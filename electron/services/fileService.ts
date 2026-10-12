import { readFile, writeFile, unlink, readdir, mkdir, lstat, access } from 'fs/promises';
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
  private ignorePatterns = ['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.DS_Store', 'release', 'coverage', '.venv', 'venv', 'target', '.cache'];

  async readFile(filePath: string): Promise<string> {
    log.debug(`Reading file: ${filePath}`);
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Only regular files can be read.');
    if (info.size > 2 * 1024 * 1024) throw new Error('File exceeds the 2 MiB context limit.');
    const bytes = await readFile(filePath);
    if (bytes.includes(0)) throw new Error('Binary files cannot enter code context.');
    const content = bytes.toString('utf8');
    if (!Buffer.from(content).equals(bytes)) throw new Error('File is not valid UTF-8 text.');
    return content;
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error('File exceeds the 2 MiB edit limit.');
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
        const stats = await lstat(fullPath);
        if (stats.isSymbolicLink()) continue;
        if (files.length >= 5000 || depth >= 30) continue;

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

    if (pattern.length > 1000) throw new Error('Search pattern is too long.');
    const regex = new RegExp(pattern, 'gi');

    let visited = 0;
    const search = async (currentPath: string, depth = 0) => {
      if (depth >= 30 || visited >= 5000 || results.length >= 100) return;
      const entries = await readdir(currentPath);

      for (const entry of entries) {
        if (++visited > 5000) return;
        if (ignore.includes(entry) || entry.startsWith('.')) continue;

        const fullPath = path.join(currentPath, entry);
        const stats = await lstat(fullPath);
        if (stats.isSymbolicLink() || results.length >= 100) continue;

        if (stats.isDirectory()) {
          await search(fullPath, depth + 1);
        } else if (stats.isFile() && /\.(ts|tsx|js|jsx|py|rs|go|java|c|cpp|h)$/i.test(entry)) {
          try {
            if (stats.size > 2 * 1024 * 1024) continue;
            const content = await readFile(fullPath, 'utf-8');
            if (content.includes('\0')) continue;
            const lines = content.split('\n');

            for (let i = 0; i < lines.length; i++) {
              regex.lastIndex = 0;
              if (regex.test(lines[i])) {
                results.push({
                  file: fullPath,
                  line: i + 1,
                  content: lines[i].trim(),
                });
                if (results.length >= 100) break;
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

  async searchNames(pattern: string, cwd: string): Promise<FileInfo[]> {
    if (!pattern || pattern.length > 200) throw new Error('Filename search requires 1–200 characters.');
    const needle = pattern.toLowerCase();
    return (await this.listFiles(cwd)).filter(file => file.type === 'file' && path.relative(cwd, file.path).toLowerCase().includes(needle)).slice(0, 100);
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
