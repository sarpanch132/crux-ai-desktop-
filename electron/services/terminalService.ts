import { ChildProcess, spawn, execFile } from 'child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import log from 'electron-log';
import type { CommandResult } from './agent/contracts.js';

export interface TerminalOutput {
  sessionId: string;
  type: 'stdout' | 'stderr' | 'system';
  data: string;
  timestamp: number;
}

export interface TerminalSessionInfo {
  id: string;
  command: string;
  cwd: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  status: 'running' | 'completed' | 'killed' | 'timed_out' | 'error';
}

interface TerminalSession {
  info: TerminalSessionInfo;
  process: ChildProcess;
  timeout?: NodeJS.Timeout;
  output: string;
  stdout: string;
  stderr: string;
  complete?: (result: CommandResult) => void;
  container?: string;
}

const MAX_DURATION_MS = 120_000;
const REPEAT_WINDOW_MS = 10_000;
const MAX_REPEAT_COUNT = 6;
const execFileAsync = promisify(execFile);

export class TerminalService extends EventEmitter {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly completed: TerminalSessionInfo[] = [];
  private readonly recentCommands = new Map<string, { count: number; lastRun: number }>();
  private readonly shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';

  async sandboxAvailable(): Promise<boolean> {
    try {
      const info = await execFileAsync('docker', ['info', '--format', '{{.OSType}}'], { windowsHide: true, timeout: 4000 });
      if (info.stdout.trim() !== 'linux') return false;
      // The image must be installed explicitly. This check never pulls or installs software.
      await execFileAsync('docker', ['image', 'inspect', 'node:22'], { windowsHide: true, timeout: 4000, maxBuffer: 128 * 1024 });
      return true;
    } catch { return false; }
  }

