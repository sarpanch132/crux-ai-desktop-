import { EventEmitter } from 'events';
import log from 'electron-log';
import { randomUUID } from 'crypto';

export interface MetricsConfig {
  serviceName: string;
  exportInterval: number;
  exportURL?: string;
  enabled: boolean;
}

export interface Metric {
  name: string;
  value: number;
  timestamp: number;
  labels: Record<string, string>;
}

export interface HistogramMetric extends Metric {
  value: number;
  count: number;
  sum: number;
  min: number;
  max: number;
}

export interface TraceSpan {
  id: string;
  parentId?: string;
  name: string;
  serviceName: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  status: 'ok' | 'error' | 'unset';
  labels: Record<string, string>;
  events: { name: string; timestamp: number; payload?: any }[];
}

export interface LogEntry {
  id: string;
  timestamp: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  serviceName: string;
  traceId?: string;
  spanId?: string;
  payload?: any;
}

export class ObservabilitySystem extends EventEmitter {
  private config: MetricsConfig;
  private metrics: Map<string, Metric[]> = new Map();
  private counters: Map<string, number> = new Map();
  private gauges: Map<string, number> = new Map();
  private histograms: Map<string, number[]> = new Map();
  private activeSpans: Map<string, TraceSpan> = new Map();
  private logs: LogEntry[] = [];
  private maxLogs: number = 1000;
  private traceQueue: any[] = [];
  private isInitialized: boolean = false;
  private exportTimer: NodeJS.Timeout | null = null;

  constructor(config: Partial<MetricsConfig> = {}) {
    super();
    this.config = {
      serviceName: config.serviceName ?? 'opencode-agent',
      exportInterval: config.exportInterval ?? 60000,
      exportURL: config.exportURL,
      enabled: config.enabled ?? true,
    };
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    if (!this.config.enabled) {
      log.info('Observability disabled');
      return;
    }

    if (this.config.exportURL) {
      this.exportTimer = setInterval(() => {
        this.exportMetrics();
      }, this.config.exportInterval);
    }

    this.isInitialized = true;
    log.info('Observability system initialized');
  }

  incrementCounter(name: string, value: number = 1, labels: Record<string, string> = {}): void {
    const key = this.getMetricKey(name, labels);
    const current = this.counters.get(key) ?? 0;
    this.counters.set(key, current + value);

    this.recordMetric({
      name,
      value: current + value,
      timestamp: Date.now(),
      labels,
    });
  }

  setGauge(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = this.getMetricKey(name, labels);
    this.gauges.set(key, value);

    this.recordMetric({
      name,
      value,
      timestamp: Date.now(),
      labels,
    });
  }

  recordHistogram(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = this.getMetricKey(name, labels);
    const values = this.histograms.get(key) ?? [];
    values.push(value);
    
    if (values.length > 1000) {
      values.shift();
    }
    
    this.histograms.set(key, values);

    const stats = this.calculateHistogramStats(values);
    this.recordMetric({
      name,
      value,
      timestamp: Date.now(),
      labels: { ...labels, ...stats },
    });
  }

  private calculateHistogramStats(values: number[]): { count: string; sum: string; min: string; max: string } {
    const count = values.length;
    const sum = values.reduce((a, b) => a + b, 0);
    const min = Math.min(...values);
    const max = Math.max(...values);

    return {
      count: String(count),
      sum: String(sum),
      min: String(min),
      max: String(max),
    };
  }

  private recordMetric(metric: Metric): void {
    const existing = this.metrics.get(metric.name) ?? [];
    existing.unshift(metric);
    
    if (existing.length > 100) {
      existing.pop();
    }
    
    this.metrics.set(metric.name, existing);
  }

  getCounter(name: string, labels: Record<string, string> = {}): number {
    const key = this.getMetricKey(name, labels);
    return this.counters.get(key) ?? 0;
  }

  getGauge(name: string, labels: Record<string, string> = {}): number | null {
    const key = this.getMetricKey(name, labels);
    return this.gauges.get(key) ?? null;
  }

  startTrace(name: string, labels: Record<string, string> = {}): string {
    const spanId = randomUUID();
    
    const span: TraceSpan = {
      id: spanId,
      name,
      serviceName: this.config.serviceName,
      startTime: Date.now(),
      status: 'unset',
      labels,
      events: [],
    };

    this.activeSpans.set(spanId, span);
    this.emit('trace:started', span);
    
    return spanId;
  }

