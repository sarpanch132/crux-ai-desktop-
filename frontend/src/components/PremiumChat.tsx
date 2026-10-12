import { ModelSelector } from './ModelSelector';
import { AgentControls } from './AgentControls';
import { RoutePreview, useMentionPicker } from './RoutePreview';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import hljs from 'highlight.js';
import { ArrowUp, Copy, Folder, Paperclip, Square, X } from 'lucide-react';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
import { Textarea } from './ui/textarea';
import { useStore } from '../hooks/useStore';

function renderMarkdownBlocks(content: string) {
  const segments: Array<{ type: 'text' | 'code'; value: string; language?: string }> = [];
  const matcher = /```([\w-]+)?\n([\s\S]*?)```/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(content)) !== null) {
    if (match.index > cursor) {
      segments.push({ type: 'text', value: content.slice(cursor, match.index) });
    }
    segments.push({ type: 'code', language: match[1], value: match[2] });
    cursor = match.index + match[0].length;
  }

  if (cursor < content.length) {
    segments.push({ type: 'text', value: content.slice(cursor) });
  }

  return segments.length > 0 ? segments : [{ type: 'text' as const, value: content }];
}

function MessageContent({ content }: { content: string }) {
  const blocks = useMemo(() => renderMarkdownBlocks(content), [content]);

  return (
    <div className="space-y-3">
      {blocks.map((block, index) => {
        if (block.type === 'text') {
          return (
            <div
              key={`${block.type}-${index}`}
              className="whitespace-pre-wrap text-sm leading-7 text-zinc-100"
            >
              {block.value}
            </div>
          );
        }

        const highlighted = block.language && hljs.getLanguage(block.language)
          ? hljs.highlight(block.value, { language: block.language, ignoreIllegals: true }).value
          : hljs.highlightAuto(block.value).value;

        return (
          <div key={`${block.type}-${index}`} className="overflow-hidden rounded-md border border-white/8 bg-[#0d0d0d]">
            <div className="flex items-center justify-between border-b border-white/8 px-3 py-2 text-xs uppercase tracking-[0.3em] text-zinc-400">
              <span>{block.language ?? 'code'}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigator.clipboard.writeText(block.value).catch(() => undefined)}
              >
                <Copy className="mr-2 h-3.5 w-3.5" />
                Copy
              </Button>
            </div>
            <pre className="overflow-x-auto p-4 text-sm text-zinc-100">
              <code dangerouslySetInnerHTML={{ __html: highlighted }} />
            </pre>
          </div>
        );
      })}
    </div>
  );
}

