import log from 'electron-log';
import path from 'path';
import { app } from 'electron';
import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'fs';
import { cwd } from 'process';

export interface LogConfig {
  level?: 'error' | 'warn' | 'info' | 'debug';
  filePath?: string;
  maxSize?: number;
  maxFiles?: number;
  console?: boolean;
  remote?: boolean;
  remoteEndpoint?: string;
}

export interface LogEntry {
  level: string;
  message: string;
  timestamp: number;
  context?: Record<string, any>;
  stack?: string;
}

export interface AnalyticsEvent {
  name: string;
  properties?: Record<string, any>;
  timestamp: number;
  sessionId: string;
  userId?: string;
}

export interface CrashReport {
  id: string;
  error: Error;
  stack: string;
  context: Record<string, any>;
  timestamp: number;
  appVersion: string;
  platform: string;
}

const DEFAULT_CONFIG: LogConfig = {
  level: 'info',
  maxSize: 10 * 1024 * 1024,
  maxFiles: 5,
  console: true,
  remote: false,
};

export class Logger {
  private config: LogConfig;
  private sessionId: string;
  private logBuffer: LogEntry[] = [];
  private flushInterval: NodeJS.Timeout | null = null;

  constructor(config: LogConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.sessionId = this.generateSessionId();
    this.setupLogger();
    this.startAutoFlush();
  }

  private setupLogger(): void {
    const logDir = this.config.filePath || path.join(cwd(), 'logs');
    
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }

    log.transports.file.resolvePathFn = () => {
      const date = new Date().toISOString().split('T')[0];
      return path.join(logDir, `ai-coder-${date}.log`);
    };

    log.transports.file.level = this.config.level || 'info';
    log.transports.file.maxSize = this.config.maxSize || 10 * 1024 * 1024;
    log.transports.console.level = this.config.console !== false ? 'debug' : false;

    log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';

    log.catchErrors({
      showDialog: false,
      onError: (error) => {
        this.error('Uncaught error', { error: error.message, stack: error.stack });
      },
    });

