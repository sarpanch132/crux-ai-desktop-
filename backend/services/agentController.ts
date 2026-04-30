import { EventEmitter } from 'events';
import { AgentConfig, AgentState, ExecutionPlan, Task, ExecutionResult } from '../types/index.js';
import { PlanningEngine } from './planningEngine.js';
import { ToolExecutor } from './toolExecutor.js';
import { MemorySystem } from './memorySystem.js';
import { ContextManager } from './contextManager.js';
import { TaskQueue } from './taskQueue.js';
import { ModelRouter } from './modelRouter.js';
import { StreamingEngine } from './streamingEngine.js';
import log from 'electron-log';

export class AgentController extends EventEmitter {
  private config: AgentConfig;
  private state: AgentState;
  private planningEngine: PlanningEngine;
  private toolExecutor: ToolExecutor;
  private memorySystem: MemorySystem;
  private contextManager: ContextManager;
  private taskQueue: TaskQueue;
  private modelRouter: ModelRouter;
  private streamingEngine: StreamingEngine;
  private isRunning: boolean = false;
  private currentPlan: ExecutionPlan | null = null;
  private executionHistory: ExecutionResult[] = [];

  constructor(config: AgentConfig) {
    super();
    this.config = config;
    this.state = this.initializeState();
    this.planningEngine = new PlanningEngine(config);
    this.toolExecutor = new ToolExecutor(config);
    this.memorySystem = new MemorySystem(config);
    this.contextManager = new ContextManager(config);
    this.taskQueue = new TaskQueue(config);
    this.modelRouter = new ModelRouter(config);
    this.streamingEngine = new StreamingEngine(config);

    this.setupEventHandlers();
    this.setupToolHandlers();
  }

