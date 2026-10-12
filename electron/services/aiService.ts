import axios, { AxiosError, AxiosInstance } from 'axios';
import Store from 'electron-store';
import log from 'electron-log';
import { safeStorage } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { providerText } from './agent/streamParser';
import { agentReply, agentStream, CRUX_REPLY_SCHEMA } from './agent/providerActions';

const execFileAsync = promisify(execFile);

export type AIProvider = '' | 'ollama' | 'openrouter' | 'openai' | 'anthropic' | 'custom' | 'gemini' | 'groq' | 'deepseek' | 'mistral' | 'xai' | 'together';

export interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AIOptions {
  agentStructured?: boolean;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface AISettings {
  autoModel?: boolean;
  provider: AIProvider;
  model: string;
  temperature: number;
  maxTokens: number;
  ollamaUrl: string;
  openaiBaseUrl: string;
  customEndpoint: string;
  apiKey: string;
  hasApiKey?: boolean;
  autonomyLevel: 'guarded' | 'balanced' | 'extended';
  toolPermissions: 'ask' | 'safe-only' | 'manual';
  performanceMode: 'balanced' | 'quality' | 'speed';
}

export type ConnectionErrorCategory = 'authentication' | 'permission' | 'model' | 'rate_limit' | 'quota' | 'spend_limit' | 'network' | 'timeout' | 'provider' | 'configuration' | 'response' | 'configuration_changed' | 'unsupported' | 'unknown';
export interface AutoModelResult { success: boolean; provider: AIProvider; model: string; message: string; category?: ConnectionErrorCategory; status?: number; code?: string; cached?: boolean; attempts: number; latencyMs: number; }
export interface ModelVerificationStatus { provider: AIProvider; state: 'idle' | 'discovering' | 'testing' | 'completed' | 'paused' | 'canceled' | 'error'; total: number; completed: number; passed: number; failed: number; untested: number; currentModel?: string; message?: string; retryAt?: number; }
interface VerificationJob { scope: string; settings: AISettings; status: ModelVerificationStatus; controller: AbortController; catalog: ModelInfo[]; next: number; force: boolean; promise?: Promise<void>; }
type ModelProbeResult = Omit<ConnectionTestResult, 'provider'> & { provider: AIProvider };
type ProbeDiagnostic = ModelProbeResult & { retryAfterMs?: number };
class ProviderRequestError extends Error { constructor(readonly failure: ConnectionTestResult) { super(failure.message); } }

export interface ConnectionTestResult {
  success: boolean;
  provider: AIProvider;
  model: string;
  latencyMs: number;
  testedAt: string;
  status?: number;
  code?: string;
  category?: ConnectionErrorCategory;
  message: string;
  requestId?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: AIProvider;
  status: 'ready' | 'unverified' | 'offline' | 'error' | 'loading';
  healthy: boolean;
  ramUsage: string;
  size?: number;
  modifiedAt?: string;
  details?: string;
  free?: boolean;
  verificationExpiresAt?: number;
  lastVerifiedAt?: string;
}

export interface ProviderHealth {
  provider: AIProvider;
  status: 'online' | 'degraded' | 'offline';
  message: string;
  latencyMs?: number;
}

const COMPATIBLE_ENDPOINTS: Partial<Record<AIProvider, string>> = {
  openrouter: 'https://openrouter.ai/api/v1', gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  groq: 'https://api.groq.com/openai/v1', deepseek: 'https://api.deepseek.com',
  mistral: 'https://api.mistral.ai/v1', xai: 'https://api.x.ai/v1', together: 'https://api.together.ai/v1',
};

const DEFAULT_SETTINGS: AISettings = {
  autoModel: false,
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

export class AIService {
  private readonly store: Store<any>;
  private readonly httpClient: AxiosInstance;
  private readonly activeRequests = new Map<string, AbortController>();
  private readonly modelDiscovery = new Map<string, Promise<ModelInfo[]>>();
  private readonly modelPreparation = new Map<string, Promise<void>>();

  private connectionRevision = 0;
  private connectionPending?: {identity: string; promise: Promise<ConnectionTestResult>; controller: AbortController};
  private autoPending?: { identity: string; controller: AbortController; promise: Promise<AutoModelResult> };
  private verifiedModels = new Map<string, { model: string; testedAt: number; expiresAt: number; latencyMs?: number }>();
  private verificationJobs = new Map<string, VerificationJob>();

  constructor(store: Store<any>) {
    this.store = store;
    this.httpClient = axios.create({
      timeout: 120_000,
      headers: {
        'Content-Type': 'application/json',
      },
      validateStatus: () => true,
      maxRedirects: 0,
    });
  }

  private secureStorage(): boolean {
    return safeStorage.isEncryptionAvailable() && !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text');
  }

  private providerBase(settings: AISettings): string {
    const endpoint = settings.provider === 'ollama' ? settings.ollamaUrl
      : COMPATIBLE_ENDPOINTS[settings.provider] ? COMPATIBLE_ENDPOINTS[settings.provider]!
      : settings.provider === 'anthropic' ? 'https://api.anthropic.com/v1'
      : settings.provider === 'custom' ? settings.customEndpoint : settings.openaiBaseUrl;
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Model endpoints must use HTTP(S) without embedded credentials, queries or fragments.');
    return this.normalizeBaseUrl(url.href).replace(/\/chat\/completions$/, '');
  }

  private credentialScope(settings: AISettings): string {
    return createHash('sha256').update(`${settings.provider}|${this.providerBase(settings)}`).digest('hex');
  }

  getSettings(): AISettings {
    const stored = (this.store.get('ai.settings') ?? {}) as Partial<AISettings>;
    const settings = {...DEFAULT_SETTINGS, ...stored, apiKey: ''};
    const scope = this.credentialScope(settings);
    const keys = {...((this.store.get('ai.credentials') ?? {}) as Record<string, string>)};
    const legacy = this.store.get('ai.encryptedKey');
    if (typeof legacy === 'string' || stored.apiKey) {
      if (!this.secureStorage()) throw new Error('OS credential storage is unavailable. Unlock your keyring and retry.');
      keys[scope] = typeof legacy === 'string' ? legacy : safeStorage.encryptString(stored.apiKey!).toString('base64');
      this.store.set('ai.credentials', keys);
      this.store.delete('ai.encryptedKey');
      this.store.set('ai.settings', {...stored, apiKey: ''});
    }
    if (keys[scope]) {
      if (!this.secureStorage()) throw new Error('OS credential storage is unavailable. Unlock your keyring and retry.');
      settings.apiKey = safeStorage.decryptString(Buffer.from(keys[scope], 'base64'));
    }
    return {...settings, hasApiKey: Boolean(settings.apiKey)};
  }

  getPublicSettings(): AISettings {
    const settings = this.getSettings();
    return {...settings, model: settings.apiKey && settings.model.includes(settings.apiKey) ? '[redacted]' : settings.model, apiKey: ''};
  }

  updateSettings(nextSettings: Partial<AISettings>): AISettings {
    if (!nextSettings || typeof nextSettings !== 'object' || Array.isArray(nextSettings)) throw new Error('Invalid model settings.');
    const allowed = Object.keys(DEFAULT_SETTINGS);
    if (nextSettings.autoModel !== undefined && typeof nextSettings.autoModel !== 'boolean') throw new Error('Auto model selection must be enabled or disabled.');
    if (Object.keys(nextSettings).some(key => !allowed.includes(key))) throw new Error('Unknown model setting.');
    if (nextSettings.provider !== undefined && !['', 'ollama', 'openrouter', 'openai', 'anthropic', 'custom', ...Object.keys(COMPATIBLE_ENDPOINTS)].includes(nextSettings.provider)) throw new Error('Unknown model provider.');
    if (nextSettings.temperature !== undefined && (typeof nextSettings.temperature !== 'number' || nextSettings.temperature < 0 || nextSettings.temperature > 2)) throw new Error('Temperature must be between 0 and 2.');
    if (nextSettings.maxTokens !== undefined && (!Number.isInteger(nextSettings.maxTokens) || nextSettings.maxTokens < 1 || nextSettings.maxTokens > 65536)) throw new Error('Token limit must be between 1 and 65,536.');
    for (const key of ['model', 'apiKey', 'ollamaUrl', 'openaiBaseUrl', 'customEndpoint'] as const) {
      if (nextSettings[key] !== undefined && (typeof nextSettings[key] !== 'string' || nextSettings[key]!.length > 4096)) throw new Error(`Invalid ${key}.`);
    }
    if (nextSettings.model !== undefined && /^(?:auto|__auto__)$/i.test(nextSettings.model.trim())) throw new Error('Auto is a selection mode. Choose an actual provider model.');
    for (const key of ['ollamaUrl', 'openaiBaseUrl', 'customEndpoint'] as const) {
      if (nextSettings[key] !== undefined) {
        const url = new URL(nextSettings[key]!);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Model endpoints must use HTTP(S) without embedded credentials, queries or fragments.');
      }
    }
    const current = this.getSettings();
    const merged = {...current, ...nextSettings, apiKey: ''};
    if ((current.provider !== merged.provider || this.credentialScope(current) !== this.credentialScope(merged)) && nextSettings.model === undefined) merged.model = '';
    if (nextSettings.apiKey !== undefined) {
      if (nextSettings.apiKey && !merged.provider) throw new Error('Choose a provider before saving an API key.');
      if (nextSettings.apiKey && !this.secureStorage()) throw new Error('Secure credential storage is unavailable. Configure an OS keyring before saving an API key.');
      const keys = {...((this.store.get('ai.credentials') ?? {}) as Record<string, string>)};
      const scope = this.credentialScope(merged);
      if (nextSettings.apiKey) keys[scope] = safeStorage.encryptString(nextSettings.apiKey).toString('base64');
      else delete keys[scope];
      this.store.set('ai.credentials', keys);
    }
    delete merged.hasApiKey;
    this.store.set('ai.settings', merged);
    const updated = this.getSettings();
    if (this.verificationScope(current) !== this.verificationScope(updated)) {
      for (const job of this.verificationJobs.values()) if (job.status.state === 'discovering' || job.status.state === 'testing') { job.status.state = 'canceled'; job.status.message = 'Provider configuration changed.'; job.controller.abort(); }
    }
    if (this.connectionIdentity(current) !== this.connectionIdentity(updated)) {
      this.connectionRevision += 1;
      this.connectionPending?.controller.abort();
      this.connectionPending = undefined;
      this.autoPending?.controller.abort();
      this.autoPending = undefined;
      this.store.delete('ai.connectionTest');
    }
    if (current.autoModel !== updated.autoModel) { this.connectionRevision += 1; this.autoPending?.controller.abort(); this.autoPending = undefined; }
    return updated;
  }

  private connectionIdentity(settings: AISettings): string {
    return createHash('sha256').update(JSON.stringify([settings.provider, this.providerBase(settings), settings.model, settings.apiKey])).digest('hex');
  }

  getConnectionTest(): ConnectionTestResult | null {
    try {
      const saved = this.store.get('ai.connectionTest') as {identity?: string; result?: ConnectionTestResult} | undefined;
      const settings = this.getSettings(); const result = saved?.result;
      if (saved?.identity !== this.connectionIdentity(settings) || !result || typeof result.success !== 'boolean' || result.provider !== settings.provider || result.model !== settings.model || !Number.isFinite(result.latencyMs) || typeof result.testedAt !== 'string' || !Number.isFinite(Date.parse(result.testedAt)) || typeof result.message !== 'string') return null;
      if (settings.apiKey && JSON.stringify(result).includes(settings.apiKey)) return null;
      return {success: result.success, provider: settings.provider, model: result.model, latencyMs: result.latencyMs, testedAt: result.testedAt, message: result.message, status: result.status, code: result.code, category: result.category, requestId: result.requestId};
    } catch { return null; }
  }

  testConnection(): Promise<ConnectionTestResult> {
    this.pauseVerificationForActivity();
    const started = Date.now();
    let settings: AISettings;
    try { settings = this.getSettings(); }
    catch { return Promise.resolve(this.connectionFailure('', started, 'configuration', 'Secure provider settings could not be loaded. Unlock OS credential storage and try again.')); }
    if (settings.apiKey && settings.model.includes(settings.apiKey)) return Promise.resolve(this.connectionFailure('[redacted]', started, 'configuration', 'The selected model is invalid. Choose an available model in Settings.'));
    const identity = this.connectionIdentity(settings);
    if (this.connectionPending?.identity === identity) return this.connectionPending.promise;
    const controller = new AbortController();
    const revision = this.connectionRevision;
    const timer = setTimeout(() => controller.abort(), 15_000);
    const promise = this.performConnectionTest(settings, started, controller.signal).then(probe => {
      const result = {...probe, provider:settings.provider};
      if (revision !== this.connectionRevision || identity !== this.connectionIdentity(this.getSettings())) {
        return this.connectionFailure(settings.model, started, 'configuration_changed', 'Provider settings changed during the test. Test the current configuration again.', {provider:settings.provider});
      }
      this.store.set('ai.connectionTest', {identity, result});
      if (result.success) this.rememberVerified(settings, 10 * 60_000, result.latencyMs);
      return result;
    }).catch(() => this.connectionFailure(settings.model, started, 'configuration', 'Connection test status could not be stored securely. Try again.', {provider:settings.provider}))
      .finally(() => { clearTimeout(timer); if (this.connectionPending?.promise === promise) this.connectionPending = undefined; });
    this.connectionPending = {identity, promise, controller};
    return promise;
  }

  private connectionFailure(model: string, started: number, category: ConnectionErrorCategory, message: string, details: Partial<ConnectionTestResult> = {}): ConnectionTestResult {
    return {success: false, provider: 'openai', model, latencyMs: Date.now() - started, testedAt: new Date().toISOString(), category, message, ...details};
  }

  private classifyConnectionFailure(model: string, started: number, status?: number, data?: unknown, headers?: Record<string, unknown>, networkCode?: string, apiKey?: string, provider: AIProvider = 'openai'): ConnectionTestResult {
    const providerError = (data as {error?: {code?: unknown; type?: unknown; param?: unknown}})?.error;
    const rawCode = providerError?.code;
    const quota = providerError?.type === 'insufficient_quota';
    const spendCodes = new Set(['billing_hard_limit_reached', 'project_budget_exceeded', 'organization_budget_exceeded', 'budget_exceeded', 'usage_limit_reached', 'project_quota_exceeded', 'organization_quota_exceeded', 'project_spend_limit_exceeded', 'organization_usage_limit_exceeded', 'organization_spend_limit_exceeded']);
    const allowedCodes = new Set(['invalid_api_key', 'insufficient_quota', 'rate_limit_exceeded', 'model_not_found', 'model_not_available', 'permission_denied', 'access_denied', 'account_deactivated', 'invalid_request_error', 'unsupported_parameter', 'invalid_parameter', 'unsupported_model', 'unsupported_endpoint', ...spendCodes]);
    const code = typeof rawCode === 'string' && allowedCodes.has(rawCode) ? rawCode : undefined;
    const rawRequestId = headers?.['x-request-id'];
    const requestId = typeof rawRequestId === 'string' && /^req_[a-zA-Z0-9_-]{1,100}$/.test(rawRequestId) && (!apiKey || !rawRequestId.includes(apiKey)) ? rawRequestId : undefined;
    let category: ConnectionErrorCategory = 'unknown'; let message = 'Connection failed.';
    if (status === 401) { category = 'authentication'; message = 'OpenAI rejected the API credentials. Verify the API key and try again.'; }
    else if (status === 403) { category = 'permission'; message = 'The API key is valid, but this OpenAI project/account does not have permission for the requested resource.'; }
    else if (code && spendCodes.has(code) || typeof providerError?.type === 'string' && spendCodes.has(providerError.type)) { category = 'quota'; message = 'OpenAI reports an account, organization, or project spending limit. Check API billing and project limits.'; }
    else if (status === 402) { category = 'quota'; message = 'OpenAI reports insufficient credits or an account/key spending limit. Check billing and the limits linked to this API key.'; }
    else if (status === 429 && (quota || code === 'insufficient_quota')) { category = 'quota'; message = 'OpenAI rejected this API key/project because of a quota or spending limit. Check the billing account and limits linked to this key; credits in another project/account may not apply.'; }
    else if (status === 429) { category = 'rate_limit'; message = 'OpenAI rate limit reached. Wait briefly and try again.'; }
    else if (status === 404 || providerError?.param === 'model' || code === 'model_not_found' || code === 'model_not_available') { category = 'model'; message = 'The configured model could not be accessed. Check the selected model.'; }
    else if (status && status >= 500) { category = 'provider'; message = 'OpenAI is temporarily unavailable. Try again shortly.'; }
    else if (networkCode === 'ECONNABORTED' || networkCode === 'ETIMEDOUT' || networkCode === 'ERR_CANCELED') { category = 'timeout'; message = 'The OpenAI connection timed out. Try again.'; }
    else if (!status && networkCode) { category = 'network'; message = 'Crux-AI could not reach OpenAI. Check the internet connection and try again.'; }
    else if (code === 'unsupported_model' || code === 'unsupported_endpoint') { category = 'unsupported'; message = 'The configured model does not support this text completion endpoint. Choose another model.'; }
    const label = {openai:'OpenAI',openrouter:'OpenRouter',anthropic:'Anthropic',ollama:'Ollama',gemini:'Google Gemini',groq:'Groq',deepseek:'DeepSeek',mistral:'Mistral',xai:'xAI',together:'Together AI',custom:'The provider','':'The provider'}[provider];
    return this.connectionFailure(model, started, category, message.replace(/OpenAI/g, label), {status, code, requestId, provider});
  }

  private async performConnectionTest(settings: AISettings, started: number, signal: AbortSignal): Promise<ConnectionTestResult> {
    if (!settings.provider) return this.connectionFailure(settings.model, started, 'configuration', 'Choose a provider before testing the connection.');
    if (settings.provider !== 'ollama' && !settings.apiKey) return this.connectionFailure(settings.model, started, 'configuration', 'Save an API key before testing the connection.', {provider:settings.provider});
    if (settings.apiKey && settings.model.includes(settings.apiKey)) return this.connectionFailure('[redacted]', started, 'configuration', 'The selected model is invalid. Choose an available model in Settings.');
    if (!settings.model.trim()) return this.connectionFailure(settings.model, started, 'configuration', 'Choose and save a model before testing the connection.');
    const result = await this.probeModel(settings, started, signal);
    return result;
  }

  private async probeModel(settings: AISettings, started: number, signal: AbortSignal, budget = 64): Promise<ProbeDiagnostic> {
    const normalize = (result: ConnectionTestResult): ModelProbeResult => ({ ...result, provider: settings.provider, message: settings.provider === 'openai' ? result.message : result.message.replace(/OpenAI/g, settings.provider === 'openrouter' ? 'OpenRouter' : 'The provider') });
    try {
      if (settings.provider === 'ollama' || settings.provider === 'anthropic') {
        const content = await this.performChat([{role: 'user', content: 'Reply with OK.'}], {maxTokens: budget, timeoutMs: 15_000}, signal, 'model-probe', settings);
        if (typeof content !== 'string' || !content.trim()) return normalize(this.connectionFailure(settings.model, started, 'response', 'The provider accepted the request but returned no text.'));
        return { success: true, provider: settings.provider, model: settings.model, latencyMs: Date.now()-started, testedAt: new Date().toISOString(), message: 'Connection successful.' };
      }
      const request = this.compatibleRequest(settings, [{role: 'user', content: 'Reply with OK.'}], {maxTokens: budget, timeoutMs: 15_000}, false);
      const response = await this.httpClient.post(request.endpoint, request.payload, {headers: request.headers, signal, timeout: 15_000, maxContentLength: 1024 * 1024});
      if (response.status < 200 || response.status >= 300) {
        const diagnostic = normalize(this.classifyConnectionFailure(settings.model, started, response.status, response.data, response.headers, undefined, settings.apiKey, settings.provider));
        const rawRetry = response.headers?.['retry-after'];
        const seconds = typeof rawRetry === 'string' || typeof rawRetry === 'number' ? Number(rawRetry) : NaN;
        const date = typeof rawRetry === 'string' ? Date.parse(rawRetry) : NaN;
        const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Number.isFinite(date) ? Math.max(0, date-Date.now()) : 30_000;
        return { ...diagnostic, ...(response.status === 429 ? { retryAfterMs: Math.min(delay, 24*60*60_000) } : {}) };
      }
      const choice = response.data?.choices?.[0];
      if (typeof choice?.message?.content !== 'string' || !choice.message.content.trim() || choice.finish_reason === 'length') {
        return normalize(this.connectionFailure(settings.model, started, 'response', 'OpenAI accepted the request, but the small test did not return a complete text response. Try again or choose another model.', {status: response.status}));
      }
      const requestId = response.headers['x-request-id'];
      return {success: true, provider: settings.provider, model: settings.model, latencyMs: Date.now() - started, testedAt: new Date().toISOString(), status: response.status, message: settings.provider === 'openai' ? 'OpenAI connection successful.' : 'Connection successful.', ...(typeof requestId === 'string' && /^req_[a-zA-Z0-9_-]{1,100}$/.test(requestId) && (!settings.apiKey || !requestId.includes(settings.apiKey)) ? {requestId} : {})};
    } catch (error) {
      if (error instanceof ProviderRequestError) return normalize(error.failure);
      if (axios.isAxiosError(error)) return normalize(this.classifyConnectionFailure(settings.model, started, error.response?.status, error.response?.data, error.response?.headers, error.code || 'NETWORK', settings.apiKey, settings.provider));
      return normalize(this.connectionFailure(settings.model, started, 'unknown', 'Connection failed.'));
    }
  }

  private verificationScope(settings: AISettings): string { return `${this.credentialScope(settings)}|${createHash('sha256').update(settings.apiKey).digest('hex')}`; }
  private verificationKey(settings: AISettings): string { return `${this.verificationScope(settings)}|${settings.model}`; }
  private rememberVerified(settings: AISettings, ttlMs = 10 * 60_000, latencyMs?: number): void {
    const testedAt = Date.now();
    const key = this.verificationKey(settings);
    this.verifiedModels.set(key, { model: settings.model, testedAt, expiresAt: Math.max(testedAt + ttlMs, this.verifiedModels.get(key)?.expiresAt || 0), ...(Number.isFinite(latencyMs) ? {latencyMs} : {}) });
    if (this.verifiedModels.size > 20_000) this.verifiedModels.delete(this.verifiedModels.keys().next().value!);
  }
  private modelVerified(settings: AISettings): boolean {
    const entry = this.verifiedModels.get(this.verificationKey(settings));
    if (!entry || entry.expiresAt <= Date.now()) { this.verifiedModels.delete(this.verificationKey(settings)); return false; }
    return true;
  }
  private forgetVerified(settings: AISettings): void {
    const job = this.restoreVerificationJob(settings);
    this.verifiedModels.delete(this.verificationKey(settings));
    if (job) this.persistVerificationJob(job);
  }
  private chatCapable(model: Record<string, unknown>, provider: AIProvider): boolean {
    if (model.type === 'embedding' || model.type === 'image' || model.type === 'transcription') return false;
    const architecture = model.architecture as { output_modalities?: unknown; input_modalities?: unknown } | undefined;
    if (Array.isArray(architecture?.output_modalities) && !architecture.output_modalities.includes('text')) return false;
    if (Array.isArray(architecture?.input_modalities) && !architecture.input_modalities.includes('text')) return false;
    const id = String(model.id || '');
    return provider !== 'openai' || !/^(?:text-embedding-|whisper-|tts-|dall-e-|gpt-image-|sora-|babbage-002$|davinci-002$)|(?:^|-)realtime(?:-|$)|(?:^|-)transcribe(?:-|$)/i.test(id);
  }

  /** Bounded diagnostic selection: only model IDs in the provider's actual catalog are probed. */
  findWorkingModel(canApply: () => boolean = () => true): Promise<AutoModelResult> {
    this.pauseVerificationForActivity();
    const started = Date.now();
    let settings: AISettings;
    try { settings = this.getSettings(); }
    catch { return Promise.resolve({ success: false, provider: '', model: '', category: 'configuration', message: 'Secure provider settings could not be loaded.', attempts: 0, latencyMs: 0 }); }
    const model = settings.apiKey && settings.model.includes(settings.apiKey) ? '[redacted]' : settings.model;
    const failure = (category: ConnectionErrorCategory, message: string): AutoModelResult => ({ success: false, provider: settings.provider, model, category, message, attempts: 0, latencyMs: Date.now()-started });
    if (!settings.provider) return Promise.resolve(failure('configuration', 'Choose a provider in Settings.'));
    if (!settings.apiKey && !['custom', 'ollama'].includes(settings.provider)) return Promise.resolve(failure('configuration', 'Save the provider API key before finding a working model.'));
    if (model === '[redacted]') return Promise.resolve(failure('configuration', 'The selected model is invalid. Choose an available model.'));
    const identity = this.connectionIdentity(settings);
    if (this.autoPending?.identity === identity) return this.autoPending.promise;
    const controller = new AbortController();
    const revision = this.connectionRevision;
    const deadline = started + 45_000;
    const timer = setTimeout(() => controller.abort(), 45_000);
    const promise = this.performAutoSelection(settings, started, deadline, controller.signal).then(result => {
      if (revision !== this.connectionRevision || identity !== this.connectionIdentity(this.getSettings()) || !canApply()) return { ...failure('configuration_changed', 'Provider settings or workspace activity changed. Try again when the agent is idle.'), attempts: result.attempts };
      if (controller.signal.aborted) return { ...failure('timeout', 'Model testing was canceled or timed out. Try again.'), attempts: result.attempts };
      if (result.success) {
        this.updateSettings({ model: result.model, autoModel: true });
        const updated = this.getSettings();
        if (updated.provider) {
          const verification = this.verifiedModels.get(this.verificationKey(updated));
          if (!result.cached && result.attempts > 0) this.store.set('ai.connectionTest', { identity: this.connectionIdentity(updated), result: { success: true, provider: updated.provider, model: updated.model, latencyMs: result.latencyMs, testedAt: new Date().toISOString(), message: 'Connection successful.' } });
          else if (!this.getConnectionTest() && typeof verification?.latencyMs === 'number') this.store.set('ai.connectionTest', { identity: this.connectionIdentity(updated), result: { success: true, provider: updated.provider, model: updated.model, latencyMs: verification.latencyMs, testedAt: new Date(verification.testedAt).toISOString(), message: 'Connection successful.' } });
        }
      }
      return result;
    }).catch(() => failure('unknown', 'Unable to determine a working model. Check provider settings and try again.'))
      .finally(() => { clearTimeout(timer); if (this.autoPending?.promise === promise) this.autoPending = undefined; });
    this.autoPending = { identity, controller, promise };
    return promise;
  }

  private async performAutoSelection(settings: AISettings, started: number, deadline: number, signal: AbortSignal): Promise<AutoModelResult> {
    let attempts = 0;
    const result = (success: boolean, model: string, message: string, category?: ConnectionErrorCategory, details: { status?: number; code?: string; cached?: boolean } = {}): AutoModelResult => ({ success, provider: settings.provider, model, message, category, attempts, latencyMs: Date.now()-started, ...details });
    let catalog: ModelInfo[];
    try { catalog = await this.discoverModels(settings, signal); }
    catch (error) {
      if (error instanceof ProviderRequestError) return result(false, settings.model, error.failure.message, error.failure.category, { status: error.failure.status, code: error.failure.code });
      if (axios.isAxiosError(error)) { const failure = this.classifyConnectionFailure(settings.model, started, error.response?.status, error.response?.data, error.response?.headers, error.code || 'NETWORK', settings.apiKey, settings.provider); return result(false, settings.model, failure.message, failure.category); }
      return result(false, settings.model, 'The provider model catalog could not be loaded. Check provider settings.', 'configuration');
    }
    const ids = new Set(catalog.map(item => item.id));
    const recent = [...this.verifiedModels.entries()].filter(([key, entry]) => key.startsWith(`${this.verificationScope(settings)}|`) && entry.expiresAt > Date.now() && ids.has(entry.model)).sort((a,b) => b[1].testedAt-a[1].testedAt).map(([,entry]) => entry.model);
    const cheap = [...catalog].sort((a,b) => {
      const rank = (id: string) => /(?:mini|nano|flash|small|haiku)/i.test(id) ? 0 : 1;
      return rank(a.id)-rank(b.id) || a.id.localeCompare(b.id);
    }).map(item => item.id);
    const selected = ids.has(settings.model) && !/^(?:auto|__auto__)$/i.test(settings.model) && this.chatCapable({ id: settings.model }, settings.provider) ? [settings.model] : [];
    const candidates = [...new Set([...selected, ...recent, ...cheap])].slice(0, 4);
    if (!candidates.length) return result(false, settings.model, 'No text chat models were returned by this provider.', 'model');
    let inconclusive = false;
    for (const model of candidates) {
      if (signal.aborted || Date.now() >= deadline) return result(false, settings.model, 'Model testing timed out. Try again.', 'timeout');
      const candidate = { ...settings, model };
      if (this.modelVerified(candidate)) return result(true, model, 'Using the most recent successful model test.', undefined, { cached: true });
      attempts++;
      const probe = await this.probeModel(candidate, Date.now(), signal);
      if (signal.aborted) return result(false, settings.model, 'Model testing was canceled or timed out. Try again.', 'timeout');
      if (probe.success) { this.rememberVerified(candidate, 10 * 60_000, probe.latencyMs); return result(true, model, 'Model connection verified.'); }
      this.forgetVerified(candidate);
      if (probe.category === 'response') inconclusive = true;
      if (!['model', 'unsupported', 'response'].includes(probe.category || 'unknown')) return result(false, settings.model, probe.message, probe.category, { status: probe.status, code: probe.code });
    }
    if (inconclusive) return result(false, settings.model, 'The small model tests were inconclusive. Choose a model and test again; no model was marked unsupported.', 'response');
    return result(false, settings.model, 'None of the tested models accepted a text request. Choose another model or check account permissions.', 'model');
  }

  private async resolveAutoSettings(): Promise<AISettings> {
    const settings = this.getSettings();
    this.restoreVerificationJob(settings);
    if (!settings.autoModel) return settings;
    if (settings.model && this.modelVerified(settings)) return settings;
    const result = await this.findWorkingModel();
    if (!result.success) throw new Error(result.message);
    return this.getSettings();
  }

  getModelVerification(): ModelVerificationStatus {
    const settings = this.getSettings();
    const job = this.restoreVerificationJob(settings);
    return job ? { ...job.status } : { provider: settings.provider, state: 'idle', total: 0, completed: 0, passed: 0, failed: 0, untested: 0 };
  }

  startModelVerification(retest = false): ModelVerificationStatus {
    const settings = this.getSettings(); const scope = this.verificationScope(settings);
    const existing = this.restoreVerificationJob(settings);
    if (existing?.promise || existing && ['discovering','testing'].includes(existing.status.state)) return { ...existing.status };
    if (existing && !retest) return { ...existing.status };
    if (!settings.provider || !settings.apiKey && !['custom','ollama'].includes(settings.provider)) return { provider: settings.provider, state: 'idle', total: 0, completed: 0, passed: 0, failed: 0, untested: 0, message: 'Choose a provider and save its API key to verify available models.' };
    existing?.controller.abort();
    const job: VerificationJob = { scope, settings, controller: new AbortController(), catalog: [], next: 0, force: retest, status: { provider: settings.provider, state: 'discovering', total: 0, completed: 0, passed: 0, failed: 0, untested: 0, message: 'Loading the provider model catalog.' } };
    this.verificationJobs.set(scope, job);
    this.persistVerificationJob(job);
    if (this.activeRequests.size || this.connectionPending || this.autoPending) { job.status.state = 'paused'; job.status.message = 'Verification paused for provider activity. Resume when the agent is idle.'; return { ...job.status }; }
    // Only explicit Retest starts a new pass. Polling and TTL expiry cannot repeat paid probes.
    job.promise = this.runModelVerification(job, true);
    return { ...job.status };
  }

  resumeModelVerification(): ModelVerificationStatus {
    const settings = this.getSettings(); const job = this.restoreVerificationJob(settings);
    if (!job || !['paused','canceled'].includes(job.status.state)) return this.getModelVerification();
    if (this.activeRequests.size || this.connectionPending || this.autoPending) return { ...job.status };
    if (job.status.retryAt && Date.now() < job.status.retryAt) return { ...job.status };
    if (job.promise) return { ...job.status };
    job.controller = new AbortController(); job.status.state = job.catalog.length ? 'testing' : 'discovering'; delete job.status.retryAt;
    job.promise = this.runModelVerification(job, !job.catalog.length);
    return { ...job.status };
  }

  cancelModelVerification(): ModelVerificationStatus {
    const job = this.verificationJobs.get(this.verificationScope(this.getSettings()));
    if (job && ['discovering','testing','paused'].includes(job.status.state)) { job.status.state = 'canceled'; job.status.message = 'Model verification canceled. Resume explicitly to continue.'; job.controller.abort(); }
    return this.getModelVerification();
  }

  private pauseVerificationForActivity(): void {
    for (const job of this.verificationJobs.values()) if (['discovering','testing'].includes(job.status.state)) { job.status.state = 'paused'; job.status.message = 'Verification paused for provider activity. Resume when the agent is idle.'; job.controller.abort(); }
  }

  private persistVerificationJob(job: VerificationJob): void {
    const stored = { ...((this.store.get('ai.modelVerification') || {}) as Record<string, unknown>) };
    const verified = [...this.verifiedModels.entries()].filter(([key]) => key.startsWith(`${job.scope}|`)).map(([,record]) => record);
    const snapshot = { provider: job.settings.provider, endpoint: this.providerBase(job.settings), status: { ...job.status }, catalog: job.catalog, next: job.next, force: job.force, verified };
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 8 * 1024 * 1024) throw new Error('Model verification journal exceeds the 8 MiB scope limit.');
    delete stored[job.scope]; stored[job.scope] = snapshot;
    const bounded = Object.fromEntries(Object.entries(stored).slice(-8));
    this.store.set('ai.modelVerification', bounded);
  }

  private restoreVerificationJob(settings: AISettings): VerificationJob | undefined {
    const scope = this.verificationScope(settings);
    const existing = this.verificationJobs.get(scope); if (existing) return existing;
    const stored = (this.store.get('ai.modelVerification') as Record<string, unknown> | undefined)?.[scope];
    if (!stored) return undefined;
    try {
      if (Buffer.byteLength(JSON.stringify(stored)) > 8 * 1024 * 1024 || settings.apiKey && JSON.stringify(stored).includes(settings.apiKey)) throw new Error('Invalid journal');
      const saved = stored as { provider: AIProvider; endpoint: string; status: ModelVerificationStatus; catalog: ModelInfo[]; next: number; force: boolean; verified: { model: string; testedAt: number; expiresAt: number; latencyMs?: number }[] };
      if (saved.provider !== settings.provider || saved.endpoint !== this.providerBase(settings) || !Array.isArray(saved.catalog) || saved.catalog.length > 20_000 || !Number.isInteger(saved.next) || saved.next < 0 || saved.next > saved.catalog.length || !saved.status || !['discovering','testing','completed','paused','canceled','error'].includes(saved.status.state) || !Array.isArray(saved.verified) || saved.verified.length > 20_000) throw new Error('Invalid journal');
      for (const key of ['total','completed','passed','failed','untested'] as const) if (!Number.isInteger(saved.status[key]) || saved.status[key] < 0 || saved.status[key] > 20_000) throw new Error('Invalid verification counts');
      for (const model of saved.catalog) if (!model || typeof model.id !== 'string' || model.id.length > 4096 || typeof model.name !== 'string' || model.name.length > 4096 || model.provider !== settings.provider) throw new Error('Invalid model metadata');
      for (const record of saved.verified) if (!record || typeof record.model !== 'string' || record.model.length > 4096 || !Number.isFinite(record.testedAt) || !Number.isFinite(record.expiresAt) || record.expiresAt > record.testedAt+24*60*60_000 || record.latencyMs !== undefined && (!Number.isFinite(record.latencyMs) || record.latencyMs < 0 || record.latencyMs > 24*60*60_000)) throw new Error('Invalid verification timestamp');
      for (const record of saved.verified) if (record.expiresAt > Date.now()) this.verifiedModels.set(this.verificationKey({ ...settings, model: record.model }), { ...record });
      const status: ModelVerificationStatus = { provider: settings.provider, state: saved.status.state, total: saved.status.total, completed: saved.status.completed, passed: saved.status.passed, failed: saved.status.failed, untested: saved.status.untested,
        ...(typeof saved.status.currentModel === 'string' && saved.status.currentModel.length <= 4096 ? { currentModel: saved.status.currentModel } : {}),
        ...(typeof saved.status.message === 'string' && saved.status.message.length <= 512 ? { message: saved.status.message } : {}),
        ...(Number.isFinite(saved.status.retryAt) ? { retryAt: saved.status.retryAt } : {}) };
      if (status.state === 'discovering' || status.state === 'testing') { status.state = 'paused'; status.message = 'Verification was interrupted. Resume explicitly to continue remaining models.'; }
      const job: VerificationJob = { scope, settings, status, catalog: saved.catalog, next: saved.next, force: Boolean(saved.force), controller: new AbortController() };
      this.verificationJobs.set(scope, job); return job;
    } catch {
      const job: VerificationJob = { scope, settings, catalog: [], next: 0, force: false, controller: new AbortController(), status: { provider: settings.provider, state: 'error', total: 0, completed: 0, passed: 0, failed: 0, untested: 0, message: 'Saved model verification could not be restored. Retest explicitly.' } };
      this.verificationJobs.set(scope, job); return job;
    }
  }

  private async runModelVerification(job: VerificationJob, discover: boolean): Promise<void> {
    const current = () => !job.controller.signal.aborted && this.verificationJobs.get(job.scope) === job && this.verificationScope(this.getSettings()) === job.scope;
    try {
      if (discover) {
        job.catalog = await this.discoverModels(job.settings, job.controller.signal);
        if (!current()) return;
        if (job.settings.provider === 'openrouter' && !job.catalog.some(model => model.id === 'openrouter/free')) job.catalog.unshift({ id: 'openrouter/free', name: 'OpenRouter Free', provider: 'openrouter', status: 'unverified', healthy: false, ramUsage: 'Unknown', free: true });
        job.catalog.sort((a,b) => Number(Boolean(b.free))-Number(Boolean(a.free)) || Number(b.id==='openrouter/free')-Number(a.id==='openrouter/free') || a.id.localeCompare(b.id));
        job.status.total = job.catalog.length; job.status.untested = job.catalog.length;
        this.persistVerificationJob(job);
      }
      for (; job.next < job.catalog.length; job.next++) {
        if (!current()) return;
        const model = job.catalog[job.next]; const settings = { ...job.settings, model: model.id };
        job.status.state = 'testing'; job.status.currentModel = model.id; job.status.message = 'Testing models sequentially with a small text request.';
        this.persistVerificationJob(job);
        const probe = !job.force && this.modelVerified(settings) ? undefined : await this.probeModel(settings, Date.now(), job.controller.signal, 128);
        if (!current()) return;
        if (!probe || probe.success) {
          if (probe) this.rememberVerified(settings, 24*60*60_000, probe.latencyMs);
          job.status.passed++;
        } else {
          this.verifiedModels.delete(this.verificationKey(settings));
          const paidOpenRouter = probe.status === 402 && settings.provider === 'openrouter' && !model.free;
          if (probe.category === 'rate_limit') { job.status.state = 'paused'; job.status.retryAt = Date.now()+(probe.retryAfterMs ?? 30_000); job.status.message = probe.message; return; }
          if (['network','timeout','provider'].includes(probe.category || '')) { job.status.state = 'paused'; job.status.message = probe.message; return; }
          if (!paidOpenRouter && !['model','unsupported','response'].includes(probe.category || 'unknown')) { job.status.failed++; job.status.completed++; job.status.untested = job.status.total-job.status.completed; job.status.state = 'error'; job.status.message = probe.status === 402 ? 'The provider rejected this account or key for billing reasons. Check the linked account and project limits.' : probe.message; return; }
          job.status.failed++;
        }
        job.status.completed++; job.status.untested = job.status.total-job.status.completed;
        this.persistVerificationJob({ ...job, next: job.next+1 });
      }
      job.status.state = 'completed'; delete job.status.currentModel; job.status.message = `Verification finished: ${job.status.passed} models passed. Only recent successful tests appear in the model selector.`;
    } catch (error) {
      if (!current()) return;
      job.status.state = 'error'; job.status.message = error instanceof ProviderRequestError ? error.failure.message : 'The model catalog could not be verified. Check provider settings and explicitly retry.';
    } finally { job.promise = undefined; if (this.verificationJobs.get(job.scope) === job) { try { this.persistVerificationJob(job); } catch { job.status.state = 'error'; job.status.message = 'Model verification status could not be saved. Retest explicitly.'; } } }
  }

  async getModels(): Promise<ModelInfo[]> {
    const settings = this.getSettings();
    this.startModelVerification();
    const scope = this.verificationScope(settings);
    const catalog = this.verificationJobs.get(scope)?.catalog || [];
    const results: ModelInfo[] = [];
    for (const [key, record] of this.verifiedModels) {
      if (!key.startsWith(`${scope}|`)) continue;
      if (record.expiresAt <= Date.now()) { this.verifiedModels.delete(key); continue; }
      const metadata = catalog.find(model => model.id === record.model);
      results.push({ ...(metadata || { id: record.model, name: record.model, provider: settings.provider, ramUsage: 'Unknown' }), status: 'ready', healthy: true, verificationExpiresAt: record.expiresAt, lastVerifiedAt: new Date(record.testedAt).toISOString() });
    }
    return results;
  }

  private async getRawModels(): Promise<ModelInfo[]> {
    const settings = this.getSettings();
    const key = `${this.credentialScope(settings)}|${createHash('sha256').update(settings.apiKey).digest('hex')}`;
    const existing = this.modelDiscovery.get(key);
    if (existing) return existing;
    const pending = this.discoverModels(settings).catch(error => {
      if (axios.isAxiosError(error)) throw new Error('Unable to load models. Check your connection, provider endpoint and API key.');
      throw error;
    }).finally(() => this.modelDiscovery.delete(key));
    this.modelDiscovery.set(key, pending);
    return pending;
  }

  private async discoverModels(settings: AISettings, signal?: AbortSignal): Promise<ModelInfo[]> {
    if (!settings.provider) return [];
    if (settings.provider === 'ollama') return (await this.fetchOllamaModels(settings.ollamaUrl)).filter(model => !settings.apiKey || !model.id.includes(settings.apiKey)).map(model => { const verified = this.modelVerified({ ...settings, model: model.id }); return { ...model, status: verified ? 'ready' : 'unverified', healthy: verified }; });
    if (!settings.apiKey && settings.provider !== 'custom') throw new Error('Add an API key and save the connection before loading models.');
    const headers = settings.provider === 'anthropic'
      ? {'x-api-key': settings.apiKey, 'anthropic-version': '2023-06-01'}
      : settings.apiKey ? {Authorization: `Bearer ${settings.apiKey}`} : {};
    const models = new Map<string, ModelInfo>();
    let cursor = '';
    try {
      for (let page = 0; page < 20; page += 1) {
        const response = await this.httpClient.get(`${this.providerBase(settings)}/models`, {
          headers, signal, timeout: 15_000, maxRedirects: 0, maxContentLength: 10 * 1024 * 1024,
          params: settings.provider === 'anthropic' ? {limit: 1000, ...(cursor ? {after_id: cursor} : {})} : undefined,
        });
        if (response.status < 200 || response.status >= 300) { const failure = this.classifyConnectionFailure(settings.model, Date.now(), response.status, response.data, response.headers, undefined, settings.apiKey, settings.provider); throw new ProviderRequestError({ ...failure, message: `Model discovery failed (HTTP ${response.status}). ${failure.message}` }); }
        const entries = settings.provider === 'together' ? response.data : response.data?.data;
        if (!Array.isArray(entries)) throw new Error('The provider returned an invalid model list.');
        for (const model of entries) {
          if (!model || typeof model !== 'object' || typeof model.id !== 'string' || !model.id.trim() || model.id.length > 4096) continue;
          if (!this.chatCapable(model, settings.provider) || settings.apiKey && model.id.includes(settings.apiKey)) continue;
          const label = typeof model.name === 'string' ? model.name : typeof model.display_name === 'string' ? model.display_name : model.id;
          if (settings.apiKey && label.includes(settings.apiKey)) continue;
          const verified = this.modelVerified({ ...settings, model: model.id });
          const pricing = model.pricing;
          const free = settings.provider === 'openrouter' && (model.id === 'openrouter/free' || model.id.endsWith(':free') || pricing && Number(pricing.prompt) === 0 && Number(pricing.completion) === 0);
          models.set(model.id, {id: model.id, name: label.slice(0, 4096), provider: settings.provider, status: verified ? 'ready' : 'unverified', healthy: verified, ramUsage: 'Unknown', ...(free ? { free: true } : {})});
        }
        if (settings.provider !== 'anthropic' || !response.data.has_more) return [...models.values()];
        const next = response.data.last_id;
        if (typeof next !== 'string' || !next || next === cursor) throw new Error('The provider returned an invalid model pagination cursor.');
        cursor = next;
      }
      throw new Error('The provider model list exceeded the pagination limit.');
    } catch (error) {
      if (axios.isAxiosError(error)) throw new Error('Unable to load models. Check your connection, provider endpoint and API key.');
      throw error;
    }
  }

  async getHealth(): Promise<ProviderHealth[]> {
    const settings = this.getSettings();
    if (!settings.provider) return [];
    const started = Date.now();
    try {
      const models = await this.getRawModels();
      return [{provider: settings.provider, status: 'online', message: `Provider returned ${models.length} models.`, latencyMs: Date.now() - started}];
    } catch (error) {
      return [{provider: settings.provider, status: 'offline', message: this.describeError(error)}];
    }
  }

  async chat(messages: AIMessage[], options?: AIOptions): Promise<string> {
    this.pauseVerificationForActivity();
    const settings = await this.resolveAutoSettings();
    const requestId = `chat:${Date.now()}`;
    const controller = new AbortController();
    this.activeRequests.set(requestId, controller);

    try {
      return await this.performChat(messages, options, controller.signal, requestId, settings);
    } catch (error) {
      this.forgetVerified(settings);
      if (axios.isAxiosError(error)) throw new Error(this.describeError(error));
      throw error;
    } finally {
      this.activeRequests.delete(requestId);
    }
  }

  async *stream(messages: AIMessage[], options?: AIOptions, onAgentPreview?: (text: string) => void): AsyncGenerator<string> {
    this.pauseVerificationForActivity();
    const settings = await this.resolveAutoSettings();
    if (!settings.provider || !settings.model.trim() || /^(?:auto|__auto__)$/i.test(settings.model.trim())) throw new Error('Choose a provider and model in Settings.');
    if (!settings.apiKey && !['custom', 'ollama'].includes(settings.provider)) throw new Error('Add your provider API key in Settings.');
    const controller = new AbortController(); const requestId = `stream:${randomUUID()}`;
    this.activeRequests.set(requestId, controller);
    const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? 120_000);
    let responseStream: {destroy(): void} | undefined;
    try {
      const anthropic = settings.provider === 'anthropic'; const ollama = settings.provider === 'ollama';
      const compatible = this.compatibleRequest(settings, messages, options, true);
      const endpoint = anthropic ? 'https://api.anthropic.com/v1/messages' : ollama ? `${this.normalizeBaseUrl(settings.ollamaUrl)}/api/chat` : compatible.endpoint;
      const headers: Record<string, string> = anthropic ? {'x-api-key': settings.apiKey, 'anthropic-version':'2023-06-01'} : compatible.headers;
      if (settings.provider === 'openrouter') {headers['HTTP-Referer']='https://crux.app'; headers['X-Title']='Crux AI';}
      const temperature = options?.temperature ?? settings.temperature; const maxTokens = options?.maxTokens ?? settings.maxTokens;
      const structured = options?.agentStructured ? { tools: anthropic ? [{name:'crux_reply',description:'Return the complete Crux agent reply with validated action requests.',input_schema:CRUX_REPLY_SCHEMA}] : [{type:'function',function:{name:'crux_reply',description:'Return the complete Crux agent reply with validated action requests.',parameters:CRUX_REPLY_SCHEMA}}], ...(anthropic ? {tool_choice:{type:'tool',name:'crux_reply'}} : ollama ? {} : {tool_choice:{type:'function',function:{name:'crux_reply'}}}) } : {};
      const payload = ollama ? {model:settings.model,messages,stream:true,options:{temperature,num_predict:maxTokens},...structured} : anthropic ? {model:settings.model,system:messages.filter(m => m.role === 'system').map(m => m.content).join('\n'),messages:messages.filter(m => m.role !== 'system'),stream:true,temperature,max_tokens:maxTokens,...structured} : compatible.payload;
      const response = await this.httpClient.post(endpoint, payload, {headers, signal:controller.signal, timeout:options?.timeoutMs ?? 120_000, responseType:'stream'});
      responseStream = response.data;
      if ([400,415,422].includes(response.status)) {
        responseStream?.destroy();
        yield await this.performChat(messages, options, controller.signal, requestId, settings); return;
      }
      if (response.status >= 300) {
        let body = ''; for await (const chunk of response.data) { body += chunk.toString('utf8'); if (Buffer.byteLength(body) > 32_768) break; }
        let data: unknown; try { data = JSON.parse(body); } catch { data = undefined; }
        throw new ProviderRequestError(this.classifyConnectionFailure(settings.model, Date.now(), response.status, data, response.headers, undefined, settings.apiKey, settings.provider));
      }
      const contentType = String(response.headers['content-type'] ?? '');
      if (contentType.includes('application/json') && !contentType.includes('ndjson')) {
        let body = ''; for await (const chunk of response.data) {body += chunk.toString('utf8'); if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new Error('Provider response exceeds 2 MiB.');}
        const data = JSON.parse(body); const text = options?.agentStructured ? agentReply(data, ollama ? 'ollama' : anthropic ? 'anthropic' : 'compatible') : ollama ? data.message?.content : anthropic ? data.content?.filter((c: {type:string}) => c.type === 'text').map((c:{text:string}) => c.text).join('') : data.choices?.[0]?.message?.content;
        if (typeof text !== 'string' || !text) throw new Error('Provider returned no text.');
        if (controller.signal.aborted) throw new Error('Run canceled.'); yield text; return;
      }
      if (options?.agentStructured) { const text = await agentStream(response.data, ollama ? 'ndjson' : 'sse', ollama ? 'ollama' : anthropic ? 'anthropic' : 'compatible', onAgentPreview); if (controller.signal.aborted) throw new Error('Run canceled.'); yield text; return; }
      for await (const chunk of providerText(response.data, ollama ? 'ndjson' : 'sse', ollama ? 'ollama' : anthropic ? 'anthropic' : 'compatible')) {
        if (controller.signal.aborted) throw new Error('Run canceled.'); yield chunk;
      }
    } catch (error) {
      this.forgetVerified(settings);
      if (controller.signal.aborted) throw new Error('Run canceled or provider timed out.');
      if (axios.isAxiosError(error)) throw new Error(this.describeError(error));
      throw error;
    } finally {clearTimeout(timer); responseStream?.destroy(); this.activeRequests.delete(requestId);}
  }

  async chatStreaming(messages: AIMessage[], options: AIOptions | undefined, onText: (text: string) => void): Promise<string> {
    let text = '';
    for await (const chunk of this.stream(messages, options, options?.agentStructured ? onText : undefined)) {text += chunk; if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Model output exceeds 1 MiB.'); onText(text);}
    if (!text) throw new Error('Provider returned an empty response.');
    return text;
  }

  abortStream(): void {
    this.autoPending?.controller.abort();
    for (const controller of this.activeRequests.values()) {
      controller.abort();
    }
    this.activeRequests.clear();
  }

  private async performChat(
    messages: AIMessage[],
    options: AIOptions | undefined,
    signal: AbortSignal,
    requestId: string,
    capturedSettings?: AISettings,
  ): Promise<string> {
    const settings = capturedSettings ?? this.getSettings();
    if (!settings.provider || !settings.model.trim() || /^(?:auto|__auto__)$/i.test(settings.model.trim())) throw new Error('Choose a provider and an available model in Settings before chatting.');
    const effectiveTimeout = options?.timeoutMs ?? 120_000;
    const timeout = setTimeout(() => {
      if (!signal.aborted) {
        log.warn(`AI request timed out after ${effectiveTimeout}ms`, requestId);
      }
    }, effectiveTimeout);

    try {
      switch (settings.provider) {
        case 'ollama':
          return await this.chatWithOllama(messages, settings, options, signal);
        case 'anthropic':
          return await this.chatWithAnthropic(messages, settings, options, signal);
        case 'openrouter':
        case 'openai':
        case 'custom':
        case 'gemini':
        case 'groq':
        case 'deepseek':
        case 'mistral':
        case 'xai':
        case 'together':
          return await this.chatWithOpenAICompatible(messages, settings, options, signal);
        default:
          throw new Error(`Unsupported provider: ${String(settings.provider)}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private async chatWithOllama(
    messages: AIMessage[],
    settings: AISettings,
    options: AIOptions | undefined,
    signal: AbortSignal,
  ): Promise<string> {
    await this.ensureOllamaModelReady(settings);
    const response = await this.requestOllamaChat(settings, settings.model, messages, options, signal);

    if (response.status >= 400) {
      throw new Error(this.extractProviderError(response.data, 'Ollama request failed'));
    }
    if (options?.agentStructured) return agentReply(response.data, 'ollama');

    const content = response.data?.message?.content;
    if (!content) {
      throw new Error('Ollama returned an empty response.');
    }

    return content;
  }

  private requestOllamaChat(
    settings: AISettings,
    modelId: string,
    messages: AIMessage[],
    options: AIOptions | undefined,
    signal: AbortSignal,
  ) {
    const endpoint = `${this.normalizeBaseUrl(settings.ollamaUrl)}/api/chat`;
    return this.httpClient.post(
      endpoint,
      {
        model: modelId,
        messages,
        stream: false,
        ...(options?.agentStructured ? {tools:[{type:'function',function:{name:'crux_reply',description:'Return the complete Crux agent reply.',parameters:CRUX_REPLY_SCHEMA}}]} : {}),
        options: {
          temperature: options?.temperature ?? settings.temperature,
          num_predict: options?.maxTokens ?? settings.maxTokens,
        },
      },
      { signal, timeout: options?.timeoutMs ?? 120_000 },
    );
  }

  private async chatWithOpenAICompatible(
    messages: AIMessage[],
    settings: AISettings,
    options: AIOptions | undefined,
    signal: AbortSignal,
  ): Promise<string> {
    if (!settings.apiKey && settings.provider !== 'custom') {
      throw new Error(`No API key configured for ${settings.provider}. Update it in Settings.`);
    }

    const request = this.compatibleRequest(settings, messages, options, false);
    const response = await this.httpClient.post(request.endpoint, request.payload, {
      signal, timeout: options?.timeoutMs ?? 120_000, headers: request.headers,
    });

    if (response.status >= 400) {
      throw new ProviderRequestError(this.classifyConnectionFailure(settings.model, Date.now(), response.status, response.data, response.headers, undefined, settings.apiKey, settings.provider));
    }

    const content = response.data?.choices?.[0]?.message?.content;
    if (options?.agentStructured) return agentReply(response.data, 'compatible');
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('Provider returned an empty response.');
    }

    return content;
  }

  private async chatWithAnthropic(
    messages: AIMessage[],
    settings: AISettings,
    options: AIOptions | undefined,
    signal: AbortSignal,
  ): Promise<string> {
    if (!settings.apiKey) {
      throw new Error('No API key configured for Anthropic. Update it in Settings.');
    }

    const systemMessage = messages.find((message) => message.role === 'system')?.content;
    const anthropicMessages = messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role,
        content: message.content,
      }));

    const response = await this.httpClient.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: settings.model,
        system: systemMessage,
        max_tokens: options?.maxTokens ?? settings.maxTokens,
        temperature: options?.temperature ?? settings.temperature,
        messages: anthropicMessages,
        ...(options?.agentStructured ? {tools:[{name:'crux_reply',description:'Return the complete Crux agent reply.',input_schema:CRUX_REPLY_SCHEMA}],tool_choice:{type:'tool',name:'crux_reply'}} : {}),
      },
      {
        signal,
        timeout: options?.timeoutMs ?? 120_000,
        headers: {
          'x-api-key': settings.apiKey,
          'anthropic-version': '2023-06-01',
        },
      },
    );

    if (response.status >= 400) {
      throw new ProviderRequestError(this.classifyConnectionFailure(settings.model, Date.now(), response.status, response.data, response.headers, undefined, settings.apiKey, settings.provider));
    }

    const content = response.data?.content?.[0]?.text;
    if (options?.agentStructured) return agentReply(response.data, 'anthropic');
    if (!content) {
      throw new Error('Anthropic returned an empty response.');
    }

    return content;
  }

  private async fetchOllamaModels(baseUrl: string): Promise<ModelInfo[]> {
    const endpoint = `${this.normalizeBaseUrl(baseUrl)}/api/tags`;
    const startedAt = Date.now();
    const response = await this.httpClient.get(endpoint, { timeout: 7_000 });
    const latency = Date.now() - startedAt;

    if (response.status >= 400) {
      throw new Error(this.extractProviderError(response.data, 'Unable to load Ollama models.'));
    }

    if (!Array.isArray(response.data?.models)) throw new Error('Ollama returned an invalid model list.');
    const rawModels = response.data.models.filter((model: unknown) => model && typeof model === 'object' && typeof (model as Record<string, unknown>).name === 'string' && ((model as Record<string, unknown>).name as string).trim());
    return rawModels.map((model: Record<string, unknown>) => ({
      id: String(model.name).slice(0, 4096),
      name: String(model.name).slice(0, 4096),
      provider: 'ollama' as const,
      status: 'ready' as const,
      healthy: true,
      size: typeof model.size === 'number' ? model.size : undefined,
      modifiedAt: typeof model.modified_at === 'string' ? model.modified_at : undefined,
      ramUsage: this.describeModelFootprint(typeof model.size === 'number' ? model.size : undefined),
      details: `Detected from Ollama in ${latency}ms`,
    }));
  }

  private compatibleRequest(settings: AISettings, messages: AIMessage[], options: AIOptions | undefined, stream: boolean) {
    const headers: Record<string, string> = settings.apiKey ? {Authorization: `Bearer ${settings.apiKey}`} : {};
    if (settings.provider === 'openrouter') { headers['HTTP-Referer'] = 'https://crux.app'; headers['X-Title'] = 'Crux AI'; }
    const reasoning = settings.provider === 'openai' && /^(o[1-9](?:-|$)|gpt-[5-9](?:[.-]|$))/.test(settings.model);
    const payload = {model: settings.model, messages, stream,
      ...(options?.agentStructured ? {tools:[{type:'function',function:{name:'crux_reply',description:'Return the complete Crux agent reply with canonical action requests.',parameters:CRUX_REPLY_SCHEMA}}],tool_choice:{type:'function',function:{name:'crux_reply'}}} : {}),
      ...(!reasoning ? {temperature: options?.temperature ?? settings.temperature} : {}),
      ...(settings.provider === 'openai' ? {max_completion_tokens: options?.maxTokens ?? settings.maxTokens} : {max_tokens: options?.maxTokens ?? settings.maxTokens})};
    return {endpoint: this.getOpenAICompatibleEndpoint(settings), headers, payload};
  }

  private getOpenAICompatibleEndpoint(settings: AISettings): string {
    return `${this.providerBase(settings)}/chat/completions`;
  }

  private normalizeBaseUrl(url: string): string {
    return url.replace(/\/+$/, '');
  }

  private describeModelFootprint(size?: number): string {
    if (!size) {
      return 'Unknown';
    }

    const sizeInGb = size / (1024 * 1024 * 1024);
    if (sizeInGb >= 12) {
      return 'Very high';
    }
    if (sizeInGb >= 7) {
      return 'High';
    }
    if (sizeInGb >= 3) {
      return 'Medium';
    }
    return 'Light';
  }

  private async ensureOllamaModelReady(settings: AISettings): Promise<void> {
    const modelId = settings.model.trim();
    const baseUrl = this.normalizeBaseUrl(settings.ollamaUrl);
    const key = `${baseUrl}|${modelId}`;

    const existing = this.modelPreparation.get(key);
    if (existing) {
      await existing;
      return;
    }

    const task = this.prepareOllamaModel(baseUrl, modelId)
      .finally(() => {
        this.modelPreparation.delete(key);
      });

    this.modelPreparation.set(key, task);
    await task;
  }

  private async prepareOllamaModel(baseUrl: string, modelId: string): Promise<void> {
    const runtime = await this.getOllamaRuntimeStatus(baseUrl);
    if (!runtime.installed) {
      throw new Error('Ollama is not installed. Install Ollama and reopen CruX.');
    }

    if (!runtime.running) {
      throw new Error('Ollama is installed but not running. Start Ollama and retry.');
    }

    if (runtime.models.includes(modelId)) {
      return;
    }

    throw new Error(`Model "${modelId}" is not installed. Install it explicitly in Ollama, then retry. Crux AI does not install models during chat.`);
  }

  private async getOllamaRuntimeStatus(baseUrl: string): Promise<{
    installed: boolean;
    running: boolean;
    models: string[];
    message: string;
    latencyMs?: number;
  }> {
    const startedAt = Date.now();

    try {
      const models = await this.fetchOllamaModels(baseUrl);
      return {
        installed: true,
        running: true,
        models: models.map((model) => model.id),
        message: 'Local Ollama service is reachable.',
        latencyMs: Date.now() - startedAt,
      };
    } catch {
      const installed = await this.detectOllamaInstallation();
      return {
        installed,
        running: false,
        models: [],
        message: installed
          ? 'Ollama is installed but the service is not reachable.'
          : 'Ollama is not installed on this machine.',
      };
    }
  }

  private async detectOllamaInstallation(): Promise<boolean> {
    const candidates: string[] = ['ollama'];

    if (process.platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA;
      if (localAppData) {
        candidates.push(`${localAppData}\\Programs\\Ollama\\ollama.exe`);
      }
    }

    for (const candidate of candidates) {
      try {
        await execFileAsync(candidate, ['--version'], { windowsHide: true, timeout: 4_000 });
        return true;
      } catch {
        continue;
      }
    }

    return false;
  }

  private extractProviderError(_data: unknown, fallback: string): string {
    return fallback;
  }


  private describeError(error: unknown): string {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError<Record<string, unknown>>;
      if (axiosError.code === 'ECONNABORTED') {
        return 'The provider request timed out after 120 seconds.';
      }
      if (axiosError.code === 'ECONNREFUSED') {
        return 'Unable to connect to the selected provider. Check that the service is running.';
      }
      if (axiosError.code === 'ERR_CANCELED') {
        return 'The request was canceled.';
      }
      if (axiosError.response?.data) {
        return this.extractProviderError(axiosError.response.data, 'The provider rejected the request. Check your model, API credentials and account quota.');
      }
      return 'Unable to reach the selected provider. Check your endpoint and network connection.';
    }

    if (error instanceof Error) {
      return error.message;
    }

    return 'An unknown provider error occurred.';
  }
}
