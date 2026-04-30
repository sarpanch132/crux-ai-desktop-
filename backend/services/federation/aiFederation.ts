import { EventEmitter } from 'events';
import axios, { AxiosInstance } from 'axios';
import log from 'electron-log';

export interface ProviderConfig {
  name: string;
  type: 'openai' | 'anthropic' | 'google' | 'openrouter' | 'together' | 'groq' | 'ollama' | 'huggingface';
  apiKey: string;
  endpoint?: string;
  models: string[];
  capabilities: ('chat' | 'vision' | 'embedding' | 'code')[];
  pricing?: { input: number; output: number };
  latency?: number;
  reliability?: number;
}

export interface FederationRequest {
  prompt: string;
  image?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  taskType?: 'chat' | 'code' | 'vision' | 'embedding' | 'reasoning';
  providers?: string[];
  parallel?: boolean;
}

export interface FederationResponse {
  content: string;
  provider: string;
  model: string;
  confidence: number;
  latency: number;
  tokens: number;
  verified: boolean;
}

export interface ConsensusResult {
  content: string;
  provider: string;
  confidence: number;
  votes: number;
  agreements: number;
  disagreements: number;
}

export interface ProviderMetrics {
  name: string;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageLatency: number;
  reliability: number;
  lastUsed?: number;
}

export class AIFederation extends EventEmitter {
  private providers: Map<string, ProviderConfig> = new Map();
  private httpClient: AxiosInstance;
  private metrics: Map<string, ProviderMetrics> = new Map();
  private responseCache: Map<string, FederationResponse> = new Map();
  private cacheTimeout: number = 60000;
  private defaultProviders: string[] = [];

  constructor() {
    super();
    this.httpClient = axios.create({ timeout: 60000 });
  }

  registerProvider(config: ProviderConfig): void {
    this.providers.set(config.name, config);
    this.metrics.set(config.name, {
      name: config.name,
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      averageLatency: 0,
      reliability: config.reliability || 0.9,
    });

    if (!this.defaultProviders.includes(config.name)) {
      this.defaultProviders.push(config.name);
    }

    log.info(`Provider registered: ${config.name}`);
  }

  removeProvider(name: string): void {
    this.providers.delete(name);
    this.metrics.delete(name);
    this.defaultProviders = this.defaultProviders.filter(p => p !== name);
  }

  getProviders(): ProviderConfig[] {
    return Array.from(this.providers.values());
  }

  getProvider(name: string): ProviderConfig | undefined {
    return this.providers.get(name);
  }

  async route(request: FederationRequest): Promise<FederationResponse> {
    const providers = request.providers || this.defaultProviders;
    const taskType = request.taskType || 'chat';

    const suitableProviders = providers
      .map(name => this.providers.get(name))
      .filter(p => p && this.hasCapability(p, taskType))
      .sort((a, b) => this.getProviderScore(b) - this.getProviderScore(a));

    if (suitableProviders.length === 0) {
      throw new Error(`No suitable provider found for task type: ${taskType}`);
    }

    if (request.parallel && suitableProviders.length > 1) {
      return await this.executeParallel(request, suitableProviders);
    }

    return await this.executeSingle(request, suitableProviders[0]);
  }

  async executeParallel(request: FederationRequest, providers: ProviderConfig[]): Promise<FederationResponse> {
    const responses = await Promise.allSettled(
      providers.map(provider => this.executeSingle(request, provider))
    );

    const successful = responses.filter((r): r is PromiseFulfilledResult<FederationResponse> => 
      r.status === 'fulfilled'
    );

    if (successful.length === 0) {
      throw new Error('All providers failed');
    }

    const results = successful.map(r => r.value);

    const consensus = this.buildConsensus(results);

    this.emit('parallel:complete', { request, responses: results, consensus });

    return consensus;
  }

