import log from 'electron-log';
import { createWorker, Worker, RecognizeResult } from 'tesseract.js';

export interface OCRConfig {
  language: string;
  logger?: (info: any) => void;
  speed?: number;
}

export interface OCRResult {
  text: string;
  confidence: number;
  words: {
    text: string;
    confidence: number;
    bbox: { x0: number; y0: number; x1: number; y1: number };
  }[];
  paragraphs: string[];
}

export class OCRService {
  private worker: Worker | null = null;
  private config: OCRConfig;
  private isInitialized: boolean = false;

  constructor(config: Partial<OCRConfig> = {}) {
    this.config = {
      language: config.language ?? 'eng',
      speed: config.speed ?? 2,
    };
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      this.worker = await createWorker(this.config.language, this.config.speed, {
        logger: this.config.logger ?? ((info) => log.debug('OCR:', info)),
      });
      
      await this.worker.loadLanguage('eng');
      await this.worker.initialize('eng');
      
      this.isInitialized = true;
      log.info('OCR service initialized');
    } catch (error) {
      log.error('OCR initialization failed:', error);
      throw error;
    }
  }

  async recognize(buffer: Buffer): Promise<OCRResult> {
    if (!this.worker) await this.initialize();

    const result = await this.worker!.recognize(buffer);
    
    return this.parseResult(result);
  }

  async recognizeFile(filePath: string): Promise<OCRResult> {
    const fs = await import('fs');
    const buffer = fs.readFileSync(filePath);
    return await this.recognize(buffer);
  }

  async recognizeBase64(base64String: string): Promise<OCRResult> {
    const buffer = Buffer.from(base64String, 'base64');
    return await this.recognize(buffer);
  }

  private parseResult(result: RecognizeResult): OCRResult {
    const words = result.data.words.map(w => ({
      text: w.text,
      confidence: w.confidence,
      bbox: w.bbox,
    }));

    const paragraphs = result.data.paragraphs.map(p => p.text);

    return {
      text: result.data.text,
      confidence: result.data.confidence,
      words,
      paragraphs,
    };
  }

  async getBlockText(buffer: Buffer): Promise<string> {
    const result = await this.recognize(buffer);
    return result.text;
  }

  async findText(buffer: Buffer, searchText: string, options: { caseSensitive?: boolean } = {}): Promise<boolean> {
    const result = await this.recognize(buffer);
    const { caseSensitive = false } = options;
    
    if (caseSensitive) {
      return result.text.includes(searchText);
    }
    return result.text.toLowerCase().includes(searchText.toLowerCase());
  }

  async getTextInRegion(buffer: Buffer, region: { x: number; y: number; width: number; height: number }): Promise<string> {
    const result = await this.recognize(buffer);
    
    const wordsInRegion = result.words.filter(w => {
      const bbox = w.bbox;
      return (
        bbox.x0 >= region.x &&
        bbox.y0 >= region.y &&
        bbox.x1 <= region.x + region.width &&
        bbox.y1 <= region.y + region.height
      );
    });

    return wordsInRegion.map(w => w.text).join(' ');
  }

  async extractLinks(buffer: Buffer): Promise<string[]> {
    const result = await this.recognize(buffer);
    const urlRegex = /https?:\/\/[^\s]+/g;
    
    const matches = result.text.match(urlRegex) ?? [];
    return [...new Set(matches)];
  }

  async terminate(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
      this.isInitialized = false;
      log.info('OCR service terminated');
    }
  }

  getStatus(): { initialized: boolean; language: string } {
    return {
      initialized: this.isInitialized,
      language: this.config.language,
    };
  }
}

export const createOCRService = (config?: Partial<OCRConfig>): OCRService => {
  return new OCRService(config);
};

export default OCRService;