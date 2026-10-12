const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {PermissionGateway}=require('../electron/dist/services/agent/permissionGateway.js');
const {FileService}=require('../electron/dist/services/fileService.js');
const {ToolService}=require('../electron/dist/services/agent/toolService.js');

async function fixture(t,mode='code'){
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'crux-coding-security-'));
  const project=path.join(temporary,'project');const external=path.join(temporary,'external');await fs.mkdir(project);await fs.mkdir(external);
  await fs.writeFile(path.join(project,'source.ts'),'export const greeting = "original";\n');await fs.writeFile(path.join(external,'private.ts'),'outside');
  t.after(async()=>{assert(path.relative(os.tmpdir(),temporary).startsWith('crux-coding-security-'));await fs.rm(temporary,{recursive:true,force:true});});
  let gateway;let decision='deny';const approvals=[];gateway=new PermissionGateway('security',project,mode,()=>{},request=>{approvals.push(request);gateway.resolve(request.id,decision);});
  const files=new FileService();const terminal={executeAndWait:async()=>{throw new Error('Unexpected command');},executeAndWaitSandbox:async()=>{throw new Error('Unexpected sandbox command');}};
  const {ChangeStore}=require('../electron/dist/services/agent/changeStore.js');const changes=new ChangeStore(path.join(temporary,'checkpoints'),project,'security');
  const tools=new ToolService(gateway,files,terminal,undefined,changes);
  return{temporary,project,external,gateway,files,tools,approvals,changes,decide:value=>{decision=value;}};
}
const hash=text=>createHash('sha256').update(text).digest('hex');

test('file tools preserve workspace boundaries against traversal and junctions',async t=>{
  const f=await fixture(t);await fs.symlink(f.external,path.join(f.project,'link'),process.platform==='win32'?'junction':'dir');
  for(const target of ['../external/private.ts','link/private.ts']){await assert.rejects(f.tools.execute({tool:'read',path:target}),/approval|outside/i);await assert.rejects(f.tools.execute({tool:'write',path:target,content:'overwrite'}),/approval|outside/i);}
  assert.equal(await fs.readFile(path.join(f.external,'private.ts'),'utf8'),'outside');
});

test('Plan mode and delegated read-only scopes deny filesystem mutations',async t=>{
  const f=await fixture(t,'plan');const expectedHash=hash(await fs.readFile(path.join(f.project,'source.ts'),'utf8'));await assert.rejects(f.tools.execute({tool:'write',path:'source.ts',content:'overwrite',expectedHash}),/Plan/);f.gateway.setMode('code');f.gateway.setRouteCapabilities(['read']);await assert.rejects(f.tools.execute({tool:'write',path:'source.ts',content:'overwrite',expectedHash}),/disabled/);assert.equal(await fs.readFile(path.join(f.project,'source.ts'),'utf8'),'export const greeting = "original";\n');
});

test('targeted edit preserves unrelated text and rejects stale inspected content',async t=>{
  const f=await fixture(t);const file=path.join(f.project,'source.ts');const before=await fs.readFile(file,'utf8');await f.tools.execute({tool:'edit',path:'source.ts',search:'original',replacement:'changed',expectedHash:hash(before)});assert.equal(await fs.readFile(file,'utf8'),before.replace('original','changed'));await assert.rejects(f.tools.execute({tool:'edit',path:'source.ts',search:'changed',replacement:'stale overwrite',expectedHash:hash(before)}),/changed|hash|stale|conflict/i);assert.equal(await fs.readFile(file,'utf8'),before.replace('original','changed'));
});

test('read followed by external user edit cannot be overwritten by a hashless write',async t=>{
  const f=await fixture(t);await f.tools.execute({tool:'read',path:'source.ts'});await fs.writeFile(path.join(f.project,'source.ts'),'latest user work');await assert.rejects(f.tools.execute({tool:'write',path:'source.ts',content:'blind generated overwrite'}),/changed|hash|inspect|conflict/i);assert.equal(await fs.readFile(path.join(f.project,'source.ts'),'utf8'),'latest user work');
});

test('existing files cannot be blindly rewritten and successful cached edits can continue safely',async t=>{
  const f=await fixture(t);await assert.rejects(f.tools.execute({tool:'write',path:'source.ts',content:'blind overwrite'}),/inspect|read|hash/i);await f.tools.execute({tool:'read',path:'source.ts'});await f.tools.execute({tool:'edit',path:'source.ts',search:'original',replacement:'first'});await f.tools.execute({tool:'edit',path:'source.ts',search:'first',replacement:'second'});assert.equal(await fs.readFile(path.join(f.project,'source.ts'),'utf8'),'export const greeting = "second";\n');
});

