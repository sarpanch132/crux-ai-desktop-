import { EventEmitter } from 'events';
import log from 'electron-log';
import { FileTool } from './tools/fileTool.js';
import { TerminalTool } from './tools/terminalTool.js';
import { GitTool } from './tools/gitTool.js';
import { SearchTool } from './tools/searchTool.js';
import { SecurityLayer, SecurityConfig, SecurityPolicy } from './tools/securityLayer.js';

export interface ToolResult {
  success: boolean;
  data?: any;
  error?: string;
  tool: string;
  executionTime: number;
}

export interface ToolExecutionRequest {
  tool: string;
  method: string;
  params?: any;
  options?: {
    requireApproval?: boolean;
    timeout?: number;
    dryRun?: boolean;
  };
}

export interface ToolDefinition {
  name: string;
  description: string;
  category: 'file' | 'terminal' | 'git' | 'search' | 'security' | 'system';
  methods: string[];
  requiresApproval?: string[];
}

export class ToolRegistry extends EventEmitter {
  private fileTool: FileTool;
  private terminalTool: TerminalTool;
  private gitTool: GitTool;
  private searchTool: SearchTool;
  private securityLayer: SecurityLayer;
  private definitions: Map<string, ToolDefinition> = new Map();
  private executionCount: Map<string, number> = new Map();

  constructor(workspaceRoot?: string, securityConfig?: SecurityConfig) {
    super();
    
    this.fileTool = new FileTool(workspaceRoot);
    this.terminalTool = new TerminalTool(workspaceRoot);
    this.gitTool = new GitTool(workspaceRoot);
    this.searchTool = new SearchTool(workspaceRoot);
    this.securityLayer = new SecurityLayer(securityConfig || {
      workspaceRoot: workspaceRoot || process.cwd(),
    });

    this.registerToolDefinitions();
    this.setupEventHandlers();
  }

  private registerToolDefinitions(): void {
    this.definitions.set('file', {
      name: 'file',
      description: 'File operations (read, write, edit, delete)',
      category: 'file',
      methods: ['read', 'write', 'edit', 'delete', 'list', 'exists'],
    });

    this.definitions.set('terminal', {
      name: 'terminal',
      description: 'Terminal command execution',
      category: 'terminal',
      methods: ['execute', 'kill', 'sessions', 'killAll'],
    });

    this.definitions.set('git', {
      name: 'git',
      description: 'Git version control',
      category: 'git',
      methods: ['status', 'diff', 'commit', 'push', 'pull', 'checkout', 'branch', 'log', 'add'],
    });

    this.definitions.set('search', {
      name: 'search',
      description: 'Code search and grep',
      category: 'search',
      methods: ['search', 'grep', 'findFiles', 'findDirectories'],
    });

    this.definitions.set('security', {
      name: 'security',
      description: 'Security and approval management',
      category: 'security',
      methods: ['validate', 'approve', 'reject', 'getApprovals', 'getPolicy', 'setPolicy'],
    });
  }

  private setupEventHandlers(): void {
    this.terminalTool.on('output', (output) => {
      this.emit('terminal:output', output);
    });

    this.securityLayer.on('approval:requested', (request) => {
      this.emit('approval:requested', request);
    });

    this.securityLayer.on('approval:approved', (request) => {
      this.emit('approval:approved', request);
    });

    this.securityLayer.on('approval:rejected', (request) => {
      this.emit('approval:rejected', request);
    });
  }

  async execute(request: ToolExecutionRequest): Promise<ToolResult> {
    const startTime = Date.now();
    const { tool, method, params = {} } = request;
    const toolKey = tool.toLowerCase();

    this.executionCount.set(toolKey, (this.executionCount.get(toolKey) || 0) + 1);

    log.info(`Executing tool: ${toolKey}.${method}`);

    try {
      switch (toolKey) {
        case 'file':
          return await this.executeFileMethod(method, params, startTime);
        case 'terminal':
          return await this.executeTerminalMethod(method, params, startTime);
        case 'git':
          return await this.executeGitMethod(method, params, startTime);
        case 'search':
          return await this.executeSearchMethod(method, params, startTime);
        case 'security':
          return await this.executeSecurityMethod(method, params, startTime);
        default:
          return {
            success: false,
            error: `Unknown tool: ${tool}`,
            tool: toolKey,
            executionTime: Date.now() - startTime,
          };
      }
    } catch (error) {
      log.error(`Tool execution error: ${toolKey}.${method}`, error);
      return {
        success: false,
        error: String(error),
        tool: toolKey,
        executionTime: Date.now() - startTime,
      };
    }
  }

