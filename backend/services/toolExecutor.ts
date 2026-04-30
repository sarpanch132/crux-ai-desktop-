import { EventEmitter } from 'events';
import { readFile, writeFile, unlink, readdir, stat, mkdir, access } from 'fs/promises';
import { spawn, ChildProcess } from 'child_process';
import { join, dirname, relative, sep } from 'path';
import { v4 as uuidv4 } from 'uuid';
import log from 'electron-log';
import { AgentConfig, ExecutionResult, ToolResult } from '../types/index.js';

export interface Tool {
  name: string;
  description: string;
  params: Param[];
  execute: (params: any) => Promise<any>;
}

interface Param {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

export interface ToolResult {
  success: boolean;
  data?: any;
  error?: string;
  executionTime?: number;
}

export class ToolExecutor extends EventEmitter {
  private config: AgentConfig;
  private tools: Map<string, Tool> = new Map();
  private activeProcesses: Map<string, ChildProcess> = new Map();

  constructor(config: AgentConfig) {
    super();
    this.config = config;
    this.registerDefaultTools();
  }

  private registerDefaultTools(): void {
    this.registerTool({
      name: 'read_file',
      description: 'Read a file from the filesystem',
      params: [
        { name: 'path', type: 'string', required: true, description: 'Absolute path to file' },
      ],
      execute: async (params) => this.readFile(params.path),
    });

    this.registerTool({
      name: 'write_file',
      description: 'Write content to a file',
      params: [
        { name: 'path', type: 'string', required: true, description: 'Absolute path to file' },
        { name: 'content', type: 'string', required: true, description: 'Content to write' },
      ],
      execute: async (params) => this.writeFile(params.path, params.content),
    });

    this.registerTool({
      name: 'delete_file',
      description: 'Delete a file',
      params: [
        { name: 'path', type: 'string', required: true, description: 'Absolute path to file' },
      ],
      execute: async (params) => this.deleteFile(params.path),
    });

    this.registerTool({
      name: 'create_directory',
      description: 'Create a directory',
      params: [
        { name: 'path', type: 'string', required: true, description: 'Absolute path to directory' },
      ],
      execute: async (params) => this.createDirectory(params.path),
    });

    this.registerTool({
      name: 'list_directory',
      description: 'List files in a directory',
      params: [
        { name: 'path', type: 'string', required: true, description: 'Directory path' },
        { name: 'recursive', type: 'boolean', required: false, description: 'List recursively' },
      ],
      execute: async (params) => this.listDirectory(params.path, params.recursive),
    });

    this.registerTool({
      name: 'execute_command',
      description: 'Execute a terminal command',
      params: [
        { name: 'command', type: 'string', required: true, description: 'Command to execute' },
        { name: 'cwd', type: 'string', required: false, description: 'Working directory' },
        { name: 'timeout', type: 'number', required: false, description: 'Timeout in ms' },
        { name: 'env', type: 'object', required: false, description: 'Environment variables' },
      ],
      execute: async (params) => this.executeCommand(params.command, params.cwd, params.timeout, params.env),
    });

    this.registerTool({
      name: 'search_code',
      description: 'Search for code patterns',
      params: [
        { name: 'pattern', type: 'string', required: true, description: 'Search pattern' },
        { name: 'path', type: 'string', required: false, description: 'Search path' },
        { name: 'ignore', type: 'array', required: false, description: 'Paths to ignore' },
      ],
      execute: async (params) => this.searchCode(params.pattern, params.path, params.ignore),
    });

    this.registerTool({
      name: 'scan_repository',
      description: 'Scan repository structure',
      params: [
        { name: 'ignore', type: 'array', required: false, description: 'Paths to ignore' },
      ],
      execute: async (params) => this.scanRepository(params.ignore),
    });

    this.registerTool({
      name: 'git_status',
      description: 'Get git status',
      params: [
        { name: 'cwd', type: 'string', required: false, description: 'Working directory' },
      ],
      execute: async (params) => this.gitStatus(params.cwd),
    });

    this.registerTool({
      name: 'git_diff',
      description: 'Get git diff',
      params: [
        { name: 'cwd', type: 'string', required: false, description: 'Working directory' },
      ],
      execute: async (params) => this.gitDiff(params.cwd),
    });

    this.registerTool({
      name: 'diagnose',
      description: 'Diagnose an error',
      params: [
        { name: 'error', type: 'string', required: true, description: 'Error message' },
        { name: 'context', type: 'object', required: false, description: 'Context information' },
      ],
      execute: async (params) => this.diagnose(params.error, params.context),
    });

    this.registerTool({
      name: 'get_dependencies',
      description: 'Get project dependencies',
      params: [
        { name: 'cwd', type: 'string', required: false, description: 'Working directory' },
      ],
      execute: async (params) => this.getDependencies(params.cwd),
    });

    this.registerTool({
      name: 'analyze_imports',
      description: 'Analyze import statements',
      params: [
        { name: 'file', type: 'string', required: true, description: 'File to analyze' },
      ],
      execute: async (params) => this.analyzeImports(params.file),
    });
  }