  endTrace(spanId: string, status: 'ok' | 'error' = 'ok'): void {
    const span = this.activeSpans.get(spanId);
    
    if (!span) {
      log.warn(`Span not found: ${spanId}`);
      return;
    }

    span.endTime = Date.now();
    span.duration = span.endTime - span.startTime;
    span.status = status;
    
    this.activeSpans.delete(spanId);
    this.traceQueue.push(span);
    
    this.emit('trace:ended', span);
    this.recordHistogram('trace.duration', span.duration, { name: span.name, status });
  }

  addTraceEvent(spanId: string, eventName: string, payload?: any): void {
    const span = this.activeSpans.get(spanId);
    
    if (!span) return;

    span.events.push({
      name: eventName,
      timestamp: Date.now(),
      payload,
    });
  }

  setTraceError(spanId: string, error: Error): void {
    const span = this.activeSpans.get(spanId);
    
    if (!span) return;

    span.status = 'error';
    span.events.push({
      name: 'error',
      timestamp: Date.now(),
      payload: { message: error.message, stack: error.stack },
    });
  }

  log(
    level: LogEntry['level'],
    message: string,
    options: { payload?: any; traceId?: string; spanId?: string } = {}
  ): void {
    const entry: LogEntry = {
      id: randomUUID(),
      timestamp: Date.now(),
      level,
      message,
      serviceName: this.config.serviceName,
      traceId: options.traceId,
      spanId: options.spanId,
      payload: options.payload,
    };

    this.logs.unshift(entry);
    
    if (this.logs.length > this.maxLogs) {
      this.logs.pop();
    }

    switch (level) {
      case 'debug':
        log.debug(message, options.payload);
        break;
      case 'info':
        log.info(message, options.payload);
        break;
      case 'warn':
        log.warn(message, options.payload);
        break;
      case 'error':
        log.error(message, options.payload);
        break;
    }

    this.emit('log', entry);
  }

  debug(message: string, payload?: any): void {
    this.log('debug', message, { payload });
  }

  info(message: string, payload?: any): void {
    this.log('info', message, { payload });
  }

  warn(message: string, payload?: any): void {
    this.log('warn', message, { payload });
  }

  error(message: string, payload?: any): void {
    this.log('error', message, { payload });
  }

  private getMetricKey(name: string, labels: Record<string, string>): string {
    const labelStr = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    
    return labelStr ? `${name}{${labelStr}}` : name;
  }

  getMetrics(): Record<string, Metric[]> {
    return Object.fromEntries(this.metrics);
  }

  getLogs(level?: LogEntry['level']): LogEntry[] {
    if (!level) return [...this.logs];
    return this.logs.filter(l => l.level === level);
  }

  getActiveSpans(): TraceSpan[] {
    return Array.from(this.activeSpans.values());
  }

  async exportMetrics(): Promise<void> {
    if (!this.config.exportURL) return;

    try {
      const payload = {
        metrics: this.getMetrics(),
        traces: this.traceQueue.splice(0),
        serviceName: this.config.serviceName,
        timestamp: Date.now(),
      };

      await fetch(this.config.exportURL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      log.error('Failed to export metrics:', error);
    }
  }

  async exportToPrometheus(): Promise<string> {
    let output = '';
    
    for (const [name, metrics] of this.metrics) {
      for (const metric of metrics.slice(0, 10)) {
        const labels = Object.entries(metric.labels)
          .map(([k, v]) => `${k}="${v}"`)
          .join(',');
        
        const labelStr = labels ? `{${labels}}` : '';
        output += `${name}${labelStr} ${metric.value} ${metric.timestamp}\n`;
      }
    }

    for (const [name, value] of this.counters) {
      output += `# TYPE ${name} counter\n${name} ${value}\n`;
    }

    for (const [name, value] of this.gauges) {
      output += `# TYPE ${name} gauge\n${name} ${value}\n`;
    }

    return output;
  }

  clear(): void {
    this.metrics.clear();
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
    this.logs = [];
    
    log.info('Observability data cleared');
  }

  async close(): Promise<void> {
    if (this.exportTimer) {
      clearInterval(this.exportTimer);
      this.exportTimer = null;
    }

    await this.exportMetrics();
    
    this.isInitialized = false;
    log.info('Observability system closed');
  }

  getStatus(): { initialized: boolean; metrics: number; logs: number; activeSpans: number } {
    return {
      initialized: this.isInitialized,
      metrics: this.metrics.size,
      logs: this.logs.length,
      activeSpans: this.activeSpans.size,
    };
  }
}

export const createObservability = (config?: Partial<MetricsConfig>): ObservabilitySystem => {
  return new ObservabilitySystem(config);
};

export default ObservabilitySystem;