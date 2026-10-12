import { request } from 'node:https';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Skill } from './contracts.js';
import { parseSkill } from './skillRegistry.js';

export interface ImportedSkillFile { path: string; content: Buffer; }
export interface PreparedSkillImport {
  skill: Skill; files: ImportedSkillFile[];
  summary: {sourceUrl: string; commit: string; destinationName: string; fileCount: number; totalBytes: number; name: string};
  kind: 'github' | 'local';
}
export type GithubTransport = (url: string, limit: number, signal?: AbortSignal) => Promise<Buffer>;
const HOSTS = new Set(['api.github.com', 'raw.githubusercontent.com', 'github.com']);
const MAX_FILES = 100; const MAX_FILE = 1024 * 1024; const MAX_TOTAL = 8 * 1024 * 1024;

export function safeImportPath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 500 || value.includes('\\')) throw new Error('Unsafe imported path.');
  const parts = value.split('/');
  if (parts.length > 8 || parts.some(part => !part || part === '.' || part === '..' || /[<>:"|?*]/.test(part) || Array.from(part).some(char => char.charCodeAt(0) < 32) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Unsafe imported path segment.');
  return parts.join('/');
}
function safeUrl(value: string, internal = false): URL {
  const rawPath = value.replace(/^https:\/\/[^/]+/i, '').split(/[?#]/)[0];
  if (rawPath.split('/').some(segment => {const decoded = decodeURIComponent(segment); return decoded === '.' || decoded === '..' || decoded.includes('\\') || decoded.includes('/');})) throw new Error('Unsafe GitHub URL path.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.port || url.username || url.password || (url.search && !(internal && url.hostname === 'api.github.com' && (/^\?ref=[a-f0-9]{40}$/.test(url.search) || /^\/repos\/[^/]+\/[^/]+\/git\/trees\/[a-f0-9]{40}$/.test(url.pathname) && url.search === '?recursive=1'))) || url.hash) throw new Error('Use an HTTPS GitHub URL without credentials, ports, queries, or fragments.');
  return url;
}
export function publicAddress(address: string): boolean {
  if (isIP(address) === 6) return /^[23]/.test(address) && !/^2001:(?:db8|0:|10:)/i.test(address);
  if (isIP(address) !== 4) return false;
  const p = address.split('.').map(Number);
  return !(p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224 || p[0] === 169 && p[1] === 254 || p[0] === 172 && p[1] >= 16 && p[1] <= 31 || p[0] === 192 && [0, 168].includes(p[1]) || p[0] === 100 && p[1] >= 64 && p[1] <= 127 || p[0] === 198 && [18, 19, 51].includes(p[1]) || p[0] === 203 && p[1] === 0);
}
function checkAbort(signal?: AbortSignal): void {if (signal?.aborted) throw new Error('Skill import canceled.');}
function cancellable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  checkAbort(signal);
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('Skill import canceled.'));
    signal.addEventListener('abort', abort, {once: true});
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
export const fetchGithub: GithubTransport = async (value, limit, signal) => {
  checkAbort(signal);
  const url = safeUrl(value, true);
  const addresses = await cancellable(lookup(url.hostname, {all: true}), signal);
  checkAbort(signal);
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('GitHub resolved to a prohibited network address.');
  const chosen = addresses[0];
  return new Promise<Buffer>((resolve, reject) => {
    const req = request(url, {agent: false, method: 'GET', signal, family: chosen.family, headers: {'User-Agent': 'Crux-Skill-Importer', Accept: url.hostname === 'api.github.com' && /\/commits\//.test(url.pathname) ? 'application/vnd.github.sha' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'},
      lookup: (_host, _options, callback) => callback(null, chosen.address, chosen.family)}, response => {
      if (response.statusCode !== 200) {response.destroy(); reject(new Error(`GitHub import request failed (HTTP ${response.statusCode ?? 'unknown'}). Redirects are not followed.`)); return;}
      if (Number(response.headers['content-length'] ?? 0) > limit) {response.destroy(); reject(new Error('GitHub response exceeds import limits.')); return;}
      const chunks: Buffer[] = []; let length = 0;
      response.on('data', chunk => {
        length += chunk.length;
        if (length > limit) {response.destroy(new Error('GitHub response exceeds import limits.')); return;}
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks))); response.on('error', reject);
    });
    req.setTimeout(10000, () => req.destroy(new Error('GitHub import timed out.')));
    req.on('error', reject); req.end();
  });
};

interface Locator {owner: string; repo: string; ref: string; directory: string; sourceUrl: string;}
export function githubLocator(value: string): Locator {
  if (typeof value !== 'string' || value.length > 1000) throw new Error('Enter a bounded GitHub URL.');
  const url = safeUrl(value);
  if (url.hostname === 'api.github.com') throw new Error('Paste a GitHub repository, tree, blob, or raw SKILL.md URL.');
  const parts = url.pathname.split('/').filter(Boolean).map(segment => decodeURIComponent(segment));
  const owner = parts[0]; const repo = parts[1]?.replace(/\.git$/, '');
  if (!owner || !repo || !/^[a-zA-Z0-9_.-]+$/.test(owner) || !/^[a-zA-Z0-9_.-]+$/.test(repo)) throw new Error('Invalid GitHub owner or repository.');
  let ref = 'HEAD'; let location: string[] = [];
  if (url.hostname === 'raw.githubusercontent.com') {ref = parts[2]; location = parts.slice(3);}
  else if (parts.length > 2) {
    if (!['tree', 'blob', 'raw'].includes(parts[2])) throw new Error('Use a repository or an explicit skill tree/blob URL.');
    ref = parts[3]; location = parts.slice(4);
    if (parts[2] !== 'tree' && location[location.length - 1] !== 'SKILL.md') throw new Error('A blob or raw URL must identify SKILL.md.');
  }
  if (!ref || !/^[a-zA-Z0-9_.-]{1,200}$/.test(ref) || ['.', '..'].includes(ref)) throw new Error('Use an unambiguous branch/tag/commit without slashes.');
  if (location[location.length - 1] === 'SKILL.md') location.pop();
  if (url.hostname === 'raw.githubusercontent.com' && parts[parts.length - 1] !== 'SKILL.md') throw new Error('A raw URL must identify SKILL.md.');
  const directory = location.length ? safeImportPath(location.join('/')) : '';
  return {owner, repo, ref, directory, sourceUrl: url.href};
}

async function prepareGithubBounded(value: string, transport: GithubTransport, signal: AbortSignal): Promise<PreparedSkillImport> {
  const locator = githubLocator(value); const started = Date.now();
  const api = `https://api.github.com/repos/${locator.owner}/${locator.repo}`;
  const read = async (url: string, limit: number) => {
    if (Date.now() - started > 30000) throw new Error('GitHub import exceeded the 30 second limit.');
    checkAbort(signal);
    const response = await cancellable(transport(url, limit, signal), signal);
    checkAbort(signal);
    if (Date.now() - started > 30000 || response.length > limit) throw new Error('GitHub import exceeded time or byte limits.');
    return response;
  };
  const commitResponse = (await read(`${api}/commits/${encodeURIComponent(locator.ref)}`, MAX_FILE)).toString('utf8').trim();
  const commitData = /^[a-f0-9]{40}$/i.test(commitResponse) ? {sha: commitResponse} : JSON.parse(commitResponse) as {sha?: unknown};
  if (typeof commitData.sha !== 'string' || !/^[a-f0-9]{40}$/i.test(commitData.sha)) throw new Error('GitHub did not return an immutable commit.');
  const commit = commitData.sha.toLowerCase();
  const files: ImportedSkillFile[] = []; const downloads: Array<{path:string; url:string; size:number}> = []; const names = new Set<string>(); let totalBytes = 0;
  const contents = async (directory: string, relative: string, depth: number): Promise<void> => {
    if (depth > 8) throw new Error('Skill folder exceeds the nesting limit.');
    // ref is an importer-generated immutable commit, never a user query.
    const url = `${api}/contents${directory ? '/' + directory.split('/').map(encodeURIComponent).join('/') : ''}?ref=${commit}`;
    // The transport allows only this internally generated GitHub API query.
    const entries = JSON.parse((await read(url, 512 * 1024)).toString('utf8')) as unknown;
    if (!Array.isArray(entries) || entries.length > MAX_FILES) throw new Error('Select a skill folder containing SKILL.md and at most 100 files.');
    if (depth === 0 && !entries.some(entry => entry && typeof entry === 'object' && entry.name === 'SKILL.md' && entry.type === 'file')) {
      if (locator.directory) throw new Error('The selected folder must contain SKILL.md. Use its explicit GitHub tree/blob URL.');
      const tree = JSON.parse((await read(`${api}/git/trees/${commit}?recursive=1`, MAX_TOTAL)).toString('utf8')) as {truncated?:boolean; tree?:Array<{path?:unknown; type?:unknown; mode?:unknown}>};
      if (tree.truncated || !Array.isArray(tree.tree) || tree.tree.length > 5000) throw new Error('Repository is too large to discover skills. Paste the specific skill folder URL.');
      const candidates = tree.tree.filter(item=>item.type==='blob' && (item.mode==='100644'||item.mode==='100755') && typeof item.path==='string' && item.path.endsWith('/SKILL.md')).map(item=>safeImportPath((item.path as string).slice(0,-9)));
      const name = locator.repo.replace(/[-_]skills?$/i,'').toLowerCase();
      const named = candidates.filter(directory=>directory.split('/').at(-1)?.toLowerCase()===name);
      const canonical = named.filter(directory=>/^\.claude\/skills\/[^/]+$/.test(directory));
      const choices = canonical.length===1 ? canonical : named.length ? named : candidates;
      if (choices.length!==1) throw new Error(choices.length ? `Multiple skills found. Paste a specific folder URL: ${choices.slice(0,5).join(', ')}` : 'No SKILL.md found in this repository.');
      locator.directory = choices[0];
      await contents(locator.directory, '', 0); return;
    }
    for (const raw of entries) {
      if (!raw || typeof raw !== 'object') throw new Error('Malformed GitHub contents response.');
      const entry = raw as {name?: unknown; path?: unknown; type?: unknown; size?: unknown; submodule_git_url?: unknown};
      if (typeof entry.name !== 'string' || typeof entry.path !== 'string' || entry.submodule_git_url || !['file', 'dir'].includes(String(entry.type))) throw new Error('Symlinks, submodules and unsupported repository entries are prohibited.');
      const expected = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.path !== expected) throw new Error('GitHub contents escaped the selected skill folder.');
      const relativePath = safeImportPath(relative ? `${relative}/${entry.name}` : entry.name);
      const key = relativePath.toLowerCase();
      if (names.has(key)) throw new Error('Case-colliding paths cannot be imported.');
      names.add(key);
      if (names.size > 150) throw new Error('Skill folder exceeds the entry limit.');
      if (entry.type === 'dir') {await contents(expected, relativePath, depth + 1); continue;}
      if (downloads.length >= MAX_FILES || typeof entry.size !== 'number' || entry.size < 0 || entry.size > MAX_FILE) throw new Error('Skill supporting files exceed count or byte limits.');
      if (/\.(?:zip|tar|gz|7z|rar|exe|dll|msi)$/i.test(relativePath)) throw new Error('Archives and executable binaries are prohibited.');
      const rawUrl = `https://raw.githubusercontent.com/${locator.owner}/${locator.repo}/${commit}/${expected.split('/').map(encodeURIComponent).join('/')}`;
      totalBytes += entry.size;
      if (totalBytes > MAX_TOTAL) throw new Error('Skill supporting files exceed total byte limits.');
      downloads.push({path:relativePath, url:rawUrl, size:entry.size});
    }
  };
  await contents(locator.directory, '', 0);
  for (let index=0; index<downloads.length; index+=4) {
    const batch = await Promise.all(downloads.slice(index,index+4).map(async file=>{
      const content=await read(file.url,MAX_FILE);
      if(content.length!==file.size)throw new Error('Skill supporting file changed unexpectedly.');
      return {path:file.path,content};
    }));
    files.push(...batch);
  }
  const definition = files.find(file => file.path === 'SKILL.md');
  if (!definition) throw new Error('The selected folder must contain SKILL.md. Use its explicit GitHub tree/blob URL.');
  const skill = parseSkill(definition.content.toString('utf8'), locator.sourceUrl);
  return {kind: 'github', skill, files, summary: {sourceUrl: locator.sourceUrl, commit, destinationName: createHash('sha256').update(`${locator.owner.toLowerCase()}/${locator.repo.toLowerCase()}/${commit}/${locator.directory}`).digest('hex').slice(0, 24), fileCount: files.length, totalBytes, name: skill.name}};
}

export async function prepareGithubSkill(value: string, transport: GithubTransport = fetchGithub, signal?: AbortSignal): Promise<PreparedSkillImport> {
  checkAbort(signal); const controller = new AbortController();
  const cancel = () => controller.abort(); signal?.addEventListener('abort', cancel, {once: true});
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {return await prepareGithubBounded(value, transport, controller.signal);}
  finally {clearTimeout(timeout); signal?.removeEventListener('abort', cancel); controller.abort();}
}
