import { EventEmitter } from 'events';
import axios, { AxiosInstance, CancelTokenSource } from 'axios';
import log from 'electron-log';

export interface ModelConfig {
  provider: string;
  apiKey: string;
  model: string;
  endpoint?: string;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  name?: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  stream?: boolean;
  timeout?: number;
  retryConfig?: RetryConfig;
}

export interface RetryConfig {
  maxRetries: number;
  backoffMs: number;
  retryableStatuses: number[];
}

export interface ModelMetrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageLatency: number;
  retries: number;
}

export class HardenedModelRouter extends EventEmitter {
  private primaryModel: ModelConfig;
  private fallbackModels: ModelConfig[];
  private httpClient: AxiosInstance;
  private cancelToken: CancelTokenSource | null = null;
  private metrics: ModelMetrics = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    averageLatency: 0,
    retries: 0,
  };
  private lastLatency: number[] = [];

  constructor(primary: ModelConfig, fallbacks: ModelConfig[] = []) {
    super();
    this.primaryModel = primary;
    this.fallbackModels = fallbacks;

    this.httpClient = axios.create({
      timeout: primary.timeout || 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    this.setupInterceptors();
  }

  private setupInterceptors(): void {
    this.httpClient.interceptors.response.use(
      (response) => response,
      async (error) => {
        if (error.response?.status === 429) {
          log.warn('Rate limited, attempting fallback');
          this.metrics.failedRequests++;
          throw error;
        }
        throw error;
      }
    );
  }

  async route(
    prompt: string,
    options: ChatOptions = {},
    attempt: number = 0
  ): Promise<string> {
    this.cancelToken = axios.CancelToken.source();
    this.metrics.totalRequests++;

    const models = [this.primaryModel, ...this.fallbackModels];
    const currentModel = models[Math.min(attempt, models.length - 1)];

    if (!currentModel) {
      throw new Error('All models exhausted');
    }

    log.info(`Routing to ${currentModel.provider}:${currentModel.model} (attempt ${attempt + 1})`);

    const startTime = Date.now();

    try {
      const response = await this.callAPIWithRetry(currentModel, prompt, options);

      const latency = Date.now() - startTime;
      this.recordLatency(latency);

      this.metrics.successfulRequests++;
      this.emit('request:success', { model: currentModel.model, latency });

      return response;
    } catch (error) {
      this.metrics.failedRequests++;
      this.emit('request:failed', { model: currentModel.model, error });

      if (attempt < models.length - 1) {
        this.metrics.retries++;
        log.warn(`Failed attempt ${attempt + 1}, trying fallback`);

        await this.sleep(Math.min(1000 * Math.pow(2, attempt), 10000));

        return this.route(prompt, options, attempt + 1);
      }

      throw error;
    } finally {
      this.cancelToken = null;
    }
  }

  private async callAPIWithRetry(
    model: ModelConfig,
    prompt: string,
    options: ChatOptions,
    retryCount: number = 0
  ): Promise<string> {
    const maxRetries = options.retryConfig?.maxRetries ?? 2;
    const retryableStatuses = options.retryData?.retryableStatuses ?? [429, 500, 502, 503];

    try {
      return await this.callAPI(model, prompt, options);
    } catch (error: any) {
      if (retryCount >= maxRetries) {
        throw error;
      }

      const status = error.response?.status;
      if (!status || !retryableStatuses.includes(status)) {
        throw error;
      }

      log.warn(`Retryable error (status ${status}), attempt ${retryCount + 1}/${maxRetries}`);

      await this.sleep(options.retryConfig?.backoffMs * Math.pow(2, retryCount) || 1000);

      return this.callAPIWithRetry(model, prompt, options, retryCount + 1);
    }
  }

  private async callAPI(model: ModelConfig, prompt: string, options: ChatOptions): Promise<string> {
    const messages = this.buildMessages(prompt, options.systemPrompt);

    const headers = this.buildHeaders(model);
    const body = this.buildBody(model, messages, options);

    const response = await this.httpClient.post(model.endpoint!, body, {
      headers,
      timeout: options.timeout || model.timeout || 30000,
      cancelToken: this.cancelToken?.token,
    });

    return this.parseResponse(response);
  }

  private buildMessages(prompt: string, systemPrompt?: string): ChatMessage[] {
    const messages: ChatMessage[] = [];

    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    } else {
      messages.push({
        role: 'system',
        content: 'You are an expert AI coding assistant. Always verify your outputs are correct.',
      });
    }

    messages.push({ role: 'user', content: prompt });

    return messages;
  }

  private buildHeaders(model: ModelConfig): Record<string, string> {
    if (model.provider === 'openai' || model.provider === 'deepseek') {
      return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${model.apiKey}`,
      };
    }

    if (model.provider === 'anthropic') {
      return {
        'Content-Type': 'application/json',
        'x-api-key': model.apiKey,
        'anthropic-version': '2023-06-01',
      };
    }

    if (model.provider === 'openrouter') {
      return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${model.apiKey}`,
        'HTTP-Referer': 'https://opencode.ai',
        'X-Title': 'OpenCode',
      };
    }

    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${model.apiKey}`,
    };
  }

  private buildBody(model: ModelConfig, messages: ChatMessage[], options: ChatOptions): any {
    const baseBody = {
      model: model.model,
      messages,
      temperature: options.temperature ?? model.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? model.maxTokens ?? 4000,
    };

    if (model.provider === 'anthropic') {
      return {
        model: model.model,
        messages: messages.map(m => ({
          role: m.role === 'system' ? 'developer' : m.role,
          content: m.content,
        })),
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? 4096,
      };
    }

    return baseBody;
  }

  private parseResponse(response: any): string {
    try {
      if (response.data?.choices?.[0]?.message?.content) {
        return response.data.choices[0].message.content;
      }

      if (response.data?.content) {
        return response.data.content;
      }

      if (response.data?.text) {
        return response.data.text;
      }

      log.warn('Unexpected response format:', response.data);
      return String(response.data);
    } catch (error) {
      log.error('Failed to parse response:', error);
      return '';
    }
  }

  private recordLatency(latency: number): void {
    this.lastLatency.push(latency);
    if (this.lastLatency.length > 100) {
      this.lastLatency.shift();
    }

    if (this.lastLatency.length > 0) {
      this.metrics.averageLatency =
        this.lastLatency.reduce((a, b) => a + b, 0) / this.lastLatency.length;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  cancel(): void {
    if (this.cancelToken) {
      this.cancelToken.cancel('Request canceled by user');
      this.cancelToken = null;
    }
  }

  getMetrics(): ModelMetrics {
    return { ...this.metrics };
  }

  getLatencyStats(): { p50: number; p95: number; p99: number } {
    const sorted = [...this.lastLatency].sort((a, b) => a - b);
    return {
      p50: sorted[Math.floor(sorted.length * 0.5)] || 0,
      p95: sorted[Math.floor(sorted.length * 0.95)] || 0,
      p99: sorted[Math.floor(sorted.length * 0.99)] || 0,
    };
  }
}

export default HardenedModelRouter;