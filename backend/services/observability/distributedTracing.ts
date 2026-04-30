import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import * as os from 'os';
import log from 'electron-log';

export interface TraceConfig {
  serviceName: string;
  exportInterval: number;
  exportURL?: string;
  sampleRate: number;
  enableDistributedTracing: boolean;
  maxTraceDuration: number;
}

export interface SpanContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  baggage: Record<string, string>;
}

export interface TraceSpan {
  id: string;
  context: SpanContext;
  operationName: string;
  serviceName: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  status: 'ok' | 'error' | 'unset';
  tags: Record<string, any>;
  logs: SpanLog[];
  metrics: SpanMetrics;
}

export interface SpanLog {
  timestamp: number;
  message: string;
  fields?: Record<string, any>;
}

export interface SpanMetrics {
  cpuBefore?: number;
  cpuAfter?: number;
  memoryBefore?: number;
  memoryAfter?: number;
}

export interface DistributedTrace {
  traceId: string;
  spans: TraceSpan[];
  startTime: number;
  endTime: number;
  duration: number;
  serviceName: string;
}

export class DistributedTracing extends EventEmitter {
  private config: TraceConfig;
  private activeSpans: Map<string, TraceSpan> = new Map();
  private completedTraces: Map<string, DistributedTrace> = new Map();
  private baggage: Map<string, Map<string, string>> = new Map();
  private traceQueue: DistributedTrace[] = [];
  private maxQueueSize: number = 100;
  private isRecording: boolean = false;
  private startTime: number = Date.now();

  constructor(config: Partial<TraceConfig> = {}) {
    super();
    this.config = {
      serviceName: config.serviceName ?? 'opencode-agent',
      exportInterval: config.exportInterval ?? 60000,
      exportURL: config.exportURL,
      sampleRate: config.sampleRate ?? 1.0,
      enableDistributedTracing: config.enableDistributedTracing ?? true,
      maxTraceDuration: config.maxTraceDuration ?? 30000,
    };
  }

  startRecording(): void {
    this.isRecording = true;
    log.info('Distributed tracing started');
  }

  stopRecording(): void {
    this.isRecording = false;
    log.info('Distributed tracing stopped');
  }

  createSpan(
    operationName: string,
    parentContext?: SpanContext,
    options?: { tags?: Record<string, any>; sample?: boolean }
  ): TraceSpan | null {
    if (!this.isRecording && Math.random() > this.config.sampleRate) {
      return null;
    }

    const spanId = randomUUID().slice(0, 16);
    const traceId = parentContext?.traceId || randomUUID();

    const context: SpanContext = {
      traceId,
      spanId,
      parentSpanId: parentContext?.spanId,
      baggage: this.getBaggage(traceId),
    };

    const span: TraceSpan = {
      id: spanId,
      context,
      operationName,
      serviceName: this.config.serviceName,
      startTime: Date.now(),
      status: 'unset',
      tags: options?.tags || {},
      logs: [],
      metrics: {},
    };

    this.activeSpans.set(spanId, span);

    this.emit('span:started', span);

    return span;
  }

  private getBaggage(traceId: string): Record<string, string> {
    const bag = this.baggage.get(traceId);
    return bag ? Object.fromEntries(bag) : {};
  }

  setBaggage(traceId: string, key: string, value: string): void {
    let bag = this.baggage.get(traceId);
    if (!bag) {
      bag = new Map();
      this.baggage.set(traceId, bag);
    }
    bag.set(key, value);
  }

  injectContext(span: TraceSpan): SpanContext {
    return {
      traceId: span.context.traceId,
      spanId: span.context.spanId,
      parentSpanId: span.context.parentSpanId,
      baggage: span.context.baggage,
    };
  }

  extractContext(headers: Record<string, string>): SpanContext | null {
    const traceId = headers['x-trace-id'];
    const spanId = headers['x-span-id'];

    if (!traceId) return null;

    return {
      traceId,
      spanId: spanId || randomUUID().slice(0, 16),
      parentSpanId: headers['x-parent-span-id'],
      baggage: {},
    };
  }

