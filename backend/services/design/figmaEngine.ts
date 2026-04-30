import { EventEmitter } from 'events';
import axios from 'axios';
import log from 'electron-log';

export interface FigmaConfig {
  accessToken: string;
}

export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  locked: boolean;
  children?: FigmaNode[];
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number };
  constraints?: { horizontal: string; vertical: string };
  fills?: FigmaFill[];
  strokes?: FigmaStroke[];
  effects?: FigmaEffect[];
  blendMode?: string;
  opacity?: number;
  cornerRadius?: number;
  rectangleCornerRadii?: number[];
  exportSettings?: ExportSetting[];
  componentId?: string;
  componentProperties?: Record<string, any>;
}

export interface FigmaFill {
  type: 'SOLID' | 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' | 'IMAGE';
  visible: boolean;
  opacity?: number;
  color?: { r: number; g: number; b: number; a: number };
  gradientStops?: { position: number; color: { r: number; g: number; b: number; a: number } }[];
  imageRef?: string;
}

export interface FigmaStroke {
  type: string;
  visible: boolean;
  color?: { r: number; g: number; b: number; a: number };
}

export interface FigmaEffect {
  type: 'DROP_SHADOW' | 'INNER_SHADOW' | 'LAYER_BLUR' | 'BACKGROUND_BLUR';
  visible: boolean;
  radius: number;
  color?: { r: number; g: number; b: number; a: number };
  offset?: { x: number; y: number };
}

export interface ExportSetting {
  format: 'PNG' | 'JPG' | 'SVG' | 'PDF';
  suffix: string;
  constraint: { type: 'SCALE' | 'WIDTH' | 'HEIGHT'; value: number };
}

export interface FigmaFrame {
  id: string;
  name: string;
  type: 'FRAME' | 'COMPONENT' | 'COMPONENT_SET';
  width: number;
  height: number;
  backgroundColor?: { r: number; g: number; b: number; a: number };
  children: FigmaNode[];
}

export interface FigmaStyle {
  typography?: {
    fontFamily: string;
    fontPostScriptName?: string;
    fontWeight: number;
    fontSize: number;
    letterSpacing: number;
    lineHeightPx?: number;
    lineHeightPercent?: number;
    lineHeightUnit?: 'PIXELS' | 'PERCENT' | 'INTRINSIC';
    textAlignHorizontal?: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
    textAlignVertical?: 'TOP' | 'CENTER' | 'BOTTOM';
    textDecoration?: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';
    textCase?: 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE';
  };
  fills?: FigmaFill[];
  strokes?: FigmaStroke[];
  effects?: FigmaEffect[];
  cornerRadius?: number;
}

export interface DesignToken {
  name: string;
  type: 'color' | 'spacing' | 'typography' | 'shadow' | 'radius' | 'size';
  value: any;
  nodeId?: string;
}

export interface ComponentInfo {
  id: string;
  name: string;
  description?: string;
  variantProperties?: string[];
  children: FigmaNode[];
}

export class FigmaEngine extends EventEmitter {
  private config: FigmaConfig;
  private httpClient;

  constructor(config: FigmaConfig) {
    super();
    this.config = config;
    this.httpClient = axios.create({
      baseURL: 'https://api.figma.com/v1',
      headers: {
        'X-Figma-Token': config.accessToken,
      },
    });
  }

  async getFile(fileKey: string): Promise<any> {
    try {
      const response = await this.httpClient.get(`/files/${fileKey}`);
      return response.data;
    } catch (error) {
      log.error('Failed to fetch Figma file:', error);
      throw error;
    }
  }

  async getFrames(fileKey: string): Promise<FigmaFrame[]> {
    const file = await this.getFile(fileKey);
    const frames: FigmaFrame[] = [];

    const extractFrames = (node: any) => {
      if (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
        frames.push(this.parseFrame(node));
      }
      if (node.children) {
        node.children.forEach(extractFrames);
      }
    };

    if (file.document.children) {
      file.document.children.forEach(extractFrames);
    }

    return frames;
  }

  private parseFrame(node: any): FigmaFrame {
    return {
      id: node.id,
      name: node.name,
      type: node.type,
      width: node.absoluteBoundingBox?.width || 0,
      height: node.absoluteBoundingBox?.height || 0,
      backgroundColor: node.fills?.find((f: any) => f.type === 'SOLID')?.color,
      children: node.children?.map((c: any) => this.parseNode(c)) || [],
    };
  }

  private parseNode(node: any): FigmaNode {
    return {
      id: node.id,
      name: node.name,
      type: node.type,
      visible: node.visible ?? true,
      locked: node.locked ?? false,
      absoluteBoundingBox: node.absoluteBoundingBox,
      constraints: node.constraints,
      fills: node.fills,
      strokes: node.strokes,
      effects: node.effects,
      blendMode: node.blendMode,
      opacity: node.opacity,
      cornerRadius: node.cornerRadius,
      rectangleCornerRadii: node.rectangleCornerRadii,
      exportSettings: node.exportSettings,
      componentId: node.componentId,
      componentProperties: node.componentProperties,
      children: node.children?.map((c: any) => this.parseNode(c)),
    };
  }

