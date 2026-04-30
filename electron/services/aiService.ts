import axios, { AxiosError, AxiosInstance } from 'axios';
import Store from 'electron-store';
import log from 'electron-log';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type AIProvider = 'ollama' | 'openrouter' | 'openai' | 'anthropic' | 'custom';

export interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AIOptions {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface AISettings {
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

export interface ModelInfo {
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

export interface ProviderHealth {
  provider: AIProvider;
  status: 'online' | 'degraded' | 'offline';
  message: string;
  latencyMs?: number;
}

const DEFAULT_SETTINGS: AISettings = {
  provider: 'ollama',
  model: 'qwen2.5-coder:3b',
  temperature: 0.2,
  maxTokens: 4096,
  ollamaUrl: 'http://127.0.0.1:11434',
  openaiBaseUrl: 'https://api.openai.com/v1',
  customEndpoint: 'http://127.0.0.1:11434/v1',
  apiKey: '',
  autonomyLevel: 'guarded',
  toolPermissions: 'safe-only',
  performanceMode: 'balanced',
};

export class AIService {
  private readonly store: Store<any>;
  private readonly httpClient: AxiosInstance;
  private readonly activeRequests = new Map<string, AbortController>();
  private readonly modelPreparation = new Map<string, Promise<void>>();

  constructor(store: Store<any>) {
    this.store = store;
    this.httpClient = axios.create({
      timeout: 120_000,
      headers: {
        'Content-Type': 'application/json',
      },
      validateStatus: () => true,
    });
  }

  getSettings(): AISettings {
    const stored = (this.store.get('ai.settings') ?? {}) as Partial<AISettings>;
    return { ...DEFAULT_SETTINGS, ...stored };
  }

  updateSettings(nextSettings: Partial<AISettings>): AISettings {
    const merged = { ...this.getSettings(), ...nextSettings };
    this.store.set('ai.settings', merged);
    return merged;
  }

  async getModels(): Promise<ModelInfo[]> {
    const settings = this.getSettings();
    const models: ModelInfo[] = [];

    try {
      const ollamaModels = await this.fetchOllamaModels(settings.ollamaUrl);
      models.push(...ollamaModels);
    } catch (error) {
      log.warn('Failed to fetch Ollama models:', error);
    }

    const configuredModel = settings.model?.trim();
    if (configuredModel && !models.some((model) => model.id === configuredModel)) {
      models.unshift({
        id: configuredModel,
        name: configuredModel,
        provider: settings.provider,
        status: settings.provider === 'ollama' ? 'offline' : 'ready',
        healthy: settings.provider !== 'ollama',
        ramUsage: settings.performanceMode === 'quality' ? 'High' : 'Balanced',
        details: settings.provider === 'ollama'
          ? 'Configured model is not currently available from Ollama.'
          : 'Configured remote model.',
      });
    }

    if (models.length === 0) {
      models.push({
        id: configuredModel || DEFAULT_SETTINGS.model,
        name: configuredModel || DEFAULT_SETTINGS.model,
        provider: settings.provider,
        status: 'offline',
        healthy: false,
        ramUsage: 'Unknown',
        details: 'No local or configured models are currently available.',
      });
    }

    return models;
  }

  async getHealth(): Promise<ProviderHealth[]> {
    const settings = this.getSettings();
    const providers: AIProvider[] = ['ollama', 'openrouter', 'openai', 'anthropic', 'custom'];
    const healthChecks = providers.map(async (provider) => this.checkProviderHealth(provider, settings));
    return Promise.all(healthChecks);
  }

  async chat(messages: AIMessage[], options?: AIOptions): Promise<string> {
    const requestId = `chat:${Date.now()}`;
    const controller = new AbortController();
    this.activeRequests.set(requestId, controller);

    try {
      return await this.executeWithRetry(() =>
        this.performChat(messages, options, controller.signal, requestId)
      );
    } finally {
      this.activeRequests.delete(requestId);
    }
  }

  async *stream(messages: AIMessage[], options?: AIOptions): AsyncGenerator<string> {
    const fullResponse = await this.chat(messages, options);
    const tokens = this.chunkResponse(fullResponse);

    for (const token of tokens) {
      if (!token) {
        continue;
      }
      yield token;
      await new Promise((resolve) => setTimeout(resolve, 14));
    }
  }

  abortStream(): void {
    for (const controller of this.activeRequests.values()) {
      controller.abort();
    }
    this.activeRequests.clear();
  }

  private async performChat(
    messages: AIMessage[],
    options: AIOptions | undefined,
    signal: AbortSignal,
    requestId: string,
  ): Promise<string> {
    const settings = this.getSettings();
    const effectiveTimeout = options?.timeoutMs ?? 120_000;
    const timeout = setTimeout(() => {
      if (!signal.aborted) {
        log.warn(`AI request timed out after ${effectiveTimeout}ms`, requestId);
      }
    }, effectiveTimeout);

    try {
      switch (settings.provider) {
        case 'ollama':
          return await this.chatWithOllama(messages, settings, options, signal);
        case 'anthropic':
          return await this.chatWithAnthropic(messages, settings, options, signal);
        case 'openrouter':
        case 'openai':
        case 'custom':
          return await this.chatWithOpenAICompatible(messages, settings, options, signal);
        default:
          throw new Error(`Unsupported provider: ${String(settings.provider)}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private async chatWithOllama(
    messages: AIMessage[],
    settings: AISettings,
    options: AIOptions | undefined,
    signal: AbortSignal,
  ): Promise<string> {
    await this.ensureOllamaModelReady(settings);
    let response = await this.requestOllamaChat(settings, settings.model, messages, options, signal);

    if (response.status >= 400) {
      const providerError = this.extractProviderError(response.data, 'Ollama request failed');
      if (this.shouldFallbackFromQwen7B(settings.model, providerError)) {
        const fallbackModel = 'qwen2.5-coder:3b';
        await this.ensureOllamaModelReady({ ...settings, model: fallbackModel });
        this.updateSettings({ model: fallbackModel });
        response = await this.requestOllamaChat(settings, fallbackModel, messages, options, signal);
      }
    }

    if (response.status >= 400) {
      throw new Error(this.extractProviderError(response.data, 'Ollama request failed'));
    }

    const content = response.data?.message?.content;
    if (!content) {
      throw new Error('Ollama returned an empty response.');
    }

    return content;
  }

  private requestOllamaChat(
    settings: AISettings,
    modelId: string,
    messages: AIMessage[],
    options: AIOptions | undefined,
    signal: AbortSignal,
  ) {
    const endpoint = `${this.normalizeBaseUrl(settings.ollamaUrl)}/api/chat`;
    return this.httpClient.post(
      endpoint,
      {
        model: modelId,
        messages,
        stream: false,
        options: {
          temperature: options?.temperature ?? settings.temperature,
          num_predict: options?.maxTokens ?? settings.maxTokens,
        },
      },
      { signal, timeout: options?.timeoutMs ?? 120_000 },
    );
  }

  private shouldFallbackFromQwen7B(modelId: string, providerError: string): boolean {
    const normalizedError = providerError.toLowerCase();
    return modelId === 'qwen2.5-coder:7b' && normalizedError.includes('requires more system memory');
  }

  private async chatWithOpenAICompatible(
    messages: AIMessage[],
    settings: AISettings,
    options: AIOptions | undefined,
    signal: AbortSignal,
  ): Promise<string> {
    if (!settings.apiKey && settings.provider !== 'custom') {
      throw new Error(`No API key configured for ${settings.provider}. Update it in Settings.`);
    }

    const endpoint = this.getOpenAICompatibleEndpoint(settings);
    const headers: Record<string, string> = {
      Authorization: settings.apiKey ? `Bearer ${settings.apiKey}` : '',
    };

    if (settings.provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://crux.app';
      headers['X-Title'] = 'CruX';
    }

    const response = await this.httpClient.post(
      endpoint,
      {
        model: settings.model,
        messages,
        temperature: options?.temperature ?? settings.temperature,
        max_tokens: options?.maxTokens ?? settings.maxTokens,
        stream: false,
      },
      {
        signal,
        timeout: options?.timeoutMs ?? 120_000,
        headers,
      },
    );

    if (response.status >= 400) {
      throw new Error(this.extractProviderError(response.data, 'Provider returned error'));
    }

    const content = response.data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('Provider returned an empty response.');
    }

    return content;
  }

  private async chatWithAnthropic(
    messages: AIMessage[],
    settings: AISettings,
    options: AIOptions | undefined,
    signal: AbortSignal,
  ): Promise<string> {
    if (!settings.apiKey) {
      throw new Error('No API key configured for Anthropic. Update it in Settings.');
    }

    const systemMessage = messages.find((message) => message.role === 'system')?.content;
    const anthropicMessages = messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role,
        content: message.content,
      }));

    const response = await this.httpClient.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: settings.model,
        system: systemMessage,
        max_tokens: options?.maxTokens ?? settings.maxTokens,
        temperature: options?.temperature ?? settings.temperature,
        messages: anthropicMessages,
      },
      {
        signal,
        timeout: options?.timeoutMs ?? 120_000,
        headers: {
          'x-api-key': settings.apiKey,
          'anthropic-version': '2023-06-01',
        },
      },
    );

    if (response.status >= 400) {
      throw new Error(this.extractProviderError(response.data, 'Anthropic returned error'));
    }

    const content = response.data?.content?.[0]?.text;
    if (!content) {
      throw new Error('Anthropic returned an empty response.');
    }

    return content;
  }

  private async fetchOllamaModels(baseUrl: string): Promise<ModelInfo[]> {
    const endpoint = `${this.normalizeBaseUrl(baseUrl)}/api/tags`;
    const startedAt = Date.now();
    const response = await this.httpClient.get(endpoint, { timeout: 7_000 });
    const latency = Date.now() - startedAt;

    if (response.status >= 400) {
      throw new Error(this.extractProviderError(response.data, 'Unable to load Ollama models.'));
    }

    const rawModels = Array.isArray(response.data?.models) ? response.data.models : [];
    return rawModels.map((model: Record<string, unknown>) => ({
      id: String(model.name ?? model.model ?? 'unknown-model'),
      name: String(model.name ?? model.model ?? 'unknown-model'),
      provider: 'ollama' as const,
      status: 'ready' as const,
      healthy: true,
      size: typeof model.size === 'number' ? model.size : undefined,
      modifiedAt: typeof model.modified_at === 'string' ? model.modified_at : undefined,
      ramUsage: this.describeModelFootprint(typeof model.size === 'number' ? model.size : undefined),
      details: `Detected from Ollama in ${latency}ms`,
    }));
  }

  private async checkProviderHealth(provider: AIProvider, settings: AISettings): Promise<ProviderHealth> {
    const startedAt = Date.now();

    try {
      if (provider === 'ollama') {
        const runtime = await this.getOllamaRuntimeStatus(settings.ollamaUrl);
        return {
          provider,
          status: runtime.running ? 'online' : runtime.installed ? 'degraded' : 'offline',
          message: runtime.message,
          latencyMs: runtime.latencyMs ?? (Date.now() - startedAt),
        };
      }

      if (provider === settings.provider) {
        if (provider === 'openai' || provider === 'openrouter' || provider === 'anthropic') {
          return {
            provider,
            status: settings.apiKey ? 'online' : 'degraded',
            message: settings.apiKey ? 'Configured and ready.' : 'API key is missing.',
          };
        }

        if (provider === 'custom') {
          return {
            provider,
            status: settings.customEndpoint ? 'online' : 'degraded',
            message: settings.customEndpoint ? 'Custom endpoint configured.' : 'Custom endpoint missing.',
          };
        }
      }

      return {
        provider,
        status: 'degraded',
        message: provider === settings.provider ? 'Selected provider needs more configuration.' : 'Inactive provider.',
      };
    } catch (error) {
      return {
        provider,
        status: 'offline',
        message: this.describeError(error),
      };
    }
  }

  private getOpenAICompatibleEndpoint(settings: AISettings): string {
    if (settings.provider === 'openrouter') {
      return 'https://openrouter.ai/api/v1/chat/completions';
    }

    const baseUrl = settings.provider === 'custom'
      ? settings.customEndpoint
      : settings.openaiBaseUrl;

    const normalized = this.normalizeBaseUrl(baseUrl);
    return normalized.endsWith('/chat/completions')
      ? normalized
      : `${normalized}/chat/completions`;
  }

  private normalizeBaseUrl(url: string): string {
    return url.replace(/\/+$/, '');
  }

  private describeModelFootprint(size?: number): string {
    if (!size) {
      return 'Unknown';
    }

    const sizeInGb = size / (1024 * 1024 * 1024);
    if (sizeInGb >= 12) {
      return 'Very high';
    }
    if (sizeInGb >= 7) {
      return 'High';
    }
    if (sizeInGb >= 3) {
      return 'Medium';
    }
    return 'Light';
  }

  private async ensureOllamaModelReady(settings: AISettings): Promise<void> {
    const modelId = settings.model?.trim() || DEFAULT_SETTINGS.model;
    const baseUrl = this.normalizeBaseUrl(settings.ollamaUrl);
    const key = `${baseUrl}|${modelId}`;

    const existing = this.modelPreparation.get(key);
    if (existing) {
      await existing;
      return;
    }

    const task = this.prepareOllamaModel(baseUrl, modelId)
      .finally(() => {
        this.modelPreparation.delete(key);
      });

    this.modelPreparation.set(key, task);
    await task;
  }

  private async prepareOllamaModel(baseUrl: string, modelId: string): Promise<void> {
    const runtime = await this.getOllamaRuntimeStatus(baseUrl);
    if (!runtime.installed) {
      throw new Error('Ollama is not installed. Install Ollama and reopen CruX.');
    }

    if (!runtime.running) {
      throw new Error('Ollama is installed but not running. Start Ollama and retry.');
    }

    if (runtime.models.includes(modelId)) {
      return;
    }

    log.info(`Model "${modelId}" not found locally. Starting install via Ollama API.`);
    await this.installOllamaModel(baseUrl, modelId);

    const refreshed = await this.getOllamaRuntimeStatus(baseUrl);
    if (!refreshed.models.includes(modelId)) {
      throw new Error(`Model "${modelId}" is still unavailable after install. Check Ollama logs and retry.`);
    }
  }

  private async getOllamaRuntimeStatus(baseUrl: string): Promise<{
    installed: boolean;
    running: boolean;
    models: string[];
    message: string;
    latencyMs?: number;
  }> {
    const startedAt = Date.now();

    try {
      const models = await this.fetchOllamaModels(baseUrl);
      return {
        installed: true,
        running: true,
        models: models.map((model) => model.id),
        message: 'Local Ollama service is reachable.',
        latencyMs: Date.now() - startedAt,
      };
    } catch {
      const installed = await this.detectOllamaInstallation();
      return {
        installed,
        running: false,
        models: [],
        message: installed
          ? 'Ollama is installed but the service is not reachable.'
          : 'Ollama is not installed on this machine.',
      };
    }
  }

  private async detectOllamaInstallation(): Promise<boolean> {
    const candidates: string[] = ['ollama'];

    if (process.platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA;
      if (localAppData) {
        candidates.push(`${localAppData}\\Programs\\Ollama\\ollama.exe`);
      }
    }

    for (const candidate of candidates) {
      try {
        await execFileAsync(candidate, ['--version'], { windowsHide: true, timeout: 4_000 });
        return true;
      } catch {
        continue;
      }
    }

    return false;
  }

  private async installOllamaModel(baseUrl: string, modelId: string): Promise<void> {
    const endpoint = `${this.normalizeBaseUrl(baseUrl)}/api/pull`;
    const response = await this.httpClient.post(
      endpoint,
      {
        model: modelId,
        stream: false,
      },
      { timeout: 20 * 60_000 },
    );

    if (response.status >= 400) {
      throw new Error(this.extractProviderError(response.data, `Failed to install model "${modelId}".`));
    }

    const errorMessage = typeof response.data?.error === 'string' ? response.data.error : '';
    if (errorMessage) {
      throw new Error(errorMessage);
    }
  }

  private extractProviderError(data: unknown, fallback: string): string {
    if (typeof data === 'string' && data.trim()) {
      return data;
    }

    if (typeof data === 'object' && data !== null) {
      const record = data as Record<string, unknown>;
      const directMessage = record.error;
      if (typeof directMessage === 'string' && directMessage.trim()) {
        return directMessage;
      }

      const nestedMessage = (record.error as Record<string, unknown> | undefined)?.message;
      if (typeof nestedMessage === 'string' && nestedMessage.trim()) {
        return nestedMessage;
      }

      const message = record.message;
      if (typeof message === 'string' && message.trim()) {
        return message;
      }
    }

    return fallback;
  }

  private chunkResponse(content: string): string[] {
    return content
      .split(/(\s+)/)
      .filter((chunk) => chunk.length > 0);
  }

  private async executeWithRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (!this.isRetriable(error) || attempt === 2) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
      }
    }

    throw new Error(this.describeError(lastError));
  }

  private isRetriable(error: unknown): boolean {
    if (axios.isAxiosError(error)) {
      return !error.response || (error.response.status >= 500 && error.response.status < 600);
    }

    return false;
  }

  private describeError(error: unknown): string {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError<Record<string, unknown>>;
      if (axiosError.code === 'ECONNABORTED') {
        return 'The provider request timed out after 120 seconds.';
      }
      if (axiosError.code === 'ECONNREFUSED') {
        return 'Unable to connect to the selected provider. Check that the service is running.';
      }
      if (axiosError.code === 'ERR_CANCELED') {
        return 'The request was canceled.';
      }
      if (axiosError.response?.data) {
        return this.extractProviderError(axiosError.response.data, axiosError.message);
      }
      return axiosError.message;
    }

    if (error instanceof Error) {
      return error.message;
    }

    return 'An unknown provider error occurred.';
  }
}
