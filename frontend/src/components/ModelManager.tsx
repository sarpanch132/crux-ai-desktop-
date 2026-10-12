import { ModelSelector } from './ModelSelector';
import { useStore } from '../hooks/useStore';

export function ModelManager() {
  const {models, providerHealth, settings, modelsLoading} = useStore();
  return <section className="settings-form-section">
    <p className="eyebrow">03 / MODELS</p><h2>Available models</h2>
    <p className="section-description">Fetched from your saved provider. Your selection also appears beside chat.</p>
    <ModelSelector/>
    {!modelsLoading && <p className="mt-5 text-sm text-muted-foreground">{models.length} models returned by {settings?.provider || 'your provider'}.</p>}
    {providerHealth.map((health) => <p key={health.provider} className="mt-3 text-sm text-muted-foreground">{health.message}</p>)}
  </section>;
}
