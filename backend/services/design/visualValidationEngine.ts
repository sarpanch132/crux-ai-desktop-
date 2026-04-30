import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import log from 'electron-log';

import { VisualAnalysis } from './screenToUIEngine';
import { UIGenerationEngine, GenerationResult } from './uiGenerationEngine';

export interface ValidationResult {
  score: number;
  differences: VisualDifference[];
  metrics: ValidationMetrics;
  passed: boolean;
}

export interface VisualDifference {
  type: 'color' | 'spacing' | 'typography' | 'layout' | 'missing' | 'extra';
  severity: 'critical' | 'major' | 'minor';
  description: string;
  location?: { x: number; y: number; width: number; height: number };
  expected?: string;
  actual?: string;
}

export interface ValidationMetrics {
  colorAccuracy: number;
  layoutAccuracy: number;
  componentAccuracy: number;
  accessibilityScore: number;
}

export interface RefinementResult {
  iterations: number;
  finalScore: number;
  improvements: string[];
  finalCode: GenerationResult;
}

export class VisualValidationEngine extends EventEmitter {
  private generationEngine: UIGenerationEngine;
  private maxIterations: number = 5;
  private similarityThreshold: number = 85;
  private playwrightPath: string = '';

  constructor() {
    super();
    this.generationEngine = new UIGenerationEngine();
  }

  async validate(sourceAnalysis: VisualAnalysis, generatedCode: GenerationResult): Promise<ValidationResult> {
    log.info('Starting visual validation...');

    const differences: VisualDifference[] = [];

    differences.push(...this.validateColors(sourceAnalysis));
    differences.push(...this.validateTypography(sourceAnalysis));
    differences.push(...this.validateLayout(sourceAnalysis));
    differences.push(...this.validateComponents(sourceAnalysis));

    const metrics: ValidationMetrics = {
      colorAccuracy: this.calculateColorAccuracy(differences),
      layoutAccuracy: this.calculateLayoutAccuracy(differences),
      componentAccuracy: this.calculateComponentAccuracy(differences),
      accessibilityScore: this.calculateAccessibilityScore(sourceAnalysis),
    };

    const score = this.calculateOverallScore(metrics);

    return {
      score,
      differences,
      metrics,
      passed: score >= this.similarityThreshold,
    };
  }

  async refine(
    sourceAnalysis: VisualAnalysis,
    currentCode: GenerationResult,
    validation: ValidationResult
  ): Promise<RefinementResult> {
    log.info('Starting refinement loop...');

    const improvements: string[] = [];
    let code = currentCode;
    let score = validation.score;
    let iteration = 0;

    while (iteration < this.maxIterations && score < this.similarityThreshold) {
      iteration++;

      log.info(`Refinement iteration ${iteration}...`);

      const refinements = this.generateRefinements(validation.differences);
      improvements.push(...refinements);

      code = await this.applyRefinements(code, refinements);

      const newValidation = await this.validate(sourceAnalysis, code);
      score = newValidation.score;

      this.emit('refine:iteration', { iteration, score, differences: newValidation.differences });

      if (score >= this.similarityThreshold) {
        break;
      }
    }

    return {
      iterations: iteration,
      finalScore: score,
      improvements,
      finalCode: code,
    };
  }

  private validateColors(analysis: VisualAnalysis): VisualDifference[] {
    const differences: VisualDifference[] = [];

    if (!analysis.colorPalette.primary || analysis.colorPalette.primary.length === 0) {
      differences.push({
        type: 'color',
        severity: 'major',
        description: 'No primary colors detected',
      });
    }

    if (!analysis.colorPalette.neutral || analysis.colorPalette.neutral.length < 3) {
      differences.push({
        type: 'color',
        severity: 'minor',
        description: 'Limited neutral color palette',
      });
    }

    return differences;
  }

  private validateTypography(analysis: VisualAnalysis): VisualDifference[] {
    const differences: VisualDifference[] = [];

    if (!analysis.typography || analysis.typography.length === 0) {
      differences.push({
        type: 'typography',
        severity: 'major',
        description: 'No typography styles detected',
      });
    }

    const hasHeading = analysis.typography.some(t => t.fontSize >= 24);
    const hasBody = analysis.typography.some(t => t.fontSize >= 14 && t.fontSize <= 16);

    if (!hasHeading) {
      differences.push({
        type: 'typography',
        severity: 'minor',
        description: 'No heading typography detected',
      });
    }

    if (!hasBody) {
      differences.push({
        type: 'typography',
        severity: 'minor',
        description: 'No body typography detected',
      });
    }

    return differences;
  }

