import { EventEmitter } from 'events';
import log from 'electron-log';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface GitHubConfig {
  owner: string;
  repo: string;
  token?: string;
  baseBranch: string;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: 'open' | 'closed';
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  date: string;
  files: string[];
}

export interface BranchInfo {
  name: string;
  commit: string;
  protected: boolean;
}

export interface DiffResult {
  files: { path: string; status: 'added' | 'modified' | 'deleted'; hunks: any[] }[];
  commits: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  assignees: string[];
}

export class GitHubAutomation extends EventEmitter {
  private config: GitHubConfig;
  private ghPath: string = 'gh';
  private isAuthenticated: boolean = false;

  constructor(config: Partial<GitHubConfig> = {}) {
    super();
    this.config = {
      owner: config.owner ?? '',
      repo: config.repo ?? '',
      token: config.token,
      baseBranch: config.baseBranch ?? 'main',
    };
  }

  async initialize(): Promise<boolean> {
    try {
      const { version } = await this.runCommand(['--version']);
      if (!version) {
        log.error('GitHub CLI not found');
        return false;
      }

      if (this.config.token) {
        await this.runCommand(['auth', 'status'], { GH_TOKEN: this.config.token });
      }

      this.isAuthenticated = true;
      log.info('GitHub automation initialized');
      return true;
    } catch (error) {
      log.error('GitHub initialization failed:', error);
      return false;
    }
  }

  async authenticate(): Promise<boolean> {
    try {
      await this.runCommand(['auth', 'login', '--web', '--force']);
      this.isAuthenticated = true;
      this.emit('authenticated');
      return true;
    } catch (error) {
      log.error('GitHub authentication failed:', error);
      return false;
    }
  }

  async createPullRequest(options: {
    title: string;
    body: string;
    head: string;
    base?: string;
    draft?: boolean;
    reviewer?: string[];
    assignees?: string[];
    labels?: string[];
  }): Promise<PullRequest | null> {
    try {
      const base = options.base ?? this.config.baseBranch;
      const args = [
        'pr', 'create',
        '--title', options.title,
        '--body', options.body,
        '--head', options.head,
        '--base', base,
      ];

      if (options.draft) args.push('--draft');
      if (options.reviewer?.length) {
        for (const r of options.reviewer) args.push('--reviewer', r);
      }
      if (options.assignees?.length) {
        for (const a of options.assignees) args.push('--assignee', a);
      }
      if (options.labels?.length) {
        for (const l of options.labels) args.push('--label', l);
      }

      const output = await this.runCommand(args);
      const urlMatch = output?.match(/https:\/\/github\.com\/[^\/]+\/[^\/]+\/pull\/(\d+)/);
      
      if (!urlMatch) {
        log.error('Failed to parse PR URL:', output);
        return null;
      }

      return await this.getPullRequest(parseInt(urlMatch[1]));
    } catch (error) {
      log.error('Failed to create PR:', error);
      return null;
    }
  }

  async getPullRequest(number: number): Promise<PullRequest | null> {
    try {
      const output = await this.runCommand(['pr', 'view', String(number), '--json', 
        'number,title,body,head,base,state,url,createdAt,updatedAt'
      ]);
      
      const data = JSON.parse(output);
      return {
        number: data.number,
        title: data.title,
        body: data.body,
        head: data.head,
        base: data.base,
        state: data.state,
        htmlUrl: data.url,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
      };
    } catch (error) {
      log.error('Failed to get PR:', error);
      return null;
    }
  }

  async listPullRequests(options: {
    state?: 'open' | 'closed' | 'all';
    limit?: number;
  } = {}): Promise<PullRequest[]> {
    try {
      const state = options.state ?? 'open';
      const limit = options.limit ?? 30;
      
      const output = await this.runCommand(['pr', 'list', 
        '--state', state, 
        '--limit', String(limit),
        '--json', 'number,title,body,head,base,state,url,createdAt'
      ]);
      
      const data = JSON.parse(output);
      return data.map((pr: any) => ({
        number: pr.number,
        title: pr.title,
        body: pr.body,
        head: pr.head,
        base: pr.base,
        state: pr.state,
        htmlUrl: pr.url,
        createdAt: pr.createdAt,
        updatedAt: pr.updatedAt,
      }));
    } catch (error) {
      log.error('Failed to list PRs:', error);
      return [];
    }
  }

