const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {CatalogRegistry, validateCatalog, validateLogoDataUrl} = require('../electron/dist/services/agent/catalogRegistry.js');
const {resolveInput} = require('../electron/dist/services/agent/inputRouter.js');
const {prepareGithubSkill, githubLocator, safeImportPath, publicAddress} = require('../electron/dist/services/agent/githubSkillSource.js');
const {parseSkill} = require('../electron/dist/services/agent/skillRegistry.js');
const draft = (handle, extra = {}) => ({name: handle, handle, instructions: `Instructions for ${handle}`, ...extra});
const md = name => Buffer.from(`---\nname: ${name}\ndescription: Workflow ${name}\n---\nInspect and report.\n`);
const commit = 'a'.repeat(40);
async function fixture(t, idle) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'crux-catalog-'));
  t.after(async () => {assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('crux-catalog-')); await fs.rm(root, {recursive: true, force: true});});
  return {root, registry: new CatalogRegistry(root, idle)};
}
function transport(entries = [{name: 'SKILL.md', path: 'workflow/SKILL.md', type: 'file', size: md('workflow').length}], content = md('workflow')) {
  const calls = [];
  const fetch = async (url, limit, signal) => {
    calls.push(url); assert.ok(!signal?.aborted);
    const result = url.includes('/commits/') ? Buffer.from(JSON.stringify({sha: commit})) : url.includes('/contents') ? Buffer.from(JSON.stringify(entries)) : content;
    assert.ok(result.length <= limit); return result;
  };
  return {fetch, calls};
}
function definition(id, keywords = [], extra = {}) {
  return {id, revision: 1, name: id, handle: id, description: '', instructions: `Use ${id}.`, enabled: true, icon: 'bot', keywords,
    allowedCapabilities: ['read'], skillIds: [], callableAgentIds: [], callableSkillIds: [], createdAt: 1, updatedAt: 1, ...extra};
}
function skill(id, keywords = [], extra = {}) {const item = definition(id, keywords, extra); delete item.allowedCapabilities; delete item.skillIds; return {...item, toolRequirements: [], definitionOfDone: [], source: 'created', provenance: {kind: 'created'}};}

// Persistence, revision authority, dependency validation and safe files.
test('catalog CRUD persists stable IDs/revisions and returns independent snapshots', async t => {
  const {root, registry} = await fixture(t); const a = await registry.createAgent(draft('reviewer'));
  assert.deepEqual(a.agents[0].allowedCapabilities, ['read', 'gitRead']);
  const id = a.agents[0].id; a.agents[0].instructions = 'tampered';
  assert.notEqual((await registry.list()).agents[0].instructions, 'tampered');
  const next = await registry.updateAgent(id, 1, draft('reviewer', {name: 'New name'}));
  assert.equal(next.agents[0].id, id); assert.equal(next.agents[0].revision, 2); assert.equal(next.revision, 2);
  await assert.rejects(registry.updateAgent(id, 1, draft('reviewer')), /changed/);
  assert.equal((await new CatalogRegistry(root).list()).agents[0].name, 'New name');
  assert.equal((await registry.removeAgent(id, 2)).agents.length, 0);
});

test('main validates cross-kind handles, capabilities, field limits and dependent deletion', async t => {
  const {registry} = await fixture(t); let c = await registry.createSkill(draft('audit', {description: 'Audit'}));
  const sid = c.skills[0].id;
  await assert.rejects(registry.createAgent(draft('audit')), /unique/);
  await assert.rejects(registry.createAgent(draft('bad', {allowedCapabilities: ['root']})), /capability/);
  await assert.rejects(registry.createAgent(draft('bad', {keywords: Array(21).fill('x')})), /keywords/);
  await assert.rejects(registry.createAgent(draft('bad', {skillIds: ['missing']})), /missing/);
  c = await registry.createAgent(draft('reviewer', {skillIds: [sid]}));
  await assert.rejects(registry.removeSkill(sid, 1), /@reviewer/);
  await assert.rejects(registry.updateAgent(c.agents[0].id, 1, draft('reviewer', {callableAgentIds: [c.agents[0].id]})), /cycles/);
});

