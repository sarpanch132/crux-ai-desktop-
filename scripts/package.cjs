// Stage only compiled application assets and production dependencies, never the repository.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execSync } = require('node:child_process');
const { packager } = require('@electron/packager');
const root = path.resolve(__dirname, '..');

async function main() {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const platform = process.platform;
  const arch = process.arch;
  const releaseRoot = path.join(root, 'release');
  const out = process.argv[2] ? path.resolve(root, process.argv[2]) : releaseRoot;
  const relativeOutput = path.relative(releaseRoot, out);
  if (path.isAbsolute(relativeOutput) || relativeOutput === '..' || relativeOutput.startsWith(`..${path.sep}`)) throw new Error('Package output must remain inside release/.');
  const destination = path.join(out, `Crux AI-${platform}-${arch}`);
  try { await fs.access(destination); throw new Error(`Output already exists: ${destination}. Move it before packaging again.`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'crux-package-'));
  const copy = async (relative) => {
    const source = path.join(root, relative);
    await fs.cp(source, path.join(stage, relative), { recursive: true, filter: item => !/\.map$|(?:^|[\\/])\.env(?:\.|$)/i.test(item) });
  };
  try {
    await copy('frontend/dist');
    await copy('electron/dist');
    const dependencies = execSync('npm ls --omit=dev --all --parseable', { cwd: root, encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/).slice(1);
    for (const dependency of dependencies) {
      const relative = path.relative(root, dependency);
      if (!relative.startsWith(`node_modules${path.sep}`) || relative.includes(`..${path.sep}`)) throw new Error('Dependency outside the project is unsupported.');
      await copy(relative);
    }
    await fs.writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: manifest.name, productName: 'Crux AI', version: manifest.version, description: manifest.description, main: manifest.main, author: manifest.author, license: manifest.license, dependencies: manifest.dependencies }, null, 2));
    const electronVersion = require('electron/package.json').version;
    const outputs = await packager({ dir: stage, name: 'Crux AI', appVersion: manifest.version, electronVersion, platform, arch, out, overwrite: false, asar: true, prune: false });
    console.log(outputs.join('\n'));
  } finally {
    // Validate the absolute temporary target before recursive cleanup on Windows.
    const temporaryRoot = path.resolve(os.tmpdir());
    const relativeStage = path.relative(temporaryRoot, path.resolve(stage));
    if (path.isAbsolute(relativeStage) || relativeStage.startsWith('..') || !/^crux-package-[^\\/]+$/.test(relativeStage)) throw new Error('Refusing unsafe staging cleanup.');
    await fs.rm(stage, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
