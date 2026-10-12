import { useEffect, useRef, useState } from 'react';

import { motion, useReducedMotion } from 'framer-motion';

import { CheckCircle, XCircle, Loader2, Wifi } from 'lucide-react';

import { toast } from 'sonner';

import type { ConnectionTestResult } from '../../../electron/services/aiService';

import { Button } from './ui/button';

import { Input } from './ui/input';

import { ModelSelector, providers } from './ModelSelector';

import { useStore } from '../hooks/useStore';



export function SettingsView() {

  const {settings, updateSettings, isGenerating, settingsSaving, autoModelLoading, connectionTesting, setConnectionTesting} = useStore();

  const [draft,setDraft] = useState<AISettings | null>(settings);

  const [key,setKey] = useState('');

  const [clearKey,setClearKey] = useState(false);

  const [dirty,setDirty] = useState(false);

  const [busy,setBusy] = useState(false);

  const [error,setError] = useState('');

  const [notice,setNotice] = useState('');

  const [testResult,setTestResult] = useState<ConnectionTestResult | null>(null);

  const [testing,setTesting] = useState(false);

  const [testError,setTestError] = useState('');

  const [now,setNow] = useState(Date.now());

  const testLock = useRef(false);

  const testEpoch = useRef(0);

  const reducedMotion = useReducedMotion();

  useEffect(() => {

    const epoch = ++testEpoch.current;

    let canceled = false;

    setTestResult(null); setTestError(''); setTesting(false); testLock.current = false;

    if (settings?.provider) void window.electron.ai.getConnectionTest().then((result) => {

      if (!canceled && epoch === testEpoch.current && result.success) setTestResult(result.data ?? null);

    }).catch(() => undefined);

    return () => {canceled = true; ++testEpoch.current;};

  }, [settings]);

  useEffect(() => {const timer = window.setInterval(() => setNow(Date.now()), 30000);return () => window.clearInterval(timer);}, []);

  useEffect(() => {if (!dirty) setDraft(settings);},[settings,dirty]);

  const change = (patch: Partial<AISettings>) => {

    if ('provider' in patch) {setKey(''); setClearKey(false); patch.model = '';}

    setDraft((old) => old ? {...old, ...patch} : old);

    setDirty(true); setNotice(''); setError('');

  };

  const pending = dirty || !!key || clearKey;

  const savedConnection = draft && settings && draft.provider === settings.provider && draft.customEndpoint === settings.customEndpoint;

  const urlValid = (value: string) => {try {const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;} catch {return false;}};

  const temperatureError = draft && (!Number.isFinite(draft.temperature) || draft.temperature < 0 || draft.temperature > 2) ? 'Temperature must be between 0 and 2.' : '';

  const tokenError = draft && (!Number.isInteger(draft.maxTokens) || draft.maxTokens < 1 || draft.maxTokens > 65536) ? 'Maximum tokens must be a whole number between 1 and 65,536.' : '';

  const validation = !draft?.provider ? 'Choose a provider.' : draft.provider === 'custom' && !urlValid(draft.customEndpoint) ? 'Use an HTTP or HTTPS endpoint without embedded credentials.' : temperatureError || tokenError;

  const save = async () => {

    if (!draft || validation) return;

    setBusy(true);setError('');setNotice('');

    try {

      const values = {...draft};

      delete (values as Partial<AISettings>).apiKey; delete (values as Partial<AISettings>).hasApiKey;

      const changed = Object.fromEntries(Object.entries(values).filter(([field,value]) => settings?.[field as keyof AISettings] !== value)) as Partial<AISettings>;

      if (clearKey) changed.apiKey=''; else if(key.trim()) changed.apiKey=key.trim();

      await updateSettings(changed);

      setDirty(false);setKey('');setClearKey(false);setNotice('Connection saved. Choose an available model below.');

    } catch(reason) {setError(reason instanceof Error ? reason.message : String(reason));} finally {setBusy(false);}

  };

  const testConnection = async () => {

    if (connectionTesting || autoModelLoading || testLock.current || pending || busy || settingsSaving || isGenerating || (!settings?.hasApiKey && settings?.provider !== 'ollama') || !settings?.model) return;

    testLock.current = true; setConnectionTesting(true); setTesting(true); setTestError('');

    const epoch = ++testEpoch.current;

    try {

      const response = await window.electron.ai.testConnection();

      if (epoch !== testEpoch.current) return;

      if (!response.success || !response.data) throw new Error('Connection failed. Try again.');

      setTestResult(response.data); setNow(Date.now());

      if (response.data.success) toast.success(`${providers.find(item=>item.value===settings.provider)?.label ?? 'Provider'} connection successful.`);

      else toast.error(response.data.message);

    } catch {

      if (epoch === testEpoch.current) {setTestResult(null);setTestError('Connection failed. Try again.');toast.error('Connection failed. Try again.');}

    } finally {setConnectionTesting(false);void useStore.getState().refreshModels();if (epoch === testEpoch.current) {testLock.current = false;setTesting(false);}}

  };

  const visibleResult = pending ? null : testResult;

  const visibleTestError = pending ? '' : testError;

  const testedAgo = visibleResult ? Math.max(0, Math.floor((now - Date.parse(visibleResult.testedAt)) / 60000)) : 0;

  const status = testing ? 'Testing' : visibleResult?.success ? 'Connected' : visibleResult || visibleTestError ? 'Connection error' : 'Not tested';

  const StatusIcon = testing ? Loader2 : visibleResult?.success ? CheckCircle : visibleResult || visibleTestError ? XCircle : Wifi;

  if (!draft) return <div className="workspace-loading">Loading settings…</div>;

  return <div className="settings-page"><div className="settings-sheet">

    <header className="settings-heading"><h1>Connect your AI</h1><p>Choose a provider, save your connection, then select a model.</p></header>

    <fieldset disabled={busy || isGenerating || testing || settingsSaving || autoModelLoading || connectionTesting} className="settings-form">

      <label htmlFor="provider"><span className="setup-step" aria-hidden="true">1</span> Provider<select id="provider" className="settings-select" value={draft.provider} onChange={(event) => change({provider:event.target.value as AISettings['provider']})}><option value="">Choose provider</option>{providers.map((provider) => <option key={provider.value} value={provider.value}>{provider.label}</option>)}</select></label>

      <section className="provider-card" aria-label={`${providers.find((provider) => provider.value === draft.provider)?.label ?? 'Provider'} configuration`}>

      {draft.provider && <h2>{providers.find((provider) => provider.value === draft.provider)?.label}</h2>}

      {draft.provider === 'custom' && <label htmlFor="custom-url">Base URL<Input id="custom-url" value={draft.customEndpoint} placeholder="https://your-provider.example/v1" aria-invalid={!urlValid(draft.customEndpoint)} aria-describedby="custom-url-help" onChange={(event) => change({customEndpoint:event.target.value})}/>{!urlValid(draft.customEndpoint) && <small id="custom-url-help" className="field-error">Enter a complete HTTP or HTTPS endpoint.</small>}</label>}

      {draft.provider && draft.provider !== 'ollama' && <label htmlFor="api-key"><span className="setup-step" aria-hidden="true">2</span> API key<Input id="api-key" type="password" autoComplete="off" disabled={clearKey || busy} value={key} onChange={(event) => {setKey(event.target.value);setNotice('');}} placeholder={savedConnection && settings?.hasApiKey ? 'Leave blank to keep saved key' : 'Enter API key'}/><small>{savedConnection && settings?.hasApiKey ? 'Your encrypted key is saved.' : draft.provider === 'custom' ? 'Optional if your endpoint needs no key.' : 'Your key is encrypted and stored on this device.'}</small></label>}

      {draft.provider === 'ollama' && <p className="settings-helper">Connects to Ollama on this device. No API key is needed.</p>}

      <div className="connection-save-row"><Button disabled={busy || isGenerating || !pending || !!validation} onClick={() => void save()}>{busy ? 'Saving…' : 'Save & verify models'}</Button><small>Connection changes require confirmation.</small></div>

      {error && <p className="field-error" role="alert">{error}</p>}{notice && <p className="settings-helper" role="status">{notice}</p>}{pending && validation && <p className="field-error" role="alert">{validation}</p>}

      <section className="setup-model"><p className="setup-model-label"><span className="setup-step" aria-hidden="true">3</span> Choose a model</p>{!pending ? <ModelSelector/> : <p className="settings-helper">Save your connection to verify its models.</p>}</section>

      {draft.provider && <div className="connection-diagnostic" aria-busy={testing}>

        <Button variant="outline" disabled={pending || busy || settingsSaving || isGenerating || testing || (!settings?.hasApiKey && settings?.provider !== 'ollama') || !settings?.model} onClick={() => void testConnection()}>

          <StatusIcon aria-hidden="true" className={`h-4 w-4 mr-2 ${testing ? 'connection-spinner' : ''}`}/>{testing ? 'Testing connection…' : visibleResult?.success ? 'Connected' : visibleResult || visibleTestError ? 'Connection failed' : 'Test Connection'}

        </Button>

        <small>{pending ? 'Save your changes before testing.' : !settings?.hasApiKey && settings?.provider !== 'ollama' ? 'Save an API key to test the connection.' : !settings.model ? 'Choose a model before testing.' : 'Tests the saved key and selected model with a minimal request.'}</small>

        <motion.div key={status} initial={reducedMotion ? false : {opacity:0}} animate={{opacity:1}} transition={{duration:0.15}} className="connection-result" role="status" aria-live="polite" aria-atomic="true">

          <p className={`connection-status ${visibleResult?.success ? 'connection-success' : visibleResult || visibleTestError ? 'connection-error' : ''}`}><StatusIcon aria-hidden="true" className={`h-4 w-4 ${testing ? 'connection-spinner' : ''}`}/>{status}</p>

          <p className="settings-helper">{visibleResult ? `Last test: ${visibleResult.success ? 'Successful' : 'Failed'}` : 'No result for the current saved configuration.'}</p>

          {visibleResult && <dl className="connection-metadata"><dt>Tested</dt><dd title={new Date(visibleResult.testedAt).toLocaleString()}>{testedAgo < 1 ? 'Just now' : `${testedAgo} minute${testedAgo === 1 ? '' : 's'} ago`}</dd><dt>Model</dt><dd>{visibleResult.model}</dd><dt>Latency</dt><dd>{visibleResult.latencyMs} ms</dd></dl>}

          {!visibleResult?.success && (visibleResult || visibleTestError) && <p className="field-error">{visibleResult?.message ?? visibleTestError}</p>}

        </motion.div>

        {visibleResult && <details className="connection-details"><summary>View Details</summary><dl className="connection-metadata"><dt>HTTP status</dt><dd>{visibleResult.status ?? 'Unavailable'}</dd><dt>Provider code</dt><dd>{visibleResult.code ?? 'None'}</dd><dt>Request ID</dt><dd>{visibleResult.requestId ?? 'Unavailable'}</dd><dt>Message</dt><dd>{visibleResult.message}</dd></dl></details>}

      </div>}

      </section>

      <details className="settings-advanced"><summary>Advanced settings</summary><div className="advanced-fields">

        <label htmlFor="temperature">Temperature<Input id="temperature" type="number" min="0" max="2" step="0.1" value={Number.isFinite(draft.temperature) ? draft.temperature : ''} onChange={(event) => change({temperature:event.target.valueAsNumber})} aria-invalid={!!temperatureError}/>{temperatureError && <small className="field-error">{temperatureError}</small>}</label>

        <label htmlFor="max-tokens">Maximum tokens<Input id="max-tokens" type="number" min="1" max="65536" step="1" value={Number.isFinite(draft.maxTokens) ? draft.maxTokens : ''} onChange={(event) => change({maxTokens:event.target.valueAsNumber})} aria-invalid={!!tokenError}/>{tokenError && <small className="field-error">{tokenError}</small>}</label>

        {draft.provider && draft.provider !== 'ollama' && <label className="settings-checkbox"><input type="checkbox" checked={clearKey} onChange={(event) => {setClearKey(event.target.checked);setNotice('');}}/>Remove saved API key when saving</label>}

        <Button variant="outline" disabled={busy || isGenerating || !pending || !!validation} onClick={() => void save()}>Save changes</Button>

        <button className="reset-settings" disabled={!pending || busy} onClick={() => {setDraft(settings);setDirty(false);setKey('');setClearKey(false);setError('');setNotice('Changes discarded.');}}>Discard changes</button>

      </div></details>

    </fieldset>

  </div></div>;

}
