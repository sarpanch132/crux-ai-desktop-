import { EventEmitter } from 'events';
import log from 'electron-log';
import { AgentConfig, ContextEntry } from '../types/index.js';

export interface ContextEntry {
  id: string;
  type: 'request' | 'repository' | 'file' | 'memory' | 'summary' | 'system' | 'error' | 'task';
  content: any;
  analysis?: any;
  metadata?: Record<string, any>;
  tokens: number;
  timestamp: number;
}

export interface ContextOptions {
  maxTokens?: number;
  preserveSystem?: boolean;
}

export class ContextManager extends EventEmitter {
  private config: AgentConfig;
  private context: ContextEntry[] = [];
  private maxTokens: number;

  constructor(config: AgentConfig) {
    super();
    this.config = config;
    this.maxTokens = config.maxContextTokens || 100000;
  }

  addContext(entry: Omit<ContextEntry, 'id' | 'tokens' | 'timestamp'>): ContextEntry {
    const newEntry: ContextEntry = {
      ...entry,
      id: `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      tokens: this.estimateTokens(entry.content),
      timestamp: Date.now(),
    };

    this.context.push(newEntry);
    this.pruneIfNeeded();

    this.emit('context:added', newEntry);
    log.debug(`Added context: ${newEntry.type} (${newEntry.tokens} tokens)`);

    return newEntry;
  }

  addFile(path: string, content: string): ContextEntry {
    return this.addContext({
      type: 'file',
      content: content.substring(0, 50000),
      metadata: { path, truncated: content.length > 50000 },
    });
  }

  addRequest(content: string, analysis?: any): ContextEntry {
    return this.addContext({
      type: 'request',
      content,
      analysis,
    });
  }

  addRepository(info: any): ContextEntry {
    const content = typeof info === 'string' 
      ? info 
      : JSON.stringify(info).substring(0, 20000);
    
    return this.addContext({
      type: 'repository',
      content,
      metadata: { scanned: Date.now() },
    });
  }

  addSystemMessage(content: string): ContextEntry {
    return this.addContext({
      type: 'system',
      content,
    });
  }

  addError(error: Error): ContextEntry {
    return this.addContext({
      type: 'error',
      content: {
        message: error.message,
        stack: error.stack?.substring(0, 2000),
      },
      metadata: { time: Date.now() },
    });
  }

  addTask(task: any): ContextEntry {
    return this.addContext({
      type: 'task',
      content: task,
      metadata: { status: task.status },
    });
  }

  getFullContext(): ContextEntry[] {
    return [...this.context];
  }

  getMessages(options: ContextOptions = {}): { role: string; content: string }[] {
    const messages: { role: string; content: string }[] = [];
    
    if (options.preserveSystem !== false) {
      messages.push({
        role: 'system',
        content: this.getSystemPrompt(),
      });
    }

    for (const entry of this.context) {
      let content: string;
      
      if (typeof entry.content === 'string') {
        content = entry.content;
      } else {
        content = JSON.stringify(entry.content, null, 2);
      }

      const role = entry.type === 'request' ? 'user' : 
                 entry.type === 'error' ? 'user' :
                 entry.type === 'memory' ? 'system' :
                 entry.type === 'summary' ? 'assistant' :
                 entry.type === 'task' ? 'user' : 'system';

      messages.push({ role, content: content.substring(0, 30000) });
    }

    return messages;
  }

  private getSystemPrompt(): string {
    return `You are an expert AI coding assistant called AI Coder.

Your capabilities:
- Understand and generate code in multiple languages
- Read, write, and edit files
- Execute terminal commands
- Debug and fix issues
- Explain code concepts
- Plan and execute coding tasks

Guidelines:
- Think step-by-step when solving problems
- Always validate your changes
- Explain what you're doing
- Ask for clarification when needed
- Provide production-quality code

Current project context:
${this.getProjectContext()}

Remember: You can use tools to read files, run commands, and make changes.`;
  }

  private getProjectContext(): string {
    const repo = this.context.find(c => c.type === 'repository');
    const files = this.context.filter(c => c.type === 'file');
    
    let context = 'Project: ';
    
    if (repo?.content) {
      const info = typeof repo.content === 'string' ? repo.content : repo.content.files?.join(', ');
      context += info?.substring(0, 1000) || 'Unknown';
    } else {
      context += 'Not scanned';
    }

    if (files.length > 0) {
      context += `\n\nLoaded files:\n${files.slice(0, 5).map(f => `- ${f.metadata?.path}`).join('\n')}`;
    }

    return context;
  }

  private estimateTokens(content: any): number {
    if (!content) return 0;
    
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    return Math.ceil(text.length / 4);
  }

  private pruneIfNeeded(): void {
    let totalTokens = this.context.reduce((sum, entry) => sum + entry.tokens, 0);

    while (totalTokens > this.maxTokens && this.context.length > 1) {
      const oldest = this.context[0];
      
      if (oldest.type === 'system') {
        break;
      }

      this.context.shift();
      totalTokens = this.context.reduce((sum, entry) => sum + entry.tokens, 0);
    }

    if (totalTokens > this.maxTokens) {
      const half = Math.floor(this.context.length / 2);
      this.context = this.context.slice(half);
    }
  }

  getTokenCount(): number {
    return this.context.reduce((sum, entry) => sum + entry.tokens, 0);
  }

  getContextByType(type: string): ContextEntry[] {
    return this.context.filter(c => c.type === type);
  }

  clear(type?: string): void {
    if (type) {
      this.context = this.context.filter(c => c.type !== type);
    } else {
      this.context = [];
    }
    
    log.info(`Cleared context${type ? `: ${type}` : ''}`);
  }

  getSummary(): {
    totalEntries: number;
    totalTokens: number;
    byType: Record<string, number>;
  } {
    const byType: Record<string, number> = {};
    
    for (const entry of this.context) {
      byType[entry.type] = (byType[entry.type] || 0) + 1;
    }

    return {
      totalEntries: this.context.length,
      totalTokens: this.getTokenCount(),
      byType,
    };
  }
}

export default ContextManager;