  async executeSingle(request: FederationRequest, provider: ProviderConfig): Promise<FederationResponse> {
    const cacheKey = this.getCacheKey(request, provider.name);
    const cached = this.responseCache.get(cacheKey);
    if (cached && Date.now() - (cached as any).timestamp < this.cacheTimeout) {
      return cached;
    }

    const startTime = Date.now();
    const metrics = this.metrics.get(provider.name);
    if (metrics) {
      metrics.totalRequests++;
    }

    try {
      let response: FederationResponse;

      switch (provider.type) {
        case 'openai':
        case 'openrouter':
          response = await this.callOpenAI(provider, request);
          break;
        case 'anthropic':
          response = await this.callAnthropic(provider, request);
          break;
        case 'google':
          response = await this.callGoogle(provider, request);
          break;
        case 'ollama':
          response = await this.callOllama(provider, request);
          break;
        case 'groq':
          response = await this.callGroq(provider, request);
          break;
        case 'together':
          response = await this.callTogether(provider, request);
          break;
        default:
          throw new Error(`Unknown provider type: ${provider.type}`);
      }

      response.latency = Date.now() - startTime;
      response.provider = provider.name;

      if (metrics) {
        metrics.successfulRequests++;
        metrics.averageLatency = (metrics.averageLatency * (metrics.totalRequests - 1) + response.latency) / metrics.totalRequests;
        metrics.lastUsed = Date.now();
      }

      response.timestamp = Date.now();
      this.responseCache.set(cacheKey, response);

      return response;
    } catch (error) {
      if (metrics) {
        metrics.failedRequests++;
      }

      this.emit('provider:error', { provider: provider.name, error });
      throw error;
    }
  }

