import { EventEmitter } from 'events';
import * as v8 from 'v8';
import * as os from 'os';

export interface MemorySnapshot {
  timestamp: number;
  heap: {
    used: number;
    total: number;
    limit: number;
    available: number;
  };
  rss: number;
  external: number;
  arrays: number;
  objects: number;
  strings: number;
  system: {
    free: number;
    total: number;
    used: number;
  };
}

export interface MemoryLeak {
  type: string;
  severity: 'low' | 'medium' | 'high';
  description: string;
  growth: number;
  snapshots: number;
}

export interface ProfilerSnapshot {
  timestamp: number;
  scriptId: string;
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
  totalTime: number;
  selfTime: number;
  callCount: number;
}

class MemoryProfiler extends EventEmitter {
  private snapshots: MemorySnapshot[] = [];
  private maxSnapshots: number = 100;
  private intervalId: NodeJS.Timeout | null = null;
  private baselineMemory: number = 0;
  private leakThreshold: number = 50 * 1024 * 1024;
  private checkInterval: number = 30000;

  start(intervalMs: number = 30000): void {
    this.takeSnapshot();
    this.baselineMemory = this.getCurrentHeap();

    this.intervalId = setInterval(() => {
      this.takeSnapshot();
      this.checkForLeaks();
    }, intervalMs);

    this.emit('started');
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.emit('stopped');
  }

  takeSnapshot(): MemorySnapshot {
    const heapStats = v8.getHeapStatistics();
    const memUsage = process.memoryUsage();

    const snapshot: MemorySnapshot = {
      timestamp: Date.now(),
      heap: {
        used: heapStats.used_heap_size,
        total: heapStats.total_heap_size,
        limit: heapStats.heap_size_limit,
        available: heapStats.total_available_size,
      },
      rss: memUsage.rss,
      external: memUsage.external,
      arrays: heapStats.number_of_array_instances,
      objects: heapStats.number_of_object_slots,
      strings: heapStats.number_of_string_slots,
      system: {
        free: os.freemem(),
        total: os.totalmem(),
        used: os.totalmem() - os.freemem(),
      },
    };

    this.snapshots.push(snapshot);

    if (this.snapshots.length > this.maxSnapshots) {
      this.snapshots.shift();
    }

    this.emit('snapshot', snapshot);
    return snapshot;
  }

  private getCurrentHeap(): number {
    return v8.getHeapStatistics().used_heap_size;
  }

  private checkForLeaks(): void {
    if (this.snapshots.length < 3) return;

    const current = this.snapshots[this.snapshots.length - 1];
    const baseline = this.snapshots[0];

    const growth = current.heap.used - baseline.heap.used;

    if (growth > this.leakThreshold) {
      const leak: MemoryLeak = {
        type: 'heap_growth',
        severity: growth > this.leakThreshold * 2 ? 'high' : 'medium',
        description: `Heap grew by ${(growth / 1024 / 1024).toFixed(2)}MB since baseline`,
        growth,
        snapshots: this.snapshots.length,
      };

      this.emit('leak', leak);
    }

    if (current.strings > baseline.strings * 1.5) {
      this.emit('leak', {
        type: 'string_growth',
        severity: 'medium',
        description: `String count increased by ${((current.strings / baseline.strings - 1) * 100).toFixed(1)}%`,
        growth: current.strings - baseline.strings,
        snapshots: this.snapshots.length,
      });
    }

    if (current.external > baseline.external * 2) {
      this.emit('leak', {
        type: 'external_memory',
        severity: 'high',
        description: `External memory doubled`,
        growth: current.external - baseline.external,
        snapshots: this.snapshots.length,
      });
    }
  }

  getSnapshots(): MemorySnapshot[] {
    return [...this.snapshots];
  }

  getLatestSnapshot(): MemorySnapshot | null {
    return this.snapshots[this.snapshots.length - 1] || null;
  }

