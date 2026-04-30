import { EventEmitter } from 'events';
import log from 'electron-log';
import { v4 as uuidv4 } from 'uuid';

export interface Reflection {
  id: string;
  task: string;
  result: any;
  steps: any[];
  analysis: ReflectionAnalysis;
  timestamp: number;
}

export interface ReflectionAnalysis {
  whatWorked: string[];
  whatFailed: string[];
  lessonsLearned: string[];
  improvements: string[];
  unexpectedIssues: string[];
}

export interface ReflectionSummary {
  totalReflections: number;
  commonFailures: string[];
  commonImprovements: string[];
  successPattern: string[];
  failurePattern: string[];
}

export class ReflectionEngine extends EventEmitter {
  private reflections: Map<string, Reflection> = new Map();
  private maxReflections: number;

  constructor(config?: { maxReflections?: number }) {
    super();
    this.maxReflections = config?.maxReflections || 1000;
  }

  async record(data: {
    task: string;
    result: any;
    steps: any[];
  time?: number;
  maxReflections?: number;
  }): Promise<Reflection> {
    const analysis = await this.analyzeExecution(data.task, data.result, data.steps);

    const reflection: Reflection = {
      id: uuidv4(),
      task: data.task,
      result: data.result,
      steps: data.steps,
      analysis,
      timestamp: data.time || Date.now(),
    };

    this.reflections.set(reflection.id, reflection);

    if (this.reflections.size > this.maxReflections) {
      this.evictOldest();
    }

    this.emit('reflection:recorded', reflection);

    log.debug(`Recorded reflection for: ${data.task}`);

    return reflection;
  }

  private async analyzeExecution(
    task: string,
    result: any,
    steps: any[]
  ): Promise<ReflectionAnalysis> {
    const { AIService } = await import('./aiService.js');

    const success = result?.success !== false;
    const failedSteps = steps.filter(s => s.status === 'failed');
    const completedSteps = steps.filter(s => s.status === 'completed');

    const prompt = `Analyze this execution:

Task: ${task}
Success: ${success}
Completed steps: ${completedSteps.length}
Failed steps: ${failedSteps.length}
${failedSteps.length > 0 ? `Failed: ${JSON.stringify(failedSteps.map(s => s.error || s.description))}` : ''}

Provide a brief analysis with:
1. What worked (whatWorked array)
2. What failed (whatFailed array) 
3. Lessons learned (lessonsLearned array)
4. Suggested improvements (improvements array)
5. Unexpected issues (unexpectedIssues array)

Respond as JSON with these keys only.`;

    try {
      const response = await AIService.chat([
        { role: 'system', content: 'Analyze coding executions concisely.' },
        { role: 'user', content: prompt },
      ]);

      const parsed = JSON.parse(response);
      return parsed;
    } catch (error) {
      return {
        whatWorked: completedSteps.map(s => s.description),
        whatFailed: failedSteps.map(s => s.error || 'Failed step'),
        lessonsLearned: [],
        improvements: failedSteps.map(s => `Fix: ${s.description}`),
        unexpectedIssues: [],
      };
    }
  }

  private evictOldest(): void {
    const sorted = Array.from(this.reflections.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp);

    const toRemove = sorted.slice(0, Math.floor(this.maxReflections * 0.2));
    
    for (const [id] of toRemove) {
      this.reflections.delete(id);
    }
  }

  getRecentReflections(limit = 10): Reflection[] {
    return Array.from(this.reflections.values())
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  getReflection(reflectionId: string): Reflection | undefined {
    return this.reflections.get(reflectionId);
  }

  getSummary(): ReflectionSummary {
    const reflections = Array.from(this.reflections.values());

    if (reflections.length === 0) {
      return {
        totalReflections: 0,
        commonFailures: [],
        commonImprovements: [],
        successPattern: [],
        failurePattern: [],
      };
    }

    const analysis = reflections.map(r => r.analysis);

    const allFailures = analysis.flatMap(a => a.whatFailed);
    const allImprovements = analysis.flatMap(a => a.improvements);
    const allLessons = analysis.flatMap(a => a.lessonsLearned);

    const failureFrequency = this.frequencyCount(allFailures);
    const improvementFrequency = this.frequencyCount(allImprovements);

    return {
      totalReflections: reflections.length,
      commonFailures: this.topKFrequent(failureFrequency, 5),
      commonImprovements: this.topKFrequent(improvementFrequency, 5),
      successPattern: this.topKFrequent(
        this.frequencyCount(analysis.flatMap(a => a.whatWorked)),
        3
      ),
      failurePattern: this.topKFrequent(failureFrequency, 3),
    };
  }

  private frequencyCount(items: string[]): Map<string, number> {
    const count = new Map<string, number>();

    for (const item of items) {
      if (!item) continue;
      count.set(item, (count.get(item) || 0) + 1);
    }

    return count;
  }

  private topKFrequent(frequency: Map<string, number>, k: number): string[] {
    return Array.from(frequency.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, k)
      .map(([item]) => item);
  }

  getLessonsLearned(): string[] {
    const allLessons = Array.from(this.reflections.values())
      .flatMap(r => r.analysis.lessonsLearned);

    return [...new Set(allLessons)];
  }

  clear(): void {
    this.reflections.clear();
    log.info('Reflection history cleared');
  }

  getStats(): {
    total: number;
    successRate: number;
    avgStepsPerTask: number;
  } {
    const reflections = Array.from(this.reflections.values());
    
    const successCount = reflections.filter(r => r.result?.success !== false).length;
    const avgSteps = reflections.length > 0 
      ? reflections.reduce((sum, r) => sum + r.steps.length, 0) / reflections.length 
      : 0;

    return {
      total: reflections.length,
      successRate: reflections.length > 0 ? successCount / reflections.length : 0,
      avgStepsPerTask: avgSteps,
    };
  }
}

export default ReflectionEngine;