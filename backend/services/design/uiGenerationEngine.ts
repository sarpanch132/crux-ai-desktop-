import { EventEmitter } from 'events';
import log from 'electron-log';

import { VisualAnalysis, DetectedComponent, ColorPalette, TypographyStyle } from './screenToUIEngine';
import { FigmaFrame, DesignToken } from './figmaEngine';

export type Framework = 'react' | 'next' | 'vue';
export type Styling = 'tailwind' | 'css' | 'styled';

export interface GenerationConfig {
  framework: Framework;
  styling: Styling;
  typescript: boolean;
  componentsDir: string;
  useShadcn: boolean;
  useFramerMotion: boolean;
  responsive: boolean;
}

export interface GeneratedCode {
  components: Map<string, string>;
  tokens: string;
  main: string;
  index: string;
}

export interface GenerationResult {
  success: boolean;
  code: GeneratedCode;
  confidence: number;
  warnings: string[];
}

export class UIGenerationEngine extends EventEmitter {
  private config: GenerationConfig;

  constructor(config: Partial<GenerationConfig> = {}) {
    super();
    this.config = {
      framework: config.framework ?? 'react',
      styling: config.styling ?? 'tailwind',
      typescript: config.typescript ?? true,
      componentsDir: config.componentsDir ?? 'components',
      useShadcn: config.useShadcn ?? true,
      useFramerMotion: config.useFramerMotion ?? false,
      responsive: config.responsive ?? true,
    };
  }

  async generateFromAnalysis(analysis: VisualAnalysis): Promise<GenerationResult> {
    log.info('Generating UI from visual analysis...');

    const code = new Map<string, string>();
    const warnings: string[] = [];

    const palette = this.generateColorTokens(analysis.colorPalette);
    const typography = this.generateTypographyTokens(analysis.typography);
    const spacing = this.generateSpacingTokens(analysis.spacing);
    
    code.set('tokens.css', this.generateTailwindConfig({ palette, typography, spacing }));

    for (const component of analysis.components) {
      const componentCode = this.generateComponent(component, analysis);
      code.set(`${component.type}.tsx`, componentCode);
    }

    const mainComponent = this.generateMainPage(analysis);
    code.set('App.tsx', mainComponent);

    const indexExport = this.generateIndexFile(code);
    code.set('index.tsx', indexExport);

    const confidence = this.calculateConfidence(analysis, code);

    return {
      success: true,
      code,
      confidence,
      warnings,
    };
  }

  async generateFromFigma(frames: FigmaFrame[], tokens: DesignToken[]): Promise<GenerationResult> {
    log.info('Generating UI from Figma design...');

    const code = new Map<string, string>();
    const warnings: string[] = [];

    const colorTokens = tokens.filter(t => t.type === 'color');
    const palette: ColorPalette = {
      primary: colorTokens.slice(0, 3).map(t => String(t.value)),
      secondary: colorTokens.slice(3, 6).map(t => String(t.value)),
      neutral: [],
      accent: [],
      semantic: { success: '#22c55e', warning: '#eab308', error: '#ef4444', info: '#3b82f6' },
    };

    code.set('tokens.css', this.generateTailwindConfig({
      palette,
      typography: [],
      spacing: { base: 4, scale: [0, 4, 8, 16, 24, 32, 48, 64] },
    }));

    for (const frame of frames) {
      const componentCode = this.generateFrameComponent(frame);
      code.set(`${this.sanitizeName(frame.name)}.tsx`, componentCode);
    }

    return {
      success: true,
      code,
      confidence: 0.85,
      warnings,
    };
  }

  private generateColorTokens(palette: ColorPalette): Record<string, string> {
    const colors: Record<string, string> = {};

    palette.primary.forEach((c, i) => {
      colors[`primary-${i + 1}`] = c;
    });
    palette.secondary.forEach((c, i) => {
      colors[`secondary-${i + 1}`] = c;
    });
    palette.neutral.forEach((c, i) => {
      colors[`neutral-${i + 1}`] = c;
    });
    palette.semantic.success && (colors['success'] = palette.semantic.success);
    palette.semantic.warning && (colors['warning'] = palette.semantic.warning);
    palette.semantic.error && (colors['error'] = palette.semantic.error);
    palette.semantic.info && (colors['info'] = palette.semantic.info);

    return colors;
  }

  private generateTypographyTokens(typography: TypographyStyle[]): Record<string, any> {
    const styles: Record<string, any> = {};

    typography.forEach((t, i) => {
      const size = Math.round(t.fontSize);
      styles[`text-${size}`] = {
        'font-size': `${t.fontSize}px`,
        'font-weight': t.fontWeight,
        'line-height': `${t.lineHeight}px`,
        'letter-spacing': `${t.letterSpacing}px`,
        color: t.color,
      };
    });

    return styles;
  }

  private generateSpacingTokens(spacing: { base: number; scale: number[] }): Record<string, string> {
    const scales: Record<string, string> = {};

    spacing.scale.forEach((s, i) => {
      scales[`space-${i}`] = `${s}px`;
    });

    return scales;
  }

  private generateTailwindConfig(tokens: { palette: Record<string, string>; typography: Record<string, any>; spacing: Record<string, string> }): string {
    return `/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: ${JSON.stringify(tokens.palette, null, 2)},
      spacing: ${JSON.stringify(tokens.spacing, null, 2)},
      fontSize: ${JSON.stringify(tokens.typography, null, 2)},
    },
  },
  plugins: [],
}
`;
  }