test('symbol and reference searches expose bounded lexical matches through same scope',async t=>{
  const f=await fixture(t);const declaration=await f.tools.execute({tool:'symbol_search',pattern:'greeting'});assert.equal(declaration.kind,'lexical');assert.equal(declaration.matches.length,1);assert.equal(declaration.matches[0].line,1);const references=await f.tools.execute({tool:'find_references',pattern:'greeting'});assert.equal(references.kind,'lexical');assert.equal(references.matches.length,1);await assert.rejects(f.tools.execute({tool:'symbol_search',pattern:'(a+)+'}),/identifier|lexical/i);
});

test('multi-file patch rejects any stale member before writing the first file',async t=>{
  const f=await fixture(t);const original=await fs.readFile(path.join(f.project,'source.ts'),'utf8');await fs.writeFile(path.join(f.project,'second.ts'),'second');await assert.rejects(f.tools.execute({tool:'patch',edits:[{path:'source.ts',search:'original',replacement:'new',expectedHash:hash(original)},{path:'second.ts',search:'second',replacement:'new',expectedHash:hash('outdated')}]}),/changed|hash|stale|conflict/i);assert.equal(await fs.readFile(path.join(f.project,'source.ts'),'utf8'),original);assert.equal(await fs.readFile(path.join(f.project,'second.ts'),'utf8'),'second');
});

test('persisted checkpoint exposes exact diff and reverts only unchanged agent output',async t=>{
  const f=await fixture(t);f.decide('once');const file=path.join(f.project,'source.ts');const original=await fs.readFile(file,'utf8');await f.tools.execute({tool:'edit',path:'source.ts',search:'original',replacement:'changed',expectedHash:hash(original)});const records=await f.tools.execute({tool:'changes'});assert.equal(records.length,1);const detail=await f.tools.execute({tool:'changes',changeId:records[0].id});assert.equal(detail.before,original);assert.equal(detail.after,original.replace('original','changed'));
  await fs.writeFile(file,'new user modification');await assert.rejects(f.tools.execute({tool:'revert',changeId:records[0].id}),/changed|conflict|user/i);assert.equal(await fs.readFile(file,'utf8'),'new user modification');
  await fs.writeFile(file,detail.after);f.gateway.setLevel('full');await f.tools.execute({tool:'revert',changeId:records[0].id});assert.equal(await fs.readFile(file,'utf8'),original);
});

test('renaming cannot overwrite a preexisting destination',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.project,'destination.ts'),'user destination');await assert.rejects(f.tools.execute({tool:'move',path:'source.ts',destination:'destination.ts'}),/exist|overwrite/i);assert.equal(await fs.readFile(path.join(f.project,'destination.ts'),'utf8'),'user destination');assert(await fs.stat(path.join(f.project,'source.ts')));
});

test('file_create refuses existing files instead of treating create as overwrite',async t=>{
  const f=await fixture(t);const before=await fs.readFile(path.join(f.project,'source.ts'),'utf8');await assert.rejects(f.tools.execute({tool:'file_create',path:'source.ts',content:'overwrite'}),/existing|overwrite|Create/i);assert.equal(await fs.readFile(path.join(f.project,'source.ts'),'utf8'),before);
});

test('partial patch failure rolls back prior changes and preserves newer user edits',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.project,'second.ts'),'second');const before=await fs.readFile(path.join(f.project,'source.ts'),'utf8');const write=f.files.writeFile.bind(f.files);f.files.writeFile=async(file,content)=>{if(file.endsWith('second.ts')){await fs.writeFile(path.join(f.project,'source.ts'),'newer user edit');throw new Error('Fixture disk failure');}await write(file,content);};await assert.rejects(f.tools.execute({tool:'patch',edits:[{path:'source.ts',search:'original',replacement:'agent',expectedHash:hash(before)},{path:'second.ts',search:'second',replacement:'agent',expectedHash:hash('second')}]}),/rollback conflicts|newer/i);assert.equal(await fs.readFile(path.join(f.project,'source.ts'),'utf8'),'newer user edit');assert.equal(await fs.readFile(path.join(f.project,'second.ts'),'utf8'),'second');assert((await f.changes.list()).length>0,'Recoverable checkpoint persists after conflicting rollback');
});

