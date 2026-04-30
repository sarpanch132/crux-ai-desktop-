import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import log from 'electron-log';

export type WorkflowStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';
export type TaskType = 'analysis' | 'scaffold' | 'code' | 'test' | 'config' | 'deploy' | 'verify';

export interface WorkflowTask {
  id: string;
  type: TaskType;
  description: string;
  status: TaskStatus;
  priority: number;
  dependsOn: string[];
  input?: any;
  output?: any;
  result?: any;
  error?: string;
  retries: number;
  maxRetries: number;
  startedAt?: number;
  completedAt?: number;
  duration?: number;
  agent?: string;
}

export interface WorkflowCheckpoint {
  id: string;
  workflowId: string;
  tasks: WorkflowTask[];
  state: Record<string, any>;
  createdAt: number;
  description: string;
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  status: WorkflowStatus;
  tasks: Map<string, WorkflowTask>;
  dependencies: Map<string, string[]>;
  checkpoints: WorkflowCheckpoint[];
  currentTaskId?: string;
  startedAt?: number;
  completedAt?: number;
  totalDuration?: number;
  metadata?: Record<string, any>;
}

export interface WorkflowResult {
  success: boolean;
  workflowId: string;
  completedTasks: number;
  failedTasks: number;
  skippedTasks: number;
  duration: number;
  checkpoints: number;
  error?: string;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  tasks: Omit<WorkflowTask, 'id' | 'status' | 'startedAt' | 'completedAt' | 'duration'>[];
}

const SAAS_TEMPLATE: WorkflowTemplate = {
  id: 'saas-app',
  name: 'SaaS Application',
  description: 'Build a complete SaaS application',
  tasks: [
    { type: 'analysis', description: 'Analyze requirements', priority: 10, dependsOn: [], maxRetries: 2 },
    { type: 'analysis', description: 'Create architecture document', priority: 9, dependsOn: [], maxRetries: 2 },
    { type: 'scaffold', description: 'Scaffold frontend project', priority: 8, dependsOn: [], maxRetries: 1 },
    { type: 'scaffold', description: 'Scaffold backend project', priority: 8, dependsOn: [], maxRetries: 1 },
    { type: 'code', description: 'Create database schema', priority: 8, dependsOn: [3], maxRetries: 2 },
    { type: 'code', description: 'Build authentication system', priority: 9, dependsOn: [4], maxRetries: 2 },
    { type: 'code', description: 'Create API endpoints', priority: 8, dependsOn: [4], maxRetries: 2 },
    { type: 'code', description: 'Build frontend components', priority: 7, dependsOn: [2], maxRetries: 3 },
    { type: 'code', description: 'Implement state management', priority: 7, dependsOn: [7], maxRetries: 2 },
    { type: 'test', description: 'Write backend tests', priority: 6, dependsOn: [5, 6], maxRetries: 2 },
    { type: 'test', description: 'Write frontend tests', priority: 6, dependsOn: [7, 8], maxRetries: 2 },
    { type: 'config', description: 'Configure Docker', priority: 5, dependsOn: [9, 10], maxRetries: 1 },
    { type: 'config', description: 'Generate CI/CD pipeline', priority: 5, dependsOn: [], maxRetries: 1 },
    { type: 'deploy', description: 'Deploy to cloud', priority: 4, dependsOn: [11, 12], maxRetries: 3 },
    { type: 'verify', description: 'Verify deployment', priority: 3, dependsOn: [13], maxRetries: 2 },
  ],
};

class WorkflowEngine extends EventEmitter {
  private workflows: Map<string, Workflow> = new Map();
  private templates: Map<string, WorkflowTemplate> = new Map();
  private executor: ((task: WorkflowTask, workflow: Workflow) => Promise<any>) | null = null;
  private maxConcurrent: number = 3;
  private checkpointInterval: number = 10;
  private taskCounters: Map<string, number> = new Map();

  constructor() {
    super();
    this.registerTemplate(SAAS_TEMPLATE);
  }

  setExecutor(fn: (task: WorkflowTask, workflow: Workflow) => Promise<any>): void {
    this.executor = fn;
  }

  setMaxConcurrent(max: number): void {
    this.maxConcurrent = max;
  }

  registerTemplate(template: WorkflowTemplate): void {
    this.templates.set(template.id, template);
    log.info(`Workflow template registered: ${template.name}`);
  }

