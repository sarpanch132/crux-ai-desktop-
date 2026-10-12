const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const projectRegistry = require('../electron/dist/services/projectRegistry.js');
const {projectDirectory, recordedProject} = projectRegistry;
const dialog = {showOpenDialog: async () => ({canceled: true, filePaths: []})};
const originalLoad = Module._load;
Module._load = function(name, parent, main) {
  if (name === 'electron') return {dialog};
  if (name === 'electron-log') return {error() {}, info() {}};
  return originalLoad.call(this, name, parent, main);
};
const {registerIPCHandlers} = require('../electron/dist/ipc/handlers.js');
Module._load = originalLoad;

async function fixture(t, initial = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'crux-projects-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(base)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(base).startsWith('crux-projects-'));
    await fs.rm(base, {recursive: true, force: true});
  });
  const a = path.join(base, 'alpha'); const b = path.join(base, 'beta');
  await fs.mkdir(a); await fs.mkdir(b);
  const values = new Map(Object.entries(initial)); const handlers = new Map(); const events = [];
  let busy = false; let changes = 0;
  const win = {webContents: {mainFrame: {}, send: (...args) => events.push(args)}};
  const runtime = {setProgressSink(){},setImportConfirmation(){},busy: () => busy, projectChanged: () => changes++};
  registerIPCHandlers({removeHandler() {}, on() {}, handle: (name, fn) => handlers.set(name, fn)}, {
    runtime, store: {get: key => values.get(key), set: (key, value) => values.set(key, value), delete: key => values.delete(key)},
    mainWindow: () => win,
  });
  const invoke = (name, ...args) => handlers.get(name)({sender: win.webContents, senderFrame: win.webContents.mainFrame}, ...args);
  return {a: await projectDirectory(a), b: await projectDirectory(b), values, invoke, events, runtime, setBusy: value => busy = value, changes: () => changes};
}

test('native selection records actual canonical folders and activates known folders without another picker', async t => {
  const f = await fixture(t); let picks = 0;
  dialog.showOpenDialog = async () => ({canceled: false, filePaths: [++picks === 1 ? f.a : f.b]});
  assert.equal((await f.invoke('project:open')).data, f.a);
  assert.equal((await f.invoke('project:open')).data, f.b);
  assert.deepEqual((await f.invoke('project:listRecent')).data, [f.b, f.a]);
  assert.equal((await f.invoke('project:activate', f.a)).data, f.a);
  assert.equal(picks, 2); assert.equal(f.changes(), 3);
  assert.equal(f.values.get('workspace.currentProject'), f.a);
  assert.deepEqual(f.events.at(-1), ['project:opened', f.a]);
});

test('concurrent startup project reads share parallel recent-folder validation', async t => {
  const f = await fixture(t); f.values.set('workspace.currentProject', f.a); f.values.set('workspace.recentProjects', [f.a, f.b]);
  const original = projectRegistry.recordedProject; let active = 0; let maximumActive = 0; let calls = 0;
  projectRegistry.recordedProject = async (...args) => {
    calls += 1; active += 1; maximumActive = Math.max(maximumActive, active);
    try { await new Promise(resolve => setTimeout(resolve, 10)); return await original(...args); }
    finally { active -= 1; }
  };
  try {
    const [current, recent] = await Promise.all([f.invoke('project:getPath'), f.invoke('project:listRecent')]);
    assert.equal(current.data, f.a); assert.deepEqual(recent.data, [f.a, f.b]);
    assert.equal(calls, 3); assert.equal(maximumActive, 2);
  } finally { projectRegistry.recordedProject = original; }
});

test('unknown existing folders, relative paths and generic renderer registry edits are denied', async t => {
  const f = await fixture(t); f.values.set('workspace.recentProjects', [f.a]);
  for (const value of [f.b, '../alpha', null]) assert.equal((await f.invoke('project:activate', value)).success, false);
  assert.equal((await f.invoke('config:set', 'workspace.recentProjects', [f.b])).success, false);
  assert.equal(f.changes(), 0);
});

