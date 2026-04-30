import log from 'electron-log';
import { ChromaClient, Collection } from 'chromadb';

export interface VectorStoreConfig {
  persistDirectory?: string;
  collectionName: string;
  dimension: number;
}

export interface Document {
  id: string;
  content: string;
  metadata?: Record<string, any>;
  embedding?: number[];
}

export interface SearchResult {
  id: string;
  content: string;
  metadata: Record<string, any>;
  score: number;
}

export interface EmbeddedDocument extends Document {
  embedding: number[];
}

export class VectorStore {
  private client: ChromaClient | null = null;
  private collection: Collection | null = null;
  private config: VectorStoreConfig;
  private isInitialized: boolean = false;
  private documents: Map<string, Document> = new Map();

  constructor(config: Partial<VectorStoreConfig> = {}) {
    this.config = {
      persistDirectory: config.persistDirectory ?? './data/vectorstore',
      collectionName: config.collectionName ?? 'opencode-memory',
      dimension: config.dimension ?? 1536,
    };
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      this.client = new ChromaClient({
        path: 'http://localhost:8000',
      });

      try {
        this.collection = await this.client.getOrCreateCollection({
          name: this.config.collectionName,
        });
      } catch {
        this.collection = await this.client.createCollection({
          name: this.config.collectionName,
        });
      }

      this.isInitialized = true;
      log.info('Vector store initialized');
    } catch (error) {
      log.warn('Vector store initialization failed, using in-memory fallback:', error);
      this.isInitialized = true;
    }
  }

  async addDocuments(documents: Document[]): Promise<void> {
    await this.initialize();

    if (!this.collection) {
      for (const doc of documents) {
        this.documents.set(doc.id, doc);
      }
      return;
    }

    const ids: string[] = [];
    const embeddings: number[][] = [];
    const documents_: string[] = [];
    const metadatas: Record<string, any>[] = [];

    for (const doc of documents) {
      ids.push(doc.id);
      documents_.push(doc.content);
      metadatas.push(doc.metadata ?? {});
    }

    await this.collection.add({
      ids,
      embeddings: embeddings as any,
      documents: documents_,
      metadatas,
    });

    for (const doc of documents) {
      this.documents.set(doc.id, doc);
    }

    log.info(`Added ${documents.length} documents to vector store`);
  }

  async search(query: string, options: { limit?: number; filter?: Record<string, any> } = {}): Promise<SearchResult[]> {
    await this.initialize();

    const { limit = 5, filter } = options;

    if (!this.collection) {
      return this.searchInMemory(query, limit);
    }

    try {
      const results = await this.collection.query({
        queryTexts: [query],
        nResults: limit,
        where: filter,
      });

      const searchResults: SearchResult[] = [];
      
      if (results.ids[0] && results.documents[0]) {
        for (let i = 0; i < results.ids[0].length; i++) {
          searchResults.push({
            id: results.ids[0][i],
            content: results.documents[0][i],
            metadata: results.metadatas?.[0]?.[i] ?? {},
            score: results.distances?.[0]?.[i] ?? 1,
          });
        }
      }

      return searchResults;
    } catch (error) {
      log.warn('Vector search failed, using in-memory:', error);
      return this.searchInMemory(query, limit);
    }
  }

  private searchInMemory(query: string, limit: number): SearchResult[] {
    const queryLower = query.toLowerCase();
    const results: SearchResult[] = [];

    for (const [id, doc] of this.documents) {
      const contentLower = doc.content.toLowerCase();
      const score = this.calculateSimilarity(queryLower, contentLower);
      
      results.push({
        id,
        content: doc.content,
        metadata: doc.metadata ?? {},
        score,
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  private calculateSimilarity(query: string, content: string): number {
    const queryTerms = query.toLowerCase().split(/\s+/);
    const contentTerms = content.toLowerCase().split(/\s+/);
    
    let matches = 0;
    for (const term of queryTerms) {
      if (contentTerms.includes(term)) {
        matches++;
      }
    }
    
    return matches / queryTerms.length;
  }

  async deleteDocument(id: string): Promise<void> {
    if (this.collection) {
      await this.collection.delete({ ids: [id] });
    }
    this.documents.delete(id);
    log.info(`Deleted document: ${id}`);
  }

  async getDocument(id: string): Promise<Document | null> {
    return this.documents.get(id) ?? null;
  }

  async updateDocument(id: string, content: string, metadata?: Record<string, any>): Promise<void> {
    const doc = this.documents.get(id);
    if (!doc) throw new Error(`Document not found: ${id}`);

    doc.content = content;
    if (metadata) {
      doc.metadata = { ...doc.metadata, ...metadata };
    }

    if (this.collection) {
      await this.collection.upsert({
        ids: [id],
        documents: [content],
        metadatas: [doc.metadata],
      });
    }

    log.info(`Updated document: ${id}`);
  }

  async getAllDocuments(): Promise<Document[]> {
    return Array.from(this.documents.values());
  }

  async clear(): Promise<void> {
    if (this.collection) {
      try {
        await this.collection.delete({ where: {} });
      } catch {}
    }
    this.documents.clear();
    log.info('Vector store cleared');
  }

  async getCollectionStats(): Promise<{ count: number; isInitialized: boolean }> {
    return {
      count: this.documents.size,
      isInitialized: this.isInitialized,
    };
  }

  getStatus(): { initialized: boolean; documentCount: number } {
    return {
      initialized: this.isInitialized,
      documentCount: this.documents.size,
    };
  }
}

export const createVectorStore = (config?: Partial<VectorStoreConfig>): VectorStore => {
  return new VectorStore(config);
};

export default VectorStore;