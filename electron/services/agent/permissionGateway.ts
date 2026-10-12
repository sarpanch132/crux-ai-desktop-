import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { AgentMode, AccessLevel, Capability, AgentPermissions, ApprovalRequest, AuditEntry } from './contracts.js';

export interface PermissionRequest { capability: Capability; target: string; payload?: unknown; destructive?: boolean; hostExecution?: boolean; }
const CAPABILITIES: Capability[] = ['read', 'write', 'delete', 'execute', 'gitRead', 'gitMutate', 'browser', 'computerControl', 'installDependencies'];
const MUTATIONS = new Set<Capability>(['write', 'delete', 'execute', 'gitMutate', 'installDependencies', 'browser', 'computerControl']);
export async function canonicalPath(target: string): Promise<string> {
  const absolute = path.resolve(target);
  if (process.platform === 'win32' && (/^\\\\[?.]/.test(absolute) || absolute.slice(2).includes(':'))) throw new Error('Device paths and alternate data streams are not allowed.');
  let current = absolute;
  const remainder: string[] = [];
  for (let depth = 0; depth < 256; depth++) {
    try { return path.join(await realpath(current), ...remainder); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      remainder.unshift(path.basename(current)); current = parent;
    }
  }
  throw new Error('Path exceeds the supported nesting limit.');
}
export function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

