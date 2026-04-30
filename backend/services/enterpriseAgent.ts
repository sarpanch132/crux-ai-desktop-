import { EventEmitter } from 'events';
import log from 'electron-log';

import { CircuitBreakerRegistry } from './reliability/circuitBreaker.js';
import { RateLimiter, TokenBucket } from './reliability/rateLimiter.js';
import { ExecutionVerifier } from './reliability/executionVerifier.js';
import { RetryEngine, BudgetEnforcer } from './reliability/retryEngine.js';
import { AntiHallucinationValidator, ConfidenceScorer } from './reliability/antiHallucinationValidator.js';
import { ProcessSupervisor } from './reliability/processSupervisor.js';
import { HardenedModelRouter } from './models/hardenedModelRouter.js';
import { InputSanitizer, PromptInjectionShield } from './security/inputSanitizer.js';
import { DistributedTracing } from './observability/distributedTracing.js';
import { ImageProcessor } from './multimodal/imageProcessor.js';
import { MultimodalModelService } from './multimodal/multimodalModelService.js';
import { AIFederation } from './federation/aiFederation.js';

export interface EnterpriseConfig {
  aiProviders: any[];
  maxConcurrentTasks: number;
  rateLimitPerMinute: number;
  tokenBudget: number;
  enableTracing: boolean;
  enableFirebase: boolean;
}

export interface EnterpriseState {
  initialized: boolean;
  uptime: number;
  components: Record<string, any>;
  metrics: Record<string, any>;
}

export class EnterpriseAgent extends EventEmitter {
  private config: EnterpriseConfig;
  private state: EnterpriseState;
  private circuitBreakers: CircuitBreakerRegistry;
  private rateLimiter: RateLimiter;
  private tokenBucket: TokenBucket;
  private executionVerifier: ExecutionVerifier;
  private retryEngine: RetryEngine;
  private tokenBudget: BudgetEnforcer;
  private hallucinationValidator: AntiHallucinationValidator;
  private confidenceScorer: ConfidenceScorer;
  private processSupervisor: ProcessSupervisor;
  private inputSanitizer: InputSanitizer;
  private promptShield: PromptInjectionShield;
  private tracing: DistributedTracing;
  private imageProcessor: ImageProcessor;
  private multimodalService?: MultimodalModelService;
  private federation: AIFederation;
  private startTime: number;

  constructor(config: EnterpriseConfig) {
    super();
    this.config = config;
    this.startTime = Date.now();

    this.state = {
      initialized: false,
      uptime: 0,
      components: {},
      metrics: {},
    };

    this.circuitBreakers = new CircuitBreakerRegistry({
      failureThreshold: 5,
      successThreshold: 2,
      resetTimeout: 60000,
    });

    this.rateLimiter = new RateLimiter({
      maxRequests: config.rateLimitPerMinute || 100,
      windowMs: 60000,
      blockDurationMs: 300000,
    });

    this.tokenBucket = new TokenBucket(config.tokenBudget || 1000, 100);

    this.executionVerifier = new ExecutionVerifier({
      verifyFileExists: true,
      verifyFileContent: true,
      verifySyntax: true,
      verifyImports: true,
    });

    this.retryEngine = new RetryEngine({
      maxRetries: 3,
      initialDelayMs: 1000,
      maxDelayMs: 30000,
      backoffMultiplier: 2,
      jitter: true,
    });

    this.tokenBudget = new BudgetEnforcer(config.tokenBudget || 10000);
    this.hallucinationValidator = new AntiHallucinationValidator();
    this.confidenceScorer = new ConfidenceScorer();
    this.processSupervisor = new ProcessSupervisor({
      maxConcurrent: config.maxConcurrentTasks || 10,
    });

    this.inputSanitizer = new InputSanitizer({
      maxLength: 100000,
      blockPatterns: [],
      stripPatterns: [],
    });

    this.promptShield = new PromptInjectionShield(
      'You are an expert AI coding assistant. Always verify outputs.'
    );

    this.tracing = new DistributedTracing({
      serviceName: 'enterprise-agent',
      sampleRate: 1.0,
    });

    this.imageProcessor = new ImageProcessor();
    this.federation = new AIFederation();

    this.setupProviders();
  }

