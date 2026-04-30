import axios from 'axios';
import log from 'electron-log';

export interface EmbeddingOptions {
  provider?: 'openai' | 'openrouter' | 'custom';
  model?: string;
  apiKey?: string;
  endpoint?: string;
  dimensions?: number;
  batchSize?: number;
}

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  tokens?: number;
}

export class EmbeddingService {
  private provider: string;
  private model: string;
  private apiKey: string;
  private endpoint: string;
  private dimensions: number;
  private batchSize: number;
  private cache: Map<string, number[]> = new Map();

  constructor(options: EmbeddingOptions = {}) {
    this.provider = options.provider || 'openrouter';
    this.model = options.model || 'text-embedding-3-small';
    this.apiKey = options.apiKey || process.env.AI_API_KEY || '';
    this.endpoint = options.endpoint || this.getDefaultEndpoint();
    this.dimensions = options.dimensions || 1536;
    this.batchSize = options.batchSize || 32;
  }

  private getDefaultEndpoint(): string {
    switch (this.provider) {
      case 'openrouter':
        return 'https://openrouter.ai/api/v1/embeddings';
      case 'openai':
        return 'https://api.openai.com/v1/embeddings';
      default:
        return 'https://openrouter.ai/api/v1/embeddings';
    }
  }

  async generate(text: string): Promise<number[]> {
    const cacheKey = this.simpleHash(text);
    
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    if (!this.apiKey) {
      return this.generateLocal(text);
    }

    try {
      const response = await axios.post(
        this.endpoint,
        {
          model: this.model,
          input: text,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
        }
      );

      const embedding = response.data.data[0]?.embedding;
      
      if (embedding) {
        this.cache.set(cacheKey, embedding);
        return embedding;
      }

      return this.generateLocal(text);
    } catch (error) {
      log.warn('Embedding generation failed, using local:', error);
      return this.generateLocal(text);
    }
  }

  async generateBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    const batches: string[][] = [];

    for (let i = 0; i < texts.length; i += this.batchSize) {
      batches.push(texts.slice(i, i + this.batchSize));
    }

    for (const batch of batches) {
      const embeddings = await Promise.all(
        batch.map(async (text) => {
          try {
            return await this.generate(text);
          } catch {
            return this.generateLocal(text);
          }
        })
      );
      results.push(...embeddings);
    }

    return results;
  }

  private generateLocal(text: string): number[] {
    const words = text.toLowerCase().split(/\s+/);
    const wordFreq = new Map<string, number>();
    
    for (const word of words) {
      wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
    }

    const embedding = new Array(this.dimensions).fill(0);
    let index = 0;

    for (const [word, freq] of wordFreq) {
      const wordHash = this.hashString(word);
      
      for (let i = 0; i < Math.min(freq, 10); i++) {
        const dimIndex = (wordHash + i) % this.dimensions;
        embedding[dimIndex] += (Math.random() - 0.5) * 2;
      }
      index++;
    }

    const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
    
    if (magnitude > 0) {
      for (let i = 0; i < embedding.length; i++) {
        embedding[i] /= magnitude;
      }
    }

    return embedding;
  }

  private simpleHash(text: string): string {
    let hash = 0;
    for (let i = 0; i < Math.min(text.length, 100); i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(36);
  }

  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash);
  }

  clearCache(): void {
    this.cache.clear();
  }

  getCacheSize(): number {
    return this.cache.size;
  }
}

export default EmbeddingService;