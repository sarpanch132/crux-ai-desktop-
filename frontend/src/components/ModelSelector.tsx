import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { useStore } from '../hooks/useStore';

export const providers: Array<{label: string; value: AIProvider}> = [
  {label: 'OpenAI', value: 'openai'}, {label: 'OpenRouter', value: 'openrouter'},
  {label: 'Anthropic', value: 'anthropic'}, {label: 'Ollama (local)', value: 'ollama'},
  {label: 'Google Gemini', value: 'gemini'}, {label: 'Groq', value: 'groq'}, {label: 'DeepSeek', value: 'deepseek'},
  {label: 'Mistral', value: 'mistral'}, {label: 'xAI', value: 'xai'}, {label: 'Together AI', value: 'together'},
  {label: 'Other OpenAI-compatible provider', value: 'custom'},
];

export function ModelSelector({compact = false}: {compact?: boolean}) {
  const {settings, models, modelsLoading, modelsError, updateSettings, isGenerating, settingsSaving, autoModelLoading, autoModelResult, autoModelError, findWorkingModel, connectionTesting, modelVerification, verificationActionPending, verifyModels, cancelModelVerification} = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now,setNow] = useState(Date.now());
  useEffect(()=>{if(!modelVerification?.retryAt)return;const timer=window.setTimeout(()=>setNow(Date.now()),Math.max(0,modelVerification.retryAt-Date.now()+1));return()=>window.clearTimeout(timer);},[modelVerification?.retryAt]);
  const available = models.filter(model => model.provider === settings?.provider && model.status === 'ready' && model.healthy && Number.isFinite(model.verificationExpiresAt)&&(model.verificationExpiresAt??0)>Date.now()&&!!model.lastVerifiedAt&&Number.isFinite(Date.parse(model.lastVerifiedAt)));
  const current = available.find(model=>model.id===settings?.model);
  const selected = autoModelLoading || settings?.autoModel ? '__auto__' : current?.id ?? '';
  const active = modelVerification?.state === 'discovering' || modelVerification?.state === 'testing';
  const blocked = !settings?.provider || modelsLoading && !available.length || busy || settingsSaving || isGenerating || autoModelLoading || connectionTesting;
  const resumable = modelVerification?.state === 'paused' || modelVerification?.state === 'canceled';
  const retryWaiting = !!modelVerification?.retryAt && modelVerification.retryAt>now;
  const scanBlocked = !settings?.provider || verificationActionPending || settingsSaving || isGenerating || autoModelLoading || connectionTesting || retryWaiting;
  const choose = async (model: string) => {
    if (blocked) return;
    setBusy(true); setError('');
    try {
      if (model === '__auto__') {
        await findWorkingModel();
        const state = useStore.getState();
        if (state.autoModelResult?.success) toast.success(`Working model selected: ${state.autoModelResult.model}`);
        else toast.error(state.autoModelError ?? 'No working model was found. Check your connection.');
      } else {await updateSettings({model, autoModel:false});}
    } catch (reason) {setError(reason instanceof Error ? reason.message : 'Could not select a model. Try again.');}
    finally {setBusy(false);}
  };
  const scanLabel = active?'Verifying models':resumable?'Resume model verification':modelVerification?.state==='completed'?'Retest models':'Verify models';
  return <div className={compact ? 'model-selector compact' : 'model-selector'} aria-busy={busy || settingsSaving || autoModelLoading}>
    <div className="flex min-w-0 items-center gap-2">
      <label className="min-w-0 flex-1">{!compact && <span className="mb-2 block">Model</span>}
        <select aria-label={compact ? 'Chat model' : 'Model'} className="settings-select" value={selected} disabled={blocked} onChange={event => void choose(event.target.value)}>
          <option value="">{active&&!available.length?'Verifying models…':'Choose verified model'}</option>
          <option value="__auto__">{autoModelLoading ? 'Auto · finding a model…' : 'Auto · find a working model'}</option>
          {available.map(model => <option key={model.id} value={model.id}>{model.id}</option>)}
        </select>
      </label>
      <button className="panel-icon-button shrink-0" aria-label={scanLabel} title={scanLabel} disabled={scanBlocked||active} onClick={() => void verifyModels(resumable)}><RefreshCw aria-hidden="true" className={`h-4 w-4 ${active ? 'animate-spin motion-reduce:animate-none' : ''}`}/></button>
    </div>
    {autoModelLoading && <p role="status" className="mt-1 flex items-center gap-1 text-xs text-muted-foreground"><Loader2 aria-hidden="true" className="h-3 w-3 animate-spin motion-reduce:animate-none"/>Finding a working model…</p>}
    {modelVerification && modelVerification.state!=='idle' && <div className="mt-1 text-xs text-muted-foreground"><p role="status">{modelVerification.state==='completed'?'Last scan':modelVerification.state==='discovering'?'Loading models':modelVerification.state==='testing'?'Verifying':modelVerification.state[0].toUpperCase()+modelVerification.state.slice(1)} · {modelVerification.completed}/{modelVerification.total}{!compact&&` · ${modelVerification.passed} passed · ${modelVerification.failed} failed · ${modelVerification.untested} remaining`}</p>{!compact&&modelVerification.currentModel&&active&&<p className="mt-1">Checking: {modelVerification.currentModel}</p>}{!compact&&modelVerification.message&&<p className="mt-1">{modelVerification.message}</p>}{active&&<button className="chat-settings-action" disabled={verificationActionPending} onClick={()=>void cancelModelVerification()} aria-label="Cancel model verification">Cancel</button>}{resumable&&<button className="chat-settings-action" disabled={scanBlocked} onClick={()=>void verifyModels(true)} aria-label="Resume model verification">Resume</button>}{retryWaiting&&<p className="mt-1">Retry after {new Date(modelVerification.retryAt!).toLocaleTimeString()}.</p>}</div>}
    {!compact&&<><p className="mt-1 text-xs text-muted-foreground">{providers.find(provider => provider.value === settings?.provider)?.label ?? 'Choose a provider in Settings'}</p><p className="mt-1 text-xs text-muted-foreground">Only models that passed a real generation test are listed. Verification tests each chat model; small API charges may apply. You can cancel at any time.</p><p className="mt-1 text-xs text-muted-foreground">Auto can use recent verification or make up to four minimal requests to find a working model.</p></>}
    {settings?.autoModel&&current&&<p className="mt-1 text-xs text-muted-foreground">Auto model: {current.id}</p>}
    {current&&!compact&&<p role="status" className="mt-1 flex items-center gap-1 text-xs text-emerald-300"><CheckCircle2 aria-hidden="true" className="h-3 w-3"/>Last verified model: {current.id}{current.lastVerifiedAt&&<span title={new Date(current.lastVerifiedAt).toLocaleString()}> · {new Date(current.lastVerifiedAt).toLocaleString()}</span>}</p>}
    {(error||autoModelError||modelsError)&&<p role="alert" className="field-error mt-1 text-xs">{error||autoModelError||modelsError}</p>}
    {autoModelResult&&!autoModelResult.success&&<details className="mt-1 text-xs text-muted-foreground"><summary>Model test details</summary><p>Provider: {autoModelResult.provider}</p><p>Attempts: {autoModelResult.attempts}</p><p>Latency: {autoModelResult.latencyMs} ms</p><p>Result: {autoModelResult.category??'Connection error'}</p><p>{autoModelResult.message}</p></details>}
    {!compact&&settings?.provider&&!active&&!modelsLoading&&!available.length&&<p role="status" className="mt-1 text-xs text-muted-foreground">No verified models yet. Run verification, resume the scan, or use Auto.</p>}
  </div>;
}
