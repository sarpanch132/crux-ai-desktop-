import path from 'node:path';
import type { Diagnostic, CommandResult } from './contracts';

/** Lexical diagnostics, not a substitute for a compiler/language server. */
export function parseDiagnostics(result: CommandResult, workspace: string): Diagnostic[] {
  const output = result.stdout !== undefined || result.stderr !== undefined ? `${result.stdout ?? ''}\n${result.stderr ?? ''}` : result.output;
  const text = output.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[a-zA-Z]`, 'g'), '');
  const entries: Diagnostic[] = [];
  const seen = new Set<string>();
  let eslintFile: string | undefined;
  const add = (message: string, source: string, file?: string, line?: string, column?: string, code?: string, severity: 'error' | 'warning' = 'error') => {
    if (entries.length >= 100) return;
    const cleanFile = file?.replace(/^file:\/\//, '');
    const invalidPath = cleanFile && ([...cleanFile].some(char => char.charCodeAt(0) < 32) || cleanFile.replace(/^[A-Za-z]:/, '').includes(':') || /^[\\/]{2}[?.]/.test(cleanFile));
    const resolved = cleanFile && !invalidPath ? path.resolve(workspace, cleanFile) : undefined;
    const relative = resolved ? path.relative(workspace, resolved) : '';
    const safeFile = resolved && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative) ? resolved : undefined;
    const item: Diagnostic = {source, severity, message: message.slice(0, 2000), command: result.command, exitCode: result.exitCode,
      ...(safeFile ? {file:safeFile} : {}), ...(line ? {line:Number(line)} : {}), ...(column ? {column:Number(column)} : {}), ...(code ? {code} : {})};
    const key = JSON.stringify(item);
    if (!seen.has(key)) {seen.add(key); entries.push(item);}
  };
  for (const raw of text.split(/\r\n|\n|\r/).slice(-4000)) {
    const row = raw.trim();
    let match = /^(.*?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.*)$/.exec(row);
    if (match) {add(match[6], 'TypeScript', match[1], match[2], match[3], match[5], match[4] as 'error' | 'warning'); continue;}
    match = /^(.*?):(\d+):(\d+)\s*[-:]?\s*(error|warning)\s*(TS\d+)?:?\s*(.*)$/.exec(row);
    if (match) {add(match[6], match[5] ? 'TypeScript' : 'Compiler', match[1], match[2], match[3], match[5], match[4] as 'error' | 'warning'); continue;}
    if (/\.(?:[cm]?[jt]sx?|vue|svelte)$/.test(row) && !/\s(?:at|in)\s/.test(row)) {eslintFile = row; continue;}
    match = /^(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}(\S+))?$/.exec(row);
    if (match && eslintFile) {add(match[4], 'ESLint', eslintFile, match[1], match[2], match[5], match[3] as 'error' | 'warning'); continue;}
    match = /^File "(.+)", line (\d+)(?:, in (.*))?$/.exec(row);
    if (match) {add(row, 'Python', match[1], match[2]); continue;}
    match = /^-->\s*(.+):(\d+):(\d+)$/.exec(row);
    if (match) {add(row, 'Rust', match[1], match[2], match[3]); continue;}
    match = /(?:at\s+.*?\()?((?:[A-Za-z]:[\\/]|\/|\.\.?[\\/])[^()]+):(\d+):(\d+)\)?$/.exec(row);
    if (match) {add(row, 'Runtime', match[1], match[2], match[3]); continue;}
    if (/^(?:\w*(?:Error|Exception):|error(?:\[|:|\s)|fatal:|FAIL\b|FAILED\b|npm ERR!|ERR_)/i.test(row)) add(row, /^(?:fatal:|error:.*git)/.test(row) ? 'Git' : 'Process');
  }
  if (result.exitCode !== 0 && !entries.length) add(result.timedOut ? 'Command timed out.' : `Command exited with code ${result.exitCode ?? 'unknown'}.`, 'Process');
  return entries;
}
