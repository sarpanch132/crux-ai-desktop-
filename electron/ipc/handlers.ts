import { BrowserWindow, IpcMain, dialog, shell, app } from 'electron';
import Store from 'electron-store';
import { projectDirectory, recordedProject } from '../services/projectRegistry.js';
import log from 'electron-log';
import { AIService, AISettings } from '../services/aiService.js';
import { FileService } from '../services/fileService.js';
import { TerminalService } from '../services/terminalService.js';
import { AgentRuntime } from '../services/agent/runtime.js';
import type { AgentMode, AccessLevel, Capability, ToolRequest, CommandResult, DefinitionDraft, DefinitionKind, RouteSelection } from '../services/agent/contracts.js';

interface HandlerDependencies {
  fileService: FileService;
  terminalService: TerminalService;
  aiService: AIService;
  runtime: AgentRuntime;
  store: Store<any>;
  mainWindow: () => BrowserWindow | null;
}

function success<T>(data?: T) {
  return { success: true, data };
}

function failure(channel: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  log.error(`IPC error in ${channel}: ${message}`);
  return { success: false, error: message };
}

export function registerIPCHandlers(ipcMain: IpcMain, deps: HandlerDependencies) {
  const { terminalService, aiService, runtime, store, mainWindow } = deps;
  const handle = (channel: string, listener: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      const win = mainWindow();
      if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return failure(channel, new Error('Untrusted IPC sender.'));
      try { return await listener(event, ...args); } catch (error) { return failure(channel, error); }
    });
  };
  const safeStoreKey = (key: string) => {
    if (typeof key !== 'string' || !/^ui\.[a-zA-Z0-9_-]{1,60}$/.test(key)) throw new Error('Only UI preferences are accessible through generic storage.');
    return key;
  };

  handle('file:read', async (_event, filePath: string) => {
    try {
      return success(await runtime.legacy({tool: 'read', path: filePath}));
    } catch (error) {
      return failure('file:read', error);
    }
  });

  handle('file:write', async (_event, filePath: string, content: string) => {
    try {
      await runtime.legacy({tool: 'write', path: filePath, content});
      return success();
    } catch (error) {
      return failure('file:write', error);
    }
  });

  handle('file:delete', async (_event, filePath: string) => {
    try {
      await runtime.legacy({tool: 'delete', path: filePath});
      return success();
    } catch (error) {
      return failure('file:delete', error);
    }
  });

  handle('file:list', async (_event, dirPath: string, options?: { recursive?: boolean; filter?: string[] }) => {
    try {
      return success(await runtime.legacy({tool: 'list', path: dirPath, recursive: options?.recursive}));
    } catch (error) {
      return failure('file:list', error);
    }
  });

  handle('file:search', async (_event, pattern: string, options?: { cwd?: string; ignore?: string[] }) => {
    try {
      return success(await runtime.legacy({tool: 'search', path: options?.cwd, pattern}));
    } catch (error) {
      return failure('file:search', error);
    }
  });

  handle('file:createDirectory', async (_event, dirPath: string) => {
    try {
      await runtime.legacy({tool: 'mkdir', path: dirPath});
      return success();
    } catch (error) {
      return failure('file:createDirectory', error);
    }
  });

  handle('file:edit', async (_event, filePath: string, edits: { search: string; replace: string }[]) => {
    try {
      const original = await runtime.legacy({tool: 'read', path: filePath}) as string;
      if (!Array.isArray(edits) || !edits.length || edits.length > 20) throw new Error('Provide between one and twenty targeted edits.');
      const updated = edits.reduce((content, edit) => {
        if (!edit || typeof edit.search !== 'string' || !edit.search || typeof edit.replace !== 'string') throw new Error('Each edit requires a nonempty search and replacement.');
        const index = content.indexOf(edit.search);
        if (index < 0 || content.indexOf(edit.search,index + edit.search.length) >= 0) throw new Error('The targeted search must match exactly once.');
        return content.slice(0,index) + edit.replace + content.slice(index + edit.search.length);
      }, original);
      await runtime.legacy({tool: 'write', path: filePath, content: updated});
      return success(updated);
    } catch (error) {
      return failure('file:edit', error);
    }
  });

  handle('terminal:exec', async (_event, command: string, cwd?: string) => {
    try {
      const result = await runtime.legacy({tool: 'command', command, path: cwd}) as CommandResult;
      if (!result.sessionId) throw new Error('Command finished but its terminal session could not be identified.');
      return success(result.sessionId);
    } catch (error) {
      return failure('terminal:exec', error);
    }
  });

  handle('terminal:kill', async (_event, sessionId: string) => {
    try {
      await terminalService.kill(sessionId);
      return success();
    } catch (error) {
      return failure('terminal:kill', error);
    }
  });

  handle('terminal:sessions', async () => {
    try {
      return success(terminalService.getSessions());
    } catch (error) {
      return failure('terminal:sessions', error);
    }
  });

  handle('ai:chat', async (_event, messages, options) => {
    try {
      return success(await aiService.chat(messages, options));
    } catch (error) {
      return failure('ai:chat', error);
    }
  });

  ipcMain.on('ai:stream:start', async (event, messages, options) => {
    if (event.sender !== mainWindow()?.webContents || event.senderFrame !== mainWindow()?.webContents.mainFrame) return;
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

  ipcMain.on('ai:stream:abort', event => {
    if (event.sender !== mainWindow()?.webContents || event.senderFrame !== mainWindow()?.webContents.mainFrame) return;
    aiService.abortStream();
  });

  handle('ai:abort', async () => {
    aiService.abortStream();
    return success();
  });

  handle('ai:getModels', async () => {
    try {
      return success(await aiService.getModels());
    } catch (error) {
      return failure('ai:getModels', error);
    }
  });

  handle('ai:getHealth', async () => {
    try {
      return success(await aiService.getHealth());
    } catch (error) {
      return failure('ai:getHealth', error);
    }
  });

  handle('ai:testConnection', async () => {
    try { return success(await aiService.testConnection()); }
    catch { return {success: false, error: 'Connection test could not be completed. Try again.'}; }
  });
  handle('ai:findWorkingModel', async () => {
    if (runtime.busy()) return {success:false,error:'Stop the active run before finding a working model.'};
    try { return success(await aiService.findWorkingModel(() => !runtime.busy())); }
    catch { return {success:false,error:'Could not test model compatibility. Check the saved provider settings and try again.'}; }
  });
  handle('ai:getModelVerification', async () => {
    try { return success(aiService.getModelVerification()); }
    catch { return {success:false,error:'Model verification status could not be loaded.'}; }
  });
  handle('ai:startModelVerification', async (_event, retest = false) => {
    if (typeof retest !== 'boolean') return {success:false,error:'Invalid verification request.'};
    if (runtime.busy()) return {success:false,error:'Stop the active run before testing provider models.'};
    try { return success(aiService.startModelVerification(retest)); }
    catch { return {success:false,error:'Model verification could not start. Check the saved provider settings.'}; }
  });
  handle('ai:resumeModelVerification', async () => {
    if (runtime.busy()) return {success:false,error:'Stop the active run before resuming model tests.'};
    try { return success(aiService.resumeModelVerification()); }
    catch { return {success:false,error:'Model verification could not resume.'}; }
  });
  handle('ai:cancelModelVerification', async () => {
    try { return success(aiService.cancelModelVerification()); }
    catch { return {success:false,error:'Model verification could not be canceled.'}; }
  });
  handle('ai:getConnectionTest', async () => {
    try { return success(aiService.getConnectionTest()); }
    catch { return {success: false, error: 'Connection test status could not be loaded.'}; }
  });

  handle('ai:getSettings', async () => {
    try {
      return success(aiService.getPublicSettings());
    } catch (error) {
      return failure('ai:getSettings', error);
    }
  });

  handle('ai:updateSettings', async (_event, partial: Partial<AISettings>) => {
    try {
      if (!partial || typeof partial !== 'object') throw new Error('Invalid model settings.');
      if (runtime.busy()) throw new Error('Stop the active run before changing model settings.');
      const current = aiService.getSettings();
      const sensitive = ['provider', 'apiKey', 'ollamaUrl', 'openaiBaseUrl', 'customEndpoint'] as const;
      if (sensitive.some(key => partial[key] !== undefined && partial[key] !== current[key])) {
        const answer = await dialog.showMessageBox(mainWindow()!, {type: 'warning', message: 'Update model connection settings?', detail: 'Project context and prompts will be sent to the configured provider endpoint. API keys are encrypted using OS credential storage. Verify that you trust this provider.', buttons: ['Cancel', 'Save settings'], defaultId: 0, cancelId: 0});
        if (answer.response !== 1) throw new Error('Model configuration change canceled.');
      }
      if (runtime.busy()) throw new Error('Stop the active run before changing model settings.');
      return success({...aiService.updateSettings(partial), apiKey: ''});
    } catch (error) {
      return failure('ai:updateSettings', error);
    }
  });

  let recentProjectsPending: Promise<string[]> | undefined;
  const recentProjects = (): Promise<string[]> => {
    if (recentProjectsPending) return recentProjectsPending;
    recentProjectsPending = (async () => {
      const saved = store.get('workspace.recentProjects');
      const current = store.get('workspace.currentProject');
      const candidates = Array.isArray(saved) ? saved : typeof current === 'string' ? [current] : [];
      const checked = await Promise.all(candidates.map(async value => {
        try { return await recordedProject(value, candidates); }
        catch { return undefined; }
      }));
      const unique = [...new Set(checked.filter((value): value is string => value !== undefined))];
      if (!Array.isArray(saved) && !Array.isArray(store.get('workspace.recentProjects'))) store.set('workspace.recentProjects', unique);
      return unique;
    })().finally(() => { recentProjectsPending = undefined; });
    return recentProjectsPending;
  };
  const activateProject = (projectPath: string) => {
    if (runtime.busy()) throw new Error('Stop the active run before changing projects.');
    runtime.projectChanged();
    store.set('workspace.currentProject', projectPath);
    const saved = store.get('workspace.recentProjects');
    const previous = Array.isArray(saved) ? saved.filter((value): value is string => typeof value === 'string') : [];
    store.set('workspace.recentProjects', [projectPath, ...previous.filter(value => value !== projectPath)]);
    mainWindow()?.webContents.send('project:opened', projectPath);
    return success(projectPath);
  };

  handle('project:listRecent', async () => success(await recentProjects()));
  handle('project:activate', async (_event, projectPath: string) => {
    if (runtime.busy()) throw new Error('Stop the active run before changing projects.');
    const recorded = await recentProjects();
    const canonical = await recordedProject(projectPath, recorded);
    return activateProject(canonical);
  });

  handle('project:open', async () => {
    try {
      if (runtime.busy()) throw new Error('Stop the active run before changing projects.');
      const result = await dialog.showOpenDialog(mainWindow()!, {
        properties: ['openDirectory'],
        title: 'Open Project',
      });

      if (result.canceled || !result.filePaths[0]) {
        return { success: false, error: 'Canceled' };
      }

      if (runtime.busy()) throw new Error('Stop the active run before changing projects.');
      const projectPath = await projectDirectory(result.filePaths[0]);
      return activateProject(projectPath);
    } catch (error) {
      return failure('project:open', error);
    }
  });

  handle('project:close', async () => {
    if (runtime.busy()) throw new Error('Stop the active run before closing the project.');
    runtime.projectChanged();
    store.delete('workspace.currentProject');
    mainWindow()?.webContents.send('project:closed');
    return success();
  });

  handle('project:getPath', async () => {
    const current = store.get('workspace.currentProject');
    try { return success(await recordedProject(current, await recentProjects())); }
    catch {
      if (typeof current === 'string' && store.get('workspace.currentProject') === current && !runtime.busy()) {
        runtime.projectChanged();
        store.delete('workspace.currentProject');
      }
      return success<string>();
    }
  });

  handle('config:get', async (_event, key: string) => success(store.get(safeStoreKey(key))));
  handle('config:set', async (_event, key: string, value: unknown) => {
    store.set(safeStoreKey(key), value);
    return success();
  });

  handle('window:minimize', async () => {
    mainWindow()?.minimize();
    return success();
  });

  handle('window:maximize', async () => {
    const win = mainWindow();
    if (win?.isMaximized()) {
      win.unmaximize();
    } else {
      win?.maximize();
    }
    return success(win?.isMaximized());
  });

  handle('window:close', async () => {
    mainWindow()?.hide();
    return success();
  });

  handle('window:isMaximized', async () => {
    return success(mainWindow()?.isMaximized());
  });

  handle('dialog:openFile', async (_event, options?: { filters?: { name: string; extensions: string[] }[]; multiple?: boolean }) => {
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

  handle('dialog:openDirectory', async () => {
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

  handle('dialog:saveFile', async (_event, options?: { defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) => {
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

  handle('shell:openExternal', async (_event, url: string) => {
    try {
      const parsed = new URL(url);
      if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Only HTTP(S) links are supported.');
      const confirmation = await dialog.showMessageBox(mainWindow()!, {type: 'question', buttons: ['Cancel', 'Open link'], defaultId: 0, cancelId: 0, message: 'Open an external browser?', detail: parsed.href});
      if (confirmation.response !== 1) throw new Error('External navigation canceled.');
      await shell.openExternal(url);
      return success();
    } catch (error) {
      return failure('shell:openExternal', error);
    }
  });

  handle('store:get', async (_event, key: string) => success(store.get(safeStoreKey(key))));
  handle('store:set', async (_event, key: string, value: unknown) => {
    store.set(safeStoreKey(key), value);
    return success();
  });

  handle('app:getVersion', async () => success(app.getVersion()));
  handle('app:getPlatform', async () => success(process.platform));

  handle('security:getApprovals', async () => ({success: false, error: 'Use the session-scoped approval panel.'}));
  handle('security:approve', async () => ({success: false, error: 'Approvals require a session and exact request ID.'}));
  handle('tool:execute', async () => ({
    success: false,
    error: 'Use session-scoped agent tools. Unscoped execution is disabled.',
  }));

  runtime.setProgressSink(progress => mainWindow()?.webContents.send('agent:progress',progress));
  runtime.setImportConfirmation(async detail => {
    const win=mainWindow(); if(!win || win.isDestroyed()) return false;
    const answer=await dialog.showMessageBox(win,{type:'warning',title:'Install skill',message:'Install this skill into Crux AI?',detail,buttons:['Cancel','Install'],defaultId:0,cancelId:0,noLink:true});
    return answer.response === 1 && mainWindow() === win && !win.isDestroyed();
  });
  handle('agent:routingOptions',async () => success(runtime.routingOptions()));
  handle('agent:setSemanticRouting',async (_event,enabled:boolean) => success(runtime.setSemanticRouting(enabled)));
  handle('agent:catalog',async () => success(await runtime.catalog()));
  handle('agent:saveDefinition',async (_event,kind:DefinitionKind,draft:DefinitionDraft,id?:string,revision?:number) => success(await runtime.saveDefinition(kind,draft,id,revision)));
  handle('agent:removeDefinition',async (_event,kind:DefinitionKind,id:string,revision:number) => success(await runtime.removeDefinition(kind,id,revision)));
  handle('agent:importGithub',async (_event,url:string) => success(await runtime.importGithub(url)));
  handle('agent:previewRoute',async (_event,text:string,selection?:RouteSelection) => success(await runtime.previewRoute(text,selection)));
  handle('agent:resetRoute',async (_event,id:string) => success(await runtime.resetRoute(id)));
  handle('agent:open' , async (_event, id: string) => success(await runtime.open(id)));
  handle('agent:snapshot', async (_event, id: string) => success(await runtime.snapshot(id)));
  handle('agent:setMode', async (_event, id: string, mode: AgentMode) => success(await runtime.mode(id, mode)));
  handle('agent:setAccess', async (_event, id: string, level: AccessLevel) => {
    if (!['full', 'medium', 'restricted'].includes(level)) throw new Error('Invalid access level.');
    if (level === 'full') {
      const answer = await dialog.showMessageBox(mainWindow()!, {type: 'warning', title: 'Enable Full Access', message: 'Allow Crux AI to access your computer?',
        detail: 'Full Access can read, create, edit and delete files outside your project, run host commands, and change configuration within your OS permissions. Destructive actions still require approval. OS security and authentication remain in force. Access resets to Medium when the application restarts.',
        buttons: ['Cancel', 'Enable Full Access'], defaultId: 0, cancelId: 0, noLink: true});
      if (answer.response !== 1) throw new Error('Full Access was not enabled.');
    }
    return success(await runtime.access(id, level));
  });
  handle('agent:configure', async (_event, id: string, capabilities: Partial<Record<Capability, boolean>>, folders: string[]) => {
    if (!Array.isArray(folders) || folders.some(item => typeof item !== 'string')) throw new Error('Invalid folder grants.');
    const answer = await dialog.showMessageBox(mainWindow()!, {type: 'warning', message: 'Apply these permission settings?', detail: `Capabilities: ${JSON.stringify(capabilities)}\nAdditional folder grants: ${folders.join('\n') || 'None'}\nFolder grants apply to read, write and delete operations allowed by the selected mode.`, buttons: ['Cancel', 'Apply'], defaultId: 0, cancelId: 0});
    if (answer.response !== 1) throw new Error('Permission changes canceled.');
    return success(await runtime.configure(id, capabilities, folders));
  });
  handle('agent:setExecutionOptions', async (_event,id:string,options:{autoFix?:boolean;iterationLimit?:number}) => success(await runtime.setExecutionOptions(id,options)));
  handle('agent:run', async (_event, id: string, objective: string, attachments: string[], selection?:RouteSelection, runId?:string) => success(await runtime.run(id, objective, attachments, selection, runId)));
  handle('agent:stop', async (_event, id: string) => {await runtime.stop(id); return success();});
  handle('agent:approve', async (_event, id: string, requestId: string, decision: 'once' | 'session' | 'deny') => {runtime.approve(id, requestId, decision); return success();});
  handle('agent:execute', async (_event, id: string, request: ToolRequest) => success(await runtime.execute(id, request)));
  handle('agent:installSkill', async (_event, id: string) => {
    const selected = await dialog.showOpenDialog(mainWindow()!, {title: 'Install a declarative SKILL.md', properties: ['openFile'], filters: [{name: 'Markdown skills', extensions: ['md']}]});
    if (selected.canceled || !selected.filePaths[0]) throw new Error('Skill installation canceled.');
    return success(await runtime.install(id, selected.filePaths[0]));
  });
  handle('agent:buildSkill', async (_event, id: string, name: string, description: string, instructions: string) => success(await runtime.build(id, name, description, instructions)));
  handle('agent:removeSkill', async (_event, id: string, skillId: string) => success(await runtime.remove(id, skillId)));

  log.info('CruX IPC handlers registered');
}
