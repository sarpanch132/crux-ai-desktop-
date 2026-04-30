import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Bot, FolderOpen, MessageSquare, Search, Settings, TerminalSquare } from 'lucide-react';
import { ScrollArea } from './ui/scroll-area';
import { useStore } from '../hooks/useStore';

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

interface CommandItem {
  id: string;
  title: string;
  subtitle: string;
  icon: JSX.Element;
  action: () => void | Promise<void>;
}

export function CommandPalette({ isOpen, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const {
    createConversation,
    openProject,
    setCurrentView,
    setTerminalOpen,
  } = useStore((state) => ({
    createConversation: state.createConversation,
    openProject: state.openProject,
    setCurrentView: state.setCurrentView,
    setTerminalOpen: state.setTerminalOpen,
  }));

  const commands = useMemo<CommandItem[]>(() => [
    {
      id: 'new-chat',
      title: 'New Chat',
      subtitle: 'Create a fresh CruX conversation',
      icon: <MessageSquare className="h-4 w-4" />,
      action: () => createConversation(),
    },
    {
      id: 'open-project',
      title: 'Open Project',
      subtitle: 'Choose a local workspace folder',
      icon: <FolderOpen className="h-4 w-4" />,
      action: () => openProject(),
    },
    {
      id: 'show-models',
      title: 'Model Manager',
      subtitle: 'Review providers, health, and installed models',
      icon: <Bot className="h-4 w-4" />,
      action: () => setCurrentView('models'),
    },
    {
      id: 'show-settings',
      title: 'Settings',
      subtitle: 'Change provider, theme, and safety controls',
      icon: <Settings className="h-4 w-4" />,
      action: () => setCurrentView('settings'),
    },
    {
      id: 'show-terminal',
      title: 'Toggle Terminal',
      subtitle: 'Open the integrated command panel',
      icon: <TerminalSquare className="h-4 w-4" />,
      action: () => setTerminalOpen(true),
    },
  ], [createConversation, openProject, setCurrentView, setTerminalOpen]);

  const filteredCommands = useMemo(() => {
    if (!query.trim()) {
      return commands;
    }

    const search = query.toLowerCase();
    return commands.filter((command) =>
      command.title.toLowerCase().includes(search)
      || command.subtitle.toLowerCase().includes(search),
    );
  }, [commands, query]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const onKeyDown = async (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((current) => Math.min(current + 1, Math.max(filteredCommands.length - 1, 0)));
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((current) => Math.max(current - 1, 0));
      }

      if (event.key === 'Enter' && filteredCommands[activeIndex]) {
        event.preventDefault();
        await filteredCommands[activeIndex].action();
        onClose();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeIndex, filteredCommands, isOpen, onClose]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            className="fixed inset-0 z-40 bg-black/65 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.div
            className="fixed left-1/2 top-20 z-50 w-[min(44rem,calc(100vw-2rem))] -translate-x-1/2"
            initial={{ opacity: 0, y: -18, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -18, scale: 0.98 }}
          >
            <div className="glass-card overflow-hidden rounded-3xl border border-white/10">
              <div className="flex items-center gap-3 border-b border-white/8 px-4 py-4">
                <Search className="h-4 w-4 text-muted-foreground" />
                <input
                  autoFocus
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search actions, views, and tools"
                  className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                />
              </div>

              <ScrollArea className="max-h-[24rem]">
                <div className="space-y-2 p-3">
                  {filteredCommands.map((command, index) => (
                    <button
                      key={command.id}
                      type="button"
                      onClick={async () => {
                        await command.action();
                        onClose();
                      }}
                      className={`flex w-full items-center gap-3 rounded-2xl border px-3 py-3 text-left transition ${
                        index === activeIndex
                          ? 'border-blue-400/35 bg-blue-500/10'
                          : 'border-white/6 bg-white/[0.02] hover:bg-white/[0.04]'
                      }`}
                    >
                      <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white/6 text-blue-200">
                        {command.icon}
                      </div>
                      <div>
                        <p className="text-sm font-medium text-white">{command.title}</p>
                        <p className="text-xs text-muted-foreground">{command.subtitle}</p>
                      </div>
                    </button>
                  ))}
                </div>
              </ScrollArea>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
