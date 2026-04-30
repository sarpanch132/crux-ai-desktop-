import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import log from 'electron-log';

export interface LockConfig {
  ttl: number;
  retryInterval: number;
  maxRetries: number;
}

export interface Lock {
  id: string;
  key: string;
  owner: string;
  acquiredAt: number;
  expiresAt: number;
  ttl: number;
}

export class DistributedLock extends EventEmitter {
  private locks: Map<string, Lock> = new Map();
  private config: LockConfig;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private ownerId: string;

  constructor(config: Partial<LockConfig> = {}) {
    super();
    this.config = {
      ttl: config.ttl ?? 30000,
      retryInterval: config.retryInterval ?? 100,
      maxRetries: config.maxRetries ?? 10,
    };
    this.ownerId = randomUUID().slice(0, 8);

    this.startCleanup();
  }

  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, this.config.ttl / 2);
  }

  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, lock] of this.locks) {
      if (lock.expiresAt < now) {
        this.locks.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      log.debug(`Lock cleanup: ${cleaned} expired locks`);
    }
  }

  async acquire(key: string, ttl?: number): Promise<boolean> {
    const now = Date.now();
    const expiresAt = now + (ttl || this.config.ttl);

    const existing = this.locks.get(key);

    if (existing) {
      if (existing.expiresAt < now) {
        this.locks.delete(key);
      } else if (existing.owner === this.ownerId) {
        existing.expiresAt = expiresAt;
        return true;
      } else {
        return false;
      }
    }

    const lock: Lock = {
      id: randomUUID(),
      key,
      owner: this.ownerId,
      acquiredAt: now,
      expiresAt,
      ttl: ttl || this.config.ttl,
    };

    this.locks.set(key, lock);
    this.emit('acquired', { key, owner: this.ownerId });

    return true;
  }

  async release(key: string): Promise<boolean> {
    const lock = this.locks.get(key);

    if (!lock) {
      return false;
    }

    if (lock.owner !== this.ownerId) {
      log.warn(`Cannot release lock owned by another process: ${lock.owner}`);
      return false;
    }

    this.locks.delete(key);
    this.emit('released', { key, owner: this.ownerId });

    return true;
  }

  async waitForLock(key: string, ttl?: number): Promise<boolean> {
    for (let i = 0; i < this.config.maxRetries; i++) {
      if (await this.acquire(key, ttl)) {
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, this.config.retryInterval));
    }

    return false;
  }

  isLocked(key: string): boolean {
    const lock = this.locks.get(key);
    if (!lock) return false;
    return lock.expiresAt > Date.now();
  }

  getLock(key: string): Lock | undefined {
    return this.locks.get(key);
  }

  getAllLocks(): Lock[] {
    return Array.from(this.locks.values());
  }

  forceRelease(key: string): boolean {
    const result = this.locks.delete(key);
    if (result) {
      this.emit('force_released', { key });
    }
    return result;
  }

  close(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.locks.clear();
  }
}

export class Semaphore extends EventEmitter {
  private permits: number;
  private maxPermits: number;
  private waiting: Map<string, () => void> = new Map();

  constructor(maxPermits: number) {
    super();
    this.maxPermits = maxPermits;
    this.permits = maxPermits;
  }

  async acquire(): Promise<boolean> {
    if (this.permits > 0) {
      this.permits--;
      this.emit('acquired', { remaining: this.permits });
      return true;
    }

    return new Promise((resolve) => {
      const id = randomUUID();
      this.waiting.set(id, () => {
        this.permits--;
        this.waiting.delete(id);
        this.emit('acquired', { remaining: this.permits });
        resolve(true);
      });
    });
  }

  release(): void {
    if (this.permits >= this.maxPermits) return;

    const waiter = this.waiting.values().next().value;
    if (waiter) {
      waiter();
    } else {
      this.permits++;
    }

    this.emit('released', { remaining: this.permits });
  }

  getPermits(): number {
    return this.permits;
  }

  getWaiting(): number {
    return this.waiting.size;
  }
}

export class ReadWriteLock extends EventEmitter {
  private readSemaphore: Semaphore;
  private writeLock: DistributedLock;
  private readCount: number = 0;
  private writePending: number = 0;

  constructor() {
    super();
    this.readSemaphore = new Semaphore(10);
    this.writeLock = new DistributedLock({ ttl: 60000 });
  }

  async readLock<T>(fn: () => Promise<T>): Promise<T> {
    this.readCount++;
    if (this.writePending === 0) {
      await this.readSemaphore.acquire();
    }

    try {
      return await fn();
    } finally {
      this.readCount--;
      if (this.readCount === 0) {
        this.readSemaphore.release();
      }
    }
  }

  async writeLock_<T>(fn: () => Promise<T>): Promise<T> {
    this.writePending++;

    await this.writeLock.acquire('write', 60000);

    try {
      return await fn();
    } finally {
      this.writePending--;
      await this.writeLock.release('write');
    }
  }
}

export class AtomicCounter extends EventEmitter {
  private value: number = 0;
  private lock: DistributedLock;

  constructor() {
    super();
    this.lock = new DistributedLock();
  }

  async increment(): Promise<number> {
    await this.lock.acquire('counter');
    this.value++;
    const result = this.value;
    await this.lock.release('counter');
    return result;
  }

  async decrement(): Promise<number> {
    await this.lock.acquire('counter');
    this.value--;
    const result = this.value;
    await this.lock.release('counter');
    return result;
  }

  async get(): Promise<number> {
    return this.value;
  }

  async set(value: number): Promise<void> {
    await this.lock.acquire('counter');
    this.value = value;
    await this.lock.release('counter');
  }

  async add(delta: number): Promise<number> {
    await this.lock.acquire('counter');
    this.value += delta;
    const result = this.value;
    await this.lock.release('counter');
    return result;
  }
}

export default DistributedLock;