  async closePullRequest(number: number): Promise<boolean> {
    try {
      await this.runCommand(['pr', 'close', String(number)]);
      return true;
    } catch (error) {
      log.error('Failed to close PR:', error);
      return false;
    }
  }

  async mergePullRequest(options: {
    number: number;
    method?: 'merge' | 'squash' | 'rebase';
    deleteBranch?: boolean;
  }): Promise<boolean> {
    try {
      const method = options.method ?? 'merge';
      const args = ['pr', 'merge', String(options.number), '--admin', '--merge'];
      
      if (method !== 'merge') {
        args.push('--squash' === method ? '--squash' : '--rebase');
      }
      
      if (options.deleteBranch !== false) {
        args.push('--delete-branch');
      }

      await this.runCommand(args);
      return true;
    } catch (error) {
      log.error('Failed to merge PR:', error);
      return false;
    }
  }

  async createIssue(options: {
    title: string;
    body: string;
    labels?: string[];
    assignees?: string[];
  }): Promise<Issue | null> {
    try {
      const args = [
        'issue', 'create',
        '--title', options.title,
        '--body', options.body,
      ];

      if (options.labels?.length) {
        for (const l of options.labels) args.push('--label', l);
      }
      if (options.assignees?.length) {
        for (const a of options.assignees) args.push('--assignee', a);
      }

      const output = await this.runCommand(args);
      const numMatch = output?.match(/#(\d+)/);
      
      if (!numMatch) return null;

      const number = parseInt(numMatch[1]);
      return await this.getIssue(number);
    } catch (error) {
      log.error('Failed to create issue:', error);
      return null;
    }
  }

  async getIssue(number: number): Promise<Issue | null> {
    try {
      const output = await this.runCommand(['issue', 'view', String(number), '--json',
        'number,title,body,state,labels,assignees'
      ]);
      
      const data = JSON.parse(output);
      return {
        number: data.number,
        title: data.title,
        body: data.body,
        state: data.state,
        labels: data.labels,
        assignees: data.assignees,
      };
    } catch (error) {
      return null;
    }
  }

  async listIssues(options: {
    state?: 'open' | 'closed' | 'all';
    limit?: number;
    labels?: string[];
  } = {}): Promise<Issue[]> {
    try {
      const state = options.state ?? 'open';
      const limit = options.limit ?? 30;
      
      const args = ['issue', 'list', '--state', state, '--limit', String(limit)];
      
      if (options.labels?.length) {
        for (const l of options.labels) args.push('--label', l);
      }

      const output = await this.runCommand([...args, '--json', 'number,title,body,state,labels']);
      const data = JSON.parse(output);
      
      return data.map((issue: any) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: issue.labels,
        assignees: [],
      }));
    } catch (error) {
      log.error('Failed to list issues:', error);
      return [];
    }
  }

  async createBranch(name: string, fromBranch?: string): Promise<boolean> {
    try {
      const source = fromBranch ?? this.config.baseBranch;
      await this.runCommand(['git', 'checkout', '-b', name, source]);
      return true;
    } catch (error) {
      log.error('Failed to create branch:', error);
      return false;
    }
  }

  async deleteBranch(name: string, force?: boolean): Promise<boolean> {
    try {
      const args = ['branch', force ? '-D' : '-d', name];
      await this.runCommand(args);
      return true;
    } catch (error) {
      log.error('Failed to delete branch:', error);
      return false;
    }
  }

  async listBranches(): Promise<BranchInfo[]> {
    try {
      const output = await this.runCommand(['branch', '-a', '--json', 'name,sha,protected']);
      const data = JSON.parse(output);
      
      return data.map((b: any) => ({
        name: b.name,
        commit: b.sha,
        protected: b.protected,
      }));
    } catch (error) {
      log.error('Failed to list branches:', error);
      return [];
    }
  }

  async getCurrentBranch(): Promise<string> {
    try {
      const output = await this.runCommand(['branch', '--show-current']);
      return output.trim();
    } catch (error) {
      log.error('Failed to get current branch:', error);
      return '';
    }
  }

  async commit(message: string): Promise<string> {
    try {
      await this.runCommand(['add', '.']);
      const output = await this.runCommand(['commit', '-m', message]);
      return output;
    } catch (error) {
      log.error('Failed to commit:', error);
      throw error;
    }
  }

  async getCommitInfo(ref: string = 'HEAD'): Promise<CommitInfo | null> {
    try {
      const output = await this.runCommand(['show', ref, '--stat', '--format', '%H|%s|%an|%ai']);
      const [sha, message, author, date] = output.trim().split('|');
      
      const filesOutput = await this.runCommand(['show', ref, '--name-only']);
      const files = filesOutput.trim().split('\n').filter(Boolean);

      return {
        sha,
        message,
        author,
        date,
        files,
      };
    } catch (error) {
      log.error('Failed to get commit info:', error);
      return null;
    }
  }

  async getDiff(options: {
    from?: string;
    to?: string;
    files?: string[];
  } = {}): Promise<DiffResult> {
    try {
      const args = ['diff', '--unified=3'];
      
      if (options.from) args.push(options.from);
      if (options.to) args.push(options.to);
      
      const output = await this.runCommand(args);

      return {
        files: [],
        commits: output,
      };
    } catch (error) {
      log.error('Failed to get diff:', error);
      return { files: [], commits: '' };
    }
  }

  async push(options: { force?: boolean; setUpstream?: boolean; branch?: string } = {}): Promise<boolean> {
    try {
      const args = ['push'];
      
      if (options.force) args.push('--force');
      if (options.setUpstream) args.push('-u');
      if (options.branch) args.push(options.branch);

      await this.runCommand(args);
      return true;
    } catch (error) {
      log.error('Failed to push:', error);
      return false;
    }
  }

  async pull(options: { rebase?: boolean; branch?: string } = {}): Promise<boolean> {
    try {
      const args = ['pull'];
      
      if (options.rebase) args.push('--rebase');
      if (options.branch) args.push(options.branch);

      await this.runCommand(args);
      return true;
    } catch (error) {
      log.error('Failed to pull:', error);
      return false;
    }
  }

  async fetch(prune: boolean = true): Promise<boolean> {
    try {
      const args = ['fetch', '--all'];
      if (prune) args.push('--prune');
      await this.runCommand(args);
      return true;
    } catch (error) {
      log.error('Failed to fetch:', error);
      return false;
    }
  }

  async createTag(name: string, message?: string, ref?: string): Promise<boolean> {
    try {
      const args = ['tag', '-a', name];
      
      if (message) args.push('-m', message);
      if (ref) args.push(ref);

      await this.runCommand(args);
      return true;
    } catch (error) {
      log.error('Failed to create tag:', error);
      return false;
    }
  }

  async listTags(limit: number = 50): Promise<{ name: string; sha: string; date: string }[]> {
    try {
      const output = await this.runCommand(['tag', '-l', '--sort', '-version:refname', `--format=%(refname:short)|%(objectname:short)|%(creatordate:iso8601)`, `--limit=${limit}`]);
      
      return output.trim().split('\n').filter(Boolean).map(line => {
        const [name, sha, date] = line.split('|');
        return { name, sha, date };
      });
    } catch (error) {
      log.error('Failed to list tags:', error);
      return [];
    }
  }

  async addCollaborator(username: string, permission: 'pull' | 'push' | 'admin' = 'pull'): Promise<boolean> {
    try {
      await this.runCommand(['repo', 'collaborator', username, '--add', `--${permission}`]);
      return true;
    } catch (error) {
      log.error('Failed to add collaborator:', error);
      return false;
    }
  }

  async getReleases(limit: number = 30): Promise<any[]> {
    try {
      const output = await this.runCommand(['release', 'list', `--limit=${limit}`, '--json', 'tagName,target,url']);
      return JSON.parse(output);
    } catch (error) {
      log.error('Failed to get releases:', error);
      return [];
    }
  }

  private runCommand(args: string[], env?: Record<string, string>): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.ghPath, args, {
        shell: true,
        env: { ...process.env, ...env },
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data) => { stdout += data.toString(); });
      proc.stderr?.on('data', (data) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(stderr || `Exit code: ${code}`));
        }
      });

      proc.on('error', (error) => {
        reject(error);
      });
    });
  }

  getStatus(): { authenticated: boolean; owner: string; repo: string } {
    return {
      authenticated: this.isAuthenticated,
      owner: this.config.owner,
      repo: this.config.repo,
    };
  }
}

export const createGitHubAutomation = (config?: Partial<GitHubConfig>): GitHubAutomation => {
  return new GitHubAutomation(config);
};

export default GitHubAutomation;