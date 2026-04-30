import { spawn, ChildProcess, exec } from 'child_process';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';
import log from 'electron-log';
import { v4 as uuidv4 } from 'uuid';

export interface TerminalOptions {
  cwd?: string;
  env?: Record<string, string>;
  shell?: string;
  timeout?: number;
}

export interface TerminalOutput {
  type: 'stdout' | 'stderr' | 'system';
  data: string;
  timestamp: number;
  sessionId: string;
}

export interface TerminalSession {
  id: string;
  command: string;
  cwd: string;
  pid?: number;
  status?: number;
  startTime: number;
  endTime?: number;
  running: boolean;
}

export interface ExecutionResult {
  success: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: string;
  duration: number;
  sessionId: string;
}

const DANGEROUS_COMMANDS = [
  /^\s*rm\s+-rf/i,
  /^\s*del\s+\/[sfq]/i,
  /^\s*format\s+/i,
  /^\s*mkfs/i,
  /^\s*dd\s+if=/i,
  /^\s*>:{1,2}\s*\//i,
  /^\s*>\s*\/dev\/sda/i,
  /^\s*chmod\s+-R\s+777/i,
  /^\s*launchctl\s+unload/i,
  /\|\s*sudo\s+/i,
  /^git\s+push\s+--force/i,
  /^git\s+push\s+--mirror/i,
];

const APPROVAL_COMMANDS = [
  /npm\s+i\s+-g/i,
  /npm\s+install\s+-g/i,
  /brew\s+install/i,
  /apt\s+get\s+install/i,
  /yum\s+install/i,
  /dnf\s+install/i,
  /pip\s+install\s+--user/i,
  /chmod\s+777/i,
  /chown\s+-R/i,
  /kill\s+-9/i,
  /killall/i,
];

export class TerminalTool extends EventEmitter {
  private sessionProcesses: Map<string, ChildProcess> = new Map();
  private sessions: Map<string, TerminalSession> = new Map();
  private workspaceRoot: string;
  private defaultShell: string;
  private requireApproval: boolean;

  constructor(workspaceRoot?: string) {
    super();
    this.workspaceRoot = workspaceRoot || process.cwd();
    this.defaultShell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
    this.requireApproval = false;
  }

  setRequireApproval(required: boolean): void {
    this.requireApproval = required;
  }

  validateCommand(command: string): { valid: boolean; requiresApproval?: boolean; error?: string } {
    const trimmed = command.trim();
    
    for (const dangerous of DANGEROUS_COMMANDS) {
      if (dangerous.test(trimmed)) {
        return { valid: false, error: `Dangerous command blocked: ${trimmed}` };
      }
    }

    let requiresApproval = false;
    for (const pattern of APPROVAL_COMMANDS) {
      if (pattern.test(trimmed)) {
        requiresApproval = true;
        break;
      }
    }

    if (this.requireApproval && requiresApproval) {
      return { valid: true, requiresApproval: true };
    }

    return { valid: true };
  }

