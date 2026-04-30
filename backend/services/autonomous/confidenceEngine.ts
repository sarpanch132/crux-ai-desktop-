import { EventEmitter } from 'events';
import log from 'electron-log';

export interface ConfidenceFactors {
  testResults: number;
  previousSuccessRate: number;
  errorHistory: number;
  codeChanges: number;
  complexity: number;
  dependencies: number;
}

export interface ConfidenceScore {
  overall: number;
  factors: ConfidenceFactors;
  breakdown: {
    testScore: number;
    historyScore: number;
    changeScore: number;
    dependencyScore: number;
  };
  recommendation: 'proceed' | 'review' | 'stop';
}

export interface ConfidenceConfig {
  weights: Partial<ConfidenceFactors>;
  thresholds: {
    proceed: number;
    review: number;
    stop: number;
  };
}

const DEFAULT_CONFIG: ConfidenceConfig = {
  weights: {
    testResults: 0.4,
    previousSuccessRate: 0.25,
    errorHistory: 0.15,
    codeChanges: 0.1,
    complexity: 0.05,
    dependencies: 0.05,
  },
  thresholds: {
    proceed: 0.8,
    review: 0.5,
    stop: 0.3,
  },
};

export class ConfidenceEngine extends EventEmitter {
  private config: ConfidenceConfig;
  private executionHistory: Map<string, { success: boolean; confidence: number; timestamp: number }> = new Map();

