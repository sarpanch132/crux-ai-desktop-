import { EventEmitter } from 'events';
import { spawn, ChildProcess, exec } from 'child_process';
import * as os from 'os';
import log from 'electron-log';

export interface SupervisorConfig {
  maxConcurrent: number;
  processTimeout: number;
  zombieTimeout: number;
  healthCheckInterval: number;
  maxRestartAttempts: number;
  restartDelay: number;
}

export interface SupervisedProcess {
  id: string;
  command: string;
  args: string[];
  proc: ChildProcess | null;
  status: 'starting' | 'running' | 'stopping' | 'stopped' | 'restarting';
  startTime: number;
  restartCount: number;
  cpuUsage: number;
  memoryUsage: number;
  pid?: number;
}

export interface HealthStatus {
  healthy: boolean;
  cpu: number;
  memory: number;
  uptime: number;
  processes: number;
}

export class ProcessSupervisor extends EventEmitter {
  private config: SupervisorConfig;
  private processes: Map<string, SupervisedProcess> = new Map();
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private metricsInterval: NodeJS.Timeout | null = null;
  private startTime: number = Date.now();

  constructor(config: Partial<SupervisorConfig> = {}) {
    super();
    this.config = {
      maxConcurrent: config.maxConcurrent ?? 10,
      processTimeout: config.processTimeout ?? 300000,
      zombieTimeout: config.zombieTimeout ?? 60000,
      healthCheckInterval: config.healthCheckInterval ?? 10000,
      maxRestartAttempts: config.maxRestartAttempts ?? 3,
      restartDelay: config.restartDelay ?? 5000,
    };

    this.startHealthChecks();
  }

  async spawn(
    id: string,
    command: string,
    args: string[] = [],
    options: { cwd?: string; env?: Record<string, string> } = {}
  ): Promise<SupervisedProcess> {
    if (this.processes.size >= this.config.maxConcurrent) {
      throw new Error(`Max concurrent processes (${this.config.maxConcurrent}) reached`);
    }

    if (this.processes.has(id)) {
      throw new Error(`Process already exists: ${id}`);
    }

    log.info(`Spawning process: ${id}`);

    const proc = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...options.env },
      shell: true,
      windowsHide: true,
    });

    const supervised: SupervisedProcess = {
      id,
      command,
      args,
      proc,
      status: 'starting',
      startTime: Date.now(),
      restartCount: 0,
      cpuUsage: 0,
      memoryUsage: 0,
      pid: proc.pid,
    };

    this.processes.set(id, supervised);

    proc.on('spawn', () => {
      supervised.status = 'running';
      supervised.startTime = Date.now();
      log.info(`Process started: ${id} (pid: ${proc.pid})`);
      this.emit('process:started', supervised);
    });

    proc.on('exit', (code, signal) => {
      supervised.status = 'stopped';
      log.info(`Process exited: ${id} (code: ${code}, signal: ${signal})`);
      this.emit('process:exited', { id, code, signal });

      if (this.shouldRestart(code, signal)) {
        this.scheduleRestart(id);
      } else {
        this.processes.delete(id);
      }
    });

    proc.on('error', (error) => {
      log.error(`Process error: ${id}`, error);
      supervised.status = 'stopped';
      this.emit('process:error', { id, error });
      this.processes.delete(id);
    });

    return supervised;
  }

  private shouldRestart(code: number | null, signal: string | null): boolean {
    if (code === 0) return false;
    if (signal === 'SIGTERM' || signal === 'SIGKILL') return false;
    return true;
  }

  private async scheduleRestart(id: string): Promise<void> {
    const supervised = this.processes.get(id);
    if (!supervised) return;

    if (supervised.restartCount >= this.config.maxRestartAttempts) {
      log.error(`Max restart attempts reached for: ${id}`);
      this.processes.delete(id);
      return;
    }

    supervised.status = 'restarting';
    supervised.restartCount++;

    log.info(`Scheduling restart ${supervised.restartCount}/${this.config.maxRestartAttempts} for: ${id}`);

    setTimeout(async () => {
      const options: any = {};
      await this.spawn(id, supervised.command, supervised.args, options);
    }, this.config.restartDelay);
  }

  async kill(id: string, force: boolean = false): Promise<boolean> {
    const supervised = this.processes.get(id);
    if (!supervised || !supervised.proc) return false;

    supervised.status = 'stopping';

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (supervised.proc && !supervised.proc.killed) {
          supervised.proc.kill('SIGKILL');
        }
        resolve(true);
      }, force ? 1000 : 5000);

      supervised.proc.once('exit', () => {
        clearTimeout(timeout);
        this.processes.delete(id);
        resolve(true);
      });

      if (!supervised.proc.killed) {
        supervised.proc.kill(force ? 'SIGKILL' : 'SIGTERM');
      }
    });
  }

  async killAll(force: boolean = false): Promise<void> {
    const kills = Array.from(this.processes.keys()).map(id => this.kill(id, force));
    await Promise.all(kills);

    this.processes.clear();
    log.info('All processes killed');
  }

  private startHealthChecks(): void {
    this.healthCheckInterval = setInterval(() => {
      this.checkHealth();
    }, this.config.healthCheckInterval);
  }

  private async checkHealth(): Promise<void> {
    const now = Date.now();

    for (const [id, supervised] of this.processes) {
      if (supervised.status !== 'running') continue;

      const age = now - supervised.startTime;

      if (age > this.config.zombieTimeout) {
        log.warn(`Potential zombie process: ${id} (age: ${age}ms)`);
        this.emit('process:zombie', { id, age });
      }

      if (supervised.proc && supervised.proc.killed && !supervised.proc.pid) {
        log.error(`Orphaned process detected: ${id}`);
        supervised.status = 'stopped';
        this.processes.delete(id);
        this.emit('process:orphaned', { id });
      }
    }
  }

  getProcess(id: string): SupervisedProcess | undefined {
    return this.processes.get(id);
  }

  getAllProcesses(): SupervisedProcess[] {
    return Array.from(this.processes.values());
  }

  getHealthStatus(): HealthStatus {
    return {
      healthy: this.processes.size < this.config.maxConcurrent,
      cpu: os.loadavg()[0],
      memory: process.memoryUsage().heapUsed,
      uptime: Date.now() - this.startTime,
      processes: this.processes.size,
    };
  }

  async close(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    await this.killAll(true);
    log.info('Process supervisor closed');
  }
}

export default ProcessSupervisor;