test('mixed agent/skill cycles reject; dense acyclic graphs validate in linear bounded time', () => {
  const a = definition('a', [], {callableSkillIds: ['s']}); const s = skill('s', [], {callableAgentIds: ['a']});
  assert.throws(() => validateCatalog({revision: 1, agents: [a], skills: [s]}), /cycles/);
  const agents = [];
  for (let layer = 0; layer < 7; layer++) for (let index = 0; index < 14; index++) agents.push(definition(`n${layer}_${index}`, [], {callableAgentIds: layer === 6 ? [] : Array.from({length: 14}, (_, child) => `n${layer + 1}_${child}`)}));
  const started = Date.now(); validateCatalog({revision: 1, agents, skills: []}); assert.ok(Date.now() - started < 2000);
});

test('legacy declarative files migrate disabled without invented triggers and unsafe catalog symlinks reject', async t => {
  const {root} = await fixture(t); await fs.mkdir(path.join(root, 'skills'));
  const parsed = parseSkill(md('legacy').toString(), 'source'); await fs.writeFile(path.join(root, 'skills', `${parsed.id}.md`), md('legacy'));
  const c = await new CatalogRegistry(root).list(); assert.equal(c.skills[0].enabled, false); assert.deepEqual(c.skills[0].keywords, []); assert.equal(c.skills[0].provenance.kind, 'legacy');
  const outside = path.join(root, 'outside.json'); await fs.writeFile(outside, '{}'); await fs.unlink(path.join(root, 'catalog.json'));
  try {await fs.symlink(outside, path.join(root, 'catalog.json'), 'file');} catch (error) {if (error.code === 'EPERM') return; throw error;}
  await assert.rejects(new CatalogRegistry(root).list(), /unsafe/);
});

test('logos validate PNG/JPEG/WebP signatures/dimensions and reject SVG or oversize images', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhVQAAAAASUVORK5CYII=', 'base64');
  assert.ok(validateLogoDataUrl('data:image/png;base64,' + png.toString('base64')));
  const webp = Buffer.alloc(30); webp.write('RIFF'); webp.writeUInt32LE(22, 4); webp.write('WEBP', 8); webp.write('VP8X', 12); webp.writeUInt32LE(10, 16);
  assert.ok(validateLogoDataUrl('data:image/webp;base64,' + webp.toString('base64')));
  const jpeg = Buffer.from([255,216,255,192,0,8,8,0,1,0,1,0,255,217]);
  assert.ok(validateLogoDataUrl('data:image/jpeg;base64,' + jpeg.toString('base64')));
  png.writeUInt32BE(513, 16); assert.throws(() => validateLogoDataUrl('data:image/png;base64,' + png.toString('base64')), /dimensions/);
  assert.throws(() => validateLogoDataUrl('data:image/svg+xml;base64,PHN2Zz4='), /PNG/);
  assert.throws(() => validateLogoDataUrl('data:image/png;base64,' + Buffer.alloc(129 * 1024).toString('base64')), /128 KiB|bounded/);
});