  registerTool(tool: Tool): void {
    this.tools.set(tool.name, tool);
    log.debug(`Registered tool: ${tool.name}`);
  }

  getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  listTools(): string[] {
    return Array.from(this.tools.keys());
  }

  async execute(toolName: string, params: any): Promise<ExecutionResult> {
    const startTime = Date.now();
    const tool = this.tools.get(toolName);

    if (!tool) {
      return { success: false, error: `Tool not found: ${toolName}`, executionTime: 0 };
    }

    this.emit('tool:executing', toolName, params);
    log.info(`Executing tool: ${toolName}`);

    try {
      const result = await tool.execute(params);
      const executionTime = Date.now() - startTime;

      if (result) {
        this.emit('tool:completed', toolName, result);
        return { success: true, data: result, executionTime };
      } else {
        return { success: true, data: null, executionTime };
      }
    } catch (error) {
      const executionTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      this.emit('tool:failed', toolName, error);
      log.error(`Tool execution failed: ${toolName}`, error);
      
      return { success: false, error: errorMessage, executionTime };
    }
  }

  async readFile(filePath: string): Promise<any> {
    try {
      const content = await readFile(filePath, 'utf-8');
      return content;
    } catch (error) {
      throw new Error(`Failed to read ${filePath}: ${error}`);
    }
  }

