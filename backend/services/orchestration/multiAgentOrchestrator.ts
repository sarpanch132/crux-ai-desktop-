import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import log from 'electron-log';
import { 
  BaseAgent, 
  AgentRole, 
  AgentConfig, 
  Task, 
  ExecutionResult,
  AgentMessage,
  SubTask,
  PlannerAgent,
  CoderAgent,
  DebuggerAgent,
  ReviewerAgent
} from './baseAgents.js';

export interface OrchestratorConfig {
  enableParallelExecution: boolean;
  maxConcurrentAgents: number;
  defaultModel: string;
  fallbackModel?: string;
  timeout: number;
}

export interface WorkflowStep {
  id: string;
  agent: AgentRole;
  task: string;
  dependsOn?: string[];
  result?: any;
  status: 'pending' | 'running' | 'completed' | 'failed';
}

export interface Workflow {
  id: string;
  name: string;
  steps: WorkflowStep[];
  status: 'pending' | 'running' | 'completed' | 'failed';
  createdAt: number;
  completedAt?: number;
}

export interface TaskResult {
  taskId: string;
  success: boolean;
  result: any;
  error?: string;
  duration: number;
  agents: string[];
}

export class MultiAgentOrchestrator extends EventEmitter {
  private agents: Map<string, BaseAgent> = new Map();
  private workflows: Map<string, Workflow> = new Map();
  private taskQueue: Task[] = [];
  private config: OrchestratorConfig;
  private runningWorkflows: Set<string> = new Set();
  private messageBus: EventEmitter = new EventEmitter();

  constructor(config: OrchestratorConfig) {
    super();
    this.config = config;
    this.initializeDefaultAgents();
    this.setupMessageBus();
  }

  private initializeDefaultAgents(): void {
    const agents: AgentConfig[] = [
      {
        id: 'planner',
        role: 'planner',
        name: 'Planner',
        model: this.config.defaultModel,
        capabilities: [
          { name: 'planning', description: 'Task decomposition', priority: 10 },
          { name: 'reasoning', description: 'Logical analysis', priority: 8 },
        ],
        maxRetries: 3,
        timeout: 60000,
        temperature: 0.3,
      },
      {
        id: 'coder',
        role: 'coder',
        name: 'Coder',
        model: this.config.defaultModel,
        capabilities: [
          { name: 'coding', description: 'Write code', priority: 10 },
          { name: 'refactoring', description: 'Improve code', priority: 8 },
        ],
        maxRetries: 2,
        timeout: 120000,
        temperature: 0.4,
      },
      {
        id: 'debugger',
        role: 'debugger',
        name: 'Debugger',
        model: this.config.defaultModel,
        capabilities: [
          { name: 'debugging', description: 'Find and fix bugs', priority: 10 },
          { name: 'diagnosis', description: 'Root cause analysis', priority: 9 },
        ],
        maxRetries: 4,
        timeout: 90000,
        temperature: 0.2,
      },
      {
        id: 'reviewer',
        role: 'reviewer',
        name: 'Reviewer',
        model: this.config.defaultModel,
        capabilities: [
          { name: 'review', description: 'Code review', priority: 10 },
          { name: 'security', description: 'Security analysis', priority: 9 },
        ],
        maxRetries: 2,
        timeout: 60000,
        temperature: 0.1,
      },
    ];

    for (const agentConfig of agents) {
      const agent = this.createAgent(agentConfig);
      this.agents.set(agentConfig.id, agent);
    }

    log.info(`Initialized ${this.agents.size} agents`);
  }

  private createAgent(config: AgentConfig): BaseAgent {
    switch (config.role) {
      case 'planner':
        return new PlannerAgent(config);
      case 'coder':
        return new CoderAgent(config);
      case 'debugger':
        return new DebuggerAgent(config);
      case 'reviewer':
        return new ReviewerAgent(config);
      default:
        return new PlannerAgent(config);
    }
  }

  private setupMessageBus(): void {
    for (const agent of this.agents.values()) {
      agent.on('message:sent', (message: AgentMessage) => {
        this.messageBus.emit('message:sent', message);
      });

      agent.on('broadcast', (message: AgentMessage) => {
        this.broadcastToOtherAgents(agent.config.id, message.content);
      });
    }
  }

  private broadcastToOtherAgents(fromAgent: string, content: string): void {
    for (const [id, agent] of this.agents) {
      if (id !== fromAgent) {
        agent.receiveMessage(content);
      }
    }
  }

  async executeTask(task: Task): Promise<TaskResult> {
    const startTime = Date.now();
    const agents: string[] = [];

    log.info(`Orchestrator executing task: ${task.id} - ${task.description}`);

    task.status = 'in_progress';
    task.startedAt = Date.now();
    this.emit('task:started', task);

    try {
      if (task.type === 'debugging') {
        const debugResult = await this.executeWithDebugger(task);
        agents.push('debugger');
        return {
          taskId: task.id,
          success: debugResult.success,
          result: debugResult.result,
          error: debugResult.error,
          duration: Date.now() - startTime,
          agents,
        };
      }

      if (task.type === 'coding') {
        const results = await this.executeWithWorkflow(task);
        return {
          taskId: task.id,
          success: results.every(r => r.success),
          result: results.map(r => r.result),
          duration: Date.now() - startTime,
          agents: results.map(r => r.agentId),
        };
      }

      const result = await this.executeSimple(task);
      agents.push('coder');

      return {
        taskId: task.id,
        success: result.success,
        result: result.result,
        error: result.error,
        duration: Date.now() - startTime,
        agents,
      };
    } catch (error) {
      task.status = 'failed';
      task.error = String(error);
      this.emit('task:failed', { task, error });

      return {
        taskId: task.id,
        success: false,
        result: null,
        error: String(error),
        duration: Date.now() - startTime,
        agents,
      };
    }
  }

