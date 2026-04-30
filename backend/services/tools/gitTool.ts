import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { join, relative } from 'path';
import { cwd } from 'process';
import log from 'electron-log';

export interface GitStatusResult {
  success: boolean;
  files?: GitFile[];
  branch?: string;
  ahead?: number;
  behind?: number;
  error?: string;
}

export interface GitFile {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'ignored';
  staged: boolean;
}

export interface GitDiffResult {
  success: boolean;
  diff?: string;
  error?: string;
}

export interface GitCommitResult {
  success: boolean;
  hash?: string;
  message?: string;
  error?: string;
}

export interface GitLogResult {
  success: boolean;
  commits?: GitCommit[];
  error?: string;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: number;
}

export interface GitBranchResult {
  success: boolean;
  current?: string;
  branches?: GitBranch[];
  error?: string;
}

export interface GitBranch {
  name: string;
  current: boolean;
  remote?: string;
}

export class GitTool {
  private repoRoot: string;
  private gitPath: string;

  constructor(repoRoot?: string) {
    this.repoRoot = repoRoot || cwd();
    this.gitPath = process.platform === 'win32' ? 'git.exe' : 'git';
  }

  setRepoRoot(path: string): void {
    this.repoRoot = path;
  }

  private async execGit(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';

      const proc = spawn(this.gitPath, args, {
        cwd: this.repoRoot,
        shell: true,
        windowsHide: true,
      });

      proc.stdout?.on('data', (data) => { stdout += data.toString(); });
      proc.stderr?.on('data', (data) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        resolve({ stdout, stderr, code: code ?? 0 });
      });