  async writeFile(filePath: string, content: string): Promise<any> {
    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content, 'utf-8');
      return { success: true, path: filePath };
    } catch (error) {
      throw new Error(`Failed to write ${filePath}: ${error}`);
    }
  }

  async deleteFile(filePath: string): Promise<any> {
    try {
      await unlink(filePath);
      return { success: true, path: filePath };
    } catch (error) {
      throw new Error(`Failed to delete ${filePath}: ${error}`);
    }
  }

  async createDirectory(dirPath: string): Promise<any> {
    try {
      await mkdir(dirPath, { recursive: true });
      return { success: true, path: dirPath };
    } catch (error) {
      throw new Error(`Failed to create directory ${dirPath}: ${error}`);
    }
  }

  async listDirectory(dirPath: string, recursive = false): Promise<any> {
    const files: any[] = [];
    
    const scan = async (path: string, depth = 0) => {
      if (!recursive && depth > 1) return;

      const entries = await readdir(path, { withFileTypes: true });
      
      for (const entry of entries) {
        if (this.config.ignorePatterns?.includes(entry.name)) continue;

        const fullPath = join(path, entry.name);
        const stats = await stat(fullPath);

        files.push({
          name: entry.name,
          path: fullPath,
          type: entry.isDirectory() ? 'directory' : 'file',
          size: stats.size,
          modified: stats.mtimeMs,
        });

        if (entry.isDirectory()) {
          await scan(fullPath, depth + 1);
        }
      }
    };

    await scan(dirPath);
    return { files, count: files.length };
  }

  async executeCommand(
    command: string,
    cwd?: string,
    timeout = 60000,
    env?: Record<string, string>
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const processId = uuidv4();
      const workingDir = cwd || this.config.projectPath || process.cwd();
      
      log.info(`Executing command: ${command} in ${workingDir}`);
      
      const childProcess = spawn(
        process.platform === 'win32' ? 'powershell.exe' : '/bin/bash',
        process.platform === 'win32' ? ['-c', command] : ['-c', command],
        {
          cwd: workingDir,
          env: { ...process.env, ...env, FORCE_COLOR: '1' },
          shell: false,
        }
      );

      this.activeProcesses.set(processId, childProcess);

      let stdout = '';
      let stderr = '';

      const timeoutHandle = setTimeout(() => {
        childProcess.kill();
        reject(new Error(`Command timeout after ${timeout}ms`));
      }, timeout);

      childProcess.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      childProcess.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      childProcess.on('close', (code) => {
        clearTimeout(timeoutHandle);
        this.activeProcesses.delete(processId);
        
        resolve({
          success: code === 0,
          code,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          command,
        });
      });

      childProcess.on('error', (error) => {
        clearTimeout(timeoutHandle);
        this.activeProcesses.delete(processId);
        reject(error);
      });
    });
  }

  async searchCode(
    pattern: string,
    searchPath?: string,
    ignore?: string[]
  ): Promise<any> {
    const results: any[] = [];
    const workingDir = searchPath || this.config.projectPath || process.cwd();
    const ignorePatterns = ignore || this.config.ignorePatterns || ['node_modules', '.git'];
    
    const regex = new RegExp(pattern, 'gi');

    const scan = async (dirPath: string) => {
      try {
        const entries = await readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
          if (ignorePatterns.includes(entry.name)) continue;

          const fullPath = join(dirPath, entry.name);

          if (entry.isDirectory()) {
            await scan(fullPath);
          } else if (entry.isFile() && /\.(ts|tsx|js|jsx|py|rs|go|java|c|cpp|h)$/i.test(entry.name)) {
            try {
              const content = await readFile(fullPath, 'utf-8');
              const lines = content.split('\n');

              for (let i = 0; i < lines.length; i++) {
                if (regex.test(lines[i])) {
                  results.push({
                    file: fullPath,
                    line: i + 1,
                    content: lines[i].trim(),
                    match: lines[i].trim(),
                  });
                }
              }

              regex.lastIndex = 0;
            } catch (error) {
              log.warn(`Could not search ${fullPath}:`, error);
            }
          }
        }
      } catch (error) {
        log.warn(`Could not scan ${dirPath}:`, error);
      }
    };

    await scan(workingDir);
    return { results: results.slice(0, 100), count: results.length };
  }

  async scanRepository(ignore?: string[]): Promise<any> {
    const workingDir = this.config.projectPath || process.cwd();
    const files: any[] = [];
    let structure = '';

    const scan = async (path: string, depth = 0) => {
      if (depth > 3) return;

      const indent = '  '.repeat(depth);
      const entries = await readdir(path, { withFileTypes: true });
      
      const dirs: string[] = [];
      
      for (const entry of entries) {
        if (entry.name.startsWith('.') || (ignore || this.config.ignorePatterns || []).includes(entry.name)) {
          continue;
        }

        const fullPath = join(path, entry.name);
        
        if (entry.isDirectory()) {
          dirs.push(entry.name);
          structure += `${indent}${entry.name}/\n`;
          await scan(fullPath, depth + 1);
        } else {
          const stats = await stat(fullPath);
          structure += `${indent}${entry.name}\n`;
          files.push({
            name: entry.name,
            path: fullPath,
            size: stats.size,
          });
        }
      }
    };

    await scan(workingDir);
    
    return {
      files,
      structure,
      basePath: workingDir,
      fileCount: files.length,
    };
  }

  async gitStatus(cwd?: string): Promise<any> {
    const result = await this.executeCommand('git status --short', cwd, 10000);
    return result;
  }

  async gitDiff(cwd?: string): Promise<any> {
    const result = await this.executeCommand('git diff --no-color', cwd, 10000);
    return result;
  }

  async diagnose(error: string, context?: any): Promise<any> {
    const { AIService } = await import('./aiService.js');
    
    const prompt = `Diagnose this error:

Error: ${error}

Context: ${JSON.stringify(context, null, 2)}

Provide:
1. Likely cause
2. Suggestions to fix
3. Prevention`;

    const diagnosis = await AIService.chat([
      { role: 'system', content: 'You are an expert debugging engine.' },
      { role: 'user', content: prompt },
    ]);

    return { diagnosis, error, context };
  }

  async getDependencies(cwd?: string): Promise<any> {
    const result = await this.executeCommand('npm list --depth=0 --json', cwd, 30000);
    
    try {
      return { dependencies: JSON.parse(result.stdout || '{}') };
    } catch {
      return { dependencies: {} };
    }
  }

  async analyzeImports(file: string): Promise<any> {
    const content = await this.readFile(file);
    const importRegex = /import\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/g;
    const imports: string[] = [];
    
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      imports.push(match[1]);
    }

    return { file, imports };
  }

  killProcess(processId: string): void {
    const process = this.activeProcesses.get(processId);
    if (process) {
      process.kill();
      this.activeProcesses.delete(processId);
    }
  }

  killAll(): void {
    for (const [id, process] of this.activeProcesses) {
      process.kill();
    }
    this.activeProcesses.clear();
  }
}

export default ToolExecutor;