test('repository context detects managers/tests and includes environment names without secret values',async t=>{
  const f=await fixture(t);const secret='NEVER_MODEL_ENV_VALUE_8873';await fs.writeFile(path.join(f.project,'.env'),`PRIVATE_KEY=${secret}`);await fs.writeFile(path.join(f.project,'.env.example'),`PUBLIC_API_URL=${secret}\nexport DATABASE_URL=${secret}`);await fs.writeFile(path.join(f.project,'package.json'),JSON.stringify({packageManager:'pnpm@9',scripts:{test:'vitest run',lint:'eslint src'},devDependencies:{vitest:'1',typescript:'5'},dependencies:{react:'18'}}));await fs.writeFile(path.join(f.project,'pnpm-lock.yaml'),'lockfileVersion: 9');
  const {inspectRepository}=require('../electron/dist/services/agent/repositoryContext.js');const context=await inspectRepository(f.project,f.files);assert(context.metadata.packageManagers.includes('pnpm'));assert(context.metadata.frameworks.includes('Vitest'));assert(context.metadata.environmentNames.includes('PUBLIC_API_URL'));assert(context.metadata.environmentNames.includes('DATABASE_URL'));assert(!JSON.stringify(context).includes(secret));assert(!context.files.some(file=>path.basename(file)==='.env'));
});

test('checkpoint IDs remain isolated by session and persist exact prior user work',async t=>{
  const f=await fixture(t);const userWork='uncommitted user work\n';await fs.writeFile(path.join(f.project,'source.ts'),userWork);await f.tools.execute({tool:'edit',path:'source.ts',search:'user work',replacement:'agent change',expectedHash:hash(userWork)});const records=await f.tools.execute({tool:'changes'});const {ChangeStore}=require('../electron/dist/services/agent/changeStore.js');const reload=new ChangeStore(path.join(f.temporary,'checkpoints'),f.project,'security');assert.equal((await reload.detail(records[0].id)).before,userWork);const other=new ChangeStore(path.join(f.temporary,'checkpoints'),f.project,'other-session');await assert.rejects(other.detail(records[0].id),/session|belong/i);
});

test('directory junction changes during checkpoint preparation cannot redirect writes outside project',async t=>{
  const f=await fixture(t);const nested=path.join(f.project,'nested');await fs.mkdir(nested);const content='original';await fs.writeFile(path.join(nested,'item.ts'),content);await fs.writeFile(path.join(f.external,'item.ts'),content);const commit=f.changes.commit.bind(f.changes);f.changes.commit=async records=>{await commit(records);await fs.rename(nested,`${nested}-original`);await fs.symlink(f.external,nested,process.platform==='win32'?'junction':'dir');};await assert.rejects(f.tools.execute({tool:'edit',path:'nested/item.ts',search:content,replacement:'must stay inside',expectedHash:hash(content)}),/path|outside|changed/i);assert.equal(await fs.readFile(path.join(f.external,'item.ts'),'utf8'),content);
});

test('checkpoints reject credential and binary files',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.project,'.env'),'PRIVATE=secret');await fs.writeFile(path.join(f.project,'binary.bin'),Buffer.from([0,1,2]));await assert.rejects(f.changes.capture(path.join(f.project,'.env'),'replacement'),/Credential|secret/i);await assert.rejects(f.changes.capture(path.join(f.project,'binary.bin'),'replacement'),/Binary|text/i);
});

test('diagnostics identify clickable project lines but discard external filesystem links',async t=>{
  const f=await fixture(t);const {parseDiagnostics}=require('../electron/dist/services/agent/diagnosticParser.js');const diagnostics=parseDiagnostics({command:'npm run typecheck',exitCode:1,timedOut:false,output:'source.ts(8,4): error TS2322: Type mismatch\n../external/private.ts(3,2): error TS0000: External diagnostic\n'},f.project);assert.equal(diagnostics.length,2);assert.equal(diagnostics[0].file,path.join(f.project,'source.ts'));assert.equal(diagnostics[0].line,8);assert.equal(diagnostics[0].column,4);assert.equal(diagnostics[0].code,'TS2322');assert.equal(diagnostics[1].file,undefined);
});

test('diagnostics parse actual streams instead of concatenated terminal metadata',async t=>{
  const f=await fixture(t);const {parseDiagnostics}=require('../electron/dist/services/agent/diagnosticParser.js');const stderr='source.ts(1,3): error TS2322: actual failure\r';const diagnostics=parseDiagnostics({command:'check',exitCode:1,timedOut:false,output:`Running in ${f.project}${stderr}`,stdout:'',stderr},f.project);assert.equal(diagnostics[0].file,path.join(f.project,'source.ts'));assert.equal(diagnostics[0].message,'actual failure');
});
test('real terminal returns separate output, cwd, duration and exit code',async t=>{
  const f=await fixture(t);const {TerminalService}=require('../electron/dist/services/terminalService.js');const terminal=new TerminalService();const result=await terminal.executeAndWait('node -e "console.log(\'real stdout\');console.error(\'real stderr\');process.exit(3)"',f.project,undefined,10000);assert.equal(result.exitCode,3);assert.equal(result.cwd,f.project);assert(result.stdout.includes('real stdout'));assert(result.stderr.includes('real stderr'));assert(result.durationMs>=0);assert.equal(result.execution,'host');
});

