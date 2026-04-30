import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import log from 'electron-log';

export type MemoryType = 'episodic' | 'semantic' | 'working' | 'archived';

export interface Memory {
  id: string;
  type: MemoryType;
  content: string;
  embedding?: number[];
  importance: number;
  timestamp: number;
  lastAccessed: number;
  accessCount: number;
  projectId?: string;
  tags: string[];
  metadata?: Record<string, any>;
  compressed?: boolean;
  summary?: string;
}

export interface MemoryQuery {
  type?: MemoryType;
  projectId?: string;
  tags?: string[];
  minImportance?: number;
  timeRange?: { start: number; end: number };
  limit?: number;
}

export interface MemoryStats {
  total: number;
  byType: Record<MemoryType, number>;
  totalTokens: number;
  avgImportance: number;
  staleMemories: number;
}

export interface MemoryConflict {
  id1: string;
  id2: string;
  type: 'contradiction' | 'redundancy' | 'outdated';
  resolution?: string;
}

class MemoryTier extends EventEmitter {
  private memories: Map<string, Memory> = new Map();
  private type: MemoryType;
  private maxSize: number;
  private maxAge: number;

  constructor(type: MemoryType, maxSize: number, maxAgeMs: number) {
    super();
    this.type = type;
    this.maxSize = maxSize;
    this.maxAge = maxAgeMs;
  }

  store(memory: Memory): void {
    if (this.memories.size >= this.maxSize) {
      this.prune();
    }
    this.memories.set(memory.id, memory);
  }

  retrieve(id: string): Memory | undefined {
    const memory = this.memories.get(id);
    if (memory) {
      memory.lastAccessed = Date.now();
      memory.accessCount++;
    }
    return memory;
  }

  query(fn: (memory: Memory) => boolean): Memory[] {
    return Array.from(this.memories.values()).filter(fn);
  }

  size(): number {
    return this.memories.size;
  }

  getAll(): Memory[] {
    return Array.from(this.memories.values());
  }

  private prune(): void {
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [id, memory] of this.memories) {
      if (now - memory.lastAccessed > this.maxAge && memory.importance < 0.5) {
        toRemove.push(id);
      }
    }

    toRemove.forEach(id => this.memories.delete(id));
  }

  clear(): void {
    this.memories.clear();
  }
}

export class EnterpriseMemory extends EventEmitter {
  private episodic: MemoryTier;
  private semantic: MemoryTier;
  private working: MemoryTier;
  private archived: MemoryTier;
  
  private config: {
    episodicSize: number;
    semanticSize: number;
    workingSize: number;
    archivedSize: number;
    episodicMaxAge: number;
    semanticMaxAge: number;
    workingMaxAge: number;
  };

  constructor() {
    super();
    
    this.config = {
      episodicSize: 1000,
      semanticSize: 5000,
      workingSize: 100,
      archivedSize: 10000,
      episodicMaxAge: 24 * 60 * 60 * 1000,
      semanticMaxAge: 30 * 24 * 60 * 60 * 1000,
      workingMaxAge: 60 * 60 * 1000,
    };

    this.episodic = new MemoryTier('episodic', this.config.episodicSize, this.config.episodicMaxAge);
    this.semantic = new MemoryTier('semantic', this.config.semanticSize, this.config.semanticMaxAge);
    this.working = new MemoryTier('working', this.config.workingSize, this.config.workingMaxAge);
    this.archived = new MemoryTier('archived', this.config.archivedSize, Infinity);
  }

  async store(memory: Omit<Memory, 'id' | 'timestamp' | 'lastAccessed' | 'accessCount'>): Promise<Memory> {
    const fullMemory: Memory = {
      ...memory,
      id: randomUUID(),
      timestamp: Date.now(),
      lastAccessed: Date.now(),
      accessCount: 0,
    };

    fullMemory.summary = this.summarize(fullMemory.content);

    const tier = this.getTier(fullMemory.type);
    tier.store(fullMemory);

    await this.deduplicate(fullMemory);

    this.emit('memory:stored', fullMemory);
    log.info(`Memory stored: ${fullMemory.type} - ${fullMemory.id}`);

    return fullMemory;
  }

  retrieve(id: string, type?: MemoryType): Memory | undefined {
    if (type) {
      const tier = this.getTier(type);
      return tier.retrieve(id);
    }

    for (const tier of [this.working, this.episodic, this.semantic, this.archived]) {
      const memory = tier.retrieve(id);
      if (memory) return memory;
    }

    return undefined;
  }