  private validateLayout(analysis: VisualAnalysis): VisualDifference[] {
    const differences: VisualDifference[] = [];

    if (!analysis.spacing.scale || analysis.spacing.scale.length < 4) {
      differences.push({
        type: 'spacing',
        severity: 'major',
        description: 'Inconsistent spacing system detected',
      });
    }

    if (!analysis.borderRadius || analysis.borderRadius.length === 0) {
      differences.push({
        type: 'layout',
        severity: 'minor',
        description: 'No border radius detected',
      });
    }

    return differences;
  }

  private validateComponents(analysis: VisualAnalysis): VisualDifference[] {
    const differences: VisualDifference[] = [];

    const expectedComponents = ['button', 'input', 'card'];
    const foundTypes = analysis.components.map(c => c.type);

    for (const expected of expectedComponents) {
      if (!foundTypes.includes(expected as any)) {
        differences.push({
          type: 'missing',
          severity: 'major',
          description: `Expected ${expected} component not found`,
        });
      }
    }

    return differences;
  }

  private calculateColorAccuracy(differences: VisualDifference[]): number {
    const colorDiffs = differences.filter(d => d.type === 'color');
    if (colorDiffs.length === 0) return 100;
    const penalty = colorDiffs.reduce((sum, d) => {
      return sum + (d.severity === 'critical' ? 25 : d.severity === 'major' ? 15 : 5);
    }, 0);
    return Math.max(0, 100 - penalty);
  }

  private calculateLayoutAccuracy(differences: VisualDifference[]): number {
    const layoutDiffs = differences.filter(d => d.type === 'layout' || d.type === 'spacing');
    if (layoutDiffs.length === 0) return 100;
    const penalty = layoutDiffs.reduce((sum, d) => {
      return sum + (d.severity === 'critical' ? 25 : d.severity === 'major' ? 15 : 5);
    }, 0);
    return Math.max(0, 100 - penalty);
  }

  private calculateComponentAccuracy(differences: VisualDifference[]): number {
    const componentDiffs = differences.filter(d => d.type === 'missing' || d.type === 'extra');
    if (componentDiffs.length === 0) return 100;
    const penalty = componentDiffs.reduce((sum, d) => {
      return sum + (d.severity === 'critical' ? 30 : d.severity === 'major' ? 20 : 10);
    }, 0);
    return Math.max(0, 100 - penalty);
  }

  private calculateAccessibilityScore(analysis: VisualAnalysis): number {
    let score = 100;

    const hasContrastColors = analysis.colorPalette.neutral && analysis.colorPalette.neutral.length > 2;
    if (!hasContrastColors) score -= 15;

    const hasProperTypography = analysis.typography && analysis.typography.some(t => t.fontSize >= 16);
    if (!hasProperTypography) score -= 15;

    return Math.max(0, score);
  }

  private calculateOverallScore(metrics: ValidationMetrics): number {
    return (
      metrics.colorAccuracy * 0.25 +
      metrics.layoutAccuracy * 0.25 +
      metrics.componentAccuracy * 0.35 +
      metrics.accessibilityScore * 0.15
    );
  }

  private generateRefinements(differences: VisualDifference[]): string[] {
    const refinements: string[] = [];

    for (const diff of differences) {
      if (diff.type === 'color' && diff.severity !== 'minor') {
        refinements.push('Add missing color tokens to design system');
      }

      if (diff.type === 'typography') {
        refinements.push('Add typography scale with proper font sizes');
      }

      if (diff.type === 'spacing') {
        refinements.push('Implement consistent spacing system');
      }

      if (diff.type === 'missing') {
        refinements.push(`Generate ${diff.description.replace('Expected ', '').replace(' component not found', '')} component`);
      }
    }

    return [...new Set(refinements)];
  }

  private async applyRefinements(code: GenerationResult, refinements: string[]): Promise<GenerationResult> {
    return code;
  }

  async compareScreenshots(sourcePath: string, generatedPath: string): Promise<number> {
    return 0;
  }

  generateReport(validation: ValidationResult): string {
    return `# Visual Validation Report

## Overall Score
${validation.score.toFixed(1)}% - ${validation.passed ? 'PASSED' : 'FAILED'}

## Metrics
- Color Accuracy: ${validation.metrics.colorAccuracy.toFixed(1)}%
- Layout Accuracy: ${validation.metrics.layoutAccuracy.toFixed(1)}%
- Component Accuracy: ${validation.metrics.componentAccuracy.toFixed(1)}%
- Accessibility: ${validation.metrics.accessibilityScore.toFixed(1)}%

## Differences Found
${validation.differences.map(d => `- [${d.severity.toUpperCase()}] ${d.type}: ${d.description}`).join('\n')}
`;
  }
}

export const visualValidation = new VisualValidationEngine();
export default VisualValidationEngine;