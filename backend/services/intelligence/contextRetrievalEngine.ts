import { EventEmitter } from 'events';
import log from 'electron-log';
import { RepositoryIndexer, IndexedFile } from './repositoryIndexer.js';
import { CodeParser, CodeSymbol } from './codeParser.js';
import { DependencyGraph } from './dependencyGraph.js';
import { EmbeddingService } from './embeddingService.js';
import { VectorStore, VectorSearchResult } from './vectorStore.js';

export interface RetrievalQuery {
  query: string;
  file?: string;
  limit?: number;
  includeSymbols?: boolean;
  includeDependencies?: boolean;
  includeImports?: boolean;
  semanticSearch?: boolean;
}

export interface RetrievalResult {
  file: IndexedFile;
  chunks: ChunkResult[];
  symbols?: SymbolResult[];
  dependencies?: DependencyResult[];
  score: number;
  totalTokens: number;
}

export interface ChunkResult {
  id: string;
  content: string;
  startLine: number;
  endLine: number;
  type: string;
  score: number;
}

export interface SymbolResult {
  name: string;
  type: string;
  line: number;
  visibility: string;
  documentation?: string;
}

export interface DependencyResult {
  path: string;
  type: 'import' | 're-export' | 'inherit';
}

export interface ContextOptions {
  maxTokens?: number;
  maxFiles?: number;
  relevanceThreshold?: number;
  prioritizeSymbols?: boolean;
}

const TOKEN_ESTIMATE = 4;

export class ContextRetrievalEngine extends EventEmitter {
  private indexer: RepositoryIndexer;
  private codeParser: CodeParser;
  private dependencyGraph: DependencyGraph;
  private embeddingService: EmbeddingService | null = null;
  private vectorStore: VectorStore | null = null;
  private maxContextTokens: number;

  constructor(
    indexer: RepositoryIndexer,
    dependencyGraph: DependencyGraph,
    options: { maxTokens?: number } = {}
  ) {
    super();
    this.indexer = indexer;
    this.dependencyGraph = dependencyGraph;
    this.maxContextTokens = options.maxTokens || 100000;
    this.codeParser = new CodeParser();
  }

  setEmbeddingService(service: EmbeddingService): void {
    this.embeddingService = service;
  }

  setVectorStore(store: VectorStore): void {
    this.vectorStore = store;
  }

  async retrieve(query: RetrievalQuery, options: ContextOptions = {}): Promise<RetrievalResult[]> {
    const {
      limit = 10,
      includeSymbols = true,
      includeDependencies = true,
      includeImports = false,
      semanticSearch = true,
    } = query;

    const results: RetrievalResult[] = [];

    try {
      const files = await this.findRelevantFiles(query.query, limit, semanticSearch);

      for (const file of files) {
        const result = await this.buildRetrievalResult(file, query, options);
        
        if (result) {
          results.push(result);
        }
      }

      if (includeDependencies && results.length > 0) {
        await this.addDependencies(results, options);
      }

      results.sort((a, b) => b.score - a.score);

      return results.slice(0, limit);
    } catch (error) {
      log.error('Retrieval error:', error);
      return results;
    }
  }

  async findRelevantFiles(
    query: string,
    limit: number,
    semantic: boolean
  ): Promise<IndexedFile[]> {
    const files = this.indexer.getFiles();

    if (!semantic || !this.vectorStore || !this.embeddingService) {
      return files.slice(0, limit);
    }

    try {
      const queryEmbedding = await this.embeddingService.generate(query);
      const searchResults = await this.vectorStore.search(queryEmbedding, { limit: limit * 3 });

      const fileMap = new Map<string, number>();
      
      for (const result of searchResults) {
        const fileId = result.metadata?.fileId;
        if (fileId) {
          const currentScore = fileMap.get(fileId) || 0;
          fileMap.set(fileId, currentScore + result.score);
        }
      }

      const sortedFiles = Array.from(fileMap.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([fileId]) => {
          for (const file of files) {
            if (file.id === fileId) {
              return file;
            }
          }
        })
        .filter(Boolean) as IndexedFile[];

      return sortedFiles;
    } catch (error) {
      log.warn('Semantic search failed, using fallback:', error);
      return files.slice(0, limit);
    }
  }

