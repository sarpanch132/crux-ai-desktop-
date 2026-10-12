import { StringDecoder } from 'node:string_decoder';

/** Decode bounded provider events. Only complete JSON events produce text. */
export async function* providerText(chunks: AsyncIterable<Buffer | string>, format: 'sse' | 'ndjson', provider: 'compatible' | 'anthropic' | 'ollama'): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8');
  let pending = ''; let bytes = 0; let finished = false;
  const decode = (event: string): string => {
    if (!event.trim()) return '';
    let data = event;
    if (format === 'sse') data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') { if (data === '[DONE]') finished = true; return ''; }
    const value = JSON.parse(data);
    if (value.error || value.type === 'error') throw new Error('Provider stream returned an error.');
    if (provider === 'ollama' && value.done === true || provider === 'anthropic' && value.type === 'message_stop') finished = true;
    const text = provider === 'ollama' ? value.message?.content : provider === 'anthropic' ? value.type === 'content_block_delta' && value.delta?.type === 'text_delta' ? value.delta.text : '' : value.choices?.[0]?.delta?.content;
    if (text !== undefined && text !== '' && typeof text !== 'string') throw new Error('Invalid streamed text.');
    return text || '';
  };
  for await (const chunk of chunks) {
    bytes += Buffer.byteLength(chunk); if (bytes > 2 * 1024 * 1024) throw new Error('Provider stream exceeds 2 MiB.');
    pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    pending = pending.replace(/\r\n/g, '\n');
    const separator = format === 'sse' ? '\n\n' : '\n';
    let end: number;
    while ((end = pending.indexOf(separator)) >= 0) {
      const event = pending.slice(0, end); pending = pending.slice(end + separator.length);
      const text = decode(event); if (text) yield text;
      if (finished) return;
    }
    if (pending.length > 512 * 1024) throw new Error('Provider event exceeds the limit.');
  }
  pending += decoder.end();
  if (pending.trim()) { const text = decode(pending); if (text) yield text; }
  if (!finished) throw new Error('Provider stream ended before its completion event.');
}

/** Presentation only: extract a top-level message string; never parse actions partially. */
export function messagePreview(source: string): string {
  const text = source.replace(/^\s*```(?:json)?\s*/i, '');
  let depth = 0; let index = 0;
  while (index < text.length) {
    const char = text[index++];
    if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') depth--;
    else if (char === '"') {
      const start = index - 1;
      while (index < text.length) { if (text[index++] === '\\') index++; else if (text[index - 1] === '"') break; }
      if (depth !== 1 || text[index - 1] !== '"') continue;
      let key: unknown; try { key = JSON.parse(text.slice(start, index)); } catch { return ''; }
      if (key !== 'message') continue;
      while (/\s/.test(text[index] ?? '') && index < text.length) index++;
      if (text[index++] !== ':') continue;
      while (/\s/.test(text[index] ?? '') && index < text.length) index++;
      if (text[index++] !== '"') return '';
      const contentStart = index;
      while (index < text.length) {
        if (text[index] === '"') { try { return JSON.parse('"' + text.slice(contentStart, index) + '"'); } catch { return ''; } }
        if (text[index] === '\\') {
          if (index + 1 >= text.length) break;
          if (text[index + 1] === 'u' && index + 6 > text.length) break;
          index += text[index + 1] === 'u' ? 6 : 2;
        } else index++;
      }
      try { return JSON.parse('"' + text.slice(contentStart, index) + '"'); } catch { return ''; }
    }
  }
  return '';
}
