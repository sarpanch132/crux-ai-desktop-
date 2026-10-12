import type { AgentSnapshot, AgentMode, AccessLevel, CatalogSnapshot, DefinitionDraft, DefinitionKind, ResolvedRoute, RouteSelection } from '../../../electron/services/agent/contracts';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export type ThemeMode = 'dark' | 'light' | 'system';
export type MainView = 'chat' | 'settings';
export type RightPanelTab = 'files' | 'search' | 'changes' | 'problems' | 'tests' | 'activity';

export interface AttachmentItem {
  id: string;
  name: string;
  path: string;
}

export interface ToolLog {
  id: string;
  label: string;
  status: 'running' | 'completed' | 'error';
  detail: string;
  startedAt: number;
  endedAt?: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: number;
  status: 'done' | 'streaming' | 'error';
  error?: string;
  attachments?: AttachmentItem[];
  tools?: ToolLog[];
  model?: string;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  projectPath?: string;
}

export interface FileTreeNode {
  id: string;
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: number;
  children?: FileTreeNode[];
}

export interface TerminalSessionState {
  id: string;
  command: string;
  cwd: string;
  status: TerminalSessionInfo['status'];
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  outputs: TerminalOutput[];
}

export interface DefinitionEditorDraft { kind: DefinitionKind; id?: string; revision?: number; values: DefinitionDraft; dirty: boolean; }

interface AppState {
  catalog: CatalogSnapshot;
  catalogLoading: boolean;
  catalogError: string | null;
  routingSemantic: boolean;
  setRoutingSemantic: (enabled: boolean) => Promise<void>;
  hubOpen: boolean;
  hubTab: DefinitionKind;
  definitionDraft: DefinitionEditorDraft | null;
  routePreview: ResolvedRoute | null;
  routeLoading: boolean;
  routeError: string | null;
  routeSelection: RouteSelection | undefined;
  setHubOpen: (open: boolean) => void;
  setHubTab: (tab: DefinitionKind) => void;
  setDefinitionDraft: (draft: DefinitionEditorDraft | null) => void;
  refreshCatalog: () => Promise<void>;
  saveDefinition: (kind: DefinitionKind, draft: DefinitionDraft, id?: string, revision?: number) => Promise<boolean>;
  removeDefinition: (kind: DefinitionKind, id: string, revision: number) => Promise<boolean>;
  importGithubSkill: (url: string) => Promise<boolean>;
  previewRoute: () => Promise<void>;
  selectRoute: (agentId: string | null | undefined) => void;
  agentSnapshots: Record<string, AgentSnapshot>;
  agentError: string | null;
  syncAgent: (snapshot: AgentSnapshot) => void;
  openAgent: () => Promise<void>;
  setAgentMode: (mode: AgentMode) => Promise<void>;
  setAgentAccess: (access: AccessLevel) => Promise<void>;
  initialized: boolean;
  appVersion: string;
  theme: ThemeMode;
  currentView: MainView;
  rightPanelTab: RightPanelTab;
  sidebarOpen: boolean;
  rightPanelOpen: boolean;
  terminalOpen: boolean;
  projectPath: string | null;
  recentProjects: string[];
  isProjectSwitching: boolean;
  layoutVersion: number;
  fileTree: FileTreeNode[];
  conversations: Conversation[];
  activeConversationId: string | null;
  models: ModelInfo[];
  modelsLoading: boolean;
  modelVerification: ModelVerificationStatus | null;
  verificationActionPending: boolean;
  verifyModels: (resume?:boolean) => Promise<void>;
  cancelModelVerification: () => Promise<void>;
  pollModelVerification: (epoch?:number) => Promise<void>;
  autoModelLoading: boolean;
  autoModelResult: AutoModelResult | null;
  autoModelTestedAt: number | null;
  autoModelError: string | null;
  connectionTesting: boolean;
  setConnectionTesting: (testing:boolean) => void;
  findWorkingModel: () => Promise<void>;
  modelsError: string | null;
  providerHealth: ProviderHealth[];
  settings: AISettings | null;
  settingsSaving: boolean;
  isGenerating: boolean;
  activeStreamMessageId: string | null;
  activeTerminalSessionId: string | null;
  terminalSessions: Record<string, TerminalSessionState>;
  activity: ToolLog[];
  terminalInput: string;
  composerValue: string;
  activeStreamAbort: (() => void) | null;
  initialize: () => Promise<void>;
  setTheme: (theme: ThemeMode) => void;
  setCurrentView: (view: MainView) => void;
  setRightPanelTab: (tab: RightPanelTab) => void;
  setSidebarOpen: (open: boolean) => void;
  setRightPanelOpen: (open: boolean) => void;
  setTerminalOpen: (open: boolean) => void;
  setTerminalInput: (value: string) => void;
  setComposerValue: (value: string) => void;
  createConversation: () => string;
  selectConversation: (id: string) => Promise<void>;
  refreshModels: () => Promise<void>;
  updateSettings: (settings: Partial<AISettings>) => Promise<void>;
  openProject: () => Promise<void>;
  activateProject: (projectPath: string) => Promise<void>;
  closeProject: () => Promise<void>;
  loadProjectFiles: (projectPath?: string | null) => Promise<void>;
  sendMessage: (content?: string, attachments?: AttachmentItem[]) => Promise<void>;
  stopGeneration: () => void;
  retryLastAssistantMessage: () => Promise<void>;
  appendTerminalOutput: (output: TerminalOutput) => void;
  loadTerminalSessions: () => Promise<void>;
  runTerminalCommand: (command?: string) => Promise<void>;
  setActiveTerminalSession: (id: string | null) => void;
  addActivity: (log: ToolLog) => void;
  finishActivity: (id: string, status: ToolLog['status'], detail: string) => void;
  bindRuntimeEvents: () => () => void;
}