  private async executeFileMethod(method: string, params: any, startTime: number): Promise<ToolResult> {
    switch (method) {
      case 'read':
        const readValidation = this.securityLayer.validateFileRead(params.path);
        if (!readValidation.valid) {
          return { success: false, error: readValidation.error, tool: 'file', executionTime: 0 };
        }
        const readResult = await this.fileTool.read(params);
        return { success: readResult.success, data: readResult, tool: 'file', executionTime: Date.now() - startTime };

      case 'write':
        const writeValidation = this.securityLayer.validateFileWrite(params.path, params.content);
        if (writeValidation.requiresApproval) {
          return { success: false, error: 'Requires approval', requiresApproval: writeValidation.approvalId, tool: 'file', executionTime: 0 };
        }
        if (!writeValidation.valid) {
          return { success: false, error: writeValidation.error, tool: 'file', executionTime: 0 };
        }
        const writeResult = await this.fileTool.write(params);
        return { success: writeResult.success, data: writeResult, tool: 'file', executionTime: Date.now() - startTime };

      case 'delete':
        const deleteValidation = this.securityLayer.validateFileDelete(params.path);
        if (!deleteValidation.valid) {
          return { success: false, error: deleteValidation.error, tool: 'file', executionTime: 0 };
        }
        const deleteResult = await this.fileTool.delete(params.path);
        return { success: deleteResult.success, data: deleteResult, tool: 'file', executionTime: Date.now() - startTime };

      case 'edit':
        const editValidation = this.securityLayer.validateFileWrite(params.path);
        if (editValidation.requiresApproval) {
          return { success: false, error: 'Requires approval', requiresApproval: editValidation.approvalId, tool: 'file', executionTime: 0 };
        }
        if (!editValidation.valid) {
          return { success: false, error: editValidation.error, tool: 'file', executionTime: 0 };
        }
        const editResult = await this.fileTool.applyEdits(params);
        return { success: editResult.success, data: editResult, tool: 'file', executionTime: Date.now() - startTime };

      case 'list':
        const listResult = await this.fileTool.list(params);
        return { success: listResult.success, data: listResult, tool: 'file', executionTime: Date.now() - startTime };

      case 'exists':
        const existsResult = await this.fileTool.exists(params.path);
        return { success: true, data: existsResult, tool: 'file', executionTime: Date.now() - startTime };

      default:
        return { success: false, error: `Unknown method: ${method}`, tool: 'file', executionTime: 0 };
    }
  }

  private async executeTerminalMethod(method: string, params: any, startTime: number): Promise<ToolResult> {
    switch (method) {
      case 'execute':
        const cmdValidation = this.securityLayer.validateCommand(params.command);
        if (cmdValidation.requiresApproval) {
          return { success: false, error: 'Requires approval', requiresApproval: cmdValidation.approvalId, tool: 'terminal', executionTime: 0 };
        }
        if (!cmdValidation.valid) {
          return { success: false, error: cmdValidation.error, tool: 'terminal', executionTime: 0 };
        }
        
        const onOutput = params.onOutput || ((output: any) => this.emit('terminal:output', output));
        const execResult = await this.terminalTool.execute(params.command, params, onOutput);
        return { success: execResult.success, data: execResult, tool: 'terminal', executionTime: Date.now() - startTime };

      case 'kill':
        const killResult = this.terminalTool.kill(params.sessionId);
        return { success: killResult.success, data: killResult, tool: 'terminal', executionTime: Date.now() - startTime };

      case 'sessions':
        const sessions = this.terminalTool.getSessions();
        return { success: true, data: sessions, tool: 'terminal', executionTime: Date.now() - startTime };

      case 'killAll':
        const killAllResult = this.terminalTool.killAll();
        return { success: true, data: killAllResult, tool: 'terminal', executionTime: Date.now() - startTime };

      case 'isRunning':
        const isRunning = this.terminalTool.isRunning(params.sessionId);
        return { success: true, data: isRunning, tool: 'terminal', executionTime: Date.now() - startTime };

      default:
        return { success: false, error: `Unknown method: ${method}`, tool: 'terminal', executionTime: 0 };
    }
  }

