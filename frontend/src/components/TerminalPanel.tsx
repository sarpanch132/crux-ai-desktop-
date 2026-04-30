import { useMemo } from 'react';
import { Play, Square, TerminalSquare } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { ScrollArea } from './ui/scroll-area';
import { useStore } from '../hooks/useStore';

export function TerminalPanel() {
  const {
    terminalInput,
    activeTerminalSessionId,
    terminalSessions,
    setTerminalInput,
    setActiveTerminalSession,
    runTerminalCommand,
  } = useStore((state) => ({
    terminalInput: state.terminalInput,
    activeTerminalSessionId: state.activeTerminalSessionId,
    terminalSessions: state.terminalSessions,
    setTerminalInput: state.setTerminalInput,
    setActiveTerminalSession: state.setActiveTerminalSession,
    runTerminalCommand: state.runTerminalCommand,
  }));

  const sessions = useMemo(
    () => Object.values(terminalSessions).sort((a, b) => b.startedAt - a.startedAt),
    [terminalSessions],
  );

  const currentSession = sessions.find((session) => session.id === activeTerminalSessionId) ?? sessions[0];

  return (
    <div className="flex h-full flex-col bg-[#05070d]">
      <div className="flex items-center justify-between border-b border-white/6 px-4 py-3">
        <div className="flex items-center gap-2">
          <TerminalSquare className="h-4 w-4 text-cyan-300" />
          <p className="text-sm font-medium text-white">Integrated Terminal</p>
        </div>
        <div className="text-xs text-muted-foreground">Timeout: 120s • loop guard enabled</div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="w-72 border-r border-white/6 p-3">
          <Button className="mb-3 w-full justify-start gap-2" onClick={() => runTerminalCommand('')}>
            <Play className="h-4 w-4" />
            Ready
          </Button>
          <ScrollArea className="h-[calc(100%-3.5rem)] pr-2">
            <div className="space-y-2">
              {sessions.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => setActiveTerminalSession(session.id)}
                  className={`w-full rounded-2xl border px-3 py-3 text-left transition ${
                    session.id === currentSession?.id
                      ? 'border-cyan-400/35 bg-cyan-500/10'
                      : 'border-white/6 bg-white/[0.02] hover:bg-white/[0.04]'
                  }`}
                >
                  <p className="truncate text-sm font-medium text-white">{session.command || 'Interactive session'}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {session.status} • {session.cwd || 'workspace root'}
                  </p>
                </button>
              ))}
              {sessions.length === 0 && (
                <p className="text-sm text-muted-foreground">Run a command to populate session history.</p>
              )}
            </div>
          </ScrollArea>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <ScrollArea className="flex-1 p-4">
            <div className="space-y-2 font-mono text-sm">
              {currentSession?.outputs.map((output, index) => (
                <div
                  key={`${output.sessionId}-${output.timestamp}-${index}`}
                  className={
                    output.type === 'stderr'
                      ? 'text-rose-300'
                      : output.type === 'system'
                        ? 'text-cyan-300'
                        : 'text-slate-200'
                  }
                >
                  {output.data}
                </div>
              ))}
              {!currentSession && <p className="text-muted-foreground">No terminal session selected.</p>}
            </div>
          </ScrollArea>

          <div className="border-t border-white/6 p-3">
            <div className="flex items-center gap-2">
              <Input
                value={terminalInput}
                onChange={(event) => setTerminalInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    runTerminalCommand().catch((error) => console.error(error));
                  }
                }}
                placeholder="Run a safe shell command"
                className="glass-input border-white/8 font-mono"
              />
              <Button onClick={() => runTerminalCommand()} disabled={!terminalInput.trim()}>
                <Play className="mr-2 h-4 w-4" />
                Run
              </Button>
              <Button variant="outline" onClick={() => window.electron.terminal.kill(currentSession?.id ?? '').catch(() => undefined)} disabled={!currentSession?.id}>
                <Square className="mr-2 h-4 w-4" />
                Stop
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
