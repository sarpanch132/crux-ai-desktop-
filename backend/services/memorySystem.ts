import { EventEmitter } from 'events';
import { readFile, writeFile, mkdir, access } from 'fs/promises';
import { join, dirname } from 'path';
import { v4 as uuidv4 } from 'uuid';
import log from 'electron-log';
import { AgentConfig, ExecutionResult } from '../types/index.js';

export interface Memory {
  id: string;
  type: 'step_completion' | 'summary' | 'context' | 'fact' | 'preference' | 'error' | 'file';
  content: any;
  metadata?: Record<string, any>;
  timestamp: number;
  embedding?: number[];
  importance: number;
}

export interface MemoryQuery {
  type?: string;
  limit?: number;
  minImportance?: number;
  since?: number;
}

export class MemorySystem extends EventEmitter {
  private config: AgentConfig;
  private memories: Memory[] = [];
  private maxMemories: number;
  private persistencePath?: string;
  private embeddings: Map<string, number[]> = new Map();

  constructor(config: AgentConfig) {
    super();
    this.config = config;
    this.maxMemories = config.maxMemories || 1000;
    this.persistencePath = config.memoryPath;

    if (this.persistencePath) {
      this.loadMemories();
    }
  }

  async store(memory: Omit<Memory, 'id' | 'timestamp' | 'importance'>): Promise<Memory> {
    const newMemory: Memory = {
      ...memory,
      id: uuidv4(),
      timestamp: Date.now(),
      importance: this.calculateImportance(memory),
    };

    this.memories.push(newMemory);
    
    if (this.config.embeddings && memory.type !== 'file') {
      await this.generateEmbedding(newMemory);
    }

    this.memories.sort((a, b) => b.importance - a.importance);
    
    while (this.memories.length > this.maxMemories) {
      const lowestImportance = this.memories[this.memories.length - 1];
      if (lowestImportance.importance <= 0) {
        this.memories.pop();
      } else {
        this.trimMemories();
      }
    }

    if (this.persistencePath) {
      await this.persistMemories();
    }

    this.emit('memory:stored', newMemory);
    log.debug(`Stored memory: ${newMemory.type} - ${newMemory.id}`);

    return newMemory;
  }

  private calculateImportance(memory: Omit<Memory, 'id' | 'timestamp' | 'importance'>): number {
    switch (memory.type) {
      case 'error':
        return 10;
      case 'step_completion':
        return 8;
      case 'context':
        return 5;
      case 'summary':
        return 4;
      case 'fact':
        return 3;
      case 'preference':
        return 2;
      default:
        return 1;
    }
  }

  private async generateEmbedding(memory: Memory): Promise<void> {
    const { AIService } = await import('./aiService.js');
    
    try {
      const text = typeof memory.content === 'string' 
        ? memory.content 
        : JSON.stringify(memory.content);
      
      const response = await AIService.chat([
        { role: 'system', content: 'Generate a single line summary for embedding.' },
        { role: 'user', content: `Summarize: ${text}` },
      ]);

      const hash = this.simpleHash(response);
      this.embeddings.set(memory.id, [hash]);
    } catch (error) {
      log.warn('Failed to generate embedding:', error);
    }
  }

  private simpleHash(text: string): number {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash;
  }

  query(query: MemoryQuery = {}): Memory[] {
    let results = [...this.memories];

    if (query.type) {
      results = results.filter(m => m.type === query.type);
    }

    if (query.minImportance !== undefined) {
      results = results.filter(m => m.importance >= query.minImportance!);
    }

    if (query.since) {
      results = results.filter(m => m.timestamp >= query.since!);
    }

    results.sort((a, b) => b.importance - a.importance || b.timestamp - a.timestamp);

    if (query.limit) {
      results = results.slice(0, query.limit);
    }

    return results;
  }

  async search(query: string, limit = 5): Promise<Memory[]> {
    const { AIService } = await import('./aiService.js');
    
    try {
      const response = await AIService.chat([
        { role: 'system', content: 'Find relevant memories. Just list memory IDs.' },
        { role: 'user', content: `Query: ${query}\n\nMemories:\n${this.memories.map(m => `${m.id}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`).join('\n')}` },
      ]);

      const ids = response.match(/[a-f0-9-]{36}/g) || [];
      
      return ids
        .map(id => this.memories.find(m => m.id === id))
        .filter(Boolean)
        .slice(0, limit) as Memory[];
    } catch (error) {
      log.warn('Search failed, using fallback:', error);
      return this.simpleSearch(query, limit);
    }
  }

  private simpleSearch(query: string, limit: number): Memory[] {
    const queryLower = query.toLowerCase();
    
    return this.memories
      .filter(m => {
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return content.toLowerCase().includes(queryLower);
      })
      .sort((a, b) => b.importance - a.importance)
      .slice(0, limit);
  }

  getRecent(type?: string, limit = 10): Memory[] {
    return this.query({ type, limit });
  }

  getErrors(limit = 5): Memory[] {
    return this.query({ type: 'error', limit });
  }

  getSummaries(): Memory[] {
    return this.query({ type: 'summary', limit: 10 });
  }

  async storeContext(context: any): Promise<void> {
    await this.store({
      type: 'context',
      content: context,
      metadata: { source: 'agent' },
    });
  }

  async storeError(error: Error): Promise<void> {
    await this.store({
      type: 'error',
      content: {
        message: error.message,
        stack: error.stack,
      },
      metadata: { category: 'execution' },
    });
  }

  async storePreference(key: string, value: any): Promise<void> {
    await this.store({
      type: 'preference',
      content: { key, value },
      metadata: { category: 'user_preference' },
    });
  }

  getPreferences(): Record<string, any> {
    const prefs = this.query({ type: 'preference' });
    return prefs.reduce((acc, m) => {
      if (m.content.key) {
        acc[m.content.key] = m.content.value;
      }
      return acc;
    }, {} as Record<string, any>);
  }

  private trimMemories(): void {
    const half = Math.floor(this.maxMemories / 2);
    this.memories = this.memories.slice(0, half);
  }

  async persistMemories(): Promise<void> {
    if (!this.persistencePath) return;

    try {
      await mkdir(dirname(this.persistencePath), { recursive: true });
      
      const data = JSON.stringify(this.memories, null, 2);
      await writeFile(this.persistencePath, data, 'utf-8');
      
      log.debug(`Persisted ${this.memories.length} memories to ${this.persistencePath}`);
    } catch (error) {
      log.error('Failed to persist memories:', error);
    }
  }

  private async loadMemories(): Promise<void> {
    if (!this.persistencePath) return;

    try {
      await access(this.persistencePath);
      const data = await readFile(this.persistencePath, 'utf-8');
      this.memories = JSON.parse(data);
      
      log.info(`Loaded ${this.memories.length} memories from ${this.persistencePath}`);
    } catch (error) {
      log.debug('No persisted memories found');
    }
  }

  clear(type?: string): void {
    if (type) {
      this.memories = this.memories.filter(m => m.type !== type);
    } else {
      this.memories = [];
    }
    
    log.info(`Cleared memories${type ? ` of type: ${type}` : ''}`);
  }

  getStats(): {
    total: number;
    byType: Record<string, number>;
    oldestTime: number;
    newestTime: number;
  } {
    const byType: Record<string, number> = {};
    
    for (const memory of this.memories) {
      byType[memory.type] = (byType[memory.type] || 0) + 1;
    }

    const timestamps = this.memories.map(m => m.timestamp);

    return {
      total: this.memories.length,
      byType,
      oldestTime: Math.min(...timestamps),
      newestTime: Math.max(...timestamps),
    };
  }
}

export default MemorySystem;