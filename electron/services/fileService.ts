import { readFile, writeFile, unlink, readdir, mkdir, stat, access } from 'fs/promises';
import path from 'path';
import log from 'electron-log';

interface FileInfo {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modified: number;
}

interface SearchResult {
  file: string;
  line: number;
  content: string;
}

export class FileService {
  private ignorePatterns = ['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.DS_Store'];

  async readFile(filePath: string): Promise<string> {
    log.debug(`Reading file: ${filePath}`);
    const content = await readFile(filePath, 'utf-8');
    return content;
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    log.debug(`Writing file: ${filePath}`);
    await writeFile(filePath, content, 'utf-8');
  }

  async deleteFile(filePath: string): Promise<void> {
    log.debug(`Deleting file: ${filePath}`);
    await unlink(filePath);
  }

  async listFiles(dirPath: string, options?: { recursive?: boolean; filter?: string[] }): Promise<FileInfo[]> {
    const files: FileInfo[] = [];
    const ignore = options?.filter || this.ignorePatterns;

    const scan = async (currentPath: string, depth = 0) => {
      if (options?.recursive === false && depth > 0) return;

      const entries = await readdir(currentPath);
      
      for (const entry of entries) {
        if (ignore.includes(entry)) continue;

        const fullPath = path.join(currentPath, entry);
        const stats = await stat(fullPath);

        files.push({
          name: entry,
          path: fullPath,
          type: stats.isDirectory() ? 'directory' : 'file',
          size: stats.size,
          modified: stats.mtimeMs,
        });

        if (stats.isDirectory()) {
          await scan(fullPath, depth + 1);
        }
      }
    };

    await scan(dirPath);
    return files;
  }

  async searchFiles(pattern: string, options?: { cwd?: string; ignore?: string[] }): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const searchDir = options?.cwd || process.cwd();
    const ignore = options?.ignore || this.ignorePatterns;

    const regex = new RegExp(pattern, 'gi');

    const search = async (currentPath: string) => {
      const entries = await readdir(currentPath);

      for (const entry of entries) {
        if (ignore.includes(entry) || entry.startsWith('.')) continue;

        const fullPath = path.join(currentPath, entry);
        const stats = await stat(fullPath);

        if (stats.isDirectory()) {
          await search(fullPath);
        } else if (stats.isFile() && /\.(ts|tsx|js|jsx|py|rs|go|java|c|cpp|h)$/i.test(entry)) {
          try {
            const content = await readFile(fullPath, 'utf-8');
            const lines = content.split('\n');

            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                results.push({
                  file: fullPath,
                  line: i + 1,
                  content: lines[i].trim(),
                });
              }
            }

            regex.lastIndex = 0;
          } catch (error) {
            log.warn(`Could not search file ${fullPath}:`, error);
          }
        }
      }
    };

    await search(searchDir);
    return results.slice(0, 100);
  }

  async createDirectory(dirPath: string): Promise<void> {
    log.debug(`Creating directory: ${dirPath}`);
    await mkdir(dirPath, { recursive: true });
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}