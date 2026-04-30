import { EventEmitter } from 'events';
import log from 'electron-log';
import { v4 as uuidv4 } from 'uuid';
import { AgentConfig, AgentState, ExecutionPlan, Task } from '../../shared/types/index.js';
import { RetryEngine } from './retryEngine.js';
import { ReflectionEngine } from './reflectionEngine.js';
import { TestingPipeline } from './testingPipeline.js';
import { SelfHealingLoop } from './selfHealingLoop.js';
import { ConfidenceEngine } from './confidenceEngine.js';
import { ContextRetrievalEngine } from '../intelligence/contextRetrievalEngine.js';

export interface AutonomousTask {
  id: string;
  description: string;
  type: 'create' | 'fix' | 'refactor' | 'analyze' | 'explain';
  priority: number;
  status: 'pending' | 'planning' | 'executing' | 'testing' | 'healing' | 'completed' | 'failed';
  steps: TaskStep[];
  currentStep?: number;
  executionAttempts: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  result?: any;
  error?: string;
}

export interface TaskStep {
  id: string;
  type: 'read' | 'write' | 'edit' | 'execute' | 'test' | 'analyze';
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  result?: any;
  error?: string;
  startedAt?: number;
  completedAt?: number;
  retryCount: number;
}

export interface ExecutionResult {
  success: boolean;
  taskId: string;
  stepsCompleted: number;
  stepsTotal: number;
  result?: any;
  error?: string;
  duration: number;
  confidence: number;
  attempts: number;
}

export interface AgentEvent {
  type: string;
  data: any;
  timestamp: number;
}

export interface ChainOfThought {
  thought: string;
  reasoning: string;
  plan: string;
  criticism: string;
  revision: string;
}

export class AutonomousAgent extends EventEmitter {
  private config: AgentConfig;
  private state: AgentState;
  private tasks: Map<string, AutonomousTask> = new Map();
  private retryEngine: RetryEngine;
  private reflectionEngine: ReflectionEngine;
  private testingPipeline: TestingPipeline;
  private selfHealingLoop: SelfHealingLoop;
  private confidenceEngine: ConfidenceEngine;
  private contextEngine: ContextRetrievalEngine | null = null;
  private isRunning: boolean = false;
  private currentTask: AutonomousTask | null = null;
  private executionHistory: ExecutionResult[] = [];

  constructor(config: AgentConfig) {
    super();
    this.config = config;
    this.state = this.initializeState();
    this.retryEngine = new RetryEngine(config);
    this.reflectionEngine = new ReflectionEngine(config);
    this.testingPipeline = new TestingPipeline(config);
    this.selfHealingLoop = new SelfHealingLoop(config);
    this.confidenceEngine = new ConfidenceEngine(config);

    this.setupEventHandlers();
  }

  setContextEngine(engine: ContextRetrievalEngine): void {
    this.contextEngine = engine;
  }

  private initializeState(): AgentState {
    return {
      id: uuidv4(),
      status: 'idle',
      currentTask: null,
      currentPlan: null,
      context: [],
      memory: [],
      tokensUsed: 0,
      tokensLimit: this.config.maxTokens || 4000,
      startTime: null,
      endTime: null,
    };
  }

  private setupEventHandlers(): void {
    this.retryEngine.on('retry:attempt', (data) => {
      this.emit('retry:attempt', data);
    });

    this.testingPipeline.on('test:running', (data) => {
      this.emit('test:running', data);
    });

    this.testingPipeline.on('test:passed', (data) => {
      this.emit('test:passed', data);
    });

    this.testingPipeline.on('test:failed', (data) => {
      this.emit('test:failed', data);
    });

    this.selfHealingLoop.on('fix:attempted', (data) => {
      this.emit('fix:attempted', data);
    });

    this.selfHealingLoop.on('fix:succeeded', (data) => {
      this.emit('fix:succeeded', data);
    });

    this.selfHealingLoop.on('fix:failed', (data) => {
      this.emit('fix:failed', data);
    });
  }