  async buildRetrievalResult(
    file: IndexedFile,
    query: RetrievalQuery,
    options: ContextOptions
  ): Promise<RetrievalResult | null> {
    const chunks: ChunkResult[] = [];
    let totalTokens = 0;

    for (const chunk of file.chunks) {
      const relevance = this.calculateRelevance(chunk.content, query.query);
      
      if (relevance > (options.relevanceThreshold || 0.1)) {
        chunks.push({
          id: chunk.id,
          content: chunk.content,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          type: chunk.type,
          score: relevance,
        });

        totalTokens += chunk.content.length / TOKEN_ESTIMATE;

        if (totalTokens > this.maxContextTokens / 2) {
          break;
        }
      }
    }

    if (chunks.length === 0 && file.chunks.length > 0) {
      chunks.push({
        id: file.chunks[0].id,
        content: file.chunks[0].content,
        startLine: file.chunks[0].startLine,
        endLine: file.chunks[0].endLine,
        type: file.chunks[0].type,
        score: 0.1,
      });
      totalTokens = file.chunks[0].content.length / TOKEN_ESTIMATE;
    }

    if (chunks.length === 0) {
      return null;
    }

    const symbols: SymbolResult[] = [];
    for (const symbol of file.symbols.slice(0, 20)) {
      const relevance = this.calculateRelevance(symbol.name, query.query);
      
      if (relevance > 0.3 || query.query.toLowerCase().includes(symbol.name.toLowerCase())) {
        symbols.push({
          name: symbol.name,
          type: symbol.type,
          line: symbol.line,
          visibility: symbol.visibility,
          documentation: symbol.documentation,
        });
      }
    }

    const avgScore = chunks.reduce((sum, c) => sum + c.score, 0) / chunks.length;

    return {
      file,
      chunks,
      symbols: symbols.slice(0, 10),
      score: avgScore,
      totalTokens,
    };
  }

  private calculateRelevance(content: string, query: string): number {
    const contentLower = content.toLowerCase();
    const queryLower = query.toLowerCase();
    
    const queryWords = queryLower.split(/\s+/);
    let matchCount = 0;

    for (const word of queryWords) {
      if (contentLower.includes(word)) {
        matchCount++;
      }
    }

    return matchCount / queryWords.length;
  }

  private async addDependencies(
    results: RetrievalResult[],
    options: ContextOptions
  ): Promise<void> {
    const fileIds = results.map(r => r.file.id);
    const allDeps = new Set<string>();

    for (const fileId of fileIds) {
      for (const dep of this.dependencyGraph.getAllDependencies(fileId)) {
        allDeps.add(dep);
      }
      for (const dep of this.dependencyGraph.getAllDependents(fileId)) {
        allDeps.add(dep);
      }
    }

    allDeps.forEach(depId => {
      const depFile = this.indexer.getFile(depId);
      if (depFile && !results.find(r => r.file.id === depId)) {
        const maxTokens = options.maxTokens || this.maxContextTokens;
        const remainingTokens = maxTokens - results.reduce((sum, r) => sum + r.totalTokens, 0);

        if (remainingTokens > 1000) {
          const depResult: RetrievalResult = {
            file: depFile,
            chunks: [{
              id: depFile.chunks[0]?.id || '',
              content: depFile.chunks[0]?.content || '',
              startLine: depFile.chunks[0]?.startLine || 1,
              endLine: depFile.chunks[0]?.endLine || 1,
              type: depFile.chunks[0]?.type || 'block',
              score: 0.1,
            }],
            score: 0.3,
            totalTokens: (depFile.chunks[0]?.content.length || 0) / TOKEN_ESTIMATE,
          };

          results.push(depResult);
        }
      }
    });
  }

  async getFileContext(
    filePath: string,
    options: ContextOptions = {}
  ): Promise<RetrievalResult | null> {
    const file = this.indexer.getFile(filePath);
    
    if (!file) {
      return null;
    }

    return this.buildRetrievalResult(
      file,
      { query: file.symbols.map(s => s.name).join(' ') },
      options
    );
  }

  async findSymbol(symbolName: string): Promise<SymbolResult[]> {
    const files = this.indexer.getFiles();
    const results: SymbolResult[] = [];

    for (const file of files) {
      for (const symbol of file.symbols) {
        if (symbol.name === symbolName) {
          results.push({
            name: symbol.name,
            type: symbol.type,
            line: symbol.line,
            visibility: symbol.visibility,
            documentation: symbol.documentation,
          });
        }
      }
    }

    return results;
  }

  getProjectStructure(): {
    root: string;
    files: number;
    stats: any;
  } {
    return {
      root: this.indexer.getFileCount() > 0 ? 'known' : 'unknown',
      files: this.indexer.getFileCount(),
      stats: this.dependencyGraph.getGraphStats(),
    };
  }
}

export default ContextRetrievalEngine;