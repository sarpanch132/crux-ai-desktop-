import { useEffect, useRef, useState } from 'react';
import { useStore } from '../hooks/useStore';
import type { AgentSnapshot, Capability } from '../../../electron/services/agent/contracts';
const capabilities: Capability[] = ['read', 'write', 'delete', 'execute', 'gitRead', 'gitMutate', 'installDependencies', 'browser', 'computerControl'];
export function AgentPanel({ approvalsOnly = false }: { approvalsOnly?: boolean }) {
  const store = useStore();
  const id = store.activeConversationId;
  const snapshot = id ? store.agentSnapshots[id] : undefined;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [paths, setPaths] = useState('');
  const [webUrl, setWebUrl] = useState('');
  const [webResult, setWebResult] = useState<{title: string; text: string; links: Array<{text?: string; href?: string; url?: string}>} | null>(null);
  const scope = `${id}:${store.projectPath}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  useEffect(() => {setPaths(''); setWebUrl(''); setWebResult(null); setError('');}, [scope]);
  const act = async (operation: () => Promise<{success: boolean; data?: unknown; error?: string}>) => {
    setBusy(true); setError('');
    try { const result = await operation(); if (!result.success) throw new Error(result.error ?? 'Action failed.');
      if (result.data && typeof result.data === 'object' && 'state' in result.data) store.syncAgent(result.data as AgentSnapshot);
      return result.data;
    } catch (reason) {setError(reason instanceof Error ? reason.message : String(reason));} finally {setBusy(false);}
  };
  if (!id || !snapshot) return <section className="agent-section">Open a chat to connect its agent session.</section>;
  return <div className="agent-panel">
    {error && <p role="alert" className="agent-error">{error}</p>}
    {snapshot.approvals.map((request) => <section key={request.id} className="agent-section approval-request">
      <h3>Permission requested</h3><p>{request.tool}: {request.target}</p><p>{request.reason}</p>
      <div className="agent-actions"><button onClick={() => void act(() => window.electron.agent.approve(id, request.id, 'once'))}>Allow once</button>
      {request.allowSession && <button onClick={() => void act(() => window.electron.agent.approve(id, request.id, 'session'))}>Allow this session</button>}
      <button onClick={() => void act(() => window.electron.agent.approve(id, request.id, 'deny'))}>Deny</button></div>
    </section>)}
    {!approvalsOnly && <><section className="agent-section"><h3>Development workflow</h3><p className="agent-status">{snapshot.state.status.replaceAll('_', ' ')}</p>
      <p>{snapshot.state.objective || 'Send an objective to begin.'}</p>{snapshot.state.blockedReason && <p role="alert">{snapshot.state.blockedReason}</p>}
      {snapshot.state.plan && <><h4>Plan</h4><p>{snapshot.state.plan.summary}</p><p>{snapshot.state.plan.architecture}</p><ol>{snapshot.state.plan.tasks.map((task, index) => <li key={index}>{task}</li>)}</ol><h4>Risks</h4><ul>{snapshot.state.plan.risks.map((risk, index) => <li key={index}>{risk}</li>)}</ul></>}
      <h4>Acceptance criteria</h4><ul>{snapshot.state.acceptanceCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul>
      {!snapshot.state.acceptanceCriteria.length && <p>No criteria established yet.</p>}
      {snapshot.state.errors.map((item, index) => <p className="agent-error" key={index}>{item.stage}: {item.message}</p>)}
    </section>
    <details className="agent-section"><summary>Access customization</summary><p>{snapshot.permissions.sandboxAvailable ? 'Execution isolation available.' : 'Execution isolation unavailable; commands remain approval-controlled.'}</p>
      {capabilities.map((capability) => <label key={capability} className="capability-row"><input type="checkbox" disabled={busy || snapshot.state.running || capability === 'computerControl'} checked={snapshot.permissions.capabilities[capability]} onChange={(event) => void act(() => window.electron.agent.configure(id, {[capability]: event.target.checked}, snapshot.permissions.allowedPaths))}/>{capability}{capability === 'computerControl' && ' — unavailable'}</label>)}
      <p>Current folder grants: {snapshot.permissions.allowedPaths.join(', ') || 'Project only'}</p>
      <label>Folder grants, one path per line<textarea value={paths} onChange={(event) => setPaths(event.target.value)} /></label>
      <button disabled={busy || snapshot.state.running} onClick={() => void act(() => window.electron.agent.configure(id, {}, paths.split('\n').map((path) => path.trim()).filter(Boolean)))}>Replace folder grants</button>
    </details>
    {!!snapshot.state.activeSkills.length && <details className="agent-section"><summary>Active skills</summary>{snapshot.state.activeSkills.map(skill => <div key={skill.id}><h4>{skill.name}</h4><p>{skill.description}</p></div>)}</details>}    <details className="agent-section"><summary>Web inspection</summary>
      <p>Inspect page text and links in an isolated temporary browser. Interactive browsing is unavailable.</p>
      {snapshot.state.mode === 'plan' ? <p>Plan mode is limited to repository inspection.</p> : !snapshot.permissions.capabilities.browser ? <p>Enable browser access in Access customization to inspect a page.</p> : null}
      <label>Page URL<input type="url" placeholder="https://example.com" value={webUrl} onChange={(event) => setWebUrl(event.target.value)}/></label>
      <button disabled={busy || !webUrl.trim() || snapshot.state.running || snapshot.state.mode === 'plan' || !snapshot.permissions.capabilities.browser} onClick={() => {
        const requestedScope = scope;
        setWebResult(null);
        void act(() => window.electron.agent.execute(id, {tool: 'browser', url: webUrl.trim()})).then((data) => {
          if (scopeRef.current !== requestedScope || !data || typeof data !== 'object') return;
          const page = data as {title?: unknown; text?: unknown; links?: unknown};
          setWebResult({title: typeof page.title === 'string' ? page.title : '', text: typeof page.text === 'string' ? page.text : '', links: Array.isArray(page.links) ? page.links : []});
        });
      }}>Inspect page</button>
      {webResult && <><h4>{webResult.title || 'Page inspection'}</h4><pre>{webResult.text}</pre><h4>Links</h4>{webResult.links.map((link, index) => <p key={index}>{String(link.text ?? '')} � {String(link.href ?? link.url ?? '')}</p>)}</>}
    </details>

    </>}
  </div>;
}