  createWorkflow(name: string, description: string, templateId?: string): Workflow {
    const id = randomUUID();
    
    const workflow: Workflow = {
      id,
      name,
      description,
      status: 'pending',
      tasks: new Map(),
      dependencies: new Map(),
      checkpoints: [],
      metadata: {},
    };

    if (templateId) {
      const template = this.templates.get(templateId);
      if (template) {
        this.buildFromTemplate(workflow, template);
      }
    }

    this.workflows.set(id, workflow);
    this.emit('workflow:created', workflow);
    
    return workflow;
  }

  private buildFromTemplate(workflow: Workflow, template: WorkflowTemplate): void {
    for (let i = 0; i < template.tasks.length; i++) {
      const taskDef = template.tasks[i];
      
      const task: WorkflowTask = {
        id: `${workflow.id}-task-${i}`,
        type: taskDef.type,
        description: taskDef.description,
        status: 'pending',
        priority: taskDef.priority,
        dependsOn: taskDef.dependsOn.map(d => `${workflow.id}-task-${d}`),
        input: taskDef.input,
        maxRetries: taskDef.maxRetries,
        retries: 0,
      };

      workflow.tasks.set(task.id, task);
      workflow.dependencies.set(task.id, task.dependsOn);
    }
  }

  async execute(workflowId: string): Promise<WorkflowResult> {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    if (workflow.status !== 'pending') {
      throw new Error(`Workflow already ${workflow.status}`);
    }

    workflow.status = 'running';
    workflow.startedAt = Date.now();
    this.emit('workflow:started', workflow);

    const startTime = Date.now();
    let completed = 0;
    let failed = 0;
    let skipped = 0;
    let checkpointCounter = 0;

    try {
      while (true) {
        const pendingTasks = this.getRunnableTasks(workflow);
        
        if (pendingTasks.length === 0) {
          if (this.getPendingCount(workflow) === 0) break;
          continue;
        }

        const toExecute = pendingTasks.slice(0, this.maxConcurrent);
        const executions = toExecute.map(task => this.executeTask(workflow, task));

        const results = await Promise.allSettled(executions);

        for (let i = 0; i < results.length; i++) {
          const task = toExecute[i];
          const result = results[i];

          if (result.status === 'fulfilled') {
            task.status = 'completed';
            task.completedAt = Date.now();
            task.duration = task.completedAt - (task.startedAt || task.completedAt);
            completed++;
            this.emit('task:completed', { workflow, task, result: result.value });
          } else {
            if (task.retries < task.maxRetries) {
              task.retries++;
              task.status = 'pending';
              this.emit('task:retry', { workflow, task, error: result.reason });
            } else {
              task.status = 'failed';
              task.error = String(result.reason);
              failed++;
              this.emit('task:failed', { workflow, task, error: result.reason });
            }
          }
        }

        checkpointCounter++;
        if (checkpointCounter >= this.checkpointInterval) {
          this.createCheckpoint(workflow, `Auto-save after ${checkpointCounter} tasks`);
          checkpointCounter = 0;
        }

        if (failed > 0 && this.shouldFailFast(workflow)) {
          break;
        }
      }

      workflow.status = failed > 0 ? 'failed' : 'completed';
    } catch (error) {
      workflow.status = 'failed';
      this.emit('workflow:failed', { workflow, error });
    }

    workflow.completedAt = Date.now();
    workflow.totalDuration = workflow.completedAt - (workflow.startedAt || workflow.completedAt);

    const result: WorkflowResult = {
      success: workflow.status === 'completed',
      workflowId,
      completedTasks: completed,
      failedTasks: failed,
      skippedTasks: skipped,
      duration: workflow.totalDuration,
      checkpoints: workflow.checkpoints.length,
    };

    this.emit('workflow:completed', { workflow, result });
    
    return result;
  }

  private async executeTask(workflow: Workflow, task: WorkflowTask): Promise<any> {
    task.status = 'in_progress';
    task.startedAt = Date.now();

    this.emit('task:started', { workflow, task });
    this.emit('workflow:progress', { 
      workflow, 
      currentTask: task,
      progress: this.getProgress(workflow),
    });

    try {
      if (this.executor) {
        task.result = await this.executor(task, workflow);
      } else {
        await this.defaultExecutor(task, workflow);
      }

      task.output = task.result;
      return task.result;
    } catch (error) {
      task.error = String(error);
      throw error;
    }
  }

  private async defaultExecutor(task: WorkflowTask, workflow: Workflow): Promise<any> {
    await new Promise(resolve => setTimeout(resolve, 100));
    return { success: true, taskId: task.id };
  }

