import { EventEmitter } from 'events';
import axios, { AxiosInstance, CancelTokenSource } from 'axios';
import log from 'electron-log';
import { AgentConfig } from '../types/index.js';

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

export class ModelRouter extends EventEmitter {
  private config: AgentConfig;
  private httpClient: AxiosInstance;
  private currentProvider: string;
  private cancelToken: CancelTokenSource | null = null;
  private models: Map<string, ModelConfig> = new Map();

  constructor(config: AgentConfig) {
    super();
    this.config = config;
    this.httpClient = axios.create();
    this.currentProvider = config.aiProvider || 'openrouter';
    this.initializeModels();
  }

  private initializeModels(): void {
    this.models.set('openrouter', {
      provider: 'openrouter',
      apiKey: this.config.aiApiKey || process.env.AI_API_KEY || '',
      model: this.config.aiModel || 'qwen/qwen3-coder-32b',
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      temperature: 0.7,
      maxTokens: 4000,
    });

    this.models.set('anthropic', {
      provider: 'anthropic',
      apiKey: this.config.aiApiKey || process.env.AI_API_KEY || '',
      model: 'claude-3-5-sonnet-20241022',
      endpoint: 'https://api.anthropic.com/v1/messages',
      temperature: 0.7,
      maxTokens: 4000,
    });

    this.models.set('openai', {
      provider: 'openai',
      apiKey: this.config.aiApiKey || process.env.AI_API_KEY || '',
      model: 'gpt-4',
      endpoint: 'https://api.openai.com/v1/chat/completions',
      temperature: 0.7,
      maxTokens: 4000,
    });

    this.models.set('deepseek', {
      provider: 'custom',
      apiKey: this.config.aiApiKey || process.env.AI_API_KEY || '',
      model: 'deepseek-coder-v3',
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      temperature: 0.7,
      maxTokens: 4000,
    });
  }

  async route(prompt: string, options: ChatOptions = {}): Promise<string> {
    this.cancelToken = axios.CancelToken.source();

    const provider = this.currentProvider;
    const model = this.models.get(provider);

    if (!model) {
      throw new Error(`Unknown provider: ${provider}`);
    }

    if (!model.apiKey) {
      throw new Error(`API key not configured for ${provider}`);
    }

    log.debug(`Routing to ${provider}:${model.model}`);

    try {
      const messages: ChatMessage[] = [];
      
      if (options.systemPrompt) {
        messages.push({ role: 'system', content: options.systemPrompt });
      } else {
        messages.push({ 
          role: 'system', 
          content: 'You are an expert AI coding assistant.' 
        });
      }
      
      messages.push({ role: 'user', content: prompt });

      const response = await this.callAPI(model, messages, {
        temperature: options.temperature || model.temperature,
        maxTokens: options.maxTokens || model.maxTokens,
      });

      this.emit('response:received', response);
      return response;
    } catch (error) {
      if (axios.isCancel(error)) {
        log.info('Request canceled');
        return '';
      }
      
      log.error('Model routing error:', error);
      throw error;
    } finally {
      this.cancelToken = null;
    }
  }

  async routeBatch(prompts: string[], options: ChatOptions = {}): Promise<string[]> {
    const results: string[] = [];
    
    for (const prompt of prompts) {
      try {
        const response = await this.route(prompt, options);
        results.push(response);
      } catch (error) {
        log.error(`Batch error for prompt: ${prompt}`, error);
        results.push('');
      }
    }

    return results;
  }

  private async callAPI(model: ModelConfig, messages: ChatMessage[], options: ChatOptions): Promise<string> {
    const headers = this.buildHeaders(model);
    const body = this.buildBody(model, messages, options);

    const response = await this.httpClient.post(model.endpoint!, body, {
      headers,
      cancelToken: this.cancelToken?.token,
      timeout: 120000,
    });

    return this.parseResponse(model.provider, response.data);
  }

  private buildHeaders(model: ModelConfig): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    switch (model.provider) {
      case 'openrouter':
        headers['Authorization'] = `Bearer ${model.apiKey}`;
        headers['HTTP-Referer'] = 'https://ai-coder.app';
        headers['HTTP-X-Title'] = 'AI Coder';
        break;
      case 'openai':
        headers['Authorization'] = `Bearer ${model.apiKey}`;
        break;
      case 'anthropic':
        headers['x-api-key'] = model.apiKey;
        headers['anthropic-version'] = '2023-06-01';
        break;
      case 'custom':
        headers['Authorization'] = `Bearer ${model.apiKey}`;
        break;
    }

    return headers;
  }

  private buildBody(model: ModelConfig, messages: ChatMessage[], options: ChatOptions): any {
    const body: any = {
      messages: messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 4000,
    };

    switch (model.provider) {
      case 'openrouter':
      case 'openai':
      case 'custom':
        body.model = model.model;
        break;
      case 'anthropic':
        body.model = model.model;
        body.system = messages.find(m => m.role === 'system')?.content;
        break;
    }

    return body;
  }

  private parseResponse(provider: string, data: any): string {
    switch (provider) {
      case 'anthropic':
        return data.content?.[0]?.text || '';
      case 'openrouter':
      case 'openai':
      case 'custom':
      default:
        return data.choices?.[0]?.message?.content || '';
    }
  }

  setProvider(provider: string): void {
    if (!this.models.has(provider)) {
      throw new Error(`Unknown provider: ${provider}`);
    }
    
    this.currentProvider = provider;
    log.info(`Provider set to: ${provider}`);
  }

  getProvider(): string {
    return this.currentProvider;
  }

  getAvailableModels(): string[] {
    return Array.from(this.models.keys());
  }

  setModel(provider: string, model: string): void {
    const config = this.models.get(provider);
    if (config) {
      config.model = model;
      log.info(`Model set to: ${provider}:${model}`);
    }
  }

  getModel(): string {
    return this.models.get(this.currentProvider)?.model || 'unknown';
  }

  abort(): void {
    if (this.cancelToken) {
      this.cancelToken.cancel();
      this.cancelToken = null;
      log.info('Request aborted');
    }
  }

  isAborted(): boolean {
    return this.cancelToken !== null;
  }

  async testConnection(): Promise<{ success: boolean; latency?: number; error?: string }> {
    const startTime = Date.now();
    
    try {
      await this.route('Respond with exactly "OK"', { maxTokens: 10 });
      const latency = Date.now() - startTime;
      
      return { success: true, latency };
    } catch (error) {
      return { 
        success: false, 
        error: error instanceof Error ? error.message : String(error) 
      };
    }
  }
}

export default ModelRouter;