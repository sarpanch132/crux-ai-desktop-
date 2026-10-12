import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, FileCode2, Files, FlaskConical, Folder, GitCompareArrows, Loader2, PanelRightClose, RefreshCw, Search, TerminalSquare, X } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import hljs from 'highlight.js';
import { toast } from 'sonner';
import { useStore } from '../hooks/useStore';
import { AgentPanel } from './AgentPanel';
const TerminalPanel = lazy(() => import('./TerminalPanel').then(module => ({default:module.TerminalPanel})));
const MonacoPane = lazy(() => import('./MonacoPane').then(module => ({default:module.MonacoPane})));
import type { ChangeDetail, ToolRequest, TrackedChange } from '../../../electron/services/agent/contracts';
const tabs = [{ id: 'files', label: 'Files', icon: Files }, { id: 'search', label: 'Search', icon: Search }, { id: 'changes', label: 'Changes', icon: GitCompareArrows }, { id: 'problems', label: 'Problems', icon: AlertTriangle }, { id: 'tests', label: 'Tests', icon: FlaskConical }, { id: 'activity', label: 'Activity', icon: Activity }] as const;
interface OpenFile {
    path: string;
    original: string;
    content: string;
    hash: string;
    line?: number;
}
async function hash(content: string) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))), byte => byte.toString(16).padStart(2, '0')).join(''); }
function CodeText({ content, line }: {
    content: string;
    line?: number;
}) {
    const viewport = useRef<HTMLDivElement>(null);
    const displayed = content.slice(0, 256000);
    const highlighted = useMemo(() => hljs.highlightAuto(displayed).value, [displayed]);
    useEffect(() => { if (viewport.current && line)
        viewport.current.scrollTop = Math.max(0, (line - 3) * 19.2); }, [content, line]);
    return <><div ref={viewport} className="workspace-code"><pre aria-hidden="true" className="code-lines">{displayed.split('\n').map((_, i) => i + 1).join('\n')}</pre><pre><code dangerouslySetInnerHTML={{ __html: highlighted }}/></pre></div>{displayed.length < content.length && <p className="workspace-empty">Preview limited to 256,000 characters. Edit mode contains the full file.</p>}</>;
}
function DiffText({ before, after }: {
    before: string | null;
    after: string | null;
}) {
    const oldLines = before?.split('\n') ?? [];
    const newLines = after?.split('\n') ?? [];
    let start = 0;
    while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start])
        start++;
    let end = 0;
    while (end < oldLines.length - start && end < newLines.length - start && oldLines[oldLines.length - 1 - end] === newLines[newLines.length - 1 - end])
        end++;
    if (start === oldLines.length && start === newLines.length)
        return <p className="workspace-empty">No text differences.</p>;
    return <pre className="workspace-unified-diff"><span className="diff-location">@@ line {start + 1} @@</span>{oldLines.slice(Math.max(0, start - 3), start).map((line, i) => <span key={`context-${i}`}>  {line}</span>)}{oldLines.slice(start, oldLines.length - end).map((line, i) => <span className="diff-removed" key={`old-${i}`}>− {line}</span>)}{newLines.slice(start, newLines.length - end).map((line, i) => <span className="diff-added" key={`new-${i}`}>+ {line}</span>)}{newLines.slice(newLines.length - end, newLines.length - end + 3).map((line, i) => <span key={`end-${i}`}>  {line}</span>)}</pre>;
}
function Directory({ path, execute, open, changed }: {
    path: string;
    execute: (request: ToolRequest) => Promise<unknown>;
    open: (path: string) => void;
    changed: Set<string>;
}) {
    const [nodes, setNodes] = useState<FileInfo[]>([]);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [error, setError] = useState('');
    useEffect(() => { let live = true; void execute({ tool: 'list', path, recursive: false }).then(data => { if (live && Array.isArray(data))
        setNodes(data); }).catch(reason => { if (live)
        setError(String(reason)); }); return () => { live = false; }; }, [path, execute]);
    return <div className="workspace-tree">{error && <p role="alert">{error}</p>}{nodes.map(node => <div key={node.path}><button className="workspace-file-row" onClick={() => node.type === 'directory' ? setExpanded(current => { const next = new Set(current); if (next.has(node.path))
        next.delete(node.path);
    else
        next.add(node.path); return next; }) : open(node.path)} aria-expanded={node.type === 'directory' ? expanded.has(node.path) : undefined}>{node.type === 'directory' ? <>{expanded.has(node.path) ? <ChevronDown /> : <ChevronRight />}<Folder /></> : <FileCode2 />}<span>{node.name}</span>{changed.has(node.path) && <span className="modified-mark" title="Agent modified">M</span>}</button>{expanded.has(node.path) && <div className="tree-children"><Directory path={node.path} execute={execute} open={open} changed={changed}/></div>}</div>)}{!nodes.length && !error && <p className="workspace-empty">No visible files.</p>}</div>;
}
export function CodingWorkspace() {
    const store = useStore();
    const id = store.activeConversationId;
    const snapshot = id ? store.agentSnapshots[id] : undefined;
    const scope = `${id}:${store.projectPath}`;
    const scopeRef = useRef(scope);
    scopeRef.current = scope;
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [opened, setOpened] = useState<OpenFile[]>([]);
    const [activePath, setActivePath] = useState('');
    const [editing, setEditing] = useState(false);
    const [query, setQuery] = useState('');
    const [searchKind, setSearchKind] = useState<'search' | 'file_search' | 'symbol_search' | 'find_references'>('search');
    const [results, setResults] = useState<Array<{
        file: string;
        line?: number;
        content?: string;
    }>>([]);
    const [changes, setChanges] = useState<TrackedChange[]>([]);
    const [detail, setDetail] = useState<ChangeDetail | null>(null);
    const [diffTab, setDiffTab] = useState<'diff' | 'before' | 'after'>('diff');
    const [treeRevision, setTreeRevision] = useState(0);
    const execute = useCallback(async (request: ToolRequest) => { if (!id)
        throw new Error('Open a workspace session first.'); const requestedScope = scope; const result = await window.electron.agent.execute(id, request); if (scopeRef.current !== requestedScope)
        throw new Error('Workspace changed; result discarded.'); if (!result.success)
        throw new Error(result.error ?? 'Action failed.'); return result.data; }, [id, scope]);
    const act = async (operation: () => Promise<void>) => { setBusy(true); setError(''); try {
        await operation();
    }
    catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
    }
    finally {
        setBusy(false);
    } };
    useEffect(() => { setOpened([]); setActivePath(''); setEditing(false); setError(''); setResults([]); setChanges([]); setDetail(null); }, [scope]);
    useEffect(() => { if (!id || !store.projectPath)
        return; let live = true; void execute({ tool: 'changes' }).then(data => { if (live && Array.isArray(data))
        setChanges(data); }).catch(() => undefined); return () => { live = false; }; }, [execute, id, store.projectPath, snapshot?.state.revision]);
    const open = async (path: string, line?: number) => { await act(async () => { const existing = opened.find(file => file.path === path); if (existing) {
        setOpened(current => current.map(item => item.path === path ? { ...item, line } : item));
        setActivePath(path);
        setEditing(false);
        store.setRightPanelTab('files');
        return;
    } const content = await execute({ tool: 'read', path }); if (typeof content !== 'string')
        throw new Error('File did not return text.'); const digest = await hash(content); if (scopeRef.current !== scope)
        return; setOpened(current => [...current, { path, original: content, content, hash: digest, line }]); setActivePath(path); setEditing(false); store.setRightPanelTab('files'); }); };
    const file = opened.find(item => item.path === activePath);
    const tab = tabs.some(item => item.id === store.rightPanelTab) ? store.rightPanelTab : 'files';
    const changed = new Set(snapshot?.state.changedFiles.map(item => item.path));
    const changeAction = async (tool: 'accept' | 'revert') => act(async () => { if (!detail)
        return; await execute({ tool, changeId: detail.id }); const records = await execute({ tool: 'changes' }); if (Array.isArray(records))
        setChanges(records); toast.success(tool === 'revert' ? 'Change reverted.' : 'Change reviewed.'); setDetail(null); setTreeRevision(value => value + 1); if (tool === 'revert') {
        setOpened(current => current.filter(item => item.path !== detail.path));
    } });
    return <div className="coding-workspace"><header className="workspace-panel-heading"><div><h2>Workspace details</h2><p title={store.projectPath ?? ''}>{store.projectPath?.split(/[\\/]/).pop() ?? 'No project open'}</p></div><button className="panel-icon-button" aria-label="Close workspace details" onClick={() => store.setRightPanelOpen(false)}><PanelRightClose className="h-4 w-4"/></button></header>
    <div className="workspace-tabs" role="tablist" aria-label="Workspace views">{tabs.map(({ id: tabId, label, icon: Icon }, index) => <button key={tabId} role="tab" aria-selected={tab === tabId} aria-controls={`workspace-${tabId}`} tabIndex={tab === tabId ? 0 : -1} onKeyDown={event => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        const next = (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
        store.setRightPanelTab(tabs[next].id);
        (event.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();
    } }} onClick={() => store.setRightPanelTab(tabId)}><Icon aria-hidden="true"/><span>{label}</span>{tabId === 'problems' && !!snapshot?.state.problems?.length && <small>{snapshot.state.problems.length}</small>}</button>)}</div>
    {error && <p className="workspace-inline-error" role="alert">{error}</p>}{busy && <p className="workspace-working" role="status"><Loader2 className="animate-spin"/>Working…</p>}
    <div className="workspace-tab-body" role="tabpanel" id={`workspace-${tab}`}>
      {!store.projectPath && <p className="workspace-empty">Choose a project to inspect files, review changes, and run checks.</p>}
      {tab === 'files' && store.projectPath && <><div className="workspace-section-heading"><span>Project files</span><button className="panel-icon-button" aria-label="Refresh files" onClick={() => setTreeRevision(value => value + 1)}><RefreshCw className="h-4 w-4"/></button></div><div className="explorer-scroll"><Directory key={`${scope}:${treeRevision}`} path={store.projectPath} execute={execute} open={path => void open(path)} changed={changed}/></div>{opened.length > 0 && <><div className="open-file-tabs">{opened.map(item => <div key={item.path} className={activePath === item.path ? 'active' : ''}><button onClick={() => { setActivePath(item.path); setEditing(false); }}>{item.path.split(/[\\/]/).pop()}{item.content !== item.original ? ' •' : ''}</button><button aria-label={`Close ${item.path.split(/[\\/]/).pop()}`} disabled={item.content !== item.original} onClick={() => { setOpened(current => current.filter(entry => entry.path !== item.path)); if (activePath === item.path)
        setActivePath(opened.find(entry => entry.path !== item.path)?.path ?? ''); }}><X className="h-3 w-3"/></button></div>)}</div>{file && <div className="file-inspector"><p className="file-path" title={file.path}>{file.path}{file.line ? ` · line ${file.line}` : ''}</p><div className="workspace-toolbar"><button aria-pressed={editing} onClick={() => setEditing(!editing)}>{editing ? 'Read mode' : 'Edit file'}</button>{file.content !== file.original && <><button onClick={() => setOpened(current => current.map(item => item.path === file.path ? { ...item, content: item.original } : item))}>Discard edits</button><button disabled={busy || snapshot?.state.running || snapshot?.state.mode === 'plan'} onClick={() => void act(async () => { await execute({ tool: 'edit', path: file.path, search: file.original, replacement: file.content, expectedHash: file.hash }); const digest = await hash(file.content); setOpened(current => current.map(item => item.path === file.path ? { ...item, original: file.content, hash: digest } : item)); toast.success('File saved.'); })}>Save changes</button></>}</div>{editing ? <Suspense fallback={<p role="status">Loading editor…</p>}><MonacoPane path={file.path} value={file.content} readOnly={false} line={file.line} diagnostics={snapshot?.state.problems} onChange={content => setOpened(current => current.map(item => item.path === file.path ? {...item,content} : item))}/></Suspense> : <Suspense fallback={<CodeText content={file.content} line={file.line}/>}><MonacoPane path={file.path} value={file.content} line={file.line} diagnostics={snapshot?.state.problems}/></Suspense>}</div>}</>}</>}
      {tab === 'search' && store.projectPath && <><form className="workspace-search" onSubmit={event => { event.preventDefault(); void act(async () => { const data = await execute({ tool: searchKind, pattern: query }); const matches = Array.isArray(data) ? data : data && typeof data === 'object' && 'matches' in data && Array.isArray(data.matches) ? data.matches : []; setResults(matches.map(item => typeof item === 'string' ? { file: item } : { ...item, file: item.file ?? item.path, content: item.content ?? item.name })); }); }}><label htmlFor="workspace-search-kind">Search repository</label><select id="workspace-search-kind" value={searchKind} onChange={event => setSearchKind(event.target.value as typeof searchKind)}><option value="search">Code text</option><option value="file_search">File names</option><option value="symbol_search">Symbol declarations</option><option value="find_references">Token references</option></select><input aria-label="Repository search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find relevant code…"/><button disabled={busy || !query.trim()}>Search</button></form><p className="workspace-empty">Symbol and reference searches use lexical matching.</p>{results.map((result, index) => <button className="workspace-search-result" key={index} onClick={() => void open(result.file, result.line)}><strong>{result.file}{result.line ? `:${result.line}` : ''}</strong><code>{result.content}</code></button>)}</>}
      {tab === 'changes' && <><p className="workspace-empty">Review agent edits. Revert checks the current file before restoring its checkpoint.</p>{changes.map(change => <button className="workspace-change-row" key={change.id} onClick={() => void act(async () => { const data = await execute({ tool: 'changes', changeId: change.id }); setDetail(data as ChangeDetail); })}><GitCompareArrows /><span>{change.path}</span><small>{change.reviewed ? 'Reviewed' : change.operation}</small></button>)}{!changes.length && <p className="workspace-empty">No tracked changes.</p>}{detail && <><p className="file-path">{detail.path}</p><div className="workspace-toolbar">{(['diff', 'before', 'after'] as const).map(value => <button key={value} aria-pressed={diffTab === value} onClick={() => setDiffTab(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}<button disabled={busy || snapshot?.state.running} onClick={() => void changeAction('accept')}>Accept</button><button disabled={busy || snapshot?.state.running || snapshot?.state.mode === 'plan'} onClick={() => void changeAction('revert')}>Revert</button></div>{diffTab === 'diff' ? <Suspense fallback={<DiffText before={detail.before} after={detail.after}/>}><MonacoPane path={detail.path} value={detail.after??''} before={detail.before??''}/></Suspense> : <Suspense fallback={<p role="status">Loading code…</p>}><MonacoPane path={detail.path} value={(diffTab === 'before' ? detail.before : detail.after) ?? ''}/></Suspense>}</>}</>}
      {tab === 'problems' && <>{snapshot?.state.problems?.map((problem, index) => <button key={index} className="workspace-problem" disabled={!problem.file} onClick={() => problem.file && void open(problem.file, problem.line)}><AlertTriangle /><div><strong>{problem.file ? `${problem.file}:${problem.line ?? 1}` : problem.source}</strong><p>{problem.code} {problem.message}</p><small>{problem.command}</small></div></button>)}{!snapshot?.state.problems?.length && <p className="workspace-empty">No parsed problems. Run a check to collect diagnostics.</p>}</>}
      {tab === 'tests' && <><div className="workspace-toolbar">{(['test','lint','typecheck','build'] as const).map(kind=><button key={kind} disabled={busy||snapshot?.state.running||snapshot?.state.mode==='plan'||!snapshot?.state.repoContext.metadata?.scripts[kind]} title={!snapshot?.state.repoContext.metadata?.scripts[kind]?`No ${kind} script detected`:snapshot?.state.mode==='plan'?'Switch to Code or Debug to run checks':`Run detected ${kind} script through the permission gateway`} onClick={()=>void act(async()=>{await execute({tool:'check',checkKind:kind});})}>Run {kind==='test'?'tests':kind}</button>)}</div><p className="workspace-empty">Checks below come from real command execution.</p>{snapshot?.state.testResults.map((result, index) => <details className="workspace-test" key={index}><summary>{result.passed ? <CheckCircle2 /> : <AlertTriangle />}<span>{result.passed ? 'Passed' : 'Failed'} · {result.command}</span></summary><p>Exit {result.exitCode ?? 'unknown'} · {new Date(result.timestamp).toLocaleTimeString()}</p><pre>{result.output}</pre>{!result.passed && <div className="workspace-toolbar"><button disabled={store.isGenerating} onClick={() => void act(async () => { await store.setAgentMode('plan'); await store.sendMessage(`Investigate the failing check without changing code: ${result.command}. Inspect its actual errors and explain the root cause.`); })}>Investigate</button><button disabled={store.isGenerating} onClick={() => void act(async () => { await store.setAgentMode('debug'); await store.sendMessage(`Investigate and fix the failing check: ${result.command}; rerun it and verify regression checks.`); })}>Fix &amp; Retest</button></div>}</details>)}{!snapshot?.state.testResults.length && <p className="workspace-empty">No checks have run.</p>}</>}
      {tab === 'activity' && <><details className="agent-section"><summary>Execution limits</summary><label className="capability-row"><input type="checkbox" checked={snapshot?.state.autoFix ?? true} disabled={busy || snapshot?.state.running || !id} onChange={event => void act(async () => { if (!id)
        return; const result = await window.electron.agent.setExecutionOptions(id, { autoFix: event.target.checked }); if (!result.success || !result.data)
        throw new Error(result.error ?? 'Could not update execution options.'); store.syncAgent(result.data); })}/>Auto-fix failed checks</label><label>Iteration limit<input type="number" min={1} max={48} aria-label="Iteration limit" defaultValue={snapshot?.state.iterationLimit ?? 24} disabled={busy || snapshot?.state.running || !id} onBlur={event => void act(async () => { if (!id)
        return; const result = await window.electron.agent.setExecutionOptions(id, { iterationLimit: Number(event.target.value) }); if (!result.success || !result.data)
        throw new Error(result.error ?? 'Could not update execution limit.'); store.syncAgent(result.data); })}/></label><p>{snapshot?.state.iterations ?? 0} iterations used. Execution stops at the configured limit.</p></details><div className="context-counts"><span>{snapshot?.state.repoContext.inspectedFiles?.length ?? snapshot?.state.inspectedFiles?.length ?? 0} files inspected</span><span>{snapshot?.state.changedFiles.length ?? 0} files modified</span><span>{snapshot?.state.testResults.length ?? 0} checks executed</span></div><AgentPanel />{snapshot?.state.repoContext.metadata && <details className="agent-section"><summary>Repository context</summary><p>{snapshot.state.repoContext.metadata.languages.join(', ')}</p><p>{snapshot.state.repoContext.metadata.frameworks.join(', ')}</p><p>Package manager: {snapshot.state.repoContext.metadata.packageManagers.join(', ') || 'Not detected'}</p><p>{snapshot.state.repoContext.notes.join(' · ')}</p></details>}<details className="agent-section" open><summary>Audit history · {snapshot?.audit.length ?? 0}</summary>{snapshot?.audit.slice().reverse().map(entry => <div className="audit-entry" key={entry.id}><p>{entry.outcome} · {entry.tool} · {new Date(entry.timestamp).toLocaleTimeString()}</p><p>{entry.target}</p><p>{entry.detail}</p></div>)}</details></>}
    </div>
    {snapshot?.approvals.length && tab !== 'activity' ? <div className="workspace-approvals"><AgentPanel approvalsOnly/></div> : null}
    {store.projectPath && <><button className="workspace-terminal-toggle" aria-expanded={store.terminalOpen} onClick={() => store.setTerminalOpen(!store.terminalOpen)}><TerminalSquare />{store.terminalOpen ? 'Hide terminal' : 'Terminal'}<ChevronDown /></button><AnimatePresence>{store.terminalOpen && <motion.div className="workspace-terminal-drawer" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={{ duration: .15 }}><TerminalPanel /></motion.div>}</AnimatePresence></>}
  </div>;
}