  async executeAndWaitSandbox(command: string, cwd: string, signal?: AbortSignal, timeoutMs = MAX_DURATION_MS): Promise<CommandResult> {
    this.validateTimeout(timeoutMs);
    if (signal?.aborted) throw new Error('Operation canceled.');
    if (cwd.includes(',')) throw new Error('Docker workspace paths containing commas are unsupported.');
    const name = `crux-${randomUUID()}`;
    const args = ['run', '--rm', '--name', name, '--pull=never', '--network=none', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=256', '--memory=2g', '--cpus=2', '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=256m', '--mount', `type=bind,src=${cwd},dst=/workspace`, '--workdir', '/workspace', 'node:22', 'sh', '-c', command];
    return new Promise<CommandResult>((resolve, reject) => {
      let output = ''; let timedOut = false; let canceled = false; let done = false;
      const child = spawn('docker', args, { windowsHide: true, shell: false, env: { ...process.env } });
      const session: TerminalSession = {info: {id: name, command, cwd, startedAt: Date.now(), status: 'running'}, process: child, output: '', stdout: '', stderr: '', container: name};
      this.sessions.set(name, session);
      this.emitOutput(name, 'system', `Running in isolated container: ${cwd}`);
      const finish = (error?: Error, exitCode: number | null = null) => {
        if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        const status = canceled || session.info.status === 'killed' ? 'killed' : timedOut ? 'timed_out' : error || exitCode !== 0 ? 'error' : 'completed';
        this.finalizeSession(name, exitCode, status);
        this.emitOutput(name, 'system', `Container command ${status}; exit ${exitCode}.`);
        if (error) reject(error); else resolve({ command, cwd, exitCode, output, stdout:session.stdout, stderr:session.stderr, durationMs:Date.now()-session.info.startedAt, execution:'container', timedOut, sessionId: name });
      };
      const remove = () => { void execFileAsync('docker', ['rm', '-f', name], { windowsHide: true, timeout: 5000 }).catch(() => undefined).finally(() => { child.kill(); finish(canceled ? new Error('Operation canceled.') : undefined); }); };
      const abort = () => { canceled = true; remove(); };
      const timer = setTimeout(() => { timedOut = true; remove(); }, timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      child.stdout?.on('data', (data: Buffer) => { output = (output + data.toString()).slice(-200_000); this.emitOutput(name, 'stdout', data.toString()); });
      child.stderr?.on('data', (data: Buffer) => { output = (output + data.toString()).slice(-200_000); this.emitOutput(name, 'stderr', data.toString()); });
      child.once('error', error => finish(error));
      child.once('close', code => finish(canceled ? new Error('Operation canceled.') : undefined, code));
    });
  }

  async execute(
    command: string,
    cwd?: string,
    onOutput?: (output: TerminalOutput) => void,
    completion?: (result: CommandResult) => void,
    timeoutMs = MAX_DURATION_MS,
  ): Promise<string> {
    this.validateTimeout(timeoutMs);
    const normalizedCommand = command.trim();
    if (!normalizedCommand) {
      throw new Error('Command cannot be empty.');
    }

    this.assertSafeCommand(normalizedCommand);

    const sessionId = randomUUID();
    const workingDirectory = cwd || process.cwd();
    const shellArgs = process.platform === 'win32'
      ? ['-NoProfile', '-Command', `& { ${normalizedCommand} }; $cruxSucceeded = $?; $cruxNativeExit = $LASTEXITCODE; if ($null -ne $cruxNativeExit) { exit $cruxNativeExit }; if (-not $cruxSucceeded) { exit 1 }; exit 0`]
      : ['-lc', normalizedCommand];

    const child = spawn(this.shell, shellArgs, {
      cwd: workingDirectory,
      env: { ...process.env, FORCE_COLOR: '1' },
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });

    const session: TerminalSession = {
      info: {
        id: sessionId,
        command: normalizedCommand,
        cwd: workingDirectory,
        startedAt: Date.now(),
        status: 'running',
      },
      process: child,
      output: '',
      stdout: '',
      stderr: '',
      complete: completion,
    };

    session.timeout = setTimeout(() => {
      this.emitOutput(sessionId, 'system', `Command timed out after ${timeoutMs / 1000}s.`, onOutput);
      this.kill(sessionId, 'timed_out').catch((error) => {
        log.error('Failed to kill timed out session:', error);
      });
    }, timeoutMs);

    this.sessions.set(sessionId, session);
    this.emitOutput(sessionId, 'system', `Running in ${workingDirectory}`, onOutput);

    child.stdout?.on('data', (data: Buffer) => {
      this.emitOutput(sessionId, 'stdout', data.toString(), onOutput);
    });

    child.stderr?.on('data', (data: Buffer) => {
      this.emitOutput(sessionId, 'stderr', data.toString(), onOutput);
    });

    child.on('close', (code) => {
      const forced = session.info.status === 'timed_out' || session.info.status === 'killed';
      this.finalizeSession(sessionId, code, forced ? session.info.status : code === 0 ? 'completed' : 'error');
      this.emitOutput(
        sessionId,
        'system',
        code === 0 ? 'Command completed successfully.' : `Command exited with code ${code}.`,
        onOutput,
      );
    });

    child.on('error', (error) => {
      this.finalizeSession(sessionId, null, 'error');
      this.emitOutput(sessionId, 'stderr', error.message, onOutput);
    });

    return sessionId;
  }

  async executeAndWait(command: string, cwd?: string, signal?: AbortSignal, timeoutMs = MAX_DURATION_MS): Promise<CommandResult> {
    if (signal?.aborted) throw new Error('Operation canceled.');
    return new Promise<CommandResult>((resolve, reject) => {
      let sessionId: string | undefined;
      const abort = () => { if (sessionId) void this.kill(sessionId); };
      signal?.addEventListener('abort', abort, { once: true });
      this.execute(command, cwd, undefined, result => {
        signal?.removeEventListener('abort', abort);
        if (signal?.aborted) reject(new Error('Operation canceled.')); else resolve(result);
      }, timeoutMs).then(id => { sessionId = id; if (signal?.aborted) abort(); }).catch(error => { signal?.removeEventListener('abort', abort); reject(error); });
    });
  }

  async kill(sessionId: string, status: 'killed' | 'timed_out' = 'killed'): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    session.info.status = status;

    if (session.container) {
      await execFileAsync('docker', ['rm', '-f', session.container], {windowsHide: true, timeout: 5000}).catch(() => undefined);
      session.process.kill(); this.finalizeSession(sessionId, null, status); return;
    }

    if (process.platform === 'win32' && session.process.pid) {
      await new Promise<void>((resolve) => {
        const killer = spawn('taskkill', ['/PID', String(session.process.pid), '/T', '/F'], { windowsHide: true, shell: false });
        killer.once('error', () => { session.process.kill(); resolve(); });
        killer.once('close', () => resolve());
      });
    } else {
      try { if (session.process.pid) process.kill(-session.process.pid, 'SIGKILL'); }
      catch { session.process.kill('SIGKILL'); }
    }
    this.finalizeSession(sessionId, null, status);
  }

  getSessions(): TerminalSessionInfo[] {
    return [...this.completed, ...[...this.sessions.values()].map(session => session.info)]
      .map((info) => ({ ...info }))
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  private assertSafeCommand(command: string): void {
    const lowered = command.toLowerCase();
    const blockedPatterns = [
      /(^|\s)shutdown(\s|$)/,
      /(^|\s)format(\s|$)/,
      /rm\s+-rf\s+\/$/,
      /del\s+\/s\s+\/q\s+c:\\/i,
    ];

    if (blockedPatterns.some((pattern) => pattern.test(lowered))) {
      throw new Error('This command is blocked by CruX safe execution guardrails.');
    }

    const now = Date.now();
    const entry = this.recentCommands.get(lowered);
    if (entry && now - entry.lastRun < REPEAT_WINDOW_MS && entry.count >= MAX_REPEAT_COUNT) {
      throw new Error('CruX blocked a repeated command loop. Review the command before trying again.');
    }

    this.recentCommands.set(lowered, {
      count: entry && now - entry.lastRun < REPEAT_WINDOW_MS ? entry.count + 1 : 1,
      lastRun: now,
    });
  }

  private validateTimeout(timeoutMs: number): void {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_DURATION_MS) throw new Error('Command timeout must be between 1 and 120,000 milliseconds.');
  }

  private emitOutput(
    sessionId: string,
    type: TerminalOutput['type'],
    data: string,
    onOutput?: (output: TerminalOutput) => void,
  ): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.output = (session.output + data).slice(-200_000);
      if (type === 'stdout') session.stdout = (session.stdout + data).slice(-100_000);
      if (type === 'stderr') session.stderr = (session.stderr + data).slice(-100_000);
    }
    const output: TerminalOutput = {
      sessionId,
      type,
      data,
      timestamp: Date.now(),
    };

    onOutput?.(output);
    this.emit('output', output);
  }

  private finalizeSession(
    sessionId: string,
    exitCode: number | null,
    status: TerminalSessionInfo['status'],
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    if (session.timeout) {
      clearTimeout(session.timeout);
    }

    session.info.status = status;
    session.info.exitCode = exitCode;
    session.info.endedAt = Date.now();
    session.complete?.({ command: session.info.command, cwd:session.info.cwd, exitCode, output: session.output, stdout:session.stdout, stderr:session.stderr, durationMs:session.info.endedAt-session.info.startedAt, execution:session.container ? 'container' : 'host', timedOut: status === 'timed_out', sessionId });
    session.complete = undefined;
    this.completed.push({ ...session.info });
    this.emit('session-updated', {...session.info});
    if (this.completed.length > 100) this.completed.shift();
    this.sessions.delete(sessionId);
  }
}
