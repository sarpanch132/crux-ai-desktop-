import { EventEmitter } from 'events';
import axios, { AxiosInstance, CancelTokenSource } from 'axios';
import log from 'electron-log';
import { AgentConfig, ContextEntry } from '../types/index.js';

export interface StreamChunk {
  content: string;
  done: boolean;
  error?: string;
}

export class StreamingEngine extends EventEmitter {
  private config: AgentConfig;
  private httpClient: AxiosInstance;
  private activeStream: CancelTokenSource | null = null;

  constructor(config: AgentConfig) {
    super();
    this.config = config;
    this.httpClient = axios.create();
  }

  async *stream(prompt: string, context: ContextEntry[] = {}): AsyncGenerator<StreamChunk> {
    const cancelToken = axios.CancelToken.source();
    this.activeStream = cancelToken;

    const provider = this.config.aiProvider || 'openrouter';
    const apiKey = this.config.aiApiKey || process.env.AI_API_KEY || '';
    const model = this.config.aiModel || 'qwen/qwen3-coder-32b';
    const endpoint = this.getEndpoint(provider);

    const messages = this.buildMessages(prompt, context);

    log.debug(`Starting stream to ${provider}:${model}`);

    try {
      const response = await this.httpClient.post(
        endpoint,
        {
          model,
          messages,
          stream: true,
          temperature: 0.7,
          max_tokens: 4000,
        },
        {
          headers: this.buildHeaders(provider, apiKey),
          responseType: 'stream',
          cancelToken: cancelToken.token,
        }
      );

      const buffer: string[] = [];

      for await (const chunk of response.data) {
        if (this.activeStream?.cancelled) {
          yield { content: '', done: true, error: 'Cancelled' };
          return;
        }

        const lines = chunk.toString().split('\n').filter(line => line.startsWith('data: '));

        for (const line of lines) {
          const data = line.slice(6).trim();
          
          if (data === '[DONE]') {
            yield { content: '', done: true };
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;
            
            if (content) {
              buffer.push(content);
              yield { content };
            }
          } catch {
          }
        }
      }

      yield { content: '', done: true };
    } catch (error) {
      if (axios.isCancel(error)) {
        log.info('Stream canceled');
        yield { content: '', done: true, error: 'Cancelled' };
        return;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error('Stream error:', errorMessage);
      yield { content: '', done: true, error: errorMessage };
    } finally {
      this.activeStream = null;
    }
  }

  private buildHeaders(provider: string, apiKey: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    switch (provider) {
      case 'openrouter':
        headers['Authorization'] = `Bearer ${apiKey}`;
        headers['HTTP-Referer'] = 'https://ai-coder.app';
        break;
      case 'openai':
        headers['Authorization'] = `Bearer ${apiKey}`;
        break;
    }

    return headers;
  }

  private getEndpoint(provider: string): string {
    switch (provider) {
      case 'openrouter':
        return 'https://openrouter.ai/api/v1/chat/completions';
      case 'openai':
        return 'https://api.openai.com/v1/chat/completions';
      default:
        return 'https://openrouter.ai/api/v1/chat/completions';
    }
  }

  private buildMessages(prompt: string, context: ContextEntry[]): { role: string; content: string }[] {
    const messages: { role: string; content: string }[] = [
      {
        role: 'system',
        content: 'You are an expert AI coding assistant. Respond naturally.',
      },
    ];

    for (const entry of context.slice(0, 5)) {
      const content = typeof entry.content === 'string' 
        ? entry.content 
        : JSON.stringify(entry.content);

      messages.push({
        role: entry.type === 'request' ? 'user' : 'system',
        content: content.substring(0, 10000),
      });
    }

    messages.push({ role: 'user', content: prompt });

    return messages;
  }

  async streamJSON<T>(
    prompt: string,
    context: ContextEntry[] = {}
  ): Promise<AsyncGenerator<T>> {
    let buffer = '';
    
    for await (const chunk of this.stream(prompt, context)) {
      if (chunk.error) {
        throw new Error(chunk.error);
      }
      
      if (!chunk.done && chunk.content) {
        buffer += chunk.content;
        try {
          const parsed = JSON.parse(buffer);
          yield parsed;
          buffer = '';
        } catch {
        }
      }
    }
  }

  abort(): void {
    if (this.activeStream) {
      this.activeStream.cancel();
      this.activeStream = null;
      log.info('Stream aborted');
    }
  }

  isStreaming(): boolean {
    return this.activeStream !== null;
  }
}

export default StreamingEngine;