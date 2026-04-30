import { EventEmitter } from 'events';
import log from 'electron-log';
import {
  Ollama,
  Message,
  ChatOptions,
  EmbeddingsOptions,
  PullOptions,
} from 'ollama';

export interface OllamaConfig {
  baseURL: string;
  model: string;
  embeddingModel?: string;
  temperature?: number;
  numCtx?: number;
  numGPU?: number;
  numThread?: number;
  f16?: boolean;
  verbose?: boolean;
}

export interface GenerateRequest {
  model?: string;
  prompt: string;
  system?: string;
  template?: string;
  images?: string[];
  options?: {
    temperature?: number;
    top_p?: number;
    top_k?: number;
    num_predict?: number;
    stop?: string[];
    num_ctx?: number;
  };
}

export interface GenerateResponse {
  model: string;
  response: string;
  done: boolean;
  context?: number[];
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
  eval_duration?: number;
}

export class LocalModelService extends EventEmitter {
  private client: Ollama | null = null;
  private config: OllamaConfig;
  private isInitialized: boolean = false;
  private availableModels: string[] = [];
  private currentGeneration: string = '';

  constructor(config: Partial<OllamaConfig> = {}) {
    super();
    this.config = {
      baseURL: config.baseURL ?? 'http://localhost:11434',
      model: config.model ?? 'llama3',
      embeddingModel: config.embeddingModel ?? 'nomic-embed-text',
      temperature: config.temperature ?? 0.7,
      numCtx: config.numCtx ?? 4096,
      numGPU: config.numGPU ?? 1,
      numThread: config.numThread ?? 4,
      f16: config.f16 ?? true,
      verbose: config.verbose ?? false,
    };
  }

  async initialize(): Promise<boolean> {
    if (this.isInitialized) return true;

    try {
      this.client = new Ollama({
        host: this.config.baseURL,
      });

      const isRunning = await this.checkConnection();
      if (!isRunning) {
        log.warn('Ollama not running');
        return false;
      }

      await this.listModels();
      this.isInitialized = true;
      
      log.info(`Local model service initialized with ${this.availableModels.length} models`);
      return true;
    } catch (error) {
      log.error('Ollama initialization failed:', error);
      return false;
    }
  }