  query(query: MemoryQuery): Memory[] {
    const results: Memory[] = [];

    const tiers = query.type 
      ? [this.getTier(query.type)]
      : [this.working, this.episodic, this.semantic, this.archived];

    for (const tier of tiers) {
      const matches = tier.query(memory => {
        if (query.projectId && memory.projectId !== query.projectId) return false;
        if (query.tags?.length && !query.tags.some(t => memory.tags.includes(t))) return false;
        if (query.minImportance && memory.importance < query.minImportance) return false;
        if (query.timeRange) {
          if (memory.timestamp < query.timeRange.start || memory.timestamp > query.timeRange.end) {
            return false;
          }
        }
        return true;
      });

      results.push(...matches);
    }

    results.sort((a, b) => {
      const scoreA = this.calculateRelevanceScore(a);
      const scoreB = this.calculateRelevanceScore(b);
      return scoreB - scoreA;
    });

    return query.limit ? results.slice(0, query.limit) : results;
  }

  private calculateRelevanceScore(memory: Memory): number {
    const now = Date.now();
    const age = now - memory.timestamp;
    const recency = Math.max(0, 1 - age / (7 * 24 * 60 * 60 * 1000));
    
    const accessScore = Math.min(1, memory.accessCount / 10);
    
    return (memory.importance * 0.5) + (recency * 0.3) + (accessScore * 0.2);
  }

  private summarize(content: string): string {
    const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 0);
    if (sentences.length <= 2) return content;
    
    return sentences.slice(0, 2).join('. ') + '...';
  }

  private async deduplicate(memory: Memory): Promise<void> {
    const candidates = this.query({
      type: memory.type,
      projectId: memory.projectId,
      limit: 10,
    });

    for (const candidate of candidates) {
      if (this.calculateSimilarity(memory.content, candidate.content) > 0.9) {
        if (candidate.importance >= memory.importance) {
          return;
        } else {
          this.delete(candidate.id, candidate.type);
        }
      }
    }
  }

  private calculateSimilarity(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\s+/));
    const wordsB = new Set(b.toLowerCase().split(/\s+/));
    
    const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
    const union = new Set([...wordsA, ...wordsB]);
    
    return intersection.size / union.size;
  }

  archive(id: string): boolean {
    const memory = this.retrieve(id);
    if (!memory) return false;

    this.delete(id, memory.type);
    
    const archived = { ...memory, type: 'archived' as MemoryType };
    this.archived.store(archived);

    this.emit('memory:archived', archived);
    return true;
  }

  restore(id: string): boolean {
    const memory = this.archived.retrieve(id);
    if (!memory) return false;

    this.archived.clear(id);

    const restored = { ...memory, type: 'episodic' as MemoryType };
    this.episodic.store(restored);

    this.emit('memory:restored', restored);
    return true;
  }

  delete(id: string, type?: MemoryType): boolean {
    if (type) {
      this.getTier(type).retrieve(id);
      return true;
    }

    for (const tier of [this.working, this.episodic, this.semantic, this.archived]) {
      if (tier.retrieve(id)) return true;
    }

    return false;
  }

  clear(type?: MemoryType): void {
    if (type) {
      this.getTier(type).clear();
    } else {
      this.working.clear();
      this.episodic.clear();
      this.semantic.clear();
    }
  }

  getStats(): MemoryStats {
    const working = this.working.getAll();
    const episodic = this.episodic.getAll();
    const semantic = this.semantic.getAll();
    const archived = this.archived.getAll();

    const all = [...working, ...episodic, ...semantic, ...archived];
    const stale = all.filter(m => Date.now() - m.lastAccessed > 7 * 24 * 60 * 60 * 1000);

    return {
      total: all.length,
      byType: {
        working: working.length,
        episodic: episodic.length,
        semantic: semantic.length,
        archived: archived.length,
      },
      totalTokens: all.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0),
      avgImportance: all.length > 0 ? all.reduce((sum, m) => sum + m.importance, 0) / all.length : 0,
      staleMemories: stale.length,
    };
  }

  detectConflicts(): MemoryConflict[] {
    const conflicts: MemoryConflict[] = [];
    const memories = this.query({ type: 'semantic', limit: 100 });

    for (let i = 0; i < memories.length; i++) {
      for (let j = i + 1; j < memories.length; j++) {
        const a = memories[i];
        const b = memories[j];

        if (this.calculateSimilarity(a.content, b.content) > 0.8) {
          if (a.timestamp > b.timestamp) {
            conflicts.push({
              id1: b.id,
              id2: a.id,
              type: 'outdated',
            });
          } else {
            conflicts.push({
              id1: a.id,
              id2: b.id,
              type: 'redundancy',
            });
          }
        }
      }
    }

    return conflicts;
  }

  private getTier(type: MemoryType): MemoryTier {
    switch (type) {
      case 'working': return this.working;
      case 'episodic': return this.episodic;
      case 'semantic': return this.semantic;
      case 'archived': return this.archived;
    }
  }
}

export const enterpriseMemory = new EnterpriseMemory();
export default EnterpriseMemory;