// Pure routing excludes code/email and freezes only a selective instruction set.
test('leading multi-handles select one agent and bounded skills; task/history text and direct edges persist', () => {
  const catalog = {revision: 3, agents: [definition('reviewer', [], {callableAgentIds: ['helper'] }), definition('helper', [], {callableAgentIds: ['deep']}), definition('deep')], skills: [skill('audit'), skill('other')]};
  const route = resolveInput('@reviewer @audit inspect this', catalog);
  assert.equal(route.executionText, 'inspect this'); assert.equal(route.originalText, '@reviewer @audit inspect this'); assert.equal(route.agent.id, 'reviewer');
  assert.deepEqual(route.skills.map(s => s.id), ['audit']); assert.deepEqual(route.allowedAgentIds, ['helper']); assert.ok(Object.isFrozen(route.agent));
  assert.throws(() => resolveInput('@missing inspect', catalog), /Unknown/);
  assert.throws(() => resolveInput('@audit @audit inspect', catalog), /more than once/);
  assert.throws(() => resolveInput('@reviewer @helper inspect', catalog), /one leading agent/);
  assert.throws(() => resolveInput('@reviewer', catalog), /Add a task/);
});

test('literal phrase routing uses token boundaries, excludes fenced/inline code/email and resolves specificity', () => {
  const catalog = {revision: 1, agents: [definition('broad', ['review']), definition('specific', ['security review'])], skills: [skill('audit', ['security review'])]};
  assert.equal(resolveInput('Please do a SECURITY   review.', catalog).agent.id, 'specific');
  assert.equal(resolveInput('preview this', catalog).source, 'default');
  for (const text of ['`security review` task', '```txt\nsecurity review\n```\nhello', 'ask security@review.example', '@security@review.example hello']) assert.equal(resolveInput(text, catalog).source, 'default');
  assert.equal(resolveInput('Explain the string @specific please', catalog).source, 'default');
});

test('ambiguity, stale overrides, disabled handles and conflicting manual overrides reject explicitly', () => {
  const catalog = {revision: 2, agents: [definition('a', ['review']), definition('b', ['review']), definition('off', [], {enabled: false})], skills: []};
  assert.throws(() => resolveInput('review task', catalog), error => error.code === 'ambiguous-agent' && error.candidateAgentIds.length === 2);
  assert.equal(resolveInput('review task', catalog, {catalogRevision: 2, agentId: 'a'}).agent.id, 'a');
  assert.equal(resolveInput('review task', catalog, {catalogRevision: 2, agentId: null}).source, 'explicit');
  assert.throws(() => resolveInput('@off task', catalog), /disabled/);
  assert.throws(() => resolveInput('task', catalog, {catalogRevision: 1}), /changed/);
  assert.throws(() => resolveInput('@a task', catalog, {catalogRevision: 2, agentId: 'b'}), /conflicts/);
});

test('route rejects missing attached skills, over-five skills and over-24KiB instructions', () => {
  assert.throws(() => resolveInput('@a task', {revision: 1, agents: [definition('a', [], {skillIds: ['missing']})], skills: []}), /missing/);
  const skills = Array.from({length: 6}, (_, i) => skill('s' + i, ['task']));
  assert.throws(() => resolveInput('task', {revision: 1, agents: [], skills}), /five/);
  assert.throws(() => resolveInput('@a task', {revision: 1, agents: [definition('a', [], {instructions: 'x'.repeat(24577)})], skills: []}), /24 KiB/);
});

// Importer fixtures exercise immutable pinning and Windows/network/path limits.
test('GitHub tree/blob/raw/repo URLs resolve only explicit safe locators; unsafe targets reject', () => {
  assert.equal(githubLocator('https://github.com/o/r/tree/main/workflow').directory, 'workflow');
  assert.equal(githubLocator('https://github.com/o/r/blob/main/workflow/SKILL.md').directory, 'workflow');
  assert.equal(githubLocator('https://raw.githubusercontent.com/o/r/main/workflow/SKILL.md').directory, 'workflow');
  assert.equal(githubLocator('https://github.com/o/r').ref, 'HEAD');
  for (const url of ['http://github.com/o/r', 'https://github.com/o/r?token=x', 'https://user@github.com/o/r', 'https://evil.example/o/r', 'https://github.com/o/r/blob/main/file.txt', 'https://github.com/o/r/tree/main/../outside', 'https://github.com/o/r/tree/main/%2e%2e/outside']) assert.throws(() => githubLocator(url));
  for (const location of ['../escape', 'folder/a:stream', 'CON.txt', 'x\\y', 'x./a', '/absolute']) assert.throws(() => safeImportPath(location));
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.1.1', '::1', '::ffff:127.0.0.1', 'fc00::1']) assert.equal(publicAddress(address), false);
  assert.equal(publicAddress('140.82.114.3'), true);
});

