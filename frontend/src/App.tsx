import { Suspense, lazy, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Button } from './components/ui/button';
import { useStore } from './hooks/useStore';
import cruxLogo from './assets/crux-logo.jpg';

const PremiumSidebar = lazy(() => import('./components/PremiumSidebar').then((module) => ({ default: module.PremiumSidebar })));
const PremiumChat = lazy(() => import('./components/PremiumChat').then((module) => ({ default: module.PremiumChat })));
const ModelManager = lazy(() => import('./components/ModelManager').then((module) => ({ default: module.ModelManager })));
const SettingsView = lazy(() => import('./components/SettingsView').then((module) => ({ default: module.SettingsView })));
const ContextPanel = lazy(() => import('./components/ContextPanel').then((module) => ({ default: module.ContextPanel })));
const TerminalPanel = lazy(() => import('./components/TerminalPanel').then((module) => ({ default: module.TerminalPanel })));
const CommandPalette = lazy(() => import('./components/CommandPalette').then((module) => ({ default: module.CommandPalette })));

function PaneSkeleton() {
  return (
    <div className="flex h-full items-center justify-center bg-background">
      <div className="glass-card rounded-3xl px-6 py-5 text-sm text-muted-foreground">
        Loading CruX workspace...
      </div>
    </div>
  );
}

function AppShell() {
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const {
    initialized,
    currentView,
    rightPanelOpen,
    terminalOpen,
    sidebarOpen,
    settings,
    projectPath,
    initialize,
    bindRuntimeEvents,
    setRightPanelOpen,
    setSidebarOpen,
    setTerminalOpen,
  } = useStore((state) => ({
    initialized: state.initialized,
    currentView: state.currentView,
    rightPanelOpen: state.rightPanelOpen,
    terminalOpen: state.terminalOpen,
    sidebarOpen: state.sidebarOpen,
    settings: state.settings,
    projectPath: state.projectPath,
    initialize: state.initialize,
    bindRuntimeEvents: state.bindRuntimeEvents,
    setRightPanelOpen: state.setRightPanelOpen,
    setSidebarOpen: state.setSidebarOpen,
    setTerminalOpen: state.setTerminalOpen,
  }));

  useEffect(() => {
    initialize().catch((error) => {
      console.error('Failed to initialize CruX:', error);
    });
    const dispose = bindRuntimeEvents();
    return dispose;
  }, [bindRuntimeEvents, initialize]);

  if (!initialized) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="glass-card flex w-[28rem] flex-col gap-4 rounded-3xl p-8">
          <div className="flex items-center gap-4">
            <div className="crux-logo-shell max-w-[180px]">
              <img src={cruxLogo} alt="cruX" className="crux-logo crux-logo-lg" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold text-white">Preparing your AI workspace</h1>
            </div>
          </div>
          <div className="overflow-hidden rounded-full bg-white/5">
            <motion.div
              className="h-2 rounded-full bg-[linear-gradient(90deg,#60a5fa,#38bdf8,#22d3ee)]"
              animate={{ x: ['-100%', '120%'] }}
              transition={{ repeat: Number.POSITIVE_INFINITY, duration: 1.4, ease: 'easeInOut' }}
            />
          </div>
          <p className="text-sm text-muted-foreground">
            Loading settings, model health, project context, and terminal state.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-background text-foreground">
      <AnimatePresence initial={false}>
        {sidebarOpen && (
          <motion.aside
            key="sidebar"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 320, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="border-r border-white/6"
          >
            <Suspense fallback={<PaneSkeleton />}>
              <PremiumSidebar onOpenCommandPalette={() => setCommandPaletteOpen(true)} />
            </Suspense>
          </motion.aside>
        )}
      </AnimatePresence>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="drag flex h-16 items-center justify-between border-b border-white/6 bg-black/35 px-4 backdrop-blur-xl">
          <div className="no-drag flex min-w-0 items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => setSidebarOpen(!sidebarOpen)}>
              <span className="text-sm tracking-tight">|||</span>
            </Button>
            <div className="crux-logo-shell max-w-[132px]">
              <img src={cruxLogo} alt="cruX" className="crux-logo crux-logo-sm" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-xs text-muted-foreground">
                {projectPath ? projectPath : 'No project open'} | {settings?.provider ?? 'provider'} / {settings?.model ?? 'model'}
              </p>
            </div>
          </div>

          <div className="no-drag flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setCommandPaletteOpen(true)}>
              Search
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setRightPanelOpen(!rightPanelOpen)}>
              {rightPanelOpen ? 'Hide Panel' : 'Show Panel'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setTerminalOpen(!terminalOpen)}>
              {terminalOpen ? 'Hide Terminal' : 'Show Terminal'}
            </Button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <main className="min-w-0 flex-1">
            <Suspense fallback={<PaneSkeleton />}>
              {currentView === 'chat' && <PremiumChat />}
              {currentView === 'models' && <ModelManager />}
              {currentView === 'settings' && <SettingsView />}
              {currentView === 'projects' && <ContextPanel standalone />}
            </Suspense>
          </main>

          <AnimatePresence initial={false}>
            {rightPanelOpen && currentView !== 'projects' && (
              <motion.aside
                key="context"
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: 360, opacity: 1 }}
                exit={{ width: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="border-l border-white/6"
              >
                <Suspense fallback={<PaneSkeleton />}>
                  <ContextPanel />
                </Suspense>
              </motion.aside>
            )}
          </AnimatePresence>
        </div>

        <AnimatePresence initial={false}>
          {terminalOpen && (
            <motion.div
              key="terminal"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 280, opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="border-t border-white/6"
            >
              <Suspense fallback={<PaneSkeleton />}>
                <TerminalPanel />
              </Suspense>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <Suspense fallback={null}>
        <CommandPalette isOpen={commandPaletteOpen} onClose={() => setCommandPaletteOpen(false)} />
      </Suspense>
    </div>
  );
}

export default AppShell;