let modelRequest = 0;
let routeRequest = 0;
let verificationEpoch = 0;
let verificationPollRequest = 0;
let modelExpiryTimer: number | undefined;
let verificationTimer: number | undefined;
const scanActive = (status:ModelVerificationStatus|null) => status?.state === 'discovering' || status?.state === 'testing';
function stopVerificationPolling() {if(verificationTimer !== undefined) window.clearTimeout(verificationTimer);verificationTimer=undefined;}
function verifiedModels(models:ModelInfo[],provider?:AIProvider) {return models.filter(model=>model.provider===provider&&model.status==='ready'&&model.healthy&&Number.isFinite(model.verificationExpiresAt)&&(model.verificationExpiresAt??0)>Date.now()&&!!model.lastVerifiedAt&&Number.isFinite(Date.parse(model.lastVerifiedAt)));}
function watchModelExpiry(models:ModelInfo[],refresh:()=>Promise<void>) {
  if(modelExpiryTimer!==undefined)window.clearTimeout(modelExpiryTimer);modelExpiryTimer=undefined;
  const deadlines=models.flatMap(model=>model.verificationExpiresAt===undefined?[]:[model.verificationExpiresAt]);
  if(deadlines.length)modelExpiryTimer=window.setTimeout(()=>{modelExpiryTimer=undefined;void refresh();},Math.max(20,Math.min(...deadlines)-Date.now()+1));
}



const DEFAULT_SETTINGS: AISettings = {
  provider: '',
  model: '',
  temperature: 0.2,
  maxTokens: 4096,
  ollamaUrl: 'http://127.0.0.1:11434',
  openaiBaseUrl: 'https://api.openai.com/v1',
  customEndpoint: 'http://127.0.0.1:11434/v1',
  apiKey: '',
  autonomyLevel: 'guarded',
  toolPermissions: 'safe-only',
  performanceMode: 'balanced',
};

function applyTheme(theme: ThemeMode) {
  const root = document.documentElement;
  if (theme === 'dark') {
    root.classList.add('dark');
    root.dataset.theme = 'dark';
    return;
  }

  if (theme === 'light') {
    root.classList.remove('dark');
    root.dataset.theme = 'light';
    return;
  }

  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  root.classList.toggle('dark', prefersDark);
  root.dataset.theme = prefersDark ? 'dark' : 'light';
}

function createEmptyConversation(projectPath?: string | null): Conversation {
  const now = Date.now();
  return { id: crypto.randomUUID(), title: 'New Chat', createdAt: now, updatedAt: now,
    messages: [], ...(projectPath ? { projectPath } : {}) };
}

function projectConversation(state: AppState, projectPath: string | null) {
  const existing = state.conversations.find(entry => (entry.projectPath ?? null) === projectPath);
  const conversation = existing ?? createEmptyConversation(projectPath);
  return { projectPath, fileTree: [], activeConversationId: conversation.id,
    conversations: existing ? state.conversations : [conversation, ...state.conversations],
    currentView: 'chat' as const, composerValue: '', agentError: null, activity: [], routeSelection: undefined, routePreview: null, routeError: null, routeLoading: false };
}

function buildFileTree(files: FileInfo[], rootPath: string): FileTreeNode[] {
  const rootMap = new Map<string, FileTreeNode>();

  const ensureNode = (parts: string[], file: FileInfo, fullPath: string): FileTreeNode => {
    let currentMap = rootMap;
    let currentPath = '';
    let currentNode: FileTreeNode | undefined;

    parts.forEach((part, index) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const pathKey = `${rootPath}/${currentPath}`.replace(/\\/g, '/');
      const isLeaf = index === parts.length - 1;

      if (!currentMap.has(pathKey)) {
        const node: FileTreeNode = {
          id: pathKey,
          name: part,
          path: fullPath,
          type: isLeaf ? file.type : 'directory',
          size: isLeaf ? file.size : undefined,
          modified: isLeaf ? file.modified : undefined,
          children: isLeaf && file.type === 'file' ? undefined : [],
        };
        currentMap.set(pathKey, node);
      }

      currentNode = currentMap.get(pathKey);
      if (currentNode?.children) {
        currentMap = new Map(
          currentNode.children.map((child) => [child.id, child]),
        );
        currentNode.children = [...currentMap.values()];
      }
    });

    return currentNode!;
  };

  files.forEach((file) => {
    const relativePath = file.path
      .replace(rootPath, '')
      .replace(/^[\\/]+/, '')
      .replace(/\\/g, '/');

    if (!relativePath) {
      return;
    }

    const parts = relativePath.split('/').filter(Boolean);
    ensureNode(parts, file, file.path);
  });

  const sortNodes = (nodes: FileTreeNode[]): FileTreeNode[] =>
    nodes
      .map((node) => ({
        ...node,
        children: node.children ? sortNodes(node.children) : undefined,
      }))
      .sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === 'directory' ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

  return sortNodes([...rootMap.values()].filter((node) => !node.path.includes(`${rootPath}\\`) || node.path === node.id));
}