test('GitHub source pins commit then reads exact bounded contents/raw bytes without scripts executing', async () => {
  const f = transport(); const prepared = await prepareGithubSkill('https://github.com/o/r/tree/main/workflow', f.fetch);
  assert.equal(prepared.summary.commit, commit); assert.equal(prepared.summary.fileCount, 1); assert.equal(prepared.skill.name, 'workflow');
  assert.ok(f.calls[1].endsWith('?ref=' + commit)); assert.ok(f.calls[2].includes('/' + commit + '/workflow/SKILL.md'));
});

test('GitHub source rejects symlink/submodule/archives/casecollisions/missing SKILL and mismatched file bytes', async () => {
  const variants = [
    [{name: 'SKILL.md', path: 'workflow/SKILL.md', type: 'symlink', size: 1}],
    [{name: 'SKILL.md', path: 'workflow/SKILL.md', type: 'file', size: 1, submodule_git_url: 'https://example.test'}],
    [{name: 'payload.zip', path: 'workflow/payload.zip', type: 'file', size: 1}],
    [{name: 'README.md', path: 'workflow/README.md', type: 'file', size: md('workflow').length}],
    [{name: 'SKILL.md', path: '../SKILL.md', type: 'file', size: md('workflow').length}],
    [{name: 'SKILL.md', path: 'workflow/SKILL.md', type: 'file', size: 1}],
    [{name: 'SKILL.md', path: 'workflow/SKILL.md', type: 'file', size: 300000}],
    [{name: 'SKILL.md', path: 'workflow/SKILL.md', type: 'file', size: md('workflow').length}, {name: 'skill.md', path: 'workflow/skill.md', type: 'file', size: md('workflow').length}],
  ];
  for (const entries of variants) await assert.rejects(prepareGithubSkill('https://github.com/o/r/tree/main/workflow', transport(entries).fetch));
});

test('GitHub cancellation aborts a pending transport and prevents further requests', async () => {
  const controller = new AbortController(); let calls = 0;
  const pending = prepareGithubSkill('https://github.com/o/r', async () => {calls++; return new Promise(() => {});}, controller.signal);
  controller.abort(); await assert.rejects(pending, /canceled/); assert.equal(calls, 1);
});

test('prepared imports install atomically, deduplicate, preserve provenance and delete/reinstall owned files', async t => {
  const {root, registry} = await fixture(t); const prepared = await registry.prepareGithub('https://github.com/o/r/tree/main/workflow', transport().fetch);
  const c = await registry.installPrepared(prepared); const installed = c.skills[0];
  assert.equal(installed.provenance.commit, commit); assert.equal(installed.provenance.fileCount, 1);
  assert.ok((await fs.stat(path.join(root, 'skills', 'imports', installed.id, 'SKILL.md'))).isFile());
  await assert.rejects(registry.installPrepared(prepared), /already installed/);
  await registry.removeSkill(installed.id, installed.revision);
  assert.equal((await registry.installPrepared(prepared)).skills.length, 1);
});

test('idle/abort recheck before import commit leaves no registered skill or installed directory', async t => {
  let checks = 0; const {root, registry} = await fixture(t, () => {if (++checks >= 4) throw new Error('active run');});
  const prepared = await prepareGithubSkill('https://github.com/o/r/tree/main/workflow', transport().fetch);
  await assert.rejects(registry.installPrepared(prepared), /active run/);
  assert.equal((await registry.list()).skills.length, 0);
  assert.deepEqual(await fs.readdir(path.join(root, 'skills', 'imports')), []);
});