  constructor(config: Partial<ConfidenceConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async calculate(task: any, history: any[] = []): Promise<ConfidenceScore> {
    const factors: ConfidenceFactors = {
      testResults: await this.evaluateTestResults(task),
      previousSuccessRate: this.evaluatePreviousSuccess(history),
      errorHistory: this.evaluateErrorHistory(task),
      codeChanges: this.evaluateCodeChanges(task),
      complexity: this.evaluateComplexity(task),
      dependencies: this.evaluateDependencies(task),
    };

    const weights = this.config.weights;

    const breakdown = {
      testScore: factors.testResults * weights.testResults,
      historyScore: factors.previousSuccessRate * weights.previousSuccessRate,
      changeScore: (1 - factors.errorHistory) * weights.errorHistory,
      dependencyScore: factors.dependencies * weights.dependencies,
    };

    const overall = Object.values(breakdown).reduce((sum, score) => sum + score, 0);

    let recommendation: 'proceed' | 'review' | 'stop';

    if (overall >= this.config.thresholds.proceed) {
      recommendation = 'proceed';
    } else if (overall >= this.config.thresholds.review) {
      recommendation = 'review';
    } else {
      recommendation = 'stop';
    }

    this.emit('confidence:calculated', { overall, recommendation, factors });

    return {
      overall,
      factors,
      breakdown,
      recommendation,
    };
  }

  private async evaluateTestResults(task: any): Promise<number> {
    if (!task.steps) return 0.5;

    const testSteps = task.steps.filter((s: any) => s.type === 'test');
    
    if (testSteps.length === 0) return 0.6;

    const passedTests = testSteps.filter((s: any) => s.status === 'completed').length;
    const totalTests = testSteps.length;

    return passedTests / totalTests;
  }

  private evaluatePreviousSuccess(history: any[]): number {
    if (history.length === 0) return 0.5;

    const recentHistory = history.slice(-10);
    const successfulCount = recentHistory.filter((r: any) => r.success).length;

    return successfulCount / recentHistory.length;
  }

  private evaluateErrorHistory(task: any): number {
    if (!task.steps) return 0.5;

    const failedSteps = task.steps.filter((s: any) => s.status === 'failed').length;
    const totalSteps = task.steps.length;

    if (totalSteps === 0) return 0.5;

    return 1 - (failedSteps / totalSteps);
  }

  private evaluateCodeChanges(task: any): number {
    if (!task.steps) return 0.5;

    const editSteps = task.steps.filter((s: any) => 
      s.type === 'write' || s.type === 'edit'
    ).length;

    if (editSteps === 0) return 1;

    if (editSteps <= 2) return 0.9;
    if (editSteps <= 5) return 0.7;
    if (editSteps <= 10) return 0.5;

    return 0.3;
  }

  private evaluateComplexity(task: any): number {
    if (!task.steps) return 0.5;

    const totalSteps = task.steps.length;

    if (totalSteps <= 3) return 1;
    if (totalSteps <= 5) return 0.9;
    if (totalSteps <= 10) return 0.7;
    if (totalSteps <= 20) return 0.5;

    return 0.3;
  }

  private evaluateDependencies(task: any): number {
    if (!task.steps) return 0.5;

    const executeSteps = task.steps.filter((s: any) => s.type === 'execute').length;

    if (executeSteps === 0) return 1;

    if (executeSteps === 1) return 0.8;
    if (executeSteps <= 3) return 0.6;

    return 0.4;
  }

  async evaluateBeforeExecution(description: string, context?: any): Promise<ConfidenceScore> {
    const factors: ConfidenceFactors = {
      testResults: 0.5,
      previousSuccessRate: 0.5,
      errorHistory: 0.5,
      codeChanges: 0.5,
      complexity: description.length < 100 ? 0.9 : 0.5,
      dependencies: 0.5,
    };

    const weights = this.config.weights;

    let testScore = 0;
    testScore += factors.testResults * weights.testResults;
    testScore += factors.previousSuccessRate * weights.previousSuccessRate;
    testScore += (1 - factors.errorHistory) * weights.errorHistory;
    testScore += factors.codeChanges * weights.codeChanges;
    testScore += factors.complexity * weights.complexity;
    testScore += factors.dependencies * weights.dependencies;

    let recommendation: 'proceed' | 'review' | 'stop';

    if (testScore >= this.config.thresholds.proceed) {
      recommendation = 'proceed';
    } else if (testScore >= this.config.thresholds.review) {
      recommendation = 'review';
    } else {
      recommendation = 'stop';
    }

    this.emit('confidence:pre-execution', { description, score: testScore, recommendation });

    return {
      overall: testScore,
      factors,
      breakdown: {
        testScore: factors.testResults * weights.testResults,
        historyScore: factors.previousSuccessRate * weights.previousSuccessRate,
        changeScore: (1 - factors.errorHistory) * weights.errorHistory,
        dependencyScore: factors.dependencies * weights.dependencies,
      },
      recommendation,
    };
  }

  async evaluateAfterExecution(result: any): Promise<ConfidenceScore> {
    const task = result.task || {};
    const history = Array.from(this.executionHistory.values());

    const score = await this.calculate(task, history);

    const taskId = `task_${Date.now()}`;
    this.executionHistory.set(taskId, {
      success: result.success || false,
      confidence: score.overall,
      timestamp: Date.now(),
    });

    if (this.executionHistory.size > 100) {
      const oldEntries = Array.from(this.executionHistory.keys()).slice(0, 10);
      for (const key of oldEntries) {
        this.executionHistory.delete(key);
      }
    }

    return score;
  }

  recordResult(taskId: string, success: boolean, confidence: number): void {
    this.executionHistory.set(taskId, {
      success,
      confidence,
      timestamp: Date.now(),
    });
  }

  getStats(): {
    avgConfidence: number;
    successRate: number;
    totalExecutions: number;
  } {
    const entries = Array.from(this.executionHistory.values());

    const avgConfidence = entries.length > 0
      ? entries.reduce((sum, e) => sum + e.confidence, 0) / entries.length
      : 0;

    const successCount = entries.filter(e => e.success).length;

    return {
      avgConfidence,
      successRate: entries.length > 0 ? successCount / entries.length : 0,
      totalExecutions: entries.length,
    };
  }

  setThresholds(thresholds: Partial<ConfidenceConfig['thresholds']>): void {
    this.config.thresholds = { ...this.config.thresholds, ...thresholds };
  }

  setWeights(weights: Partial<ConfidenceFactors>): void {
    this.config.weights = { ...this.config.weights, ...weights };
  }

  clearHistory(): void {
    this.executionHistory.clear();
  }
}

export default ConfidenceEngine;