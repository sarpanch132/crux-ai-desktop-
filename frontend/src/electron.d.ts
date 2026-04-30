declare global {
type AsyncResult<T> = Promise<{ success: boolean; data?: T; error?: string }>;

type AIProvider = 'ollama' | 'openrouter' | 'openai' | 'anthropic' | 'custom';

interface AISettings {
  provider: AIProvider;
  model: string;
  temperature: number;
  maxTokens: number;
  ollamaUrl: string;
  openaiBaseUrl: string;
  customEndpoint: string;
  apiKey: string;
  autonomyLevel: 'guarded' | 'balanced' | 'extended';
  toolPermissions: 'ask' | 'safe-only' | 'manual';
  performanceMode: 'balanced' | 'quality' | 'speed';
}

interface ModelInfo {
  id: string;
  name: string;
  provider: AIProvider;
  status: 'ready' | 'offline' | 'error' | 'loading';
  healthy: boolean;
  ramUsage: string;
  size?: number;
  modifiedAt?: string;
  details?: string;
}

interface ProviderHealth {
  provider: AIProvider;
  status: 'online' | 'degraded' | 'offline';
  message: string;
  latencyMs?: number;
}

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

interface TerminalOutput {
  sessionId: string;
  type: 'stdout' | 'stderr' | 'system';
  data: string;
  timestamp: number;
}

interface TerminalSessionInfo {
  id: string;
  command: string;
  cwd: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  status: 'running' | 'completed' | 'killed' | 'timed_out' | 'error';
}

interface ElectronAPI {
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
  app: {
    getVersion: () => AsyncResult<string>;
    getPlatform: () => AsyncResult<string>;
  };
  on: (channel: string, callback: (...args: unknown[]) => void) => () => void;
}

  interface Window {
    electron: ElectronAPI;
  }
}

export {};
