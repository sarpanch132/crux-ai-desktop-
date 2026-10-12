import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, unlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import type { Skill, Capability } from './contracts.js';
import { PermissionGateway, canonicalPath } from './permissionGateway.js';

const MAX_SIZE = 64 * 1024;
export function parseSkill(source: string, location: string): Skill {
  if (Buffer.byteLength(source) > MAX_SIZE) throw new Error('Skill exceeds the 64 KiB limit.');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(source);
  if (!match) throw new Error('SKILL.md must contain a frontmatter block and instructions.');
  const metadata: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  let listKey = '';
  const lines = match[1].split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const listItem = /^\s+-\s+(.+)$/.exec(line);
    if (listItem && listKey) { (lists[listKey] ||= []).push(listItem[1].trim().replace(/^['"]|['"]$/g, '')); continue; }
    // Unknown nested YAML metadata is data, never an executable or granting rule.
    if (/^\s/.test(line)) continue;
    const item = /^([a-zA-Z][\w-]*):\s*(.*?)\s*$/.exec(line);
    if (!item) throw new Error('Use simple frontmatter fields or bounded text block scalars.');
    const key = item[1]; const value = item[2];
    listKey = value === '' && ['tool-requirements', 'toolRequirements', 'definition-of-done', 'definitionOfDone'].includes(key) ? key : '';
    if (/^[|>][+-]?$/.test(value)) {
      const block: string[] = [];
      while (index + 1 < lines.length && (!lines[index + 1].trim() || /^\s/.test(lines[index + 1]))) block.push(lines[++index].trim());
      metadata[key] = value.startsWith('>') ? block.join(' ').replace(/\s+/g, ' ').trim() : block.join('\n').trim();
    } else {
      metadata[key] = value.startsWith('"') ? JSON.parse(value) as string : value.replace(/^'(.*)'$/, '$1').replace(/''/g, "'");
      if (typeof metadata[key] !== 'string') throw new Error('Skill metadata must be text.');
    }
  }
  const name = metadata.name;
  const description = metadata.description;
  const instructions = match[2].trim();
  if (!name || name.length > 100 || !description || description.length > 1000 || !instructions) throw new Error('Skill requires name, description, and instructions.');
  const requirements = lists['tool-requirements'] || lists.toolRequirements || (metadata['tool-requirements'] || metadata.toolRequirements || '').replace(/^\[|\]$/g, '').split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  const valid: Capability[] = ['read', 'write', 'delete', 'execute', 'gitRead', 'gitMutate', 'browser', 'computerControl', 'installDependencies'];
  if (requirements.some(r => !valid.includes(r as Capability))) throw new Error('Skill declares an unknown capability.');
  return { id: createHash('sha256').update(name).digest('hex').slice(0, 24), name, description, instructions, toolRequirements: requirements as Capability[], definitionOfDone: lists['definition-of-done'] || lists.definitionOfDone || (metadata['definition-of-done'] || metadata.definitionOfDone || '').split('|').map(s => s.trim()).filter(Boolean), source: location };
}

export class SkillRegistry {
  constructor(private storageDirectory: string, private gateway: PermissionGateway) {}
  async list(): Promise<Skill[]> {
    let names: string[];
    try { names = await readdir(this.storageDirectory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const skills: Skill[] = [];
    for (const name of names.filter(n => /^[a-f0-9]{24}\.md$/.test(n))) {
      const location = path.join(this.storageDirectory, name);
      const info = await lstat(location);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SIZE) continue;
      try { skills.push(parseSkill(await readFile(location, 'utf8'), location)); } catch { /* Invalid local files never become active instructions. */ }
    }
    return skills;
  }
  async install(filePath: string): Promise<Skill> {
    await this.gateway.authorize({ capability: 'read', target: filePath });
    const location = await canonicalPath(filePath);
    const info = await lstat(location);
    if (!info.isFile() || info.size > MAX_SIZE) throw new Error('Select a SKILL.md file smaller than 64 KiB.');
    const source = await readFile(location, 'utf8');
    return this.save(source, location);
  }
  async build(name: string, description: string, instructions: string): Promise<Skill> {
    if ([name, description].some(s => typeof s !== 'string' || /[\r\n]/.test(s)) || typeof instructions !== 'string') throw new Error('Invalid skill fields.');
    return this.save(`---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n${instructions}`, 'Built in Crux AI');
  }
  async remove(id: string): Promise<void> {
    if (!/^[a-f0-9]{24}$/.test(id)) throw new Error('Invalid skill identifier.');
    const location = path.join(this.storageDirectory, `${id}.md`);
    await this.gateway.authorize({ capability: 'installDependencies', target: location, payload: { remove: id }, destructive: true });
    await unlink(location);
    this.gateway.audit('skill:remove', location, 'completed', 'Skill removed; permissions unchanged');
  }
  private async save(source: string, origin: string): Promise<Skill> {
    const skill = parseSkill(source, origin);
    const location = path.join(this.storageDirectory, `${skill.id}.md`);
    await this.gateway.authorize({ capability: 'installDependencies', target: location, payload: source });
    await mkdir(this.storageDirectory, { recursive: true });
    // wx prevents an existing symlink or unnoticed overwrite from replacing arbitrary files.
    await writeFile(location, source, { encoding: 'utf8', flag: 'wx' });
    this.gateway.audit('skill:install', location, 'completed', 'Declarative instructions installed; no scripts executed or permissions granted');
    return { ...skill, source: location };
  }
}
