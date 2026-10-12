import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import path from 'node:path';
import type { ChangeDetail, TrackedChange } from './contracts.js';
import { canonicalPath, isWithin } from './permissionGateway.js';

export const contentHash = (content: string): string => createHash('sha256').update(content).digest('hex');
export const sensitivePath = (file: string): boolean => /(^|[\\/])(\.env(?:\.[^\\/]*)?|\.ssh|\.aws|\.azure|credentials|id_rsa|id_ed25519|[^\\/]*\.(?:pem|key))($|[\\/])/i.test(file);
const MAX_FILE = 2 * 1024 * 1024;
const MAX_SESSION = 16 * 1024 * 1024;

export async function textSnapshot(file: string): Promise<string | null> {
  if (sensitivePath(file)) throw new Error('Credential files cannot be copied into coding context or checkpoints.');
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE) throw new Error('Only regular text files up to 2 MiB can be checkpointed.');
    const bytes = await readFile(file);
    if (bytes.includes(0)) throw new Error('Binary files cannot be edited or checkpointed.');
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) throw new Error('File must contain valid UTF-8 text.');
    return text;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

/** Session-owned text checkpoints; no Git reset, index changes, or user baseline loss. */
export class ChangeStore {
  private records: ChangeDetail[] | undefined;
  private readonly file: string;
  constructor(storageDirectory: string, private workspace: string, sessionId: string) {
    this.file = path.join(storageDirectory, `${contentHash(sessionId)}.json`);
  }
  private async load(): Promise<ChangeDetail[]> {
    if (this.records) return this.records;
    try {
      const stat = await lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SESSION * 7) throw new Error('Invalid checkpoint store.');
      const stored = JSON.parse(await readFile(this.file, 'utf8')) as { workspace: string; records: ChangeDetail[] };
      if (stored.workspace !== this.workspace || !Array.isArray(stored.records)) throw new Error('Checkpoint workspace mismatch.');
      this.validate(stored.records);
      this.records = stored.records;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; this.records = []; }
    return this.records;
  }
  private validate(records: ChangeDetail[]): void {
    let bytes = 0;
    for (const record of records) {
      if (!record || typeof record.id !== 'string' || !/^[a-f0-9-]{36}$/.test(record.id) || typeof record.path !== 'string' || !['write', 'delete'].includes(record.operation) || typeof record.reviewed !== 'boolean' || !Number.isFinite(record.timestamp) || sensitivePath(record.path) || !isWithin(this.workspace, record.path)) throw new Error('Invalid checkpoint record.');
      for (const field of ['before', 'after'] as const) {
        const value = record[field];
        if (value !== null && (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > MAX_FILE)) throw new Error('Invalid checkpoint text.');
        if (record[`${field}Hash`] !== (value === null ? null : contentHash(value))) throw new Error('Checkpoint content integrity failed.');
        bytes += value === null ? 0 : Buffer.byteLength(value);
      }
    }
    if (bytes > MAX_SESSION || records.length > 1000) throw new Error('Session checkpoint limit reached. Review changes and start a new task.');
  }
  private async save(records: ChangeDetail[]): Promise<void> {
    this.validate(records);
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ workspace: this.workspace, records }), { mode: 0o600 });
    await rename(temporary, this.file);
    this.records = records;
  }
  async list(): Promise<TrackedChange[]> { return (await this.load()).map(({ before: _before, after: _after, ...record }) => record); }
  async detail(id: string): Promise<ChangeDetail> {
    const record = (await this.load()).find(item => item.id === id);
    if (!record) throw new Error('Change does not belong to this session.');
    if (!isWithin(await canonicalPath(this.workspace), await canonicalPath(record.path))) throw new Error('Checkpoint path is outside this project.');
    return { ...record };
  }
  async capture(file: string, after: string | null): Promise<ChangeDetail> {
    const target = await canonicalPath(file);
    if (!isWithin(await canonicalPath(this.workspace), target)) throw new Error('Checkpoints only support this project.');
    const before = await textSnapshot(target);
    const record: ChangeDetail = { id: randomUUID(), path: target, before, after, beforeHash: before === null ? null : contentHash(before), afterHash: after === null ? null : contentHash(after), operation: after === null ? 'delete' : 'write', timestamp: Date.now(), reviewed: false };
    this.validate([...(await this.load()), record]);
    return record;
  }
  async commit(records: ChangeDetail[]): Promise<void> { await this.save([...(await this.load()), ...records]); }
  async accept(id: string): Promise<TrackedChange[]> {
    const record = await this.detail(id);
    if ((await textSnapshot(record.path)) !== record.after) throw new Error('File changed since this checkpoint. Review the current file before accepting.');
    await this.save((await this.load()).map(item => item.id === id ? { ...item, reviewed: true } : item));
    return this.list();
  }
  async remove(id: string): Promise<void> { await this.detail(id); await this.save((await this.load()).filter(item => item.id !== id)); }
}
