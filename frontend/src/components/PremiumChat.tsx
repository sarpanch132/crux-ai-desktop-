import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import hljs from 'highlight.js';
import { Bot, Copy, Paperclip, RefreshCw, Send, Square, User2 } from 'lucide-react';
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
              className="whitespace-pre-wrap text-sm leading-7 text-slate-100"
            >
              {block.value}
            </div>
          );
        }

        const highlighted = block.language
          ? hljs.highlight(block.value, { language: block.language, ignoreIllegals: true }).value
          : hljs.highlightAuto(block.value).value;

        return (
          <div key={`${block.type}-${index}`} className="overflow-hidden rounded-2xl border border-white/8 bg-[#0b1020]">
            <div className="flex items-center justify-between border-b border-white/8 px-3 py-2 text-xs uppercase tracking-[0.3em] text-slate-400">
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
            <pre className="overflow-x-auto p-4 text-sm text-slate-100">
              <code dangerouslySetInnerHTML={{ __html: highlighted }} />
            </pre>
          </div>
        );
      })}
    </div>
  );
}

export function PremiumChat() {
  const {
    conversations,
    activeConversationId,
    composerValue,
    isGenerating,
    settings,
    setComposerValue,
    sendMessage,
    stopGeneration,
    retryLastAssistantMessage,
  } = useStore((state) => ({
    conversations: state.conversations,
    activeConversationId: state.activeConversationId,
    composerValue: state.composerValue,
    isGenerating: state.isGenerating,
    settings: state.settings,
    setComposerValue: state.setComposerValue,
    sendMessage: state.sendMessage,
    stopGeneration: state.stopGeneration,
    retryLastAssistantMessage: state.retryLastAssistantMessage,
  }));

  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId) ?? conversations[0];
  const [attachments, setAttachments] = useState<Array<{ id: string; name: string; path: string }>>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeConversation?.messages.length, isGenerating]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
  }, [composerValue]);

  const openFiles = async () => {
    const result = await window.electron.dialog.openFile({ multiple: true });
    if (!result.success || !result.data) {
      return;
    }

    setAttachments(result.data.map((filePath) => ({
      id: crypto.randomUUID(),
      name: filePath.split(/[\\/]/).pop() ?? filePath,
      path: filePath,
    })));
  };

  const handleSend = async () => {
    await sendMessage(undefined, attachments);
    setAttachments([]);
  };

  return (
    <div className="flex h-full flex-col bg-[radial-gradient(circle_at_top,rgba(56,189,248,0.08),transparent_24%),radial-gradient(circle_at_right,rgba(37,99,235,0.08),transparent_24%),#04070d]">
      <div className="border-b border-white/6 px-6 py-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.35em] text-blue-300/75">Conversation</p>
            <h1 className="mt-2 text-2xl font-semibold text-white">{activeConversation?.title ?? 'Chat'}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Streaming responses, safe tool execution, and local-first desktop context.
            </p>
          </div>
          <div className="glass-panel rounded-2xl px-4 py-3 text-right">
            <p className="text-xs uppercase tracking-[0.28em] text-muted-foreground">Model</p>
            <p className="mt-1 text-sm font-medium text-white">{settings?.model ?? 'Not configured'}</p>
            <p className="text-xs text-muted-foreground">{settings?.provider ?? 'provider'}</p>
          </div>
        </div>
      </div>

      <ScrollArea className="flex-1 px-6 py-7">
        <div className="mx-auto flex max-w-4xl flex-col gap-6">
          <AnimatePresence initial={false}>
            {activeConversation?.messages.map((message) => (
              <motion.div
                key={message.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                className={`flex gap-4 ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                {message.role !== 'user' && (
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[linear-gradient(135deg,#2563eb,#1d4ed8,#111827)] text-white shadow-[0_0_30px_rgba(59,130,246,0.2)]">
                    <Bot className="h-4 w-4" />
                  </div>
                )}

                <div
                  className={`max-w-[82%] rounded-[1.75rem] border px-6 py-5 backdrop-blur-xl ${
                    message.role === 'user'
                      ? 'border-blue-400/30 bg-[linear-gradient(135deg,rgba(29,78,216,0.95),rgba(37,99,235,0.8))] text-white shadow-[0_0_36px_rgba(37,99,235,0.2)]'
                      : 'border-white/7 bg-white/[0.04] text-white shadow-[0_12px_30px_rgba(0,0,0,0.28)]'
                  }`}
                >
                  <div className="mb-2 flex items-center justify-between gap-4">
                    <span className="text-xs uppercase tracking-[0.3em] text-white/55">
                      {message.role === 'user' ? 'You' : 'Assistant'}
                    </span>
                    {message.role === 'assistant' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => navigator.clipboard.writeText(message.content).catch(() => undefined)}
                      >
                        <Copy className="mr-2 h-3.5 w-3.5" />
                        Copy
                      </Button>
                    )}
                  </div>

                  <MessageContent content={message.content} />

                  {message.status === 'streaming' && (
                    <div className="mt-4 flex items-center gap-2 text-xs uppercase tracking-[0.28em] text-blue-200/70">
                      <span className="h-2 w-2 rounded-full bg-blue-300 animate-pulse" />
                      Thinking
                    </div>
                  )}

                  {message.error && (
                    <div className="mt-4 rounded-2xl border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-sm text-rose-100">
                      {message.error}
                    </div>
                  )}
                </div>

                {message.role === 'user' && (
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-white/8 text-white">
                    <User2 className="h-4 w-4" />
                  </div>
                )}
              </motion.div>
            ))}
          </AnimatePresence>

          {isGenerating && (
            <div className="glass-panel flex items-center gap-3 rounded-2xl px-4 py-3 text-sm text-muted-foreground">
              <span className="h-2 w-2 rounded-full bg-cyan-300 animate-pulse" />
              Assistant is composing a response and watching for provider errors or timeouts.
            </div>
          )}

          <div ref={scrollRef} />
        </div>
      </ScrollArea>

      <div className="border-t border-white/6 px-6 py-6">
        <div className="mx-auto max-w-4xl rounded-[1.75rem] border border-white/7 bg-black/35 p-5 shadow-[0_18px_36px_rgba(0,0,0,0.3)] backdrop-blur-xl">
          {attachments.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {attachments.map((attachment) => (
                <span
                  key={attachment.id}
                  className="inline-flex items-center gap-2 rounded-full border border-white/8 bg-white/[0.04] px-3 py-1 text-xs text-slate-200"
                >
                  <Paperclip className="h-3.5 w-3.5" />
                  {attachment.name}
                </span>
              ))}
            </div>
          )}

          <Textarea
            ref={textareaRef}
            value={composerValue}
            onChange={(event) => setComposerValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                handleSend().catch((error) => console.error(error));
              }
            }}
            placeholder="Ask CruX to inspect code, debug issues, plan a refactor, or explain what’s happening."
            className="min-h-[88px] resize-none border-none bg-transparent px-0 text-base text-white shadow-none focus-visible:ring-0"
          />

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => openFiles()}>
                <Paperclip className="mr-2 h-4 w-4" />
                Attach File
              </Button>
              <Button variant="outline" size="sm" onClick={() => retryLastAssistantMessage()}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Retry
              </Button>
            </div>

            <div className="flex items-center gap-2">
              {isGenerating && (
                <Button variant="outline" size="sm" onClick={() => stopGeneration()}>
                  <Square className="mr-2 h-4 w-4" />
                  Stop
                </Button>
              )}
              <Button size="sm" onClick={() => handleSend()} disabled={isGenerating || !composerValue.trim()}>
                <Send className="mr-2 h-4 w-4" />
                Send
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
