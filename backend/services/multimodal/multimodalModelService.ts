import { EventEmitter } from 'events';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as base64 from 'base64util';
import log from 'electron-log';

export interface VisionModelConfig {
  provider: 'openai' | 'anthropic' | 'google' | 'openrouter' | 'ollama';
  apiKey: string;
  model: string;
  endpoint?: string;
  maxTokens?: number;
}

export interface VisionRequest {
  image: string;
  imageType: 'url' | 'base64' | 'file';
  prompt: string;
  systemPrompt?: string;
  temperature?: number;
}

export interface VisionResponse {
  content: string;
  confidence: number;
  tokens: number;
  model: string;
}

export interface MultimodalAnalysis {
  description: string;
  bugs?: BugFinding[];
  uiElements?: UIElement[];
  code?: CodeSuggestion;
  accessibility?: AccessibilityIssue[];
  responsive?: ResponsiveIssue[];
}

export interface BugFinding {
  type: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  description: string;
  location?: { x: number; y: number; width: number; height: number };
  suggestion?: string;
}

export interface UIElement {
  type: string;
  text?: string;
  bounds: { x: number; y: number; width: number; height: number };
  style?: Record<string, string>;
}

export interface CodeSuggestion {
  framework: string;
  code: string;
  css?: string;
  confidence: number;
}

export interface AccessibilityIssue {
  type: string;
  element?: string;
  description: string;
  wcagCriteria?: string;
}

export interface ResponsiveIssue {
  breakpoint: string;
  description: string;
}

export class MultimodalModelService extends EventEmitter {
  private config: VisionModelConfig;
  private fallbackModels: VisionModelConfig[];
  private httpClient;

  constructor(config: VisionModelConfig, fallbacks: VisionModelConfig[] = []) {
    super();
    this.config = config;
    this.fallbackModels = fallbacks;
    this.httpClient = axios.create({ timeout: 60000 });
  }

  async analyzeImage(request: VisionRequest): Promise<VisionResponse> {
    const imageData = await this.prepareImageData(request.image, request.imageType);

    const providers = [this.config, ...this.fallbackModels];
    let lastError: Error | null = null;

    for (const provider of providers) {
      try {
        let response: VisionResponse;

        switch (provider.provider) {
          case 'openai':
          case 'openrouter':
            response = await this.callOpenAI(provider, request, imageData);
            break;
          case 'anthropic':
            response = await this.callAnthropic(provider, request, imageData);
            break;
          case 'google':
            response = await this.callGoogle(provider, request, imageData);
            break;
          case 'ollama':
            response = await this.callOllama(provider, request, imageData);
            break;
          default:
            throw new Error(`Unknown provider: ${provider.provider}`);
        }

        this.emit('analysis:complete', response);
        return response;
      } catch (error) {
        lastError = error as Error;
        log.warn(`Provider ${provider.provider} failed:`, error);
      }
    }

    throw lastError || new Error('All vision providers failed');
  }

  private async prepareImageData(image: string, type: 'url' | 'base64' | 'file'): Promise<string> {
    switch (type) {
      case 'url':
        return image;
      case 'base64':
        return image;
      case 'file':
        const buffer = fs.readFileSync(image);
        return buffer.toString('base64');
      default:
        return image;
    }
  }

