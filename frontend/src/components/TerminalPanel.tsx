import { useEffect, useMemo, useRef } from 'react';
import { Play, Square, TerminalSquare } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { ScrollArea } from './ui/scroll-area';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useStore } from '../hooks/useStore';

function TerminalOutputView({session}:{session?:ReturnType<typeof useStore.getState>['terminalSessions'][string]}) {
  const host=useRef<HTMLDivElement>(null);
  const terminal=useRef<Terminal>();
  const written=useRef(0);
  useEffect(()=>{
    if(!host.current)return;
    const instance=new Terminal({disableStdin:true,convertEol:true,fontSize:12,fontFamily:'Consolas, monospace',screenReaderMode:true,scrollback:5000,theme:{background:'#0d0d0d',foreground:'#d1d1d1'}});
    const fit=new FitAddon();instance.loadAddon(fit);instance.open(host.current);terminal.current=instance;written.current=0;
    const observer=new ResizeObserver(()=>{if(host.current?.clientWidth&&host.current?.clientHeight)fit.fit();});observer.observe(host.current);fit.fit();
    return()=>{observer.disconnect();instance.dispose();terminal.current=undefined;};
  },[session?.id]);
  useEffect(()=>{
    const instance=terminal.current;if(!instance)return;
    const outputs=session?.outputs??[];
    if(outputs.length<written.current){instance.reset();written.current=0;}
    for(const output of outputs.slice(written.current))instance.write(output.data);
    written.current=outputs.length;
  },[session?.outputs,session?.id]);
  return <div className="terminal-output-host" aria-label="Command output" ref={host}/>;
}

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
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[#0d0d0d]">
      <div className="flex items-center justify-between border-b border-white/6 px-4 py-2">
        <div className="flex items-center gap-2">
          <TerminalSquare className="h-4 w-4 text-zinc-300" />
          <p className="text-sm font-medium text-white">Command Terminal</p>
        </div>
        <div className="text-xs text-muted-foreground">Timeout: 120s • loop guard enabled</div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="w-48 shrink-0 overflow-auto border-r border-white/6 p-2">
          <p className="mb-2 text-xs uppercase tracking-widest text-zinc-400">Sessions</p>
          <ScrollArea className="min-h-0 pr-2">
            <div className="space-y-2">
              {sessions.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => setActiveTerminalSession(session.id)}
                  className={`w-full rounded-md border px-3 py-3 text-left transition ${
                    session.id === currentSession?.id
                      ? 'border-zinc-400/35 bg-zinc-500/10'
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
          <div className="flex-1 min-h-0 p-3"><TerminalOutputView session={currentSession}/>{!currentSession&&<p className="text-xs text-muted-foreground">No command has run. Output will appear here.</p>}</div>

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
                placeholder="Run a project command"
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