  async execute(
    command: string,
    options: TerminalOptions = {},
    onOutput?: (output: TerminalOutput) => void
  ): Promise<ExecutionResult> {
    const validation = this.validateCommand(command);
    if (!validation.valid) {
      return {
        success: false,
        error: validation.error,
        duration: 0,
        sessionId: '',
      };
    }

    const sessionId = uuidv4();
    const cwd = options.cwd || this.workspaceRoot;
    const shell = options.shell || this.defaultShell;
    const startTime = Date.now();

    log.info(`Executing: ${command} in ${cwd} (session: ${sessionId})`);

    const session: TerminalSession = {
      id: sessionId,
      command,
      cwd,
      startTime,
      running: true,
    };

    return new Promise((resolve) => {
      let proc: ChildProcess;
      let stdout = '';
      let stderr = '';

      const shellArgs = process.platform === 'win32' 
        ? ['-c', command] 
        : ['-c', command];

      try {
        proc = spawn(shell, shellArgs, {
          cwd,
          env: { 
            ...process.env, 
            FORCE_COLOR: '1',
            ...options.env 
          },
          shell: false,
          windowsHide: true,
        });

        session.pid = proc.pid;
        this.sessionProcesses.set(sessionId, proc);
        this.sessions.set(sessionId, session);

        const sendOutput = (type: 'stdout' | 'stderr' | 'system', data: string) => {
          const output: TerminalOutput = {
            type,
            data,
            timestamp: Date.now(),
            sessionId,
          };
          
          if (onOutput) {
            onOutput(output);
          }
          
          this.emit('output', output);
        };

        proc.stdout?.on('data', (data: Buffer) => {
          const text = data.toString();
          stdout += text;
          sendOutput('stdout', text);
        });

        proc.stderr?.on('data', (data: Buffer) => {
          const text = data.toString();
          stderr += text;
          sendOutput('stderr', text);
        });

        const timeout = options.timeout || 60000;
        const timeoutHandle = setTimeout(() => {
          if (proc && !proc.killed) {
            proc.kill('SIGKILL');
            sendOutput('system', `\n[TIMEOUT] Command killed after ${timeout}ms\n`);
          }
        }, timeout);

        proc.on('close', (code) => {
          clearTimeout(timeoutHandle);
          
          session.running = false;
          session.status = code ?? undefined;
          session.endTime = Date.now();

          this.sessionProcesses.delete(sessionId);
          
          sendOutput('system', `\n[EXIT] Code: ${code}\n`);
          
          log.info(`Session ${sessionId} exited with code ${code}`);
          
          resolve({
            success: code === 0,
            stdout,
            stderr,
            exitCode: code ?? undefined,
            duration: Date.now() - startTime,
            sessionId,
          });
        });

        proc.on('error', (error) => {
          clearTimeout(timeoutHandle);
          
          session.running = false;
          session.endTime = Date.now();
          
          this.sessionProcesses.delete(sessionId);
          
          log.error(`Session ${sessionId} error:`, error);
          
          resolve({
            success: false,
            stderr: error.message,
            error: String(error),
            duration: Date.now() - startTime,
            sessionId,
          });
        });
      } catch (error) {
        log.error(`Failed to spawn: ${command}`, error);
        
        resolve({
          success: false,
          error: String(error),
          duration: Date.now() - startTime,
          sessionId,
        });
      }
    });
  }

  async *stream(
    command: string,
    options: TerminalOptions = {}
  ): AsyncGenerator<TerminalOutput> {
    const sessionId = uuidv4();
    
    yield {
      type: 'system',
      data: `[START] ${command}\n`,
      timestamp: Date.now(),
      sessionId,
    };

    let stdout = '';
    let stderr = '';

    try {
      const result = await this.execute(command, options, (output) => {
        if (output.type === 'stdout') stdout += output.data;
        if (output.type === 'stderr') stderr += output.data;
        yield output;
      });

      yield {
        type: 'system',
        data: `\n[EXIT] Code: ${result.exitCode}\n`,
        timestamp: Date.now(),
        sessionId,
      };

      return result;
    } catch (error) {
      yield {
        type: 'stderr',
        data: String(error),
        timestamp: Date.now(),
        sessionId,
      };
    }
  }

  kill(sessionId: string): { success: boolean; error?: string } {
    const proc = this.sessionProcesses.get(sessionId);
    
    if (!proc) {
      return { success: false, error: 'Session not found' };
    }

    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
      } else {
        proc.kill('SIGKILL');
      }
      
      this.sessionProcesses.delete(sessionId);
      
      const session = this.sessions.get(sessionId);
      if (session) {
        session.running = false;
        session.endTime = Date.now();
      }
      
      log.info(`Killed session: ${sessionId}`);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  killAll(): { killed: number; errors: string[] } {
    const errors: string[] = [];
    let killed = 0;

    for (const [sessionId] of this.sessionProcesses) {
      const result = this.kill(sessionId);
      if (result.success) {
        killed++;
      } else if (result.error) {
        errors.push(result.error);
      }
    }

    return { killed, errors };
  }

  getSessions(): TerminalSession[] {
    return Array.from(this.sessions.values());
  }

  getSession(sessionId: string): TerminalSession | undefined {
    return this.sessions.get(sessionId);
  }

  isRunning(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session?.running || false;
  }

  getActiveCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.running) count++;
    }
    return count;
  }
}

export default TerminalTool;