  async execute(taskDescription: string, options?: {
    type?: AutonomousTask['type'];
    priority?: number;
    context?: any;
    autoFix?: boolean;
    maxAttempts?: number;
  }): Promise<ExecutionResult> {
    const startTime = Date.now();
    const taskId = uuidv4();

    log.info(`Starting autonomous task: ${taskDescription}`);

    const task: AutonomousTask = {
      id: taskId,
      description: taskDescription,
      type: options?.type || this.classifyTask(taskDescription),
      priority: options?.priority || 5,
      status: 'pending',
      steps: [],
      executionAttempts: 0,
      createdAt: Date.now(),
    };

    this.tasks.set(taskId, task);
    this.currentTask = task;
    this.isRunning = true;
    this.state.status = 'running';
    this.state.startTime = startTime;

    this.emit('task:started', { taskId, description: taskDescription });

    try {
      const chainOfThought = await this.plan(task, options?.context);
      this.emit('thought:generated', chainOfThought);

      const plan = await this.createPlan(task, chainOfThought);
      task.steps = plan;
      task.status = 'planning';

      for (let stepIndex = 0; stepIndex < task.steps.length; stepIndex++) {
        task.currentStep = stepIndex;
        task.status = 'executing';
        const step = task.steps[stepIndex];

        this.emit('step:started', { taskId, stepId: step.id, step: step.description });

        step.status = 'running';
        step.startedAt = Date.now();

        try {
          const stepResult = await this.executeStep(step, options);
          step.result = stepResult;
          step.status = 'completed';
          step.completedAt = Date.now();

          this.emit('step:completed', { taskId, stepId: step.id, result: stepResult });

          if (step.type === 'test') {
            const testResult = await this.testingPipeline.runTest(step.description, stepResult);
            if (!testResult.success && options?.autoFix) {
              task.status = 'healing';
              await this.handleFailure(task, step, testResult.error, options);
            }
          }
        } catch (error) {
          step.error = String(error);
          step.status = 'failed';
          step.completedAt = Date.now();

          if (options?.autoFix) {
            await this.handleFailure(task, step, error, options);
          }
        }

        if (task.status === 'failed') break;
      }

      task.status = task.steps.every(s => s.status === 'completed') ? 'completed' : 'failed';
      task.completedAt = Date.now();

      const confidence = await this.confidenceEngine.calculate(task, this.executionHistory);

      const result: ExecutionResult = {
        success: task.status === 'completed',
        taskId,
        stepsCompleted: task.steps.filter(s => s.status === 'completed').length,
        stepsTotal: task.steps.length,
        result: task.result,
        error: task.error,
        duration: Date.now() - startTime,
        confidence,
        attempts: task.executionAttempts,
      };

      this.executionHistory.push(result);

      await this.reflectionEngine.record({
        task: taskDescription,
        result,
        steps: task.steps,
      });

      this.emit('task:completed', result);

      return result;
    } catch (error) {
      task.status = 'failed';
      task.error = String(error);
      task.completedAt = Date.now();

      this.emit('task:failed', { taskId, error });

      return {
        success: false,
        taskId,
        stepsCompleted: task.steps.filter(s => s.status === 'completed').length,
        stepsTotal: task.steps.length,
        error: String(error),
        duration: Date.now() - startTime,
        confidence: 0,
        attempts: task.executionAttempts,
      };
    } finally {
      this.isRunning = false;
      this.currentTask = null;
    }
  }

  private classifyTask(description: string): AutonomousTask['type'] {
    const lower = description.toLowerCase();
    
    if (lower.includes('fix') || lower.includes('bug') || lower.includes('error') || lower.includes('crash')) {
      return 'fix';
    }
    if (lower.includes('create') || lower.includes('add') || lower.includes('implement')) {
      return 'create';
    }
    if (lower.includes('refactor') || lower.includes('improve') || lower.includes('optimize')) {
      return 'refactor';
    }
    if (lower.includes('analyze') || lower.includes('check') || lower.includes('audit')) {
      return 'analyze';
    }
    if (lower.includes('explain') || lower.includes('what')) {
      return 'explain';
    }
    
    return 'create';
  }

  private async plan(task: AutonomousTask, context?: any): Promise<ChainOfThought> {
    const { AIService } = await import('./aiService.js');

    const prompt = `Analyze this coding task and provide your reasoning:

Task: ${task.description}
Type: ${task.type}
Context: ${JSON.stringify(context || {}).substring(0, 500)}

Provide:
1. What needs to be done (thought)
2. Why this approach (reasoning)
3. Implementation steps (plan)
4. Potential issues (criticism)
5. Improvements (revision)`;

    const response = await AIService.chat([
      { role: 'system', content: 'You are a coding expert that thinks step by step.' },
      { role: 'user', content: prompt },
    ]);

    try {
      const parsed = JSON.parse(response);
      return parsed;
    } catch {
      return {
        thought: response.substring(0, 200),
        reasoning: 'General approach',
        plan: 'Execute the task directly',
        criticism: 'None identified',
        revision: 'None needed',
      };
    }
  }

