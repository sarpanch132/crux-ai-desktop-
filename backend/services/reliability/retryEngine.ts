import { EventEmitter } from 'events';
import log from 'electron-log';

export interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitter: boolean;
  retryableErrors: string[];
  nonRetryableErrors: string[];
  timeout: number;
}

export interface RetryState {
  attempt: number;
  lastError?: Error;
  nextDelay: number;
  startedAt: number;
  lastAttemptAt?: number;
  totalDelay: number;
}

export interface RetryResult<T> {
  success: boolean;
  result?: T;
  error?: Error;
  state: RetryState;
  finalAttempt: boolean;
}

export class RetryEngine extends EventEmitter {
  private defaultConfig: RetryConfig;

  constructor(defaultConfig: Partial<RetryConfig> = {}) {
    super();
    this.defaultConfig = {
      maxRetries: defaultConfig.maxRetries ?? 3,
      initialDelayMs: defaultConfig.initialDelayMs ?? 1000,
      maxDelayMs: defaultConfig.maxDelayMs ?? 30000,
      backoffMultiplier: defaultConfig.backoffMultiplier ?? 2,
      jitter: defaultConfig.jitter ?? true,
      retryableErrors: defaultConfig.retryableErrors ?? [
        'ECONNREFUSED',
        'ETIMEDOUT',
        'ENOTFOUND',
        'ECONNRESET',
        'network',
        'timeout',
      ],
      nonRetryableErrors: defaultConfig.nonRetryableErrors ?? [
        'AUTHENTICATION',
        'AUTHORIZATION',
        'PERMISSION',
        'INVALID',
        'VALIDATION',
      ],
      timeout: defaultConfig.timeout ?? 60000,
    };
  }

  async execute<T>(
    fn: () => Promise<T>,
    config?: Partial<RetryConfig>,
    state?: RetryState
  ): Promise<RetryResult<T>> {
    const cfg = { ...this.defaultConfig, ...config };
    const retryState = state || this.initializeState();

    log.info(`Retry attempt ${retryState.attempt + 1}/${cfg.maxRetries}`);

    try {
      const result = await this.executeWithTimeout(fn, cfg.timeout);
      
      this.emit('retry:success', { attempt: retryState.attempt, result });
      return {
        success: true,
        result,
        state: retryState,
        finalAttempt: true,
      };
    } catch (error) {
      const err = error as Error;
      retryState.lastError = err;
      retryState.lastAttemptAt = Date.now();

      if (!this.isRetryable(err, cfg)) {
        log.warn(`Non-retryable error: ${err.message}`);
        this.emit('retry:failed', { attempt: retryState.attempt, error: err });
        return {
          success: false,
          error: err,
          state: retryState,
          finalAttempt: true,
        };
      }

      if (retryState.attempt >= cfg.maxRetries) {
        log.error(`Max retries exceeded: ${cfg.maxRetries}`);
        this.emit('retry:exhausted', { state: retryState, error: err });
        return {
          success: false,
          error: err,
          state: retryState,
          finalAttempt: true,
        };
      }

      retryState.attempt++;
      const delay = this.calculateDelay(retryState.attempt, cfg, retryState);
      retryState.nextDelay = delay;
      retryState.totalDelay += delay;

      log.info(`Retrying in ${delay}ms (total: ${retryState.totalDelay}ms)`);
      this.emit('retry:attempt', { attempt: retryState.attempt, delay, error: err });

      await this.sleep(delay);

      return this.execute(fn, cfg, retryState);
    }
  }

  private executeWithTimeout<T>(fn: () => Promise<T>, timeout: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Operation timed out after ${timeout}ms`));
      }, timeout);

      fn()
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  private initializeState(): RetryState {
    return {
      attempt: 0,
      nextDelay: this.defaultConfig.initialDelayMs,
      startedAt: Date.now(),
      totalDelay: 0,
    };
  }

  private isRetryable(error: Error, config: RetryConfig): boolean {
    const message = error.message.toLowerCase();
    const name = error.name.toLowerCase();

    for (const pattern of config.nonRetryableErrors) {
      if (message.includes(pattern.toLowerCase()) {
        return false;
      }
    }

    for (const pattern of config.retryableErrors) {
      if (message.includes(pattern.toLowerCase()) {
        return true;
      }
    }

    return true;
  }

  private calculateDelay(attempt: number, config: RetryConfig, state: RetryState): number {
    let delay = Math.min(
      config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt - 1),
      config.maxDelayMs
    );

    if (config.jitter) {
      delay = delay * (0.5 + Math.random() * 0.5);
    }

    return Math.floor(delay);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export class BudgetEnforcer extends EventEmitter {
  private budget: number;
  private spent: number = 0;
  private operations: Map<string, number> = new Map();
  private limits: Map<string, number> = new Map();
  private warnings: Map<string, boolean> = new Map();

  constructor(budget: number) {
    super();
    this.budget = budget;
  }

  tryConsume(operation: string, cost: number = 1): { allowed: boolean; remaining: number; exhausted: boolean } {
    if (this.spent + cost > this.budget) {
      this.emit('budget:exhausted', { operation, cost, remaining: this.budget - this.spent });
      return {
        allowed: false,
        remaining: this.budget - this.spent,
        exhausted: true,
      };
    }

    this.spent += cost;
    const current = this.operations.get(operation) || 0;
    this.operations.set(operation, current + cost);

    const remaining = this.budget - this.spent;
    const warnThreshold = this.budget * 0.8;

    if (remaining < warnThreshold && !this.warnings.get(operation)) {
      this.warnings.set(operation, true);
      this.emit('budget:warning', { operation, remaining, threshold: warnThreshold });
    }

    return {
      allowed: true,
      remaining,
      exhausted: false,
    };
  }

  setLimit(operation: string, limit: number): void {
    this.limits.set(operation, limit);
  }

  checkLimit(operation: string): { withinLimit: boolean; used: number; limit: number } {
    const limit = this.limits.get(operation);
    const used = this.operations.get(operation) || 0;

    if (!limit) return { withinLimit: true, used, limit: Infinity };

    return {
      withinLimit: used <= limit,
      used,
      limit,
    };
  }

  getRemaining(): number {
    return this.budget - this.spent;
  }

  getSpent(): number {
    return this.spent;
  }

  getUsage(): Record<string, number> {
    return Object.fromEntries(this.operations);
  }

  reset(operation?: string): void {
    if (operation) {
      this.operations.delete(operation);
      this.warnings.delete(operation);
    } else {
      this.spent = 0;
      this.operations.clear();
      this.warnings.clear();
    }
  }
}

export default RetryEngine;