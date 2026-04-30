import { EventEmitter } from 'events';
import log from 'electron-log';

export interface CacheOptions {
  maxSize?: number;
  maxAge?: number;
  ttl?: number;
  storage?: 'memory' | 'disk';
  diskPath?: string;
}

export interface CacheEntry<T> {
  key: string;
  value: T;
  timestamp: number;
  expiresAt?: number;
  hits: number;
  size: number;
}

export interface CacheStats {
  size: number;
  hits: number;
  misses: number;
  hitRate: number;
  totalSize: number;
  avgAge: number;
}

export class Cache<T = any> extends EventEmitter {
  private store: Map<string, CacheEntry<T>> = new Map();
  private options: Required<CacheOptions>;
  private hits: number = 0;
  private misses: number = 0;
  private maxSize: number;
  private maxAge: number;
  private ttl: number;

  constructor(options: CacheOptions = {}) {
    super();
    this.maxSize = options.maxSize || 1000;
    this.maxAge = options.maxAge || 3600000;
    this.ttl = options.ttl || this.maxAge;
    this.options = {
      maxSize: this.maxSize,
      maxAge: this.maxAge,
      ttl: this.ttl,
      storage: options.storage || 'memory',
      diskPath: options.diskPath || '',
    };
  }

  set(key: string, value: T, ttl?: number): void {
    const now = Date.now();
    const size = this.estimateSize(value);

    const entry: CacheEntry<T> = {
      key,
      value,
      timestamp: now,
      expiresAt: ttl ? now + ttl : now + this.ttl,
      hits: 0,
      size,
    };

    if (this.store.size >= this.maxSize && !this.store.has(key)) {
      this.evict();
    }

    this.store.set(key, entry);
    this.emit('cache:set', { key, size });
  }

  get(key: string, allowExpired = false): T | null {
    const entry = this.store.get(key);

    if (!entry) {
      this.misses++;
      this.emit('cache:miss', { key });
      return null;
    }

    if (!allowExpired && entry.expiresAt && entry.expiresAt < Date.now()) {
      this.store.delete(key);
      this.misses++;
      this.emit('cache:expired', { key });
      return null;
    }

    entry.hits++;
    this.hits++;
    this.emit('cache:hit', { key });

    return entry.value;
  }

  has(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  delete(key: string): boolean {
    const result = this.store.delete(key);
    if (result) {
      this.emit('cache:delete', { key });
    }
    return result;
  }

  clear(): void {
    const size = this.store.size;
    this.store.clear();
    this.hits = 0;
    this.misses = 0;
    this.emit('cache:clear', { size });
  }

  getOrCompute(key: string, compute: () => T | Promise<T>, ttl?: number): T | Promise<T> {
    const cached = this.get(key);
    if (cached !== null) return cached;

    if (typeof compute === 'function') {
      const result = compute();
      
      if (result instanceof Promise) {
        return result.then(value => {
          this.set(key, value, ttl);
          return value;
        });
      }

      this.set(key, result, ttl);
      return result;
    }

    return null as any;
  }

  async getOrComputeAsync(key: string, compute: () => Promise<T>, ttl?: number): Promise<T> {
    const cached = this.get(key);
    if (cached !== null) return cached;

    const value = await compute();
    this.set(key, value, ttl);
    return value;
  }

  private evict(): void {
    let oldest: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.store) {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldest = key;
      }
    }

    if (oldest) {
      this.store.delete(oldest);
      this.emit('cache:evict', { key: oldest });
    }
  }

  private estimateSize(value: any): number {
    if (typeof value === 'string') return value.length;
    if (typeof value === 'object') return JSON.stringify(value).length;
    return 1;
  }

  getStats(): CacheStats {
    const now = Date.now();
    let totalSize = 0;
    let totalAge = 0;
    let count = 0;

    for (const entry of this.store.values()) {
      totalSize += entry.size || 1;
      totalAge += now - entry.timestamp;
      count++;
    }

    return {
      size: this.store.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: this.hits + this.misses > 0 ? this.hits / (this.hits + this.misses) : 0,
      totalSize,
      avgAge: count > 0 ? totalAge / count : 0,
    };
  }

  getEntries(): CacheEntry<T>[] {
    return Array.from(this.store.values());
  }

  getKeys(): string[] {
    return Array.from(this.store.keys());
  }

  getValues(): T[] {
    return Array.from(this.store.values()).map(e => e.value);
  }

  prune(): number {
    const now = Date.now();
    let pruned = 0;

    for (const [key, entry] of this.store) {
      if (entry.expiresAt && entry.expiresAt < now) {
        this.store.delete(key);
        pruned++;
      }
    }

    if (pruned > 0) {
      this.emit('cache:prune', { pruned });
    }

    return pruned;
  }
}

export class MultiLevelCache<T = any> extends EventEmitter {
  private l1: Cache<T>;
  private l2: Cache<T>;
  private enabled: boolean;

  constructor(options?: { l1Size?: number; l2Size?: number }) {
    super();
    this.enabled = options?.l1Size !== 0;
    this.l1 = new Cache({ maxSize: options?.l1Size || 100 });
    this.l2 = new Cache({ maxSize: options?.l2Size || 1000 });

    this.setupListeners();
  }

  private setupListeners(): void {
    this.l1.on('cache:miss', () => {
      this.emit('cache:miss');
    });
  }

  set(key: string, value: T, ttl?: number): void {
    this.l2.set(key, value, ttl);
    if (this.enabled) {
      this.l1.set(key, value, ttl);
    }
  }

  async get(key: string): Promise<T | null> {
    if (this.enabled) {
      const l1Value = this.l1.get(key);
      if (l1Value !== null) {
        return l1Value;
      }
    }

    const l2Value = this.l2.get(key);
    if (l2Value !== null && this.enabled) {
      this.l1.set(key, l2Value);
    }

    return l2Value;
  }

  delete(key: string): boolean {
    this.l1.delete(key);
    return this.l2.delete(key);
  }

  clear(): void {
    this.l1.clear();
    this.l2.clear();
  }

  async prefetch(key: string, compute: () => Promise<T>, ttl?: number): Promise<void> {
    const cached = await this.get(key);
    if (cached === null) {
      const value = await compute();
      this.set(key, value, ttl);
    }
  }
}

export class MemoCache<T extends Function> {
  private cache: Map<string, T> = new Map();
  private fn: T;
  private ttl: number;

  constructor(fn: T, ttl = 60000) {
    this.fn = fn;
    this.ttl = ttl;
  }

  wrap(...args: any[]): any {
    const key = this.generateKey(args);
    const cached = this.cache.get(key);

    if (cached) {
      return cached;
    }

    const result = this.fn(...args);
    this.cache.set(key, result);

    setTimeout(() => {
      this.cache.delete(key);
    }, this.ttl);

    return result;
  }

  private generateKey(args: any[]): string {
    return args.map(a => JSON.stringify(a)).join(':');
  }

  clear(): void {
    this.cache.clear();
  }
}

export const fileCache = new Cache({ maxSize: 500 });
export const aiCache = new Cache({ maxSize: 100 });
export const searchCache = new Cache({ maxSize: 200 });