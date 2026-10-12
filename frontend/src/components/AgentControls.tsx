import { useStore } from '../hooks/useStore';
import type { AgentMode, AccessLevel } from '../../../electron/services/agent/contracts';
export function AgentControls() {
  const store = useStore();
  const snapshot = store.activeConversationId ? store.agentSnapshots[store.activeConversationId] : undefined;
  return <div className="agent-controls">
    <select aria-label="Agent mode" title="Agent mode" value={snapshot?.state.mode ?? 'plan'} disabled={store.isGenerating || !snapshot} onChange={(event) => void store.setAgentMode(event.target.value as AgentMode)}><option value="plan">Plan</option><option value="code">Code</option><option value="debug">Debug</option></select>
    <select aria-label="Agent access level" title="Agent access level" value={snapshot?.permissions.level ?? 'medium'} disabled={store.isGenerating || !snapshot} onChange={(event) => void store.setAgentAccess(event.target.value as AccessLevel)}><option value="restricted">Restricted access</option><option value="medium">Medium access</option><option value="full">Full access</option></select>
    {store.agentError && <p className="agent-error" role="alert">{store.agentError}</p>}
  </div>;
}
