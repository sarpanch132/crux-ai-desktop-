import path from 'node:path';
import type { FileService } from '../fileService.js';
import type { RepoContext, RepositoryMetadata } from './contracts.js';
import { sensitivePath } from './changeStore.js';

/** Bounded manifest metadata, never complete source trees or environment values. */
export async function inspectRepository(root: string, files: FileService): Promise<RepoContext> {
  const entries = await files.listFiles(root);
  const names = entries.map(file => path.relative(root, file.path).replace(/\\/g, '/'));
  const metadata: RepositoryMetadata = { languages: [], frameworks: [], packageManagers: [], sourceDirectories: [], tests: [], configuration: [], routes: [], databases: [], migrations: [], environmentNames: [], scripts: {}, monorepo: false, truncated: entries.length >= 5000 };
  const languages: Record<string, string> = { ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', py: 'Python', rs: 'Rust', go: 'Go', java: 'Java', cs: 'C#', cpp: 'C++', rb: 'Ruby', php: 'PHP' };
  for (const name of names) {
    const extension = name.split('.').pop() || '';
    if (languages[extension]) metadata.languages.push(languages[extension]);
    if (/(^|\/)(src|app|pages|server|client|frontend|backend)$/.test(name)) metadata.sourceDirectories.push(name);
    if (/(^|\/)(__tests__|tests?|specs?)(\/|$)|\.(test|spec)\./.test(name)) metadata.tests.push(name);
    if (/(^|\/)(api|routes?)(\/|$)/.test(name)) metadata.routes.push(name);
    if (/migrations?/.test(name)) metadata.migrations.push(name);
    if (/(^|\/)(prisma|drizzle|schema\.sql|database|db)(\/|\.|$)/.test(name)) metadata.databases.push(name);
    if (/config\.|(^|\/)(Dockerfile|docker-compose\.ya?ml|package\.json|pyproject\.toml|requirements\.txt|Cargo\.toml|go\.mod)$/.test(name)) metadata.configuration.push(name);
    if (/pnpm-lock\.yaml$|pnpm-workspace\.yaml$/.test(name)) metadata.packageManagers.push('pnpm');
    if (/yarn\.lock$/.test(name)) metadata.packageManagers.push('yarn');
    if (/package-lock\.json$/.test(name)) metadata.packageManagers.push('npm');
    if (/uv\.lock$/.test(name)) metadata.packageManagers.push('uv');
    if (/poetry\.lock$/.test(name)) metadata.packageManagers.push('Poetry');
    if (/requirements\.txt$/.test(name)) metadata.packageManagers.push('pip');
    if (/Cargo\.toml$/.test(name)) metadata.packageManagers.push('Cargo');
    if (/go\.mod$/.test(name)) metadata.packageManagers.push('Go modules');
  }
  const inspectedFiles: string[] = [];
  const manifests = entries.filter(file => file.type === 'file' && file.name === 'package.json' && file.size <= 128 * 1024).slice(0, 24);
  for (const file of manifests) {
    try {
      const manifest = JSON.parse(await files.readFile(file.path)) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string>; workspaces?: unknown; packageManager?: string };
      inspectedFiles.push(file.path);
      const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
      for (const [key, label] of Object.entries({ react: 'React', next: 'Next.js', vue: 'Vue', svelte: 'Svelte', express: 'Express', fastify: 'Fastify', electron: 'Electron', vite: 'Vite', vitest: 'Vitest', jest: 'Jest', '@playwright/test': 'Playwright', cypress: 'Cypress' })) if (dependencies[key]) metadata.frameworks.push(label);
      if (manifest.workspaces) metadata.monorepo = true;
      if (typeof manifest.packageManager === 'string') metadata.packageManagers.push(manifest.packageManager.split('@')[0]);
      if (path.dirname(file.path) === root && manifest.scripts && typeof manifest.scripts === 'object') {
        for (const [key, value] of Object.entries(manifest.scripts).slice(0, 40)) if (typeof value === 'string') metadata.scripts[key] = value.slice(0, 1000);
      }
    } catch { /* Invalid manifests remain listed for deliberate inspection. */ }
  }
  metadata.monorepo ||= names.some(name => /(^|\/)(pnpm-workspace\.yaml|lerna\.json|turbo\.json)$/.test(name)) || manifests.length > 1;
  // Only identifiers are returned, including from examples; assignment values never enter context.
  for (const file of entries.filter(item => item.type === 'file' && /^\.env\.(example|sample|template)$/.test(item.name) && item.size <= 64 * 1024).slice(0, 8)) {
    const text = await files.readFile(file.path);
    metadata.environmentNames.push(...[...text.matchAll(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/gm)].map(match => match[1]));
  }
  for (const key of ['languages', 'frameworks', 'packageManagers', 'sourceDirectories', 'tests', 'configuration', 'routes', 'databases', 'migrations', 'environmentNames'] as const) metadata[key] = [...new Set(metadata[key])].slice(0, 100);
  return { projectPath: root, files: entries.filter(file => !sensitivePath(file.path)).slice(0, 250).map(file => file.path), metadata, inspectedFiles, notes: ['Repository metadata is bounded. Search before reading relevant files.', 'Environment values and credential files are excluded.', 'Symbol and reference search are lexical, not language-server analysis.'] };
}