test('safe skill parser accepts common multiline descriptions and ignores non-granting nested metadata', () => {
  const parsed = parseSkill('---\nname: workflow\ndescription: >-\n  Inspect source\n  and verify changes.\nmetadata:\n  audience: developer\n  enabled: true\nallowed-tools:\n  - Shell(*)\ntool-requirements:\n  - read\n---\nReport evidence.', 'source');
  assert.equal(parsed.description, 'Inspect source and verify changes.'); assert.deepEqual(parsed.toolRequirements, ['read']);
  assert.throws(() => parseSkill('---\nname: a\ndescription: test\ntool-requirements: [root]\n---\nDo work', 'source'), /capability/);
});

test('GitHub SHA-only media response pins a small immutable response even for large commits', async () => {
  const f = transport();
  const prepared = await prepareGithubSkill('https://github.com/o/r/tree/main/workflow', (url, limit, signal) => url.includes('/commits/') ? Promise.resolve(Buffer.from(commit + '\n')) : f.fetch(url, limit, signal));
  assert.equal(prepared.summary.commit, commit);
});
test('default HTTPS transport denies private DNS and redirects and pins a validated public IP', async () => {
  const https = require('node:https'); const dns = require('node:dns/promises'); const {EventEmitter} = require('node:events');
  const {fetchGithub} = require('../electron/dist/services/agent/githubSkillSource.js');
  const originalRequest = https.request; const originalLookup = dns.lookup; let requests = 0; let destroyed = false;
  try {
    dns.lookup = async () => [{address: '127.0.0.1', family: 4}];
    https.request = () => {requests++; throw new Error('must not connect');};
    await assert.rejects(fetchGithub('https://api.github.com/repos/o/r/commits/main', 1024), /prohibited network/); assert.equal(requests, 0);
    dns.lookup = async () => [{address: '140.82.114.3', family: 4}];
    https.request = (url, options, callback) => {
      requests++; assert.equal(options.family, 4); assert.equal(options.headers.Accept, 'application/vnd.github.sha');
      options.lookup('api.github.com', {}, (error, address, family) => {assert.equal(error, null); assert.equal(address, '140.82.114.3'); assert.equal(family, 4);});
      const req = new EventEmitter(); req.setTimeout = () => req; req.end = () => {
        const response = new EventEmitter(); response.statusCode = 302; response.headers = {location: 'https://evil.example'}; response.destroy = () => {destroyed = true;};
        callback(response);
      }; return req;
    };
    await assert.rejects(fetchGithub('https://api.github.com/repos/o/r/commits/main', 1024), /HTTP 302/);
    assert.equal(requests, 1); assert.equal(destroyed, true);
  } finally {https.request = originalRequest; dns.lookup = originalLookup;}
});

