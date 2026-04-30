export const APP_NAME = 'AI Coder';
export const APP_VERSION = '1.0.0';

export const DEFAULT_AI_CONFIG = {
  provider: 'openrouter',
  model: 'qwen/qwen3-coder-32b',
  temperature: 0.7,
  maxTokens: 4000,
};

export const IGNORE_PATTERNS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '__pycache__',
  '.DS_Store',
  '*.log',
  '.env',
  '.env.local',
];

export const SUPPORTED_LANGUAGES = [
  'typescript',
  'javascript',
  'python',
  'rust',
  'go',
  'java',
  'c',
  'cpp',
  'csharp',
  'php',
  'ruby',
  'swift',
  'kotlin',
];

export const IPC_CHANNELS = {
  FILE_READ: 'file:read',
  FILE_WRITE: 'file:write',
  FILE_DELETE: 'file:delete',
  FILE_LIST: 'file:list',
  FILE_SEARCH: 'file:search',
  TERMINAL_EXEC: 'terminal:exec',
  TERMINAL_KILL: 'terminal:kill',
  AI_CHAT: 'ai:chat',
  AI_STREAM: 'ai:stream',
  PROJECT_OPEN: 'project:open',
  PROJECT_CLOSE: 'project:close',
  CONFIG_GET: 'config:get',
  CONFIG_SET: 'config:set',
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',
} as const;