  private async executeSimple(task: Task): Promise<ExecutionResult> {
    const coder = this.agents.get('coder');
    if (!coder) {
      throw new Error('Coder agent not available');
    }

    return await coder.execute(task);
  }

  private async executeWithDebugger(task: Task): Promise<ExecutionResult> {
    const debuggerAgent = this.agents.get('debugger');
    if (!debuggerAgent) {
      throw new Error('Debugger agent not available');
    }

    return await debuggerAgent.execute(task);
  }

  private async executeWithWorkflow(task: Task): Promise<ExecutionResult[]> {
    const results: ExecutionResult[] = [];

    const planner = this.agents.get('planner');
    const coder = this.agents.get('coder');
    const reviewer = this.agents.get('reviewer');

    if (!planner || !coder || !reviewer) {
      throw new Error('Required agents not available');
    }

    this.emit('workflow:started', { taskId: task.id });

    const planResult = await planner.execute(task);
    results.push(planResult);

    if (!planResult.success) {
      return results;
    }

    task.subtasks = planResult.result?.subtasks || [];

    if (this.config.enableParallelExecution) {
      const subtaskResults = await Promise.all(
        task.subtasks.map(async (subtask) => {
          subtask.status = 'in_progress';
          const result = await coder.execute({ ...task, description: subtask.description });
          subtask.status = result.success ? 'completed' : 'failed';
          return result;
        })
      );
      results.push(...subtaskResults);
    } else {
      for (const subtask of task.subtasks) {
        subtask.status = 'in_progress';
        const result = await coder.execute({ ...task, description: subtask.description });
        subtask.status = result.success ? 'completed' : 'failed';
        results.push(result);

        if (!result.success && subtask.retryCount < 3) {
          const debugTask = { ...task, description: `Fix: ${subtask.description} - Error: ${result.error}` };
          const debugResult = await this.agents.get('debugger')!.execute(debugTask);
          results.push(debugResult);

          if (debugResult.success) {
            const retryResult = await coder.execute({ ...task, description: subtask.description });
            subtask.status = retryResult.success ? 'completed' : 'failed';
            results.push(retryResult);
          }
        }
      }
    }

    const reviewTask = { ...task, description: `Review code for: ${task.description}` };
    const reviewResult = await reviewer.execute(reviewTask);
    results.push(reviewResult);

    task.status = results.every(r => r.success) ? 'completed' : 'failed';
    task.completedAt = Date.now();

    this.emit('workflow:completed', { taskId: task.id, results });

    return results;
  }

  async executeWorkflow(workflow: Workflow): Promise<void> {
    this.runningWorkflows.add(workflow.id);
    workflow.status = 'running';

    const completedSteps = new Set<string>();

    while (completedSteps.size < workflow.steps.length) {
      const readySteps = workflow.steps.filter(step => {
        if (step.status !== 'pending') return false;
        
        const deps = step.dependsOn || [];
        return deps.every(dep => completedSteps.has(dep));
      });

      if (readySteps.length === 0) {
        workflow.status = 'failed';
        break;
      }

      const executions = readySteps.map(async (step) => {
        step.status = 'running';
        const agent = this.agents.get(step.agent);
        
        if (!agent) {
          step.status = 'failed';
          return;
        }

        try {
          const result = await agent.execute({
            id: step.id,
            description: step.task,
            type: 'coding',
            priority: 5,
            status: 'in_progress',
            subtasks: [],
            context: {},
            createdAt: Date.now(),
          });

          step.result = result.result;
          step.status = result.success ? 'completed' : 'failed';
          completedSteps.add(step.id);
        } catch (error) {
          step.status = 'failed';
          completedSteps.add(step.id);
        }
      });

      await Promise.all(executions);
    }

    workflow.status = workflow.steps.every(s => s.status === 'completed') ? 'completed' : 'failed';
    workflow.completedAt = Date.now();
    this.runningWorkflows.delete(workflow.id);

    this.emit('workflow:completed', workflow);
  }

  getAgent(agentId: string): BaseAgent | undefined {
    return this.agents.get(agentId);
  }

  getAgentsByRole(role: AgentRole): BaseAgent[] {
    return Array.from(this.agents.values()).filter(a => a.getConfig().role === role);
  }

  getStatus(): {
    agents: number;
    runningWorkflows: number;
    queueLength: number;
    agentStates: Record<string, any>;
  } {
    const agentStates: Record<string, any> = {};
    for (const [id, agent] of this.agents) {
      agentStates[id] = agent.getState();
    }

    return {
      agents: this.agents.size,
      runningWorkflows: this.runningWorkflows.size,
      queueLength: this.taskQueue.length,
      agentStates,
    };
  }

  broadcastToAll(content: string): void {
    for (const agent of this.agents.values()) {
      agent.receiveMessage(content);
    }
  }

  onMessage(handler: (message: AgentMessage) => void): void {
    this.messageBus.on('message:sent', handler);
  }
}

export const createOrchestrator = (config?: Partial<OrchestratorConfig>) => {
  return new MultiAgentOrchestrator({
    enableParallelExecution: config?.enableParallelExecution ?? true,
    maxConcurrentAgents: config?.maxConcurrentAgents ?? 4,
    defaultModel: config?.defaultModel ?? 'qwen/qwen3-coder-32b',
    fallbackModel: config?.fallbackModel,
    timeout: config?.timeout ?? 120000,
  });
};

export default MultiAgentOrchestrator;