function nestedSkillTransport(candidates, extra = {}) {
  const calls = []; const content = md('ui-ux-pro-max');
  return {calls, fetch: async (url, limit) => {
    calls.push(url); let data;
    if (url.includes('/commits/')) data = Buffer.from(commit);
    else if (url.includes('/git/trees/')) {assert.equal(url, `https://api.github.com/repos/o/ui-ux-pro-max-skill/git/trees/${commit}?recursive=1`); data = Buffer.from(JSON.stringify({sha: commit, truncated: false, tree: candidates.map(item => typeof item === 'string' ? {path:item, type:'blob', mode:'100644', sha:'b'.repeat(40)} : item), ...extra}));}
    else if (url.includes('/contents?')) data = Buffer.from(JSON.stringify([{name:'README.md', path:'README.md', type:'file', size:10}]));
    else if (url.includes('/contents/')) {const directory = decodeURIComponent(new URL(url).pathname.split('/contents/')[1]); data = Buffer.from(JSON.stringify([{name:'SKILL.md',path:`${directory}/SKILL.md`,type:'file',size:content.length}]));}
    else {assert(url.includes(`/${commit}/`));assert(url.endsWith('/SKILL.md'));data=content;}
    assert(data.length<=limit);return data;
  }};
}
test('GitHub root skill discovery prefers the repo-named canonical skill and imports immutable contents',async()=>{
  const f=nestedSkillTransport(['.codex/skills/ui-ux-pro-max/SKILL.md','.claude/skills/ui-ux-pro-max/SKILL.md','skills/other/SKILL.md']);const prepared=await prepareGithubSkill('https://github.com/o/ui-ux-pro-max-skill',f.fetch);assert.equal(prepared.skill.name,'ui-ux-pro-max');assert.equal(prepared.summary.fileCount,1);assert(f.calls.some(url=>url.includes(`/contents/.claude/skills/ui-ux-pro-max?ref=${commit}`)));assert(f.calls.at(-1).includes(`/${commit}/.claude/skills/ui-ux-pro-max/SKILL.md`));
});
test('GitHub root discovery accepts a unique candidate but rejects ambiguous or truncated inventories',async()=>{
  const unique=nestedSkillTransport(['nested/only/SKILL.md']);assert.equal((await prepareGithubSkill('https://github.com/o/ui-ux-pro-max-skill',unique.fetch)).summary.fileCount,1);for(const f of [nestedSkillTransport(['nested/one/SKILL.md','nested/two/SKILL.md']),nestedSkillTransport(['nested/only/SKILL.md'],{truncated:true})])await assert.rejects(prepareGithubSkill('https://github.com/o/ui-ux-pro-max-skill',f.fetch),/ambiguous|multiple|explicit|truncat|specific skill folder/i);
});
test('GitHub discovery never follows symlink skills or unsafe candidate paths',async()=>{
  for(const path of ['../escape/SKILL.md','folder/a:stream/SKILL.md']){const f=nestedSkillTransport([path]);await assert.rejects(prepareGithubSkill('https://github.com/o/ui-ux-pro-max-skill',f.fetch));assert(!f.calls.some(url=>url.startsWith('https://raw.githubusercontent.com/')));}
  const linked=nestedSkillTransport([{path:'.claude/skills/ui-ux-pro-max/SKILL.md',type:'blob',mode:'120000',sha:'b'.repeat(40)}]);await assert.rejects(prepareGithubSkill('https://github.com/o/ui-ux-pro-max-skill',linked.fetch));assert(!linked.calls.some(url=>url.startsWith('https://raw.githubusercontent.com/')));
});
test('GitHub skill import retains larger bounded data resources and rejects new byte limits',async()=>{
  const definition=md('workflow');const resource=Buffer.alloc(700_000,65);const entries=[{name:'SKILL.md',path:'workflow/SKILL.md',type:'file',size:definition.length},{name:'data.csv',path:'workflow/data.csv',type:'file',size:resource.length}];const fetch=async(url,limit)=>{const data=url.includes('/commits/')?Buffer.from(commit):url.includes('/contents')?Buffer.from(JSON.stringify(entries)):url.endsWith('/SKILL.md')?definition:resource;assert(data.length<=limit);return data;};const prepared=await prepareGithubSkill('https://github.com/o/r/tree/main/workflow',fetch);assert.equal(prepared.files.length,2);assert.equal(prepared.files.find(file=>file.path==='data.csv').content.length,700_000);
  const oversized=[entries[0],{name:'large.csv',path:'workflow/large.csv',type:'file',size:1024*1024+1}];await assert.rejects(prepareGithubSkill('https://github.com/o/r/tree/main/workflow',transport(oversized).fetch));
  const largeEntries=[entries[0],...Array.from({length:9},(_,index)=>({name:`data-${index}.csv`,path:`workflow/data-${index}.csv`,type:'file',size:1024*1024}))];await assert.rejects(prepareGithubSkill('https://github.com/o/r/tree/main/workflow',async url=>url.includes('/commits/')?Buffer.from(commit):url.includes('/contents')?Buffer.from(JSON.stringify(largeEntries)):url.endsWith('/SKILL.md')?definition:Buffer.alloc(1024*1024,65)),/total|limit|bytes/i);
});

