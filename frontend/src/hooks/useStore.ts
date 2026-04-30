import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export type ThemeMode = 'dark' | 'light' | 'system';
export type MainView = 'chat' | 'models' | 'settings' | 'projects';
export type RightPanelTab = 'files' | 'tasks' | 'activity';

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

interface AppState {
  initialized: boolean;
  appVersion: string;
  theme: ThemeMode;
  currentView: MainView;
  rightPanelTab: RightPanelTab;
  sidebarOpen: boolean;
  rightPanelOpen: boolean;
  terminalOpen: boolean;
  projectPath: string | null;
  fileTree: FileTreeNode[];
  conversations: Conversation[];
  activeConversationId: string | null;
  models: ModelInfo[];
  providerHealth: ProviderHealth[];
  settings: AISettings | null;
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
  selectConversation: (id: string) => void;
  refreshModels: () => Promise<void>;
  updateSettings: (settings: Partial<AISettings>) => Promise<void>;
  openProject: () => Promise<void>;
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

const DEFAULT_SETTINGS: AISettings = {
  provider: 'ollama',
  model: 'qwen2.5-coder:3b',
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

function createEmptyConversation(): Conversation {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: 'New Chat',
    createdAt: now,
    updatedAt: now,
    messages: [
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: 'CruX is ready. I can help you code, inspect files, reason through bugs, and work with your local tools safely.',
        createdAt: now,
        status: 'done',
      },
    ],
  };
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
      initialized: false,
      appVersion: '0.0.0',
      theme: 'dark',
      currentView: 'chat',
      rightPanelTab: 'files',
      sidebarOpen: true,
      rightPanelOpen: true,
      terminalOpen: true,
      projectPath: null,
      fileTree: [],
      conversations: [createEmptyConversation()],
      activeConversationId: null,
      models: [],
      providerHealth: [],
      settings: null,
      isGenerating: false,
      activeStreamMessageId: null,
      activeTerminalSessionId: null,
      terminalSessions: {},
      activity: [],
      terminalInput: '',
      composerValue: '',
      activeStreamAbort: null,
      initialize: async () => {
        const [settingsResult, modelsResult, healthResult, projectResult, versionResult] = await Promise.all([
          window.electron.ai.getSettings(),
          window.electron.ai.getModels(),
          window.electron.ai.getHealth(),
          window.electron.project.getPath(),
          window.electron.app.getVersion(),
        ]);

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
          models: modelsResult.success && modelsResult.data ? modelsResult.data : [],
          providerHealth: healthResult.success && healthResult.data ? healthResult.data : [],
          projectPath: projectResult.success && projectResult.data ? projectResult.data : null,
        }));

        if (projectResult.success && projectResult.data) {
          await get().loadProjectFiles(projectResult.data);
        }

        await get().loadTerminalSessions();
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
      setComposerValue: (composerValue) => set({ composerValue }),
      createConversation: () => {
        const conversation = createEmptyConversation();
        set((state) => ({
          conversations: [conversation, ...state.conversations],
          activeConversationId: conversation.id,
          currentView: 'chat',
          composerValue: '',
        }));
        return conversation.id;
      },
      selectConversation: (id) => set({ activeConversationId: id, currentView: 'chat' }),
      refreshModels: async () => {
        const [modelsResult, healthResult] = await Promise.all([
          window.electron.ai.getModels(),
          window.electron.ai.getHealth(),
        ]);

        set({
          models: modelsResult.success && modelsResult.data ? modelsResult.data : [],
          providerHealth: healthResult.success && healthResult.data ? healthResult.data : [],
        });
      },
      updateSettings: async (settings) => {
        const result = await window.electron.ai.updateSettings(settings);
        if (!result.success || !result.data) {
          throw new Error(result.error || 'Unable to update settings.');
        }

        set({ settings: result.data });
        if (settings.provider || settings.model || settings.ollamaUrl) {
          await get().refreshModels();
        }
      },
      openProject: async () => {
        const result = await window.electron.project.open();
        if (!result.success || !result.data) {
          return;
        }

        set({ projectPath: result.data, currentView: 'projects' });
        await get().loadProjectFiles(result.data);
      },
      closeProject: async () => {
        await window.electron.project.close();
        set({ projectPath: null, fileTree: [] });
      },
      loadProjectFiles: async (projectPathOverride) => {
        const rootPath = projectPathOverride ?? get().projectPath;
        if (!rootPath) {
          set({ fileTree: [] });
          return;
        }

        const result = await window.electron.file.list(rootPath, {
          recursive: true,
          filter: ['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.turbo', '.cache'],
        });

        if (!result.success || !result.data) {
          set({ fileTree: [] });
          return;
        }

        set({ fileTree: buildFileTree(result.data.slice(0, 1200), rootPath) });
      },
      sendMessage: async (content, attachments = []) => {
        const state = get();
        if (state.isGenerating) {
          return;
        }

        const body = (content ?? state.composerValue).trim();
        if (!body) {
          return;
        }

        let conversation = getCurrentConversation(state);
        if (!state.activeConversationId) {
          const newId = get().createConversation();
          conversation = getCurrentConversation({ ...get(), activeConversationId: newId } as AppState);
        }

        const userMessage: ChatMessage = {
          id: crypto.randomUUID(),
          role: 'user',
          content: body,
          createdAt: Date.now(),
          status: 'done',
          attachments,
        };

        const assistantMessage: ChatMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: '',
          createdAt: Date.now(),
          status: 'streaming',
          model: state.settings?.model,
        };

        const requestMessages = [
          { role: 'system', content: 'You are CruX, a precise desktop AI IDE assistant. Be concise, accurate, and practical. Never loop. Use tools only when necessary.' },
          ...conversation.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
          { role: userMessage.role, content: userMessage.content },
        ];

        const activityId = crypto.randomUUID();

        set((current) => ({
          composerValue: '',
          isGenerating: true,
          activeStreamMessageId: assistantMessage.id,
          activity: [
            {
              id: activityId,
              label: `Model response (${current.settings?.provider ?? 'provider'})`,
              status: 'running',
              detail: `Streaming from ${current.settings?.model ?? 'configured model'}`,
              startedAt: Date.now(),
            },
            ...current.activity,
          ],
          conversations: current.conversations.map((entry) =>
            entry.id === conversation.id
              ? {
                  ...entry,
                  title: entry.messages.length <= 1 ? summarizeConversationTitle(body) : entry.title,
                  updatedAt: Date.now(),
                  messages: [...entry.messages, userMessage, assistantMessage],
                }
              : entry,
          ),
        }));

        const stream = window.electron.ai.stream(requestMessages, {
          temperature: state.settings?.temperature,
          maxTokens: state.settings?.maxTokens,
        });

        const cleanupChunk = stream.onChunk((chunk) => {
          set((current) => ({
            conversations: current.conversations.map((entry) =>
              entry.id === conversation.id
                ? {
                    ...entry,
                    updatedAt: Date.now(),
                    messages: entry.messages.map((message) =>
                      message.id === assistantMessage.id
                        ? { ...message, content: `${message.content}${chunk}` }
                        : message,
                    ),
                  }
                : entry,
            ),
          }));
        });

        const finalize = (status: ChatMessage['status'], error?: string) => {
          cleanupChunk();
          cleanupDone();
          cleanupError();
          set((current) => ({
            isGenerating: false,
            activeStreamMessageId: null,
            activeStreamAbort: null,
            conversations: current.conversations.map((entry) =>
              entry.id === conversation.id
                ? {
                    ...entry,
                    updatedAt: Date.now(),
                    messages: entry.messages.map((message) =>
                      message.id === assistantMessage.id
                        ? {
                            ...message,
                            status,
                            error,
                            content: message.content || (error ? 'CruX could not generate a response.' : message.content),
                          }
                        : message,
                    ),
                  }
                : entry,
            ),
            activity: current.activity.map((item) =>
              item.id === activityId
                ? {
                    ...item,
                    status: status === 'error' ? 'error' : 'completed',
                    detail: error ?? 'Response completed.',
                    endedAt: Date.now(),
                  }
                : item,
            ),
          }));
        };

        const cleanupDone = stream.onDone(() => finalize('done'));
        const cleanupError = stream.onError((error) => finalize('error', error));

        set({
          activeStreamAbort: () => {
            stream.abort();
            finalize('error', 'Generation stopped.');
          },
        });
      },
      stopGeneration: () => {
        get().activeStreamAbort?.();
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
            acc[session.id] = state.terminalSessions[session.id] ?? {
              ...session,
              outputs: [],
            };
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

        const result = await window.electron.terminal.exec(nextCommand, get().projectPath ?? undefined);
        if (!result.success || !result.data) {
          set((state) => ({
            activity: state.activity.map((item) =>
              item.id === activityId
                ? { ...item, status: 'error', detail: result.error ?? 'Command failed.', endedAt: Date.now() }
                : item,
            ),
          }));
          return;
        }

        set((state) => ({
          terminalSessions: {
            ...state.terminalSessions,
            [result.data!]: {
              id: result.data!,
              command: nextCommand,
              cwd: state.projectPath ?? '',
              status: 'running',
              startedAt: Date.now(),
              outputs: [
                {
                  sessionId: result.data!,
                  type: 'system',
                  data: `$ ${nextCommand}`,
                  timestamp: Date.now(),
                },
              ],
            },
          },
          activeTerminalSessionId: result.data!,
          activity: state.activity.map((item) =>
            item.id === activityId
              ? { ...item, status: 'completed', detail: nextCommand, endedAt: Date.now() }
              : item,
          ),
        }));
      },
      setActiveTerminalSession: (activeTerminalSessionId) => set({ activeTerminalSessionId }),
      addActivity: (log) => set((state) => ({ activity: [log, ...state.activity].slice(0, 32) })),
      finishActivity: (id, status, detail) => set((state) => ({
        activity: state.activity.map((entry) =>
          entry.id === id ? { ...entry, status, detail, endedAt: Date.now() } : entry,
        ),
      })),
      bindRuntimeEvents: () => {
        const offProjectOpened = window.electron.on('project:opened', async (projectPath) => {
          if (typeof projectPath !== 'string') {
            return;
          }
          set({ projectPath });
          await get().loadProjectFiles(projectPath);
        });

        const offProjectClosed = window.electron.on('project:closed', () => {
          set({ projectPath: null, fileTree: [] });
        });

        const offNewChat = window.electron.on('app:new-chat', () => {
          get().createConversation();
        });

        const offTerminal = window.electron.terminal.onOutput((output) => {
          get().appendTerminalOutput(output);
        });

        return () => {
          offProjectOpened();
          offProjectClosed();
          offNewChat();
          offTerminal();
        };
      },
    }),
    {
      name: 'crux-ui-state',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
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