  async getComponent(fileKey: string, nodeId: string): Promise<FigmaNode> {
    const response = await this.httpClient.get(`/files/${fileKey}/nodes?ids=${nodeId}`);
    return this.parseNode(response.data.nodes[nodeId].document);
  }

  async getStyles(fileKey: string): Promise<Record<string, FigmaStyle>> {
    const file = await this.getFile(fileKey);
    const styles: Record<string, FigmaStyle> = {};

    if (file.styles) {
      for (const [id, style] of Object.entries(file.styles as Record<string, any>)) {
        styles[id] = {
          typography: style.typography,
          fills: style.fills,
          strokes: style.strokes,
          effects: style.effects,
          cornerRadius: style.cornerRadius,
        };
      }
    }

    return styles;
  }

  async getImage(fileKey: string, nodeIds: string[], format: 'png' | 'svg' | 'jpg' = 'png', scale: number = 2): Promise<string[]> {
    const response = await this.httpClient.get(`/images/${fileKey}`, {
      params: {
        ids: nodeIds.join(','),
        format,
        scale,
      },
    });

    return response.data.images ? Object.values(response.data.images) : [];
  }

  async exportFrame(fileKey: string, nodeId: string): Promise<Buffer> {
    const response = await this.httpClient.get(`/images/${fileKey}`, {
      params: {
        ids: nodeId,
        format: 'png',
        scale: 2,
      },
      responseType: 'arraybuffer',
    });

    return Buffer.from(response.data);
  }

  extractDesignTokens(frames: FigmaFrame[]): DesignToken[] {
    const tokens: DesignToken[] = [];
    const colors = new Set<string>();
    const spacings = new Set<number>();
    const radii = new Set<number>();

    const processNode = (node: FigmaNode) => {
      if (node.fills) {
        for (const fill of node.fills) {
          if (fill.type === 'SOLID' && fill.color) {
            const hex = this.rgbToHex(fill.color);
            if (!colors.has(hex)) {
              colors.add(hex);
              tokens.push({
                name: `color-${colors.size}`,
                type: 'color',
                value: hex,
                nodeId: node.id,
              });
            }
          }
        }
      }

      if (node.effects) {
        for (const effect of node.effects) {
          if ((effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW') && effect.radius) {
            const shadowKey = `${effect.radius}-${effect.offset?.x || 0}-${effect.offset?.y || 0}`;
            tokens.push({
              name: `shadow-${tokens.filter(t => t.type === 'shadow').length + 1}`,
              type: 'shadow',
              value: {
                radius: effect.radius,
                x: effect.offset?.x || 0,
                y: effect.offset?.y || 0,
                color: effect.color ? this.rgbToHex(effect.color) : '#00000040',
              },
              nodeId: node.id,
            });
          }
        }
      }

      if (node.cornerRadius) {
        radii.add(node.cornerRadius);
      }

      if (node.children) {
        node.children.forEach(processNode);
      }
    };

    frames.forEach(frame => processNode(frame));

    return tokens;
  }

  private rgbToHex(color: { r: number; g: number; b: number; a?: number }): string {
    const r = Math.round(color.r * 255);
    const g = Math.round(color.g * 255);
    const b = Math.round(color.b * 255);
    const a = color.a !== undefined ? Math.round(color.a * 255) : 255;
    
    const toHex = (n: number) => n.toString(16).padStart(2, '0');
    
    return a < 255 ? `#${toHex(r)}${toHex(g)}${toHex(b)}${toHex(a)}` : `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  analyzeLayout(node: FigmaNode): any {
    const layout: any = {
      type: node.type,
      bounds: node.absoluteBoundingBox,
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
      gap: 0,
      orientation: 'vertical',
    };

    return layout;
  }

  detectAutoLayout(node: FigmaNode): { isAutoLayout: boolean; direction: 'horizontal' | 'vertical'; gap: number; padding: any } {
    return {
      isAutoLayout: !!node.constraints,
      direction: 'vertical',
      gap: 0,
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
    };
  }

  extractComponents(frames: FigmaFrame[]): ComponentInfo[] {
    const components: ComponentInfo[] = [];

    const findComponents = (frame: FigmaFrame) => {
      if (frame.type === 'COMPONENT') {
        components.push({
          id: frame.id,
          name: frame.name,
          children: frame.children,
        });
      }
      frame.children?.forEach(child => {
        if (child.type === 'COMPONENT') {
          components.push({
            id: child.id,
            name: child.name,
            children: child.children,
          });
        }
      });
    };

    frames.forEach(findComponents);
    return components;
  }
}

export default FigmaEngine;