// Actual Electron/renderer/IPC smoke test. Native project picker is stubbed;
// model responses use a local deterministic fixture, not a paid provider.
const { _electron: electron, expect } = require('@playwright/test');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  const root = path.resolve(__dirname, '..');
  const packaged = process.argv.includes('--packaged');
  const nativeActions = process.argv.includes('--native-actions');
  let nativeRequests = 0;
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'crux-electron-'));
  const project = path.join(temporary, 'project'); await fs.mkdir(project);
  const artifacts = path.join(root, 'tests', 'artifacts'); await fs.mkdir(artifacts, { recursive: true });
  const check = `node -e "if(require('fs').readFileSync('hello.txt','utf8')!=='hello from Crux')process.exit(1);console.log('fixture acceptance passed')"`;
  const plan = { summary: 'Create a greeting file', architecture: 'One project-local text file', tasks: ['Write hello.txt', 'Verify its exact content'], risks: ['Host command needs explicit approval'], acceptanceCriteria: ['Greeting matches'], checks: [check] };
  let requests = 0; let crossOriginRequests = 0; let debugRequests = 0; let selectedModel; let authenticatedCatalog = false;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/blocked-image') crossOriginRequests++;
    if (req.url?.endsWith('/models') && req.headers.authorization === 'Bearer fixture-only-key') authenticatedCatalog = true;
    if (req.url === '/fixture-page') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><head><title>Crux fixture page</title></head><body>Read-only browser fixture<a href="/same-origin">Fixture link</a><img src="http://localhost:${server.address().port}/blocked-image"><script>document.body.append(' require='+typeof require)</script></body></html>`);
      return;
    }
    let body = ''; for await (const chunk of req) body += chunk;
    if (req.url.endsWith('/chat/completions')) {
      requests++; const input = JSON.parse(body); selectedModel = input.model;
      const coding = input.messages[0].content.includes('CODE mode');
      const debugging = input.messages[0].content.includes('DEBUG mode');
      if (nativeActions && debugging) console.log('Fixture debug response', {debugRequests, structured:!!input.tools, system:input.messages[0].content.slice(0,90)});
      const response = debugging && debugRequests++ === 0 ? { message: 'Reproduce greeting mismatch', actions: [{tool: 'command', command: check, verification: true}], done: false }
        : coding || debugging ? { message: debugging ? 'Root cause: file content mismatch; greeting repaired' : 'Greeting created', actions: [{ tool: 'write', path: 'hello.txt', content: 'hello from Crux' }], done: true, acceptance: [{ criterion: 'Greeting matches', passed: true, evidence: `${check} checks exact content` }] } : { message: 'Greeting implementation plan', plan, requirements: ['Create a greeting file'] };
      if(input.stream){
        res.writeHead(200,{'Content-Type':'text/event-stream'});
        if (nativeActions && input.tools) {
          const malformed = nativeRequests++ === 0;
          const reply = { actions: [], done: false, ...response };
          reply.actions = reply.actions.map(({tool, ...arguments}) => ({type:'tool_call', name:tool, arguments}));
          const raw = malformed ? '{"message":' : JSON.stringify(reply);
          for (const [index, fragment] of [raw.slice(0, 20), raw.slice(20)].entries()) {
            res.write(`data: ${JSON.stringify({choices:[{delta:{tool_calls:[{index:0, ...(index === 0 ? {id:'fixture-call',type:'function'} : {}),function:{...(index === 0 ? {name:'crux_reply'} : {}),arguments:fragment}}]}}]})}\n\n`);
          }
          res.write(`data: ${JSON.stringify({choices:[{delta:{},finish_reason:'tool_calls'}]})}\n\n`);
          res.end('data: [DONE]\n\n');
          return;
        }
        const raw=JSON.stringify(response); const event=content=>`data: ${JSON.stringify({choices:[{delta:{content}}]})}\n\n`;
        res.write(event(raw.slice(0,30)));
        setTimeout(()=>{res.write(event(raw.slice(30)));res.end('data: [DONE]\n\n');},80);
      }else{res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }));}
    } else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{id: 'fixture-model'}, {id: 'fixture-alternative'}] })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = path.join(temporary, 'profile'); await fs.mkdir(profile);
  await fs.writeFile(path.join(profile, 'config.json'), JSON.stringify({ ai: { settings: { provider: 'custom', model: 'fixture-model', customEndpoint: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture-only-key' } } }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let app; let mainPage;
  try {
    app = await electron.launch({ ...(packaged ? { executablePath: process.env.CRUX_TEST_EXECUTABLE || path.join(root, 'release', 'Crux AI-win32-x64', 'Crux AI.exe') } : {}), args: [...(packaged ? [] : [root]), `--user-data-dir=${profile}`], env, timeout: 45000 });
    assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), profile, 'Fixture uses an isolated Electron profile');
    const browserResult = await app.evaluate(async ({ app, BrowserWindow }, url) => {
      const count = BrowserWindow.getAllWindows().length;
      const { BrowserAdapter } = process.mainModule.require(app.getAppPath() + '/electron/dist/services/agent/browserAdapter.js');
      const data = await new BrowserAdapter().inspect(url);
      return { data, windowsBefore: count, windowsAfter: BrowserWindow.getAllWindows().length };
    }, `http://127.0.0.1:${server.address().port}/fixture-page`);
    assert.equal(browserResult.data.title, 'Crux fixture page'); assert.match(browserResult.data.text, /Read-only browser fixture/);
    assert.match(browserResult.data.text, /require=undefined/); assert.equal(browserResult.data.untrusted, true);
    assert.equal(browserResult.data.links[0].text, 'Fixture link');
    assert.equal(browserResult.windowsAfter, browserResult.windowsBefore, 'Browser inspection closes its temporary window');
    assert.equal(crossOriginRequests, 0, 'Different-origin browser subrequests were blocked');
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, project);
    let page;
    for (let count = 0; count < 100; count++) {
      page = app.windows().find(window => window.url().startsWith('http://localhost:5173') || window.url().startsWith('file://'));
      if (page) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(page, 'Main renderer window was created');
    mainPage = page;
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('combobox', { name: 'Agent mode' })).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole('heading', { name: 'Start with an idea', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Workspace details', exact: true })).toHaveCount(0);
    await page.screenshot({path: path.join(artifacts, `${packaged ? 'packaged-' : ''}crux-empty-home.png`)});
    const configuration = await page.evaluate(async () => window.electron.ai.getSettings());
    assert.equal(configuration.data.provider, 'custom', 'Initial fixture settings loaded; provider confirmation is not bypassed');
    assert.equal(configuration.data.apiKey, '', 'The renderer never receives the stored key');
    assert.equal(configuration.data.hasApiKey, true, 'Saved credential presence is reflected safely');
    const storedConfiguration = JSON.parse(await fs.readFile(path.join(profile, 'config.json'), 'utf8'));
    assert.equal(storedConfiguration.ai.settings.apiKey, '', 'Legacy fixture key is removed from plaintext storage');
    assert(Object.values(storedConfiguration.ai.credentials).every(value => value !== 'fixture-only-key'), 'OS-encrypted scoped credentials are stored');
    await page.getByRole('combobox', {name: 'Choose project'}).selectOption('__open__');
    await expect(page.getByRole('combobox', {name: 'Choose project'})).toHaveValue(project);
    const navigation = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(navigation).toBeVisible();
    await expect(navigation.getByRole('button', { name: /^Settings/ })).toHaveCount(1);
    await expect(navigation.getByRole('button', { name: /^(Models|Manage|Projects|Open|Switch|Terminal|Command Palette)$/ })).toHaveCount(0);
    await expect(navigation.getByRole('combobox')).toHaveCount(0);
    await navigation.getByRole('button', { name: /^Settings/ }).click();
    await expect(page.getByRole('heading', { name: 'Connect your AI', exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Agent mode' })).toHaveCount(0);
    await expect(page.getByPlaceholder('Run a safe shell command')).toHaveCount(0);
    await expect(page.getByLabel(/^Model/)).toHaveCount(1);
    await expect(page.getByRole('combobox', { name: 'Detected models' })).toHaveCount(0);
    const settingsModel = page.getByRole('combobox', { name: 'Model', exact: true });
    await expect(settingsModel).toBeEnabled({ timeout: 20000 });
    assert(authenticatedCatalog, 'Actual catalog discovery uses the saved credential');
    await settingsModel.selectOption('fixture-alternative');
    await expect.poll(async () => (await page.evaluate(() => window.electron.ai.getSettings())).data.model).toBe('fixture-alternative');
    const provider = page.getByRole('combobox', { name: 'Provider', exact: true });
    await expect(provider).toHaveValue('custom');
    await expect(page.getByLabel('Base URL', { exact: true })).toBeVisible();
    await expect(page.getByLabel(/^Ollama URL/)).toHaveCount(0);
    await provider.selectOption('ollama');
    await expect(page.getByLabel(/^Ollama URL/)).toHaveCount(0);
    await expect(page.getByRole('textbox', {name: /^API key/})).toHaveCount(0);
    await provider.selectOption('openai');
    await expect(page.getByRole('textbox', {name: /^API key/})).toBeVisible();
    await expect(page.getByLabel('OpenAI base URL', {exact: true})).toHaveCount(0);
    await expect(page.getByLabel('Base URL', {exact: true})).toHaveCount(0);
    await expect(provider.locator('option')).toHaveCount(12);
    await page.getByText('Advanced settings', {exact: true}).click();
    const temperature = page.getByLabel(/^Temperature/);
    const originalTemperature = configuration.data.temperature;
    await temperature.fill('0.3');
    await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(temperature).toHaveValue(String(originalTemperature));
    assert.equal((await page.evaluate(() => window.electron.ai.getSettings())).data.provider, 'custom', 'Reset draft never changes persisted provider');
    await temperature.fill('0.3');
    await expect(page.getByLabel('Performance', { exact: true })).toHaveCount(0);
    await temperature.fill('');
    await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
    await temperature.fill('0.3');
    const tokens = page.getByLabel(/^Maximum tokens/);
    await tokens.fill('65537');
    await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
    await tokens.fill(String(configuration.data.maxTokens));
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByRole('status').filter({hasText:'Connection saved.'})).toContainText(/saved/i);
    assert.equal((await page.evaluate(() => window.electron.ai.getSettings())).data.temperature, 0.3, 'Settings Save persists generation configuration');
    await page.getByText('Advanced settings', {exact: true}).click();
    await expect(provider).toHaveValue('custom');
    await page.locator('.settings-sheet').evaluate(element => { element.parentElement.scrollTop = 0; });
    await page.screenshot({ path: path.join(artifacts, `${packaged ? 'packaged-' : ''}crux-settings.png`), fullPage: true });
    await page.locator('.conversation-link').first().click();
    const chatModel = page.getByRole('combobox', { name: 'Chat model', exact: true });
    await expect(chatModel).toHaveValue('fixture-alternative');
    await chatModel.selectOption('fixture-model');
    await expect.poll(async () => (await page.evaluate(() => window.electron.ai.getSettings())).data.model).toBe('fixture-model');
    await navigation.getByRole('button', { name: /^Settings/ }).click();
    await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue('fixture-model');
    await page.locator('.conversation-link').first().click();
    const mode = () => page.getByRole('combobox', { name: 'Agent mode' });
    await expect(mode('plan')).toBeEnabled({ timeout: 15000 });
    await expect(page.getByRole('combobox', { name: 'Agent access level' })).toHaveValue('medium');
    const session = await page.evaluate(() => JSON.parse(localStorage.getItem('crux-ui-state')).state.activeConversationId);
    assert(session);
    const denied = await page.evaluate(async id => window.electron.agent.execute(id, { tool: 'write', path: 'denied.txt', content: 'must not exist' }), session);
    assert.equal(denied.success, false); assert.match(denied.error, /Plan/);
    await assert.rejects(fs.access(path.join(project, 'denied.txt')));
    await page.getByRole('textbox', {name: 'Message', exact: true}).fill('Plan a greeting file'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(mode('code')).toBeEnabled({ timeout: 20000 });
    const before = await page.evaluate(async id => (await window.electron.agent.snapshot(id)).data.state, session);
    assert.equal(before.plan.summary, plan.summary);
    for (const value of ['code', 'debug', 'code']) { await mode().selectOption(value); await expect(mode()).toHaveValue(value); }
    const after = await page.evaluate(async id => (await window.electron.agent.snapshot(id)).data.state, session);
    assert.deepEqual(after.plan, before.plan); assert.deepEqual(after.history, before.history);
    await page.getByRole('textbox', {name: 'Message', exact: true}).fill('Implement the greeting plan'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toBeVisible({ timeout: 20000 });
    await page.getByRole('button', { name: 'Allow once', exact: true }).click();
    await expect(mode('code')).toBeEnabled({ timeout: 20000 });
    const completed = await page.evaluate(async id => (await window.electron.agent.snapshot(id)).data, session);
    assert.equal(completed.state.status, 'completed', completed.state.blockedReason);
    assert.equal(completed.state.testResults.at(-1).exitCode, 0);
    assert.equal(await fs.readFile(path.join(project, 'hello.txt'), 'utf8'), 'hello from Crux');
    assert(completed.audit.some(entry => entry.outcome === 'denied'));
    assert(completed.audit.some(entry => entry.outcome === 'completed'));
    assert(requests >= 2);
    assert.equal(selectedModel, 'fixture-model', 'The chat selection is used in actual provider requests');
    await fs.writeFile(path.join(project, 'hello.txt'), 'broken greeting');
    await mode().selectOption('debug'); await expect(mode()).toHaveValue('debug');
    await page.getByRole('textbox', {name: 'Message', exact: true}).fill('Repair greeting'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    for (let approval = 0; approval < 2; approval++) {
      await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toBeVisible({ timeout: 20000 });
      const requestId = await page.evaluate(async id => (await window.electron.agent.snapshot(id)).data.approvals[0].id, session);
      await page.getByRole('button', { name: 'Allow once', exact: true }).click();
      await expect.poll(async () => page.evaluate(async ({id, requestId}) => !(await window.electron.agent.snapshot(id)).data.approvals.some(item => item.id === requestId), {id: session, requestId}), { timeout: 20000 }).toBe(true);
    }
    await expect(mode('debug')).toBeEnabled({ timeout: 20000 });
    const repaired = await page.evaluate(async id => (await window.electron.agent.snapshot(id)).data, session);
    assert.equal(repaired.state.status, 'completed', repaired.state.blockedReason);
    assert.equal(repaired.state.testResults.at(-2).passed, false); assert.equal(repaired.state.testResults.at(-1).passed, true);
    assert.equal(await fs.readFile(path.join(project, 'hello.txt'), 'utf8'), 'hello from Crux');
    await mode().selectOption('code');
    await expect(page.getByText('Integrated Terminal', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Hide Terminal|Show Terminal/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Hide workspace', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Workspace details', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Show workspace', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Workspace details', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Hide projects and chats', exact: true }).click();
    await expect(page.getByRole('navigation', {name: 'Projects and chats'})).toHaveCount(0);
    await page.getByRole('button', { name: 'Show projects and chats', exact: true }).click();
    await expect(navigation).toBeVisible();
    for (const [width, height] of [[1440, 900], [1280, 800]]) {
      await app.evaluate(({ BrowserWindow }, bounds) => { const win = BrowserWindow.getAllWindows().find(w => /^(http:\/\/localhost:5173|file:\/\/)/.test(w.webContents.getURL())); win.setSize(bounds.width, bounds.height); }, { width, height });
      await page.screenshot({ path: path.join(artifacts, `${packaged ? 'packaged-' : ''}crux-${width}x${height}.png`), fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, 'Workspace has no horizontal page overflow');
      const composer = await page.getByRole('button', { name: 'Send message', exact: true }).boundingBox();
      assert(composer.y + composer.height <= await page.evaluate(() => window.innerHeight), 'Composer remains within the laptop viewport');
    }
    await page.reload(); await expect(mode()).toHaveValue('code', { timeout: 20000 });
    const restored = await page.evaluate(async id => (await window.electron.agent.snapshot(id)).data.state, session);
    assert.deepEqual(restored.plan, repaired.state.plan); assert.deepEqual(restored.testResults, repaired.state.testResults);
    assert.equal(restored.status, 'completed');
    const secondProject = path.join(temporary, 'another-project'); await fs.mkdir(secondProject);
    await app.evaluate(({dialog}, selected) => { dialog.showOpenDialog = async () => ({canceled: false, filePaths: [selected]}); }, secondProject);
    await page.getByRole('combobox', {name: 'Choose project'}).selectOption('__open__');
    await expect(page.getByRole('combobox', {name: 'Choose project'})).toHaveValue(secondProject);
    await expect(page.getByRole('heading', {name: 'Start with an idea', exact:true})).toBeVisible();
    const otherSession = await page.evaluate(() => JSON.parse(localStorage.getItem('crux-ui-state')).state.activeConversationId);
    assert.notEqual(otherSession, session, 'Another project receives a distinct chat');
    await page.getByRole('combobox', {name: 'Choose project'}).selectOption(project);
    await expect(page.getByRole('combobox', {name: 'Choose project'})).toHaveValue(project);
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('crux-ui-state')).state.activeConversationId)).toBe(session);
    const returned = await page.evaluate(async id => (await window.electron.agent.snapshot(id)).data.state, session);
    assert.deepEqual(returned.plan, restored.plan); assert.deepEqual(returned.testResults, restored.testResults);
    await page.getByRole('button',{name:'Hide workspace',exact:true}).click();
    await navigation.getByRole('button',{name:'Agents and Skills',exact:true}).click();
    const hub=page.getByRole('region',{name:'Agents and Skills'});
    await hub.getByRole('tab',{name:'Skills',exact:true}).click();
    await hub.getByRole('button',{name:'Create',exact:true}).click();
    await hub.getByLabel('Name',{exact:true}).fill('Fixture helper');
    await hub.getByLabel(/^Handle/).fill('fixture-helper');
    await hub.getByLabel('How it works',{exact:true}).fill('Fixture helper instruction: inspect carefully.');
    await hub.getByRole('button',{name:'book logo',exact:true}).click();
    await hub.getByRole('button',{name:'Create skill',exact:true}).click();
    await expect(hub.getByRole('button',{name:'Edit Fixture helper',exact:true})).toBeVisible();
    await hub.getByRole('tab',{name:'Agents',exact:true}).click();
    await hub.getByRole('button',{name:'Create',exact:true}).click();
    await hub.getByLabel('Name',{exact:true}).fill('Fixture Reviewer');
    await hub.getByLabel(/^Handle/).fill('review-fixture');
    await hub.getByLabel('Description',{exact:true}).fill('Reviews a fixture project.');
    await hub.getByLabel('How it works',{exact:true}).fill('Review the plan with the attached helper.');
    await hub.getByRole('button',{name:'shield logo',exact:true}).click();
    await hub.getByText('Advanced permissions and integrations',{exact:true}).click();
    await hub.getByRole('group',{name:'Attached skills',exact:true}).getByRole('checkbox',{name:'Fixture helper',exact:true}).check();
    await hub.getByRole('group',{name:'Callable skills',exact:true}).getByRole('checkbox',{name:'Fixture helper',exact:true}).check();
    await hub.getByRole('button',{name:'Create agent',exact:true}).click();
    await expect(hub.getByRole('button',{name:'Edit Fixture Reviewer',exact:true})).toBeVisible();
    const definitions=await page.evaluate(()=>window.electron.agent.catalog());
    const reviewer=definitions.data.agents.find(a=>a.handle==='review-fixture');
    assert.equal(reviewer.icon,'shield');assert.equal(reviewer.skillIds.length,1);assert.equal(reviewer.callableSkillIds.length,1);
    await page.screenshot({path:path.join(artifacts,`${packaged?'packaged-':''}crux-agents-skills.png`)});
    await hub.getByRole('button',{name:'Close Agents and Skills',exact:true}).click();
    await mode().selectOption('plan');
    const prompt=page.getByRole('textbox',{name:'Message',exact:true});
    await prompt.fill('@review');
    await expect(page.getByRole('listbox',{name:'Agents and skills suggestions'})).toBeVisible();
    await prompt.press('Enter');await expect(prompt).toHaveValue('@review-fixture ');
    await prompt.fill('@review-fixture Review the plan');
    await page.getByRole('button',{name:'Send message',exact:true}).click();
    await expect(mode()).toBeEnabled({timeout:20000});
    const routed=await page.evaluate(async id=>(await window.electron.agent.snapshot(id)).data,session);
    assert.equal(routed.state.route.agent.id,reviewer.id);assert.equal(routed.state.activeSkills.length,1);
    assert.equal(routed.permissions.capabilities.write,false);
    await prompt.fill('@missing A task');await expect(page.getByRole('alert')).toContainText('Unknown handle');
    await expect(page.getByRole('button',{name:'Send message',exact:true})).toBeDisabled();
    await prompt.fill('');
    await page.getByRole('combobox',{name:'Agent routing'}).selectOption('__default__');
    await page.reload();await expect(mode()).toBeVisible({timeout:20000});
    assert.equal((await page.evaluate(()=>window.electron.agent.catalog())).data.agents.length,1);


    assert.deepEqual(errors, []);
    await app.close(); app = undefined;
    const freshProfile = path.join(temporary, 'fresh-profile'); await fs.mkdir(freshProfile);
    app = await electron.launch({ ...(packaged ? { executablePath: process.env.CRUX_TEST_EXECUTABLE || path.join(root, 'release', 'Crux AI-win32-x64', 'Crux AI.exe') } : {}), args: [...(packaged ? [] : [root]), `--user-data-dir=${freshProfile}`], env, timeout:45000 });
    let fresh; for(let attempt=0;attempt<100;attempt++){fresh=app.windows().find(window=>window.url().startsWith('http://localhost:5173') || window.url().startsWith('file://'));if(fresh)break;await new Promise(resolve=>setTimeout(resolve,100));} assert(fresh,'Fresh main renderer opened'); mainPage=fresh;
    await expect(fresh.getByRole('button', {name:'Set up', exact:true})).toBeVisible({timeout:30000});
    await expect(fresh.getByRole('combobox', {name:'Choose project'})).toHaveValue('');
    await expect(fresh.locator('.project-group-title')).toHaveCount(0);
    await fresh.getByRole('button', {name:'Set up', exact:true}).click();
    const freshProvider = fresh.getByRole('combobox', {name:'Provider', exact:true});
    await expect(freshProvider).toHaveValue('');
    await freshProvider.selectOption('openai');
    await expect(fresh.getByRole('textbox', {name:/^API key/})).toBeVisible();
    await expect(fresh.getByLabel('Base URL', {exact:true})).toHaveCount(0);
    await fresh.screenshot({path:path.join(artifacts, `${packaged ? 'packaged-' : ''}crux-setup.png`)});
    await freshProvider.selectOption('custom');
    await expect(fresh.getByLabel('Base URL', {exact:true})).toBeVisible();
    await app.evaluate(async ({app,dialog})=>{
      const {CatalogRegistry}=process.mainModule.require(app.getAppPath()+'/electron/dist/services/agent/catalogRegistry.js');
      const {prepareGithubSkill}=process.mainModule.require(app.getAppPath()+'/electron/dist/services/agent/githubSkillSource.js');
      const source='---\nname: Imported fixture\ndescription: Imported test skill\n---\nRead carefully.';
      CatalogRegistry.prototype.prepareGithub=function(url,_transport,signal){return prepareGithubSkill(url,async requested=>{
        if(requested.includes('/commits/'))return Buffer.from(JSON.stringify({sha:'b'.repeat(40)}));
        if(requested.includes('/contents/'))return Buffer.from(JSON.stringify([{name:'SKILL.md',path:'sample/SKILL.md',type:'file',size:Buffer.byteLength(source)},{name:'guide.md',path:'sample/guide.md',type:'file',size:4}]));
        return Buffer.from(requested.endsWith('guide.md')?'data':source);
      },signal);};
      dialog.showMessageBox=async (_window,options)=>{
        if(options.title!=='Install skill')throw new Error('Unexpected native dialog');
        if(!options.detail.includes('/skills') && !options.detail.includes('\\skills'))throw new Error('Missing destination');
        if(!options.detail.includes('b'.repeat(40)) || !options.detail.includes('Files: 2'))throw new Error('Missing pinned source/files');
        return {response:1};
      };
    });
    await fresh.getByRole('button',{name:'Chats',exact:true}).click();
    await fresh.getByRole('textbox',{name:'Message',exact:true}).fill('Install this skill https://github.com/fixture/skill/tree/main/sample');
    await fresh.getByRole('button',{name:'Send message',exact:true}).click();
    await expect(fresh.getByText(/Installed Imported fixture in/)).toBeVisible({timeout:20000});
    const imported=(await fresh.evaluate(()=>window.electron.agent.catalog())).data.skills[0];
    assert.equal(imported.keywords.length,0);assert.equal(imported.provenance.fileCount,2);
    assert.equal((await fresh.evaluate(()=>window.electron.agent.previewRoute('An unrelated task'))).data.source,'default');
    assert(imported.source.startsWith(path.join(freshProfile,'agent','skills','imports')));
    assert.equal(await fs.readFile(path.join(path.dirname(imported.source),'guide.md'),'utf8'),'data');
    if (nativeActions) {
      assert(nativeRequests >= 4, 'Native model replies exercised Plan, Code, Debug and repair');
      console.log('PASS native structured actions: malformed first response repaired; native streamed calls reached existing permission/execution pipeline.');
    }


    console.log(`PASS actual Electron ${packaged ? 'packaged' : 'development'}: Plan/Code/Debug context, Medium default, denied write, local fixture plan, file creation, UI approval, real command exit evidence, actual Debug failing reproduction/repair/passing regression, audit, true fixture SSE streaming, CRUD logos/integrations/@routing, GitHub chat import without provider, reload, distinct project chats and restored plan/test evidence, 1440/1280 geometry/screenshots, no renderer errors. Browser adapter-only inspection extracted title/text/links, blocked cross-origin image, disabled Node integration, and closed its window. Native picker, native security confirmations, browser UI permission enabling, and paid AI provider are untested.`);
  } catch (error) {
    if (mainPage) {
      if (nativeActions) console.error('Fixture agent diagnostics:', await mainPage.evaluate(async () => {const id=JSON.parse(localStorage.getItem('crux-ui-state')).state.activeConversationId; const result=await window.electron.agent.snapshot(id); return {errors:result.data?.state.errors.slice(-4),audit:result.data?.audit.slice(-8)};}).catch(()=>null));
      console.error('Renderer URL:', mainPage.url());
      console.error('Renderer body:', (await mainPage.locator('body').innerText()).slice(0, 5000));
      await mainPage.screenshot({ path: path.join(artifacts, 'crux-runtime-failure.png') }).catch(() => {});
    }
    throw error;
  } finally {
    if (app) await app.close();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
