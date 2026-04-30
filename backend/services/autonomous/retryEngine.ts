import { EventEmitter } from 'events';
import log from 'electron-log';

export interface RetryConfig {
  maxRetries: number;
  initialDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
  jitter: boolean;
  retryableErrors?: RegExp[];
  nonRetryableErrors?: RegExp[];
}

export interface RetryAttempt {
  attempt: number;
  delay: number;
  timestamp: number;
  error: string;
}

export interface RetryResult {
  success: boolean;
  attempts: number;
  totalDelay: number;
  error?: string;
  lastError?: string;
}

const DEFAULT_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelay: 1000,
  maxDelay: 30000,
  backoffMultiplier: 2,
  jitter: true,
};

export class RetryEngine extends EventEmitter {
  private config: RetryConfig;
  private retryHistory: Map<string, RetryAttempt[]> = new Map();

  constructor(config: Partial<RetryConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async executeWithRetry<T>(
    taskId: string,
    fn: () => Promise<T>,
    options?: {
      maxRetries?: number;
      shouldRetry?: (error: any) => boolean;
    }
  ): Promise<RetryResult & { result?: T }> {
    const maxRetries = options?.maxRetries ?? this.config.maxRetries;
    const attempts: RetryAttempt[] = [];
    let attempt = 0;
    let totalDelay = 0;

    while (attempt < maxRetries) {
      attempt++;

      this.emit('retry:attempt', { taskId, attempt, maxRetries });

      try {
        const result = await fn();

        const successResult: RetryResult & { result?: T } = {
          success: true,
          attempts: attempt,
          totalDelay,
          result,
        };

        this.recordAttempts(taskId, attempts);
        
        return successResult;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const shouldRetry = options?.shouldRetry ?? this.shouldRetryError;

        if (!shouldRetry(error)) {
          this.recordAttempts(taskId, attempts);
          
          return {
            success: false,
            attempts: attempt,
            totalDelay,
            error: errorMessage,
            lastError: errorMessage,
          };
        }

        const delay = this.calculateDelay(attempt);
        totalDelay += delay;

        attempts.push({
          attempt,
          delay,
          timestamp: Date.now(),
          error: errorMessage,
        });

        log.warn(`Retry attempt ${attempt}/${maxRetries} for ${taskId}: ${errorMessage}`);

        this.emit('retry:delayed', { taskId, attempt, delay, error: errorMessage });

        if (attempt < maxRetries) {
          await this.sleep(delay);
        }
      }
    }

    const lastError = attempts[attempts.length - 1]?.error || 'Max retries exceeded';

    this.recordAttempts(taskId, attempts);

    return {
      success: false,
      attempts: attempt,
      totalDelay,
      error: lastError,
      lastError,
    };
  }

  async executeWithExponentialBackoff<T>(
    taskId: string,
    fn: () => Promise<T>,
    options?: {
      maxRetries?: number;
      baseDelay?: number;
      maxDelay?: number;
    }
  ): Promise<RetryResult & { result?: T }> {
    const maxRetries = options?.maxRetries ?? this.config.maxRetries;
    const baseDelay = options?.baseDelay ?? this.config.initialDelay;
    const maxDelay = options?.maxDelay ?? this.config.maxDelay;
    
    const attempts: RetryAttempt[] = [];
    let attempt = 0;
    let totalDelay = 0;

    while (attempt < maxRetries) {
      attempt++;

      this.emit('retry:attempt', { taskId, attempt, maxRetries });

      try {
        const result = await fn();

        this.recordAttempts(taskId, attempts);
        
        return {
          success: true,
          attempts: attempt,
          totalDelay,
          result,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        const delay = this.calculateExponentialDelay(attempt, baseDelay, maxDelay);
        totalDelay += delay;

        attempts.push({
          attempt,
          delay,
          timestamp: Date.now(),
          error: errorMessage,
        });

        log.warn(`Exponential backoff attempt ${attempt}/${maxRetries} for ${taskId}: ${errorMessage} (delay: ${delay}ms)`);

        if (attempt < maxRetries) {
          await this.sleep(delay);
        }
      }
    }

    const lastError = attempts[attempts.length - 1]?.error || 'Max retries exceeded';

    this.recordAttempts(taskId, attempts);

    return {
      success: false,
      attempts: attempt,
      totalDelay,
      error: lastError,
      lastError,
    };
  }

  private calculateDelay(attempt: number): number {
    let delay = this.config.initialDelay * Math.pow(this.config.backoffMultiplier, attempt - 1);
    delay = Math.min(delay, this.config.maxDelay);

    if (this.config.jitter) {
      delay = delay * (0.5 + Math.random() * 0.5);
    }

    return Math.floor(delay);
  }

  private calculateExponentialDelay(attempt: number, baseDelay: number, maxDelay: number): number {
    let delay = baseDelay * Math.pow(2, attempt - 1);
    delay = Math.min(delay, maxDelay);

    if (this.config.jitter) {
      delay = delay * (0.5 + Math.random() * 0.5);
    }

    return Math.floor(delay);
  }

  private shouldRetryError(error: any): boolean {
    if (!this.config.retryableErrors && !this.config.nonRetryableErrors) {
      return true;
    }

    const errorMessage = error instanceof Error ? error.message : String(error);

    if (this.config.nonRetryableErrors) {
      for (const pattern of this.config.nonRetryableErrors) {
        if (pattern.test(errorMessage)) {
          return false;
        }
      }
    }

    if (this.config.retryableErrors) {
      for (const pattern of this.config.retryableErrors) {
        if (pattern.test(errorMessage)) {
          return true;
        }
      }
      return false;
    }

    return true;
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private recordAttempts(taskId: string, attempts: RetryAttempt[]): void {
    this.retryHistory.set(taskId, attempts);
  }

  getRetryHistory(taskId: string): RetryAttempt[] {
    return this.retryHistory.get(taskId) || [];
  }

  getStats(): {
    totalTasks: number;
    totalAttempts: number;
    avgAttemptsPerTask: number;
    successRate: number;
  } {
    let totalAttempts = 0;
    let successfulTasks = 0;

    for (const attempts of this.retryHistory.values()) {
      if (attempts.length > 0) {
        totalAttempts += attempts.length;
        successfulTasks++;
      }
    }

    return {
      totalTasks: this.retryHistory.size,
      totalAttempts,
      avgAttemptsPerTask: this.retryHistory.size > 0 ? totalAttempts / this.retryHistory.size : 0,
      successRate: this.retryHistory.size > 0 ? successfulTasks / this.retryHistory.size : 0,
    };
  }

  clearHistory(): void {
    this.retryHistory.clear();
  }

  setConfig(config: Partial<RetryConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

export default RetryEngine;