  private async createPlan(task: AutonomousTask, chainOfThought: ChainOfThought): Promise<TaskStep[]> {
    const steps: TaskStep[] = [];

    const { AIService } = await import('./aiService.js');

    const prompt = `Create a detailed implementation plan for:

Task: ${task.description}
Type: ${task.type}
Chain of thought: ${chainOfThought.thought}

Return a JSON array of steps with this structure:
[{
  "id": "step_1",
  "type": "read|write|edit|execute|test|analyze",
  "description": "Clear description of what this step does"
}]`;

    try {
      const response = await AIService.chat([
        { role: 'system', content: 'Create implementation plans as JSON.' },
        { role: 'user', content: prompt },
      ]);

      const parsed = JSON.parse(response);
      const stepArray = Array.isArray(parsed) ? parsed : parsed.steps || [];

      for (let i = 0; i < stepArray.length; i++) {
        steps.push({
          id: stepArray[i].id || `step_${i + 1}`,
          type: stepArray[i].type || 'execute',
          description: stepArray[i].description,
          status: 'pending',
          retryCount: 0,
        });
      }
    } catch (error) {
      log.warn('Failed to create AI plan, using fallback:', error);

      steps.push({
        id: 'step_analyze',
        type: 'analyze',
        description: 'Analyze the codebase for relevant files',
        status: 'pending',
        retryCount: 0,
      });
      steps.push({
        id: 'step_implement',
        type: 'execute',
        description: `Implement: ${task.description}`,
        status: 'pending',
        retryCount: 0,
      });
    }

    if (task.type === 'fix' || task.type === 'create') {
      steps.push({
        id: 'step_test',
        type: 'test',
        description: 'Run tests to validate changes',
        status: 'pending',
        retryCount: 0,
      });
    }

    return steps;
  }

  private async executeStep(step: TaskStep, options?: any): Promise<any> {
    const { ToolRegistry } = await import('./toolRegistry.js');
    const registry = new ToolRegistry(this.config.projectPath);

    switch (step.type) {
      case 'read':
        return await registry.execute({
          tool: 'file',
          method: 'read',
          params: { path: step.description },
        });

      case 'write':
      case 'edit':
        return await registry.execute({
          tool: 'file',
          method: step.type,
          params: { path: step.description, ...step.result },
        });

      case 'execute':
        return await registry.execute({
          tool: 'terminal',
          method: 'execute',
          params: { command: step.description },
        });

      case 'test':
        return await this.testingPipeline.runTest(step.description, step.result);

      case 'analyze':
        return { success: true, analysis: step.description };

      default:
        return { success: true };
    }
  }

  private async handleFailure(task: AutonomousTask, step: TaskStep, error: any, options?: any): Promise<void> {
    const maxAttempts = options?.maxAttempts || this.config.maxRetries || 3;

    if (step.retryCount >= maxAttempts) {
      log.warn(`Step failed after ${maxAttempts} attempts: ${step.id}`);
      task.status = 'failed';
      task.error = `Max retries exceeded: ${error}`;
      return;
    }

    step.retryCount++;
    task.executionAttempts++;

    this.emit('failure:analyzing', { stepId: step.id, error, attempt: step.retryCount });

    const fix = await this.selfHealingLoop.analyzeAndFix(step, error);

    if (fix.success) {
      step.result = fix.result;
      step.status = 'completed';
      
      this.emit('fix:succeeded', { stepId: step.id, fix });
    } else {
      step.error = fix.error;
      step.status = 'failed';

      this.emit('fix:failed', { stepId: step.id, error: fix.error });
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    log.info('Stopping autonomous agent');
    
    if (this.currentTask) {
      this.currentTask.status = 'failed';
      this.currentTask.error = 'Stopped by user';
    }

    this.isRunning = false;
    this.state.status = 'stopped';
    this.emit('agent:stopped');
  }

  async pause(): Promise<void> {
    if (!this.isRunning) return;
    
    this.state.status = 'paused';
    this.emit('agent:paused');
  }

  resume(): void {
    if (this.state.status === 'paused') {
      this.state.status = 'running';
      this.emit('agent:resumed');
    }
  }

  getTask(taskId: string): AutonomousTask | undefined {
    return this.tasks.get(taskId);
  }

  getCurrentTask(): AutonomousTask | null {
    return this.currentTask;
  }

  getState(): AgentState {
    return { ...this.state };
  }

  getHistory(limit = 10): ExecutionResult[] {
    return this.executionHistory.slice(-limit);
  }

  getReflectionSummary(): any {
    return this.reflectionEngine.getSummary();
  }
}

export default AutonomousAgent;