import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import log from 'electron-log';

export type AgentRole = 'planner' | 'coder' | 'debugger' | 'reviewer' | 'researcher' | 'tester' | 'executor';
export type AgentStatus = 'idle' | 'thinking' | 'working' | 'waiting' | 'completed' | 'failed';

export interface AgentCapability {
  name: string;
  description: string;
  priority: number;
}

export interface AgentConfig {
  id: string;
  role: AgentRole;
  name: string;
  model: string;
  capabilities: AgentCapability[];
  maxRetries: number;
  timeout: number;
  temperature: number;
}

export interface AgentMessage {
  id: string;
  fromAgent: string;
  toAgent?: string;
  role: 'planner' | 'coder' | 'system';
  content: string;
  timestamp: number;
  attachments?: any[];
}

export interface Task {
  id: string;
  description: string;
  type: 'coding' | 'debugging' | 'refactoring' | 'testing' | 'research' | 'planning';
  priority: number;
  status: 'pending' | 'assigned' | 'in_progress' | 'completed' | 'failed';
  assignedTo?: string;
  subtasks: SubTask[];
  context: Record<string, any>;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  result?: any;
  error?: string;
}

export interface SubTask {
  id: string;
  description: string;
  status: 'pending' | 'assigned' | 'in_progress' | 'completed' | 'failed';
  assignedTo?: string;
  result?: any;
}

export interface ExecutionResult {
  success: boolean;
  agentId: string;
  taskId: string;
  result: any;
  error?: string;
  duration: number;
  tokensUsed?: number;
}

export interface AgentState {
  id: string;
  role: AgentRole;
  status: AgentStatus;
  currentTask?: string;
  messages: AgentMessage[];
  lastActivity: number;
}

export class BaseAgent extends EventEmitter {
  protected config: AgentConfig;
  protected state: AgentState;
  protected messageQueue: AgentMessage[] = [];
  protected capabilities: Map<string, AgentCapability> = new Map();

  constructor(config: AgentConfig) {
    super();
    this.config = config;
    this.state = {
      id: config.id,
      role: config.role,
      status: 'idle',
      messages: [],
      lastActivity: Date.now(),
    };

    for (const cap of config.capabilities) {
      this.capabilities.set(cap.name, cap);
    }
  }

  async sendMessage(toAgent: string, content: string, attachments?: any[]): Promise<void> {
    const message: AgentMessage = {
      id: uuidv4(),
      fromAgent: this.config.id,
      toAgent,
      role: this.config.role,
      content,
      timestamp: Date.now(),
      attachments,
    };

    this.state.messages.push(message);
    this.state.lastActivity = Date.now();
    this.emit('message:sent', message);
  }

  async broadcast(content: string): Promise<void> {
    const message: AgentMessage = {
      id: uuidv4(),
      fromAgent: this.config.id,
      role: this.config.role,
      content,
      timestamp: Date.now(),
    };

    this.state.messages.push(message);
    this.emit('broadcast', message);
  }

  getState(): AgentState {
    return { ...this.state };
  }

  getConfig(): AgentConfig {
    return { ...this.config };
  }

  setStatus(status: AgentStatus): void {
    this.state.status = status;
    this.emit('status:changed', status);
  }

  canHandle(capability: string): boolean {
    return this.capabilities.has(capability);
  }

  abstract execute(task: Task): Promise<ExecutionResult>;
  abstract think(prompt: string): Promise<string>;
}

export class PlannerAgent extends BaseAgent {
  private planHistory: Map<string, any> = new Map();

  constructor(config: AgentConfig) {
    super(config);
  }

  async think(prompt: string): Promise<string> {
    this.setStatus('thinking');
    this.emit('thinking', { agent: this.config.id, prompt });

    const planningPrompt = `You are a senior software architect. Analyze this request and create a detailed execution plan:

${prompt}

Provide:
1. Task decomposition into subtasks
2. Dependencies between subtasks
3. Risk assessment
4. Alternative approaches considered
5. Confidence level (0-1)

Respond in JSON format.`;

    try {
      const result = await this.callModel(planningPrompt);
      this.setStatus('idle');
      return result;
    } catch (error) {
      this.setStatus('failed');
      throw error;
    }
  }

  async execute(task: Task): Promise<ExecutionResult> {
    const startTime = Date.now();
    this.setStatus('working');

    try {
      const plan = await this.think(task.description);

      task.subtasks = this.parsePlanToSubtasks(plan);
      this.planHistory.set(task.id, plan);

      this.setStatus('completed');

      return {
        success: true,
        agentId: this.config.id,
        taskId: task.id,
        result: { plan, subtasks: task.subtasks },
        duration: Date.now() - startTime,
      };
    } catch (error) {
      this.setStatus('failed');
      return {
        success: false,
        agentId: this.config.id,
        taskId: task.id,
        error: String(error),
        duration: Date.now() - startTime,
      };
    }
  }

