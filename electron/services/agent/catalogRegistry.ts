import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, readdir, lstat, realpath } from 'node:fs/promises';
import { existsSync, lstatSync, realpathSync, writeFileSync, renameSync, mkdirSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentDefinition, Capability, CatalogSnapshot, DefinitionDraft, DefinitionIcon, DefinitionKind, DefinitionMetadata, SkillDefinition, SkillProvenance } from './contracts.js';
import { parseSkill } from './skillRegistry.js';
import { prepareGithubSkill, safeImportPath, type GithubTransport, type PreparedSkillImport } from './githubSkillSource.js';

export const CATALOG_CAPABILITIES: Capability[] = ['read', 'write', 'delete', 'execute', 'gitRead', 'gitMutate', 'browser', 'computerControl', 'installDependencies'];
export const DEFINITION_ICONS: DefinitionIcon[] = ['sparkles', 'bot', 'code', 'search', 'shield', 'terminal', 'book', 'wrench', 'pen', 'chart', 'globe', 'flask'];
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);

export function validateLogoDataUrl(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 180000) throw new Error('Logo must be a bounded PNG, JPEG or WebP image.');
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4) throw new Error('Logo must be a PNG, JPEG or WebP data URL.');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > 128 * 1024 || bytes.toString('base64') !== match[2]) throw new Error('Logo exceeds 128 KiB or has invalid encoding.');
  let width = 0; let height = 0;
  if (match[1] === 'png' && bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(8) === 13) {
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (match[1] === 'jpeg' && bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217) {
    for (let offset = 2; offset + 4 <= bytes.length;) {
      if (bytes[offset++] !== 255) break;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 255 || marker === 0 || marker >= 208 && marker <= 215) continue;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([192, 193, 194].includes(marker) && length >= 8) {height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break;}
      offset += length;
    }
  } else if (match[1] === 'webp' && bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) === bytes.length - 8) {
    const type = bytes.toString('ascii', 12, 16);
    if (type === 'VP8X') {width = bytes.readUIntLE(24, 3) + 1; height = bytes.readUIntLE(27, 3) + 1;}
    else if (type === 'VP8 ' && bytes.subarray(23, 26).equals(Buffer.from([157, 1, 42]))) {width = bytes.readUInt16LE(26) & 16383; height = bytes.readUInt16LE(28) & 16383;}
    else if (type === 'VP8L' && bytes[20] === 47) {const bits = bytes.readUInt32LE(21); width = (bits & 16383) + 1; height = ((bits >>> 14) & 16383) + 1;}
  }
  if (!width || !height || width > 512 || height > 512) throw new Error('Logo signature or dimensions are invalid; use an image up to 512×512.');
  return value;
}
function text(value: unknown, label: string, max: number, required = true): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || required && !value.trim()) throw new Error(`Invalid ${label}.`);
  return value.trim();
}
function list(value: unknown, label: string, max: number, itemMax = 100): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw new Error(`Invalid ${label}.`);
  const result = value.map(item => text(item, label, itemMax));
  if (new Set(result).size !== result.length) throw new Error(`${label} must contain unique values.`);
  return result;
}
function capabilities(value: unknown): Capability[] {
  const result = list(value, 'capabilities', CATALOG_CAPABILITIES.length);
  if (result.some(item => !CATALOG_CAPABILITIES.includes(item as Capability))) throw new Error('Unknown capability.');
  return result as Capability[];
}
function metadata(draft: DefinitionDraft, id: string, revision: number, createdAt: number): DefinitionMetadata {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw new Error('Invalid definition.');
  const handle = text(draft.handle, 'handle', 32).toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(handle)) throw new Error('Handle must begin with a lowercase letter and contain only letters, digits, hyphens and underscores.');
  if (draft.enabled !== undefined && typeof draft.enabled !== 'boolean') throw new Error('Enabled must be boolean.');
  const icon = draft.icon ?? 'sparkles';
  if (!DEFINITION_ICONS.includes(icon)) throw new Error('Choose a supported icon.');
  const logoDataUrl = validateLogoDataUrl(draft.logoDataUrl);
  return {id, revision, name: text(draft.name, 'name', 100), handle, description: text(draft.description ?? '', 'description', 1000, false),
    enabled: draft.enabled ?? true, icon, ...(logoDataUrl ? {logoDataUrl} : {}), keywords: list(draft.keywords, 'keywords', 20, 120),
    instructions: text(draft.instructions, 'instructions', 64 * 1024), callableAgentIds: list(draft.callableAgentIds, 'callable agents', 20),
    callableSkillIds: list(draft.callableSkillIds, 'callable skills', 20), createdAt, updatedAt: Date.now()};
}
export function validateCatalog(catalog: CatalogSnapshot): void {
  if (!Number.isSafeInteger(catalog.revision) || catalog.revision < 0 || !Array.isArray(catalog.agents) || !Array.isArray(catalog.skills) || catalog.agents.length > 100 || catalog.skills.length > 100) throw new Error('Catalog exceeds supported bounds.');
  const definitions = [...catalog.agents, ...catalog.skills]; const handles = new Set<string>(); const ids = new Set<string>();
  for (const item of definitions) {
    if (!validId(item.id) || ids.has(item.id) || !Number.isSafeInteger(item.revision) || item.revision < 1) throw new Error('Invalid or duplicate definition identifier/revision.');
    metadata(item, item.id, item.revision, item.createdAt);
    if (item.handle !== item.handle.toLowerCase() || handles.has(item.handle)) throw new Error('Agent and skill handles must be unique.');
    if (Buffer.byteLength(JSON.stringify({...item, logoDataUrl: undefined})) > 64 * 1024 || Buffer.byteLength(JSON.stringify(item)) > 256 * 1024) throw new Error('Definition text exceeds 64 KiB or its total storage exceeds 256 KiB.');
    handles.add(item.handle); ids.add(item.id);
  }
  for (const agent of catalog.agents) {capabilities(agent.allowedCapabilities); list(agent.skillIds, 'attached skills', 5);}
  for (const skill of catalog.skills) {capabilities(skill.toolRequirements); list(skill.definitionOfDone, 'definition of done', 20, 500);}
  const graph = new Map<string, string[]>();
  for (const item of definitions) {
    const agentIds = item.callableAgentIds;
    const skillIds = [...item.callableSkillIds, ...('skillIds' in item ? item.skillIds : [])];
    if (agentIds.some(id => !catalog.agents.some(agent => agent.id === id)) || skillIds.some(id => !catalog.skills.some(skill => skill.id === id))) throw new Error('A definition references a missing agent or skill. Remove dependent references before deleting.');
    graph.set(item.id, [...new Set([...agentIds, ...skillIds])]);
  }
  const visiting = new Set<string>(); const depths = new Map<string, number>();
  const visit = (id: string): number => {
    if (visiting.has(id)) throw new Error('Callable agent/skill references must not contain cycles.');
    const known = depths.get(id); if (known !== undefined) return known;
    visiting.add(id);
    const depth = 1 + Math.max(0, ...(graph.get(id) ?? []).map(visit));
    visiting.delete(id);
    if (depth > 8) throw new Error('Callable references exceed the maximum graph depth.');
    depths.set(id, depth); return depth;
  };
  for (const id of graph.keys()) visit(id);
}