  log(spanId: string, message: string, fields?: Record<string, any>): void {
    const span = this.activeSpans.get(spanId);
    if (!span) return;

    span.logs.push({
      timestamp: Date.now(),
      message,
      fields,
    });

    this.emit('span:log', { spanId, message });
  }

  setTag(spanId: string, key: string, value: any): void {
    const span = this.activeSpans.get(spanId);
    if (span) {
      span.tags[key] = value;
    }
  }

  setTags(spanId: string, tags: Record<string, any>): void {
    const span = this.activeSpans.get(spanId);
    if (span) {
      span.tags = { ...span.tags, ...tags };
    }
  }

  endSpan(
    spanId: string,
    options?: { status?: 'ok' | 'error'; error?: Error; tags?: Record<string, any> }
  ): void {
    const span = this.activeSpans.get(spanId);
    if (!span) {
      log.warn(`Span not found: ${spanId}`);
      return;
    }

    span.endTime = Date.now();
    span.duration = span.endTime - span.startTime;

    if (options?.status) {
      span.status = options.status;
    }

    if (options?.error) {
      span.status = 'error';
      span.logs.push({
        timestamp: span.endTime,
        message: options.error.message,
        fields: { error: true, stack: options.error.stack },
      });
    }

    if (options?.tags) {
      span.tags = { ...span.tags, ...options.tags };
    }

    span.metrics.cpuAfter = os.loadavg()[0];
    span.metrics.memoryAfter = process.memoryUsage().heapUsed;

    if (span.duration > this.config.maxTraceDuration) {
      log.warn(`Long running span detected: ${span.operationName} (${span.duration}ms)`);
    }

    this.activeSpans.delete(spanId);

    this.emit('span:ended', span);

    this.addToTrace(span);
  }

  private addToTrace(span: TraceSpan): void {
    let trace = this.completedTraces.get(span.context.traceId);

    if (!trace) {
      trace = {
        traceId: span.context.traceId,
        spans: [],
        startTime: span.startTime,
        endTime: span.endTime || span.startTime,
        duration: span.duration || 0,
        serviceName: this.config.serviceName,
      };
      this.completedTraces.set(span.context.traceId, trace);
    }

    trace.spans.push(span);
    trace.endTime = Math.max(trace.endTime, span.endTime || span.startTime);
    trace.duration = trace.endTime - trace.startTime;

    if (trace.spans.length === 1) {
      this.traceQueue.push(trace);

      if (this.traceQueue.length > this.maxQueueSize) {
        this.traceQueue.shift();
      }
    }
  }

  async exportTraces(): Promise<void> {
    if (!this.config.exportURL || this.traceQueue.length === 0) return;

    try {
      const payload = {
        traces: this.traceQueue.splice(0),
        serviceName: this.config.serviceName,
        timestamp: Date.now(),
        hostname: os.hostname(),
        pid: process.pid,
      };

      const response = await fetch(this.config.exportURL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Name': this.config.serviceName,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`Export failed: ${response.status}`);
      }

      log.info(`Exported ${payload.traces.length} traces`);
      this.emit('traces:exported', { count: payload.traces.length });
    } catch (error) {
      log.error('Failed to export traces:', error);
      this.emit('traces:export:failed', error);
    }
  }

  getActiveSpans(): TraceSpan[] {
    return Array.from(this.activeSpans.values());
  }

  getTrace(traceId: string): DistributedTrace | undefined {
    return this.completedTraces.get(traceId);
  }

  getQueuedTraces(): DistributedTrace[] {
    return [...this.traceQueue];
  }

  clear(): void {
    this.activeSpans.clear();
    this.completedTraces.clear();
    this.baggage.clear();
    log.info('Tracing data cleared');
  }

  getStatus(): { isRecording: boolean; activeSpans: number; queuedTraces: number; uptime: number } {
    return {
      isRecording: this.isRecording,
      activeSpans: this.activeSpans.size,
      queuedTraces: this.traceQueue.length,
      uptime: Date.now() - this.startTime,
    };
  }
}

export default DistributedTracing;