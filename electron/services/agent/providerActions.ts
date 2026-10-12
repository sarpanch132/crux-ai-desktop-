import { StringDecoder } from 'node:string_decoder';
import { resolveToolName } from './toolRegistry.js';

type Provider = 'compatible' | 'anthropic' | 'ollama';
interface NativeCall { name: string; arguments: unknown; }
export class StructuredResponseError extends Error {
  constructor(message: string) { super(`Invalid agent structured response: ${message}`); this.name = 'StructuredResponseError'; }
}
const fail = (message: string): never => { throw new StructuredResponseError(message); };
function checked(value: unknown, depth = 0): void {
  if (depth > 20) fail('arguments exceed the nesting limit.');
  if (value && typeof value === 'object') for (const [key, nested] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('unsafe argument key.');
    checked(nested, depth+1);
  }
}
function argumentsObject(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof value === 'string') { try { parsed = JSON.parse(value); } catch { fail('function arguments are not complete JSON.'); } }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('function arguments must be an object.');
  checked(parsed);
  return parsed as Record<string, unknown>;
}
function normalized(content: unknown, calls: NativeCall[]): string {
  const text = typeof content === 'string' ? content : '';
  if (!calls.length) return text;
  if (calls.length > 10) fail('too many native calls.');
  const envelope = calls.find(call => call.name === 'crux_reply');
  if (envelope) {
    if (calls.length !== 1) fail('reply envelope cannot be mixed with direct calls.');
    const reply = argumentsObject(envelope.arguments);
    if (typeof reply.message !== 'string' || !Array.isArray(reply.actions) || reply.actions.length > 10 || typeof reply.done !== 'boolean') fail('reply envelope requires message, actions and done with their declared types.');
    if (text.trim()) reply.message = `${text.trim()}${typeof reply.message === 'string' && reply.message ? `\n\n${reply.message}` : ''}`;
    return JSON.stringify(reply);
  }
  const actions = calls.map(call => {
    if (!resolveToolName(call.name)) fail('unknown native tool name.');
    const args = argumentsObject(call.arguments);
    if (Object.keys(args).some(key => ['tool','name','type'].includes(key))) fail('arguments cannot override tool identity.');
    return { type: 'tool_call', name: call.name, arguments: args };
  });
  let metadata: Record<string, unknown> = {};
  if (text.trim().startsWith('{')) metadata = argumentsObject(text);
  return JSON.stringify({ ...metadata, message: typeof metadata.message === 'string' ? metadata.message : text, actions: [...(Array.isArray(metadata.actions) ? metadata.actions : []), ...actions], done: metadata.done === true });
}

/** Native transport normalization only; the orchestrator still validates every action. */
export function agentReply(data: any, provider: Provider): string {
  if (provider === 'compatible') {
    const choice = data?.choices?.[0]; if (choice?.finish_reason === 'length') fail('completion was truncated.');
    if (choice?.message?.tool_calls !== undefined && !Array.isArray(choice.message.tool_calls)) fail('native tool calls must be an array.');
    return normalized(choice?.message?.content, (choice?.message?.tool_calls || []).map((call: any) => ({ name: call?.function?.name, arguments: call?.function?.arguments })));
  }
  if (provider === 'anthropic') {
    if (data?.stop_reason === 'max_tokens') fail('completion was truncated.');
    const blocks = Array.isArray(data?.content) ? data.content : [];
    return normalized(blocks.filter((block: any) => block?.type === 'text').map((block: any) => block.text).join(''), blocks.filter((block: any) => block?.type === 'tool_use').map((block: any) => ({ name: block.name, arguments: block.input })));
  }
  if (data?.done_reason === 'length') fail('completion was truncated.');
  if (data?.message?.tool_calls !== undefined && !Array.isArray(data.message.tool_calls)) fail('native tool calls must be an array.');
  return normalized(data?.message?.content, (data?.message?.tool_calls || []).map((call: any) => ({ name: call?.function?.name, arguments: call?.function?.arguments })));
}

