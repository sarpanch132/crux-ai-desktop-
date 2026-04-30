import { promises as fs } from 'fs';
import { join, relative, extname } from 'path';
import { EventEmitter } from 'events';
import log from 'electron-log';
import { CodeParser } from './codeParser.js';
import { DependencyGraph } from './dependencyGraph.js';
import { EmbeddingService } from './embeddingService.js';
import { VectorStore } from './vectorStore.js';

export interface RepositoryIndex {
  id: string;
  rootPath: string;
  fileCount: number;
  indexedAt: number;
  lastUpdated: number;
  languageStats: Record<string, number>;
}

export interface IndexedFile {
  id: string;
  path: string;
  relativePath: string;
  language: string;
  size: number;
  hash: string;
  chunks: FileChunk[];
  symbols: CodeSymbol[];
  imports: ImportInfo[];
  exports: ExportInfo[];
  dependencies: string[];
  lastModified: number;
}

export interface FileChunk {
  id: string;
  content: string;
  startLine: number;
  endLine: number;
  type: 'function' | 'class' | 'method' | 'block' | 'import' | 'export' | 'comment';
  symbolId?: string;
  embedding?: number[];
}

export interface CodeSymbol {
  id: string;
  name: string;
  type: 'function' | 'class' | 'method' | 'variable' | 'constant' | 'interface' | 'type' | 'enum';
  visibility: 'public' | 'private' | 'protected';
  line: number;
  endLine: number;
  fileId: string;
  signature?: string;
  params?: string[];
  returnType?: string;
  documentation?: string;
}

export interface ImportInfo {
  path: string;
  local: string;
  isDefault: boolean;
  isNamespace: boolean;
  line: number;
}

export interface ExportInfo {
  name: string;
  isDefault: boolean;
  line: number;
}

const IGNORE_PATTERNS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '__pycache__',
  '.DS_Store',
  '*.log',
  'vendor',
  '.cache',
  'coverage',
];

const LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.scala': 'scala',
  '.sql': 'sql',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.md': 'markdown',
  '.txt': 'text',
};

export interface IndexOptions {
  rootPath: string;
  ignore?: string[];
  maxFileSize?: number;
  chunkSize?: number;
  generateEmbeddings?: boolean;
  parseSymbols?: boolean;
  parseImports?: boolean;
  languages?: string[];
}

export class RepositoryIndexer extends EventEmitter {
  private rootPath: string;
  private codeParser: CodeParser;
  private dependencyGraph: DependencyGraph;
  private embeddingService: EmbeddingService | null = null;
  private vectorStore: VectorStore | null = null;
  private indexedFiles: Map<string, IndexedFile> = new Map();
  private isIndexing: boolean = false;
  private shouldStop: boolean = false;

  constructor(rootPath: string) {
    super();
    this.rootPath = rootPath;
    this.codeParser = new CodeParser();
    this.dependencyGraph = new DependencyGraph(rootPath);
  }

  setEmbeddingService(service: EmbeddingService): void {
    this.embeddingService = service;
  }

  setVectorStore(store: VectorStore): void {
    this.vectorStore = store;
  }

  async index(options: IndexOptions): Promise<RepositoryIndex> {
    if (this.isIndexing) {
      throw new Error('Already indexing');
    }

    this.isIndexing = true;
    this.shouldStop = false;
    
    const startTime = Date.now();
    const files: IndexedFile[] = [];

    log.info(`Starting indexing: ${options.rootPath}`);

    try {
      const fileList = await this.scanFiles(options.rootPath, options.ignore || IGNORE_PATTERNS);
      
      this.emit('indexing:started', { totalFiles: fileList.length });

      for (let i = 0; i < fileList.length; i++) {
        if (this.shouldStop) {
          log.info('Indexing stopped');
          break;
        }

        const filePath = fileList[i];
        
        this.emit('indexing:progress', { current: i + 1, total: fileList.length, file: filePath });

        try {
          const indexedFile = await this.indexFile(filePath, options, relative(options.rootPath, filePath));
          
          if (indexedFile) {
            files.push(indexedFile);
            this.indexedFiles.set(filePath, indexedFile);
            
            this.dependencyGraph.addFile(indexedFile);
          }
        } catch (error) {
          log.warn(`Failed to index: ${filePath}`, error);
        }
      }

      this.dependencyGraph.build();

      if (this.vectorStore && this.embeddingService) {
        await this.indexEmbeddings(files);
      }

      const languageStats: Record<string, number> = {};
      for (const file of files) {
        languageStats[file.language] = (languageStats[file.language] || 0) + 1;
      }

      const index: RepositoryIndex = {
        id: `repo_${Date.now()}`,
        rootPath: options.rootPath,
        fileCount: files.length,
        indexedAt: startTime,
        lastUpdated: Date.now(),
        languageStats,
      };

      this.emit('indexing:complete', { index, duration: Date.now() - startTime });
      
      log.info(`Indexed ${files.length} files in ${Date.now() - startTime}ms`);
      
      return index;
    } finally {
      this.isIndexing = false;
    }
  }

