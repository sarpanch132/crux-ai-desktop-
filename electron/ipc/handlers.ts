import { BrowserWindow, IpcMain, dialog, shell, app } from 'electron';
import Store from 'electron-store';
import log from 'electron-log';
import { AIService, AISettings } from '../services/aiService.js';
import { FileService } from '../services/fileService.js';
import { TerminalService } from '../services/terminalService.js';

interface HandlerDependencies {
  fileService: FileService;
  terminalService: TerminalService;
  aiService: AIService;
  store: Store<any>;
  mainWindow: () => BrowserWindow | null;
}

function success<T>(data?: T) {
  return { success: true, data };
}

function failure(channel: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  log.error(`IPC error in ${channel}:`, error);
  return { success: false, error: message };
}

export function registerIPCHandlers(ipcMain: IpcMain, deps: HandlerDependencies) {
  const { fileService, terminalService, aiService, store, mainWindow } = deps;

  ipcMain.handle('file:read', async (_event, filePath: string) => {
    try {
      return success(await fileService.readFile(filePath));
    } catch (error) {
      return failure('file:read', error);
    }
  });

  ipcMain.handle('file:write', async (_event, filePath: string, content: string) => {
    try {
      await fileService.writeFile(filePath, content);
      return success();
    } catch (error) {
      return failure('file:write', error);
    }
  });

  ipcMain.handle('file:delete', async (_event, filePath: string) => {
    try {
      await fileService.deleteFile(filePath);
      return success();
    } catch (error) {
      return failure('file:delete', error);
    }
  });

  ipcMain.handle('file:list', async (_event, dirPath: string, options?: { recursive?: boolean; filter?: string[] }) => {
    try {
      return success(await fileService.listFiles(dirPath, options));
    } catch (error) {
      return failure('file:list', error);
    }
  });

  ipcMain.handle('file:search', async (_event, pattern: string, options?: { cwd?: string; ignore?: string[] }) => {
    try {
      return success(await fileService.searchFiles(pattern, options));
    } catch (error) {
      return failure('file:search', error);
    }
  });

  ipcMain.handle('file:createDirectory', async (_event, dirPath: string) => {
    try {
      await fileService.createDirectory(dirPath);
      return success();
    } catch (error) {
      return failure('file:createDirectory', error);
    }
  });

  ipcMain.handle('file:edit', async (_event, filePath: string, edits: { search: string; replace: string }[]) => {
    try {
      const original = await fileService.readFile(filePath);
      const updated = edits.reduce((content, edit) => content.replace(edit.search, edit.replace), original);
      await fileService.writeFile(filePath, updated);
      return success(updated);
    } catch (error) {
      return failure('file:edit', error);
    }
  });

  ipcMain.handle('terminal:exec', async (_event, command: string, cwd?: string) => {
    try {
      const sessionId = await terminalService.execute(command, cwd, (output) => {
        mainWindow()?.webContents.send('terminal:output', output);
      });
      return success(sessionId);
    } catch (error) {
      return failure('terminal:exec', error);
    }
  });

  ipcMain.handle('terminal:kill', async (_event, sessionId: string) => {
    try {
      await terminalService.kill(sessionId);
      return success();
    } catch (error) {
      return failure('terminal:kill', error);
    }
  });

  ipcMain.handle('terminal:sessions', async () => {
    try {
      return success(terminalService.getSessions());
    } catch (error) {
      return failure('terminal:sessions', error);
    }
  });

  ipcMain.handle('ai:chat', async (_event, messages, options) => {
    try {
      return success(await aiService.chat(messages, options));
    } catch (error) {
      return failure('ai:chat', error);
    }
  });

  ipcMain.on('ai:stream:start', async (event, messages, options) => {
    try {
      for await (const chunk of aiService.stream(messages, options)) {
        event.sender.send('ai:stream:chunk', chunk);
      }
      event.sender.send('ai:stream:done');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      event.sender.send('ai:stream:error', message);
    }
  });

  ipcMain.on('ai:stream:abort', () => {
    aiService.abortStream();
  });

  ipcMain.handle('ai:abort', async () => {
    aiService.abortStream();
    return success();
  });

  ipcMain.handle('ai:getModels', async () => {
    try {
      return success(await aiService.getModels());
    } catch (error) {
      return failure('ai:getModels', error);
    }
  });

  ipcMain.handle('ai:getHealth', async () => {
    try {
      return success(await aiService.getHealth());
    } catch (error) {
      return failure('ai:getHealth', error);
    }
  });

  ipcMain.handle('ai:getSettings', async () => {
    try {
      return success(aiService.getSettings());
    } catch (error) {
      return failure('ai:getSettings', error);
    }
  });

  ipcMain.handle('ai:updateSettings', async (_event, partial: Partial<AISettings>) => {
    try {
      return success(aiService.updateSettings(partial));
    } catch (error) {
      return failure('ai:updateSettings', error);
    }
  });

  ipcMain.handle('project:open', async () => {
    try {
      const result = await dialog.showOpenDialog(mainWindow()!, {
        properties: ['openDirectory'],
        title: 'Open Project',
      });

      if (result.canceled || !result.filePaths[0]) {
        return { success: false, error: 'Canceled' };
      }

      const projectPath = result.filePaths[0];
      store.set('workspace.currentProject', projectPath);
      mainWindow()?.webContents.send('project:opened', projectPath);
      return success(projectPath);
    } catch (error) {
      return failure('project:open', error);
    }
  });

  ipcMain.handle('project:close', async () => {
    store.delete('workspace.currentProject');
    mainWindow()?.webContents.send('project:closed');
    return success();
  });

  ipcMain.handle('project:getPath', async () => {
    return success(store.get('workspace.currentProject'));
  });

  ipcMain.handle('config:get', async (_event, key: string) => success(store.get(key)));
  ipcMain.handle('config:set', async (_event, key: string, value: unknown) => {
    store.set(key, value);
    return success();
  });

  ipcMain.handle('window:minimize', async () => {
    mainWindow()?.minimize();
    return success();
  });

  ipcMain.handle('window:maximize', async () => {
    const win = mainWindow();
    if (win?.isMaximized()) {
      win.unmaximize();
    } else {
      win?.maximize();
    }
    return success(win?.isMaximized());
  });

  ipcMain.handle('window:close', async () => {
    mainWindow()?.hide();
    return success();
  });

  ipcMain.handle('window:isMaximized', async () => {
    return success(mainWindow()?.isMaximized());
  });

  ipcMain.handle('dialog:openFile', async (_event, options?: { filters?: { name: string; extensions: string[] }[]; multiple?: boolean }) => {
    try {
      const result = await dialog.showOpenDialog(mainWindow()!, {
        properties: options?.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
        filters: options?.filters,
      });

      if (result.canceled) {
        return { success: false, error: 'Canceled' };
      }

      return success(result.filePaths);
    } catch (error) {
      return failure('dialog:openFile', error);
    }
  });

  ipcMain.handle('dialog:openDirectory', async () => {
    try {
      const result = await dialog.showOpenDialog(mainWindow()!, {
        properties: ['openDirectory'],
      });

      if (result.canceled || !result.filePaths[0]) {
        return { success: false, error: 'Canceled' };
      }

      return success(result.filePaths[0]);
    } catch (error) {
      return failure('dialog:openDirectory', error);
    }
  });

  ipcMain.handle('dialog:saveFile', async (_event, options?: { defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) => {
    try {
      const result = await dialog.showSaveDialog(mainWindow()!, {
        defaultPath: options?.defaultPath,
        filters: options?.filters,
      });

      if (result.canceled || !result.filePath) {
        return { success: false, error: 'Canceled' };
      }

      return success(result.filePath);
    } catch (error) {
      return failure('dialog:saveFile', error);
    }
  });

  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
    try {
      await shell.openExternal(url);
      return success();
    } catch (error) {
      return failure('shell:openExternal', error);
    }
  });

  ipcMain.handle('store:get', async (_event, key: string) => success(store.get(key)));
  ipcMain.handle('store:set', async (_event, key: string, value: unknown) => {
    store.set(key, value);
    return success();
  });

  ipcMain.handle('app:getVersion', async () => success(app.getVersion()));
  ipcMain.handle('app:getPlatform', async () => success(process.platform));

  ipcMain.handle('security:getApprovals', async () => success([]));
  ipcMain.handle('security:approve', async () => success());
  ipcMain.handle('tool:execute', async () => ({
    success: false,
    error: 'Generic tool execution is not enabled in this build. Use file and terminal APIs directly.',
  }));

  log.info('CruX IPC handlers registered');
}
