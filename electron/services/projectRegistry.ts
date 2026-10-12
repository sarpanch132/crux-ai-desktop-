import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export async function projectDirectory(value: unknown): Promise<string> {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('Invalid project directory.');
  const canonical = await realpath(value);
  if (!(await stat(canonical)).isDirectory()) throw new Error('Project directory no longer exists.');
  return canonical;
}

export async function recordedProject(value: unknown, recorded: string[]): Promise<string> {
  if (typeof value !== 'string' || !recorded.includes(value)) throw new Error('Choose this folder using Open Project first.');
  const canonical = await projectDirectory(value);
  // A recorded symlink must not silently grant authority to a new target.
  if (path.normalize(canonical) !== path.normalize(value)) throw new Error('Project directory changed. Choose it using Open Project again.');
  return canonical;
}