export function PremiumChat() {
  const { conversations, activeConversationId, composerValue, isGenerating, isProjectSwitching, settingsSaving, autoModelLoading, connectionTesting, settings, projectPath, recentProjects, setComposerValue, sendMessage, stopGeneration, openProject, activateProject, setCurrentView, previewRoute, routeError, routeLoading } = useStore();
  const [connectionTested,setConnectionTested] = useState(false);
  const mentions = useMentionPicker();
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId) ?? conversations[0];
  const [attachments, setAttachments] = useState<Array<{ id: string; name: string; path: string }>>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const empty = !activeConversation?.messages.length;
  const ready = !!settings?.provider && !!settings.model && (settings.provider === 'ollama' || settings.provider === 'custom' || settings.hasApiKey);
  useEffect(() => { scrollRef.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }, [activeConversation?.messages.length, isGenerating]);
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }, [composerValue]);
  useEffect(() => { setAttachments([]); }, [activeConversationId]);
  useEffect(() => {const timeout = window.setTimeout(() => void previewRoute(), 180);return () => window.clearTimeout(timeout);}, [composerValue, previewRoute]);
  useEffect(() => {
    let canceled = false;
    setConnectionTested(false);
    if (settings?.provider) void window.electron.ai.getConnectionTest().then((result) => {
      if (!canceled) setConnectionTested(!!(result.success && result.data?.success));
    }).catch(() => undefined);
    return () => {canceled = true;};
  }, [settings, isGenerating]);
  const openFiles = async () => {
    const result = await window.electron.dialog.openFile({ multiple: true });
    if (result.success && result.data) setAttachments(result.data.map((path) => ({ id: crypto.randomUUID(), name: path.split(/[\\/]/).pop() ?? path, path })));
  };
  const handleSend = async () => {
    if (isGenerating || isProjectSwitching || settingsSaving || autoModelLoading || connectionTesting || routeLoading || routeError || !composerValue.trim()) return;
    await sendMessage(undefined, attachments);
    if (!useStore.getState().composerValue.trim()) setAttachments([]);
  };
  return <div className="chat-surface">
    {empty ? <div className="chat-empty"><h1>Start with an idea</h1><p>Bring a question, a change, or a problem to solve.</p></div> : <ScrollArea className="chat-history"><div className="message-list">
      <AnimatePresence initial={false}>{activeConversation?.messages.map((message) => <motion.article key={message.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className={`chat-message ${message.role}`}>
        <div className="message-meta"><span>{message.role === 'user' ? 'You' : 'Crux AI'}</span>{message.role === 'assistant' && <button className="panel-icon-button" aria-label="Copy response" title="Copy response" onClick={() => void navigator.clipboard.writeText(message.content).catch(() => undefined)}><Copy aria-hidden="true" className="h-3.5 w-3.5"/></button>}</div>
        <MessageContent content={message.content}/>
        {message.status === 'streaming' && <p className="message-progress" role="status">Working…</p>}
        {message.error && <div><p className="field-error" role="alert">{message.error}</p>{settings?.provider && !connectionTested && <button className="chat-settings-action" onClick={() => setCurrentView('settings')}>Open AI Settings</button>}</div>}
      </motion.article>)}</AnimatePresence><div ref={scrollRef}/>
    </div></ScrollArea>}
    <div className="composer-dock">
      {!ready && <div className="connection-prompt"><span>Connect a provider and choose a model to begin.</span><button onClick={() => setCurrentView('settings')}>Set up</button></div>}
      <div className="project-picker"><Folder aria-hidden="true" className="h-4 w-4"/><select aria-label="Choose project" title={projectPath ?? 'Choose project'} value={projectPath ?? ''} disabled={isGenerating || isProjectSwitching} onChange={(event) => { if (event.target.value === '__open__') void openProject(); else if (event.target.value) void activateProject(event.target.value); }}><option value="">Choose project</option>{[...new Set([...(projectPath ? [projectPath] : []), ...recentProjects])].map((path) => <option key={path} value={path}>{path.split(/[\\/]/).filter(Boolean).pop() ?? path}</option>)}<option value="__open__">Open folder…</option></select></div>
      <div className="composer-box">
        {mentions.picker}
        <RoutePreview/>
        {!!attachments.length && <div className="attachment-list">{attachments.map((attachment) => <span key={attachment.id}>{attachment.name}<button aria-label={`Remove ${attachment.name}`} onClick={() => setAttachments((items) => items.filter((item) => item.id !== attachment.id))}><X aria-hidden="true" className="h-3 w-3"/></button></span>)}</div>}
        <Textarea ref={textareaRef} aria-label="Message" aria-autocomplete="list" aria-controls={mentions.open ? 'mention-options' : undefined} aria-activedescendant={mentions.activeId} value={composerValue} onChange={(event) => setComposerValue(event.target.value)} onKeyDown={(event) => {if(event.nativeEvent.isComposing) return;if(mentions.onKeyDown(event)) return; if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void handleSend(); } }} placeholder="Ask Crux to build, change, test, or explain code…" className="composer-textarea"/>
        <div className="composer-controls"><button className="panel-icon-button" aria-label="Attach files" title="Attach files" disabled={isGenerating || isProjectSwitching} onClick={() => void openFiles()}><Paperclip aria-hidden="true" className="h-4 w-4"/></button><AgentControls/><div className="composer-model"><ModelSelector compact/></div>{isGenerating ? <button className="send-button" aria-label="Stop generation" title="Stop generation" onClick={() => void stopGeneration()}><Square aria-hidden="true" className="h-4 w-4"/></button> : <button className="send-button" aria-label="Send message" title="Send message" disabled={isProjectSwitching || settingsSaving || autoModelLoading || connectionTesting || routeLoading || !!routeError || !composerValue.trim()} onClick={() => void handleSend()}><ArrowUp aria-hidden="true" className="h-5 w-5"/></button>}</div>
      </div>
    </div>
  </div>;
}