  private async callOpenAI(
    provider: VisionModelConfig,
    request: VisionRequest,
    imageData: string
  ): Promise<VisionResponse> {
    const isUrl = request.imageType === 'url';

    const messages: any[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: request.prompt },
          {
            type: 'image_url',
            image_url: isUrl
              ? { url: imageData }
              : { url: `data:image/png;base64,${imageData}` },
          },
        ],
      },
    ];

    if (request.systemPrompt) {
      messages.unshift({ role: 'system', content: request.systemPrompt });
    }

    const response = await this.httpClient.post(
      provider.endpoint || 'https://api.openai.com/v1/chat/completions',
      {
        model: provider.model,
        messages,
        max_tokens: request.temperature || 4096,
        temperature: request.temperature || 0.7,
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
      confidence: this.estimateConfidence(content),
      tokens: response.data.usage?.total_tokens || 0,
      model: provider.model,
    };
  }

  private async callAnthropic(
    provider: VisionModelConfig,
    request: VisionRequest,
    imageData: string
  ): Promise<VisionResponse> {
    const isUrl = request.imageType === 'url';

    const messages: any[] = [
      {
        role: 'user',
        content: [
          { type: 'image', source: isUrl ? { type: 'url', url: imageData } : { type: 'base64', media_type: 'image/png', data: imageData } },
          { type: 'text', text: request.prompt },
        ],
      },
    ];

    const response = await this.httpClient.post(
      provider.endpoint || 'https://api.anthropic.com/v1/messages',
      {
        model: provider.model,
        messages,
        max_tokens: 4096,
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
      confidence: this.estimateConfidence(content),
      tokens: response.data.usage?.input_tokens + response.data.usage?.output_tokens || 0,
      model: provider.model,
    };
  }

  private async callGoogle(
    provider: VisionModelConfig,
    request: VisionRequest,
    imageData: string
  ): Promise<VisionResponse> {
    const isUrl = request.imageType === 'url';

    const response = await this.httpClient.post(
      provider.endpoint || `https://generativelanguage.googleapis.com/v1/models/${provider.model}:generateContent`,
      {
        contents: [{
          parts: [
            { text: request.prompt },
            isUrl
              ? { inlineData: { mimeType: 'image/png', data: imageData } }
              : { inlineData: { mimeType: 'image/png', data: imageData } },
          ],
        }],
        generationConfig: {
          temperature: request.temperature || 0.7,
          maxOutputTokens: 4096,
        },
      },
      {
        headers: {
          'Content-Type': 'application/json',
        },
        params: { key: provider.apiKey },
      }
    );

    const content = response.data.candidates[0]?.content?.parts[0]?.text || '';

    return {
      content,
      confidence: this.estimateConfidence(content),
      tokens: 0,
      model: provider.model,
    };
  }

  private async callOllama(
    provider: VisionModelConfig,
    request: VisionRequest,
    imageData: string
  ): Promise<VisionResponse> {
    const response = await this.httpClient.post(
      provider.endpoint || 'http://localhost:11434/api/generate',
      {
        model: provider.model,
        prompt: request.prompt,
        images: [imageData],
        stream: false,
      },
      { timeout: 120000 }
    );

    const content = response.data.response || '';

    return {
      content,
      confidence: this.estimateConfidence(content),
      tokens: 0,
      model: provider.model,
    };
  }

  private estimateConfidence(content: string): number {
    let confidence = 0.5;

    const uncertainPhrases = ['might', 'possibly', 'could be', 'unclear', ' uncertain'];
    for (const phrase of uncertainPhrases) {
      if (content.toLowerCase().includes(phrase)) {
        confidence -= 0.1;
      }
    }

    const confidentPhrases = ['definitely', 'clearly', 'obvious', 'visible'];
    for (const phrase of confidentPhrases) {
      if (content.toLowerCase().includes(phrase)) {
        confidence += 0.1;
      }
    }

    return Math.max(0, Math.min(1, confidence));
  }

  async analyzeUIBug(imageData: string, imageType: 'url' | 'base64' | 'file'): Promise<MultimodalAnalysis> {
    const prompt = `Analyze this screenshot for UI bugs and issues. Identify:
1. Visual bugs (layout issues, overlapping elements, missing text)
2. Broken UI elements
3. Accessibility issues
4. Responsive problems
5. Any error messages or warnings

Provide a detailed analysis with specific locations if possible.`;

    const response = await this.analyzeImage({
      image: imageData,
      imageType,
      prompt,
      systemPrompt: 'You are an expert UI/UX bug analyzer. Identify specific bugs with locations and severity levels.',
    });

    return this.parseBugAnalysis(response.content);
  }

  async generateCodeFromScreenshot(imageData: string, imageType: 'url' | 'base64' | 'file', framework: string = 'react'): Promise<CodeSuggestion> {
    const prompt = `Analyze this screenshot and generate ${framework} code that recreates the UI. Include:
1. Component structure
2. Inline styles or CSS
3. Responsive considerations
4. Proper semantic HTML

Generate clean, production-ready code.`;

    const response = await this.analyzeImage({
      image: imageData,
      imageType,
      prompt,
      systemPrompt: `You are an expert ${framework} developer. Generate clean, working code from UI screenshots.`,
    });

    return {
      framework,
      code: this.extractCode(response.content),
      confidence: response.confidence,
    };
  }

  private parseBugAnalysis(content: string): MultimodalAnalysis {
    const bugs: BugFinding[] = [];
    const uiElements: UIElement[] = [];

    return {
      description: content,
      bugs,
      uiElements,
    };
  }

  private extractCode(content: string): string {
    const codeBlockMatch = content.match(/```(?:\w+)?\n([\s\S]*?)```/);
    if (codeBlockMatch) {
      return codeBlockMatch[1].trim();
    }
    return content;
  }
}

export default MultimodalModelService;