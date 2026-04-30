import { readFile, writeFile, stat } from 'fs/promises';
import { EventEmitter } from 'events';
import log from 'electron-log';
import { FileEdit, FileEditResult, AppliedEdit } from '../types/index.js';

export interface EditInstruction {
  type: 'replace' | 'insert' | 'delete';
  startLine?: number;
  endLine?: number;
  content?: string;
  afterLine?: number;
  beforeLine?: number;
  searchPattern?: string;
}

export interface EditResult {
  success: boolean;
  path: string;
  edits: AppliedEdit[];
  error?: string;
  backup?: string;
}

export class FileEditingEngine extends EventEmitter {
  constructor() {
    super();
  }

  async editFile(path: string, edits: EditInstruction[]): Promise<EditResult> {
    log.info(`Editing file: ${path} with ${edits.length} edits`);

    let content: string;
    let backup: string | undefined;

    try {
      const fileStat = await stat(path);
      content = await readFile(path, 'utf-8');
      backup = content;
    } catch (error) {
      return { success: false, path, edits: [], error: `Cannot read file: ${error}` };
    }

    const lines = content.split('\n');
    const appliedEdits: AppliedEdit[] = [];

    try {
      for (const edit of edits) {
        const applied = this.applyEdit(lines, edit);
        if (applied) {
          appliedEdits.push(applied);
        }
      }

      const newContent = lines.join('\n');
      
      await writeFile(path, newContent, 'utf-8');
      
      log.info(`File edited successfully: ${path}`);
      this.emit('file:edited', { path, edits: appliedEdits });

      return {
        success: true,
        path,
        edits: appliedEdits,
        backup,
      };
    } catch (error) {
      log.error(`Failed to edit file: ${path}`, error);
      return {
        success: false,
        path,
        edits: appliedEdits,
        error: String(error),
        backup,
      };
    }
  }

  private applyEdit(lines: string[], edit: EditInstruction): AppliedEdit | null {
    switch (edit.type) {
      case 'replace':
        return this.replaceLines(lines, edit.startLine!, edit.endLine!, edit.content!);
      case 'insert':
        return this.insertLines(lines, edit.afterLine!, edit.content!);
      case 'delete':
        return this.deleteLines(lines, edit.startLine!, edit.endLine!);
      default:
        return null;
    }
  }

  private replaceLines(lines: string[], startLine: number, endLine: number, content: string): AppliedEdit {
    const start = startLine - 1;
    const end = endLine;
    
    const original = lines.slice(start, end).join('\n');
    const newLines = content.split('\n');
    
    lines.splice(start, end - start, ...newLines);

    return {
      type: 'replace',
      startLine,
      endLine,
      original,
      new: content,
    };
  }

  private insertLines(lines: string[], afterLine: number, content: string): AppliedEdit {
    const position = afterLine;
    const newLines = content.split('\n');
    
    lines.splice(position, 0, ...newLines);

    return {
      type: 'insert',
      startLine: position + 1,
      endLine: position + newLines.length,
      content,
    };
  }

  private deleteLines(lines: string[], startLine: number, endLine: number): AppliedEdit {
    const start = startLine - 1;
    const end = endLine;
    
    const original = lines.slice(start, end).join('\n');
    lines.splice(start, end - start);

    return {
      type: 'delete',
      startLine,
      endLine,
      original,
    };
  }

  async multiFileEdit(edits: Map<string, EditInstruction[]>): Promise<EditResult[]> {
    const results: EditResult[] = [];

    for (const [path, fileEdits] of edits) {
      const result = await this.editFile(path, fileEdits);
      results.push(result);
    }

    return results;
  }

  async createFile(path: string, content: string): Promise<{ success: boolean; path: string; error?: string }> {
    try {
      await writeFile(path, content, 'utf-8');
      return { success: true, path };
    } catch (error) {
      return { success: false, path, error: String(error) };
    }
  }

  async deleteFile(path: string): Promise<{ success: boolean; path: string; error?: string }> {
    try {
      const { unlink } = await import('fs/promises');
      await unlink(path);
      return { success: true, path };
    } catch (error) {
      return { success: false, path, error: String(error) };
    }
  }

  async backupFile(path: string): Promise<string | null> {
    try {
      const content = await readFile(path, 'utf-8');
      const backupPath = `${path}.backup.${Date.now()}`;
      await writeFile(backupPath, content, 'utf-8');
      return backupPath;
    } catch (error) {
      log.warn(`Failed to backup file: ${path}`, error);
      return null;
    }
  }

  async restoreFile(backupPath: string): Promise<{ success: boolean; path: string; error?: string }> {
    try {
      const content = await readFile(backupPath, 'utf-8');
      const originalPath = backupPath.replace(/\.backup\.\d+$/, '');
      await writeFile(originalPath, content, 'utf-8');
      return { success: true, path: originalPath };
    } catch (error) {
      return { success: false, path: backupPath, error: String(error) };
    }
  }

  parseEditInstructions(text: string): EditInstruction[] {
    const instructions: EditInstruction[] = [];
    
    const replacePattern = /replace\s+lines\s+(\d+)-(\d+)\s+with\s+```[\s\S]*?```/g;
    let match;
    
    while ((match = replacePattern.exec(text)) !== null) {
      const lineMatch = text.match(/replace\s+lines\s+(\d+)-(\d+)/);
      const contentMatch = text.match(/```[\s\S]*?\n([\s\S]*?)```/);
      
      if (lineMatch && contentMatch) {
        instructions.push({
          type: 'replace',
          startLine: parseInt(lineMatch[1]),
          endLine: parseInt(lineMatch[2]),
          content: contentMatch[1].trim(),
        });
      }
    }

    const insertPattern = /insert\s+after\s+line\s+(\d+)\s+```[\s\S]*?```/g;
    
    while ((match = insertPattern.exec(text)) !== null) {
      const lineMatch = text.match(/insert\s+after\s+line\s+(\d+)/);
      const contentMatch = text.match(/```([\s\S]*?)```/);
      
      if (lineMatch && contentMatch) {
        instructions.push({
          type: 'insert',
          afterLine: parseInt(lineMatch[1]),
          content: contentMatch[1].trim(),
        });
      }
    }

    return instructions;
  }
}

export default FileEditingEngine;