interface Pending { request: ApprovalRequest; hash: string; revision: number; resolve: (decision: 'once' | 'session' | 'deny') => void; }
export class PermissionGateway {
  private policy: AgentPermissions;
  private pending = new Map<string, Pending>();
  private grants = new Set<string>();
  private routeScope: Set<Capability> | null = null;
  constructor(private sessionId: string, private projectPath: string | null, private mode: AgentMode,
    private auditCallback: (entry: AuditEntry) => void = () => undefined,
    private approvalCallback: (request: ApprovalRequest) => void = () => undefined) {
    this.policy = { level: 'medium', allowedPaths: [], capabilities: Object.fromEntries(CAPABILITIES.map(c => [c, c !== 'computerControl' && c !== 'browser'])) as Record<Capability, boolean>, revision: 0, sandboxAvailable: false };
  }
  get permissions(): AgentPermissions { return { ...this.policy, allowedPaths: [...this.policy.allowedPaths], capabilities: Object.fromEntries(CAPABILITIES.map(c => [c, this.policy.capabilities[c] && (!this.routeScope || this.routeScope.has(c))])) as Record<Capability, boolean> }; }
  setRouteCapabilities(capabilities: Capability[] | null): void {
    if (capabilities !== null && (!Array.isArray(capabilities) || capabilities.some(c => !CAPABILITIES.includes(c)))) throw new Error('Invalid agent tool scope.');
    this.routeScope = capabilities === null ? null : new Set(capabilities); this.revoke();
  }
  get routeCapabilities(): Capability[] | null { return this.routeScope ? [...this.routeScope] : null; }
  get workspace(): string | null { return this.projectPath; }
  setSandboxAvailable(available: boolean): void { this.policy.sandboxAvailable = available; }
  get approvals(): ApprovalRequest[] { return [...this.pending.values()].map(p => ({ ...p.request })); }
  setMode(mode: AgentMode): void { if (!['plan', 'code', 'debug'].includes(mode)) throw new Error('Invalid agent mode.'); this.mode = mode; this.revoke(); this.audit('mode', mode, 'approved', 'Execution mode changed; grants revoked'); }
  setLevel(level: AccessLevel): void { if (!['full', 'medium', 'restricted'].includes(level)) throw new Error('Invalid access level.'); this.policy.level = level; this.revoke(); this.audit('access', level, 'approved', 'Access level changed; grants revoked'); }
  configure(capabilities: Partial<Record<Capability, boolean>>, allowedPaths: string[]): void {
    if (!Array.isArray(allowedPaths) || allowedPaths.some(p => typeof p !== 'string' || !path.isAbsolute(p))) throw new Error('Folder grants require absolute paths.');
    for (const [key, value] of Object.entries(capabilities)) { if (!CAPABILITIES.includes(key as Capability) || typeof value !== 'boolean') throw new Error('Invalid capability.'); }
    this.policy.capabilities = { ...this.policy.capabilities, ...capabilities };
    this.policy.allowedPaths = [...new Set(allowedPaths)]; this.revoke();
    this.audit('permissions', allowedPaths.join(', '), 'approved', 'Capabilities and folder grants updated; prior grants revoked');
  }
  revoke(): void { this.policy.revision++; this.grants.clear(); for (const item of this.pending.values()) item.resolve('deny'); this.pending.clear(); }
  resolve(id: string, decision: 'once' | 'session' | 'deny'): boolean {
    if (!['once', 'session', 'deny'].includes(decision)) return false;
    const item = this.pending.get(id);
    if (!item || item.revision !== this.policy.revision || item.request.expiresAt <= Date.now()) { item?.resolve('deny'); return false; }
    if (decision === 'session' && !item.request.allowSession) return false;
    this.pending.delete(id); item.resolve(decision); return true;
  }
  audit(tool: string, target: string, outcome: AuditEntry['outcome'], detail: string): void {
    this.auditCallback({ id: randomUUID(), timestamp: Date.now(), sessionId: this.sessionId, tool, target, outcome, detail });
  }
  async authorize(input: PermissionRequest, signal?: AbortSignal): Promise<void> {
    const request = { ...input };
    const startingRevision = this.policy.revision;
    this.audit(request.capability, request.target, 'requested', 'Tool permission check');
    try {
      if (signal?.aborted) throw new Error('Operation canceled.');
      if (!CAPABILITIES.includes(request.capability) || typeof request.target !== 'string' || !request.target) throw new Error('Invalid tool permission request.');
      if (!this.permissions.capabilities[request.capability]) throw new Error(`Capability ${request.capability} is disabled.`);
      if (request.capability === 'execute') {
        const required: Capability[] = ['read', 'write', 'delete', 'installDependencies'];
        const disabled = required.filter(c => !this.permissions.capabilities[c]);
        if (disabled.length) throw new Error(`Arbitrary commands can bypass disabled capabilities (${disabled.join(', ')}). Enable them or use a structured file tool.`);
      }
      if (this.mode === 'plan' && MUTATIONS.has(request.capability)) throw new Error('Plan mode cannot modify files or execute commands. Switch to Code or Debug.');
      let inside = true;
      if (['read', 'write', 'delete', 'gitRead', 'gitMutate'].includes(request.capability)) {
        request.target = await canonicalPath(request.target);
        const roots = [this.projectPath, ...this.policy.allowedPaths].filter((p): p is string => Boolean(p));
        inside = false;
        for (const root of roots) if (isWithin(await canonicalPath(root), request.target)) { inside = true; break; }
        if (this.policy.level !== 'full' && this.projectPath && request.target === await canonicalPath(this.projectPath) && request.capability === 'delete') throw new Error('Deleting the project root is prohibited.');
      }
      if (signal?.aborted) throw new Error('Operation canceled.');
      if (startingRevision !== this.policy.revision) throw new Error('Permissions changed during authorization. Retry the operation.');
      const revision = startingRevision;
      const hash = createHash('sha256').update(JSON.stringify({ session: this.sessionId, revision, mode: this.mode, ...request })).digest('hex');
      const sensitive = /(^|[\\/])(\.env(?:\.[^\\/]*)?|\.ssh|\.aws|\.azure|credentials|id_rsa|id_ed25519|[^\\/]*\.(?:pem|key))($|[\\/])/i.test(request.target);
      const requiresApproval = request.destructive || request.hostExecution || sensitive || (this.policy.level === 'restricted' && MUTATIONS.has(request.capability)) || (this.policy.level !== 'full' && !inside) || ['browser', 'computerControl', 'installDependencies'].includes(request.capability);
      if (requiresApproval && !this.grants.has(hash)) {
        const reason = request.hostExecution ? 'This command runs on your host with access beyond the project and may modify/delete files or install dependencies. Approve this exact command once.' : request.capability === 'browser' ? 'Load this web page and same-origin resources in an isolated, temporary browser. Network requests may have server-side effects. Page text is untrusted; no host tools or stored cookies are exposed.' : request.capability === 'execute' ? 'This command runs in the isolated container with a writable project folder. It can modify/delete project files or install project dependencies. Approve this exact command once.' : request.destructive ? 'Destructive operation requires approval.' : sensitive ? 'This path may contain credentials or secrets. Approve access explicitly.' : !inside ? 'Target is outside the approved project folders.' : 'This capability requires approval.';
        const approval: ApprovalRequest = { id: randomUUID(), sessionId: this.sessionId, tool: request.capability, target: request.target, reason, expiresAt: Date.now() + 300_000, allowSession: !request.hostExecution && !request.destructive };
        const decision = await new Promise<'once' | 'session' | 'deny'>((resolve) => {
          let finished = false;
          const finish = (value: 'once' | 'session' | 'deny') => { if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending.delete(approval.id); resolve(value); };
          const abort = () => finish('deny');
          const timer = setTimeout(() => finish('deny'), 300_000);
          this.pending.set(approval.id, { request: approval, hash, revision, resolve: finish });
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) finish('deny'); else this.approvalCallback(approval);
        });
        if (decision === 'deny' || signal?.aborted || revision !== this.policy.revision) throw new Error('Approval denied, expired, revoked, or canceled.');
        if (decision === 'session') this.grants.add(hash);
      }
      if (signal?.aborted) throw new Error('Operation canceled.');
      if (revision !== this.policy.revision) throw new Error('Permissions changed during authorization. Retry the operation.');
      this.audit(request.capability, request.target, 'approved', requiresApproval ? 'Exact operation approved' : 'Allowed by current policy');
    } catch (error) { this.audit(request.capability, request.target, 'denied', error instanceof Error ? error.message : String(error)); throw error; }
  }
}
