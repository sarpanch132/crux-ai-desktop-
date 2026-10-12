const {test} = require('node:test');
const assert = require('node:assert/strict');
const {PermissionGateway} = require('../electron/dist/services/agent/permissionGateway.js');
const {AgentOrchestrator, createAgentState} = require('../electron/dist/services/agent/orchestrator.js');
const {AgentRuntime} = require('../electron/dist/services/agent/runtime.js');

const full = ['read','write','delete','execute','gitRead','gitMutate','browser','computerControl','installDependencies'];
const id = 'a'.repeat(24);
const child = {id,revision:1,name:'Reader',handle:'reader',enabled:true,instructions:'Inspect only.',description:'',keywords:[],icon:'book',createdAt:1,updatedAt:1,allowedCapabilities:['read'],skillIds:[],callableAgentIds:[],callableSkillIds:[]};
const route = {source:'explicit',catalogRevision:1,originalText:'review',executionText:'review',skills:[],matchedKeywords:[],reason:'test',allowedAgentIds:[id],allowedSkillIds:[]};
function gateway() {const g = new PermissionGateway('review',null,'code',()=>{},()=>{});g.setRouteCapabilities(full);return g;}
function runtime() {
  const values = new Map(); let calls = 0;
  const ai = {getSettings:()=>({apiKey:''}),abortStream:()=>{},chatStreaming:async()=>{calls++;throw new Error('MODEL_SHOULD_NOT_RUN');}};
  const r = new AgentRuntime({get:k=>values.get(k),set:(k,v)=>values.set(k,v)},ai,{}, {sandboxAvailable:async()=>false},process.cwd(),()=>{});
  return {r,values,calls:()=>calls};
}
function deferred() {let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}

test('route intersection denies arbitrary execution despite execute enabled and grants willing',async()=>{
  const g=gateway();g.setRouteCapabilities(['read','execute']);
  await assert.rejects(g.authorize({capability:'execute',target:'node app.js',hostExecution:true}),/bypass disabled capabilities/);
  assert.equal(g.approvals.length,0);
});

test('delegated read-only scope remains narrowed after return and blocks manual mutation',async()=>{
  const g=gateway();
  const a=new AgentOrchestrator({model:{chat:async()=>'{"message":"Reviewed","actions":[],"done":true}'},tools:{execute:async()=>{throw new Error('Unexpected tool');}},gateway:g,skills:{list:async()=>[]},persist:()=>{},emit:()=>{}},createAgentState('review',null));
  a.catalog={revision:1,agents:[child],skills:[]};a.actionBudget=120;
  await a.executeAction({tool:'delegate',targetKind:'agent',targetId:id,task:'Review'},route,[],0);
  assert.deepEqual(g.routeCapabilities,['read']);
  assert.deepEqual(a.state.routeCapabilities,['read']);
  await assert.rejects(g.authorize({capability:'write',target:'unreachable'}),/disabled/);
  await assert.rejects(g.authorize({capability:'execute',target:'node app.js'}),/disabled/);
});

test('undeclared delegates fail before child provider request',async()=>{
  let calls=0;const g=gateway();
  const a=new AgentOrchestrator({model:{chat:async()=>{calls++;return '{}';}},tools:{execute:async()=>{}},gateway:g,skills:{list:async()=>[]},persist:()=>{},emit:()=>{}},createAgentState('review',null));
  a.catalog={revision:1,agents:[child],skills:[]};a.actionBudget=120;
  await assert.rejects(a.executeAction({tool:'delegate',targetKind:'agent',targetId:id,task:'Review'},{...route,allowedAgentIds:[]},[],0),/not declared/);
  assert.equal(calls,0);
});

test('Stop during route preparation prevents later provider execution',async()=>{
  const f=runtime(),pending=deferred();f.r.registry={list:()=>pending.promise};
  const running=f.r.run('review','Review this',[]);
  const rejected=assert.rejects(running,/cancel|stop/i);
  f.r.stop('review');pending.resolve({revision:0,agents:[],skills:[]});
  await rejected;assert.equal(f.calls(),0);
});

test('Stop during GitHub preparation prevents confirmation and installation',async()=>{
  const f=runtime(),pending=deferred();let writes=0,confirmations=0;
  f.r.registry={prepareGithub:()=>pending.promise,installPrepared:async()=>{writes++;return {revision:1,agents:[],skills:[]};}};
  f.r.setImportConfirmation(async()=>{confirmations++;return true;});
  const importing=f.r.importGithub('https://github.com/example/skill');
  const rejected=assert.rejects(importing,/cancel|stop/i);
  f.r.stop('review');pending.resolve({summary:{name:'Skill',sourceUrl:'https://github.com/example/skill',commit:'b'.repeat(40),destinationName:id,fileCount:1,totalBytes:20}});
  await rejected;assert.equal(confirmations,0);assert.equal(writes,0);
});