test('real terminal honors bounded timeout and cancellation',async t=>{
  const f=await fixture(t);const {TerminalService}=require('../electron/dist/services/terminalService.js');const terminal=new TerminalService();const timeout=await terminal.executeAndWait('node -e "setTimeout(()=>{},10000)"',f.project,undefined,100);assert.equal(timeout.timedOut,true);assert.equal(terminal.getSessions().filter(session=>session.status==='running').length,0);const controller=new AbortController();const pending=terminal.executeAndWait('node -e "setTimeout(()=>{},10000)"',f.project,controller.signal,10000);setTimeout(()=>controller.abort(),100);await assert.rejects(pending,/cancel|abort/i);assert.equal(terminal.getSessions().filter(session=>session.status==='running').length,0);
});

test('background process tools require exact approval and refuse cross-session stop',async t=>{
  const f=await fixture(t);f.decide('once');const {TerminalService}=require('../electron/dist/services/terminalService.js');const terminal=new TerminalService();const owned=new ToolService(f.gateway,f.files,terminal,undefined,f.changes);const other=new ToolService(f.gateway,f.files,terminal,undefined,f.changes);const started=await owned.execute({tool:'process_start',command:'node -e "setTimeout(()=>{},10000)"',timeoutMs:10000});assert.equal(started.execution,'host');assert(f.approvals.some(item=>item.tool==='execute'));await assert.rejects(other.execute({tool:'process_stop',sessionId:started.sessionId}),/belong|session/i);assert.equal((await other.execute({tool:'processes'})).length,0);assert.equal((await owned.execute({tool:'processes'})).length,1);await owned.execute({tool:'process_stop',sessionId:started.sessionId});assert.equal(terminal.getSessions().filter(session=>session.status==='running').length,0);
});

test('tool registry maps canonical aliases and declares missing adapters honestly',()=>{
  const {normalizeToolRequest,TOOL_DESCRIPTORS}=require('../electron/dist/services/agent/toolRegistry.js');assert.equal(normalizeToolRequest({tool:'code_search',pattern:'literal'}).tool,'search');assert.equal(normalizeToolRequest({tool:'test_run'}).checkKind,'test');assert.deepEqual(normalizeToolRequest({tool:'git_status'}).args,['status']);assert.throws(()=>normalizeToolRequest({tool:'invented_tool'}),/Unknown/);for(const name of ['web_search','github_issue','mcp']){const descriptor=TOOL_DESCRIPTORS.find(item=>item.name===name);assert.equal(descriptor.available,false);assert(descriptor.reason);}assert(TOOL_DESCRIPTORS.find(item=>item.name==='symbol_search').description.includes('lexical'));
});

test('delegation cannot bypass Debug reproduction requirement or reuse an old failure',async t=>{
  const f=await fixture(t);const {AgentOrchestrator,createAgentState}=require('../electron/dist/services/agent/orchestrator.js');const state=createAgentState('security',f.project);state.mode='debug';state.testResults.push({command:'old failing check',exitCode:1,output:'old error',passed:false,timestamp:1,revision:0});let writes=0;
  const agent=new AgentOrchestrator({model:{chat:async()=>JSON.stringify({message:'Attempt delegated edit',actions:[{tool:'write',path:'source.ts',content:'changed'}],done:true})},tools:{execute:async()=>{writes++;return{written:'source.ts'};}},gateway:f.gateway,persist:()=>{},emit:()=>{}},state);agent.reproductionStart=1;const id='b'.repeat(24);const child={id,revision:1,name:'Writer',handle:'writer',enabled:true,instructions:'Edit the code.',description:'',keywords:[],icon:'code',createdAt:1,updatedAt:1,allowedCapabilities:['read','write'],skillIds:[],callableAgentIds:[],callableSkillIds:[]};agent.catalog={revision:1,agents:[child],skills:[]};const route={source:'explicit',catalogRevision:1,originalText:'debug',executionText:'debug',skills:[],matchedKeywords:[],reason:'fixture',allowedAgentIds:[id],allowedSkillIds:[]};await assert.rejects(agent.executeAction({tool:'delegate',targetKind:'agent',targetId:id,task:'Fix it'},route,[],0),/reproduce/i);assert.equal(writes,0);agent.recordTest({command:'current failing check',exitCode:1,output:'current error',timedOut:false});await agent.executeAction({tool:'write',path:'source.ts',content:'changed'},route,[],0);assert.equal(writes,1);
});
