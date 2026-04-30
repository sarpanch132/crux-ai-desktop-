import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import log from 'electron-log';

export interface QueueItem<T = any> {
  id: string;
  data: T;
  priority: number;
  attempts: number;
  maxAttempts: number;
  createdAt: number;
  processedAt?: number;
  completedAt?: number;
  failedAt?: number;
  error?: string;
}

export interface QueueConfig {
  maxSize: number;
  maxRetries: number;
  retryDelay: number;
  processingTimeout: number;
  batchSize: number;
}

export interface WorkerMetrics {
  processed: number;
  failed: number;
  retries: number;
  avgProcessingTime: number;
}

class ProtectedQueue<T = any> extends EventEmitter {
  private queue: QueueItem<T>[] = [];
  private config: QueueConfig;
  private processing: Set<string> = new Set();
  private metrics: WorkerMetrics = {
    processed: 0,
    failed: 0,
    retries: 0,
    avgProcessingTime: 0,
  };
  private processingTimes: number[] = [];

  constructor(config: Partial<QueueConfig> = {}) {
    super();
    this.config = {
      maxSize: config.maxSize ?? 1000,
      maxRetries: config.maxRetries ?? 3,
      retryDelay: config.retryDelay ?? 1000,
      processingTimeout: config.processingTimeout ?? 30000,
      batchSize: config.batchSize ?? 10,
    };
  }

  enqueue(data: T, priority: number = 5, maxAttempts?: number): string {
    if (this.queue.length >= this.config.maxSize) {
      this.emit('queue_full', { size: this.queue.length });
      throw new Error('Queue is full');
    }

    const item: QueueItem<T> = {
      id: randomUUID(),
      data,
      priority,
      attempts: 0,
      maxAttempts: maxAttempts ?? this.config.maxRetries,
      createdAt: Date.now(),
    };

    this.queue.push(item);
    this.queue.sort((a, b) => b.priority - a.priority);

    this.emit('enqueued', item);
    return item.id;
  }

  dequeue(count: number = 1): QueueItem<T>[] {
    const items: QueueItem<T>[] = [];

    for (let i = 0; i < count && this.queue.length > 0; i++) {
      const item = this.queue.shift()!;

      if (!this.processing.has(item.id)) {
        item.attempts++;
        item.processedAt = Date.now();
        this.processing.add(item.id);
        items.push(item);
      }
    }

    if (items.length > 0) {
      this.emit('dequeued', items);
    }

    return items;
  }

  complete(id: string): void {
    const item = Array.from(this.processing).find(pid => pid === id);
    if (item) {
      this.processing.delete(id);
      this.metrics.processed++;

      const time = Date.now() - (item as any).processedAt;
      this.processingTimes.push(time);
      if (this.processingTimes.length > 100) {
        this.processingTimes.shift();
      }
      this.metrics.avgProcessingTime =
        this.processingTimes.reduce((a, b) => a + b, 0) / this.processingTimes.length;

      this.emit('completed', { id });
    }
  }

  fail(id: string, error: string): void {
    this.processing.delete(id);
    this.metrics.failed++;
    this.emit('failed', { id, error });
  }

  retry(id: string): void {
    const item = this.queue.find(i => i.id === id);
    if (item && item.attempts < item.maxAttempts) {
      this.metrics.retries++;
      item.attempts++;
      this.queue.push(item);
      this.queue.sort((a, b) => b.priority - a.priority);
      this.emit('retried', { id, attempts: item.attempts });
    }
  }

  getSize(): number {
    return this.queue.length;
  }

  getProcessing(): number {
    return this.processing.size;
  }

  getMetrics(): WorkerMetrics {
    return { ...this.metrics };
  }

  clear(): void {
    this.queue = [];
    this.processing.clear();
  }
}

class WorkerRecovery extends EventEmitter {
  private workers: Map<string, WorkerState> = new Map();
  private recoveryStrategies: Map<string, () => Promise<any>> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;