  private initializeState(): AgentState {
    return {
      id: this.generateId(),
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

  private generateId(): string {
    return `agent_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  private setupEventHandlers(): void {
    this.planningEngine.on('plan:generated', (plan: ExecutionPlan) => {
      this.emit('plan:generated', plan);
    });

    this.planningEngine.on('plan:error', (error: Error) => {
      this.emit('plan:error', error);
    });

    this.taskQueue.on('task:queued', (task: Task) => {
      this.emit('task:queued', task);
    });

    this.taskQueue.on('task:completed', (task: Task, result: any) => {
      this.emit('task:completed', task, result);
    });

    this.taskQueue.on('task:failed', (task: Task, error: Error) => {
      this.emit('task:failed', task, error);
    });

    this.memorySystem.on('memory:stored', (memory: any) => {
      this.emit('memory:stored', memory);
    });
  }

  private setupToolHandlers(): void {
    this.toolExecutor.on('tool:executing', (tool: string, params: any) => {
      this.emit('tool:executing', tool, params);
    });

    this.toolExecutor.on('tool:completed', (tool: string, result: any) => {
      this.emit('tool:completed', tool, result);
    });

    this.toolExecutor.on('tool:failed', (tool: string, error: Error) => {
      this.emit('tool:failed', tool, error);
    });
  }

  async start(userRequest: string): Promise<void> {
    if (this.isRunning) {
      throw new Error('Agent is already running');
    }

    log.info(`Agent starting: ${userRequest}`);
    this.isRunning = true;
    this.state.status = 'running';
    this.state.startTime = Date.now();
    this.emit('start', this.state);

    try {
      await this.execute(userRequest);
    } catch (error) {
      log.error('Agent execution error:', error);
      this.state.status = 'error';
      this.emit('error', error);
      throw error;
    } finally {
      this.isRunning = false;
      this.state.status = 'completed';
      this.state.endTime = Date.now();
      this.emit('complete', this.state);
    }
  }

  async execute(userRequest: string): Promise<void> {
    try {
      this.emit('thinking', { stage: 'understanding', message: 'Analyzing user request...' });
      
      const requestAnalysis = await this.analyzeRequest(userRequest);
      this.contextManager.addContext({
        type: 'request',
        content: userRequest,
        analysis: requestAnalysis,
        timestamp: Date.now(),
      });

      this.emit('thinking', { stage: 'scanning', message: 'Scanning repository...' });
      
      const repoContext = await this.scanRepository();
      this.contextManager.addContext({
        type: 'repository',
        content: repoContext,
        timestamp: Date.now(),
      });

      this.emit('thinking', { stage: 'planning', message: 'Generating execution plan...' });
      
      const context = this.contextManager.getFullContext();
      const plan = await this.planningEngine.generatePlan(userRequest, context);
      this.currentPlan = plan;
      this.state.currentPlan = plan;

      this.emit('plan:start', plan);

      for (const step of plan.steps) {
        this.state.currentTask = step;
        this.emit('step:start', step);

        const result = await this.executeStep(step);
        
        if (!result.success) {
          if (this.config.autoRetry && plan.allowRetry) {
            this.emit('step:retry', { step, error: result.error });
            const retryResult = await this.retryStep(step, result.error);
            if (!retryResult.success) {
              throw new Error(`Step failed after retry: ${result.error}`);
            }
          } else {
            throw new Error(`Step failed: ${result.error}`);
          }
        }

        this.emit('step:complete', step, result);
        
        this.memorySystem.store({
          type: 'step_completion',
          content: { step, result },
          timestamp: Date.now(),
        });
      }

      this.emit('thinking', { stage: 'summarizing', message: 'Summarizing results...' });
      
      await this.summarizeResults();
      
    } catch (error) {
      this.state.status = 'failed';
      this.emit('failure', { error, state: this.state });
      throw error;
    }
  }

  private async analyzeRequest(request: string): Promise<any> {
    const prompt = `Analyze this coding request and extract:
1. Intent (create, modify, debug, explain, refactor)
2. Target files or components
3. Requirements
4. Constraints
5. Success criteria

Request: ${request}`;

    const response = await this.modelRouter.route(prompt, {
      systemPrompt: 'You are a request analysis engine. Extract structured information from coding requests.',
    });

    try {
      return JSON.parse(response);
    } catch {
      return { raw: response };
    }
  }

  private async scanRepository(): Promise<any> {
    const result = await this.toolExecutor.execute('scan_repository', {
      ignore: this.config.ignorePatterns || ['node_modules', '.git', 'dist'],
    });

    return result;
  }

  private async executeStep(step: Task): Promise<ExecutionResult> {
    try {
      switch (step.type) {
        case 'read':
          return await this.handleReadStep(step);
        case 'write':
          return await this.handleWriteStep(step);
        case 'edit':
          return await this.handleEditStep(step);
        case 'execute':
          return await this.handleExecuteStep(step);
        case 'analyze':
          return await this.handleAnalyzeStep(step);
        case 'search':
          return await this.handleSearchStep(step);
        case 'diagnose':
          return await this.handleDiagnoseStep(step);
        default:
          return { success: false, error: `Unknown step type: ${step.type}` };
      }
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  private async handleReadStep(step: Task): Promise<ExecutionResult> {
    const result = await this.toolExecutor.execute('read_file', {
      path: step.file,
    });

    if (result.success) {
      this.contextManager.addContext({
        type: 'file',
        content: result.data,
        metadata: { path: step.file },
        timestamp: Date.now(),
      });
    }

    return result;
  }

  private async handleWriteStep(step: Task): Promise<ExecutionResult> {
    return await this.toolExecutor.execute('write_file', {
      path: step.file,
      content: step.content,
    });
  }

  private async handleEditStep(step: Task): Promise<ExecutionResult> {
    return await this.toolExecutor.execute('edit_file', {
      path: step.file,
      edits: step.edits,
    });
  }

  private async handleExecuteStep(step: Task): Promise<ExecutionResult> {
    return await this.toolExecutor.execute('execute_command', {
      command: step.command,
      cwd: step.cwd,
      timeout: step.timeout,
    });
  }

  private async handleAnalyzeStep(step: Task): Promise<ExecutionResult> {
    const code = step.code || await this.toolExecutor.execute('read_file', { path: step.file });
    
    const prompt = `Analyze this code for:
1. Bugs and issues
2. Security vulnerabilities
3. Performance concerns
4. Code quality issues
5. Suggested fixes

Code:
${code}`;

    const analysis = await this.modelRouter.route(prompt, {
      systemPrompt: 'You are a code analysis engine. Provide detailed analysis with line numbers.',
    });

    return { success: true, data: { analysis } };
  }

  private async handleSearchStep(step: Task): Promise<ExecutionResult> {
    return await this.toolExecutor.execute('search_code', {
      pattern: step.pattern,
      path: step.path,
    });
  }

  private async handleDiagnoseStep(step: Task): Promise<ExecutionResult> {
    return await this.toolExecutor.execute('diagnose', {
      error: step.error,
      context: step.context,
    });
  }

  private async retryStep(step: Task, error: any): Promise<ExecutionResult> {
    log.info(`Retrying step: ${step.id}, error: ${error}`);
    
    const prompt = `Analyzing failure and generating fix:
    
Error: ${error}
Step: ${JSON.stringify(step)}
Context: ${JSON.stringify(this.contextManager.getFullContext())}

Generate a fix for this step.`;

    const fix = await this.modelRouter.route(prompt, {
      systemPrompt: 'You are a debugging engine. Generate corrected steps.',
    });

    try {
      const parsedFix = JSON.parse(fix);
      Object.assign(step, parsedFix);
    } catch {
      log.warn('Could not parse fix, attempting basic retry');
    }

    return await this.executeStep(step);
  }

  private async summarizeResults(): Promise<void> {
    const context = this.contextManager.getFullContext();
    const history = this.executionHistory;
    
    const prompt = `Summarize the completed work:

Request: ${this.state.currentPlan?.goal}
Steps executed: ${this.currentPlan?.steps.length}
History: ${JSON.stringify(history)}

Provide a summary of what was done, what was changed, and any next steps.`;

    const summary = await this.modelRouter.route(prompt, {
      systemPrompt: 'You are a summary engine. Provide clear summaries of completed work.',
    });

    this.memorySystem.store({
      type: 'summary',
      content: summary,
      timestamp: Date.now(),
    });

    this.emit('summary', summary);
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;
    
    log.info('Stopping agent');
    this.isRunning = false;
    this.state.status = 'stopped';
    this.emit('stopped', this.state);
  }

  async pause(): Promise<void> {
    this.state.status = 'paused';
    this.emit('paused', this.state);
  }

  async resume(): Promise<void> {
    this.state.status = 'running';
    this.emit('resumed', this.state);
  }

  getState(): AgentState {
    return { ...this.state };
  }

  getConfig(): AgentConfig {
    return { ...this.config };
  }

  async updateConfig(config: Partial<AgentConfig>): Promise<void> {
    this.config = { ...this.config, ...config };
  }

  streamResponse(prompt: string): AsyncIterable<string> {
    return this.streamingEngine.stream(prompt, this.contextManager.getFullContext());
  }
}

export default AgentController;