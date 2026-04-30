import { EventEmitter } from 'events';
import * as fs from 'fs';
import log from 'electron-log';

export interface UILayout {
  type: 'page' | 'section' | 'component';
  name: string;
  bounds: { x: number; y: number; width: number; height: number };
  children?: UILayout[];
}

export interface DetectedComponent {
  type: 'button' | 'input' | 'card' | 'navbar' | 'sidebar' | 'footer' | 'header' | 'form' | 'table' | 'modal' | 'menu' | 'dropdown' | 'checkbox' | 'radio' | 'toggle' | 'slider' | 'avatar' | 'badge' | 'chip' | 'tooltip' | 'accordion' | 'tabs' | 'chart' | 'icon' | 'text' | 'image';
  bounds: { x: number; y: number; width: number; height: number };
  text?: string;
  styles: ComponentStyles;
  children?: DetectedComponent[];
}

export interface ComponentStyles {
  backgroundColor?: string;
  borderColor?: string;
  borderWidth?: number;
  borderRadius?: number;
  padding?: { top: number; right: number; bottom: number; left: number };
  margin?: { top: number; right: number; bottom: number; left: number };
  fontSize?: number;
  fontWeight?: number;
  fontFamily?: string;
  color?: string;
  opacity?: number;
  shadow?: string;
  gradient?: string;
}

export interface ColorPalette {
  primary: string[];
  secondary: string[];
  neutral: string[];
  accent: string[];
  semantic: { success: string; warning: string; error: string; info: string };
}

export interface TypographyStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
  letterSpacing: number;
  color: string;
}

export interface VisualAnalysis {
  layout: UILayout[];
  components: DetectedComponent[];
  colorPalette: ColorPalette;
  typography: TypographyStyle[];
  spacing: { base: number; scale: number[] };
  borderRadius: number[];
  shadows: string[];
  aspectRatios: { width: number; height: number }[];
}

export class ScreenToUIEngine extends EventEmitter {
  private visionProviders: VisionProvider[] = [];
  private ocrEngine: any = null;

  constructor() {
    super();
  }

  addVisionProvider(provider: VisionProvider): void {
    this.visionProviders.push(provider);
  }

  async analyzeImage(imagePath: string): Promise<VisualAnalysis> {
    log.info(`Analyzing image: ${imagePath}`);

    const imageBuffer = fs.readFileSync(imagePath);
    const base64 = imageBuffer.toString('base64');

    return this.analyzeBase64(base64);
  }

  async analyzeBase64(imageData: string): Promise<VisualAnalysis> {
    const analysis = await this.analyzeWithVision(imageData);
    
    const colorPalette = this.extractColors(analysis);
    const typography = this.extractTypography(analysis);
    const spacing = this.extractSpacing(analysis);
    const borderRadius = this.extractBorderRadius(analysis);
    const shadows = this.extractShadows(analysis);

    return {
      layout: analysis.layout || [],
      components: analysis.components || [],
      colorPalette,
      typography,
      spacing,
      borderRadius,
      shadows,
      aspectRatios: [],
    };
  }

  private async analyzeWithVision(imageData: string): Promise<any> {
    for (const provider of this.visionProviders) {
      try {
        const result = await provider.analyze(imageData);
        if (result) return result;
      } catch (error) {
        log.warn(`Vision provider ${provider.name} failed:`, error);
      }
    }

    return this.defaultAnalysis(imageData);
  }

  private async defaultAnalysis(imageData: string): Promise<any> {
    return {
      layout: [
        {
          type: 'page',
          name: 'Main',
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        },
      ],
      components: [],
    };
  }

  private extractColors(analysis: any): ColorPalette {
    const allColors: string[] = [];
    
    if (analysis.components) {
      const extract = (components: DetectedComponent[]) => {
        for (const comp of components) {
          if (comp.styles.backgroundColor) {
            allColors.push(comp.styles.backgroundColor);
          }
          if (comp.styles.color) {
            allColors.push(comp.styles.color);
          }
          if (comp.styles.borderColor) {
            allColors.push(comp.styles.borderColor);
          }
          if (comp.children) {
            extract(comp.children);
          }
        }
      };
      extract(analysis.components);
    }

    const uniqueColors = [...new Set(allColors)];
    
    return {
      primary: uniqueColors.slice(0, 3),
      secondary: uniqueColors.slice(3, 6),
      neutral: uniqueColors.filter(c => this.isNeutral(c)).slice(0, 5),
      accent: uniqueColors.filter(c => !this.isNeutral(c)).slice(0, 3),
      semantic: {
        success: uniqueColors.find(c => this.isGreenish(c)) || '#22c55e',
        warning: uniqueColors.find(c => this.isYellowish(c)) || '#eab308',
        error: uniqueColors.find(c => this.isReddish(c)) || '#ef4444',
        info: uniqueColors.find(c => this.isBlueish(c)) || '#3b82f6',
      },
    };
  }

  private isNeutral(color: string): boolean {
    const hex = color.replace('#', '');
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const saturation = max === 0 ? 0 : (max - min) / max;
    return saturation < 0.15;
  }