test('legacy native current folder seeds recent registry while missing folders do not activate', async t => {
  const f = await fixture(t); f.values.set('workspace.currentProject', f.a);
  assert.deepEqual((await f.invoke('project:listRecent')).data, [f.a]);
  assert.deepEqual(f.values.get('workspace.recentProjects'), [f.a]);
  await fs.rmdir(f.a);
  assert.equal((await f.invoke('project:activate', f.a)).success, false);
  assert.equal((await f.invoke('project:getPath')).data, undefined);
});

test('busy guard is rechecked after the native picker and after async recorded directory validation', async t => {
  const f = await fixture(t);
  dialog.showOpenDialog = async () => { f.setBusy(true); return {canceled: false, filePaths: [f.a]}; };
  assert.equal((await f.invoke('project:open')).success, false);
  f.setBusy(false); f.values.set('workspace.recentProjects', [f.a]);
  let checks = 0; f.runtime.busy = () => ++checks > 1;
  assert.equal((await f.invoke('project:activate', f.a)).success, false);
  assert.equal(f.changes(), 0); assert.equal(f.values.get('workspace.currentProject'), undefined);
});

test('retargeted recorded directories cannot grant authority through a junction', async t => {
  const f = await fixture(t); f.values.set('workspace.recentProjects', [f.a]);
  await fs.rmdir(f.a); await fs.symlink(f.b, f.a, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(recordedProject(f.a, [f.a]), /directory changed/);
  assert.equal((await f.invoke('project:activate', f.a)).success, false);
  assert.equal(f.changes(), 0);
  await fs.unlink(f.a);
});

// Exercise the actual Zustand store with an in-memory Electron bridge and persistence.
function rendererStore(saved = {}, overrides = {}) {
  const vm = require('node:vm');
  const ts = require('typescript');
  const fsSync = require('node:fs');
  const filename = path.resolve('frontend/src/hooks/useStore.ts');
  const compiled = ts.transpileModule(fsSync.readFileSync(filename, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}}).outputText;
  const calls = []; let activeProject = 'C:\\projects\\alpha';
  const snapshot = id => ({state: {id, repoContext: {projectPath: activeProject}, history: []}, approvals: []});
  const electron = {
    ai: {getSettings: async () => ({success: true, data: {provider: '', model: ''}}), getModels: async () => ({success: true, data: []}), getHealth: async () => ({success: true, data: []})},
    app: {getVersion: async () => ({success: true, data: '1.0.0'})},
    project: {getPath: async () => ({success: true, data: activeProject}), listRecent: async () => ({success: true, data: ['C:\\projects\\alpha', 'C:\\projects\\beta']}), activate: async value => {activeProject = value; calls.push(['activate', value]); return {success: true, data: value};}, close: async () => {activeProject = null; return {success: true};}},
    agent: {snapshot: async id => ({success: true, data: snapshot(id)}), open: async id => {calls.push(['open', id, activeProject]); return {success: true, data: snapshot(id)};}},
    file: {list: async () => ({success: true, data: []})}, terminal: {sessions: async () => ({success: true, data: []})},
  };
  for (const [group, methods] of Object.entries(overrides)) Object.assign(electron[group], methods);
  const context = {exports: {}, require: Module.createRequire(filename), crypto: require('node:crypto').webcrypto,
    window: {electron, matchMedia: () => ({matches: false})}, document: {documentElement: {classList: {add() {}, remove() {}, toggle() {}}, dataset: {}}},
    localStorage: {getItem: () => JSON.stringify({state: saved, version: 0}), setItem() {}, removeItem() {}}, console, setTimeout, clearTimeout};
  vm.runInNewContext(compiled, context, {filename});
  return {store: context.exports.useStore, calls};
}