  stop(): void {
    this.shouldStop = true;
  }

  private async scanFiles(dirPath: string, ignore: string[]): Promise<string[]> {
    const files: string[] = [];

    const scan = async (path: string, depth = 0) => {
      if (depth > 10) return;

      try {
        const entries = await fs.readdir(path, { withFileTypes: true });

        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          if (ignore.includes(entry.name)) continue;

          const fullPath = join(path, entry.name);

          if (entry.isDirectory() && !IGNORE_PATTERNS.includes(entry.name)) {
            await scan(fullPath, depth + 1);
          } else if (entry.isFile()) {
            const ext = extname(entry.name).toLowerCase();
            if (LANGUAGE_MAP[ext]) {
              files.push(fullPath);
            }
          }
        }
      } catch (error) {
        log.warn(`Cannot scan: ${path}`, error);
      }
    };

    await scan(dirPath);
    return files;
  }

  private async indexFile(
    filePath: string,
    options: IndexOptions,
    relativePath: string
  ): Promise<IndexedFile | null> {
    const ext = extname(filePath).toLowerCase();
    const language = LANGUAGE_MAP[ext] || 'text';

    if (options.languages && !options.languages.includes(language)) {
      return null;
    }

    const stats = await fs.stat(filePath);
    
    if (options.maxFileSize && stats.size > options.maxFileSize) {
      log.warn(`File too large: ${filePath}`);
      return null;
    }

    const content = await fs.readFile(filePath, 'utf-8');
    const hash = this.simpleHash(content);

    const indexedFile: IndexedFile = {
      id: `file_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      path: filePath,
      relativePath,
      language,
      size: stats.size,
      hash,
      chunks: [],
      symbols: [],
      imports: [],
      exports: [],
      dependencies: [],
      lastModified: stats.mtimeMs,
    };

    if (options.parseSymbols || options.parseImports || options.generateEmbeddings) {
      const parsed = await this.codeParser.parse(content, language);

      if (options.parseSymbols && parsed.symbols) {
        indexedFile.symbols = parsed.symbols.map(s => ({
          ...s,
          fileId: indexedFile.id,
        }));
      }

      if (options.parseImports && parsed.imports) {
        indexedFile.imports = parsed.imports;
        indexedFile.dependencies = parsed.imports.map(i => i.path);
      }

      if (parsed.exports) {
        indexedFile.exports = parsed.exports;
      }
    }

    if (options.chunkSize && content) {
      indexedFile.chunks = this.chunkContent(
        content,
        indexedFile.id,
        options.chunkSize,
        indexedFile.symbols
      );
    }

    return indexedFile;
  }

  private chunkContent(
    content: string,
    fileId: string,
    chunkSize: number,
    symbols: CodeSymbol[]
  ): FileChunk[] {
    const lines = content.split('\n');
    const chunks: FileChunk[] = [];
    
    const symbolMap = new Map<number, CodeSymbol>();
    for (const symbol of symbols) {
      symbolMap.set(symbol.line, symbol);
    }

    let currentChunkLines: string[] = [];
    let startLine = 1;

    for (let i = 0; i < lines.length; i++) {
      currentChunkLines.push(lines[i]);

      if (currentChunkLines.join('\n').length >= chunkSize || i === lines.length - 1) {
        const symbol = symbolMap.get(startLine);

        chunks.push({
          id: `chunk_${fileId}_${chunks.length}`,
          content: currentChunkLines.join('\n').trim(),
          startLine,
          endLine: i + 1,
          type: symbol?.type || 'block',
          symbolId: symbol?.id,
        });

        currentChunkLines = [];
        startLine = i + 2;
      }
    }

    return chunks;
  }

  private async indexEmbeddings(files: IndexedFile[]): Promise<void> {
    if (!this.vectorStore || !this.embeddingService) return;

    log.info(`Generating embeddings for ${files.length} files`);

    for (const file of files) {
      for (const chunk of file.chunks) {
        const embedding = await this.embeddingService.generate(chunk.content);
        
        await this.vectorStore.add({
          id: chunk.id,
          content: chunk.content,
          metadata: {
            fileId: file.id,
            filePath: file.relativePath,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            type: chunk.type,
          },
          embedding,
        });
      }
    }

    log.info('Embeddings indexed');
  }

  private simpleHash(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
  }

  getFile(filePath: string): IndexedFile | undefined {
    return this.indexedFiles.get(filePath);
  }

  getFiles(): IndexedFile[] {
    return Array.from(this.indexedFiles.values());
  }

  getFileCount(): number {
    return this.indexedFiles.size;
  }

  isIndexing(): boolean {
    return this.isIndexing;
  }
}

export default RepositoryIndexer;