import { EventEmitter } from 'events';
import log from 'electron-log';

export interface SecurityConfig {
  workspaceRoot: string;
  allowReadOutside?: boolean;
  allowWriteOutside?: boolean;
  allowCommandOutside?: boolean;
  requireApprovalFor?: string[];
  maxFileSize?: number;
  timeout?: number;
  dangerousCommands?: string[];
  allowedCommands?: string[];
}

export interface ApprovalRequest {
  id: string;
  type: 'file_write' | 'file_delete' | 'command_execute' | 'command_approval';
  title: string;
  description: string;
  details: any;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  requestedAt: number;
  expiresAt: number;
  approvedBy?: string;
  approvedAt?: number;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
  warning?: string;
  requiresApproval?: boolean;
  approvalId?: string;
}

export interface SecurityPolicy {
  allowRead: boolean;
  allowWrite: boolean;
  allowDelete: boolean;
  allowExecute: boolean;
  allowNetwork: boolean;
  requireApproval: boolean;
  maxFileSize: number;
  timeout: number;
}

const DEFAULT_POLICY: SecurityPolicy = {
  allowRead: true,
  allowWrite: true,
  allowDelete: false,
  allowExecute: true,
  allowNetwork: true,
  requireApproval: true,
  maxFileSize: 10 * 1024 * 1024,
  timeout: 60000,
};

const DANGEROUS_PATTERNS = {
  command: [
    /^\s*rm\s+-rf/i,
    /^\s*del\s+\/[sfq]/i,
    /^\s*format\s+/i,
    /^\s*mkfs/i,
    /^\s*dd\s+if=/i,
    />\s*\/(dev|sys|proc)/i,
    /chmod\s+777/i,
    /chown\s+-R/i,
    /killall/i,
    /pkill\s+-9/i,
    /launchctl\s+unload/i,
    /sysctl\s+-w/i,
    /echo\s+>*\s*\//i,
  ],
  path: [
    /^\/System/i,
    /^\/Library\/Receipts/i,
    /^\/usr\/bin\/passwd/i,
    /^\/etc\/passwd/i,
    /^\/etc\/shadow/i,
    /^C:\\Windows\\System32\\config/i,
    /^C:\\Users\\.*\\.ssh/i,
    /\\device\\harddisk/i,
  ],
  extension: [
    /\.exe$/i,
    /\.dll$/i,
    /\.so$/i,
    /\.dylib$/i,
    /\.bat$/i,
    /\.cmd$/i,
    /\.ps1$/i,
    /\.sh$/i,
    /\.sql$/i,
  ],
};

const APPROVAL_REQUIRED = {
  command: [
    /npm\s+i\s+-g/i,
    /npm\s+install\s+-g/i,
    /pip\s+install\s+--user/i,
    /chmod\s+777/i,
    /sudo\s+.+/i,
    /git\s+push\s+--force/i,
    /git\s+push\s+--mirror/i,
  ],
  path: [
    /\.env$/i,
    /\.pem$/i,
    /\.key$/i,
    /\.pub$/i,
    /id_rsa/i,
    /id_ed25519/i,
  ],
};

export class SecurityLayer extends EventEmitter {
  private config: SecurityConfig;
  private policy: SecurityPolicy;
  private approvalRequests: Map<string, ApprovalRequest> = new Map();
  private autoApprovedCommands: Set<string> = new Set();

  constructor(config: SecurityConfig) {
    super();
    this.config = config;
    this.policy = { ...DEFAULT_POLICY };
  }

  setPolicy(policy: Partial<SecurityPolicy>): void {
    this.policy = { ...this.policy, ...policy };
  }

  getPolicy(): SecurityPolicy {
    return { ...this.policy };
  }

  validateFileRead(filePath: string): ValidationResult {
    if (!this.policy.allowRead) {
      return { valid: false, error: 'Reading files is not allowed' };
    }

    const resolved = this.resolvePath(filePath);

    for (const pattern of DANGEROUS_PATTERNS.path) {
      if (pattern.test(resolved)) {
        return { valid: false, error: `Cannot read from path: ${pattern}` };
      }
    }

    if (!this.isInsideWorkspace(resolved) && !this.config.allowReadOutside) {
      return { valid: false, error: 'Path is outside workspace' };
    }

    return { valid: true };
  }

  validateFileWrite(filePath: string, content?: string): ValidationResult {
    if (!this.policy.allowWrite) {
      return { valid: false, error: 'Writing files is not allowed' };
    }

    const resolved = this.resolvePath(filePath);

    for (const ext of DANGEROUS_PATTERNS.extension) {
      if (ext.test(resolved)) {
        return { valid: false, error: 'Cannot write to executable files' };
      }
    }

    if (!this.isInsideWorkspace(resolved) && !this.config.allowWriteOutside) {
      return { valid: false, error: 'Path is outside workspace' };
    }

    const requiresApproval = this.checkRequiresApproval('write', filePath);
    if (requiresApproval) {
      return this.createApprovalRequest('file_write', 'Write file', `Write to ${filePath}`, {
        path: filePath,
        content,
      });
    }

    return { valid: true };
  }

