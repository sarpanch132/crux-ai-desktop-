export interface AgentConfig {
  id?: string;
  name?: string;
  aiProvider?: string;
  aiApiKey?: string;
  aiModel?: string;
  aiEndpoint?: string;
  maxTokens?: number;
  maxContextTokens?: number;
  maxMemories?: number;
  memoryPath?: string;
  projectPath?: string;
  autoRetry?: boolean;
  maxRetries?: number;
  retryDelay?: number;
  timeout?: number;
  ignorePatterns?: string[];
  maxConcurrent?: number;
  embeddings?: boolean;
  streaming?: boolean;
}

export interface AgentState {
  id: string;
  status: 'idle' | 'running' | 'paused' | 'completed' | 'failed' | 'stopped' | 'error';
  currentTask?: any;
  currentPlan?: any;
  context: any[];
  memory: any[];
  tokensUsed: number;
  tokensLimit: number;
  startTime?: number;
  endTime?: number;
}

export interface ExecutionPlan {
  id: string;
  goal: string;
  steps: Task[];
  allowRetry: boolean;
  maxRetries: number;
  timeout: number;
  dependencies: string[];
  createdAt: number;
}

export interface Task {
  id: string;
  type: 'read' | 'write' | 'edit' | 'execute' | 'analyze' | 'search' | 'diagnose' | 'create' | 'delete';
  title: string;
  description: string;
  file?: string;
  content?: string;
  edits?: FileEdit[];
  command?: string;
  cwd?: string;
  timeout?: number;
  pattern?: string;
  path?: string;
  code?: string;
  error?: string;
  context?: any;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  dependencies: string[];
  result?: any;
}

export interface FileEdit {
  type: 'replace' | 'insert' | 'delete';
  startLine?: number;
  endLine?: number;
  content?: string;
  afterLine?: number;
  beforeLine?: number;
}

export interface ExecutionResult {
  success: boolean;
  data?: any;
  error?: string;
  executionTime?: number;
  retries?: number;
}

export interface ToolResult {
  success: boolean;
  data?: any;
  error?: string;
  executionTime?: number;
}

export interface ContextEntry {
  id: string;
  type: 'request' | 'repository' | 'file' | 'memory' | 'summary' | 'system' | 'error' | 'task';
  content: any;
  analysis?: any;
  metadata?: Record<string, any>;
  tokens: number;
  timestamp: number;
}

export interface Memory {
  id: string;
  type: 'step_completion' | 'summary' | 'context' | 'fact' | 'preference' | 'error' | 'file';
  content: any;
  metadata?: Record<string, any>;
  timestamp: number;
  embedding?: number[];
  importance: number;
}

export interface ModelConfig {
  provider: 'openrouter' | 'openai' | 'anthropic' | 'custom';
  apiKey: string;
  model: string;
  endpoint?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  stream?: boolean;
}

export interface StreamChunk {
  content: string;
  done: boolean;
  error?: string;
}

export interface QueuedTask {
  id: string;
  type: string;
  priority: number;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  data: any;
  result?: any;
  error?: Error;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  retries: number;
  maxRetries: number;
}

export interface FileEditResult {
  success: boolean;
  path: string;
  edits: AppliedEdit[];
  error?: string;
}

export interface AppliedEdit {
  type: 'replace' | 'insert' | 'delete';
  startLine: number;
  endLine: number;
  content?: string;
  original?: string;
  new?: string;
}