/** Buffer native calls until the transport completion marker. Preview text never executes. */
export async function agentStream(chunks: AsyncIterable<Buffer | string>, format: 'sse' | 'ndjson', provider: Provider, preview?: (text: string) => void): Promise<string> {
  const decoder = new StringDecoder('utf8');
  let pending = '', text = '', bytes = 0, finished = false, truncated = false;
  const calls = new Map<number, { name: string; arguments: string }>();
  const callAt = (index: unknown) => {
    if (!Number.isInteger(index) || Number(index) < 0 || Number(index) >= 10) fail('invalid native call index.');
    const key = Number(index); if (!calls.has(key)) calls.set(key, { name: '', arguments: '' }); return calls.get(key)!;
  };
  const consume = (event: string) => {
    const raw = format === 'sse' ? event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n') : event;
    if (!raw.trim()) return;
    if (raw === '[DONE]') { finished = true; return; }
    let value: any; try { value = JSON.parse(raw); } catch { fail('malformed stream event.'); }
    if (value.error || value.type === 'error') throw new Error('Provider stream returned an error.');
    let delta: unknown;
    if (provider === 'compatible') {
      const choice = value.choices?.[0]; delta = choice?.delta?.content;
      truncated ||= choice?.finish_reason === 'length';
      for (const entry of choice?.delta?.tool_calls || []) {
        const call = callAt(entry.index); const name = entry.function?.name; const args = entry.function?.arguments;
        if (name !== undefined) { if (typeof name !== 'string') fail('invalid native name.'); if (call.name !== name) call.name += name; }
        if (args !== undefined) { if (typeof args !== 'string') fail('invalid native argument fragment.'); call.arguments += args; }
      }
    } else if (provider === 'anthropic') {
      if (value.type === 'message_stop') finished = true;
      truncated ||= value.delta?.stop_reason === 'max_tokens';
      if (value.type === 'content_block_start' && value.content_block?.type === 'tool_use') { const call = callAt(value.index); call.name = value.content_block.name; if (value.content_block.input && Object.keys(value.content_block.input).length) call.arguments = JSON.stringify(value.content_block.input); }
      if (value.delta?.type === 'input_json_delta') { const call = callAt(value.index); if (typeof value.delta.partial_json !== 'string') fail('invalid Anthropic argument fragment.'); call.arguments += value.delta.partial_json; }
      if (value.delta?.type === 'text_delta') delta = value.delta.text;
    } else {
      finished ||= value.done === true; truncated ||= value.done_reason === 'length'; delta = value.message?.content;
      for (const [index, entry] of (value.message?.tool_calls || []).entries()) { const call = callAt(index); call.name = entry.function?.name; const args = entry.function?.arguments; call.arguments = typeof args === 'string' ? args : JSON.stringify(args); }
    }
    if (delta !== undefined && delta !== null) { if (typeof delta !== 'string') fail('invalid streamed text.'); text += delta; if (delta) preview?.(text); }
    for (const call of calls.values()) { if (call.name.length > 200 || call.arguments.length > 1024*1024) fail('native call exceeds the limit.'); if (call.name === 'crux_reply') preview?.(call.arguments); }
  };
  for await (const chunk of chunks) {
    bytes += Buffer.byteLength(chunk); if (bytes > 2*1024*1024) fail('stream exceeds 2 MiB.');
    pending += typeof chunk === 'string' ? chunk : decoder.write(chunk); pending = pending.replace(/\r\n/g,'\n');
    const separator = format === 'sse' ? '\n\n' : '\n'; let end: number;
    while ((end = pending.indexOf(separator)) !== -1) { const event = pending.slice(0,end); pending = pending.slice(end+separator.length); consume(event); if (finished) break; }
    if (finished) break;
    if (pending.length > 512*1024) fail('stream event exceeds the limit.');
  }
  pending += decoder.end();
  if (!finished && pending.trim()) { try { consume(pending); } catch { throw new Error('Provider stream ended before its completion event.'); } }
  if (!finished) throw new Error('Provider stream ended before its completion event.');
  if (truncated) fail('completion was truncated.');
  return normalized(text, [...calls.values()]);
}

export const CRUX_REPLY_SCHEMA = {
  type: 'object', properties: {
    message: { type: 'string' }, requirements: { type: 'array', items: { type: 'string' } }, done: { type: 'boolean' },
    acceptanceCriteria: { type: 'array', items: { type: 'string' } },
    plan: { type: 'object', properties: { summary: { type: 'string' }, architecture: { type: 'string' }, tasks: { type: 'array', items: { type: 'string' } }, risks: { type: 'array', items: { type: 'string' } }, acceptanceCriteria: { type: 'array', items: { type: 'string' } }, checks: { type: 'array', items: { type: 'string' } } }, required: ['summary','architecture','tasks','risks','acceptanceCriteria','checks'], additionalProperties: false },
    actions: { type: 'array', maxItems: 10, items: { type: 'object', properties: { type: { type: 'string', enum: ['tool_call'] }, name: { type: 'string' }, arguments: { type: 'object', additionalProperties: true } }, required: ['type','name','arguments'], additionalProperties: false } },
    acceptance: { type: 'array', items: { type: 'object', properties: { criterion: { type: 'string' }, passed: { type: 'boolean' }, evidence: { type: 'string' } }, required: ['criterion','passed','evidence'], additionalProperties: false } },
  }, required: ['message','actions','done'], additionalProperties: false,
};
