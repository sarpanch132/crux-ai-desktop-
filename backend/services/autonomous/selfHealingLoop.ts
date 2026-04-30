import { EventEmitter } from 'events';
import log from 'electron-log';
import { TaskStep } from './autonomousAgent.js';

export interface FixResult {
  success: boolean;
  fix: string;
  result?: any;
  error?: string;
  attempts: number;
}

export interface FixAttempt {
  description: string;
  fix: string;
  error: string;
  succeeded: boolean;
  timestamp: number;
}

export interface SelfHealingConfig {
  maxAttempts: number;
  analyzeErrors: boolean;
  useAI: boolean;
  similarityThreshold: number;
}

const DEFAULT_CONFIG: SelfHealingConfig = {
  maxAttempts: 3,
  analyzeErrors: true,
  useAI: true,
  similarityThreshold: 0.8,
};

export class SelfHealingLoop extends EventEmitter {
  private config: SelfHealingConfig;
  private fixHistory: Map<string, FixAttempt[]> = new Map();
  private errorPatterns: Map<string, string[]> = new Map();

  constructor(config: Partial<SelfHealingConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };

    this.initializeErrorPatterns();
  }

  private initializeErrorPatterns(): void {
    this.errorPatterns.set('SyntaxError', [
      'Check for missing brackets or parentheses',
      'Verify proper line endings',
      'Check for missing commas between elements',
    ]);

    this.errorPatterns.set('ReferenceError', [
      'Check if the variable is defined before use',
      'Verify the import path is correct',
      'Check for typos in the variable name',
    ]);

    this.errorPatterns.set('TypeError', [
      'Check if the value is null or undefined',
      'Verify the correct type is being used',
      'Check method signatures',
    ]);

    this.errorPatterns.set('Module not found', [
      'Verify the package is installed',
      'Check the import path',
      'Run npm install',
    ]);

    this.errorPatterns.set('Test failed', [
      'Check the test expectations',
      'Verify the implementation matches expected behavior',
      'Check for race conditions',
    ]);
  }

  async analyzeAndFix(step: TaskStep, error: any): Promise<FixResult> {
    const errorMessage = error instanceof Error ? error.message : String(error);

    log.info(`Attempting to fix step ${step.id}: ${errorMessage}`);

    this.emit('fix:attempted', { stepId: step.id, error: errorMessage });

    const attempts: FixAttempt[] = [];

    for (let attempt = 0; attempt < this.config.maxAttempts; attempt++) {
      this.emit('fix:analyzing', { stepId: step.id, attempt: attempt + 1 });

      let fix: string;

      if (this.config.useAI) {
        fix = await this.generateAIFix(step, errorMessage, attempts);
      } else {
        fix = this.generatePatternFix(errorMessage, step);
      }

      this.emit('fix:generated', { stepId: step.id, fix, attempt: attempt + 1 });

      const fixAttempt: FixAttempt = {
        description: step.description,
        fix,
        error: errorMessage,
        succeeded: false,
        timestamp: Date.now(),
      };

      attempts.push(fixAttempt);

      const success = await this.applyFix(step, fix);

      if (success) {
        fixAttempt.succeeded = true;

        const result: FixResult = {
          success: true,
          fix,
          result: step.result,
          attempts: attempts.length,
        };

        this.recordFixAttempt(step.id, attempts);

        this.emit('fix:succeeded', { stepId: step.id, fix, attempts: attempts.length });

        return result;
      }

      log.warn(`Fix attempt ${attempt + 1} failed for ${step.id}`);
    }

    const finalError = attempts[attempts.length - 1]?.error || 'All fixes failed';

    this.recordFixAttempt(step.id, attempts);

    this.emit('fix:failed', { stepId: step.id, error: finalError });

    return {
      success: false,
      fix: attempts[attempts.length - 1]?.fix || '',
      error: finalError,
      attempts: attempts.length,
    };
  }

  private async generateAIFix(step: TaskStep, error: string, previousAttempts: FixAttempt[]): Promise<string> {
    const { AIService } = await import('./aiService.js');

    const prompt = `Fix the error in this step:

Step: ${step.description}
Error: ${error}
Type: ${step.type}
${previousAttempts.length > 0 ? `Previous attempts: ${JSON.stringify(previousAttempts.map(a => a.fix))}` : ''}

Provide a specific fix to apply. Be concise and actionable.`;

    try {
      const response = await AIService.chat([
        { role: 'system', content: 'You are an expert code fixer. Provide precise fixes.' },
        { role: 'user', content: prompt },
      ]);

      return response.trim();
    } catch (error) {
      log.warn('AI fix generation failed:', error);
      return this.generatePatternFix(error, step);
    }
  }

  private generatePatternFix(error: string, step: TaskStep): string {
    for (const [pattern, fixes] of this.errorPatterns) {
      if (error.includes(pattern)) {
        return fixes[Math.floor(Math.random() * fixes.length)];
      }
    }

    return `Review and fix: ${step.description}`;
  }

  private async applyFix(step: TaskStep, fix: string): Promise<boolean> {
    try {
      switch (step.type) {
        case 'execute':
          return await this.applyCommandFix(step, fix);

        case 'write':
        case 'edit':
          return await this.applyCodeFix(step, fix);

        default:
          return true;
      }
    } catch (error) {
      log.warn('Apply fix failed:', error);
      return false;
    }
  }

  private async applyCommandFix(step: TaskStep, fix: string): Promise<boolean> {
    const { ToolRegistry } = await import('./toolRegistry.js');
    const registry = new ToolRegistry(process.cwd());

    if (fix.toLowerCase().includes('npm install')) {
      await registry.execute({
        tool: 'terminal',
        method: 'execute',
        params: { command: 'npm install' },
      });
    }

    if (fix.toLowerCase().includes('git reset')) {
      await registry.execute({
        tool: 'terminal',
        method: 'execute',
        params: { command: 'git reset --hard HEAD' },
      });
    }

    return true;
  }

  private async applyCodeFix(step: TaskStep, fix: string): Promise<boolean> {
    const { FileTool } = await import('../tools/fileTool.js');
    const fileTool = new FileTool();

    if (step.result?.path) {
      const readResult = await fileTool.read({ path: step.result.path });

      if (readResult.success && readResult.content) {
        let content = readResult.content;

        if (fix.includes('add console.log')) {
          content += '\nconsole.log("Debug");\n';
        }

        if (fix.includes('add error handling')) {
          content = content.replace(
            /(async\s+\([^)]*\)\s*=>\s*\{)/,
            '$1\n  try {\n    // code\n  } catch (error) {\n    console.error(error);\n  }'
          );
        }

        await fileTool.write({ path: step.result.path, content });
      }
    }

    return true;
  }

  private recordFixAttempt(stepId: string, attempts: FixAttempt[]): void {
    this.fixHistory.set(stepId, attempts);
  }

  getFixAttemptHistory(stepId: string): FixAttempt[] {
    return this.fixHistory.get(stepId) || [];
  }

  getStats(): {
    totalAttempts: number;
    successRate: number;
    avgAttemptsPerFix: number;
  } {
    let totalAttempts = 0;
    let successfulFixes = 0;

    for (const attempts of this.fixHistory.values()) {
      totalAttempts += attempts.length;
      if (attempts.some(a => a.succeeded)) {
        successfulFixes++;
      }
    }

    return {
      totalAttempts,
      successRate: this.fixHistory.size > 0 ? successfulFixes / this.fixHistory.size : 0,
      avgAttemptsPerFix: successfulFixes > 0 ? totalAttempts / successfulFixes : 0,
    };
  }

  clearHistory(): void {
    this.fixHistory.clear();
  }

  addErrorPattern(error: string, fixes: string[]): void {
    this.errorPatterns.set(error, fixes);
  }
}

export default SelfHealingLoop;