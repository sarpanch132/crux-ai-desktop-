import { useMemo } from 'react';
import { MoonStar, Save, Server, Shield, SlidersHorizontal } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { useStore } from '../hooks/useStore';

const providerOptions: Array<{ label: string; value: AISettings['provider'] }> = [
  { label: 'Ollama', value: 'ollama' },
  { label: 'OpenRouter', value: 'openrouter' },
  { label: 'OpenAI', value: 'openai' },
  { label: 'Anthropic', value: 'anthropic' },
  { label: 'Custom', value: 'custom' },
];

export function SettingsView() {
  const { settings, models, theme, setTheme, updateSettings } = useStore((state) => ({
    settings: state.settings,
    models: state.models,
    theme: state.theme,
    setTheme: state.setTheme,
    updateSettings: state.updateSettings,
  }));

  const currentSettings = useMemo(() => settings ?? {
    provider: 'ollama' as const,
    model: 'qwen2.5-coder:3b',
    temperature: 0.2,
    maxTokens: 4096,
    ollamaUrl: 'http://127.0.0.1:11434',
    openaiBaseUrl: 'https://api.openai.com/v1',
    customEndpoint: 'http://127.0.0.1:11434/v1',
    apiKey: '',
    autonomyLevel: 'guarded' as const,
    toolPermissions: 'safe-only' as const,
    performanceMode: 'balanced' as const,
  }, [settings]);

  const modelOptions = useMemo(() => {
    const optionIds = new Set<string>();
    const options: string[] = [];

    for (const model of models) {
      if (!optionIds.has(model.id)) {
        optionIds.add(model.id);
        options.push(model.id);
      }
    }

    if (currentSettings.model && !optionIds.has(currentSettings.model)) {
      options.unshift(currentSettings.model);
    }

    return options;
  }, [models, currentSettings.model]);

  return (
    <div className="flex h-full flex-col bg-[radial-gradient(circle_at_top,rgba(168,85,247,0.08),transparent_22%),#05070d]">
      <div className="border-b border-white/6 px-6 py-5">
        <p className="text-xs uppercase tracking-[0.35em] text-violet-300/75">Settings</p>
        <h1 className="mt-2 text-2xl font-semibold text-white">CruX configuration and safety controls</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Provider setup, model preferences, timeout behavior, and runtime safeguards all persist through Electron store.
        </p>
      </div>

      <div className="grid flex-1 gap-5 overflow-auto px-6 py-6 lg:grid-cols-2">
        <section className="glass-panel rounded-3xl p-5">
          <div className="mb-4 flex items-center gap-2">
            <Server className="h-4 w-4 text-cyan-300" />
            <h2 className="text-lg font-semibold text-white">Provider</h2>
          </div>
          <div className="space-y-4">
            <label className="block">
              <span className="mb-2 block text-xs uppercase tracking-[0.28em] text-muted-foreground">Provider</span>
              <select
                className="glass-input w-full rounded-2xl border border-white/8 bg-transparent px-3 py-3 text-sm text-white outline-none"
                value={currentSettings.provider}
                onChange={(event) => updateSettings({ provider: event.target.value as AISettings['provider'] }).catch((error) => console.error(error))}
              >
                {providerOptions.map((option) => (
                  <option key={option.value} value={option.value} className="bg-slate-950">
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="mb-2 block text-xs uppercase tracking-[0.28em] text-muted-foreground">Detected Models</span>
              <select
                className="glass-input mb-3 w-full rounded-2xl border border-white/8 bg-transparent px-3 py-3 text-sm text-white outline-none"
                value={currentSettings.model}
                onChange={(event) => updateSettings({ model: event.target.value }).catch((error) => console.error(error))}
              >
                {modelOptions.map((modelId) => (
                  <option key={modelId} value={modelId} className="bg-slate-950">
                    {modelId}
                  </option>
                ))}
              </select>

              <span className="mb-2 block text-xs uppercase tracking-[0.28em] text-muted-foreground">Model</span>
              <Input
                value={currentSettings.model}
                onChange={(event) => updateSettings({ model: event.target.value }).catch((error) => console.error(error))}
                className="glass-input border-white/8"
              />
            </label>

            <label className="block">
              <span className="mb-2 block text-xs uppercase tracking-[0.28em] text-muted-foreground">Ollama URL</span>
              <Input
                value={currentSettings.ollamaUrl}
                onChange={(event) => updateSettings({ ollamaUrl: event.target.value }).catch((error) => console.error(error))}
                className="glass-input border-white/8"
              />
            </label>

            <label className="block">
              <span className="mb-2 block text-xs uppercase tracking-[0.28em] text-muted-foreground">API Key</span>
              <Input
                value={currentSettings.apiKey}
                onChange={(event) => updateSettings({ apiKey: event.target.value }).catch((error) => console.error(error))}
                className="glass-input border-white/8"
                placeholder="Optional for Ollama, required for hosted providers"
                type="password"
              />
            </label>
          </div>
        </section>

        <section className="glass-panel rounded-3xl p-5">
          <div className="mb-4 flex items-center gap-2">
            <SlidersHorizontal className="h-4 w-4 text-emerald-300" />
            <h2 className="text-lg font-semibold text-white">Generation</h2>
          </div>
          <div className="space-y-4">
            <label className="block">
              <span className="mb-2 block text-xs uppercase tracking-[0.28em] text-muted-foreground">Temperature</span>
              <Input
                type="number"
                step="0.1"
                value={currentSettings.temperature}
                onChange={(event) => updateSettings({ temperature: Number(event.target.value) }).catch((error) => console.error(error))}
                className="glass-input border-white/8"
              />
            </label>

            <label className="block">
              <span className="mb-2 block text-xs uppercase tracking-[0.28em] text-muted-foreground">Max Tokens</span>
              <Input
                type="number"
                value={currentSettings.maxTokens}
                onChange={(event) => updateSettings({ maxTokens: Number(event.target.value) }).catch((error) => console.error(error))}
                className="glass-input border-white/8"
              />
            </label>

            <label className="block">
              <span className="mb-2 block text-xs uppercase tracking-[0.28em] text-muted-foreground">Performance Mode</span>
              <select
                className="glass-input w-full rounded-2xl border border-white/8 bg-transparent px-3 py-3 text-sm text-white outline-none"
                value={currentSettings.performanceMode}
                onChange={(event) => updateSettings({ performanceMode: event.target.value as AISettings['performanceMode'] }).catch((error) => console.error(error))}
              >
                <option value="balanced" className="bg-slate-950">Balanced</option>
                <option value="quality" className="bg-slate-950">Quality</option>
                <option value="speed" className="bg-slate-950">Speed</option>
              </select>
            </label>
          </div>
        </section>

        <section className="glass-panel rounded-3xl p-5">
          <div className="mb-4 flex items-center gap-2">
            <Shield className="h-4 w-4 text-amber-300" />
            <h2 className="text-lg font-semibold text-white">Autonomy & Safety</h2>
          </div>
          <div className="space-y-4">
            <label className="block">
              <span className="mb-2 block text-xs uppercase tracking-[0.28em] text-muted-foreground">Autonomy Level</span>
              <select
                className="glass-input w-full rounded-2xl border border-white/8 bg-transparent px-3 py-3 text-sm text-white outline-none"
                value={currentSettings.autonomyLevel}
                onChange={(event) => updateSettings({ autonomyLevel: event.target.value as AISettings['autonomyLevel'] }).catch((error) => console.error(error))}
              >
                <option value="guarded" className="bg-slate-950">Guarded</option>
                <option value="balanced" className="bg-slate-950">Balanced</option>
                <option value="extended" className="bg-slate-950">Extended</option>
              </select>
            </label>

            <label className="block">
              <span className="mb-2 block text-xs uppercase tracking-[0.28em] text-muted-foreground">Tool Permissions</span>
              <select
                className="glass-input w-full rounded-2xl border border-white/8 bg-transparent px-3 py-3 text-sm text-white outline-none"
                value={currentSettings.toolPermissions}
                onChange={(event) => updateSettings({ toolPermissions: event.target.value as AISettings['toolPermissions'] }).catch((error) => console.error(error))}
              >
                <option value="ask" className="bg-slate-950">Ask</option>
                <option value="safe-only" className="bg-slate-950">Safe Only</option>
                <option value="manual" className="bg-slate-950">Manual</option>
              </select>
            </label>
          </div>
        </section>

        <section className="glass-panel rounded-3xl p-5">
          <div className="mb-4 flex items-center gap-2">
            <MoonStar className="h-4 w-4 text-blue-300" />
            <h2 className="text-lg font-semibold text-white">Appearance</h2>
          </div>
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2">
              <Button variant={theme === 'dark' ? 'default' : 'outline'} onClick={() => setTheme('dark')}>Dark</Button>
              <Button variant={theme === 'light' ? 'default' : 'outline'} onClick={() => setTheme('light')}>Light</Button>
              <Button variant={theme === 'system' ? 'default' : 'outline'} onClick={() => setTheme('system')}>System</Button>
            </div>

            <div className="rounded-3xl border border-white/8 bg-white/[0.03] px-4 py-4 text-sm text-muted-foreground">
              CruX keeps the desktop UI in premium dark mode by default, but theme switching is still available for accessibility and daylight use.
            </div>

            <Button className="w-full justify-center gap-2" onClick={() => updateSettings({ ...currentSettings }).catch((error) => console.error(error))}>
              <Save className="h-4 w-4" />
              Save Settings
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
}