function summarizeConversationTitle(content: string): string {
  const trimmed = content.trim().replace(/\s+/g, ' ');
  return trimmed.length > 40 ? `${trimmed.slice(0, 40)}...` : trimmed || 'New Chat';
}

function getCurrentConversation(state: AppState): Conversation {
  const existing = state.conversations.find((conversation) => conversation.id === state.activeConversationId);
  if (existing) {
    return existing;
  }

  return state.conversations[0] ?? createEmptyConversation();
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      catalog: {revision: 0, agents: [], skills: []}, catalogLoading: false, catalogError: null,
      routingSemantic: false,
      setRoutingSemantic: async (enabled) => {
        try {const result=await window.electron.agent.setSemanticRouting(enabled);if(!result.success || !result.data) throw new Error(result.error ?? 'Unable to update intent matching.');set({routingSemantic:result.data.semantic});await get().previewRoute();}
        catch(error) {set({catalogError:error instanceof Error ? error.message : String(error)});}
      },
      hubOpen: false, hubTab: 'agent', definitionDraft: null,
      routePreview: null, routeLoading: false, routeError: null, routeSelection: undefined,
      setHubOpen: (hubOpen) => {set({hubOpen, ...(hubOpen ? {rightPanelOpen: false} : {})}); if (hubOpen) void get().refreshCatalog();},
      setHubTab: (hubTab) => set({hubTab}),
      setDefinitionDraft: (definitionDraft) => set({definitionDraft}),
      refreshCatalog: async () => {
        set({catalogLoading: true, catalogError: null});
        try {
          const [result,options] = await Promise.all([window.electron.agent.catalog(),window.electron.agent.routingOptions()]);
          if (!result.success || !result.data) throw new Error(result.error ?? 'Unable to load agents and skills.');
          set({catalog: result.data});
          if(options.success && options.data) set({routingSemantic:options.data.semantic});
          await get().previewRoute();
        } catch(error) {set({catalogError: error instanceof Error ? error.message : String(error)});}
        finally {set({catalogLoading: false});}
      },
      saveDefinition: async (kind, draft, id, revision) => {
        set({catalogError: null});
        try {
          const result = await window.electron.agent.saveDefinition(kind, draft, id, revision);
          if (!result.success || !result.data) throw new Error(result.error ?? 'Unable to save definition.');
          set({catalog: result.data, definitionDraft: null}); await get().previewRoute(); return true;
        } catch(error) {set({catalogError: error instanceof Error ? error.message : String(error)}); return false;}
      },
      removeDefinition: async (kind, id, revision) => {
        set({catalogError: null});
        try {
          const result = await window.electron.agent.removeDefinition(kind, id, revision);
          if (!result.success || !result.data) throw new Error(result.error ?? 'Unable to delete definition.');
          set({catalog: result.data, definitionDraft: null}); await get().previewRoute(); return true;
        } catch(error) {set({catalogError: error instanceof Error ? error.message : String(error)}); return false;}
      },
      importGithubSkill: async (url) => {
        set({catalogError: null});
        try {
          const result = await window.electron.agent.importGithub(url);
          if (!result.success || !result.data) throw new Error(result.error ?? 'Unable to import skill.');
          set({catalog: result.data}); await get().previewRoute(); return true;
        } catch(error) {set({catalogError: error instanceof Error ? error.message : String(error)}); return false;}
      },
      previewRoute: async () => {
        const request = ++routeRequest;
        const text = get().composerValue.trim();
        if (!text) {set({routePreview: null, routeLoading: false, routeError: null}); return;}
        set({routeLoading: true, routeError: null});
        try {
          const result = await window.electron.agent.previewRoute(text, get().routeSelection);
          if (request !== routeRequest) return;
          if (!result.success || !result.data) throw new Error(result.error ?? 'Unable to resolve this request.');
          set({routePreview: result.data, routeError: null});
        } catch(error) {if (request === routeRequest) set({routePreview: null, routeError: error instanceof Error ? error.message : String(error)});}
        finally {if (request === routeRequest) set({routeLoading: false});}
      },
      selectRoute: (agentId) => {
        set({routeSelection: agentId === undefined ? undefined : {catalogRevision: get().catalog.revision, agentId}, routePreview: null});
        const id = get().activeConversationId;
        if(agentId === null && id && !get().isGenerating) {
          void window.electron.agent.resetRoute(id).then(result => {if(result.success && result.data) get().syncAgent(result.data);else set({agentError:result.error ?? 'Unable to reset the route.'});});
        }
        void get().previewRoute();
      },
      agentSnapshots: {},
      agentError: null,
      syncAgent: (snapshot) => {
        if (snapshot.state.repoContext.projectPath !== get().projectPath) return;
        set((state) => ({ agentSnapshots: { ...state.agentSnapshots, [snapshot.state.id]: snapshot }, ...(snapshot.approvals.length && snapshot.state.id === state.activeConversationId ? {rightPanelOpen: true, currentView:'chat' as const} : {}) }));
      },
      openAgent: async () => {
        const id = get().activeConversationId;
        if (!id) return;
        const result = await window.electron.agent.open(id);
        if (result.success && result.data) { get().syncAgent(result.data); set({agentError: null}); }
        else set({agentError: result.error ?? 'Unable to open agent session.'});
      },
      setAgentMode: async (mode) => {
        const id = get().activeConversationId;
        if (!id) return;
        const result = await window.electron.agent.setMode(id, mode);
        if (result.success && result.data) { get().syncAgent(result.data); set({agentError: null}); }
        else set({agentError: result.error ?? 'Mode change failed.'});
      },
      setAgentAccess: async (access) => {
        const id = get().activeConversationId;
        if (!id) return;
        const result = await window.electron.agent.setAccess(id, access);
        if (result.success && result.data) { get().syncAgent(result.data); set({agentError: null}); }
        else set({agentError: result.error ?? 'Access change failed.'});
      },
      initialized: false,
      appVersion: '0.0.0',
      theme: 'dark',
      currentView: 'chat',
      rightPanelTab: 'files',
      sidebarOpen: true,
      rightPanelOpen: false,
      terminalOpen: false,
      layoutVersion: 1,
      projectPath: null,
      recentProjects: [],
      isProjectSwitching: false,
      fileTree: [],
      conversations: [createEmptyConversation()],
      activeConversationId: null,
      models: [],
      modelsLoading: false,
      modelVerification: null,
      verificationActionPending: false,
      autoModelLoading: false,
      autoModelResult: null,
      autoModelTestedAt: null,
      autoModelError: null,
      connectionTesting: false,
      setConnectionTesting: (connectionTesting) => set({connectionTesting}),
      modelsError: null,
      providerHealth: [],
      settings: null,
      settingsSaving: false,
      isGenerating: false,
      activeStreamMessageId: null,
      activeTerminalSessionId: null,
      terminalSessions: {},
      activity: [],
      terminalInput: '',
      composerValue: '',
      activeStreamAbort: null,
      initialize: async () => {
        const [settingsResult, projectResult, versionResult, recentResult] = await Promise.all([
          window.electron.ai.getSettings(),
          window.electron.project.getPath(),
          window.electron.app.getVersion(),
          window.electron.project.listRecent(),
        ]);

        // Legacy UI chats had no folder field. Recover only a backend session whose
        // real project and user history agree; a newly created empty snapshot is not evidence.
        const legacy = get().conversations.find(entry => entry.id === get().activeConversationId && !entry.projectPath);
        if (legacy && projectResult.data && recentResult.data?.includes(projectResult.data)) {
          try {
            const result = await window.electron.agent.snapshot(legacy.id);
            const users = legacy.messages.filter(message => message.role === 'user').map(message => message.content);
            const recorded = result.data?.state.history.filter(message => message.role === 'user').map(message => message.content) ?? [];
            if (result.success && result.data?.state.repoContext.projectPath === projectResult.data && users.length &&
                users.length === recorded.length && users.every((content, index) => content === recorded[index])) {
              set(state => ({conversations: state.conversations.map(entry => entry.id === legacy.id ? {...entry, projectPath: projectResult.data} : entry)}));
            }
          } catch { /* Preserve unassigned legacy history if its backend session cannot be verified. */ }
        }

        const theme = get().theme;
        applyTheme(theme);

        const resolvedSettings = settingsResult.success && settingsResult.data
          ? settingsResult.data
          : DEFAULT_SETTINGS;

        set((state) => ({
          initialized: true,
          appVersion: versionResult.data ?? state.appVersion,
          activeConversationId: state.activeConversationId ?? state.conversations[0]?.id ?? null,
          settings: resolvedSettings,
          models: [],
          modelsError: null,
          providerHealth: [],
          projectPath: projectResult.success && projectResult.data ? projectResult.data : null,
          recentProjects: recentResult.success && recentResult.data ? recentResult.data : [],
        }));

        if (projectResult.success && projectResult.data) {
          if (get().recentProjects.includes(projectResult.data)) {
            const active = get().conversations.find(entry => entry.id === get().activeConversationId);
            if (active?.projectPath !== projectResult.data) set(projectConversation(get(), projectResult.data));
            await get().loadProjectFiles(projectResult.data);
          }
        } else if (get().conversations.find(entry => entry.id === get().activeConversationId)?.projectPath) {
          set(projectConversation(get(), null));
        }

        await get().refreshModels();
        await get().loadTerminalSessions();
        await get().openAgent();
        await get().refreshCatalog();
      },
      setTheme: (theme) => {
        applyTheme(theme);
        set({ theme });
      },
      setCurrentView: (currentView) => set({ currentView }),
      setRightPanelTab: (rightPanelTab) => set({ rightPanelTab }),
      setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
      setRightPanelOpen: (rightPanelOpen) => set({ rightPanelOpen }),
      setTerminalOpen: (terminalOpen) => set({ terminalOpen }),
      setTerminalInput: (terminalInput) => set({ terminalInput }),
      setComposerValue: (composerValue) => {++routeRequest; set({ composerValue, routePreview: null, routeError: null, routeLoading: !!composerValue.trim() });},
      createConversation: () => {
        if (get().isGenerating || get().isProjectSwitching) return get().activeConversationId ?? '';
        const conversation = createEmptyConversation(get().projectPath);
        set((state) => ({
          conversations: [conversation, ...state.conversations],
          activeConversationId: conversation.id,
          currentView: 'chat',
          composerValue: '',
          routeSelection: undefined, routePreview: null, routeError: null, routeLoading: false,
        }));
        void get().openAgent();
        return conversation.id;
      },
      selectConversation: async (id) => {
        if (get().isGenerating || get().isProjectSwitching) return;
        const conversation = get().conversations.find(entry => entry.id === id);
        if (!conversation) return;
        if ((conversation.projectPath ?? null) !== get().projectPath) {
          if (conversation.projectPath) {
            await get().activateProject(conversation.projectPath);
            if (get().projectPath !== conversation.projectPath) return;
          } else {
            await get().closeProject();
            if (get().projectPath) return;
          }
        }
        ++routeRequest;
        set({ activeConversationId: id, currentView: 'chat', composerValue: '', agentError: null, routeSelection: undefined, routePreview: null, routeError: null, routeLoading: false });
        await get().openAgent();
      },
      findWorkingModel: async () => {
        if (get().autoModelLoading || get().connectionTesting || get().settingsSaving || get().isGenerating || !get().settings?.provider) return;
        set({autoModelLoading: true, autoModelError: null, autoModelResult: null});
        try {
          const response = await window.electron.ai.findWorkingModel();
          if (!response.success || !response.data) throw new Error(response.error ?? 'Could not test available models. Try again.');
          const settings = await window.electron.ai.getSettings();
          if (!settings.success || !settings.data) throw new Error('The test finished, but settings could not be refreshed. Reopen Settings.');
          set({settings: settings.data, autoModelResult: response.data, autoModelTestedAt:response.data.attempts>0&&!response.data.cached?Date.now():null, autoModelError: response.data.success ? null : response.data.message});
          await get().refreshModels();
        } catch (reason) {set({autoModelError: reason instanceof Error ? reason.message : 'Could not find a working model. Try again.'});}
        finally {set({autoModelLoading: false});}
      },
      pollModelVerification: async (epoch=verificationEpoch) => {
        const request=++verificationPollRequest;
        stopVerificationPolling();
        try {
          const [statusResult, modelsResult] = await Promise.all([window.electron.ai.getModelVerification(), window.electron.ai.getModels()]);
          if(epoch !== verificationEpoch || request!==verificationPollRequest)return;
          if(!statusResult.success || !statusResult.data)throw new Error(statusResult.error??'Could not read model verification progress.');
          const provider=get().settings?.provider;
          if(statusResult.data.provider !== provider)return;
          set({modelVerification:statusResult.data,models:modelsResult.success&&modelsResult.data?verifiedModels(modelsResult.data,provider):verifiedModels(get().models,provider)});
          watchModelExpiry(get().models,()=>get().refreshModels());
          if(scanActive(statusResult.data))verificationTimer=window.setTimeout(()=>void get().pollModelVerification(epoch),1000);
        } catch(reason) {
          if(epoch===verificationEpoch&&request===verificationPollRequest)set({modelsError:reason instanceof Error?reason.message:'Could not read verification progress. Retry the scan.'});
        }
      },
      verifyModels: async (resume=false) => {
        if(get().verificationActionPending||get().isGenerating||get().settingsSaving||get().connectionTesting||get().autoModelLoading)return;
        set({verificationActionPending:true,modelsError:null});
        const epoch=verificationEpoch;
        try {
          const result=await (resume?window.electron.ai.resumeModelVerification():window.electron.ai.startModelVerification(get().modelVerification?.state !== 'idle'));
          if(epoch!==verificationEpoch)return;
          if(!result.success||!result.data)throw new Error(result.error??'Could not start model verification.');
          set({modelVerification:result.data});
          await get().pollModelVerification(epoch);
        }catch(reason){if(epoch===verificationEpoch)set({modelsError:reason instanceof Error?reason.message:'Could not start model verification.'});}
        finally{if(epoch===verificationEpoch)set({verificationActionPending:false});}
      },
      cancelModelVerification: async () => {
        if(get().verificationActionPending)return;
        ++verificationPollRequest;stopVerificationPolling();
        set({verificationActionPending:true});
        const epoch=verificationEpoch;
        try {
          const result=await window.electron.ai.cancelModelVerification();
          if(epoch!==verificationEpoch)return;
          if(!result.success||!result.data)throw new Error(result.error??'Could not cancel verification.');
          stopVerificationPolling();set({modelVerification:result.data});
          await get().pollModelVerification(epoch);
        }catch(reason){if(epoch===verificationEpoch)set({modelsError:reason instanceof Error?reason.message:'Could not cancel verification.'});}
        finally{if(epoch===verificationEpoch)set({verificationActionPending:false});}
      },
      refreshModels: async () => {
        const request = ++modelRequest;
        const epoch=verificationEpoch;
        set({modelsLoading: true, modelsError: null});
        try {
          const [modelsResult, healthResult] = await Promise.all([window.electron.ai.getModels(), window.electron.ai.getHealth()]);
          if (request !== modelRequest || epoch !== verificationEpoch) return;
          const provider=get().settings?.provider;
          set({models: modelsResult.success && modelsResult.data ? verifiedModels(modelsResult.data,provider) : [],
            modelsError: modelsResult.success ? null : modelsResult.error ?? 'Unable to fetch verified models.',
            providerHealth: healthResult.success && healthResult.data ? healthResult.data : []});
          await get().pollModelVerification(epoch);
        } catch (reason) {
          if (request === modelRequest && epoch===verificationEpoch) set({models: [], modelsError: reason instanceof Error ? reason.message : 'Unable to fetch verified models.'});
        } finally {if (request === modelRequest) set({modelsLoading: false});}
      },
      updateSettings: async (settings) => {
        if (get().settingsSaving || get().autoModelLoading || get().connectionTesting) throw new Error('Wait for the current connection check or settings save.');
        set({settingsSaving: true});
        try {
          const result = await window.electron.ai.updateSettings(settings);
          if (!result.success || !result.data) throw new Error(result.error || 'Unable to update settings.');
          const connectionChanged = ['provider', 'ollamaUrl', 'openaiBaseUrl', 'customEndpoint', 'apiKey'].some((field) => field in settings);
          if (connectionChanged) {++modelRequest;++verificationEpoch;++verificationPollRequest;stopVerificationPolling();if(modelExpiryTimer!==undefined)window.clearTimeout(modelExpiryTimer);modelExpiryTimer=undefined;}
          set({settings: result.data, ...(connectionChanged ? {models: [], modelsError: null, modelVerification:null, verificationActionPending:false, autoModelResult: null, autoModelTestedAt:null, autoModelError: null} : {})});
          if (connectionChanged) await get().refreshModels();
        } finally {set({settingsSaving: false});}
      },
      openProject: async () => {
        if (get().isGenerating || get().isProjectSwitching) {set({agentError: 'Stop the active run before switching projects.'}); return;}
        set({isProjectSwitching: true});
        try {
          const result = await window.electron.project.open();
          if (!result.success || !result.data) { if (result.error !== 'Canceled') set({agentError: result.error ?? 'Unable to open project.'}); return; }
          set(projectConversation(get(), result.data));
          const recent = await window.electron.project.listRecent();
          if (recent.success && recent.data) set({recentProjects: recent.data});
          await get().loadProjectFiles(result.data);
          await get().openAgent();
        } catch (error) {set({agentError: error instanceof Error ? error.message : String(error)});}
        finally {set({isProjectSwitching: false});}
      },
      activateProject: async (projectPath) => {
        if (get().isGenerating || get().isProjectSwitching) {set({agentError: 'Stop the active run before switching projects.'}); return;}
        if (projectPath === get().projectPath) return;
        set({isProjectSwitching: true});
        try {
          const result = await window.electron.project.activate(projectPath);
          if (!result.success || !result.data) {set({agentError: result.error ?? 'Unable to activate project.'}); return;}
          set(projectConversation(get(), result.data));
          const recent = await window.electron.project.listRecent();
          if (recent.success && recent.data) set({recentProjects: recent.data});
          await get().loadProjectFiles(result.data);
          await get().openAgent();
        } catch (error) {set({agentError: error instanceof Error ? error.message : String(error)});}
        finally {set({isProjectSwitching: false});}
      },
      closeProject: async () => {
        if (get().isGenerating || get().isProjectSwitching) {set({agentError: 'Stop the active run before closing the project.'}); return;}
        set({isProjectSwitching: true});
        try {
          const result = await window.electron.project.close();
          if (!result.success) {set({agentError: result.error ?? 'Unable to close project.'}); return;}
          set(projectConversation(get(), null));
          await get().openAgent();
        } catch (error) {set({agentError: error instanceof Error ? error.message : String(error)});}
        finally {set({isProjectSwitching: false});}
      },
      loadProjectFiles: async (projectPathOverride) => {
        const rootPath = projectPathOverride ?? get().projectPath;
        if (!rootPath) {
          set({ fileTree: [] });
          return;
        }

        const result = await window.electron.file.list(rootPath, {
          recursive: false,
          filter: ['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.turbo', '.cache'],
        });

        if (get().projectPath !== rootPath) return;
        if (!result.success || !result.data) {
          set({ fileTree: [] });
          return;
        }

        set({ fileTree: buildFileTree(result.data.slice(0, 1200), rootPath) });
      },
      sendMessage: async (content, attachments = []) => {
        if (get().isGenerating || get().settingsSaving || get().autoModelLoading || get().connectionTesting || get().isProjectSwitching) return;
        const body = (content ?? get().composerValue).trim();
        if (!body) return;
        const skillInstall = /^(?:(?:please|can you|could you|will you)\s+)?(?:install|import|add)\b/i.test(body) && /\bskill\b/i.test(body) && /https:\/\/(?:github\.com|raw\.githubusercontent\.com)\//i.test(body);
        if (!skillInstall && (!get().settings?.provider || !get().settings?.model)) {set({agentError: 'Choose a provider and model in Settings before sending.'}); return;}
        const selection = get().routeSelection;
        const routing = await window.electron.agent.previewRoute(body, selection);
        if (!routing.success || !routing.data) {set({routeError: routing.error ?? 'Choose a route before sending.', routeLoading: false}); return;}
        if (get().isGenerating || get().isProjectSwitching || (!content && get().composerValue.trim() !== body)) return;
        if (!get().activeConversationId) get().createConversation();
        const conversation = getCurrentConversation(get());
        const assistantId = crypto.randomUUID();
        set((state) => ({composerValue: '', isGenerating: true, agentError: null,
          conversations: state.conversations.map((entry) => entry.id === conversation.id ? {...entry,
            title: !entry.messages.some(message => message.role === 'user') ? summarizeConversationTitle(body) : entry.title,
            updatedAt: Date.now(), messages: [...entry.messages,
              {id: crypto.randomUUID(), role: 'user', content: body, createdAt: Date.now(), status: 'done', attachments},
              {id: assistantId, role: 'assistant', content: '', createdAt: Date.now(), status: 'streaming'}]} : entry)}));
        const requestRunId = crypto.randomUUID();
        let progressSequence = -1;
        const progressProject = get().projectPath;
        const offProgress = window.electron.agent.onProgress?.(event => {
          if(!get().isGenerating || get().activeConversationId !== conversation.id || get().projectPath !== progressProject || event.sessionId !== conversation.id || event.projectPath !== progressProject) return;
          if(event.runId !== requestRunId) return;
          if(event.sequence <= progressSequence) return;
          progressSequence = event.sequence;
          set(state => ({conversations:state.conversations.map(entry=>entry.id===conversation.id?{...entry,messages:entry.messages.map(message=>message.id===assistantId?{...message,content:event.text}:message)}:entry)}));
        });
        try {
          await get().openAgent();
          const result = await window.electron.agent.run(conversation.id, body, attachments.map((item) => item.path), selection, requestRunId);
          if (!result.success || !result.data) throw new Error(result.error ?? 'Agent run failed.');
          get().syncAgent(result.data.snapshot);
          set((state) => ({conversations: state.conversations.map((entry) => entry.id === conversation.id ? {...entry,
            messages: entry.messages.map((message) => message.id === assistantId ? {...message, content: result.data!.message, status: 'done'} : message)} : entry)}));
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          try {
            const snapshot = await window.electron.agent.snapshot(conversation.id);
            if (snapshot.success && snapshot.data) get().syncAgent(snapshot.data);
          } catch { /* Keep the original run error if refreshing also fails. */ }
          set((state) => ({agentError: detail, conversations: state.conversations.map((entry) => entry.id === conversation.id ? {...entry,
            messages: entry.messages.map((message) => message.id === assistantId ? {...message, content: message.content || 'Agent paused.', status: 'error', error: detail} : message)} : entry)}));
        } finally {offProgress?.(); set({isGenerating: false, routePreview: null, routeLoading: false}); await get().refreshCatalog(); await get().refreshModels(); }
      },
      stopGeneration: () => {
        const id = get().activeConversationId;
        if (id) void window.electron.agent.stop(id).then((result) => { if (!result.success) set({agentError: result.error ?? 'Unable to stop.'}); });
      },
      retryLastAssistantMessage: async () => {
        const conversation = getCurrentConversation(get());
        const lastUserMessage = [...conversation.messages].reverse().find((message) => message.role === 'user');
        if (!lastUserMessage) {
          return;
        }

        set((state) => ({
          conversations: state.conversations.map((entry) =>
            entry.id === conversation.id
              ? {
                  ...entry,
                  messages: entry.messages.filter((message, index, messages) => {
                    if (message.role !== 'assistant') {
                      return true;
                    }

                    const isLastAssistant = index === messages.map((item) => item.role).lastIndexOf('assistant');
                    return !isLastAssistant;
                  }),
                }
              : entry,
          ),
        }));

        await get().sendMessage(lastUserMessage.content, lastUserMessage.attachments ?? []);
      },
      appendTerminalOutput: (output) => {
        set((state) => {
          const existing = state.terminalSessions[output.sessionId] as TerminalSessionState | undefined;
          const nextSession: TerminalSessionState = existing ?? {
            id: output.sessionId,
            command: '',
            cwd: state.projectPath ?? '',
            status: 'running',
            startedAt: output.timestamp,
            outputs: [],
          };

          return {
            terminalSessions: {
              ...state.terminalSessions,
              [output.sessionId]: {
                ...nextSession,
                outputs: [...nextSession.outputs, output],
              },
            },
            activeTerminalSessionId: state.activeTerminalSessionId ?? output.sessionId,
          };
        });
      },
      loadTerminalSessions: async () => {
        const result = await window.electron.terminal.sessions();
        if (!result.success || !result.data) {
          return;
        }

        const sessions = result.data;

        set((state) => ({
          terminalSessions: sessions.reduce<Record<string, TerminalSessionState>>((acc, session) => {
            acc[session.id] = {...session, outputs: state.terminalSessions[session.id]?.outputs ?? []};
            return acc;
          }, { ...state.terminalSessions }),
          activeTerminalSessionId: state.activeTerminalSessionId ?? sessions[0]?.id ?? null,
        }));
      },
      runTerminalCommand: async (command) => {
        const nextCommand = (command ?? get().terminalInput).trim();
        if (!nextCommand) {
          return;
        }

        const activityId = crypto.randomUUID();
        set((state) => ({
          terminalInput: '',
          activity: [
            {
              id: activityId,
              label: 'Terminal command',
              status: 'running',
              detail: nextCommand,
              startedAt: Date.now(),
            },
            ...state.activity,
          ],
        }));

        try {
          const result = await window.electron.terminal.exec(nextCommand, get().projectPath ?? undefined);
          await get().loadTerminalSessions();
          if (!result.success || !result.data) throw new Error(result.error ?? 'Command failed.');
          const session = get().terminalSessions[result.data];
          if (!session) throw new Error('Command returned without a terminal session. Inspect the agent audit for its result.');
          const passed = session.status === 'completed' && session.exitCode === 0;
          const detail = `${nextCommand} Â· ${session.status} Â· exit ${session.exitCode ?? 'unknown'}`;
          set((state) => ({
            activeTerminalSessionId: result.data!,
            agentError: passed ? null : detail,
            activity: state.activity.map((item) => item.id === activityId ? {
              ...item, status: passed ? 'completed' : 'error', detail, endedAt: Date.now(),
            } : item),
          }));
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          set((state) => ({agentError: detail, activity: state.activity.map((item) => item.id === activityId ? {
            ...item, status: 'error', detail, endedAt: Date.now(),
          } : item)}));
        }
      },
      setActiveTerminalSession: (activeTerminalSessionId) => set({ activeTerminalSessionId }),
      addActivity: (log) => set((state) => ({ activity: [log, ...state.activity].slice(0, 32) })),
      finishActivity: (id, status, detail) => set((state) => ({
        activity: state.activity.map((entry) =>
          entry.id === id ? { ...entry, status, detail, endedAt: Date.now() } : entry,
        ),
      })),
      bindRuntimeEvents: () => {
        const offAgent = window.electron.on('agent:updated', (snapshot) => {
          if (snapshot && typeof snapshot === 'object' && 'state' in snapshot) get().syncAgent(snapshot as AgentSnapshot);
        });
        const offProjectOpened = window.electron.on('project:opened', async (projectPath) => {
          if (typeof projectPath !== 'string') {
            return;
          }
          if (!get().isProjectSwitching) {
            set(projectConversation(get(), projectPath));
            const recent = await window.electron.project.listRecent();
            if (recent.success && recent.data) set({recentProjects: recent.data});
            await get().loadProjectFiles(projectPath);
            await get().openAgent();
          }
        });

        const offProjectClosed = window.electron.on('project:closed', () => {
          if (!get().isProjectSwitching) set(projectConversation(get(), null));
        });

        const offNewChat = window.electron.on('app:new-chat', () => {
          get().createConversation();
        });

        const offTerminal = window.electron.terminal.onOutput((output) => {
          get().appendTerminalOutput(output);
          if (output.type === 'system') void get().loadTerminalSessions();
        });
        const offTerminalUpdated = window.electron.on('terminal:session-updated', () => {void get().loadTerminalSessions();});

        return () => {
          offAgent();
          offProjectOpened();
          offProjectClosed();
          offNewChat();
          offTerminal();
          offTerminalUpdated();
        };
      },
    }),
    {
      name: 'crux-ui-state',
      storage: createJSONStorage(() => localStorage),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Omit<Partial<AppState>, 'currentView'> & { currentView?: string };
        return { ...current, ...saved, layoutVersion: 1, ...(saved.layoutVersion !== 1 ? {rightPanelOpen: false, terminalOpen: false} : {}), currentView: saved.currentView === 'settings' || saved.currentView === 'models' ? 'settings' : 'chat' };
      },
      partialize: (state) => ({
        layoutVersion: state.layoutVersion,
        conversations: state.conversations,
        activeConversationId: state.activeConversationId,
        theme: state.theme,
        sidebarOpen: state.sidebarOpen,
        rightPanelOpen: state.rightPanelOpen,
        terminalOpen: state.terminalOpen,
        currentView: state.currentView,
        rightPanelTab: state.rightPanelTab,
      }),
    },
  ),
);
