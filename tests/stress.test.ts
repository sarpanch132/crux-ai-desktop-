import { performance } from 'perf_hooks';
import { EventEmitter } from 'events';
import * as os from 'os';

interface StressResult {
  name: string;
  iterations: number;
  duration: number;
  avgDuration: number;
  minDuration: number;
  maxDuration: number;
  memory: { before: number; after: number; delta: number };
  errors: number;
}

interface StressConfig {
  iterations: number;
  concurrency: number;
  warmup: number;
}

class StressTester extends EventEmitter {
  private results: StressResult[] = [];

  async runStressTest(
    name: string,
    fn: () => Promise<any>,
    config: StressConfig = { iterations: 100, concurrency: 10, warmup: 5 }
  ): Promise<StressResult> {
    console.log(`\n🧪 Running stress test: ${name}`);

    for (let i = 0; i < config.warmup; i++) {
      await fn();
    }

    const memoryBefore = process.memoryUsage().heapUsed;
    const startTime = performance.now();
    const durations: number[] = [];
    let errors = 0;

    const runBatch = async (batchSize: number) => {
      const promises = [];
      for (let i = 0; i < batchSize; i++) {
        const batchStart = performance.now();
        try {
          await fn();
          durations.push(performance.now() - batchStart);
        } catch (e) {
          errors++;
        }
      }
      await Promise.all(promises);
    };

    const batches = Math.ceil(config.iterations / config.concurrency);
    for (let i = 0; i < batches; i++) {
      const batchSize = Math.min(config.concurrency, config.iterations - i * config.concurrency);
      await runBatch(batchSize);
      this.emit('progress', { current: i + 1, total: batches });
    }

    const duration = performance.now() - startTime;
    const memoryAfter = process.memoryUsage().heapUsed;

    const result: StressResult = {
      name,
      iterations: config.iterations,
      duration,
      avgDuration: durations.reduce((a, b) => a + b, 0) / durations.length,
      minDuration: Math.min(...durations),
      maxDuration: Math.max(...durations),
      memory: {
        before: memoryBefore,
        after: memoryAfter,
        delta: memoryAfter - memoryBefore,
      },
      errors,
    };

    this.results.push(result);
    this.printResult(result);

    return result;
  }

  private printResult(result: StressResult): void {
    console.log(`\n📊 Results for: ${result.name}`);
    console.log(`   Iterations: ${result.iterations}`);
    console.log(`   Duration: ${result.duration.toFixed(2)}ms`);
    console.log(`   Avg: ${result.avgDuration.toFixed(2)}ms`);
    console.log(`   Min: ${result.minDuration.toFixed(2)}ms`);
    console.log(`   Max: ${result.maxDuration.toFixed(2)}ms`);
    console.log(`   Memory Δ: ${(result.memory.delta / 1024 / 1024).toFixed(2)}MB`);
    console.log(`   Errors: ${result.errors}`);

    if (result.errors / result.iterations > 0.1) {
      console.log(`   ⚠️  High error rate: ${((result.errors / result.iterations) * 100).toFixed(1)}%`);
    }
  }

  getResults(): StressResult[] {
    return this.results;
  }

  getSummary(): { totalTests: number; totalErrors: number; avgMemoryDelta: number } {
    const totalErrors = this.results.reduce((sum, r) => sum + r.errors, 0);
    const avgMemoryDelta = this.results.reduce((sum, r) => sum + r.memory.delta, 0) / this.results.length;

    return {
      totalTests: this.results.length,
      totalErrors,
      avgMemoryDelta,
    };
  }
}

class ChaosEngine extends EventEmitter {
  private enabled: boolean = false;
  private faultRate: number = 0.1;
  private delayRate: number = 0.1;

  enable(faultRate: number = 0.1, delayRate: number = 0.1): void {
    this.enabled = true;
    this.faultRate = faultRate;
    this.delayRate = delayRate;
    console.log('🌀 Chaos engine enabled');
  }

  disable(): void {
    this.enabled = false;
    console.log('🛑 Chaos engine disabled');
  }

  async inject<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.enabled) {
      return await fn();
    }

    if (Math.random() < this.faultRate) {
      this.emit('fault', { type: 'random_error' });
      throw new Error('Chaos: Injected random error');
    }

    if (Math.random() < this.delayRate) {
      const delay = Math.random() * 100;
      await new Promise(resolve => setTimeout(resolve, delay));
      this.emit('delay', { ms: delay });
    }

    try {
      return await fn();
    } catch (error) {
      this.emit('error', { error });
      throw error;
    }
  }

  injectMemoryPressure(): void {
    if (!this.enabled) return;

    const size = 10 * 1024 * 1024;
    const arr = new Array(size);
    for (let i = 0; i < size; i++) {
      arr[i] = 'x';
    }

    this.emit('memory_pressure', { size });
  }

  injectCPUBurn(duration: number = 1000): void {
    if (!this.enabled) return;

    const end = Date.now() + duration;
    while (Date.now() < end) {
      Math.sqrt(Math.random() * 10000);
    }

    this.emit('cpu_burn', { duration });
  }
}

async function runStressTests() {
  const tester = new StressTester();
  const chaos = new ChaosEngine();

  chaos.enable(0.05, 0.1);

  console.log('\n========================================');
  console.log('🚀 STRESS TEST SUITE');
  console.log('========================================');

  console.log(`\n📋 System Info:`);
  console.log(`   CPU: ${os.cpus().length} cores`);
  console.log(`   Memory: ${(os.totalmem() / 1024 / 1024 / 1024).toFixed(2)}GB`);
  console.log(`   Platform: ${os.platform()}`);

  await tester.runStressTest('Memory Store', async () => {
    const memory = new Map<string, any>();
    for (let i = 0; i < 1000; i++) {
      memory.set(`key-${i}`, `value-${i}`);
    }
    return memory;
  }, { iterations: 500, concurrency: 50, warmup: 10 });

  await tester.runStressTest('Context Manager', async () => {
    const contexts = [];
    for (let i = 0; i < 100; i++) {
      contexts.push({ type: 'test', content: 'x'.repeat(100), timestamp: Date.now() });
    }
    return contexts;
  }, { iterations: 300, concurrency: 30, warmup: 10 });

  await tester.runStressTest('Event Emission', async () => {
    const emitter = new EventEmitter();
    let count = 0;
    emitter.on('event', () => count++);
    for (let i = 0; i < 100; i++) {
      emitter.emit('event');
    }
    return count;
  }, { iterations: 500, concurrency: 50, warmup: 10 });

  await tester.runStressTest('JSON Parsing', async () => {
    const data = { items: [] };
    for (let i = 0; i < 100; i++) {
      data.items.push({ id: i, name: `item-${i}`, value: Math.random() });
    }
    return JSON.parse(JSON.stringify(data));
  }, { iterations: 1000, concurrency: 100, warmup: 20 });

  chaos.disable();

  const summary = tester.getSummary();
  console.log('\n========================================');
  console.log('📈 SUMMARY');
  console.log('========================================');
  console.log(`   Tests: ${summary.totalTests}`);
  console.log(`   Total Errors: ${summary.totalErrors}`);
  console.log(`   Avg Memory Δ: ${(summary.avgMemoryDelta / 1024 / 1024).toFixed(2)}MB`);

  return tester.getResults();
}

runStressTests().catch(console.error);