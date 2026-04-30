import { contextBridge, ipcRenderer } from 'electron';
import type { AISettings, ModelInfo, ProviderHealth } from '../services/aiService.js';
import type { TerminalOutput, TerminalSessionInfo } from '../services/terminalService.js';

type AsyncResult<T> = Promise<{ success: boolean; data?: T; error?: string }>;

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

export interface ElectronAPI {
  file: {
    read: (filePath: string) => AsyncResult<string>;
    write: (filePath: string, content: string) => AsyncResult<void>;
    delete: (filePath: string) => AsyncResult<void>;
    list: (dirPath: string, options?: { recursive?: boolean; filter?: string[] }) => AsyncResult<FileInfo[]>;
    search: (pattern: string, options?: { cwd?: string; ignore?: string[] }) => AsyncResult<SearchResult[]>;
    createDirectory: (dirPath: string) => AsyncResult<void>;
    edit: (filePath: string, edits: { search: string; replace: string }[]) => AsyncResult<string>;
  };
  terminal: {
    exec: (command: string, cwd?: string) => AsyncResult<string>;
    kill: (sessionId: string) => AsyncResult<void>;
    sessions: () => AsyncResult<TerminalSessionInfo[]>;
    onOutput: (callback: (output: TerminalOutput) => void) => () => void;
  };
  ai: {
    chat: (messages: { role: string; content: string }[], options?: { temperature?: number; maxTokens?: number }) => AsyncResult<string>;
    stream: (messages: { role: string; content: string }[], options?: { temperature?: number; maxTokens?: number }) => {
      onChunk: (callback: (chunk: string) => void) => () => void;
      onDone: (callback: () => void) => () => void;
      onError: (callback: (error: string) => void) => () => void;
      abort: () => void;
    };
    abort: () => AsyncResult<void>;
    getModels: () => AsyncResult<ModelInfo[]>;
    getHealth: () => AsyncResult<ProviderHealth[]>;
    getSettings: () => AsyncResult<AISettings>;
    updateSettings: (settings: Partial<AISettings>) => AsyncResult<AISettings>;
  };
  project: {
    open: () => AsyncResult<string>;
    close: () => AsyncResult<void>;
    getPath: () => AsyncResult<string>;
  };
  config: {
    get: (key: string) => AsyncResult<unknown>;
    set: (key: string, value: unknown) => AsyncResult<void>;
  };
  window: {
    minimize: () => AsyncResult<void>;
    maximize: () => AsyncResult<boolean>;
    close: () => AsyncResult<void>;
    isMaximized: () => AsyncResult<boolean>;
  };
  dialog: {
    openFile: (options?: { filters?: { name: string; extensions: string[] }[]; multiple?: boolean }) => AsyncResult<string[]>;
    openDirectory: () => AsyncResult<string>;
    saveFile: (options?: { defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) => AsyncResult<string>;
  };
  shell: {
    openExternal: (url: string) => AsyncResult<void>;
  };
  store: {
    get: (key: string) => AsyncResult<unknown>;
    set: (key: string, value: unknown) => AsyncResult<void>;
  };
  security: {
    getApprovals: () => AsyncResult<unknown[]>;
    approve: (id: string, approved: boolean) => AsyncResult<void>;
  };
  tool: {
    execute: (params: unknown) => AsyncResult<unknown>;
  };
  app: {
    getVersion: () => AsyncResult<string>;
    getPlatform: () => AsyncResult<string>;
  };
  on: (channel: string, callback: (...args: unknown[]) => void) => () => void;
}

const api: ElectronAPI = {
  file: {
    read: (filePath) => ipcRenderer.invoke('file:read', filePath),
    write: (filePath, content) => ipcRenderer.invoke('file:write', filePath, content),
    delete: (filePath) => ipcRenderer.invoke('file:delete', filePath),
    list: (dirPath, options) => ipcRenderer.invoke('file:list', dirPath, options),
    search: (pattern, options) => ipcRenderer.invoke('file:search', pattern, options),
    createDirectory: (dirPath) => ipcRenderer.invoke('file:createDirectory', dirPath),
    edit: (filePath, edits) => ipcRenderer.invoke('file:edit', filePath, edits),
  },
  terminal: {
    exec: (command, cwd) => ipcRenderer.invoke('terminal:exec', command, cwd),
    kill: (sessionId) => ipcRenderer.invoke('terminal:kill', sessionId),
    sessions: () => ipcRenderer.invoke('terminal:sessions'),
    onOutput: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, output: TerminalOutput) => callback(output);
      ipcRenderer.on('terminal:output', handler);
      return () => ipcRenderer.removeListener('terminal:output', handler);
    },
  },
  ai: {
    chat: (messages, options) => ipcRenderer.invoke('ai:chat', messages, options),
    stream: (messages, options) => {
      ipcRenderer.send('ai:stream:start', messages, options);

      return {
        onChunk: (callback) => {
          const handler = (_event: Electron.IpcRendererEvent, chunk: string) => callback(chunk);
          ipcRenderer.on('ai:stream:chunk', handler);
          return () => ipcRenderer.removeListener('ai:stream:chunk', handler);
        },
        onDone: (callback) => {
          const handler = () => callback();
          ipcRenderer.on('ai:stream:done', handler);
          return () => ipcRenderer.removeListener('ai:stream:done', handler);
        },
        onError: (callback) => {
          const handler = (_event: Electron.IpcRendererEvent, error: string) => callback(error);
          ipcRenderer.on('ai:stream:error', handler);
          return () => ipcRenderer.removeListener('ai:stream:error', handler);
        },
        abort: () => {
          ipcRenderer.send('ai:stream:abort');
        },
      };
    },
    abort: () => ipcRenderer.invoke('ai:abort'),
    getModels: () => ipcRenderer.invoke('ai:getModels'),
    getHealth: () => ipcRenderer.invoke('ai:getHealth'),
    getSettings: () => ipcRenderer.invoke('ai:getSettings'),
    updateSettings: (settings) => ipcRenderer.invoke('ai:updateSettings', settings),
  },
  project: {
    open: () => ipcRenderer.invoke('project:open'),
    close: () => ipcRenderer.invoke('project:close'),
    getPath: () => ipcRenderer.invoke('project:getPath'),
  },
  config: {
    get: (key) => ipcRenderer.invoke('config:get', key),
    set: (key, value) => ipcRenderer.invoke('config:set', key, value),
  },
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  },
  dialog: {
    openFile: (options) => ipcRenderer.invoke('dialog:openFile', options),
    openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
    saveFile: (options) => ipcRenderer.invoke('dialog:saveFile', options),
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  },
  store: {
    get: (key) => ipcRenderer.invoke('store:get', key),
    set: (key, value) => ipcRenderer.invoke('store:set', key, value),
  },
  security: {
    getApprovals: () => ipcRenderer.invoke('security:getApprovals'),
    approve: (id, approved) => ipcRenderer.invoke('security:approve', id, approved),
  },
  tool: {
    execute: (params) => ipcRenderer.invoke('tool:execute', params),
  },
  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    getPlatform: () => ipcRenderer.invoke('app:getPlatform'),
  },
  on: (channel, callback) => {
    const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
};

contextBridge.exposeInMainWorld('electron', api);