  private setupProviders(): void {
    for (const provider of this.config.aiProviders) {
      this.federation.registerProvider(provider);
    }
  }

  async initialize(): Promise<void> {
    log.info('Initializing Enterprise Agent...');

    await this.tracing.startRecording();

    this.state.initialized = true;
    this.state.components = {
      circuitBreakers: true,
      rateLimiter: true,
      executionVerifier: true,
      retryEngine: true,
      hallucinationValidator: true,
      processSupervisor: true,
      tracing: true,
      federation: true,
    };

    log.info('Enterprise Agent initialized');
    this.emit('ready');
  }

  async executeTask(request: {
    prompt: string;
    image?: string;
    verify?: boolean;
    taskType?: string;
  }): Promise<{
    result: string;
    confidence: number;
    verified: boolean;
    provider: string;
  }> {
    const traceId = this.tracing.createSpan('executeTask')?.context.spanId;

    try {
      this.rateLimiter.check('default');

      if (!this.tokenBucket.tryConsume(10)) {
        throw new Error('Token budget exhausted');
      }

      const sanitized = this.inputSanitizer.sanitize(request.prompt);
      if (sanitized.blocked) {
        throw new Error('Input blocked by sanitizer');
      }

      const threatAnalysis = this.promptShield.analyze(request.prompt);
      if (!threatAnalysis.safe) {
        throw new Error(`Threat detected: ${threatAnalysis.reason}`);
      }

      const validation = this.hallucinationValidator.validateClaim(request.prompt);
      if (validation.confidence < 0.5) {
        log.warn('Low confidence in request:', validation.issues);
      }

      const response = await this.circuitBreakers.getOrCreate('ai').execute(async () => {
        return await this.federation.route({
          prompt: this.promptShield.enrichSystemPrompt() + '\n\n' + sanitized.sanitized,
          image: request.image,
          taskType: request.taskType as any,
          parallel: request.verify || false,
        });
      });

      if (request.verify) {
        const verification = this.hallucinationValidator.verifyWithEvidence(
          response.content,
          [request.prompt]
        );

        response.verified = verification.verified;
        response.confidence = verification.confidence;
      }

      if (traceId) {
        this.tracing.endSpan(traceId, { status: 'ok' });
      }

      return {
        result: response.content,
        confidence: response.confidence,
        verified: response.verified,
        provider: response.provider,
      };
    } catch (error) {
      if (traceId) {
        this.tracing.endSpan(traceId, { status: 'error', error: error as Error });
      }

      this.emit('task:failed', error);
      throw error;
    }
  }

  async processImage(imageData: string, type: 'upload' | 'clipboard' | 'screenshot'): Promise<any> {
    const metadata = await this.imageProcessor.processImage(
      Buffer.from(imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64'),
      { type }
    );

    return metadata;
  }

  async analyzeImage(imageData: string, prompt: string): Promise<any> {
    if (!this.multimodalService) {
      throw new Error('Multimodal service not configured');
    }

    return await this.multimodalService.analyzeImage({
      image: imageData.replace(/^data:image\/\w+;base64,/, ''),
      imageType: 'base64',
      prompt,
    });
  }

  getState(): EnterpriseState {
    this.state.uptime = Date.now() - this.startTime;
    this.state.metrics = {
      circuitBreakers: this.circuitBreakers.getAllStates(),
      rateLimiter: this.rateLimiter.getAllStatuses().size,
      tokenBucket: this.tokenBucket.getAvailable(),
      tokenBudget: this.tokenBudget.getRemaining(),
      tracing: this.tracing.getStatus(),
      federation: this.federation.getMetrics(),
    };

    return { ...this.state };
  }

  async shutdown(): Promise<void> {
    log.info('Shutting down Enterprise Agent...');

    await this.processSupervisor.close();
    await this.tracing.close();
    this.rateLimiter.close();
    this.tokenBucket.close();

    this.state.initialized = false;
    log.info('Enterprise Agent shutdown complete');
  }
}

export default EnterpriseAgent;