  private async executeGitMethod(method: string, params: any, startTime: number): Promise<ToolResult> {
    switch (method) {
      case 'status':
        const statusResult = await this.gitTool.status();
        return { success: statusResult.success, data: statusResult, tool: 'git', executionTime: Date.now() - startTime };

      case 'diff':
        const diffResult = await this.gitTool.diff(params);
        return { success: diffResult.success, data: diffResult, tool: 'git', executionTime: Date.now() - startTime };

      case 'commit':
        const commitResult = await this.gitTool.commit(params.message, params);
        return { success: commitResult.success, data: commitResult, tool: 'git', executionTime: Date.now() - startTime };

      case 'log':
        const logResult = await this.gitTool.log(params);
        return { success: logResult.success, data: logResult, tool: 'git', executionTime: Date.now() - startTime };

      case 'branch':
        const branchResult = await this.gitTool.branch(params);
        return { success: branchResult.success, data: branchResult, tool: 'git', executionTime: Date.now() - startTime };

      case 'add':
        const addResult = await this.gitTool.add(params.files);
        return { success: addResult.success, data: addResult, tool: 'git', executionTime: Date.now() - startTime };

      case 'push':
        const pushResult = await this.gitTool.push(params);
        return { success: pushResult.success, data: pushResult, tool: 'git', executionTime: Date.now() - startTime };

      case 'pull':
        const pullResult = await this.gitTool.pull(params);
        return { success: pullResult.success, data: pullResult, tool: 'git', executionTime: Date.now() - startTime };

      case 'checkout':
        const checkoutResult = await this.gitTool.checkout(params.branch, params);
        return { success: checkoutResult.success, data: checkoutResult, tool: 'git', executionTime: Date.now() - startTime };

      default:
        return { success: false, error: `Unknown method: ${method}`, tool: 'git', executionTime: 0 };
    }
  }

  private async executeSearchMethod(method: string, params: any, startTime: number): Promise<ToolResult> {
    switch (method) {
      case 'search':
        const searchResult = await this.searchTool.search(params);
        return { success: searchResult.success, data: searchResult, tool: 'search', executionTime: Date.now() - startTime };

      case 'grep':
        const grepResult = await this.searchTool.grep(params);
        return { success: grepResult.success, data: grepResult, tool: 'search', executionTime: Date.now() - startTime };

      case 'findFiles':
        const findFilesResult = await this.searchTool.findFiles(params);
        return { success: findFilesResult.success, data: findFilesResult, tool: 'search', executionTime: Date.now() - startTime };

      case 'findDirectories':
        const findDirsResult = await this.searchTool.findDirectories(params);
        return { success: findDirsResult.success, data: findDirsResult, tool: 'search', executionTime: Date.now() - startTime };

      default:
        return { success: false, error: `Unknown method: ${method}`, tool: 'search', executionTime: 0 };
    }
  }

  private async executeSecurityMethod(method: string, params: any, startTime: number): Promise<ToolResult> {
    switch (method) {
      case 'validate':
        const { type, target } = params;
        if (type === 'read') {
          return { success: true, data: this.securityLayer.validateFileRead(target), tool: 'security', executionTime: 0 };
        } else if (type === 'write') {
          return { success: true, data: this.securityLayer.validateFileWrite(target), tool: 'security', executionTime: 0 };
        } else if (type === 'command') {
          return { success: true, data: this.securityLayer.validateCommand(target), tool: 'security', executionTime: 0 };
        }
        return { success: false, error: 'Unknown validation type', tool: 'security', executionTime: 0 };

      case 'approve':
        const approveResult = await this.securityLayer.requestApproval(params.approvalId, true, params.approver);
        return { success: approveResult, tool: 'security', executionTime: Date.now() - startTime };

      case 'reject':
        const rejectResult = await this.securityLayer.requestApproval(params.approvalId, false, params.approver);
        return { success: rejectResult, tool: 'security', executionTime: Date.now() - startTime };

      case 'getPolicy':
        return { success: true, data: this.securityLayer.getPolicy(), tool: 'security', executionTime: 0 };

      case 'setPolicy':
        this.securityLayer.setPolicy(params.policy);
        return { success: true, tool: 'security', executionTime: Date.now() - startTime };

      case 'getApprovals':
        const approvals = this.securityLayer.getPendingApproval(params.approvalId);
        return { success: true, data: approvals, tool: 'security', executionTime: 0 };

      default:
        return { success: false, error: `Unknown method: ${method}`, tool: 'security', executionTime: 0 };
    }
  }

  getDefinitions(): ToolDefinition[] {
    return Array.from(this.definitions.values());
  }

  getStats(): { executions: Record<string, number>; activeSessions: number } {
    return {
      executions: Object.fromEntries(this.executionCount),
      activeSessions: this.terminalTool.getActiveCount(),
    };
  }

  onTerminalOutput(callback: (output: any) => void): void {
    this.on('terminal:output', callback);
  }

  onApprovalRequest(callback: (request: any) => void): void {
    this.on('approval:requested', callback);
  }
}

export default ToolRegistry;