  private generateComponent(component: DetectedComponent, analysis: VisualAnalysis): string {
    const props = this.config.typescript ? 'Props' : '';
    const imports = this.getComponentImports(component);

    const tag = this.getHtmlTag(component.type);
    const className = this.generateClassName(component.styles, this.config.styling === 'tailwind');

    let children = '';
    if (component.children && component.children.length > 0) {
      children = component.children.map(child => {
        const childCode = this.generateComponent(child, analysis);
        return `  ${child}`;
      }).join('\n');
    }

    return `${imports}

export interface ${props} {
  className?: string;
}

export function ${this.toPascalCase(component.type)}({ className }: ${props}) {
  return (
    <${tag} className={className}>
      ${component.text || ''}
${children}
    </${tag}>
  );
}
`;
  }

  private getComponentImports(component: DetectedComponent): string {
    const imports = ['import React'];

    if (this.config.useShadcn) {
      switch (component.type) {
        case 'button':
          imports.push("import { Button } from '@/components/ui/button'");
          break;
        case 'input':
          imports.push("import { Input } from '@/components/ui/input'");
          break;
        case 'card':
          imports.push("import { Card, CardHeader, CardContent } from '@/components/ui/card'");
          break;
      }
    }

    if (this.config.useFramerMotion) {
      imports.push('import { motion } from framer-motion');
    }

    return imports.join('\n');
  }

  private getHtmlTag(type: string): string {
    const map: Record<string, string> = {
      button: 'button',
      input: 'input',
      card: 'div',
      navbar: 'nav',
      sidebar: 'aside',
      footer: 'footer',
      header: 'header',
      form: 'form',
      table: 'table',
      modal: 'div',
      menu: 'ul',
      dropdown: 'div',
      checkbox: 'input',
      toggle: 'button',
      avatar: 'div',
      badge: 'span',
      chip: 'span',
      tooltip: 'div',
      accordion: 'div',
      tabs: 'div',
      chart: 'div',
      icon: 'svg',
      text: 'span',
      image: 'img',
    };

    return map[type] || 'div';
  }

  private generateClassName(styles: ComponentStyles, tailwind: boolean): string {
    if (!tailwind) return '';

    const classes: string[] = [];

    if (styles.backgroundColor) {
      classes.push(`bg-[${styles.backgroundColor}]`);
    }
    if (styles.color) {
      classes.push(`text-[${styles.color}]`);
    }
    if (styles.borderRadius) {
      classes.push(`rounded-${Math.round(styles.borderRadius / 4)}`);
    }
    if (styles.padding) {
      const p = styles.padding;
      classes.push(`px-${p.left} py-${p.top}`);
    }
    if (styles.fontSize) {
      classes.push(`text-${Math.round(styles.fontSize / 2)}`);
    }
    if (styles.fontWeight) {
      classes.push(`font-${styles.fontWeight}`);
    }
    if (styles.shadow) {
      classes.push('shadow-md');
    }

    return classes.join(' ') || '';
  }

  private generateFrameComponent(frame: FigmaFrame): string {
    return `import React from 'react';

interface FrameProps {
  className?: string;
}

export function ${this.toPascalCase(frame.name)}({ className }: FrameProps) {
  return (
    <div 
      className={\`w-[${frame.width}px] h-[${frame.height}px] \${className || ''}\`}
      style={{ backgroundColor: '${this.rgbToHex(frame.backgroundColor)}' }}
    >
      ${frame.children.map(c => `<div key="${c.id}" />`).join('\n      ')}
    </div>
  );
}
`;
  }

  private generateMainPage(analysis: VisualAnalysis): string {
    return `import React from 'react';
${[...analysis.components.map((c, i) => `import ${this.toPascalCase(c.type)} from './${c.type}';`)].join('\n')}

export default function App() {
  return (
    <div className="min-h-screen bg-gray-50">
      ${analysis.components.map(c => `<${this.toPascalCase(c.type)} key="${c.id}" />`).join('\n      ')}
    </div>
  );
}
`;
  }

  private generateIndexFile(code: Map<string, string>): string {
    const exports = [...code.keys()].filter(k => k !== 'index.tsx').map(k => {
      const name = k.replace('.tsx', '');
      return `export * from './${name}';`;
    });

    return exports.join('\n');
  }

  private toPascalCase(str: string): string {
    return str
      .replace(/[-_](.)/g, (_, c) => c.toUpperCase())
      .replace(/^(.)/, (_, c) => c.toUpperCase());
  }

  private sanitizeName(name: string): string {
    return name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  }

  private rgbToHex(color?: { r: number; g: number; b: number; a?: number }): string {
    if (!color) return '#ffffff';
    const r = Math.round(color.r * 255);
    const g = Math.round(color.g * 255);
    const b = Math.round(color.b * 255);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  }

  private calculateConfidence(analysis: VisualAnalysis, code: Map<string, string>): number {
    let score = 0.5;

    if (analysis.colorPalette.primary.length > 0) score += 0.15;
    if (analysis.typography.length > 0) score += 0.15;
    if (analysis.components.length > 0) score += 0.2;

    return Math.min(score, 1);
  }
}

export default UIGenerationEngine;