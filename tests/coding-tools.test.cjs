const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {FileService} = require('../electron/dist/services/fileService.js');
const {ToolService} = require('../electron/dist/services/agent/toolService.js');
const {PermissionGateway} = require('../electron/dist/services/agent/permissionGateway.js');
const {ChangeStore, contentHash} = require('../electron/dist/services/agent/changeStore.js');
const {inspectRepository} = require('../electron/dist/services/agent/repositoryContext.js');
const {TerminalService} = require('../electron/dist/services/terminalService.js');

async function fixture(t, mode='code') {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'crux-coding-'));
  const project = path.join(base, 'project'); await fs.mkdir(project);
  t.after(() => fs.rm(base,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  let gateway; gateway = new PermissionGateway('test',project,mode,()=>{},request=>gateway.resolve(request.id,'once'));
  const files = new FileService(); const changes = new ChangeStore(path.join(base,'snapshots'),project,'test');
  const tools = new ToolService(gateway,files,{executeAndWait:async()=>({command:'test',exitCode:0,output:'',timedOut:false})},undefined,changes);
  return {base,project,gateway,files,changes,tools};
}

test('targeted patch preserves existing user baseline and exact-hash revert refuses later edits',async t=>{
  const f=await fixture(t); const file=path.join(f.project,'app.ts'); const original='// user work\nconst value = 1;\n'; await fs.writeFile(file,original);
  await f.tools.execute({tool:'edit',path:file,search:'value = 1',replacement:'value = 2',expectedHash:contentHash(original)});
  const records=await f.tools.execute({tool:'changes'}); assert.equal(records.length,1); assert.equal('before' in records[0],false);
  const detail=await f.tools.execute({tool:'changes',changeId:records[0].id}); assert.equal(detail.before,original);
  await fs.writeFile(file,'new user edit'); await assert.rejects(f.tools.execute({tool:'revert',changeId:detail.id}),/conflict/); assert.equal(await fs.readFile(file,'utf8'),'new user edit');
  await fs.writeFile(file,detail.after); await f.tools.execute({tool:'revert',changeId:detail.id}); assert.equal(await fs.readFile(file,'utf8'),original);
});
test('multi-file patch prevalidation and duplicate searches prevent partial changes',async t=>{
  const f=await fixture(t); const a=path.join(f.project,'a.ts'),b=path.join(f.project,'b.ts'); await fs.writeFile(a,'one'); await fs.writeFile(b,'two');
  await assert.rejects(f.tools.execute({tool:'patch',edits:[{path:a,search:'one',replacement:'ONE',expectedHash:contentHash('one')},{path:b,search:'two',replacement:'TWO',expectedHash:contentHash('stale')}] }),/changed/);
  assert.equal(await fs.readFile(a,'utf8'),'one'); assert.equal((await f.changes.list()).length,0);
  await fs.writeFile(a,'one one'); await assert.rejects(f.tools.execute({tool:'edit',path:a,search:'one',replacement:'x',expectedHash:contentHash('one one')}),/exactly once/);
});
test('Plan denies patch/create/move/revert and create alias refuses overwrite',async t=>{
  const f=await fixture(t); const a=path.join(f.project,'a.ts'); await fs.writeFile(a,'one');
  await assert.rejects(f.tools.execute({tool:'file_create',path:a,content:'overwrite'}),/overwrite/);
  f.gateway.setMode('plan'); await assert.rejects(f.tools.execute({tool:'edit',path:a,search:'one',replacement:'two',expectedHash:contentHash('one')}),/Plan/);
  await assert.rejects(f.tools.execute({tool:'move',path:a,destination:'b.ts'}),/Plan/); assert.equal(await fs.readFile(a,'utf8'),'one');
});
test('repository context excludes secret values, generated directories and linked trees',async t=>{
  const f=await fixture(t); await fs.writeFile(path.join(f.project,'package.json'),JSON.stringify({scripts:{test:'vitest'},dependencies:{react:'1'},packageManager:'pnpm@9'}));
  await fs.writeFile(path.join(f.project,'.env'),'SECRET=supersecret'); await fs.writeFile(path.join(f.project,'.env.example'),'DATABASE_URL=privateexample\nPUBLIC_TOKEN=anothersecret');
  await fs.mkdir(path.join(f.project,'node_modules')); await fs.writeFile(path.join(f.project,'node_modules','hidden.ts'),'hidden');
  const context=await inspectRepository(f.project,f.files); const encoded=JSON.stringify(context); assert.ok(!encoded.includes('supersecret')); assert.ok(!encoded.includes('privateexample')); assert.ok(!encoded.includes('anothersecret')); assert.ok(!encoded.includes('hidden.ts')); assert.deepEqual(context.metadata.environmentNames,['DATABASE_URL','PUBLIC_TOKEN']); assert.ok(context.metadata.frameworks.includes('React'));
  await assert.rejects(f.tools.execute({tool:'read',path:'.env'}),/Credential/);
});
test('lazy tree, literal filename/code and lexical references return bounded actual results',async t=>{
  const f=await fixture(t); await fs.mkdir(path.join(f.project,'src')); await fs.writeFile(path.join(f.project,'src','app.ts'),'export function greet() { return "hi"; }\ngreet();');
  assert.equal((await f.tools.execute({tool:'list',recursive:false})).length,1);
  assert.equal((await f.tools.execute({tool:'file_search',pattern:'app.ts'})).length,1);
  assert.equal((await f.tools.execute({tool:'search',pattern:'greet()'})).length,2);
  const references=await f.tools.execute({tool:'find_references',pattern:'greet'}); assert.equal(references.kind,'lexical'); assert.equal(references.matches.length,2);
});
test('checkpoint namespaces isolate sessions and persisted corruption is rejected repeatedly',async t=>{
  const f=await fixture(t); const a=path.join(f.project,'a.ts'); await fs.writeFile(a,'one'); await f.tools.execute({tool:'read',path:a}); await f.tools.execute({tool:'write',path:a,content:'two'});
  const record=(await f.changes.list())[0]; const other=new ChangeStore(path.join(f.base,'snapshots'),f.project,'other'); await assert.rejects(other.detail(record.id),/session/);
  const stored=path.join(f.base,'snapshots',`${contentHash('test')}.json`); const data=JSON.parse(await fs.readFile(stored,'utf8')); data.records[0].before='tampered'; await fs.writeFile(stored,JSON.stringify(data));
  const reload=new ChangeStore(path.join(f.base,'snapshots'),f.project,'test'); await assert.rejects(reload.list(),/integrity/); await assert.rejects(reload.list(),/integrity/);
});
test('failed second write restores first file and does not discard user baseline',async t=>{
  const f=await fixture(t); const a=path.join(f.project,'a.ts'),b=path.join(f.project,'b.ts'); await fs.writeFile(a,'user one'); await fs.writeFile(b,'user two');
  const write=f.files.writeFile.bind(f.files); f.files.writeFile=async(file,content)=>{ if(file===b) throw new Error('fixture write failure'); return write(file,content); };
  await assert.rejects(f.tools.execute({tool:'patch',edits:[{path:a,search:'one',replacement:'ONE',expectedHash:contentHash('user one')},{path:b,search:'two',replacement:'TWO',expectedHash:contentHash('user two')}] }),/fixture write failure/);
  assert.equal(await fs.readFile(a,'utf8'),'user one'); assert.equal(await fs.readFile(b,'utf8'),'user two'); assert.equal((await f.changes.list()).length,0);
});
test('journal persistence failure prevents every file mutation',async t=>{
  const f=await fixture(t); const a=path.join(f.project,'a.ts'); await fs.writeFile(a,'user work'); await f.tools.execute({tool:'read',path:a});
  f.changes.commit=async()=>{throw new Error('fixture storage failure');};
  await assert.rejects(f.tools.execute({tool:'write',path:a,content:'agent edit'}),/storage failure/); assert.equal(await fs.readFile(a,'utf8'),'user work');
});
test('real bounded processes stay session-owned, stop, time out and respect Plan/container boundaries',async t=>{
  const f=await fixture(t); const terminal=new TerminalService(); const tools=new ToolService(f.gateway,f.files,terminal,undefined,f.changes);
  t.after(()=>Promise.all(terminal.getSessions().filter(item=>item.status==='running').map(item=>terminal.kill(item.id))));
  const command='node -e "setInterval(()=>{},1000)"';
  const started=await tools.execute({tool:'process_start',command,timeoutMs:30000}); assert.equal(started.execution,'host');
  assert.equal((await tools.execute({tool:'processes'})).length,1);
  const other=new ToolService(f.gateway,f.files,terminal); assert.equal((await other.execute({tool:'processes'})).length,0);
  await assert.rejects(other.execute({tool:'process_stop',sessionId:started.sessionId}),/belong/);
  await tools.execute({tool:'process_stop',sessionId:started.sessionId}); assert.equal(terminal.getSessions().find(item=>item.id===started.sessionId).status,'killed');
  const timed=await tools.execute({tool:'process_start',command,timeoutMs:50});
  const deadline=Date.now()+5000; while(terminal.getSessions().find(item=>item.id===timed.sessionId).status==='running' && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(terminal.getSessions().find(item=>item.id===timed.sessionId).status,'timed_out');
  f.gateway.setMode('plan'); await assert.rejects(tools.execute({tool:'process_start',command}),/Plan/);
  f.gateway.setMode('code'); f.gateway.setSandboxAvailable(true); await assert.rejects(tools.execute({tool:'process_start',command}),/no host fallback/);
});
test('diagnostics are bound explicitly and unavailable adapters stay truthful',async t=>{
  const f=await fixture(t); assert.equal((await f.tools.execute({tool:'tool_registry'})).find(item=>item.name==='diagnostics').available,false);
  f.tools.getDiagnostics=()=>[{message:'actual fixture error',severity:'error',source:'test'}]; assert.equal((await f.tools.execute({tool:'diagnostics'}))[0].message,'actual fixture error');
  const descriptors=await f.tools.execute({tool:'tool_registry'}); assert.equal(descriptors.find(item=>item.name==='diagnostics').available,true); assert.equal(descriptors.find(item=>item.name==='mcp').available,false);
});
test('denied host approval and narrowed agent scope never start a process',async t=>{
  const f=await fixture(t); const terminal=new TerminalService(); let approvals=0; let gateway;
  gateway=new PermissionGateway('denied',f.project,'code',()=>{},request=>{approvals++; gateway.resolve(request.id,'deny');});
  const tools=new ToolService(gateway,f.files,terminal);
  await assert.rejects(tools.execute({tool:'process_start',command:'node -e "console.log(1)"'}),/Approval denied/); assert.equal(approvals,1); assert.equal(terminal.getSessions().length,0);
  gateway.setRouteCapabilities(['read','execute']); await assert.rejects(tools.execute({tool:'process_start',command:'node -e "console.log(1)"'}),/bypass disabled/); assert.equal(terminal.getSessions().length,0);
});
test('empty file edit is hash-guarded and empty search cannot modify nonempty files',async t=>{
  const f=await fixture(t); const file=path.join(f.project,'empty.ts'); await fs.writeFile(file,'');
  await assert.rejects(f.tools.execute({tool:'edit',path:file,search:'',replacement:'x',expectedHash:contentHash('stale')}),/changed/);
  await f.tools.execute({tool:'edit',path:file,search:'',replacement:'export {};',expectedHash:contentHash('')}); assert.equal(await fs.readFile(file,'utf8'),'export {};');
  await assert.rejects(f.tools.execute({tool:'edit',path:file,search:'',replacement:'x',expectedHash:contentHash('export {};')}),/Empty search/);
});
