import { EventEmitter } from 'events';
import log from 'electron-log';

export interface ContextItem {
  id: string;
  type: string;
  content: string;
  importance: number;
  timestamp: number;
  metadata?: Record<string, any>;
  tokens: number;
}

export interface CompressionConfig {
  maxTokens: number;
  targetTokens: number;
  minImportance: number;
  preserveRecent: number;
}

export class ContextCompressor extends EventEmitter {
  private config: CompressionConfig;
  private items: ContextItem[] = [];
  private tokenCounts: Map<string, number> = new Map();

  constructor(config: Partial<CompressionConfig> = {}) {
    super();
    this.config = {
      maxTokens: config.maxTokens ?? 8000,
      targetTokens: config.targetTokens ?? 6000,
      minImportance: config.minImportance ?? 0.3,
      preserveRecent: config.preserveRecent ?? 10,
    };
  }

  addItem(item: Omit<ContextItem, 'tokens'>): void {
    const tokens = this.estimateTokens(item.content);
    const fullItem: ContextItem = { ...item, tokens };
    this.items.push(fullItem);
    this.tokenCounts.set(item.id, tokens);
  }

  compress(): ContextItem[] {
    const totalTokens = this.getTotalTokens();

    if (totalTokens <= this.config.targetTokens) {
      return this.items;
    }

    const sorted = [...this.items].sort((a, b) => {
      const recentA = this.items.indexOf(a) >= this.items.length - this.config.preserveRecent;
      const recentB = this.items.indexOf(b) >= this.items.length - this.config.preserveRecent;

      if (recentA && !recentB) return -1;
      if (!recentA && recentB) return 1;

      return b.importance - a.importance;
    });

    let currentTokens = totalTokens;
    const kept: ContextItem[] = [];

    for (const item of sorted) {
      if (currentTokens <= this.config.targetTokens) {
        break;
      }

      if (item.importance < this.config.minImportance && currentTokens - item.tokens > this.config.targetTokens) {
        continue;
      }

      kept.push(item);
      currentTokens -= item.tokens;
    }

    const recent = this.items.slice(-this.config.preserveRecent);
    const result = [...kept, ...recent].sort((a, b) => b.timestamp - a.timestamp);

    this.emit('compressed', {
      original: totalTokens,
      compressed: this.getItemTokens(result),
      removed: this.items.length - result.length,
    });

    return result;
  }

  getItemTokens(items: ContextItem[]): number {
    return items.reduce((sum, item) => sum + item.tokens, 0);
  }

  getTotalTokens(): number {
    return this.items.reduce((sum, item) => sum + item.tokens, 0);
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  getItems(): ContextItem[] {
    return [...this.items];
  }

  clear(): void {
    this.items = [];
    this.tokenCounts.clear();
  }
}

export class TokenOptimizer extends EventEmitter {
  private budget: number;
  private spent: number = 0;
  private allocations: Map<string, number> = new Map();

  constructor(budget: number) {
    super();
    this.budget = budget;
  }

  allocate(category: string, tokens: number): boolean {
    const available = this.getAvailable();

    if (tokens > available) {
      this.emit('budget_exceeded', { category, requested: tokens, available });
      return false;
    }

    const current = this.allocations.get(category) || 0;
    this.allocations.set(category, current + tokens);
    this.spent += tokens;

    return true;
  }

  release(category: string, tokens: number): void {
    const current = this.allocations.get(category) || 0;
    const released = Math.min(current, tokens);
    this.allocations.set(category, current - released);
    this.spent -= released;
  }

  getAvailable(): number {
    return this.budget - this.spent;
  }

  getUsage(): Record<string, number> {
    return Object.fromEntries(this.allocations);
  }

  reset(): void {
    this.spent = 0;
    this.allocations.clear();
  }
}

export class SmartContextManager extends EventEmitter {
  private compressor: ContextCompressor;
  private optimizer: TokenOptimizer;
  private priorityMap: Map<string, number> = new Map();

  constructor(maxTokens: number = 8000) {
    super();
    this.compressor = new ContextCompressor({ maxTokens });
    this.optimizer = new TokenOptimizer(maxTokens);
  }

  addContext(type: string, content: string, priority: number = 0.5): void {
    const item: ContextItem = {
      id: `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      type,
      content,
      importance: priority,
      timestamp: Date.now(),
    };

    this.compressor.addItem(item);
    this.compressor.compress();
  }

  getOptimizedContext(): string {
    const items = this.compressor.compress();

    return items
      .sort((a, b) => b.importance - a.importance)
      .map(item => `[${item.type}] ${item.content}`)
      .join('\n\n');
  }

  summarize(item: ContextItem): string {
    const lines = item.content.split('\n');
    if (lines.length <= 3) return item.content;

    const summary = lines.slice(0, 2);
    summary.push(`... (${lines.length - 2} more lines)`);

    return summary.join('\n');
  }

  getStats(): { total: number; available: number; items: number } {
    return {
      total: 8000,
      available: this.optimizer.getAvailable(),
      items: this.compressor.getItems().length,
    };
  }
}

export default ContextCompressor;