  private getRunnableTasks(workflow: Workflow): WorkflowTask[] {
    const runnable: WorkflowTask[] = [];

    for (const [id, task] of workflow.tasks) {
      if (task.status !== 'pending') continue;

      const deps = workflow.dependencies.get(id) || [];
      const canRun = deps.every(depId => {
        const dep = workflow.tasks.get(depId);
        return dep?.status === 'completed';
      });

      if (canRun) {
        runnable.push(task);
      }
    }

    return runnable.sort((a, b) => b.priority - a.priority);
  }

  private getPendingCount(workflow: Workflow): number {
    let count = 0;
    for (const task of workflow.tasks.values()) {
      if (task.status === 'pending' || task.status === 'in_progress') {
        count++;
      }
    }
    return count;
  }

  private getProgress(workflow: Workflow): number {
    let total = 0;
    let completed = 0;

    for (const task of workflow.tasks.values()) {
      total++;
      if (task.status === 'completed' || task.status === 'failed') {
        completed++;
      }
    }

    return total > 0 ? (completed / total) * 100 : 0;
  }

  private shouldFailFast(workflow: Workflow): boolean {
    let total = 0;
    let failed = 0;

    for (const task of workflow.tasks.values()) {
      total++;
      if (task.status === 'failed') failed++;
    }

    return failed / total > 0.3;
  }

  createCheckpoint(workflow: Workflow, description: string): WorkflowCheckpoint {
    const tasks = Array.from(workflow.tasks.values()).map(t => ({ ...t }));
    
    const checkpoint: WorkflowCheckpoint = {
      id: randomUUID(),
      workflowId: workflow.id,
      tasks,
      state: { 
        status: workflow.status,
        currentTaskId: workflow.currentTaskId,
      },
      createdAt: Date.now(),
      description,
    };

    workflow.checkpoints.push(checkpoint);
    this.emit('checkpoint:created', { workflow, checkpoint });

    log.info(`Checkpoint created for workflow ${workflow.id}: ${description}`);
    
    return checkpoint;
  }

  async rollback(workflowId: string, checkpointId: string): Promise<boolean> {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return false;

    const checkpoint = workflow.checkpoints.find(c => c.id === checkpointId);
    if (!checkpoint) return false;

    workflow.tasks = new Map(checkpoint.tasks.map(t => [t.id, t]));
    workflow.status = checkpoint.state.status as WorkflowStatus;
    workflow.currentTaskId = checkpoint.state.currentTaskId;

    for (const task of workflow.tasks.values()) {
      if (task.status === 'completed' || task.status === 'failed') {
        task.status = 'pending';
      }
    }

    this.emit('workflow:rolledback', { workflow, checkpoint });
    
    log.info(`Workflow ${workflowId} rolled back to checkpoint ${checkpointId}`);
    
    return true;
  }

  cancel(workflowId: string): boolean {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return false;

    workflow.status = 'cancelled';
    
    for (const task of workflow.tasks.values()) {
      if (task.status === 'pending' || task.status === 'in_progress') {
        task.status = 'skipped';
      }
    }

    this.emit('workflow:cancelled', workflow);
    
    return true;
  }

  pause(workflowId: string): boolean {
    const workflow = this.workflows.get(workflowId);
    if (!workflow || workflow.status !== 'running') return false;

    workflow.status = 'paused';
    this.emit('workflow:paused', workflow);
    
    return true;
  }

  resume(workflowId: string): boolean {
    const workflow = this.workflows.get(workflowId);
    if (!workflow || workflow.status !== 'paused') return false;

    workflow.status = 'running';
    this.emit('workflow:resumed', workflow);
    
    return true;
  }

  getWorkflow(id: string): Workflow | undefined {
    return this.workflows.get(id);
  }

  getAllWorkflows(): Workflow[] {
    return Array.from(this.workflows.values());
  }

  getTemplates(): WorkflowTemplate[] {
    return Array.from(this.templates.values());
  }

  getWorkflowStatus(id: string): {
    status: WorkflowStatus;
    progress: number;
    currentTask?: WorkflowTask;
    duration?: number;
  } | null {
    const workflow = this.workflows.get(id);
    if (!workflow) return null;

    let currentTask: WorkflowTask | undefined;
    for (const task of workflow.tasks.values()) {
      if (task.status === 'in_progress') {
        currentTask = task;
        break;
      }
    }

    return {
      status: workflow.status,
      progress: this.getProgress(workflow),
      currentTask,
      duration: workflow.totalDuration,
    };
  }
}

export const workflowEngine = new WorkflowEngine();
export default WorkflowEngine;