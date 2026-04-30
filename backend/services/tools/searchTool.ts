import { promises as fs } from 'fs';
import { join, relative, dirname } from 'path';
import { cwd } from 'process';
import log from 'electron-log';

export interface SearchOptions {
  pattern: string;
  path?: string;
  ignore?: string[];
  extensions?: string[];
  caseSensitive?: boolean;
  regex?: boolean;
  wholeWord?: boolean;
  maxResults?: number;
  maxLineLength?: number;
}

export interface SearchResult {
  file: string;
  line: number;
  content: string;
  match: string;
}

export interface SearchResults {
  success: boolean;
  results: SearchResult[];
  filesMatched: number;
  matchesFound: number;
  error?: string;
}

export interface GrepOptions {
  pattern: string;
  path?: string;
  ignore?: string[];
  extensions?: string[];
  context?: number;
  maxResults?: number;
  outputFormat?: 'text' | 'json' | 'count';
}

export interface GrepResults {
  success: boolean;
  output: string;
  matches: number;
  error?: string;
}

const DEFAULT_IGNORE = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '__pycache__',
  '.DS_Store',
  '*.log',
  '.env',
  'vendor',
  'coverage',
  '.cache',
];

const DEFAULT_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php', '.swift',
  '.kt', '.scala', '.sql', '.sh', '.bash', '.zsh', '.json',
  '.yaml', '.yml', '.toml', '.xml', '.md', '.txt',
];

export class SearchTool {
  private workspaceRoot: string;
  private defaultIgnore: string[];
  private defaultExtensions: string[];

  constructor(workspaceRoot?: string) {
    this.workspaceRoot = workspaceRoot || cwd();
    this.defaultIgnore = DEFAULT_IGNORE;
    this.defaultExtensions = DEFAULT_EXTENSIONS;
  }

  setWorkspaceRoot(path: string): void {
    this.workspaceRoot = path;
  }

  async search(options: SearchOptions): Promise<SearchResults> {
    const {
      pattern,
      path = this.workspaceRoot,
      ignore = this.defaultIgnore,
      extensions,
      caseSensitive = false,
      regex = false,
      wholeWord = false,
      maxResults = 1000,
      maxLineLength = 500,
    } = options;

    let compiledPattern: RegExp;
    
    try {
      let patternStr = pattern;
      
      if (!regex) {
        patternStr = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
      
      if (wholeWord) {
        patternStr = `\\b${patternStr}\\b`;
      }

      compiledPattern = new RegExp(patternStr, caseSensitive ? 'g' : 'gi');
    } catch (error) {
      return { success: false, results: [], filesMatched: 0, matchesFound: 0, error: String(error) };
    }

    const results: SearchResult[] = [];
    const processedFiles = new Set<string>();
    let matchesFound = 0;

    const scan = async (dirPath: string, depth = 0) => {
      if (depth > 10 || results.length >= maxResults) return;

      try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
          if (results.length >= maxResults) break;

          const fullPath = join(dirPath, entry.name);
          const relativePath = relative(this.workspaceRoot, fullPath);

          if (entry.name.startsWith('.')) continue;
          if (ignore.some(i => 
            relativePath.startsWith(i) || 
            relativePath.includes(`/${i}/`) ||
            relativePath.includes(`\\${i}\\`)
          )) continue;

          if (entry.isDirectory()) {
            await scan(fullPath, depth + 1);
          } else if (entry.isFile()) {
            const ext = entry.name.substring(entry.name.lastIndexOf('.'));
            
            if (extensions && !extensions.includes(ext) && !extensions.some(e => entry.name.endsWith(e))) {
              continue;
            }
            if (!extensions && !this.defaultExtensions.includes(ext) && !this.defaultExtensions.some(e => entry.name.endsWith(e))) {
              continue;
            }

            if (processedFiles.has(fullPath)) continue;
            processedFiles.add(fullPath);

            try {
              const content = await fs.readFile(fullPath, 'utf-8');
              const lines = content.split('\n');

              compiledPattern.lastIndex = 0;
              let hasMatch = false;

              for (let i = 0; i < lines.length; i++) {
                if (results.length >= maxResults) break;

                compiledPattern.lastIndex = 0;
                if (compiledPattern.test(lines[i])) {
                  hasMatch = true;
                  matchesFound++;

                  const matchContent = lines[i].trim();
                  const truncatedContent = matchContent.length > maxLineLength 
                    ? matchContent.substring(0, maxLineLength) + '...'
                    : matchContent;

                  results.push({
                    file: relativePath,
                    line: i + 1,
                    content: truncatedContent,
                    match: matchContent,
                  });
                }
              }

              compiledPattern.lastIndex = 0;
            } catch (error) {
              log.warn(`Cannot search file: ${fullPath}`, error);
            }
          }
        }
      } catch (error) {
        log.warn(`Cannot scan directory: ${dirPath}`, error);
      }
    };