const legacyChat = {id: 'old', title: 'Saved chat', messages: [{role: 'user', content: 'fix alpha'}], createdAt: 1, updatedAt: 1};
test('legacy active chat recovers a project only from matching authoritative session history', async () => {
  const f = rendererStore({conversations: [legacyChat], activeConversationId: 'old', rightPanelOpen: true, terminalOpen: true}, {
    agent: {snapshot: async () => ({success: true, data: {state: {repoContext: {projectPath: 'C:\\projects\\alpha'}, history: [{role: 'user', content: 'fix alpha'}]}}})},
  });
  await f.store.getState().initialize();
  assert.equal(f.store.getState().activeConversationId, 'old');
  assert.equal(f.store.getState().conversations[0].projectPath, 'C:\\projects\\alpha');
  assert.equal(f.store.getState().rightPanelOpen, false); assert.equal(f.store.getState().terminalOpen, false);
});

test('ambiguous legacy chats remain unassigned and new chats start empty in the real current project', async () => {
  const f = rendererStore({conversations: [legacyChat], activeConversationId: 'old'});
  await f.store.getState().initialize();
  assert.equal(f.store.getState().conversations.find(entry => entry.id === 'old').projectPath, undefined);
  const active = f.store.getState().conversations.find(entry => entry.id === f.store.getState().activeConversationId);
  assert.equal(active.projectPath, 'C:\\projects\\alpha'); assert.equal(active.messages.length, 0);
});

test('chat selection restores its known folder before opening its authoritative agent session', async () => {
  const beta = {...legacyChat, id: 'beta-chat', projectPath: 'C:\\projects\\beta'};
  const f = rendererStore({conversations: [beta], activeConversationId: 'beta-chat', layoutVersion: 1, rightPanelOpen: true});
  await f.store.getState().initialize();
  f.calls.length = 0;
  await f.store.getState().selectConversation('beta-chat');
  assert.equal(f.store.getState().projectPath, beta.projectPath);
  assert.deepEqual(f.calls[0], ['activate', beta.projectPath]);
  assert.deepEqual(f.calls.at(-1), ['open', 'beta-chat', beta.projectPath]);
  assert.equal(f.store.getState().rightPanelOpen, true);
});

test('failed close preserves project state and stale snapshots cannot open another project approvals', async () => {
  const f = rendererStore({}, {project: {close: async () => ({success: false, error: 'busy'})}});
  await f.store.getState().initialize(); const before = f.store.getState().projectPath;
  await f.store.getState().closeProject();
  assert.equal(f.store.getState().projectPath, before);
  f.store.getState().syncAgent({state: {id: f.store.getState().activeConversationId, repoContext: {projectPath: 'C:\\projects\\beta'}}, approvals: [{}]});
  assert.equal(f.store.getState().rightPanelOpen, false);
});
test('startup without a valid current folder preserves scoped history and opens an unassigned chat', async () => {
  const scoped = {...legacyChat, projectPath: 'C:\\projects\\alpha'};
  const f = rendererStore({conversations: [scoped], activeConversationId: 'old'}, {
    project: {getPath: async () => ({success: true}), listRecent: async () => ({success: true, data: []})},
  });
  await f.store.getState().initialize();
  const state = f.store.getState();
  assert.equal(state.projectPath, null);
  assert.equal(state.conversations.find(entry => entry.id === 'old').projectPath, scoped.projectPath);
  assert.equal(state.conversations.find(entry => entry.id === state.activeConversationId).projectPath, undefined);
});

test('invalid startup project is revoked only when no run is active', async t => {
  const f = await fixture(t); f.values.set('workspace.currentProject', f.a); f.values.set('workspace.recentProjects', [f.a]);
  await fs.rmdir(f.a); f.setBusy(true);
  await f.invoke('project:getPath');
  assert.equal(f.values.get('workspace.currentProject'), f.a); assert.equal(f.changes(), 0);
  f.setBusy(false); await f.invoke('project:getPath');
  assert.equal(f.values.get('workspace.currentProject'), undefined); assert.equal(f.changes(), 1);
});