test('Stop while native import confirmation is pending prevents installation',async()=>{
  const f=runtime(),confirmation=deferred(),entered=deferred();let writes=0;
  f.r.registry={prepareGithub:async()=>({summary:{name:'Skill',sourceUrl:'https://github.com/example/skill',commit:'b'.repeat(40),destinationName:id,fileCount:1,totalBytes:20}}),installPrepared:async()=>{writes++;return {revision:1,agents:[],skills:[]};}};
  f.r.setImportConfirmation(()=>{entered.resolve();return confirmation.promise;});
  const importing=f.r.importGithub('https://github.com/example/skill');
  const rejected=assert.rejects(importing,/cancel|stop/i);
  await entered.promise;f.r.stop('review');confirmation.resolve(true);
  await rejected;assert.equal(writes,0);
});

test('shared delegation budget and runtime cycle checks stop before child requests',async()=>{
  let calls=0;const g=gateway();
  const a=new AgentOrchestrator({model:{chat:async()=>{calls++;return '{}';}},tools:{execute:async()=>{}},gateway:g,skills:{list:async()=>[]},persist:()=>{},emit:()=>{}},createAgentState('review',null));
  a.catalog={revision:1,agents:[child],skills:[]};a.actionBudget=0;
  const action={tool:'delegate',targetKind:'agent',targetId:id,task:'Review'};
  await assert.rejects(a.executeAction(action,route,[],0),/120-action/);
  a.actionBudget=120;
  await assert.rejects(a.executeAction(action,route,[`agent:${id}`],1),/Cyclic/);
  await assert.rejects(a.executeAction(action,route,[],3),/three-level/);
  assert.equal(calls,0);
});

test('stopping parent prevents delegated actions returned after cancellation',async()=>{
  const pending=deferred();let tools=0;const g=gateway();
  const a=new AgentOrchestrator({model:{chat:()=>pending.promise,abort:()=>{}},tools:{execute:async()=>{tools++;}},gateway:g,skills:{list:async()=>[]},persist:()=>{},emit:()=>{}},createAgentState('review',null));
  a.catalog={revision:1,agents:[child],skills:[]};a.actionBudget=120;a.controller=new AbortController();
  const call=a.executeAction({tool:'delegate',targetKind:'agent',targetId:id,task:'Review'},route,[],0);
  const rejected=assert.rejects(call,/stopped|cancel/i);
  a.stop();pending.resolve('{"message":"Late response","actions":[{"tool":"read","path":"package.json"}],"done":true}');
  await rejected;assert.equal(tools,0);
});

test('delegated prompt injects selected child instructions without parent specialization',async()=>{
  let prompt='';const g=gateway();
  const a=new AgentOrchestrator({model:{chat:async messages=>{prompt=messages[0].content;return '{"message":"Reviewed","actions":[],"done":true}';}},tools:{execute:async()=>{}},gateway:g,skills:{list:async()=>[]},persist:()=>{},emit:()=>{}},createAgentState('review',null));
  a.catalog={revision:1,agents:[child],skills:[]};a.actionBudget=120;
  a.setRoute({...route,agent:{...child,id:'b'.repeat(24),instructions:'PARENT_PRIVATE_SPECIALIZATION'}},full);
  await a.executeAction({tool:'delegate',targetKind:'agent',targetId:id,task:'Review'},route,[],0);
  assert.match(prompt,/Inspect only/);assert.doesNotMatch(prompt,/PARENT_PRIVATE_SPECIALIZATION/);
});

test('editing retained agent to read-only prevents manual writes without another run',async()=>{
  const f=runtime();f.values.set('workspace.currentProject',process.cwd());let writes=0;
  f.r.files.writeFile=async()=>{writes++;};
  const entry=f.r.session('review');
  entry.agent.setMode('code');
  entry.gateway.setRouteCapabilities(full);
  entry.agent.setRoute({...route,agent:{...child,allowedCapabilities:full}},full);
  f.r.registry={list:async()=>({revision:2,agents:[{...child,revision:2}],skills:[]})};
  await assert.rejects(f.r.execute('review',{tool:'write',path:require('node:path').join(process.cwd(),'review-never-written.txt'),content:'blocked'}),/disabled|scope|changed|route/i);
  assert.equal(writes,0);
});

test('disabled retained agent prevents manual reads until explicit reset',async()=>{
  const f=runtime();f.values.set('workspace.currentProject',process.cwd());let reads=0;
  f.r.files.readFile=async()=>{reads++;return 'blocked';};
  const entry=f.r.session('review');entry.gateway.setRouteCapabilities(['read']);entry.agent.setRoute({...route,agent:child},['read']);
  f.r.registry={list:async()=>({revision:2,agents:[{...child,revision:2,enabled:false}],skills:[]})};
  await assert.rejects(f.r.execute('review',{tool:'read',path:require('node:path').join(process.cwd(),'package.json')}),/disabled|unavailable|reset/i);
  assert.equal(reads,0);
});
