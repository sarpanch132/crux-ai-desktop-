import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import log from 'electron-log';
import { AgentConfig } from '../types/index.js';

export interface QueuedTask {
  id: string;
  type: string;
  priority: number;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  data: any;
  result?: any;
  error?: Error;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  retries: number;
  maxRetries: number;
}

export interface TaskStats {
  queued: number;
  running: number;
  completed: number;
  failed: number;
}

export class TaskQueue extends EventEmitter {
  private config: AgentConfig;
  private queue: QueuedTask[] = [];
  private running: QueuedTask | null = null;
  private completed: QueuedTask[] = [];
  private maxConcurrent: number;
  private processing: boolean = false;

  constructor(config: AgentConfig) {
    super();
    this.config = config;
    this.maxConcurrent = config.maxConcurrent || 1;
  }

  async add(task: Omit<QueuedTask, 'id' | 'status' | 'createdAt' | 'retries'>): Promise<string> {
    const queuedTask: QueuedTask = {
      ...task,
      id: task.id || uuidv4(),
      status: 'queued',
      createdAt: Date.now(),
      retries: 0,
    };

    this.queue.push(queuedTask);
    this.queue.sort((a, b) => b.priority - a.priority);

    this.emit('task:queued', queuedTask);
    log.debug(`Task queued: ${queuedTask.id}`);

    if (this.processing === false) {
      this.processQueue();
    }

    return queuedTask.id;
  }

  async addBatch(tasks: Omit<QueuedTask, 'id' | 'status' | 'createdAt' | 'retries'>[]): Promise<string[]> {
    const ids: string[] = [];
    
    for (const task of tasks) {
      const id = await this.add(task);
      ids.push(id);
    }

    return ids;
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0 && this.running === null) {
      const task = this.queue.shift()!;
      
      if (task.status === 'cancelled') continue;

      this.running = task;
      this.running.status = 'running';
      this.running.startedAt = Date.now();

      this.emit('task:started', task);

      try {
        const result = await this.executeTask(task);
        
        task.status = 'completed';
        task.result = result;
        task.completedAt = Date.now();
        
        this.completed.push(task);
        this.emit('task:completed', task, result);
        
        if (this.completed.length > 100) {
          this.completed = this.completed.slice(-50);
        }
      } catch (error) {
        task.status = 'failed';
        task.error = error instanceof Error ? error : new Error(String(error));
        task.completedAt = Date.now();
        
        if (task.retries < task.maxRetries) {
          task.retries++;
          task.status = 'queued';
          
          this.queue.push(task);
          this.queue.sort((a, b) => b.priority - a.priority);
          
          this.emit('task:retry', task);
        } else {
          this.emit('task:failed', task, error);
        }
      } finally {
        this.running = null;
      }
    }

    this.processing = false;
  }

  private async executeTask(task: QueuedTask): Promise<any> {
    log.info(`Executing task: ${task.id} - ${task.type}`);
    
    return new Promise((resolve, reject) => {
      setTimeout(async () => {
        try {
          resolve({ success: true, taskId: task.id });
        } catch (error) {
          reject(error);
        }
      }, 100);
    });
  }

  getStatus(taskId: string): QueuedTask | undefined {
    if (this.running?.id === taskId) return this.running;
    return this.queue.find(t => t.id === taskId) || this.completed.find(t => t.id === taskId);
  }

  cancel(taskId: string): boolean {
    const task = this.queue.find(t => t.id === taskId);
    
    if (task) {
      task.status = 'cancelled';
      this.emit('task:cancelled', task);
      return true;
    }

    if (this.running?.id === taskId) {
      this.running.status = 'cancelled';
      this.emit('task:cancelled', this.running);
      return true;
    }

    return false;
  }

  getStats(): TaskStats {
    return {
      queued: this.queue.length,
      running: this.running ? 1 : 0,
      completed: this.completed.filter(t => t.status === 'completed').length,
      failed: this.completed.filter(t => t.status === 'failed').length,
    };
  }

  getQueue(): QueuedTask[] {
    return [...this.queue];
  }

  getRunning(): QueuedTask | null {
    return this.running;
  }

  getCompleted(limit = 20): QueuedTask[] {
    return this.completed.slice(-limit);
  }

  clear(): void {
    this.queue = [];
    log.info('Task queue cleared');
  }

  clearCompleted(): void {
    this.completed = [];
    log.info('Completed tasks cleared');
  }
}

export default TaskQueue;