    await scan(path);

    const filesMatched = new Set(results.map(r => r.file)).size;

    return {
      success: true,
      results,
      filesMatched,
      matchesFound,
    };
  }

  async searchMultiple(patterns: string[], options?: Omit<SearchOptions, 'pattern'>): Promise<Map<string, SearchResults>> {
    const results = new Map<string, SearchResults>();

    for (const pattern of patterns) {
      const searchResults = await this.search({ ...options, pattern });
      results.set(pattern, searchResults);
    }

    return results;
  }

  async grep(options: GrepOptions): Promise<GrepResults> {
    const {
      pattern,
      path = this.workspaceRoot,
      ignore = this.defaultIgnore,
      extensions,
      context = 2,
      maxResults = 100,
      outputFormat = 'text',
    } = options;

    const results = await this.search({
      pattern,
      path,
      ignore,
      extensions,
      maxResults: maxResults * 3,
    });

    if (!results.success) {
      return { success: false, output: '', matches: 0, error: results.error };
    }

    if (outputFormat === 'count') {
      return {
        success: true,
        output: String(results.matchesFound),
        matches: results.matchesFound,
      };
    }

    if (outputFormat === 'json') {
      return {
        success: true,
        output: JSON.stringify(results.results, null, 2),
        matches: results.matchesFound,
      };
    }

    let output = '';
    let lastFile = '';

    for (const result of results.results) {
      if (result.file !== lastFile) {
        output += `\n${result.file}\n`;
        lastFile = result.file;
      }
      
      output += `  ${result.line}: ${result.content}\n`;
    }

    return {
      success: true,
      output,
      matches: results.matchesFound,
    };
  }

  async findFiles(options: {
    name?: string;
    path?: string;
    ignore?: string[];
    extensions?: string[];
    maxResults?: number;
  }): Promise<{ success: boolean; files?: string[]; error?: string }> {
    const {
      name,
      path = this.workspaceRoot,
      ignore = this.defaultIgnore,
      extensions,
      maxResults = 100,
    } = options;

    const files: string[] = [];
    const nameLower = name?.toLowerCase();

    const scan = async (dirPath: string, depth = 0) => {
      if (depth > 10 || files.length >= maxResults) return;

      try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
          if (files.length >= maxResults) break;

          const fullPath = join(dirPath, entry.name);
          const relativePath = relative(this.workspaceRoot, fullPath);

          if (entry.name.startsWith('.')) continue;
          if (ignore.some(i => relativePath.includes(`/${i}/`) || relativePath.includes(`\\${i}\\`))) continue;

          if (entry.isDirectory()) {
            await scan(fullPath, depth + 1);
          } else if (entry.isFile()) {
            let matches = true;

            if (nameLower && !entry.name.toLowerCase().includes(nameLower)) {
              matches = false;
            }

            if (matches && extensions) {
              matches = extensions.some(e => entry.name.endsWith(e));
            }

            if (matches) {
              files.push(relativePath);
            }
          }
        }
      } catch (error) {
        log.warn(`Cannot scan: ${dirPath}`, error);
      }
    };

    await scan(path);

    return { success: true, files };
  }

  async findInFile(filePath: string, pattern: string, options?: {
    caseSensitive?: boolean;
    regex?: boolean;
  }): Promise<{ success: boolean; results?: { line: number; content: string }[]; error?: string }> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');

      let regex: RegExp;
      
      try {
        const patternStr = options?.regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        regex = new RegExp(patternStr, options?.caseSensitive ? 'g' : 'gi');
      } catch (error) {
        return { success: false, error: String(error) };
      }

      const results: { line: number; content: string }[] = [];

      for (let i = 0; i < lines.length; i++) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          results.push({
            line: i + 1,
            content: lines[i].trim(),
          });
        }
      }

      return { success: true, results };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  async findDirectories(options: {
    name?: string;
    path?: string;
    ignore?: string[];
  }): Promise<{ success: boolean; directories?: string[]; error?: string }> {
    const { name, path = this.workspaceRoot, ignore = this.defaultIgnore } = options;
    const directories: string[] = [];

    const scan = async (dirPath: string, depth = 0) => {
      if (depth > 10) return;

      try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          if (entry.name.startsWith('.')) continue;

          const fullPath = join(dirPath, entry.name);
          const relativePath = relative(this.workspaceRoot, fullPath);

          if (ignore.some(i => relativePath.includes(`/${i}/`))) continue;

          if (!name || entry.name.toLowerCase().includes(name.toLowerCase())) {
            directories.push(relativePath);
          }

          await scan(fullPath, depth + 1);
        }
      } catch (error) {
      log.warn(`Cannot scan: ${dirPath}`, error);
      }
    };

    await scan(path);

    return { success: true, directories };
  }
}

export default SearchTool;