      proc.on('error', (error) => {
        log.error('Git error:', error);
        resolve({ stdout: '', stderr: String(error), code: 1 });
      });
    });
  }

  async status(): Promise<GitStatusResult> {
    try {
      const { stdout, code } = await this.execGit(['status', '--porcelain=v1', '-u']);

      if (code !== 0) {
        return { success: false, error: stdout || 'Git error' };
      }

      const branchResult = await this.execGit(['branch', '--show-current']);
      const branch = branchResult.stdout.trim();

      const aheadResult = await this.execGit(['rev-list', '--count', '@{upstream}..HEAD']);
      const behindResult = await this.execGit(['rev-list', '--count', 'HEAD..@{upstream}']);

      const files: GitFile[] = [];
      
      for (const line of stdout.split('\n').filter(Boolean)) {
        const statusChar = line.substring(0, 2);
        const filePath = line.substring(3).trim();

        const statusMap: Record<string, GitFile['status']> = {
          'M': 'modified',
          'A': 'added',
          'D': 'deleted',
          'R': 'renamed',
          '??': 'untracked',
          '!!': 'ignored',
        };

        const staged = statusChar[0] !== ' ' && statusChar[0] !== '?';
        const shortStatus = statusChar[0] === '?' ? '??' : statusChar[0] === ' ' ? statusChar[1] + statusChar[1] : statusChar;
        
        files.push({
          path: filePath,
          status: statusMap[shortStatus] || 'modified',
          staged,
        });
      }

      return {
        success: true,
        files,
        branch,
        ahead: parseInt(aheadResult.stdout) || 0,
        behind: parseInt(behindResult.stdout) || 0,
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  async diff(options?: {
    file?: string;
    staged?: boolean;
    cached?: boolean;
    branch?: string;
  }): Promise<GitDiffResult> {
    try {
      const args: string[] = ['diff'];

      if (options?.staged || options?.cached) {
        args.push('--cached');
      }

      if (options?.file) {
        args.push('--', options.file);
      }

      if (options?.branch) {
        args.push(options.branch);
      }

      args.push('--no-color');

      const { stdout, code } = await this.execGit(args);

      return {
        success: code === 0,
        diff: stdout,
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  async diffSummary(): Promise<{ success: boolean; changes?: number; error?: string }> {
    try {
      const { stdout } = await this.execGit(['diff', '--stat']);
      
      const match = stdout.match(/(\d+)\s+file/);
      const changes = match ? parseInt(match[1]) : 0;

      return { success: true, changes };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  async commit(message: string, options?: { all?: boolean; amend?: boolean }): Promise<GitCommitResult> {
    try {
      if (options?.all) {
        await this.execGit(['add', '-A']);
      }

      const args = ['commit'];
      
      if (options?.amend) {
        args.push('--amend', '--no-edit');
      } else {
        args.push('-m', message);
      }

      const { stdout, code } = await this.execGit(args);

      if (code !== 0) {
        return { success: false, error: stdout };
      }

      const hashMatch = stdout.match(/\[([a-f0-9]+)\s/);
      const hash = hashMatch ? hashMatch[1] : '';

      return {
        success: true,
        hash,
        message: options?.amend ? undefined : message,
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  async add(files?: string | string[]): Promise<{ success: boolean; error?: string }> {
    try {
      const args = ['add'];
      
      if (files) {
        if (Array.isArray(files)) {
          args.push(...files);
        } else {
          args.push(files);
        }
      } else {
        args.push('-A');
      }

      const { stdout, code } = await this.execGit(args);

      return {
        success: code === 0,
        error: code !== 0 ? stdout : undefined,
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  async log(options?: { limit?: number; file?: string }): Promise<GitLogResult> {
    try {
      const args = ['log', `--max-count=${options?.limit || 10}`, '--format=%H|%h|%s|%an|%at'];
      
      if (options?.file) {
        args.push('--', options.file);
      }

      const { stdout, code } = await this.execGit(args);

      if (code !== 0) {
        return { success: false, error: stdout };
      }

      const commits: GitCommit[] = [];
      
      for (const line of stdout.split('\n').filter(Boolean)) {
        const [hash, shortHash, message, author, date] = line.split('|');
        
        commits.push({
          hash,
          shortHash,
          message,
          author,
          date: parseInt(date) * 1000,
        });
      }

      return { success: true, commits };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  async branch(options?: { list?: boolean; current?: boolean; all?: boolean }): Promise<GitBranchResult> {
    try {
      const args = ['branch'];
      
      if (options?.all) {
        args.push('-a');
      } else if (options?.list) {
        args.push('--list');
      }

      const { stdout, code } = await this.execGit(args);

      if (code !== 0) {
        return { success: false, error: stdout };
      }

      const currentResult = await this.execGit(['branch', '--show-current']);
      const current = currentResult.stdout.trim();

      const branches: GitBranch[] = [];
      
      for (const line of stdout.split('\n').filter(Boolean)) {
        const name = line.replace(/^\*?\s*remotes\/|\s*$/g, '').trim();
        const isCurrent = line.startsWith('*');
        
        branches.push({
          name,
          current: isCurrent,
          remote: line.includes('remotes/') ? line.replace(/.*remotes\//, '').trim() : undefined,
        });
      }

      return {
        success: true,
        current,
        branches,
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  async checkout(branch: string, options?: { create?: boolean; force?: boolean }): Promise<{ success: boolean; error?: string }> {
    try {
      const args = ['checkout'];
      
      if (options?.create) {
        args.push('-b');
      }
      
      if (options?.force) {
        args.push('--force');
      }
      
      args.push(branch);

      const { stdout, code } = await this.execGit(args);

      return {
        success: code === 0,
        error: code !== 0 ? stdout : undefined,
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  async fetch(options?: { all?: boolean; prune?: boolean }): Promise<{ success: boolean; error?: string }> {
    try {
      const args = ['fetch'];
      
      if (options?.all) {
        args.push('--all');
      }
      
      if (options?.prune) {
        args.push('--prune');
      }

      const { stdout, code } = await this.execGit(args);

      return {
        success: code === 0,
        error: code !== 0 ? stdout : undefined,
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  async pull(options?: { rebase?: boolean }): Promise<{ success: boolean; files?: number; error?: string }> {
    try {
      const args = ['pull'];
      
      if (options?.rebase) {
        args.push('--rebase');
      }

      const { stdout, code } = await this.execGit(args);

      if (code !== 0) {
        return { success: false, error: stdout };
      }

      const match = stdout.match(/(\d+)\s+file/);
      const files = match ? parseInt(match[1]) : 0;

      return { success: true, files };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  async push(options?: { remote?: string; force?: boolean; tags?: boolean }): Promise<{ success: boolean; error?: string }> {
    try {
      const args = ['push'];
      
      if (options?.remote) {
        args.push(options.remote);
      }
      
      if (options?.force) {
        args.push('--force');
      }
      
      if (options?.tags) {
        args.push('--tags');
      }

      const { stdout, code } = await this.execGit(args);

      return {
        success: code === 0,
        error: code !== 0 ? stdout : undefined,
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  async isRepo(): Promise<boolean> {
    try {
      await fs.access(join(this.repoRoot, '.git'));
      return true;
    } catch {
      return false;
    }
  }

  async getRoot(): Promise<string | null> {
    const { stdout, code } = await this.execGit(['rev-parse', '--show-toplevel']);
    return code === 0 ? stdout.trim() : null;
  }
}

export default GitTool;