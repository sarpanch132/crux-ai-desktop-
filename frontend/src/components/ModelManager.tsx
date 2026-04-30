import { useEffect } from 'react';
import { Activity, Bot, Database, RefreshCw, ShieldCheck } from 'lucide-react';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
import { useStore } from '../hooks/useStore';

export function ModelManager() {
  const { models, providerHealth, settings, refreshModels } = useStore((state) => ({
    models: state.models,
    providerHealth: state.providerHealth,
    settings: state.settings,
    refreshModels: state.refreshModels,
  }));

  useEffect(() => {
    refreshModels().catch((error) => console.error(error));
  }, [refreshModels]);

  return (
    <div className="flex h-full flex-col bg-[radial-gradient(circle_at_top,rgba(34,197,94,0.08),transparent_22%),#05070d]">
      <div className="border-b border-white/6 px-6 py-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.35em] text-emerald-300/75">Model Manager</p>
            <h1 className="mt-2 text-2xl font-semibold text-white">Providers, health, and local model visibility</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              This fixes the old blank model screen by rendering live provider configuration and Ollama detection results.
            </p>
          </div>
          <Button onClick={() => refreshModels()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1 px-6 py-6">
        <div className="grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
          <section className="glass-panel rounded-3xl p-5">
            <div className="mb-4 flex items-center gap-2">
              <Database className="h-4 w-4 text-blue-300" />
              <h2 className="text-lg font-semibold text-white">Detected Models</h2>
            </div>
            <div className="space-y-3">
              {models.map((model) => (
                <div key={model.id} className="rounded-3xl border border-white/8 bg-white/[0.03] px-4 py-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-sm font-medium text-white">{model.name}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {model.provider} • status: {model.status} • RAM profile: {model.ramUsage}
                      </p>
                    </div>
                    <span className={`rounded-full px-3 py-1 text-xs ${
                      model.healthy ? 'bg-emerald-500/15 text-emerald-200' : 'bg-amber-500/15 text-amber-200'
                    }`}>
                      {model.healthy ? 'Healthy' : 'Needs Attention'}
                    </span>
                  </div>
                  {model.details && <p className="mt-3 text-sm text-muted-foreground">{model.details}</p>}
                </div>
              ))}
            </div>
          </section>

          <div className="space-y-5">
            <section className="glass-panel rounded-3xl p-5">
              <div className="mb-4 flex items-center gap-2">
                <Activity className="h-4 w-4 text-cyan-300" />
                <h2 className="text-lg font-semibold text-white">Provider Health</h2>
              </div>
              <div className="space-y-3">
                {providerHealth.map((health) => (
                  <div key={health.provider} className="rounded-3xl border border-white/8 bg-white/[0.03] px-4 py-4">
                    <div className="flex items-center justify-between gap-4">
                      <p className="text-sm font-medium capitalize text-white">{health.provider}</p>
                      <span className={`rounded-full px-3 py-1 text-xs ${
                        health.status === 'online'
                          ? 'bg-emerald-500/15 text-emerald-200'
                          : health.status === 'degraded'
                            ? 'bg-amber-500/15 text-amber-200'
                            : 'bg-rose-500/15 text-rose-200'
                      }`}>
                        {health.status}
                      </span>
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">{health.message}</p>
                  </div>
                ))}
              </div>
            </section>

            <section className="glass-panel rounded-3xl p-5">
              <div className="mb-4 flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-violet-300" />
                <h2 className="text-lg font-semibold text-white">Active Selection</h2>
              </div>
              <div className="rounded-3xl border border-white/8 bg-white/[0.03] px-4 py-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/6">
                    <Bot className="h-5 w-5 text-white" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-white">{settings?.model ?? 'No model selected'}</p>
                    <p className="text-xs text-muted-foreground">
                      Provider: {settings?.provider ?? 'unset'} • Max tokens: {settings?.maxTokens ?? 0}
                    </p>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
