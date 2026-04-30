import { useMemo, useState } from 'react';
import {
  Bot,
  FolderOpen,
  MessageSquare,
  Plus,
  Search,
  Settings,
  TerminalSquare,
  Wrench,
} from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { ScrollArea } from './ui/scroll-area';
import { useStore } from '../hooks/useStore';
import cruxLogo from '../assets/crux-logo.jpg';

interface PremiumSidebarProps {
  onOpenCommandPalette: () => void;
}

export function PremiumSidebar({ onOpenCommandPalette }: PremiumSidebarProps) {
  const [query, setQuery] = useState('');
  const {
    currentView,
    projectPath,
    models,
    settings,
    conversations,
    activeConversationId,
    setCurrentView,
    createConversation,
    selectConversation,
    openProject,
    setTerminalOpen,
    updateSettings,
  } = useStore((state) => ({
    currentView: state.currentView,
    projectPath: state.projectPath,
    models: state.models,
    settings: state.settings,
    conversations: state.conversations,
    activeConversationId: state.activeConversationId,
    setCurrentView: state.setCurrentView,
    createConversation: state.createConversation,
    selectConversation: state.selectConversation,
    openProject: state.openProject,
    setTerminalOpen: state.setTerminalOpen,
    updateSettings: state.updateSettings,
  }));

  const filteredConversations = useMemo(() => {
    const search = query.trim().toLowerCase();
    if (!search) {
      return conversations;
    }

    return conversations.filter((conversation) =>
      conversation.title.toLowerCase().includes(search)
      || conversation.messages.some((message) => message.content.toLowerCase().includes(search)),
    );
  }, [conversations, query]);

  const activeModel = models.find((model) => model.id === settings?.model) ?? models[0];
  const modelOptions = useMemo(() => {
    const optionIds = new Set<string>();
    const options: string[] = [];

    for (const model of models) {
      if (!optionIds.has(model.id)) {
        optionIds.add(model.id);
        options.push(model.id);
      }
    }

    const configuredModel = settings?.model?.trim();
    if (configuredModel && !optionIds.has(configuredModel)) {
      options.unshift(configuredModel);
    }

    return options;
  }, [models, settings?.model]);

  return (
    <div className="flex h-full flex-col bg-[linear-gradient(180deg,rgba(4,6,13,0.98),rgba(9,10,18,0.95))]">
      <div className="border-b border-white/6 px-4 pb-4 pt-5">
        <div className="crux-logo-shell mb-5">
          <img src={cruxLogo} alt="cruX" className="crux-logo crux-logo-lg" />
          <p className="mt-2 text-xs tracking-[0.2em] text-blue-200/65">Desktop AI IDE</p>
        </div>

        <Button className="mb-3 w-full justify-start gap-2" onClick={() => createConversation()}>
          <Plus className="h-4 w-4" />
          New Chat
        </Button>

        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="glass-input border-white/8 pl-9"
            placeholder="Search chats"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2.5 border-b border-white/6 px-4 py-5">
        <Button variant={currentView === 'chat' ? 'default' : 'outline'} className="justify-start gap-2" onClick={() => setCurrentView('chat')}>
          <MessageSquare className="h-4 w-4" />
          Chat
        </Button>
        <Button variant={currentView === 'models' ? 'default' : 'outline'} className="justify-start gap-2" onClick={() => setCurrentView('models')}>
          <Bot className="h-4 w-4" />
          Models
        </Button>
        <Button variant={currentView === 'projects' ? 'default' : 'outline'} className="justify-start gap-2" onClick={() => setCurrentView('projects')}>
          <FolderOpen className="h-4 w-4" />
          Projects
        </Button>
        <Button variant={currentView === 'settings' ? 'default' : 'outline'} className="justify-start gap-2" onClick={() => setCurrentView('settings')}>
          <Settings className="h-4 w-4" />
          Settings
        </Button>
      </div>

      <div className="border-b border-white/6 px-4 py-5">
        <div className="glass-panel rounded-2xl p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-xs uppercase tracking-[0.28em] text-muted-foreground">Active Model</p>
            <Button variant="ghost" size="sm" onClick={() => setCurrentView('models')}>
              Manage
            </Button>
          </div>
          <p className="text-sm font-medium text-white">{activeModel?.name ?? 'No model selected'}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Provider: {settings?.provider ?? 'unknown'} • Health: {activeModel?.healthy ? 'healthy' : 'check configuration'}
          </p>
        </div>

        <label className="mt-3 block">
          <span className="mb-1.5 block text-[10px] uppercase tracking-[0.28em] text-muted-foreground">Switch Model</span>
          <select
            className="glass-input w-full rounded-xl border border-white/8 bg-transparent px-3 py-2 text-sm text-white outline-none"
            value={settings?.model ?? ''}
            onChange={(event) => updateSettings({ model: event.target.value }).catch((error) => console.error(error))}
          >
            {modelOptions.map((modelId) => (
              <option key={modelId} value={modelId} className="bg-slate-950">
                {modelId}
              </option>
            ))}
          </select>
        </label>

        <div className="mt-4 grid grid-cols-2 gap-2.5">
          <Button variant="outline" className="justify-start gap-2" onClick={() => openProject()}>
            <FolderOpen className="h-4 w-4" />
            {projectPath ? 'Switch' : 'Open'}
          </Button>
          <Button variant="outline" className="justify-start gap-2" onClick={() => setTerminalOpen(true)}>
            <TerminalSquare className="h-4 w-4" />
            Terminal
          </Button>
          <Button variant="outline" className="col-span-2 justify-start gap-2" onClick={onOpenCommandPalette}>
            <Wrench className="h-4 w-4" />
            Command Palette
          </Button>
        </div>

        <p className="mt-4 truncate text-xs text-muted-foreground">
          {projectPath ? `Workspace: ${projectPath}` : 'No project open'}
        </p>
      </div>

      <ScrollArea className="flex-1 px-3 py-4">
        <div className="space-y-2.5">
          {filteredConversations.map((conversation) => (
            <button
              key={conversation.id}
              type="button"
              onClick={() => selectConversation(conversation.id)}
              className={`w-full rounded-2xl border px-3 py-3 text-left transition ${
                conversation.id === activeConversationId
                  ? 'border-blue-400/30 bg-blue-500/10 shadow-[0_0_20px_rgba(59,130,246,0.18)]'
                  : 'border-white/6 bg-white/[0.02] hover:border-white/12 hover:bg-white/[0.04]'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-white">{conversation.title}</p>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {conversation.messages.at(-1)?.content ?? 'No messages yet'}
                  </p>
                </div>
                <span className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
                  {conversation.messages.length}
                </span>
              </div>
            </button>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
