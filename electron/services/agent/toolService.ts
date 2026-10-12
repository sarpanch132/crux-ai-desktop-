import path from 'node:path';
import type { FileService } from '../fileService.js';
import type { TerminalService } from '../terminalService.js';
import type { ToolRequest, FileChange, Diagnostic } from './contracts.js';
import { PermissionGateway, canonicalPath } from './permissionGateway.js';
import { unlink, writeFile } from 'node:fs/promises';
import { ChangeStore, contentHash, sensitivePath, textSnapshot } from './changeStore.js';
import { inspectRepository } from './repositoryContext.js';
import { normalizeToolRequest, TOOL_DESCRIPTORS } from './toolRegistry.js';

export class ToolService {
  private inspectedHashes = new Map<string,string>();
  private ownedProcesses = new Set<string>();
  getDiagnostics?: () => Diagnostic[];
  descriptors() {
    return TOOL_DESCRIPTORS.map(item => item.name === 'diagnostics' ? { ...item, available: Boolean(this.getDiagnostics), reason: this.getDiagnostics ? undefined : item.reason } : item);
  }
  async stopOwnedProcesses(): Promise<void> {
    if (!this.ownedProcesses.size) return;
    await Promise.all(this.terminal.getSessions().filter(session => this.ownedProcesses.has(session.id) && session.status === 'running').map(session => this.terminal.kill(session.id)));
  }
  onChanged?: (change: FileChange) => void;
  onInspected?: (file: string) => void;
  onResult?: (request: ToolRequest, result: unknown) => void;
  constructor(private gateway: PermissionGateway, private files: FileService, private terminal: TerminalService, private browser?: {inspect(url: string, signal?: AbortSignal): Promise<unknown>}, private changes?: ChangeStore) {}
  async execute(request: ToolRequest, signal?: AbortSignal): Promise<unknown> {
    request = normalizeToolRequest(request);
    const authorizationRevision = this.gateway.permissions.revision;
    const assertAuthorized = () => {
      if (signal?.aborted) throw new Error('Operation canceled.');
      if (authorizationRevision !== this.gateway.permissions.revision) throw new Error('Permissions changed before tool execution. Retry the operation.');
    };
    const workspace = this.gateway.workspace;
    const rawTarget = request.path ? (path.isAbsolute(request.path) ? request.path : path.resolve(workspace || process.cwd(), request.path)) : workspace || '';
    const target = rawTarget ? await canonicalPath(rawTarget) : '';
    if (!target && !['browser', 'computer', 'tool_registry'].includes(request.tool)) throw new Error('Open a project before using tools.');
    try {
      let result: unknown;
      switch (request.tool) {
        case 'read':
          if (sensitivePath(target)) throw new Error('Credential files cannot be read into coding context.');
          await this.gateway.authorize({ capability: 'read', target }, signal);
          assertAuthorized();
          result = await this.files.readFile(target); this.inspectedHashes.set(target,contentHash(result as string)); this.onInspected?.(target); break;
        case 'list':
          await this.gateway.authorize({ capability: 'read', target }, signal);
          assertAuthorized();
          result = await this.files.listFiles(target, { recursive: request.recursive }); break;
        case 'context':
          await this.gateway.authorize({ capability: 'read', target }, signal);
          assertAuthorized();
          result = await inspectRepository(target, this.files);
          for (const file of (result as { inspectedFiles?: string[] }).inspectedFiles || []) this.onInspected?.(file);
          break;
        case 'file_search':
          await this.gateway.authorize({ capability: 'read', target, payload: request.pattern }, signal);
          assertAuthorized();
          if (typeof request.pattern !== 'string') throw new Error('Filename pattern is required.');
          result = await this.files.searchNames(request.pattern, target); break;
        case 'symbol_search':
        case 'find_references': {
          await this.gateway.authorize({ capability: 'read', target, payload: request.pattern }, signal);
          assertAuthorized();
          if (typeof request.pattern !== 'string' || !/^[A-Za-z_$][\w$]{0,99}$/.test(request.pattern)) throw new Error('A lexical identifier is required.');
          const escaped = request.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const pattern = request.tool === 'symbol_search' ? `(?:class|function|interface|type|const|let|var|def|struct|enum|fn)\\s+${escaped}\\b` : `\\b${escaped}\\b`;
          result = { kind: 'lexical', matches: await this.files.searchFiles(pattern, { cwd: target }) }; break;
        }
        case 'search':
          await this.gateway.authorize({ capability: 'read', target, payload: request.pattern }, signal);
          assertAuthorized();
          if (typeof request.pattern !== 'string' || request.pattern.length > 200) throw new Error('Search pattern must be at most 200 characters.');
          // Treat searches as literal input: untrusted regexes can lock the main process.
          result = await this.files.searchFiles(request.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), { cwd: target }); break;
        case 'write':
          if (typeof request.content !== 'string') throw new Error('File content must be a string.');
          if (request.createOnly && await this.files.exists(target)) throw new Error('Create refuses to overwrite an existing file. Use edit instead.');
          result = await this.applyChanges([{ path: target, after: request.content, expectedHash: request.createOnly ? null : request.expectedHash ?? this.inspectedHashes.get(target) }], assertAuthorized, signal); break;
        case 'edit':
        case 'patch': {
          const edits = request.tool === 'edit' ? [{ path: target, search: request.search, replacement: request.replacement, expectedHash: request.expectedHash ?? this.inspectedHashes.get(target) }] : request.edits;
          if (!Array.isArray(edits) || !edits.length || edits.length > 20) throw new Error('Patch requires 1–20 file edits.');
          const modifications = [];
          for (const edit of edits) {
            if (!edit || typeof edit.path !== 'string' || typeof edit.search !== 'string' || typeof edit.replacement !== 'string' || typeof edit.expectedHash !== 'string') throw new Error('Each targeted edit requires path, search, replacement and expectedHash.');
            const file = await canonicalPath(path.resolve(workspace || '', edit.path));
            await this.gateway.authorize({ capability: 'read', target: file }, signal);
            assertAuthorized();
            const before = await textSnapshot(file);
            if (before === null || contentHash(before) !== edit.expectedHash) throw new Error('File changed since inspection. Read it again before editing.');
            if (edit.search === '' && before !== '') throw new Error('Empty search is allowed only when editing an empty file.');
            const index = before.indexOf(edit.search);
            if (index === -1 || (edit.search !== '' && before.indexOf(edit.search, index + 1) !== -1)) throw new Error('Targeted edit search must match exactly once.');
            this.onInspected?.(file);
            modifications.push({ path: file, after: before.slice(0, index) + edit.replacement + before.slice(index + edit.search.length), expectedHash: edit.expectedHash });
          }
          result = await this.applyChanges(modifications, assertAuthorized, signal); break;
        }
        case 'move': {
          if (typeof request.destination !== 'string' || !request.destination) throw new Error('Move destination is required.');
          const destination = await canonicalPath(path.resolve(workspace || '', request.destination));
          await this.gateway.authorize({ capability: 'read', target }, signal);
          assertAuthorized();
          const before = await textSnapshot(target);
          if (before === null) throw new Error('Move source does not exist.');
          if (await this.files.exists(destination)) throw new Error('Move refuses to overwrite an existing destination.');
          result = await this.applyChanges([{ path: destination, after: before, expectedHash: null }, { path: target, after: null, expectedHash: request.expectedHash || contentHash(before) }], assertAuthorized, signal); break;
        }
        case 'changes': {
          if (!this.changes) throw new Error('Change tracking is unavailable for this session.');
          const records = request.changeId ? [await this.changes.detail(request.changeId)] : await this.changes.list();
          for (const record of records) await this.gateway.authorize({ capability: 'read', target: record.path }, signal);
          assertAuthorized();
          result = request.changeId ? records[0] : records; break;
        }
        case 'accept': {
          if (!this.changes || !request.changeId) throw new Error('A session change ID is required.');
          const record = await this.changes.detail(request.changeId);
          await this.gateway.authorize({ capability: 'read', target: record.path }, signal);
          assertAuthorized(); result = await this.changes.accept(request.changeId); break;
        }
        case 'revert': {
          if (!this.changes || !request.changeId) throw new Error('A session change ID is required.');
          const record = await this.changes.detail(request.changeId);
          await this.gateway.authorize({ capability: 'read', target: record.path }, signal);
          assertAuthorized();
          const current = await textSnapshot(record.path);
          if (current !== record.after) throw new Error('Revert conflict: file changed after the agent edit. Your changes were preserved.');
          result = await this.applyChanges([{ path: record.path, after: record.before, expectedHash: record.afterHash }], assertAuthorized, signal);
          await this.changes.remove(record.id); break;
        }
        case 'tool_registry': result = this.descriptors(); break;
        case 'diagnostics':
          if (!this.getDiagnostics) throw new Error('Diagnostics are available in the session Problems view; no tool binding is configured.');
          await this.gateway.authorize({ capability: 'read', target }, signal);
          assertAuthorized(); result = this.getDiagnostics().slice(0, 200); break;
        case 'processes':
          await this.gateway.authorize({ capability: 'read', target }, signal);
          assertAuthorized();
          result = this.terminal.getSessions().filter(session => this.ownedProcesses.has(session.id)); break;
        case 'process_stop': {
          if (typeof request.sessionId !== 'string' || !this.ownedProcesses.has(request.sessionId)) throw new Error('Process does not belong to this agent session.');
          const session = this.terminal.getSessions().find(item => item.id === request.sessionId);
          if (!session) throw new Error('Process is no longer available.');
          await this.gateway.authorize({ capability: 'read', target: session.cwd }, signal);
          await this.gateway.authorize({ capability: 'execute', target: `stop process ${session.id}`, payload: { command: session.command, cwd: session.cwd }, hostExecution: true, destructive: true }, signal);
          assertAuthorized(); await this.terminal.kill(session.id); result = { stopped: session.id }; break;
        }
        case 'process_start': {
          if (typeof request.command !== 'string' || !request.command.trim() || request.command.length > 16_000) throw new Error('Invalid process command.');
          if (this.gateway.permissions.level === 'medium' && this.gateway.permissions.sandboxAvailable) throw new Error('Background container processes are not supported. Use a bounded container command; no host fallback was performed.');
          const timeoutMs = request.timeoutMs ?? 120_000;
          if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error('Process timeout must be between 1 and 120,000 milliseconds.');
          const sessions = this.terminal.getSessions();
          if (sessions.filter(item => this.ownedProcesses.has(item.id) && item.status === 'running').length >= 4) throw new Error('This agent session already has four running processes. Stop one before starting another.');
          await this.gateway.authorize({ capability: 'read', target }, signal);
          await this.gateway.authorize({ capability: 'execute', target: request.command, payload: { cwd: target, timeoutMs, background: true }, hostExecution: true, destructive: true }, signal);
          assertAuthorized();
          const before = await this.fileStamps(target);
          assertAuthorized();
          const abort = () => { void this.terminal.kill(processId).catch(() => undefined); };
          const processId = await this.terminal.execute(request.command, target, undefined, outcome => {
            signal?.removeEventListener('abort', abort);
            void this.recordCommandChanges(target, before).then(() => this.onResult?.({ tool: 'process_start', command: request.command, path: target, verification: request.verification }, outcome)).catch(() => this.gateway.audit('process:result', target, 'error', 'Process result could not be recorded.'));
          }, timeoutMs);
          this.ownedProcesses.add(processId);
          if (this.ownedProcesses.size > 256) for (const id of this.ownedProcesses) if (!this.terminal.getSessions().some(item => item.id === id)) this.ownedProcesses.delete(id);
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
          result = { sessionId: processId, command: request.command, cwd: target, timeoutMs, execution: 'host' }; break;
        }
        case 'check': {
          const kinds = ['test', 'lint', 'typecheck', 'build'];
          if (!request.checkKind || !kinds.includes(request.checkKind)) throw new Error('Choose test, lint, typecheck, or build.');
          await this.gateway.authorize({ capability: 'read', target }, signal);
          assertAuthorized();
          const context = await inspectRepository(target, this.files);
          if (!context.metadata?.scripts[request.checkKind]) throw new Error(`No ${request.checkKind} script was detected. Inspect the project and use its explicit command.`);
          const managers = context.metadata.packageManagers;
          const manager = managers.includes('pnpm') ? 'pnpm' : managers.includes('yarn') ? 'yarn' : 'npm';
          result = await this.execute({ tool: 'command', path: target, command: `${manager} run ${request.checkKind}`, verification: true }, signal); break;
        }
        case 'mkdir':
          await this.gateway.authorize({ capability: 'write', target, payload: 'mkdir' }, signal);
          assertAuthorized();
          await this.files.createDirectory(target); this.changed(target, 'mkdir'); result = { created: target }; break;
        case 'delete':
          result = await this.applyChanges([{ path: target, after: null, expectedHash: request.expectedHash }], assertAuthorized, signal); break;
        case 'command': {
          if (typeof request.command !== 'string' || !request.command.trim() || request.command.length > 16_000) throw new Error('Invalid command.');
          const cwd = await canonicalPath(target);
          await this.gateway.authorize({ capability: 'read', target: cwd }, signal);
          const sandboxed = this.gateway.permissions.level === 'medium' && this.gateway.permissions.sandboxAvailable;
          await this.gateway.authorize({ capability: 'execute', target: request.command, payload: { cwd, sandboxed }, hostExecution: !sandboxed, destructive: true }, signal);
          assertAuthorized();
          const before = await this.fileStamps(cwd);
          assertAuthorized();
          try { result = sandboxed ? await this.terminal.executeAndWaitSandbox(request.command, cwd, signal,request.timeoutMs) : await this.terminal.executeAndWait(request.command, cwd, signal,request.timeoutMs); }
          finally { await this.recordCommandChanges(cwd, before); }
          break;
        }
        case 'git': {
          const args = request.args;
          if (!Array.isArray(args) || args.length === 0 || args.some(a => typeof a !== 'string' || /[\r\n\0]/.test(a))) throw new Error('Git requires explicit arguments.');
          const verb = args[0];
          // Conservative read forms avoid -c, external diff, pager, aliases and hooks.
          const readOnly = ['status', 'diff', 'log', 'show', 'branch'].includes(verb) && args.every(a => /^[-\w./:@= ]+$/.test(a)) && !args.some(a => /^(-c|--exec|--ext-diff|--output|--no-index|--textconv)/.test(a)) && (verb !== 'branch' || args.length === 1);
          const cwd = await canonicalPath(target);
          await this.gateway.authorize({ capability: readOnly ? 'gitRead' : 'gitMutate', target: cwd, payload: args }, signal);
          // Git configuration and hooks can execute programs, even for apparently read-only invocations.
          const command = process.platform === 'win32'
            ? `git ${args.map(a => `'${a.replace(/'/g, "''")}'`).join(' ')}`
            : `git ${args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`;
          await this.gateway.authorize({ capability: 'execute', target: command, payload: { cwd }, hostExecution: true, destructive: !readOnly }, signal);
          assertAuthorized();
          result = await this.terminal.executeAndWait(command, cwd, signal); break;
        }
        case 'browser': {
          if (!this.browser) throw new Error('browser adapter is not installed. No action was performed.');
          if (typeof request.url !== 'string' || request.url.length > 4096) throw new Error('A valid browser URL is required.');
          const url = new URL(request.url);
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP(S) web inspection is supported.');
          await this.gateway.authorize({capability: 'browser', target: url.href, payload: {operation: 'inspect', origin: url.origin}, destructive: true}, signal);
          assertAuthorized();
          result = await this.browser.inspect(url.href, signal); break;
        }
        case 'computer':
          throw new Error(`${request.tool} adapter is not installed. No action was performed.`);
        default: throw new Error('Unknown tool.');
      }
      this.gateway.audit(request.tool, target || request.command || '', 'completed', 'Tool finished');
      this.onResult?.(request, result);
      return result;
    } catch (error) { this.gateway.audit(request.tool, target || request.command || '', 'error', error instanceof Error ? error.message : String(error)); throw error; }
  }
  private async applyChanges(modifications: { path: string; after: string | null; expectedHash?: string | null }[], assertAuthorized: () => void, signal?: AbortSignal): Promise<unknown> {
    if (new Set(modifications.map(item => process.platform === 'win32' ? item.path.toLowerCase() : item.path)).size !== modifications.length) throw new Error('Patch contains duplicate paths.');
    const snapshots = [];
    for (const item of modifications) {
      await this.gateway.authorize({ capability: 'read', target: item.path }, signal);
      assertAuthorized();
      const before = await textSnapshot(item.path);
      const hash = before === null ? null : contentHash(before);
      if (before !== null && item.expectedHash === undefined) throw new Error('Read the existing file before changing it, or provide its inspected expectedHash.');
      if (item.expectedHash !== undefined && item.expectedHash !== hash) throw new Error('File changed since inspection. Read it again before editing.');
      if (item.after !== null && (Buffer.byteLength(item.after) > 2 * 1024 * 1024 || item.after.includes('\0'))) throw new Error('Edit exceeds the text-file limit.');
      const checkpoint = this.changes ? await this.changes.capture(item.path, item.after) : undefined;
      if (checkpoint && checkpoint.beforeHash !== hash) throw new Error('File changed while preparing checkpoint.');
      snapshots.push({ ...item, before, checkpoint });
    }
    // Obtain every authorization before the first write; approvals bind exact before/after content.
    for (const item of snapshots) {
      await this.gateway.authorize({ capability: item.after === null ? 'delete' : 'write', target: item.path, payload: { beforeHash: item.before === null ? null : contentHash(item.before), after: item.after }, destructive: item.after === null }, signal);
      assertAuthorized();
    }
    for (const item of snapshots) {
      assertAuthorized();
      if (await canonicalPath(item.path) !== item.path || await textSnapshot(item.path) !== item.before) throw new Error('File or path changed during approval. No changes were applied.');
    }
    const applied: typeof snapshots = [];
    // Persist recoverable before/after data before any mutation; failed partial writes retain it.
    if (this.changes) await this.changes.commit(snapshots.flatMap(item => item.checkpoint ? [item.checkpoint] : []));
    try {
      for (const item of snapshots) {
        assertAuthorized();
        if (await canonicalPath(item.path) !== item.path) throw new Error('File path changed before write.');
        if (await textSnapshot(item.path) !== item.before) throw new Error('File changed before write.');
        if (item.after === null) await this.files.deleteFile(item.path); else await this.files.writeFile(item.path, item.after);
        applied.push(item);
      }
    } catch (error) {
      const conflicts: string[] = [];
      for (const item of [...applied].reverse()) {
        try {
          if (await canonicalPath(item.path) !== item.path) throw new Error('Path changed during rollback');
          if (await textSnapshot(item.path) !== item.after) throw new Error('Concurrent edit');
          if (item.before === null) await unlink(item.path); else await writeFile(item.path, item.before, 'utf8');
        } catch { conflicts.push(item.path); }
      }
      if (conflicts.length) throw new Error(`Patch failed; rollback conflicts preserved newer files: ${conflicts.join(', ')}. Inspect changes before retrying.`);
      if (this.changes) for (const item of snapshots) if (item.checkpoint) await this.changes.remove(item.checkpoint.id);
      throw error;
    }
    for (const item of snapshots) {
      if (item.after === null) this.inspectedHashes.delete(item.path);
      else this.inspectedHashes.set(item.path, contentHash(item.after));
      this.changed(item.path, item.after === null ? 'delete' : 'write');
    }
    return { changed: snapshots.map(item => item.path), checkpointIds: snapshots.flatMap(item => item.checkpoint ? [item.checkpoint.id] : []) };
  }
  private changed(target: string, operation: FileChange['operation']): void { this.onChanged?.({ path: path.resolve(target), operation, timestamp: Date.now() }); }
  private async fileStamps(root: string): Promise<Map<string, string>> {
    const files = await this.files.listFiles(root);
    return new Map(files.filter(file => file.type === 'file').map(file => [file.path, `${file.size}:${file.modified}`]));
  }
  private async recordCommandChanges(root: string, before: Map<string, string>): Promise<void> {
    try {
      const after = await this.fileStamps(root);
      for (const [file, stamp] of after) if (before.get(file) !== stamp) {this.changed(file, 'write'); this.gateway.audit('command:file-change', file, 'completed', 'Workspace file changed during command execution');}
      for (const file of before.keys()) if (!after.has(file)) {this.changed(file, 'delete'); this.gateway.audit('command:file-change', file, 'completed', 'Workspace file removed during command execution');}
    } catch (error) {this.gateway.audit('command:change-scan', root, 'error', error instanceof Error ? error.message : String(error));}
  }
}