  private parsePlanToSubtasks(plan: string): SubTask[] {
    try {
      const parsed = JSON.parse(plan);
      return (parsed.subtasks || []).map((st: any, i: number) => ({
        id: `subtask_${i}`,
        description: st.description || st,
        status: 'pending',
      }));
    } catch {
      return plan.split('\n').filter(Boolean).map((line, i) => ({
        id: `subtask_${i}`,
        description: line.replace(/^\d+\.\s*/, ''),
        status: 'pending',
      }));
    }
  }

  private async callModel(prompt: string): Promise<string> {
    return prompt;
  }
}

export class CoderAgent extends BaseAgent {
  private codeHistory: Map<string, string> = new Map();

  constructor(config: AgentConfig) {
    super(config);
  }

  async think(prompt: string): Promise<string> {
    this.setStatus('thinking');
    const codingPrompt = `You are an expert programmer. Write production-quality code for:

${prompt}

Requirements:
- TypeScript with proper typing
- Error handling
- Clean architecture
- Follow best practices
- Include necessary imports`;

    try {
      const result = await this.callModel(codingPrompt);
      this.setStatus('idle');
      return result;
    } catch (error) {
      this.setStatus('failed');
      throw error;
    }
  }

  async execute(task: Task): Promise<ExecutionResult> {
    const startTime = Date.now();
    this.setStatus('working');

    try {
      let code = '';

      for (const subtask of task.subtasks) {
        subtask.status = 'in_progress';
        const result = await this.think(subtask.description);
        subtask.result = result;
        subtask.status = 'completed';
        code += result + '\n\n';
      }

      this.codeHistory.set(task.id, code);
      this.setStatus('completed');

      return {
        success: true,
        agentId: this.config.id,
        taskId: task.id,
        result: { code },
        duration: Date.now() - startTime,
      };
    } catch (error) {
      this.setStatus('failed');
      return {
        success: false,
        agentId: this.config.id,
        taskId: task.id,
        error: String(error),
        duration: Date.now() - startTime,
      };
    }
  }

  private async callModel(prompt: string): Promise<string> {
    return prompt;
  }
}

export class DebuggerAgent extends BaseAgent {
  constructor(config: AgentConfig) {
    super(config);
  }

  async think(prompt: string): Promise<string> {
    this.setStatus('thinking');
    const debugPrompt = `You are an expert debugger. Analyze this error and provide a fix:

${prompt}

Provide:
1. Root cause analysis
2. The fix with line numbers
3. Alternative solutions
4. Prevention strategies`;

    try {
      const result = await this.callModel(debugPrompt);
      this.setStatus('idle');
      return result;
    } catch (error) {
      this.setStatus('failed');
      throw error;
    }
  }

  async execute(task: Task): Promise<ExecutionResult> {
    const startTime = Date.now();
    this.setStatus('working');

    try {
      const analysis = await this.think(task.description);
      this.setStatus('completed');

      return {
        success: true,
        agentId: this.config.id,
        taskId: task.id,
        result: { analysis },
        duration: Date.now() - startTime,
      };
    } catch (error) {
      this.setStatus('failed');
      return {
        success: false,
        agentId: this.config.id,
        taskId: task.id,
        error: String(error),
        duration: Date.now() - startTime,
      };
    }
  }

  private async callModel(prompt: string): Promise<string> {
    return prompt;
  }
}

export class ReviewerAgent extends BaseAgent {
  constructor(config: AgentConfig) {
    super(config);
  }

  async think(prompt: string): Promise<string> {
    this.setStatus('thinking');
    const reviewPrompt = `You are a senior code reviewer. Review this code:

${prompt}

Check for:
1. Security vulnerabilities
2. Performance issues
3. Code quality
4. Best practices
5. Test coverage
6. Documentation`;

    try {
      const result = await this.callModel(reviewPrompt);
      this.setStatus('idle');
      return result;
    } catch (error) {
      this.setStatus('failed');
      throw error;
    }
  }

  async execute(task: Task): Promise<ExecutionResult> {
    const startTime = Date.now();
    this.setStatus('working');

    try {
      const review = await this.think(task.description);
      this.setStatus('completed');

      return {
        success: true,
        agentId: this.config.id,
        taskId: task.id,
        result: { review },
        duration: Date.now() - startTime,
      };
    } catch (error) {
      this.setStatus('failed');
      return {
        success: false,
        agentId: this.config.id,
        taskId: task.id,
        error: String(error),
        duration: Date.now() - startTime,
      };
    }
  }

  private async callModel(prompt: string): Promise<string> {
    return prompt;
  }
}