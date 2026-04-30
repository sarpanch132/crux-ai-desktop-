import { readFile, writeFile, unlink, stat, readdir, access, mkdir } from 'fs/promises';
import { dirname, relative, sep, join, isAbsolute } from 'path';
import { cwd } from 'process';
import log from 'electron-log';
import { FileEdit, EditResult, AppliedEdit } from '../../shared/types/index.js';

export const DANGEROUS_PATTERNS = [
  /^C:\\Windows/i,
  /^C:\\Program\s*Files/i,
  /^C:\\Users.*\\AppData\\Local\\Microsoft/i,
  /^\/System/i,
  /^\/Library\/Receipts/i,
  /^\.git\//,
  /node_modules/,
];

export const DANGEROUS_EXTENSIONS = [
  /\.exe$/i,
  /\.dll$/i,
  /\.so$/i,
  /\.dylib$/i,
  /\.bat$/i,
  /\.cmd$/i,
  /\.ps1$/i,
  /\.sh$/i,
  /\.sql$/i,
];

export const IGNORE_PATTERNS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '__pycache__',
  '.DS_Store',
  '*.log',
  '.env.local',
  'vendor/bundle',
];

export const MAX_FILE_SIZE = 10 * 1024 * 1024;
export const MAX_LINE_COUNT = 50000;

export interface FileReadOptions {
  path: string;
  encoding?: BufferEncoding;
  maxSize?: number;
  lineNumbers?: boolean;
  highlight?: string;
}

export interface FileReadResult {
  success: boolean;
  content?: string;
  lines?: number;
  truncated?: boolean;
  error?: string;
}

export interface FileWriteOptions {
  path: string;
  content: string;
  createDirectories?: boolean;
  encoding?: BufferEncoding;
}

export interface FileWriteResult {
  success: boolean;
  path?: string;
  bytesWritten?: number;
  error?: string;
}

export interface FileEditOptions {
  path: string;
  edits: FileEdit[];
  dryRun?: boolean;
  createBackup?: boolean;
}

export interface FileEditResult {
  success: boolean;
  path: string;
  edits: AppliedEdit[];
  error?: string;
  backupPath?: string;
}

export class FileTool {
  private workspaceRoot: string;
  private allowOutOfWorkspace: boolean;

  constructor(workspaceRoot?: string, allowOutOfWorkspace = false) {
    this.workspaceRoot = workspaceRoot || cwd();
    this.allowOutOfWorkspace = allowOutOfWorkspace;
  }

  setWorkspaceRoot(path: string): void {
    this.workspaceRoot = path;
  }

