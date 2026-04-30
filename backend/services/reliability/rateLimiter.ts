import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import log from 'electron-log';

export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
  blockDurationMs: number;
  identifierExtractor?: (request: any) => string;
}

export interface RateLimitEntry {
  count: number;
  firstRequest: number;
  lastRequest: number;
  blocked: boolean;
  blockExpires?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfter?: number;
  remaining: number;
  resetAt: number;
}

export class RateLimiter extends EventEmitter {
  private config: RateLimitConfig;
  private entries: Map<string, RateLimitEntry> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(config: Partial<RateLimitConfig> = {}) {
    super();
    this.config = {
      maxRequests: config.maxRequests ?? 100,
      windowMs: config.windowMs ?? 60000,
      blockDurationMs: config.blockDurationMs ?? 300000,
      identifierExtractor: config.identifierExtractor,
    };

    this.startCleanup();
  }

  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      let cleaned = 0;

      for (const [id, entry] of this.entries) {
        if (entry.blockExpires && entry.blockExpires < now) {
          entry.blocked = false;
          entry.blockExpires = undefined;
          entry.count = 0;
        }

        if (!entry.blocked && entry.lastRequest && now - entry.lastRequest > this.config.windowMs * 2) {
          this.entries.delete(id);
          cleaned++;
        }
      }

      if (cleaned > 0) {
        log.debug(`Rate limiter cleanup: ${cleaned} entries`);
      }
    }, 60000);
  }

  check(identifier: string): RateLimitResult {
    const now = Date.now();
    let entry = this.entries.get(identifier);

    if (!entry) {
      entry = { count: 0, firstRequest: now, lastRequest: now, blocked: false };
      this.entries.set(identifier, entry);
    }

    if (entry.blocked) {
      const retryAfter = entry.blockExpires ? entry.blockExpires - now : this.config.blockDurationMs;
      this.emit('rate_limit: blocked', { identifier, retryAfter });
      return {
        allowed: false,
        retryAfter,
        remaining: 0,
        resetAt: entry.blockExpires || now,
      };
    }

    const windowStart = now - this.config.windowMs;
    if (entry.lastRequest && entry.lastRequest < windowStart) {
      entry.count = 0;
    }

    const remaining = this.config.maxRequests - entry.count;
    const resetAt = entry.firstRequest + this.config.windowMs;

    if (entry.count >= this.config.maxRequests) {
      entry.blocked = true;
      entry.blockExpires = now + this.config.blockDurationMs;
      log.warn(`Rate limit exceeded for: ${identifier}`);
      this.emit('rate_limit: exceeded', { identifier });
      return {
        allowed: false,
        retryAfter: this.config.blockDurationMs,
        remaining: 0,
        resetAt,
      };
    }

    entry.count++;
    entry.lastRequest = now;
    if (entry.count === 1) {
      entry.firstRequest = now;
    }

    return {
      allowed: true,
      remaining: this.config.maxRequests - entry.count,
      resetAt,
    };
  }

  checkWithRequest(request: any): RateLimitResult {
    const identifier = this.config.identifierExtractor
      ? this.config.identifierExtractor(request)
      : this.getDefaultIdentifier(request);

    return this.check(identifier);
  }

  private getDefaultIdentifier(request: any): string {
    const ip = request.ip || request.headers?.['x-forwarded-for'] || 'unknown';
    const user = request.user?.id || 'anonymous';
    return `${ip}:${user}`;
  }

  reset(identifier: string): void {
    const entry = this.entries.get(identifier);
    if (entry) {
      entry.count = 0;
      entry.blocked = false;
      entry.blockExpires = undefined;
      log.info(`Rate limit reset for: ${identifier}`);
    }
  }

  getStatus(identifier: string): RateLimitEntry | null {
    return this.entries.get(identifier) || null;
  }

  getAllStatuses(): Map<string, RateLimitEntry> {
    return new Map(this.entries);
  }

  close(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

export class TokenBucket extends EventEmitter {
  private capacity: number;
  private tokens: number;
  private refillRate: number;
  private lastRefill: number;
  private refillInterval: NodeJS.Timeout | null = null;

  constructor(capacity: number, refillRatePerSecond: number) {
    super();
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillRate = refillRatePerSecond;
    this.lastRefill = Date.now();

    this.startRefill();
  }

  private startRefill(): void {
    this.refillInterval = setInterval(() => {
      this.refill();
    }, 1000);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    const tokensToAdd = elapsed * this.refillRate;

    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  tryConsume(tokens: number = 1): boolean {
    this.refill();

    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return true;
    }

    this.emit('token_bucket: exhausted', {
      requested: tokens,
      available: this.tokens,
      capacity: this.capacity,
    });

    return false;
  }

  waitForTokens(tokens: number = 1): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.tryConsume(tokens)) {
          resolve();
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
  }

  getAvailable(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  getCapacity(): number {
    return this.capacity;
  }

  close(): void {
    if (this.refillInterval) {
      clearInterval(this.refillInterval);
      this.refillInterval = null;
    }
  }
}

export default RateLimiter;