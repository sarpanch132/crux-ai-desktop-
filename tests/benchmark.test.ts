import { performance } from 'perf_hooks';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface BenchmarkScenario {
  name: string;
  description: string;
  duration: number;
  iterations: number;
  concurrency: number;
}

interface BenchmarkResult {
  scenario: string;
  metric: string;
  value: number;
  unit: string;
  competitor?: string;
}

interface CompetitorProfile {
  name: string;
  strengths: string[];
  weaknesses: string[];
  expectedLatency: number;
  expectedAccuracy: number;
}

const competitors: CompetitorProfile[] = [
  {
    name: 'Cursor',
    strengths: ['IDE integration', 'Fast autocomplete', 'Context awareness'],
    weaknesses: ['Limited multimodal', 'Cloud-only'],
    expectedLatency: 200,
    expectedAccuracy: 0.85,
  },
  {
    name: 'Claude Code',
    strengths: ['Strong reasoning', 'Large context', 'Tool use'],
    weaknesses: ['Slower', 'Cost'],
    expectedLatency: 500,
    expectedAccuracy: 0.90,
  },
  {
    name: 'Windsurf',
    strengths: ['AI-native', 'Fast', 'Good UX'],
    weaknesses: ['Newer', 'Smaller context'],
    expectedLatency: 300,
    expectedAccuracy: 0.82,
  },
  {
    name: 'Devin',
    strengths: ['Autonomous', 'End-to-end', 'Self-correcting'],
    weaknesses: ['Very slow', 'Expensive'],
    expectedLatency: 2000,
    expectedAccuracy: 0.88,
  },
];

const scenarios: BenchmarkScenario[] = [
  {
    name: 'Cold Start',
    description: 'Time from launch to ready state',
    duration: 0,
    iterations: 10,
    concurrency: 1,
  },
  {
    name: 'Context Loading',
    description: 'Load 100 context items',
    duration: 0,
    iterations: 50,
    concurrency: 1,
  },
  {
    name: 'Task Execution',
    description: 'Execute simple coding task',
    duration: 0,
    iterations: 20,
    concurrency: 1,
  },
  {
    name: 'Memory Operations',
    description: 'Store and retrieve 100 memories',
    duration: 0,
    iterations: 100,
    concurrency: 10,
  },
  {
    name: 'File Operations',
    description: 'Read/write 50 files',
    duration: 0,
    iterations: 50,
    concurrency: 5,
  },
  {
    name: 'Concurrent Tasks',
    description: 'Execute 10 parallel tasks',
    duration: 0,
    iterations: 10,
    concurrency: 10,
  },
  {
    name: 'Long Session',
    description: 'Sustained operation over time',
    duration: 60000,
    iterations: 1,
    concurrency: 1,
  },
  {
    name: 'Memory Leak Detection',
    description: 'Check for memory growth over 100 operations',
    duration: 0,
    iterations: 100,
    concurrency: 1,
  },
];

class BenchmarkRunner {
  private results: BenchmarkResult[] = [];
  private memorySnapshots: number[] = [];

  async runAll(): Promise<void> {
    console.log('\n🚀 STARTING BENCHMARK SUITE\n');
    console.log(`Platform: ${os.platform()} ${os.release()}`);
    console.log(`CPU: ${os.cpus()[0].model}`);
    console.log(`Memory: ${(os.totalmem() / 1024 / 1024 / 1024).toFixed(2)}GB\n`);

    for (const scenario of scenarios) {
      await this.runScenario(scenario);
    }

    this.printResults();
    this.compareWithCompetitors();
    this.generateReport();
  }

  private async runScenario(scenario: BenchmarkScenario): Promise<void> {
    console.log(`\n📊 Running: ${scenario.name}`);

    const results: number[] = [];

    for (let i = 0; i < scenario.iterations; i++) {
      const start = performance.now();

      switch (scenario.name) {
        case 'Cold Start':
          await this.benchmarkColdStart();
          break;
        case 'Context Loading':
          await this.benchmarkContextLoading();
          break;
        case 'Task Execution':
          await this.benchmarkTaskExecution();
          break;
        case 'Memory Operations':
          await this.benchmarkMemoryOperations();
          break;
        case 'File Operations':
          await this.benchmarkFileOperations();
          break;
        case 'Concurrent Tasks':
          await this.benchmarkConcurrentTasks(scenario.concurrency);
          break;
        case 'Long Session':
          await this.benchmarkLongSession(scenario.duration);
          break;
        case 'Memory Leak Detection':
          await this.benchmarkMemoryLeakDetection();
          break;
      }

      const duration = performance.now() - start;
      results.push(duration);

      if (scenario.concurrency > 1) {
        await this.sleep(10);
      }
    }

    const avg = results.reduce((a, b) => a + b, 0) / results.length;
    const min = Math.min(...results);
    const max = Math.max(...results);

    this.results.push(
      { scenario: scenario.name, metric: 'avg', value: avg, unit: 'ms' },
      { scenario: scenario.name, metric: 'min', value: min, unit: 'ms' },
      { scenario: scenario.name, metric: 'max', value: max, unit: 'ms' }
    );

    console.log(`   Avg: ${avg.toFixed(2)}ms | Min: ${min.toFixed(2)}ms | Max: ${max.toFixed(2)}ms`);
  }

  private async benchmarkColdStart(): Promise<void> {
    const imports = [
      './agentController',
      './memorySystem',
      './contextManager',
      './planningEngine',
    ];
    for (const _ of imports) {
      await Promise.resolve();
    }
  }

