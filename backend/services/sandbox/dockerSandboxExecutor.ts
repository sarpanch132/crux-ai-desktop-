import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import log from 'electron-log';
import * as fs from 'fs';
import * as path from 'path';

export interface SandboxConfig {
  image: string;
  cpuLimit: number;
  memoryLimit: number;
  networkEnabled: boolean;
  timeout: number;
  workingDirectory: string;
}

export interface ExecutionRequest {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeout?: number;
}

export interface ExecutionResult {
  id: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  success: boolean;
  duration: number;
  error?: string;
}

export interface ContainerStatus {
  id: string;
  status: 'created' | 'running' | 'paused' | 'exited' | 'dead';
  uptime: number;
 cpu: number;
  memory: number;
}

export class DockerSandboxExecutor extends EventEmitter {
  private config: SandboxConfig;
  private activeContainers: Map<string, ChildProcess> = new Map();
  private containerStates: Map<string, ContainerStatus> = new Map();
  private executionHistory: ExecutionResult[] = [];
  private maxHistory: number = 100;
  private containerId: string | null = null;
  private isInitialized: boolean = false;
  private initPromise: Promise<boolean> | null = null;

  constructor(config: Partial<SandboxConfig> = {}) {
    super();
    this.config = {
      image: config.image ?? 'opencode-sandbox:latest',
      cpuLimit: config.cpuLimit ?? 2,
      memoryLimit: config.memoryLimit ?? 2048,
      networkEnabled: config.networkEnabled ?? false,
      timeout: config.timeout ?? 300000,
      workingDirectory: config.workingDirectory ?? '/workspace',
    };
  }

  async initialize(): Promise<boolean> {
    if (this.isInitialized) return true;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._initialize();
    return this.initPromise;
  }

  private async _initialize(): Promise<boolean> {
    try {
      log.info('Initializing Docker sandbox...');
      
      const dockerCheck = await this.runDockerCommand(['ps']);
      if (!dockerCheck.success) {
        log.warn('Docker not available, using fallback execution');
        this.isInitialized = true;
        return true;
      }

      await this.pullImage(this.config.image);
      this.containerId = await this.createContainer();
      
      this.isInitialized = true;
      log.info(`Docker sandbox initialized with container: ${this.containerId}`);
      return true;
    } catch (error) {
      log.error('Docker initialization failed:', error);
      return false;
    }
  }