  validatePath(filePath: string): { valid: boolean; error?: string; resolved?: string } {
    if (!filePath || typeof filePath !== 'string') {
      return { valid: false, error: 'Invalid file path' };
    }

    const normalized = filePath.replace(/\\/g, '/');

    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(normalized)) {
        return { valid: false, error: `Path matches dangerous pattern: ${pattern}` };
      }
    }

    for (const ext of DANGEROUS_EXTENSIONS) {
      if (ext.test(normalized)) {
        return { valid: false, error: `Dangerous file extension: ${ext}` };
      }
    }

    let resolved: string;
    try {
      resolved = isAbsolute(normalized) 
        ? normalized 
        : join(this.workspaceRoot, normalized);
    } catch {
      return { valid: false, error: 'Invalid path resolution' };
    }

    if (!this.allowOutOfWorkspace) {
      const relativePath = relative(this.workspaceRoot, resolved);
      if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
        return { valid: false, error: 'Path is outside workspace' };
      }
    }

    return { valid: true, resolved };
  }

  async read(options: FileReadOptions): Promise<FileReadResult> {
    const { path, encoding = 'utf-8', maxSize, lineNumbers = true, highlight } = options;

    const validation = this.validatePath(path);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    try {
      const stats = await stat(validation.resolved!);

      if (stats.size > (maxSize || MAX_FILE_SIZE)) {
        return { 
          success: false, 
          error: `File too large: ${stats.size} bytes (max: ${maxSize || MAX_FILE_SIZE})` 
        };
      }

      let content = await readFile(validation.resolved!, { encoding });
      
      const lines = content.split('\n');
      if (lines.length > MAX_LINE_COUNT) {
        content = lines.slice(0, MAX_LINE_COUNT).join('\n');
        return { 
          success: true, 
          content, 
          lines: MAX_LINE_COUNT, 
          truncated: true 
        };
      }

      if (highlight && lineNumbers) {
        const highlightLines = highlight.split(',').map(l => parseInt(l.trim()));
        content = lines.map((line, i) => {
          const lineNum = i + 1;
          const prefix = highlightLines.includes(lineNum) ? '>>> ' : '    ';
          return `${String(lineNum).padStart(4)}${prefix}${line}`;
        }).join('\n');
      } else if (lineNumbers) {
        content = lines.map((line, i) => `${String(i + 1).padStart(4)}| ${line}`).join('\n');
      }

      return { 
        success: true, 
        content, 
        lines: lines.length 
      };
    } catch (error) {
      log.error(`File read error: ${path}`, error);
      return { success: false, error: String(error) };
    }
  }

  async write(options: FileWriteOptions): Promise<FileWriteResult> {
    const { path, content, createDirectories = true, encoding = 'utf-8' } = options;

    const validation = this.validatePath(path);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    try {
      if (createDirectories) {
        const dir = dirname(validation.resolved!);
        await access(dir).catch(() => mkdir(dir, { recursive: true }));
      }

      await writeFile(validation.resolved!, content, { encoding });
      
      log.info(`File written: ${validation.resolved}`);
      return { 
        success: true, 
        path: validation.resolved, 
        bytesWritten: content.length 
      };
    } catch (error) {
      log.error(`File write error: ${path}`, error);
      return { success: false, error: String(error) };
    }
  }

  async delete(filePath: string): Promise<{ success: boolean; error?: string }> {
    const validation = this.validatePath(filePath);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    try {
      await unlink(validation.resolved!);
      log.info(`File deleted: ${validation.resolved}`);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  async exists(filePath: string): Promise<{ exists: boolean; isFile?: boolean; isDirectory?: boolean; size?: number }> {
    const validation = this.validatePath(filePath);
    if (!validation.valid) {
      return { exists: false };
    }

    try {
      const stats = await stat(validation.resolved!);
      return { 
        exists: true, 
        isFile: stats.isFile(), 
        isDirectory: stats.isDirectory(),
        size: stats.size 
      };
    } catch {
      return { exists: false };
    }
  }

  async list(options: {
    path?: string;
    recursive?: boolean;
    ignore?: string[];
    maxDepth?: number;
  }): Promise<{ success: boolean; files?: FileInfo[]; error?: string }> {
    const { path, recursive = false, ignore = IGNORE_PATTERNS, maxDepth = 5 } = options;
    
    const basePath = path || this.workspaceRoot;
    const validation = this.validatePath(basePath);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    const files: FileInfo[] = [];

    const scan = async (dirPath: string, depth = 0) => {
      if (depth > maxDepth) return;

      try {
        const entries = await readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
          if (ignore.includes(entry.name) || entry.name.startsWith('.')) continue;

          const fullPath = join(dirPath, entry.name);
          
          try {
            const stats = await stat(fullPath);
            
            files.push({
              name: entry.name,
              path: relative(this.workspaceRoot, fullPath),
              absolutePath: fullPath,
              type: entry.isDirectory() ? 'directory' : 'file',
              size: stats.size,
              modified: stats.mtimeMs,
            });

            if (recursive && entry.isDirectory()) {
              await scan(fullPath, depth + 1);
            }
          } catch {
          }
        }
      } catch (error) {
        log.warn(`Cannot scan directory: ${dirPath}`, error);
      }
    };

    await scan(validation.resolved!);
    return { success: true, files };
  }

  async applyEdits(options: FileEditOptions): Promise<FileEditResult> {
    const { path, edits, dryRun = false, createBackup = false } = options;

    const validation = this.validatePath(path);
    if (!validation.valid) {
      return { success: false, path, edits: [], error: validation.error };
    }

    let content: string;
    let backupPath: string | undefined;

    try {
      if (createBackup) {
        const stats = await stat(validation.resolved!);
        if (stats.isFile()) {
          content = await readFile(validation.resolved!, 'utf-8');
          backupPath = `${validation.resolved}.backup.${Date.now()}`;
          await writeFile(backupPath, content, 'utf-8');
        }
      } else {
        content = await readFile(validation.resolved!, 'utf-8');
      }
    } catch (error) {
      return { success: false, path, edits: [], error: String(error) };
    }

    const lines = content.split('\n');
    const appliedEdits: AppliedEdit[] = [];

    for (const edit of edits) {
      try {
        const applied = this.applyEditToLines(lines, edit);
        if (applied) {
          appliedEdits.push(applied);
        }
      } catch (error) {
        return { 
          success: false, 
          path, 
          edits: appliedEdits, 
          error: `Edit failed: ${error}` 
        };
      }
    }

    if (!dryRun) {
      const newContent = lines.join('\n');
      await writeFile(validation.resolved!, newContent, 'utf-8');
    }

    return { 
      success: true, 
      path: validation.resolved!, 
      edits: appliedEdits,
      backupPath 
    };
  }

  private applyEditToLines(lines: string[], edit: FileEdit): AppliedEdit | null {
    switch (edit.type) {
      case 'replace': {
        const start = (edit.startLine || 1) - 1;
        const end = edit.endLine || start + 1;
        
        const original = lines.slice(start, end).join('\n');
        const newLines = edit.content?.split('\n') || [];
        
        lines.splice(start, end - start, ...newLines);

        return {
          type: 'replace',
          startLine: edit.startLine!,
          endLine: edit.endLine!,
          original,
          new: edit.content,
        };
      }
      case 'insert': {
        const position = edit.afterLine || 0;
        const newLines = edit.content?.split('\n') || [];
        
        lines.splice(position, 0, ...newLines);

        return {
          type: 'insert',
          startLine: position + 1,
          endLine: position + newLines.length,
          content: edit.content,
        };
      }
      case 'delete': {
        const start = (edit.startLine || 1) - 1;
        const end = edit.endLine || start + 1;
        
        const original = lines.slice(start, end).join('\n');
        lines.splice(start, end - start);

        return {
          type: 'delete',
          startLine: edit.startLine!,
          endLine: edit.endLine!,
          original,
        };
      }
      default:
        return null;
    }
  }
}

interface FileInfo {
  name: string;
  path: string;
  absolutePath: string;
  type: 'file' | 'directory';
  size: number;
  modified: number;
}

export default FileTool;