  interface WorkerState {
    id: string;
    status: 'idle' | 'running' | 'recovering' | 'dead';
    lastHeartbeat: number;
    restartCount: number;
    maxRestarts: number;
    metadata: Record<string, any>;
  }

  registerWorker(id: string, maxRestarts: number = 3): void {
    this.workers.set(id, {
      id,
      status: 'idle',
      lastHeartbeat: Date.now(),
      restartCount: 0,
      maxRestarts,
      metadata: {},
    });

    this.emit('worker_registered', { id });
  }

  unregisterWorker(id: string): void {
    this.workers.delete(id);
    this.emit('worker_unregistered', { id });
  }

  markHealthy(id: string): void {
    const worker = this.workers.get(id);
    if (worker) {
      worker.lastHeartbeat = Date.now();
      worker.status = 'idle';
    }
  }

  markRunning(id: string): void {
    const worker = this.workers.get(id);
    if (worker) {
      worker.status = 'running';
      worker.lastHeartbeat = Date.now();
    }
  }

  async recover(id: string): Promise<boolean> {
    const worker = this.workers.get(id);
    if (!worker) return false;

    if (worker.restartCount >= worker.maxRestarts) {
      worker.status = 'dead';
      this.emit('worker_dead', { id, restarts: worker.restartCount });
      return false;
    }

    worker.status = 'recovering';
    worker.restartCount++;

    this.emit('worker_recovering', { id, attempt: worker.restartCount });

    try {
      const strategy = this.recoveryStrategies.get(id);
      if (strategy) {
        await strategy();
      }

      worker.status = 'idle';
      worker.lastHeartbeat = Date.now();

      this.emit('worker_recovered', { id, attempts: worker.restartCount });
      return true;
    } catch (error) {
      worker.status = 'dead';
      this.emit('worker_recovery_failed', { id, error });
      return false;
    }
  }

  registerRecoveryStrategy(workerId: string, strategy: () => Promise<any>): void {
    this.recoveryStrategies.set(workerId, strategy);
  }

  startHeartbeat(intervalMs: number = 5000): void {
    this.heartbeatInterval = setInterval(() => {
      this.checkHeartbeats();
    }, intervalMs);
  }

  stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private async checkHeartbeats(): Promise<void> {
    const now = Date.now();
    const timeout = 30000;

    for (const [id, worker] of this.workers) {
      if (now - worker.lastHeartbeat > timeout) {
        log.warn(`Worker ${id} heartbeat timeout`);
        await this.recover(id);
      }
    }
  }

  getWorkerState(id: string): WorkerState | undefined {
    return this.workers.get(id);
  }

  getAllWorkerStates(): WorkerState[] {
    return Array.from(this.workers.values());
  }
}

export class BackpressureController extends EventEmitter {
  private maxConcurrent: number;
  private current: number = 0;
  private waiting: number = 0;
  private queue: (() => void)[] = [];

  constructor(maxConcurrent: number) {
    super();
    this.maxConcurrent = maxConcurrent;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.current >= this.maxConcurrent) {
      this.waiting++;
      this.emit('backpressure', { waiting: this.waiting });

      await new Promise<void>(resolve => {
        this.queue.push(resolve);
      });

      this.waiting--;
    }

    this.current++;

    try {
      return await fn();
    } finally {
      this.current--;

      if (this.queue.length > 0) {
        const next = this.queue.shift();
        if (next) next();
      }

      this.emit('released', { current: this.current, waiting: this.waiting });
    }
  }

  getStats(): { current: number; max: number; waiting: number } {
    return {
      current: this.current,
      max: this.maxConcurrent,
      waiting: this.waiting,
    };
  }
}

export const queue = new ProtectedQueue();
export const workerRecovery = new WorkerRecovery();
export const backpressure = new BackpressureController(10);

export default {
  queue,
  workerRecovery,
  backpressure,
};