  validateFileDelete(filePath: string): ValidationResult {
    if (!this.policy.allowDelete) {
      return { valid: false, error: 'Deleting files is not allowed' };
    }

    return { valid: false, error: 'File deletion requires manual approval' };
  }

  validateCommand(command: string): ValidationResult {
    if (!this.policy.allowExecute) {
      return { valid: false, error: 'Executing commands is not allowed' };
    }

    const trimmed = command.trim();

    for (const pattern of DANGEROUS_PATTERNS.command) {
      if (pattern.test(trimmed)) {
        return { valid: false, error: 'Dangerous command blocked' };
      }
    }

    if (this.config.allowedCommands?.length) {
      const allowed = this.config.allowedCommands.some(cmd => trimmed.startsWith(cmd));
      if (!allowed) {
        return { valid: false, error: 'Command not in allowed list' };
      }
    }

    const requiresApproval = this.checkRequiresApproval('command', command);
    if (requiresApproval) {
      return this.createApprovalRequest('command_execute', 'Execute command', command, {
        command,
      });
    }

    return { valid: true };
  }

  validateNetwork(url: string): ValidationResult {
    if (!this.policy.allowNetwork) {
      return { valid: false, error: 'Network access is not allowed' };
    }

    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return { valid: false, error: 'Only HTTP/HTTPS allowed' };
      }
    } catch {
      return { valid: false, error: 'Invalid URL' };
    }

    return { valid: true };
  }

  private resolvePath(filePath: string): string {
    if (!filePath) return '';
    return filePath.replace(/\\/g, '/');
  }

  private isInsideWorkspace(path: string): boolean {
    const normalized = path.replace(/\\/g, '/');
    const workspace = this.config.workspaceRoot.replace(/\\/g, '/');
    return normalized.startsWith(workspace) || normalized.includes(workspace);
  }

  private checkRequiresApproval(type: 'write' | 'command' | 'delete', target: string): boolean {
    if (!this.policy.requireApproval) return false;

    if (this.autoApprovedCommands.has(target)) return false;

    if (type === 'write') {
      for (const pattern of APPROVAL_REQUIRED.path) {
        if (pattern.test(target)) return true;
      }
    }

    if (type === 'command') {
      for (const pattern of APPROVAL_REQUIRED.command) {
        if (pattern.test(target)) return true;
      }
    }

    return false;
  }

  private createApprovalRequest(
    type: ApprovalRequest['type'],
    title: string,
    description: string,
    details: any
  ): ValidationResult {
    const request: ApprovalRequest = {
      id: `approval_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      type,
      title,
      description,
      details,
      status: 'pending',
      requestedAt: Date.now(),
      expiresAt: Date.now() + 300000,
    };

    this.approvalRequests.set(request.id, request);
    this.emit('approval:requested', request);

    log.info(`Approval requested: ${request.id} - ${title}`);

    return {
      valid: false,
      requiresApproval: true,
      approvalId: request.id,
    };
  }

  async requestApproval(approvalId: string, approved: boolean, approver?: string): Promise<boolean> {
    const request = this.approvalRequests.get(approvalId);
    
    if (!request) {
      return false;
    }

    if (approvalId in this.approvalRequests) {
      request.status = approved ? 'approved' : 'rejected';
      request.approvedBy = approver || 'user';
      request.approvedAt = Date.now();

      this.approvalRequests.delete(approvalId);
      this.emit(approved ? 'approval:approved' : 'approval:rejected', request);

      log.info(`Approval ${request.status}: ${approvalId}`);
      return true;
    }

    return false;
  }

  getPendingApproval(approvalId?: string): ApprovalRequest | ApprovalRequest[] | undefined {
    if (approvalId) {
      return this.approvalRequests.get(approvalId);
    }
    return Array.from(this.approvalRequests.values()).filter(r => r.status === 'pending');
  }

  clearExpiredApprovals(): number {
    const now = Date.now();
    let cleared = 0;

    for (const [id, request] of this.approvalRequests) {
      if (request.expiresAt < now) {
        request.status = 'expired';
        this.approvalRequests.delete(id);
        cleared++;
      }
    }

    return cleared;
  }

  autoApprove(command: string): void {
    this.autoApprovedCommands.add(command);
  }

  revokeAutoApprove(command: string): void {
    this.autoApprovedCommands.delete(command);
  }
}

export default SecurityLayer;