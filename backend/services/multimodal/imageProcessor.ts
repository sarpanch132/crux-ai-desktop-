import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import log from 'electron-log';

export interface ImageConfig {
  maxFileSize: number;
  allowedFormats: string[];
  compressionQuality: number;
  thumbnailSize: number;
  storageDirectory: string;
}

export interface ImageMetadata {
  id: string;
  filename: string;
  originalPath: string;
  storedPath: string;
  thumbnailPath?: string;
  format: string;
  width: number;
  height: number;
  size: number;
  uploadedAt: number;
  type: 'upload' | 'screenshot' | 'clipboard';
}

export interface ImageAnalysis {
  id: string;
  imageId: string;
  analysis: string;
  confidence: number;
  tags: string[];
  bugs?: BugAnalysis[];
  uiElements?: UIElement[];
  codeGenerated?: CodeGeneration;
  timestamp: number;
}

export interface BugAnalysis {
  type: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  description: string;
  location?: { x: number; y: number; width: number; height: number };
  suggestedFix?: string;
}

export interface UIElement {
  type: string;
  text?: string;
  bounds: { x: number; y: number; width: number; height: number };
  attributes?: Record<string, string>;
}

export interface CodeGeneration {
  framework: 'react' | 'vue' | 'html' | 'tailwind' | 'css';
  code: string;
  confidence: number;
}

export class ImageProcessor extends EventEmitter {
  private config: ImageConfig;
  private metadata: Map<string, ImageMetadata> = new Map();
  private analysisHistory: Map<string, ImageAnalysis[]> = new Map();

  constructor(config: Partial<ImageConfig> = {}) {
    super();
    this.config = {
      maxFileSize: config.maxFileSize ?? 10 * 1024 * 1024,
      allowedFormats: config.allowedFormats ?? ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'],
      compressionQuality: config.compressionQuality ?? 85,
      thumbnailSize: config.thumbnailSize ?? 200,
      storageDirectory: config.storageDirectory ?? './data/images',
    };

    this.ensureStorageDirectory();
  }

  private ensureStorageDirectory(): void {
    const dirs = [this.config.storageDirectory, path.join(this.config.storageDirectory, 'thumbnails')];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  async processImage(source: Buffer | string, options: {
    type?: 'upload' | 'screenshot' | 'clipboard';
    filename?: string;
  } = {}): Promise<ImageMetadata> {
    const id = randomUUID();
    const isBuffer = Buffer.isBuffer(source);
    const buffer = isBuffer ? source : fs.readFileSync(source as string);
    const filename = options.filename || `${id}.png`;

    const ext = path.extname(filename).toLowerCase().slice(1);
    if (!this.config.allowedFormats.includes(ext)) {
      throw new Error(`Unsupported format: ${ext}`);
    }

    if (buffer.length > this.config.maxFileSize) {
      throw new Error(`File too large: ${buffer.length} bytes (max: ${this.config.maxFileSize})`);
    }

    const storedFilename = `${id}.${ext}`;
    const storedPath = path.join(this.config.storageDirectory, storedFilename);

    fs.writeFileSync(storedPath, buffer);

    const metadata: ImageMetadata = {
      id,
      filename,
      originalPath: isBuffer ? '' : (source as string),
      storedPath,
      format: ext,
      width: 0,
      height: 0,
      size: buffer.length,
      uploadedAt: Date.now(),
      type: options.type || 'upload',
    };

    this.metadata.set(id, metadata);

    this.emit('image:processed', metadata);
    log.info(`Image processed: ${id}`);

    return metadata;
  }

  async processClipboard(imageDataUrl: string): Promise<ImageMetadata> {
    const base64Data = imageDataUrl.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    return this.processImage(buffer, { type: 'clipboard' });
  }

  async processScreenshot(imageDataUrl: string): Promise<ImageMetadata> {
    const base64Data = imageDataUrl.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    return this.processImage(buffer, { type: 'screenshot' });
  }

  getMetadata(id: string): ImageMetadata | undefined {
    return this.metadata.get(id);
  }

  getAllImages(): ImageMetadata[] {
    return Array.from(this.metadata.values());
  }

  async deleteImage(id: string): Promise<boolean> {
    const metadata = this.metadata.get(id);
    if (!metadata) return false;

    try {
      if (fs.existsSync(metadata.storedPath)) {
        fs.unlinkSync(metadata.storedPath);
      }
      if (metadata.thumbnailPath && fs.existsSync(metadata.thumbnailPath)) {
        fs.unlinkSync(metadata.thumbnailPath);
      }
      this.metadata.delete(id);
      return true;
    } catch (error) {
      log.error(`Failed to delete image ${id}:`, error);
      return false;
    }
  }

  storeAnalysis(analysis: ImageAnalysis): void {
    const history = this.analysisHistory.get(analysis.imageId) || [];
    history.unshift(analysis);
    if (history.length > 50) history.pop();
    this.analysisHistory.set(analysis.imageId, history);
  }

  getAnalysisHistory(imageId: string): ImageAnalysis[] {
    return this.analysisHistory.get(imageId) || [];
  }
}

export default ImageProcessor;