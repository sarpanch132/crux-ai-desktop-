import { useMemo, useState } from 'react';
import { Activity, Bot, FolderTree, FolderUp, ListTodo } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { ScrollArea } from './ui/scroll-area';
import { useStore } from '../hooks/useStore';

interface ContextPanelProps {
  standalone?: boolean;
}

function FileTree({ nodes }: { nodes: ReturnType<typeof useStore.getState>['fileTree'] }) {
  return (
    <div className="space-y-1">
      {nodes.map((node) => (
        <div key={node.id}>
          <div className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm text-slate-200 hover:bg-white/[0.04]">
            <span className="text-blue-200/80">{node.type === 'directory' ? '▸' : '•'}</span>
            <span className="truncate">{node.name}</span>
          </div>
          {node.children && node.children.length > 0 && (
            <div className="ml-4 border-l border-white/6 pl-2">
              <FileTree nodes={node.children} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function ContextPanel({ standalone = false }: ContextPanelProps) {
  const [query, setQuery] = useState('');
  const {
    fileTree,
    activity,
    projectPath,
    models,
    providerHealth,
    isGenerating,
    currentView,
    setCurrentView,
    openProject,
  } = useStore((state) => ({
    fileTree: state.fileTree,
    activity: state.activity,
    projectPath: state.projectPath,
    models: state.models,
    providerHealth: state.providerHealth,
    isGenerating: state.isGenerating,
    currentView: state.currentView,
    setCurrentView: state.setCurrentView,
    openProject: state.openProject,
  }));

  const filteredActivity = useMemo(() => {
    if (!query.trim()) {
      return activity;
    }
    return activity.filter((item) => item.label.toLowerCase().includes(query.toLowerCase()) || item.detail.toLowerCase().includes(query.toLowerCase()));
  }, [activity, query]);

  const panelClass = standalone
    ? 'h-full bg-[radial-gradient(circle_at_top,rgba(59,130,246,0.08),transparent_20%),#05070d]'
    : 'h-full bg-[linear-gradient(180deg,rgba(6,8,14,0.96),rgba(8,10,18,0.96))]';

  return (
    <div className={`${panelClass} flex h-full flex-col`}>
      <div className="border-b border-white/6 p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.35em] text-blue-300/70">Workspace</p>
            <h2 className="mt-2 text-xl font-semibold text-white">
              {standalone ? 'Project Context' : 'Live Context'}
            </h2>
          </div>
          <Button variant="outline" size="sm" onClick={() => openProject()}>
            <FolderUp className="mr-2 h-4 w-4" />
            {projectPath ? 'Switch' : 'Open'}
          </Button>
        </div>
        <p className="mt-3 text-sm text-muted-foreground">
          {projectPath ? projectPath : 'No workspace connected. Open a project to populate the explorer and tool context.'}
        </p>
      </div>

      {standalone && (
        <div className="grid grid-cols-3 gap-3 border-b border-white/6 p-5">
          <Button variant={currentView === 'projects' ? 'default' : 'outline'} onClick={() => setCurrentView('projects')}>
            <FolderTree className="mr-2 h-4 w-4" />
            Files
          </Button>
          <Button variant="outline" onClick={() => setCurrentView('models')}>
            <Bot className="mr-2 h-4 w-4" />
            Models
          </Button>
          <Button variant="outline" onClick={() => setCurrentView('settings')}>
            <ListTodo className="mr-2 h-4 w-4" />
            Settings
          </Button>
        </div>
      )}

      <div className="p-4">
        <Input
          className="glass-input border-white/8"
          placeholder="Search activity or file context"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <ScrollArea className="flex-1 px-4 pb-4">
        <div className="space-y-4">
          <section className="glass-panel rounded-3xl p-4">
            <div className="mb-3 flex items-center gap-2">
              <FolderTree className="h-4 w-4 text-blue-300" />
              <p className="text-sm font-medium text-white">File Tree</p>
            </div>
            {fileTree.length > 0 ? (
              <FileTree nodes={fileTree.slice(0, 12)} />
            ) : (
              <p className="text-sm text-muted-foreground">Open a project to see local files here.</p>
            )}
          </section>

          <section className="glass-panel rounded-3xl p-4">
            <div className="mb-3 flex items-center gap-2">
              <ListTodo className="h-4 w-4 text-cyan-300" />
              <p className="text-sm font-medium text-white">Runtime Tasks</p>
            </div>
            <div className="space-y-2 text-sm text-slate-200">
              <div className="rounded-2xl border border-white/8 bg-white/[0.03] px-3 py-3">
                <p className="font-medium">AI Generation</p>
                <p className="text-xs text-muted-foreground">{isGenerating ? 'A response is currently streaming.' : 'Idle and ready.'}</p>
              </div>
              {providerHealth.map((health) => (
                <div key={health.provider} className="rounded-2xl border border-white/8 bg-white/[0.03] px-3 py-3">
                  <p className="font-medium capitalize">{health.provider}</p>
                  <p className="text-xs text-muted-foreground">{health.message}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="glass-panel rounded-3xl p-4">
            <div className="mb-3 flex items-center gap-2">
              <Activity className="h-4 w-4 text-violet-300" />
              <p className="text-sm font-medium text-white">Recent Activity</p>
            </div>
            <div className="space-y-2">
              {filteredActivity.length > 0 ? filteredActivity.map((item) => (
                <div key={item.id} className="rounded-2xl border border-white/8 bg-white/[0.03] px-3 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-medium text-white">{item.label}</p>
                    <span className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">{item.status}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{item.detail}</p>
                </div>
              )) : (
                <p className="text-sm text-muted-foreground">No activity matches your current filter.</p>
              )}
            </div>
          </section>

          <section className="glass-panel rounded-3xl p-4">
            <div className="mb-3 flex items-center gap-2">
              <Bot className="h-4 w-4 text-emerald-300" />
              <p className="text-sm font-medium text-white">Detected Models</p>
            </div>
            <div className="space-y-2">
              {models.map((model) => (
                <div key={model.id} className="rounded-2xl border border-white/8 bg-white/[0.03] px-3 py-3">
                  <p className="text-sm font-medium text-white">{model.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {model.provider} • {model.status} • RAM: {model.ramUsage}
                  </p>
                </div>
              ))}
            </div>
          </section>
        </div>
      </ScrollArea>
    </div>
  );
}