  private isGreenish(color: string): boolean {
    const hex = color.replace('#', '');
    const g = parseInt(hex.slice(2, 4), 16);
    const r = parseInt(hex.slice(0, 2), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return g > r && g > b;
  }

  private isYellowish(color: string): boolean {
    const hex = color.replace('#', '');
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    return r > 200 && g > 200 && r > b;
  }

  private isReddish(color: string): boolean {
    const hex = color.replace('#', '');
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return r > g * 2 && r > b * 2;
  }

  private isBlueish(color: string): boolean {
    const hex = color.replace('#', '');
    const b = parseInt(hex.slice(4, 6), 16);
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    return b > r && b > g;
  }

  private extractTypography(analysis: any): TypographyStyle[] {
    const styles: TypographyStyle[] = [];
    const seen = new Set<string>();

    const extract = (components: DetectedComponent[]) => {
      for (const comp of components) {
        if (comp.styles.fontSize && comp.styles.color) {
          const key = `${comp.styles.fontSize}-${comp.styles.color}`;
          if (!seen.has(key)) {
            seen.add(key);
            styles.push({
              fontFamily: comp.styles.fontFamily || 'Inter',
              fontSize: comp.styles.fontSize,
              fontWeight: comp.styles.fontWeight || 400,
              lineHeight: comp.styles.fontSize * 1.5,
              letterSpacing: 0,
              color: comp.styles.color,
            });
          }
        }
        if (comp.children) {
          extract(comp.children);
        }
      }
    };

    if (analysis.components) {
      extract(analysis.components);
    }

    return styles.sort((a, b) => b.fontSize - a.fontSize);
  }

  private extractSpacing(analysis: any): { base: number; scale: number[] } {
    const spacings = new Set<number>();
    
    const extract = (components: DetectedComponent[]) => {
      for (const comp of components) {
        if (comp.styles.padding) {
          Object.values(comp.styles.padding).forEach((v: any) => spacings.add(Number(v)));
        }
        if (comp.styles.margin) {
          Object.values(comp.styles.margin).forEach((v: any) => spacings.add(Number(v)));
        }
        if (comp.children) {
          extract(comp.children);
        }
      }
    };

    if (analysis.components) {
      extract(analysis.components);
    }

    const sorted = [...spacings].sort((a, b) => a - b);
    return {
      base: sorted[0] || 4,
      scale: sorted.slice(0, 8),
    };
  }

  private extractBorderRadius(analysis: any): number[] {
    const radii = new Set<number>();
    
    const extract = (components: DetectedComponent[]) => {
      for (const comp of components) {
        if (comp.styles.borderRadius) {
          radii.add(comp.styles.borderRadius);
        }
        if (comp.children) {
          extract(comp.children);
        }
      }
    };

    if (analysis.components) {
      extract(analysis.components);
    }

    return [...radii].sort((a, b) => a - b);
  }

  private extractShadows(analysis: any): string[] {
    const shadows = new Set<string>();
    
    const extract = (components: DetectedComponent[]) => {
      for (const comp of components) {
        if (comp.styles.shadow) {
          shadows.add(comp.styles.shadow);
        }
        if (comp.children) {
          extract(comp.children);
        }
      }
    };

    if (analysis.components) {
      extract(analysis.components);
    }

    return [...shadows];
  }

  calculateSimilarity(target: VisualAnalysis, generated: VisualAnalysis): number {
    let score = 0;

    const colorMatch = this.compareColorPalettes(target.colorPalette, generated.colorPalette);
    score += colorMatch * 0.3;

    const typographyMatch = this.compareTypography(target.typography, generated.typography);
    score += typographyMatch * 0.25;

    const spacingMatch = this.compareSpacing(target.spacing, generated.spacing);
    score += spacingMatch * 0.2;

    const componentMatch = this.compareComponents(target.components, generated.components);
    score += componentMatch * 0.25;

    return score * 100;
  }

  private compareColorPalettes(a: ColorPalette, b: ColorPalette): number {
    const compareArrays = (arr1: string[], arr2: string[]) => {
      let matches = 0;
      for (const color of arr1) {
        if (arr2.some(c => this.colorDistance(c, color) < 30)) {
          matches++;
        }
      }
      return matches / Math.max(arr1.length, 1);
    };

    return (
      compareArrays(a.primary, b.primary) +
      compareArrays(a.secondary, b.secondary) +
      compareArrays(a.neutral, b.neutral)
    ) / 3;
  }

  private colorDistance(a: string, b: string): number {
    const hex2rgb = (hex: string) => ({
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    });

    const rgb1 = hex2rgb(a.replace('#', ''));
    const rgb2 = hex2rgb(b.replace('#', ''));

    return Math.sqrt(
      Math.pow(rgb1.r - rgb2.r, 2) +
      Math.pow(rgb1.g - rgb2.g, 2) +
      Math.pow(rgb1.b - rgb2.b, 2)
    );
  }

  private compareTypography(a: TypographyStyle[], b: TypographyStyle[]): number {
    if (a.length === 0 || b.length === 0) return 0.5;

    let matches = 0;
    for (const styleA of a) {
      for (const styleB of b) {
        if (Math.abs(styleA.fontSize - styleB.fontSize) < 2) {
          matches++;
          break;
        }
      }
    }

    return matches / Math.max(a.length, b.length);
  }

  private compareSpacing(a: any, b: any): number {
    const scaleMatch = a.scale.filter((v: number) => 
      b.scale.some((bv: number) => Math.abs(v - bv) < 4)
    ).length;

    return scaleMatch / Math.max(a.scale.length, b.scale.length, 1);
  }

  private compareComponents(a: DetectedComponent[], b: DetectedComponent[]): number {
    const typesA = a.map(c => c.type);
    const typesB = b.map(c => c.type);

    const matches = typesA.filter(t => typesB.includes(t)).length;
    return matches / Math.max(typesA.length, typesB.length, 1);
  }
}

export interface VisionProvider {
  name: string;
  analyze(imageData: string): Promise<any>;
}

export const screenToUI = new ScreenToUIEngine();
export default ScreenToUIEngine;