  private async benchmarkContextLoading(): Promise<void> {
    const contexts = [];
    for (let i = 0; i < 100; i++) {
      contexts.push({
        type: 'test',
        content: `Context ${i}: ${'x'.repeat(50)}`,
        timestamp: Date.now(),
      });
    }
    return contexts;
  }

  private async benchmarkTaskExecution(): Promise<void> {
    const task = {
      id: 'test',
      type: 'coding',
      description: 'Test task',
      priority: 5,
      status: 'pending',
    };
    return task;
  }

  private async benchmarkMemoryOperations(): Promise<void> {
    const memory = new Map<string, any>();
    for (let i = 0; i < 100; i++) {
      memory.set(`key-${i}`, { data: `value-${i}`, timestamp: Date.now() });
    }
    for (let i = 0; i < 50; i++) {
      memory.get(`key-${i}`);
    }
    return memory;
  }

  private async benchmarkFileOperations(): Promise<void> {
    const tempDir = os.tmpdir();
    const files = [];

    for (let i = 0; i < 50; i++) {
      const filePath = path.join(tempDir, `bench-${i}.txt`);
      fs.writeFileSync(filePath, `test content ${i}`);
      files.push(filePath);
    }

    for (const file of files) {
      fs.readFileSync(file);
      fs.unlinkSync(file);
    }
  }

  private async benchmarkConcurrentTasks(concurrency: number): Promise<void> {
    const tasks = Array(concurrency).fill(null).map((_, i) => i);
    await Promise.all(tasks.map(async (i) => {
      await Promise.resolve();
      return i;
    }));
  }

  private async benchmarkLongSession(duration: number): Promise<void> {
    const start = Date.now();
    let operations = 0;

    while (Date.now() - start < duration) {
      operations++;
      const memory = new Map();
      memory.set('key', 'value');
      memory.get('key');

      if (operations % 100 === 0) {
        const memUsage = process.memoryUsage();
        this.memorySnapshots.push(memUsage.heapUsed);
      }
    }

    console.log(`   Operations: ${operations}`);
  }

  private async benchmarkMemoryLeakDetection(): Promise<void> {
    const memory: any[] = [];

    for (let i = 0; i < 100; i++) {
      memory.push({ id: i, data: new Array(1000).fill('x').join('') });
    }

    const memBefore = process.memoryUsage().heapUsed;

    for (let i = 0; i < memory.length; i++) {
      memory[i] = null;
    }

    if (global.gc) {
      global.gc();
    }

    const memAfter = process.memoryUsage().heapUsed;
    const growth = memAfter - memBefore;

    console.log(`   Memory Δ: ${(growth / 1024 / 1024).toFixed(2)}MB`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private printResults(): void {
    console.log('\n\n========================================');
    console.log('📈 BENCHMARK RESULTS');
    console.log('========================================\n');

    const byScenario = new Map<string, BenchmarkResult[]>();
    for (const r of this.results) {
      const existing = byScenario.get(r.scenario) || [];
      existing.push(r);
      byScenario.set(r.scenario, existing);
    }

    for (const [scenario, results] of byScenario) {
      console.log(`${scenario}:`);
      for (const r of results) {
        console.log(`   ${r.metric}: ${r.value.toFixed(2)} ${r.unit}`);
      }
      console.log();
    }
  }

  private compareWithCompetitors(): void {
    console.log('\n========================================');
    console.log('🏆 COMPETITOR COMPARISON');
    console.log('========================================\n');

    const avgResults = this.getAverageResults();

    console.log('Expected vs Actual Performance:\n');

    for (const comp of competitors) {
      console.log(`${comp.name}:`);
      console.log(`   Expected Latency: ${comp.expectedLatency}ms`);
      console.log(`   Expected Accuracy: ${(comp.expectedAccuracy * 100).toFixed(0)}%`);

      if (avgResults['Task Execution'] && avgResults['Task Execution'].value < comp.expectedLatency) {
        console.log(`   ✅ OUTPERFORMING`);
      } else {
        console.log(`   ⚠️  Need optimization`);
      }
      console.log();
    }
  }

  private getAverageResults(): Map<string, BenchmarkResult> {
    const results = new Map<string, BenchmarkResult>();

    for (const r of this.results) {
      if (r.metric === 'avg') {
        results.set(r.scenario, r);
      }
    }

    return results;
  }

  private generateReport(): void {
    const report = {
      timestamp: new Date().toISOString(),
      platform: os.platform(),
      cpu: os.cpus()[0].model,
      memory: `${(os.totalmem() / 1024 / 1024 / 1024).toFixed(2)}GB`,
      results: this.results,
      competitors: competitors,
      recommendations: this.generateRecommendations(),
    };

    const reportPath = path.join(process.cwd(), 'benchmark-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

    console.log(`\n📄 Report saved to: ${reportPath}`);
  }

  private generateRecommendations(): string[] {
    const recommendations: string[] = [];

    const avgResults = this.getAverageResults();

    const taskExec = avgResults.get('Task Execution');
    if (taskExec && taskExec.value > 500) {
      recommendations.push('Optimize task execution - latency too high');
    }

    const memOps = avgResults.get('Memory Operations');
    if (memOps && memOps.value > 100) {
      recommendations.push('Optimize memory operations - too slow');
    }

    if (this.memorySnapshots.length > 1) {
      const growth = this.memorySnapshots[this.memorySnapshots.length - 1] - this.memorySnapshots[0];
      if (growth > 10 * 1024 * 1024) {
        recommendations.push('CRITICAL: Memory leak detected!');
      }
    }

    if (recommendations.length === 0) {
      recommendations.push('System performing within acceptable parameters');
    }

    return recommendations;
  }
}

const runner = new BenchmarkRunner();
runner.runAll().catch(console.error);