test('GitHub resource downloads are bounded to four and cancellation starts no next batch', async () => {
  const definition=md('workflow');const entries=[{name:'SKILL.md',path:'workflow/SKILL.md',type:'file',size:definition.length},...Array.from({length:11},(_,i)=>({name:`data${i}.txt`,path:`workflow/data${i}.txt`,type:'file',size:2}))];
  let active=0,maximum=0,downloads=0;const fetch=async(url)=>{if(url.includes('/commits/'))return Buffer.from(commit);if(url.includes('/contents'))return Buffer.from(JSON.stringify(entries));active++;downloads++;maximum=Math.max(maximum,active);await new Promise(resolve=>setTimeout(resolve,5));active--;return url.endsWith('/SKILL.md')?definition:Buffer.from('OK');};
  const prepared=await prepareGithubSkill('https://github.com/o/r/tree/main/workflow',fetch);assert.equal(prepared.files.length,12);assert.equal(downloads,12);assert.equal(maximum,4);
  const controller=new AbortController();let started=0;const pending=prepareGithubSkill('https://github.com/o/r/tree/main/workflow',async(url)=>{if(url.includes('/commits/'))return Buffer.from(commit);if(url.includes('/contents'))return Buffer.from(JSON.stringify(entries));started++;if(started===4)setImmediate(()=>controller.abort());return new Promise(()=>{});},controller.signal);await assert.rejects(pending,/canceled/);assert.equal(started,4);
});

test('reference graphs reject excessive depth and import byte totals stay bounded', async () => {
  const agents = Array.from({length: 9}, (_, index) => definition('d' + index, [], {callableAgentIds: index === 8 ? [] : ['d' + (index + 1)]}));
  assert.throws(() => validateCatalog({revision: 1, agents, skills: []}), /depth/);
  const entries = [{name: 'SKILL.md', path: 'workflow/SKILL.md', type: 'file', size: md('workflow').length},
    ...Array.from({length: 43}, (_, index) => ({name: `support${index}.txt`, path: `workflow/support${index}.txt`, type: 'file', size: 200000}))];
  const fetch = async url => url.includes('/commits/') ? Buffer.from(commit) : url.includes('/contents') ? Buffer.from(JSON.stringify(entries)) : url.endsWith('/SKILL.md') ? md('workflow') : Buffer.alloc(200000);
  await assert.rejects(prepareGithubSkill('https://github.com/o/r/tree/main/workflow', fetch), /total byte/);
});
test('final import commit rejects changed, missing or unexpected staged supporting files', async t => {
  const sync = require('node:fs');
  for (const change of ['changed', 'missing', 'extra']) {
    let root; let checks = 0;
    const f = await fixture(t, () => {
      if (++checks !== 3) return;
      const imports = path.join(root, 'skills', 'imports'); const stage = sync.readdirSync(imports).find(name => name.startsWith('.stage-'));
      const skillPath = path.join(imports, stage, 'SKILL.md');
      if (change === 'changed') sync.writeFileSync(skillPath, 'tampered');
      else if (change === 'missing') sync.unlinkSync(skillPath);
      else sync.writeFileSync(path.join(imports, stage, 'unexpected.txt'), 'tampered');
    });
    root = f.root;
    const prepared = await prepareGithubSkill('https://github.com/o/r/tree/main/workflow', transport().fetch);
    await assert.rejects(f.registry.installPrepared(prepared), /Staged import/);
    assert.equal((await f.registry.list()).skills.length, 0);
    assert.deepEqual(await fs.readdir(path.join(root, 'skills', 'imports')), []);
  }
});
