import { Suspense, lazy, useEffect, useState } from 'react';
import { Command } from 'cmdk';
import { Toaster } from 'sonner';
import { MotionConfig } from 'framer-motion';
import { Asterisk, Bot, Folder, Home, PanelRight, Settings } from 'lucide-react';
import { useStore } from './hooks/useStore';

const PremiumSidebar = lazy(() => import('./components/PremiumSidebar').then((module) => ({ default: module.PremiumSidebar })));
const PremiumChat = lazy(() => import('./components/PremiumChat').then((module) => ({ default: module.PremiumChat })));
const SettingsView = lazy(() => import('./components/SettingsView').then((module) => ({ default: module.SettingsView })));
const ContextPanel = lazy(() => import('./components/ContextPanel').then((module) => ({ default: module.ContextPanel })));
const AgentsSkillsPanel = lazy(() => import('./components/AgentsSkillsPanel').then((module) => ({ default: module.AgentsSkillsPanel })));
function Loading() { return <div className="workspace-loading" role="status">Loading workspace…</div>; }


function CommandPalette() {
  const [open, setOpen] = useState(false);
  const store = useStore();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault(); setOpen(value => !value);
      }
      if ((event.ctrlKey || event.metaKey) && event.key === '`' && store.projectPath) {
        event.preventDefault(); store.setCurrentView('chat'); store.setRightPanelOpen(true); store.setTerminalOpen(!useStore.getState().terminalOpen);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store.projectPath]);
  const workspace = (tab: typeof store.rightPanelTab) => {store.setCurrentView('chat'); store.setHubOpen(false); store.setRightPanelTab(tab); store.setRightPanelOpen(true);};
  const actions = [
    {label: 'Open Project', run: () => void store.openProject()},
    {label: 'New Task', run: () => {store.createConversation(); store.setCurrentView('chat');}},
    {label: 'Open Files', run: () => workspace('files')},
    {label: 'Search Project', run: () => workspace('search')},
    {label: 'View Changes', run: () => workspace('changes')},
    {label: 'View Problems', run: () => workspace('problems')},
    {label: 'View Tests', run: () => workspace('tests')},
    {label: 'Agent Activity', run: () => workspace('activity')},
    ...(store.projectPath ? [{label: 'Open Terminal', run: () => {workspace('activity'); store.setTerminalOpen(true);}}] : []),
    {label: 'View Agents', run: () => {store.setHubTab('agent'); store.setHubOpen(true);}},
    {label: 'View Skills / Install from GitHub', run: () => {store.setHubTab('skill'); store.setHubOpen(true);}},
    {label: 'AI Settings / Test Connection', run: () => store.setCurrentView('settings')},
  ];
  return <Command.Dialog open={open} onOpenChange={setOpen} label="Command palette" className="command-palette">
    <h2 className="sr-only">Command palette</h2>
    <Command.Input placeholder="Search workspace actions…" aria-label="Search workspace actions" />
    <Command.List><Command.Empty>No matching action.</Command.Empty><Command.Group heading="Workspace">{actions.map(action => <Command.Item key={action.label} value={action.label} onSelect={() => {setOpen(false); action.run();}}>{action.label}</Command.Item>)}</Command.Group></Command.List>
    <p className="command-hint">↑ ↓ navigate · Enter choose · Esc close</p>
  </Command.Dialog>;
}

export default function AppShell() {
  const [panelWidth, setPanelWidth] = useState<number>();
  const resizePanel = (event: React.PointerEvent) => {
    event.preventDefault();
    const resize = (move: PointerEvent) => setPanelWidth(Math.max(360, Math.min(720, window.innerWidth - move.clientX)));
    const end = () => {window.removeEventListener('pointermove', resize); window.removeEventListener('pointerup', end);};
    window.addEventListener('pointermove', resize); window.addEventListener('pointerup', end, {once: true});
  };
  const { initialized, currentView, rightPanelOpen, sidebarOpen, initialize, bindRuntimeEvents, setRightPanelOpen, setSidebarOpen, setCurrentView, hubOpen, setHubOpen, agentSnapshots, activeConversationId } = useStore();
  const approvalPending = !!(activeConversationId && agentSnapshots[activeConversationId]?.approvals.length);
  useEffect(() => {
    void initialize().catch((error) => console.error('Failed to initialize Crux AI:', error));
    return bindRuntimeEvents();
  }, [initialize, bindRuntimeEvents]);
  if (!initialized) return <Loading/>;
  return <MotionConfig reducedMotion="user"><div className="crux-shell">
    <nav className="icon-rail" aria-label="Main navigation">
      <Asterisk className="rail-mark" aria-hidden="true"/>
      <button className="rail-button" title="Tasks" aria-label="Tasks" aria-current={currentView === 'chat' ? 'page' : undefined} onClick={() => setCurrentView('chat')}><Home aria-hidden="true"/></button>
      <button className="rail-button" title={sidebarOpen ? 'Hide projects and chats' : 'Show projects and chats'} aria-label={sidebarOpen ? 'Hide projects and chats' : 'Show projects and chats'} aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(!sidebarOpen)}><Folder aria-hidden="true"/></button>
      <button className="rail-button" title="Agents and Skills" aria-label="Agents and Skills" aria-expanded={hubOpen && !approvalPending && !rightPanelOpen} onClick={() => setHubOpen(!(hubOpen && !approvalPending && !rightPanelOpen))}><Bot aria-hidden="true"/></button>
      <button className="rail-button rail-settings" title="Settings" aria-label="Settings" aria-current={currentView === 'settings' ? 'page' : undefined} onClick={() => setCurrentView('settings')}><Settings aria-hidden="true"/></button>
    </nav>
    {sidebarOpen && <aside className="navigation-pane"><Suspense fallback={<Loading/>}><PremiumSidebar/></Suspense></aside>}
    <div className="workspace-main">
      <div className="window-drag-strip drag"/>
      {currentView === 'chat' && <button className="workspace-toggle panel-icon-button" aria-label={rightPanelOpen ? 'Hide workspace' : 'Show workspace'} title="Workspace details" aria-expanded={rightPanelOpen} onClick={() => {setHubOpen(false);setRightPanelOpen(!rightPanelOpen);}}><PanelRight aria-hidden="true" className="h-4 w-4"/></button>}
      <main className="workspace-canvas"><Suspense fallback={<Loading/>}>{currentView === 'settings' ? <SettingsView/> : <PremiumChat/>}</Suspense></main>
    </div>
    {(rightPanelOpen || approvalPending) && currentView === 'chat' && <aside className="details-pane" style={panelWidth ? {width: panelWidth} : undefined}><div className="workspace-resize-handle" role="separator" aria-label="Resize workspace panel" aria-orientation="vertical" aria-valuemin={360} aria-valuemax={720} aria-valuenow={panelWidth ?? 480} tabIndex={0} onPointerDown={resizePanel} onKeyDown={event => {if(event.key === 'ArrowLeft' || event.key === 'ArrowRight'){event.preventDefault();setPanelWidth(value => Math.max(360, Math.min(720, (value ?? 480) + (event.key === 'ArrowLeft' ? 20 : -20))));}}}/><Suspense fallback={<Loading/>}><ContextPanel/></Suspense></aside>}
    {hubOpen && !approvalPending && !rightPanelOpen && <aside className="hub-pane"><Suspense fallback={<Loading/>}><AgentsSkillsPanel/></Suspense></aside>}
  </div><CommandPalette/><Toaster theme="dark" position="bottom-right" richColors closeButton/></MotionConfig>;
}
