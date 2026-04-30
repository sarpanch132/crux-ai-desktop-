import { ChildProcess, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import log from 'electron-log';

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
}

const MAX_DURATION_MS = 120_000;
const REPEAT_WINDOW_MS = 10_000;
const MAX_REPEAT_COUNT = 2;

export class TerminalService extends EventEmitter {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly recentCommands = new Map<string, { count: number; lastRun: number }>();
  private readonly shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';

  async execute(
    command: string,
    cwd?: string,
    onOutput?: (output: TerminalOutput) => void,
  ): Promise<string> {
    const normalizedCommand = command.trim();
    if (!normalizedCommand) {
      throw new Error('Command cannot be empty.');
    }

    this.assertSafeCommand(normalizedCommand);

    const sessionId = randomUUID();
    const workingDirectory = cwd || process.cwd();
    const shellArgs = process.platform === 'win32'
      ? ['-NoProfile', '-Command', normalizedCommand]
      : ['-lc', normalizedCommand];

    const child = spawn(this.shell, shellArgs, {
      cwd: workingDirectory,
      env: { ...process.env, FORCE_COLOR: '1' },
      shell: false,
      windowsHide: true,
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
    };

    session.timeout = setTimeout(() => {
      this.emitOutput(sessionId, 'system', `Command timed out after ${MAX_DURATION_MS / 1000}s.`, onOutput);
      this.kill(sessionId, 'timed_out').catch((error) => {
        log.error('Failed to kill timed out session:', error);
      });
    }, MAX_DURATION_MS);

    this.sessions.set(sessionId, session);
    this.emitOutput(sessionId, 'system', `Running in ${workingDirectory}`, onOutput);

    child.stdout?.on('data', (data: Buffer) => {
      this.emitOutput(sessionId, 'stdout', data.toString(), onOutput);
    });

    child.stderr?.on('data', (data: Buffer) => {
      this.emitOutput(sessionId, 'stderr', data.toString(), onOutput);
    });

    child.on('close', (code) => {
      this.finalizeSession(sessionId, code, code === 0 ? 'completed' : 'error');
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

  async kill(sessionId: string, status: 'killed' | 'timed_out' = 'killed'): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    session.process.kill();
    this.finalizeSession(sessionId, null, status);
  }

  getSessions(): TerminalSessionInfo[] {
    return [...this.sessions.values()]
      .map((session) => ({ ...session.info }))
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

  private emitOutput(
    sessionId: string,
    type: TerminalOutput['type'],
    data: string,
    onOutput?: (output: TerminalOutput) => void,
  ): void {
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
    this.sessions.delete(sessionId);
  }
}