  async checkConnection(): Promise<boolean> {
    if (!this.client) return false;
    try {
      await this.client.list();
      return true;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    if (!this.client) await this.initialize();
    if (!this.client) return [];

    try {
      const response = await this.client.list();
      this.availableModels = response.models.map(m => m.name);
      return this.availableModels;
    } catch (error) {
      log.error('Failed to list models:', error);
      return [];
    }
  }

  async pullModel(model: string, onProgress?: (progress: number) => void): Promise<boolean> {
    if (!this.client) return false;

    try {
      const stream = await this.client.pull({ model, stream: true });
      
      for await (const chunk of stream) {
        if (onProgress) {
          const progress = chunk.status === 'success' ? 100 : 50;
          onProgress(progress);
        }
        this.emit('progress', chunk);
      }

      await this.listModels();
      return true;
    } catch (error) {
      log.error('Failed to pull model:', error);
      return false;
    }
  }

  async deleteModel(model: string): Promise<boolean> {
    if (!this.client) return false;

    try {
      await this.client.delete({ model });
      await this.listModels();
      return true;
    } catch (error) {
      log.error('Failed to delete model:', error);
      return false;
    }
  }

  async chat(
    messages: Message[],
    options?: Partial<ChatOptions>
  ): Promise<{ message: Message; done: boolean }> {
    if (!this.client) await this.initialize();
    if (!this.client) throw new Error('Ollama not initialized');

    const chatOptions: ChatOptions = {
      model: this.config.model,
      messages,
      stream: false,
      options: {
        temperature: options?.options?.temperature ?? this.config.temperature,
        num_ctx: options?.options?.num_ctx ?? this.config.numCtx,
        top_p: options?.options?.top_p,
        top_k: options?.options?.top_k,
      },
    };

    const response = await this.client.chat(chatOptions);
    return response;
  }

  async *streamChat(
    messages: Message[],
    options?: Partial<ChatOptions>
  ): AsyncGenerator<string> {
    if (!this.client) await this.initialize();
    if (!this.client) throw new Error('Ollama not initialized');

    const chatOptions: ChatOptions = {
      model: this.config.model,
      messages,
      stream: true,
      options: {
        temperature: options?.options?.temperature ?? this.config.temperature,
        num_ctx: options?.options?.num_ctx ?? this.config.numCtx,
        top_p: options?.options?.top_p,
        top_k: options?.options?.top_k,
      },
    };

    const stream = await this.client.chat(chatOptions);
    
    for await (const chunk of stream) {
      if (chunk.message?.content) {
        this.currentGeneration += chunk.message.content;
        yield chunk.message.content;
      }
      
      if (chunk.done) {
        this.emit('generationComplete', { model: chunk.model, response: this.currentGeneration });
        this.currentGeneration = '';
      }
    }
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    if (!this.client) await this.initialize();
    if (!this.client) throw new Error('Ollama not initialized');

    const response = await this.client.generate({
      model: request.model ?? this.config.model,
      prompt: request.prompt,
      system: request.system,
      template: request.template,
      images: request.images,
      stream: false,
      options: request.options,
    });

    return response;
  }

  async *streamGenerate(request: GenerateRequest): AsyncGenerator<string> {
    if (!this.client) await this.initialize();
    if (!this.client) throw new Error('Ollama not initialized');

    const stream = await this.client.generate({
      model: request.model ?? this.config.model,
      prompt: request.prompt,
      system: request.system,
      template: request.template,
      images: request.images,
      stream: true,
      options: request.options,
    });

    for await (const chunk of stream) {
      if (chunk.response) {
        this.currentGeneration += chunk.response;
        yield chunk.response;
      }
      
      if (chunk.done) {
        this.emit('generationComplete', { model: chunk.model });
        this.currentGeneration = '';
      }
    }
  }

  async getEmbedding(text: string, model?: string): Promise<number[]> {
    if (!this.client) await this.initialize();
    if (!this.client) throw new Error('Ollama not initialized');

    const response = await this.client.embeddings({
      model: model ?? this.config.embeddingModel ?? 'nomic-embed-text',
      prompt: text,
    });

    return response.embedding;
  }

  async getBatchEmbeddings(texts: string[], model?: string): Promise<number[][]> {
    const embeddings: number[][] = [];
    
    for (const text of texts) {
      const embedding = await this.getEmbedding(text, model);
      embeddings.push(embedding);
    }

    return embeddings;
  }

  async createModel(name: string, modelfile: string): Promise<boolean> {
    if (!this.client) return false;

    try {
      await this.client.create({ model: name, modelfile });
      await this.listModels();
      return true;
    } catch (error) {
      log.error('Failed to create model:', error);
      return false;
    }
  }

  async copyModel(source: string, destination: string): Promise<boolean> {
    if (!this.client) return false;

    try {
      await this.client.copy({ source, destination });
      await this.listModels();
      return true;
    } catch (error) {
      log.error('Failed to copy model:', error);
      return false;
    }
  }

  async getModelInfo(model: string): Promise<any> {
    if (!this.client) await this.initialize();
    if (!this.client) return null;

    try {
      const info = await this.client.show({ model });
      return info;
    } catch (error) {
      log.error('Failed to get model info:', error);
      return null;
    }
  }

  setModel(model: string): void {
    this.config.model = model;
    log.info(`Model set to: ${model}`);
  }

  setEmbeddingModel(model: string): void {
    this.config.embeddingModel = model;
    log.info(`Embedding model set to: ${model}`);
  }

  getAvailableModels(): string[] {
    return [...this.availableModels];
  }

  getCurrentModel(): string {
    return this.config.model;
  }

  getStatus(): {
    initialized: boolean;
    model: string;
    availableModels: number;
    connection: boolean;
  } {
    return {
      initialized: this.isInitialized,
      model: this.config.model,
      availableModels: this.availableModels.length,
      connection: this.isInitialized,
    };
  }
}

export const createLocalModelService = (config?: Partial<OllamaConfig>): LocalModelService => {
  return new LocalModelService(config);
};

export default LocalModelService;