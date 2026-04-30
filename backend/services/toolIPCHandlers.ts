import { IpcMain, BrowserWindow, dialog } from 'electron';
import Store from 'electron-store';
import log from 'electron-log';
import { ToolRegistry, ToolExecutionRequest } from '../services/toolRegistry.js';

interface HandlerDependencies {
  toolRegistry: ToolRegistry;
  store: Store;
  mainWindow: () => BrowserWindow | null;
}

function handleIPCError(error: unknown, channel: string) {
  log.error(`IPC error [${channel}]:`, error);
  return { success: false, error: error instanceof Error ? error.message : String(error) };
}

export function registerToolIPCHandlers(ipcMain: IpcMain, deps: HandlerDependencies) {
  const { toolRegistry, store, mainWindow } = deps;

  ipcMain.handle('tool:execute', async (_event, request: ToolExecutionRequest) => {
    try {
      const result = await toolRegistry.execute(request);
      return result;
    } catch (error) {
      return handleIPCError(error, 'tool:execute');
    }
  });

  ipcMain.handle('tool:list', async () => {
    try {
      const definitions = toolRegistry.getDefinitions();
      return { success: true, data: definitions };
    } catch (error) {
      return handleIPCError(error, 'tool:list');
    }
  });

  ipcMain.handle('tool:stats', async () => {
    try {
      const stats = toolRegistry.getStats();
      return { success: true, data: stats };
    } catch (error) {
      return handleIPCError(error, 'tool:stats');
    }
  });

  ipcMain.handle('file:read', async (_event, filePath: string, options?: any) => {
    try {
      const result = await toolRegistry.execute({
        tool: 'file',
        method: 'read',
        params: { path: filePath, ...options },
      });
      return { success: result.success, data: result.data, error: result.error };
    } catch (error) {
      return handleIPCError(error, 'file:read');
    }
  });

  ipcMain.handle('file:write', async (_event, filePath: string, content: string) => {
    try {
      const result = await toolRegistry.execute({
        tool: 'file',
        method: 'write',
        params: { path: filePath, content },
      });
      return { success: result.success, data: result.data, error: result.error };
    } catch (error) {
      return handleIPCError(error, 'file:write');
    }
  });

  ipcMain.handle('file:delete', async (_event, filePath: string) => {
    try {
      const result = await toolRegistry.execute({
        tool: 'file',
        method: 'delete',
        params: { path: filePath },
      });
      return { success: result.success, data: result.data, error: result.error };
    } catch (error) {
      return handleIPCError(error, 'file:delete');
    }
  });

  ipcMain.handle('file:list', async (_event, dirPath: string, options?: any) => {
    try {
      const result = await toolRegistry.execute({
        tool: 'file',
        method: 'list',
        params: { path: dirPath, ...options },
      });
      return { success: result.success, data: result.data, error: result.error };
    } catch (error) {
      return handleIPCError(error, 'file:list');
    }
  });

  ipcMain.handle('file:edit', async (_event, filePath: string, edits: any[]) => {
    try {
      const result = await toolRegistry.execute({
        tool: 'file',
        method: 'edit',
        params: { path: filePath, edits },
      });
      return { success: result.success, data: result.data, error: result.error };
    } catch (error) {
      return handleIPCError(error, 'file:edit');
    }
  });

  ipcMain.handle('terminal:exec', async (event, command: string, cwd?: string) => {
    try {
      const onOutput = (output: any) => {
        mainWindow()?.webContents.send('terminal:output', output);
      };

      const result = await toolRegistry.execute({
        tool: 'terminal',
        method: 'execute',
        params: { command, cwd, onOutput },
      });
      return { success: result.success, data: result.data, error: result.error };
    } catch (error) {
      return handleIPCError(error, 'terminal:exec');
    }
  });

  ipcMain.handle('terminal:kill', async (_event, sessionId: string) => {
    try {
      const result = await toolRegistry.execute({
        tool: 'terminal',
        method: 'kill',
        params: { sessionId },
      });
      return { success: result.success, error: result.error };
    } catch (error) {
      return handleIPCError(error, 'terminal:kill');
    }
  });

  ipcMain.handle('terminal:sessions', async () => {
    try {
      const result = await toolRegistry.execute({
        tool: 'terminal',
        method: 'sessions',
        params: {},
      });
      return { success: true, data: result.data };
    } catch (error) {
      return handleIPCError(error, 'terminal:sessions');
    }
  });

  ipcMain.handle('search:grep', async (_event, pattern: string, options?: any) => {
    try {
      const result = await toolRegistry.execute({
        tool: 'search',
        method: 'grep',
        params: { pattern, ...options },
      });
      return { success: result.success, data: result.data, error: result.error };
    } catch (error) {
      return handleIPCError(error, 'search:grep');
    }
  });

  ipcMain.handle('search:files', async (_event, pattern: string, options?: any) => {
    try {
      const result = await toolRegistry.execute({
        tool: 'search',
        method: 'search',
        params: { pattern, ...options },
      });
      return { success: result.success, data: result.data, error: result.error };
    } catch (error) {
      return handleIPCError(error, 'search:files');
    }
  });

  ipcMain.handle('git:status', async () => {
    try {
      const result = await toolRegistry.execute({
        tool: 'git',
        method: 'status',
        params: {},
      });
      return { success: result.success, data: result.data, error: result.error };
    } catch (error) {
      return handleIPCError(error, 'git:status');
    }
  });

  ipcMain.handle('git:diff', async (_event, options?: any) => {
    try {
      const result = await toolRegistry.execute({
        tool: 'git',
        method: 'diff',
        params: options || {},
      });
      return { success: result.success, data: result.data, error: result.error };
    } catch (error) {
      return handleIPCError(error, 'git:diff');
    }
  });

  ipcMain.handle('git:commit', async (_event, message: string, options?: any) => {
    try {
      const result = await toolRegistry.execute({
        tool: 'git',
        method: 'commit',
        params: { message, ...options },
      });
      return { success: result.success, data: result.data, error: result.error };
    } catch (error) {
      return handleIPCError(error, 'git:commit');
    }
  });

  ipcMain.handle('security:approve', async (_event, approvalId: string, approved: boolean) => {
    try {
      const result = await toolRegistry.execute({
        tool: 'security',
        method: approved ? 'approve' : 'reject',
        params: { approvalId },
      });
      return { success: result.success, error: result.error };
    } catch (error) {
      return handleIPCError(error, 'security:approve');
    }
  });

  ipcMain.handle('security:getApprovals', async () => {
    try {
      const result = await toolRegistry.execute({
        tool: 'security',
        method: 'getApprovals',
        params: {},
      });
      return { success: true, data: result.data };
    } catch (error) {
      return handleIPCError(error, 'security:getApprovals');
    }
  });

  log.info('Tool IPC handlers registered');
}