export class CatalogRegistry {
  private snapshot: CatalogSnapshot = {revision: 0, agents: [], skills: []};
  private initialized?: Promise<void>; private pending: Promise<unknown> = Promise.resolve(); private root = '';
  constructor(private storagePath: string, private assertIdle: () => void = () => {}) {}
  private async initialize(): Promise<void> {
    if (!this.initialized) this.initialized = this.load();
    return this.initialized;
  }
  private async load(): Promise<void> {
    await mkdir(this.storagePath, {recursive: true}); this.root = await realpath(this.storagePath);
    const filename = path.join(this.root, 'catalog.json');
    if (existsSync(filename)) {
      const info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024) throw new Error('Catalog storage is unsafe or too large.');
      const saved = JSON.parse(await readFile(filename, 'utf8')) as CatalogSnapshot;
      validateCatalog(saved); this.snapshot = saved; return;
    }
    const legacyDirectory = path.join(this.root, 'skills'); let names: string[] = [];
    try {
      const info = await lstat(legacyDirectory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Legacy skill storage is unsafe.');
      names = await readdir(legacyDirectory);
    } catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
    for (const filename of names.filter(name => /^[a-f0-9]{24}\.md$/.test(name)).sort()) {
      const location = path.join(legacyDirectory, filename); const info = await lstat(location);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) continue;
      try {
        const skill = parseSkill(await readFile(location, 'utf8'), location);
        if (this.snapshot.skills.some(item => item.id === skill.id)) continue;
        const base = this.handleFor(skill.name); let handle = base;
        for (let suffix = 2; this.snapshot.skills.some(item => item.handle === handle); suffix++) handle = `${base.slice(0, 27)}-${suffix}`;
        const common = metadata({name: skill.name, handle, description: skill.description, instructions: skill.instructions, enabled: false, icon: 'book'}, skill.id, 1, Date.now());
        this.snapshot.skills.push({...skill, ...common, provenance: {kind: 'legacy'}});
      } catch { /* Malformed legacy files never become routing definitions. */ }
    }
    if (this.snapshot.skills.length) {this.snapshot.revision = 1; validateCatalog(this.snapshot); this.commit(this.snapshot);}
  }
  private handleFor(name: string): string {return name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/^[^a-z]+/, '') || 'skill';}
  private ownedDirectory(directory: string): void {
    const relative = path.relative(this.root, directory);
    if (relative.startsWith('..') || path.isAbsolute(relative) || realpathSync(this.root) !== this.root) throw new Error('Catalog path escaped owned storage.');
    let current = this.root;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      if (existsSync(current)) {const info = lstatSync(current); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Catalog storage contains an unsafe directory.');}
    }
  }
  private commit(next: CatalogSnapshot, beforeCommit?: () => void): void {
    this.assertIdle(); this.ownedDirectory(this.root);
    const filename = path.join(this.root, 'catalog.json');
    if (existsSync(filename) && (lstatSync(filename).isSymbolicLink() || !lstatSync(filename).isFile())) throw new Error('Unsafe catalog file.');
    const temporary = path.join(this.root, `.catalog-${randomUUID()}.tmp`);
    writeFileSync(temporary, JSON.stringify(next), {encoding: 'utf8', flag: 'wx'});
    try {this.assertIdle(); beforeCommit?.(); renameSync(temporary, filename);}
    catch (error) {if (existsSync(temporary)) rmSync(temporary); throw error;}
  }
  async list(): Promise<CatalogSnapshot> {await this.initialize(); await this.pending; return clone(this.snapshot);}
  private mutate(operation: (next: CatalogSnapshot) => void, beforeCommit?: () => void): Promise<CatalogSnapshot> {
    const result = this.pending.then(async () => {
      await this.initialize(); this.assertIdle(); const next = clone(this.snapshot);
      operation(next); next.revision++; validateCatalog(next); this.commit(next, beforeCommit); this.snapshot = next; return clone(next);
    });
    this.pending = result.catch(() => undefined); return result;
  }
  private definition(kind: DefinitionKind, draft: DefinitionDraft, id: string, revision: number, createdAt: number, previous?: SkillDefinition): AgentDefinition | SkillDefinition {
    const common = metadata(draft, id, revision, createdAt);
    if (kind === 'agent') return {...common, allowedCapabilities: capabilities(draft.allowedCapabilities ?? ['read', 'gitRead']), skillIds: list(draft.skillIds, 'attached skills', 5)};
    return {...common, toolRequirements: capabilities(draft.toolRequirements), definitionOfDone: list(draft.definitionOfDone, 'definition of done', 20, 500), source: previous?.source ?? 'Built in Crux AI', provenance: previous?.provenance ?? {kind: 'created'}};
  }
  createAgent(draft: DefinitionDraft): Promise<CatalogSnapshot> {return this.create('agent', draft);}
  createSkill(draft: DefinitionDraft): Promise<CatalogSnapshot> {return this.create('skill', draft);}
  private create(kind: DefinitionKind, draft: DefinitionDraft): Promise<CatalogSnapshot> {
    return this.mutate(next => {
      const item = this.definition(kind, draft, randomUUID(), 1, Date.now());
      if (kind === 'agent') next.agents.push(item as AgentDefinition); else next.skills.push(item as SkillDefinition);
    });
  }
  updateAgent(id: string, expectedRevision: number, draft: DefinitionDraft): Promise<CatalogSnapshot> {return this.update('agent', id, expectedRevision, draft);}
  updateSkill(id: string, expectedRevision: number, draft: DefinitionDraft): Promise<CatalogSnapshot> {return this.update('skill', id, expectedRevision, draft);}
  private update(kind: DefinitionKind, id: string, revision: number, draft: DefinitionDraft): Promise<CatalogSnapshot> {
    return this.mutate(next => {
      const items = kind === 'agent' ? next.agents : next.skills; const index = items.findIndex(item => item.id === id);
      const previous = items[index];
      if (!previous || previous.revision !== revision) throw new Error('Definition changed or no longer exists. Refresh before saving.');
      const item = this.definition(kind, draft, id, revision + 1, previous.createdAt, kind === 'skill' ? previous as SkillDefinition : undefined);
      if (kind === 'agent') next.agents[index] = item as AgentDefinition; else next.skills[index] = item as SkillDefinition;
    });
  }
  removeAgent(id: string, revision: number): Promise<CatalogSnapshot> {return this.remove('agent', id, revision);}
  removeSkill(id: string, revision: number): Promise<CatalogSnapshot> {return this.remove('skill', id, revision);}
  private async remove(kind: DefinitionKind, id: string, revision: number): Promise<CatalogSnapshot> {
    let removeDirectory = false;
    const result = await this.mutate(next => {
      const items = kind === 'agent' ? next.agents : next.skills;
      const item = items.find(entry => entry.id === id);
      if (!item || item.revision !== revision) throw new Error('Definition changed or no longer exists. Refresh before removing.');
      const dependents = [...next.agents, ...next.skills].filter(entry => entry.callableAgentIds.includes(id) || entry.callableSkillIds.includes(id) || 'skillIds' in entry && entry.skillIds.includes(id));
      if (dependents.length) throw new Error(`Remove references from ${dependents.map(entry => '@' + entry.handle).join(', ')} before deleting.`);
      removeDirectory = kind === 'skill' && ['local', 'github'].includes((item as SkillDefinition).provenance.kind);
      if (kind === 'agent') next.agents = next.agents.filter(entry => entry.id !== id); else next.skills = next.skills.filter(entry => entry.id !== id);
    });
    if (removeDirectory) {
      const directory = path.join(this.root, 'skills', 'imports', id);
      if (existsSync(directory)) {this.assertIdle(); this.ownedDirectory(directory); rmSync(directory, {recursive: true});}
    }
    return result;
  }
  prepareGithub(url: string, transport?: GithubTransport, signal?: AbortSignal): Promise<PreparedSkillImport> {this.assertIdle(); return prepareGithubSkill(url, transport, signal);}
  async prepareLocal(filePath: string): Promise<PreparedSkillImport> {
    this.assertIdle(); const canonical = await realpath(filePath); const info = await lstat(canonical);
    if (!info.isFile() || info.size > 64 * 1024) throw new Error('Choose a SKILL.md file smaller than 64 KiB.');
    const content = await readFile(canonical); const skill = parseSkill(content.toString('utf8'), canonical);
    const id = createHash('sha256').update(canonical).update(content).digest('hex').slice(0, 24);
    return {kind: 'local', skill, files: [{path: 'SKILL.md', content}], summary: {sourceUrl: canonical, commit: '', destinationName: id, fileCount: 1, totalBytes: content.length, name: skill.name}};
  }
  async installPrepared(prepared: PreparedSkillImport): Promise<CatalogSnapshot> {
    await this.initialize(); this.assertIdle();
    const id = prepared.summary.destinationName;
    if (!/^[a-f0-9]{24}$/.test(id)) throw new Error('Invalid prepared import identifier.');
    const imports = path.join(this.root, 'skills', 'imports'); this.ownedDirectory(imports); mkdirSync(imports, {recursive: true});
    const stage = path.join(imports, `.stage-${randomUUID()}`); this.ownedDirectory(stage); mkdirSync(stage);
    const destination = path.join(imports, id); let installed = false;
    try {
      const seen = new Set<string>(); const segments = new Map<string, string>(); let bytes = 0;
      if (!prepared.files.length || prepared.files.length > 100) throw new Error('Invalid prepared file count.');
      for (const file of prepared.files) {
        const relative = safeImportPath(file.path); const key = relative.toLowerCase();
        if (seen.has(key) || !Buffer.isBuffer(file.content) || file.content.length > 1024 * 1024) throw new Error('Unsafe prepared supporting file.');
        const parts = relative.split('/');
        for (let length = 1; length <= parts.length; length++) {
          const partial = parts.slice(0, length).join('/'); const folded = partial.toLowerCase();
          if (segments.has(folded) && segments.get(folded) !== partial) throw new Error('Case-colliding paths cannot be imported.');
          segments.set(folded, partial);
        }
        if (/\.(?:zip|tar|gz|7z|rar|exe|dll|msi)$/i.test(relative)) throw new Error('Archives and executable binaries are prohibited.');
        seen.add(key); bytes += file.content.length;
        if (bytes > 8 * 1024 * 1024) throw new Error('Prepared import exceeds total byte limits.');
        const location = path.join(stage, ...relative.split('/')); this.ownedDirectory(path.dirname(location)); mkdirSync(path.dirname(location), {recursive: true});
        writeFileSync(location, file.content, {flag: 'wx'});
      }
      const definitionFile = prepared.files.find(file => file.path === 'SKILL.md');
      if (!definitionFile) throw new Error('Prepared import has no SKILL.md.');
      const skill = parseSkill(definitionFile.content.toString('utf8'), path.join(destination, 'SKILL.md'));
      const draft: DefinitionDraft = {name: skill.name, description: skill.description, handle: this.handleFor(skill.name), instructions: `Installed SKILL.md: ${path.join(destination, 'SKILL.md')}\nSupporting resources: ${destination}\nResolve skill resource paths against this folder, never the project folder.\n\n${skill.instructions}`, enabled: true, icon: 'book', toolRequirements: skill.toolRequirements, definitionOfDone: skill.definitionOfDone};
      const provenance: SkillProvenance = {kind: prepared.kind, sourceUrl: prepared.summary.sourceUrl, ...(prepared.summary.commit ? {commit: prepared.summary.commit} : {}), importedAt: Date.now(), fileCount: prepared.files.length, totalBytes: bytes};
      return await this.mutate(next => {
        if (next.skills.some(item => item.id === id)) throw new Error('This skill source is already installed.');
        next.skills.push({...skill, ...metadata(draft, id, 1, Date.now()), provenance});
      }, () => {
        this.ownedDirectory(imports);
        this.ownedDirectory(stage);
        const expected = new Map(prepared.files.map(file => [file.path, file.content]));
        const directories = new Set<string>();
        for (const file of prepared.files) {
          const parts = file.path.split('/');
          for (let length = 1; length < parts.length; length++) directories.add(parts.slice(0, length).join('/'));
        }
        let verified = 0;
        const verify = (directory: string, prefix: string) => {
          const entries = readdirSync(directory);
          if (entries.length > 150) throw new Error('Staged import changed unexpectedly.');
          for (const entry of entries) {
            const relative = prefix ? `${prefix}/${entry}` : entry; const location = path.join(directory, entry); const info = lstatSync(location);
            if (info.isSymbolicLink()) throw new Error('Staged import contains a symlink.');
            if (info.isDirectory() && directories.has(relative)) verify(location, relative);
            else if (!info.isFile() || !expected.has(relative) || info.size > 1024 * 1024 || !readFileSync(location).equals(expected.get(relative)!)) throw new Error('Staged import changed unexpectedly.');
            else verified++;
          }
        };
        verify(stage, '');
        if (verified !== expected.size) throw new Error('Staged import is missing supporting files.');
        if (existsSync(destination)) throw new Error('Skill destination already exists; imports never overwrite it.');
        renameSync(stage, destination); installed = true;
      });
    } catch (error) {
      if (installed && existsSync(destination)) {this.ownedDirectory(destination); rmSync(destination, {recursive: true});}
      throw error;
    } finally {
      if (existsSync(stage)) {this.ownedDirectory(stage); rmSync(stage, {recursive: true});}
    }
  }
}
