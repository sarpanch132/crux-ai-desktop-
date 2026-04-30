import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import log from 'electron-log';

export interface CircuitBreakerConfig {
  failureThreshold: number;
  successThreshold: number;
  timeout: number;
  halfOpenMaxCalls: number;
  resetTimeout: number;
}

export interface CircuitBreakerState {
  name: string;
  status: 'closed' | 'open' | 'half-open';
  failures: number;
  successes: number;
  lastFailure?: number;
  nextAttempt?: number;
  callsDuringHalfOpen: number;
}

export interface CircuitBreakerMetrics {
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  rejectedCalls: number;
  averageDuration: number;
  p50Duration: number;
  p95Duration: number;
  p99Duration: number;
}

export class CircuitBreaker extends EventEmitter {
  private name: string;
  private config: CircuitBreakerConfig;
  private state: CircuitBreakerState;
  private callDurations: number[] = [];
  private metrics = {
    totalCalls: 0,
    successfulCalls: 0,
    failedCalls: 0,
    rejectedCalls: 0,
  };

  constructor(name: string, config: Partial<CircuitBreakerConfig> = {}) {
    super();
    this.name = name;
    this.config = {
      failureThreshold: config.failureThreshold ?? 5,
      successThreshold: config.successThreshold ?? 2,
      timeout: config.timeout ?? 30000,
      halfOpenMaxCalls: config.halfOpenMaxCalls ?? 3,
      resetTimeout: config.resetTimeout ?? 60000,
    };
    this.state = this.initializeState();
    this.startResetTimer();
  }

  private initializeState(): CircuitBreakerState {
    return {
      name: this.name,
      status: 'closed',
      failures: 0,
      successes: 0,
      callsDuringHalfOpen: 0,
    };
  }

  private startResetTimer(): void {
    setInterval(() => {
      if (this.state.status === 'open' && this.state.nextAttempt) {
        if (Date.now() >= this.state.nextAttempt) {
          this.transitionToHalfOpen();
        }
      }
    }, 5000);
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.canExecute()) {
      this.metrics.rejectedCalls++;
      this.emit('call:rejected', { name: this.name, state: this.state });
      throw new Error(`Circuit breaker ${this.name} is open`);
    }

    this.metrics.totalCalls++;
    const startTime = Date.now();

    try {
      const result = await fn();
      this.recordSuccess(Date.now() - startTime);
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  private canExecute(): boolean {
    if (this.state.status === 'closed') return true;

    if (this.state.status === 'half-open') {
      return this.state.callsDuringHalfOpen < this.config.halfOpenMaxCalls;
    }

    if (this.state.nextAttempt && Date.now() >= this.state.nextAttempt) {
      this.transitionToHalfOpen();
      return true;
    }

    return false;
  }

  private recordSuccess(duration: number): void {
    this.callDurations.push(duration);
    if (this.callDurations.length > 1000) this.callDurations.shift();

    this.metrics.successfulCalls++;
    this.state.successes++;

    if (this.state.status === 'half-open') {
      if (this.state.successes >= this.config.successThreshold) {
        this.transitionToClosed();
      }
    } else {
      this.state.failures = 0;
    }

    this.emit('call:success', { name: this.name, duration, state: this.state });
  }

  private recordFailure(): void {
    this.metrics.failedCalls++;
    this.state.failures++;
    this.state.lastFailure = Date.now();

    if (this.state.status === 'closed') {
      if (this.state.failures >= this.config.failureThreshold) {
        this.transitionToOpen();
      }
    } else if (this.state.status === 'half-open') {
      this.transitionToOpen();
    }

    this.emit('call:failure', { name: this.name, state: this.state });
  }

  private transitionToOpen(): void {
    this.state.status = 'open';
    this.state.nextAttempt = Date.now() + this.config.resetTimeout;
    this.state.callsDuringHalfOpen = 0;
    log.warn(`Circuit breaker ${this.name} opened`);
    this.emit('circuit:opened', { name: this.name, nextAttempt: this.state.nextAttempt });
  }

  private transitionToHalfOpen(): void {
    this.state.status = 'half-open';
    this.state.successes = 0;
    this.state.failures = 0;
    this.state.nextAttempt = undefined;
    log.info(`Circuit breaker ${this.name} half-open`);
    this.emit('circuit:half-open', { name: this.name });
  }

  private transitionToClosed(): void {
    this.state = this.initializeState();
    log.info(`Circuit breaker ${this.name} closed`);
    this.emit('circuit:closed', { name: this.name });
  }

  getState(): CircuitBreakerState {
    return { ...this.state };
  }

  getMetrics(): CircuitBreakerMetrics {
    const durations = [...this.callDurations].sort((a, b) => a - b);
    const average = durations.length
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : 0;

    return {
      ...this.metrics,
      averageDuration: average,
      p50Duration: this.percentile(durations, 0.5),
      p95Duration: this.percentile(durations, 0.95),
      p99Duration: this.percentile(durations, 0.99),
    };
  }

  private percentile(sorted: number[], p: number): number {
    if (!sorted.length) return 0;
    const idx = Math.floor(sorted.length * p);
    return sorted[Math.min(idx, sorted.length - 1)];
  }

  reset(): void {
    this.state = this.initializeState();
    this.callDurations = [];
    this.metrics = {
      totalCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      rejectedCalls: 0,
    };
  }
}

export class CircuitBreakerRegistry extends EventEmitter {
  private breakers: Map<string, CircuitBreaker> = new Map();
  private defaultConfig: Partial<CircuitBreakerConfig>;

  constructor(defaultConfig: Partial<CircuitBreakerConfig> = {}) {
    super();
    this.defaultConfig = defaultConfig;
  }

  getOrCreate(name: string, config?: Partial<CircuitBreakerConfig>): CircuitBreaker {
    let breaker = this.breakers.get(name);
    if (!breaker) {
      breaker = new CircuitBreaker(name, { ...this.defaultConfig, ...config });
      this.breakers.set(name, breaker);
    }
    return breaker;
  }

  get(name: string): CircuitBreaker | undefined {
    return this.breakers.get(name);
  }

  getAllStates(): Record<string, CircuitBreakerState> {
    const states: Record<string, CircuitBreakerState> = {};
    for (const [name, breaker] of this.breakers) {
      states[name] = breaker.getState();
    }
    return states;
  }

  getAllMetrics(): Record<string, CircuitBreakerMetrics> {
    const metrics: Record<string, CircuitBreakerMetrics> = {};
    for (const [name, breaker] of this.breakers) {
      metrics[name] = breaker.getMetrics();
    }
    return metrics;
  }

  reset(name?: string): void {
    if (name) {
      this.breakers.get(name)?.reset();
    } else {
      for (const [, breaker] of this.breakers) {
        breaker.reset();
      }
    }
  }

  remove(name: string): void {
    this.breakers.delete(name);
  }
}

export default CircuitBreakerRegistry;