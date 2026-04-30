import { EventEmitter } from 'events';
import log from 'electron-log';

export interface VectorEntry {
  id: string;
  content: string;
  metadata?: Record<string, any>;
  embedding: number[];
}

export interface VectorSearchResult {
  id: string;
  content: string;
  metadata: Record<string, any>;
  score: number;
}

export interface SearchOptions {
  limit?: number;
  minScore?: number;
  filter?: (entry: VectorEntry) => boolean;
}

export class VectorStore extends EventEmitter {
  private entries: Map<string, VectorEntry> = new Map();
  private embeddings: number[][] = [];
  private idToIndex: Map<string, number> = new Map();
  private dimensions: number;
  private maxEntries: number;

  constructor(dimensions = 1536, maxEntries = 100000) {
    super();
    this.dimensions = dimensions;
    this.maxEntries = maxEntries;
  }

  async add(entry: VectorEntry): Promise<void> {
    if (this.entries.size >= this.maxEntries) {
      await this.evict();
    }

    const index = this.embeddings.length;
    
    this.entries.set(entry.id, entry);
    this.idToIndex.set(entry.id, index);
    this.embeddings.push(entry.embedding);
  }

  async addBatch(entries: VectorEntry[]): Promise<void> {
    for (const entry of entries) {
      await this.add(entry);
    }
  }

  async search(queryEmbedding: number[], options: SearchOptions = {}): Promise<VectorSearchResult[]> {
    const { limit = 10, minScore = 0.3, filter } = options;

    if (this.entries.size === 0) {
      return [];
    }

    const scores: { id: string; score: number }[] = [];

    for (const [id, embedding] of this.embeddings) {
      const entry = this.entries.get(id);
      
      if (filter && entry && !filter(entry)) {
        continue;
      }

      const score = this.cosineSimilarity(queryEmbedding, embedding);
      
      if (score >= minScore) {
        scores.push({ id, score });
      }
    }

    scores.sort((a, b) => b.score - a.score);

    const results: VectorSearchResult[] = [];
    
    for (let i = 0; i < Math.min(limit, scores.length); i++) {
      const { id, score } = scores[i];
      const entry = this.entries.get(id);
      
      if (entry) {
        results.push({
          id: entry.id,
          content: entry.content,
          metadata: entry.metadata || {},
          score,
        });
      }
    }

    return results;
  }

  async searchByText(text: string, _embeddingService: any, options: SearchOptions = {}): Promise<VectorSearchResult[]> {
    try {
      const { limit = 10, minScore = 0.3, filter } = options;

      const queryEmbedding = new Array(this.dimensions).fill(0);
      const words = text.toLowerCase().split(/\s+/);
      const wordFreq = new Map<string, number>();

      for (const word of words) {
        wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
      }

      for (const [id, embedding] of this.embeddings.entries()) {
        const entry = this.entries.get(id);
        
        if (filter && entry && !filter(entry)) {
          continue;
        }

        let matchScore = 0;
        
        for (const entryId of this.idToIndex.keys()) {
          const entry = this.entries.get(entryId);
          if (entry) {
            const contentWords = entry.content.toLowerCase().split(/\s+/);
            for (const word of words) {
              if (contentWords.includes(word)) {
                matchScore += (wordFreq.get(word) || 0);
              }
            }
          }
        }

        matchScore /= words.length * Math.log(this.entries.size + 1);

        if (matchScore >= minScore) {
          const score = Math.min(1, matchScore);
          const vectorResult = await this.search(embedding, { limit: 1, minScore: score });
          
          results.push(...vectorResult);
        }
      }

      return results
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    } catch (error) {
      log.warn('Text search failed:', error);
      return [];
    }
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    
    return magnitude > 0 ? dotProduct / magnitude : 0;
  }

  get(id: string): VectorEntry | undefined {
    return this.entries.get(id);
  }

  getAll(): VectorEntry[] {
    return Array.from(this.entries.values());
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  async remove(id: string): Promise<boolean> {
    const entry = this.entries.get(id);
    
    if (!entry) {
      return false;
    }

    this.entries.delete(id);
    this.embeddings = this.embeddings.filter((_, i) => {
      const entryId = Array.from(this.entries.keys())[i];
      return entryId !== id;
    });

    this.rebuildIndex();
    return true;
  }

  clear(): void {
    this.entries.clear();
    this.embeddings = [];
    this.idToIndex.clear();
  }

  private async evict(): Promise<void> {
    const toRemove = Math.floor(this.maxEntries * 0.1);
    const ids = Array.from(this.entries.keys()).slice(0, toRemove);
    
    for (const id of ids) {
      await this.remove(id);
    }
  }

  private rebuildIndex(): void {
    this.idToIndex.clear();
    
    let index = 0;
    for (const id of this.entries.keys()) {
      this.idToIndex.set(id, index++);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  getStats(): { size: number; dimensions: number; maxEntries: number } {
    return {
      size: this.entries.size,
      dimensions: this.dimensions,
      maxEntries: this.maxEntries,
    };
  }
}

export default VectorStore;