    this.info('Logger initialized', { sessionId: this.sessionId });
  }

  private startAutoFlush(): void {
    this.flushInterval = setInterval(() => {
      this.flush();
    }, 5000);
  }

  error(message: string, context?: Record<string, any>): void {
    const entry: LogEntry = {
      level: 'error',
      message,
      timestamp: Date.now(),
      context: { ...context, sessionId: this.sessionId },
    };

    log.error(message, context);
    this.bufferEntry(entry);
    this.emitToRemote(entry);
  }

  warn(message: string, context?: Record<string, any>): void {
    const entry: LogEntry = {
      level: 'warn',
      message,
      timestamp: Date.now(),
      context: { ...context, sessionId: this.sessionId },
    };

    log.warn(message, context);
    this.bufferEntry(entry);
  }

  info(message: string, context?: Record<string, any>): void {
    const entry: LogEntry = {
      level: 'info',
      message,
      timestamp: Date.now(),
      context: { ...context, sessionId: this.sessionId },
    };

    log.info(message, context);
    this.bufferEntry(entry);
  }

  debug(message: string, context?: Record<string, any>): void {
    const entry: LogEntry = {
      level: 'debug',
      message,
      timestamp: Date.now(),
      context: { ...context, sessionId: this.sessionId },
    };

    log.debug(message, context);
    this.bufferEntry(entry);
  }

  track(event: string, properties?: Record<string, any>): void {
    const analyticsEvent: AnalyticsEvent = {
      name: event,
      properties,
      timestamp: Date.now(),
      sessionId: this.sessionId,
    };

    this.info(`[Analytics] ${event}`, { properties });

    if (this.config.remote && this.config.remoteEndpoint) {
      this.sendToRemote(analyticsEvent);
    }
  }

  private bufferEntry(entry: LogEntry): void {
    this.logBuffer.push(entry);

    if (this.logBuffer.length > 100) {
      this.logBuffer.shift();
    }
  }

  private flush(): void {
    this.logBuffer = [];
  }

  private emitToRemote(entry: LogEntry): void {
    if (this.config.remote && this.config.remoteEndpoint) {
      this.sendToRemote({ ...entry, type: 'log' });
    }
  }

  private sendToRemote(data: any): void {
    if (!this.config.remoteEndpoint) return;

    fetch(this.config.remoteEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).catch(() => {});
  }

  private generateSessionId(): string {
    return `session_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getRecentLogs(limit = 100): LogEntry[] {
    return this.logBuffer.slice(-limit);
  }

  getStats(): { errorCount: number; warnCount: number; infoCount: number } {
    const stats = { errorCount: 0, warnCount: 0, infoCount: 0 };

    for (const entry of this.logBuffer) {
      if (entry.level === 'error') stats.errorCount++;
      else if (entry.level === 'warn') stats.warnCount++;
      else if (entry.level === 'info') stats.infoCount++;
    }

    return stats;
  }

  destroy(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
    }
    this.flush();
  }
}

export class Analytics {
  private endpoint: string | null = null;
  private userId: string | null = null;
  private sessionId: string;
  private eventQueue: AnalyticsEvent[] = [];
  private flushInterval: NodeJS.Timeout | null = null;

  constructor(endpoint?: string) {
    this.endpoint = endpoint || null;
    this.sessionId = `session_${Date.now()}`;
    this.startAutoFlush();
  }

  setUserId(userId: string): void {
    this.userId = userId;
  }

  track(eventName: string, properties?: Record<string, any>): void {
    const event: AnalyticsEvent = {
      name: eventName,
      properties,
      timestamp: Date.now(),
      sessionId: this.sessionId,
      userId: this.userId,
    };

    this.eventQueue.push(event);

    if (this.eventQueue.length > 50) {
      this.flushQueue();
    }
  }

  trackPageView(pagePath: string): void {
    this.track('page_view', { path: pagePath });
  }

  trackAction(actionName: string, details?: Record<string, any>): void {
    this.track('action', { action: actionName, ...details });
  }

  trackError(error: Error, context?: Record<string, any>): void {
    this.track('error', {
      message: error.message,
      stack: error.stack,
      ...context,
    });
  }

  trackPerformance(metricName: string, value: number, unit?: string): void {
    this.track('performance', { metric: metricName, value, unit });
  }

  private startAutoFlush(): void {
    this.flushInterval = setInterval(() => {
      this.flushQueue();
    }, 10000);
  }

  private async flushQueue(): Promise<void> {
    if (this.eventQueue.length === 0 || !this.endpoint) return;

    const events = [...this.eventQueue];
    this.eventQueue = [];

    try {
      await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events }),
      });
    } catch {
      this.eventQueue.unshift(...events);
    }
  }

  destroy(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
    }
    this.flushQueue();
  }
}

export class CrashRecovery {
  private recoveryDir: string;
  private maxCrashReports: number;

  constructor(recoveryDir?: string) {
    this.recoveryDir = recoveryDir || path.join(cwd(), '.crash-recovery');
    this.maxCrashReports = 10;
    
    if (!existsSync(this.recoveryDir)) {
      mkdirSync(this.recoveryDir, { recursive: true });
    }
  }

  saveState(state: Record<string, any>): void {
    try {
      const filename = `state_${Date.now()}.json`;
      const filepath = path.join(this.recoveryDir, filename);
      appendFileSync(filepath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
      this.cleanOldStates();
    } catch (error) {
      log.error('Failed to save recovery state:', error);
    }
  }

  loadLatestState(): Record<string, any> | null {
    try {
      const files = this.getStateFiles();
      
      if (files.length === 0) return null;

      const latestFile = files.sort().pop();
      if (!latestFile) return null;

      const content = readFileSync(latestFile, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      log.error('Failed to load recovery state:', error);
      return null;
    }
  }

  clearStates(): void {
    try {
      const files = this.getStateFiles();
      files.forEach(file => {
        const { unlinkSync } = require('fs');
        unlinkSync(file);
      });
    } catch (error) {
      log.error('Failed to clear recovery states:', error);
    }
  }

  private getStateFiles(): string[] {
    const { readdirSync } = require('fs');
    const { readdirSync } = require('fs');
    try {
      return readdirSync(this.recoveryDir)
        .filter(f => f.startsWith('state_') && f.endsWith('.json'))
        .map(f => path.join(this.recoveryDir, f));
    } catch {
      return [];
    }
  }

  private cleanOldStates(): void {
    const files = this.getStateFiles();
    
    if (files.length > this.maxCrashReports) {
      const toDelete = files.sort().slice(0, files.length - this.maxCrashReports);
      const { unlinkSync } = require('fs');
      toDelete.forEach(f => unlinkSync(f));
    }
  }

  generateCrashReport(error: Error, context: Record<string, any>): CrashReport {
    return {
      id: `crash_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      error,
      stack: error.stack || '',
      context,
      timestamp: Date.now(),
      appVersion: app?.getVersion() || '1.0.0',
      platform: process.platform,
    };
  }
}

export const logger = new Logger();
export const analytics = new Analytics();
export const crashRecovery = new CrashRecovery();