  private async runDockerCommand(args: string[]): Promise<ExecutionResult> {
    return new Promise((resolve) => {
      const id = randomUUID();
      let stdout = '';
      let stderr = '';
      const startTime = Date.now();

      const proc = spawn('docker', args, { 
        shell: true,
        env: { ...process.env }
      });

      proc.stdout?.on('data', (data) => { stdout += data.toString(); });
      proc.stderr?.on('data', (data) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        resolve({
          id,
          exitCode: code,
          stdout,
          stderr,
          success: code === 0,
          duration: Date.now() - startTime,
        });
      });

      proc.on('error', (error) => {
        resolve({
          id,
          exitCode: null,
          stdout,
          stderr: error.message,
          success: false,
          duration: Date.now() - startTime,
          error: error.message,
        });
      });

      setTimeout(() => {
        proc.kill();
        resolve({
          id,
          exitCode: -1,
          stdout,
          stderr: 'Timeout',
          success: false,
          duration: Date.now() - startTime,
          error: 'Command timeout',
        });
      }, 30000);
    });
  }

  private async pullImage(image: string): Promise<void> {
    const check = await this.runDockerCommand(['images', '-q', image]);
    if (!check.stdout.trim()) {
      log.info(`Pulling image: ${image}`);
      await this.runDockerCommand(['pull', image]);
    }
  }

  private async createContainer(): Promise<string> {
    const name = `opencode-sandbox-${randomUUID().slice(0, 8)}`;
    const args = [
      'create',
      '--name', name,
      '--cpus', String(this.config.cpuLimit),
      '--memory', `${this.config.memoryLimit}m`,
      '--network', this.config.networkEnabled ? 'bridge' : 'none',
      '-w', this.config.workingDirectory,
      this.config.image,
      'sleep', 'infinity',
    ];

    const result = await this.runDockerCommand(args);
    if (!result.success) {
      throw new Error(`Failed to create container: ${result.error}`);
    }

    await this.runDockerCommand(['start', name]);
    log.info(`Container created: ${name}`);
    return name;
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const id = randomUUID();
    const startTime = Date.now();
    const timeout = request.timeout ?? this.config.timeout;

    log.info(`Executing in sandbox: ${request.command} ${request.args?.join(' ') ?? ''}`);

    if (this.containerId && await this.isDockerAvailable()) {
      return await this.executeInContainer(id, request, timeout, startTime);
    } else {
      return await this.executeFallback(id, request, timeout, startTime);
    }
  }

  private async isDockerAvailable(): Promise<boolean> {
    const result = await this.runDockerCommand(['ps']);
    return result.success;
  }

  private async executeInContainer(
    id: string,
    request: ExecutionRequest,
    timeout: number,
    startTime: number
  ): Promise<ExecutionResult> {
    const envArgs = Object.entries(request.env ?? {})
      .map(([k, v]) => `-e ${k}=${v}`)
      .join(' ');

    const cwdArg = request.cwd ? `-w ${request.cwd}` : '';
    const cmd = `docker exec ${envArgs} ${cwdArg} ${this.containerId} ${request.command} ${request.args?.join(' ') ?? ''}`;

    const result = await this.runDockerCommandCommand(cmd, timeout);
    result.id = id;
    result.duration = Date.now() - startTime;

    this.addToHistory(result);
    return result;
  }

  private runDockerCommandCommand(cmd: string, timeout: number): Promise<ExecutionResult> {
    return new Promise((resolve) => {
      const id = randomUUID();
      let stdout = '';
      let stderr = '';
      const start = Date.now();

      const proc = spawn('sh', ['-c', cmd], { 
        shell: true,
        env: { ...process.env }
      });

      proc.stdout?.on('data', (data) => { 
        stdout += data.toString();
        this.emit('output', { id, stream: 'stdout', data: data.toString() });
      });
      
      proc.stderr?.on('data', (data) => { 
        stderr += data.toString();
        this.emit('output', { id, stream: 'stderr', data: data.toString() });
      });

      proc.on('close', (code) => {
        const result: ExecutionResult = {
          id,
          exitCode: code,
          stdout,
          stderr,
          success: code === 0,
          duration: Date.now() - start,
        };
        resolve(result);
      });

      proc.on('error', (error) => {
        resolve({
          id,
          exitCode: null,
          stdout,
          stderr: error.message,
          success: false,
          duration: Date.now() - start,
          error: error.message,
        });
      });

      setTimeout(() => {
        proc.kill();
        resolve({
          id,
          exitCode: -1,
          stdout,
          stderr: 'Timeout',
          success: false,
          duration: Date.now() - start,
          error: 'Execution timeout',
        });
      }, timeout);
    });
  }

  private async executeFallback(
    id: string,
    request: ExecutionRequest,
    timeout: number,
    startTime: number
  ): Promise<ExecutionResult> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      const env = { ...process.env, ...request.env };

      const proc = spawn(request.command, request.args ?? [], {
        cwd: request.cwd,
        env,
        shell: true,
      });

      this.activeContainers.set(id, proc);

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
        this.emit('output', { id, stream: 'stdout', data: data.toString() });
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
        this.emit('output', { id, stream: 'stderr', data: data.toString() });
      });

      proc.on('close', (code) => {
        this.activeContainers.delete(id);
        const result: ExecutionResult = {
          id,
          exitCode: code,
          stdout,
          stderr,
          success: code === 0,
          duration: Date.now() - startTime,
        };
        this.addToHistory(result);
        resolve(result);
      });

      proc.on('error', (error) => {
        this.activeContainers.delete(id);
        resolve({
          id,
          exitCode: null,
          stdout,
          stderr: error.message,
          success: false,
          duration: Date.now() - startTime,
          error: error.message,
        });
      });

      setTimeout(() => {
        proc.kill();
        resolve({
          id,
          exitCode: -1,
          stdout,
          stderr: 'Timeout',
          success: false,
          duration: Date.now() - startTime,
          error: 'Execution timeout',
        });
      }, timeout);
    });
  }

  private addToHistory(result: ExecutionResult): void {
    this.executionHistory.unshift(result);
    if (this.executionHistory.length > this.maxHistory) {
      this.executionHistory.pop();
    }
  }

  async getContainerStatus(): Promise<ContainerStatus | null> {
    if (!this.containerId) return null;

    const result = await this.runDockerCommand([
      'inspect',
      '--format',
      '{{.State.Status}}|{{.State.StartedAt}}|{{.CPUPerc}}|{{.MemPerc}}',
      this.containerId,
    ]);

    if (!result.success) return null;

    const [status, startedAt, cpu, mem] = result.stdout.split('|');
    return {
      id: this.containerId,
      status: status as ContainerStatus['status'],
      uptime: startedAt ? Date.now() - new Date(startedAt).getTime() : 0,
      cpu: parseFloat(cpu) || 0,
      memory: parseFloat(mem) || 0,
    };
  }

  async stopContainer(): Promise<void> {
    if (this.containerId) {
      await this.runDockerCommand(['stop', this.containerId]);
      await this.runDockerCommand(['rm', this.containerId]);
      this.containerId = null;
      log.info('Sandbox container stopped');
    }
  }

  terminateExecution(id: string): void {
    const proc = this.activeContainers.get(id);
    if (proc) {
      proc.kill();
      this.activeContainers.delete(id);
      log.info(`Terminated execution: ${id}`);
    }
  }

  getHistory(): ExecutionResult[] {
    return [...this.executionHistory];
  }

  getActiveExecutions(): number {
    return this.activeContainers.size;
  }

  getStatus(): { initialized: boolean; containerId: string | null; activeExecutions: number } {
    return {
      initialized: this.isInitialized,
      containerId: this.containerId,
      activeExecutions: this.activeContainers.size,
    };
  }
}

export const createSandboxExecutor = (config?: Partial<SandboxConfig>): DockerSandboxExecutor => {
  return new DockerSandboxExecutor(config);
};

export default DockerSandboxExecutor;