  getGrowth(): { heap: number; rss: number; external: number } {
    if (this.snapshots.length < 2) {
      return { heap: 0, rss: 0, external: 0 };
    }

    const first = this.snapshots[0];
    const last = this.snapshots[this.snapshots.length - 1];

    return {
      heap: last.heap.used - first.heap.used,
      rss: last.rss - first.rss,
      external: last.external - first.external,
    };
  }

  getMemoryTrend(): number[] {
    return this.snapshots.map(s => s.heap.used);
  }

  forceGC(): void {
    if (global.gc) {
      global.gc();
      this.emit('gc', { timestamp: Date.now() });
    }
  }

  getHeapStats(): any {
    return v8.getHeapStatistics();
  }

  getSpaceStats(): any {
    return v8.getHeapSpaceStatistics();
  }
}

class CPUProfiler extends EventEmitter {
  private samples: ProfilerSnapshot[] = [];
  private isProfiling: boolean = false;
  private intervalId: NodeJS.Timeout | null = null;

  start(intervalMs: number = 100): void {
    if (this.isProfiling) return;

    this.isProfiling = true;
    this.intervalId = setInterval(() => {
      this.sample();
    }, intervalMs);

    this.emit('started');
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isProfiling = false;
    this.emit('stopped');
  }

  private sample(): void {
    const profiler = v8.getHeapCodeStatistics();
    this.emit('sample', profiler);
  }

  getTopFunctions(limit: number = 10): ProfilerSnapshot[] {
    return this.samples
      .sort((a, b) => b.totalTime - a.totalTime)
      .slice(0, limit);
  }

  clear(): void {
    this.samples = [];
  }
}

class PerformanceMonitor extends EventEmitter {
  private metrics: Map<string, number[]> = new Map();
  private maxDataPoints: number = 1000;
  private intervalId: NodeJS.Timeout | null = null;

  start(intervalMs: number = 1000): void {
    this.intervalId = setInterval(() => {
      this.collectMetrics();
    }, intervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private collectMetrics(): void {
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();

    this.recordMetric('memory.heap', memUsage.heapUsed);
    this.recordMetric('memory.rss', memUsage.rss);
    this.recordMetric('memory.external', memUsage.external);
    this.recordMetric('memory.arrayBuffers', memUsage.arrayBuffers || 0);

    this.recordMetric('cpu.user', cpuUsage.user);
    this.recordMetric('cpu.system', cpuUsage.system);

    this.recordMetric('eventLoop.lag', this.getEventLoopLag());

    this.emit('metrics', this.getLatestMetrics());
  }

  private getEventLoopLag(): number {
    const start = process.hrtime.bigint();
    setTimeout(() => {}, 0);
    return Number(process.hrtime.bigint() - start) / 1000000;
  }

  recordMetric(name: string, value: number): void {
    let values = this.metrics.get(name);
    if (!values) {
      values = [];
      this.metrics.set(name, values);
    }
    values.push(value);
    if (values.length > this.maxDataPoints) {
      values.shift();
    }
  }

  getMetric(name: string): number[] {
    return this.metrics.get(name) || [];
  }

  getLatestMetrics(): Record<string, number> {
    const latest: Record<string, number> = {};
    for (const [name, values] of this.metrics) {
      if (values.length > 0) {
        latest[name] = values[values.length - 1];
      }
    }
    return latest;
  }

  getStats(name: string): { min: number; max: number; avg: number; current: number } {
    const values = this.metrics.get(name) || [];
    if (values.length === 0) {
      return { min: 0, max: 0, avg: 0, current: 0 };
    }

    return {
      min: Math.min(...values),
      max: Math.max(...values),
      avg: values.reduce((a, b) => a + b, 0) / values.length,
      current: values[values.length - 1],
    };
  }
}

export const memoryProfiler = new MemoryProfiler();
export const cpuProfiler = new CPUProfiler();
export const performanceMonitor = new PerformanceMonitor();

export default {
  memoryProfiler,
  cpuProfiler,
  performanceMonitor,
};