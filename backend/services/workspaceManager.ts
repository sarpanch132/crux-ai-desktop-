import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import path from 'path';
import log from 'electron-log';

export interface Workspace {
  id: string;
  name: string;
  path: string;
  type: 'git' | 'local';
  lastOpened: number;
  config?: Record<string, any>;
}

export interface WorkspaceConfig {
  autoOpen?: boolean;
  scanOnOpen?: boolean;
  ignorePatterns?: string[];
  includePatterns?: string[];
  maxFileSize?: number;
}

export interface WorkspaceSettings extends WorkspaceConfig {
  theme?: 'light' | 'dark' | 'system';
  fontSize?: number;
  fontFamily?: string;
  tabSize?: number;
  lineNumbers?: boolean;
  wordWrap?: boolean;
  minimap?: boolean;
  autoSave?: boolean;
  aiModel?: string;
  aiProvider?: string;
}

export interface AppSettings extends WorkspaceSettings {
  language?: string;
  editorKeyBindings?: string;
  terminalShell?: string;
  enableTelemetry?: boolean;
  enableAutoUpdate?: boolean;
}

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  fontSize: 14,
  fontFamily: 'JetBrains Mono, Fira Code, monospace',
  tabSize: 2,
  lineNumbers: true,
  wordWrap: true,
  minimap: false,
  autoSave: true,
  ignorePatterns: ['node_modules', '.git', 'dist', 'build'],
  maxFileSize: 10 * 1024 * 1024,
  enableAutoUpdate: true,
};

export class WorkspaceManager extends EventEmitter {
  private currentWorkspace: Workspace | null = null;
  private workspaces: Map<string, Workspace> = new Map();
  private settings: AppSettings;
  private settingsPath: string;

  constructor(settingsPath?: string) {
    super();
    this.settingsPath = settingsPath || '.aicoder-settings.json';
    this.settings = { ...DEFAULT_SETTINGS };
  }

  async initialize(): Promise<void> {
    try {
      const existingSettings = await this.loadSettings();
      if (existingSettings) {
        this.settings = { ...DEFAULT_SETTINGS, ...existingSettings };
      }

      const recentWorkspaces = this.settings.recentWorkspaces || [];
      for (const ws of recentWorkspaces) {
        this.workspaces.set(ws.id, ws);
      }

      log.info('WorkspaceManager initialized', {
        workspaces: this.workspaces.size,
      });
    } catch (error) {
      log.warn('Failed to load settings:', error);
    }
  }

  async addWorkspace(workspacePath: string, name?: string): Promise<Workspace> {
    const stats = await fs.stat(workspacePath).catch(() => null);
    
    if (!stats?.isDirectory()) {
      throw new Error('Invalid workspace path');
    }

    const isGit = await this.isGitRepo(workspacePath);

    const workspace: Workspace = {
      id: `ws_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      name: name || path.basename(workspacePath),
      path: workspacePath,
      type: isGit ? 'git' : 'local',
      lastOpened: Date.now(),
    };

    this.workspaces.set(workspace.id, workspace);
    this.currentWorkspace = workspace;

    await this.saveSettings();

    this.emit('workspace:opened', workspace);

    return workspace;
  }

  async openWorkspace(workspaceId: string): Promise<Workspace> {
    const workspace = this.workspaces.get(workspaceId);

    if (!workspace) {
      throw new Error('Workspace not found');
    }

    workspace.lastOpened = Date.now();
    this.currentWorkspace = workspace;

    await this.saveSettings();

    this.emit('workspace:opened', workspace);

    return workspace;
  }

  async closeWorkspace(): Promise<void> {
    if (this.currentWorkspace) {
      const workspace = { ...this.currentWorkspace };
      this.currentWorkspace = null;
      this.emit('workspace:closed', workspace);
    }
  }

  getCurrentWorkspace(): Workspace | null {
    return this.currentWorkspace;
  }

  getWorkspaces(): Workspace[] {
    return Array.from(this.workspaces.values())
      .sort((a, b) => b.lastOpened - a.lastOpened);
  }

  removeWorkspace(workspaceId: string): void {
    this.workspaces.delete(workspaceId);
    this.emit('workspace:removed', workspaceId);
  }

  workspaceSettings(workspaceId: string): WorkspaceSettings | undefined {
    return this.workspaces.get(workspaceId)?.config;
  }

  updateSettings(settings: Partial<AppSettings>): void {
    this.settings = { ...this.settings, ...settings };
    this.saveSettings();
    this.emit('settings:updated', settings);
  }

  getSettings(): AppSettings {
    return { ...this.settings };
  }

  private async isGitRepo(workspacePath: string): Promise<boolean> {
    try {
      await fs.access(path.join(workspacePath, '.git'));
      return true;
    } catch {
      return false;
    }
  }

  private async loadSettings(): Promise<Partial<AppSettings> | null> {
    try {
      const content = await fs.readFile(this.settingsPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  private async saveSettings(): Promise<void> {
    try {
      const settingsToSave = {
        ...this.settings,
        recentWorkspaces: this.getWorkspaces().slice(0, 10),
      };

      await fs.writeFile(this.settingsPath, JSON.stringify(settingsToSave, null, 2), 'utf-8');
    } catch (error) {
      log.error('Failed to save settings:', error);
    }
  }
}

export const workspaceManager = new WorkspaceManager();