  private async callOpenAI(provider: ProviderConfig, request: FederationRequest): Promise<FederationResponse> {
    const messages: any[] = [];

    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt });
    }

    if (request.image) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: request.prompt },
          { type: 'image_url', image_url: { url: request.image.startsWith('data:') ? request.image : `data:image/png;base64,${request.image}` } },
        ],
      });
    } else {
      messages.push({ role: 'user', content: request.prompt });
    }

    const response = await this.httpClient.post(
      provider.endpoint || 'https://api.openai.com/v1/chat/completions',
      {
        model: provider.models[0],
        messages,
        temperature: request.temperature || 0.7,
        max_tokens: request.maxTokens || 4096,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${provider.apiKey}`,
        },
      }
    );

    const content = response.data.choices[0]?.message?.content || '';

    return {
      content,
      provider: provider.name,
      model: provider.models[0],
      confidence: this.estimateConfidence(content),
      latency: 0,
      tokens: response.data.usage?.total_tokens || 0,
      verified: false,
    };
  }

  private async callAnthropic(provider: ProviderConfig, request: FederationRequest): Promise<FederationResponse> {
    const messages: any[] = [
      {
        role: 'user',
        content: request.image
          ? [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: request.image } },
              { type: 'text', text: request.prompt },
            ]
          : request.prompt,
      },
    ];

    const response = await this.httpClient.post(
      provider.endpoint || 'https://api.anthropic.com/v1/messages',
      {
        model: provider.models[0],
        messages,
        max_tokens: request.maxTokens || 4096,
        temperature: request.temperature || 0.7,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': provider.apiKey,
          'anthropic-version': '2023-06-01',
        },
      }
    );

    const content = response.data.content[0]?.text || '';

    return {
      content,
      provider: provider.name,
      model: provider.models[0],
      confidence: this.estimateConfidence(content),
      latency: 0,
      tokens: response.data.usage?.input_tokens + response.data.usage?.output_tokens || 0,
      verified: false,
    };
  }

  private async callGoogle(provider: ProviderConfig, request: FederationRequest): Promise<FederationResponse> {
    const response = await this.httpClient.post(
      provider.endpoint || `https://generativelanguage.googleapis.com/v1/models/${provider.models[0]}:generateContent`,
      {
        contents: [{
          parts: request.image
            ? [
                { text: request.prompt },
                { inlineData: { mimeType: 'image/png', data: request.image } },
              ]
            : [{ text: request.prompt }],
        }],
        generationConfig: {
          temperature: request.temperature || 0.7,
          maxOutputTokens: request.maxTokens || 4096,
        },
      },
      {
        params: { key: provider.apiKey },
      }
    );

    const content = response.data.candidates[0]?.content?.parts[0]?.text || '';

    return {
      content,
      provider: provider.name,
      model: provider.models[0],
      confidence: this.estimateConfidence(content),
      latency: 0,
      tokens: 0,
      verified: false,
    };
  }

  private async callOllama(provider: ProviderConfig, request: FederationRequest): Promise<FederationResponse> {
    const response = await this.httpClient.post(
      provider.endpoint || 'http://localhost:11434/api/generate',
      {
        model: provider.models[0],
        prompt: request.prompt,
        images: request.image ? [request.image] : undefined,
        stream: false,
      },
      { timeout: 120000 }
    );

    const content = response.data.response || '';

    return {
      content,
      provider: provider.name,
      model: provider.models[0],
      confidence: this.estimateConfidence(content),
      latency: 0,
      tokens: 0,
      verified: false,
    };
  }

  private async callGroq(provider: ProviderConfig, request: FederationRequest): Promise<FederationResponse> {
    const messages: any[] = [];
    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt });
    }
    messages.push({ role: 'user', content: request.prompt });

    const response = await this.httpClient.post(
      provider.endpoint || 'https://api.groq.com/openai/v1/chat/completions',
      {
        model: provider.models[0],
        messages,
        temperature: request.temperature || 0.7,
        max_tokens: request.maxTokens || 4096,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${provider.apiKey}`,
        },
      }
    );

    const content = response.data.choices[0]?.message?.content || '';

    return {
      content,
      provider: provider.name,
      model: provider.models[0],
      confidence: this.estimateConfidence(content),
      latency: 0,
      tokens: response.data.usage?.total_tokens || 0,
      verified: false,
    };
  }

  private async callTogether(provider: ProviderConfig, request: FederationRequest): Promise<FederationResponse> {
    const response = await this.httpClient.post(
      provider.endpoint || 'https://api.together.xyz/v1/chat/completions',
      {
        model: provider.models[0],
        messages: [
          ...(request.systemPrompt ? [{ role: 'system', content: request.systemPrompt }] : []),
          { role: 'user', content: request.prompt },
        ],
        temperature: request.temperature || 0.7,
        max_tokens: request.maxTokens || 4096,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${provider.apiKey}`,
        },
      }
    );

    const content = response.data.choices[0]?.message?.content || '';

    return {
      content,
      provider: provider.name,
      model: provider.models[0],
      confidence: this.estimateConfidence(content),
      latency: 0,
      tokens: response.data.usage?.total_tokens || 0,
      verified: false,
    };
  }

  private buildConsensus(responses: FederationResponse[]): FederationResponse {
    const byProvider: Record<string, FederationResponse[]> = {};
    for (const response of responses) {
      if (!byProvider[response.content]) {
        byProvider[response.content] = [];
      }
      byProvider[response.content].push(response);
    }

    let bestContent = '';
    let bestVotes = 0;
    let bestProvider = '';
    let bestConfidence = 0;

    for (const [content, providerResponses] of Object.entries(byProvider)) {
      if (providerResponses.length > bestVotes) {
        bestVotes = providerResponses.length;
        bestContent = content;
        bestProvider = providerResponses[0].provider;
        bestConfidence = providerResponses.reduce((sum, r) => sum + r.confidence, 0) / providerResponses.length;
      }
    }

    return {
      content: bestContent,
      provider: bestProvider,
      model: '',
      confidence: bestConfidence,
      latency: Math.min(...responses.map(r => r.latency)),
      tokens: Math.max(...responses.map(r => r.tokens)),
      verified: bestVotes > 1,
    };
  }

  private hasCapability(provider: ProviderConfig, taskType: string): boolean {
    const capabilityMap: Record<string, string> = {
      chat: 'chat',
      code: 'code',
      vision: 'vision',
      embedding: 'embedding',
      reasoning: 'chat',
    };

    return provider.capabilities.includes(capabilityMap[taskType] as any);
  }

  private getProviderScore(provider: ProviderConfig): number {
    const metrics = this.metrics.get(provider.name);
    if (!metrics) return 0.5;

    const latencyScore = Math.max(0, 1 - (metrics.averageLatency / 10000));
    const reliabilityScore = metrics.reliability || 0.9;

    return (latencyScore * 0.4 + reliabilityScore * 0.6);
  }

  private estimateConfidence(content: string): number {
    let confidence = 0.5;

    const uncertainPhrases = ['might', 'possibly', 'could be', 'unclear', ' uncertain', 'probably'];
    for (const phrase of uncertainPhrases) {
      if (content.toLowerCase().includes(phrase)) {
        confidence -= 0.1;
      }
    }

    const confidentPhrases = ['definitely', 'clearly', 'certain', 'always', 'never'];
    for (const phrase of confidentPhrases) {
      if (content.toLowerCase().includes(phrase)) {
        confidence += 0.1;
      }
    }

    if (content.length > 100) confidence += 0.1;
    if (content.includes('```')) confidence += 0.1;

    return Math.max(0, Math.min(1, confidence));
  }

  private getCacheKey(request: FederationRequest, provider: string): string {
    const data = `${provider}:${request.prompt.slice(0, 100)}:${request.image?.slice(0, 50)}`;
    return Buffer.from(data).toString('base64');
  }

  getMetrics(): Record<string, ProviderMetrics> {
    return Object.fromEntries(this.metrics);
  }

  clearCache(): void {
    this.responseCache.clear();
  }
}

export const aiFederation = new AIFederation();
export default AIFederation;