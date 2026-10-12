const {test}=require('node:test');
const assert=require('node:assert/strict');
const {AgentOrchestrator,createAgentState,parseModelReply}=require('../electron/dist/services/agent/orchestrator.js');
const {PermissionGateway}=require('../electron/dist/services/agent/permissionGateway.js');
const plan={summary:'Inspect',architecture:'Existing project',tasks:['Inspect'],risks:[],acceptanceCriteria:['Read complete'],checks:[]};
const final=JSON.stringify({message:'Plan prepared',plan});
function harness(replies,{deny=false}={}){
  let requests=0;const actions=[];const gateway=new PermissionGateway('structured',null,'plan',()=>{},()=>{});
  const agent=new AgentOrchestrator({gateway,model:{chat:async()=>{const reply=replies[requests++];if(reply instanceof Error)throw reply;return reply??final;}},tools:{execute:async request=>{actions.push(request);if(deny)throw new Error('Permission denied');return 'read result';}},persist:()=>{},emit:()=>{}},createAgentState('structured',null));
  return {agent,actions,get requests(){return requests;}};
}
test('canonical tool calls and aliases normalize without losing legacy envelope metadata',()=>{
  const reply=parseModelReply(JSON.stringify({message:'Inspect',requirements:['Read'],actions:[{type:'tool_call',name:'file_read',arguments:{path:'src/app.ts'}}]}));
  assert.equal(reply.actions[0].tool,'read');assert.equal(reply.actions[0].path,'src/app.ts');assert.deepEqual(reply.requirements,['Read']);
  assert.equal(parseModelReply(JSON.stringify({type:'tool_call',name:'read',arguments:{path:'a.ts'}})).actions[0].tool,'read');
  assert.equal(parseModelReply(JSON.stringify({message:'Legacy',actions:[{tool:'read',path:'a.ts'}]})).actions[0].path,'a.ts');
  const metadata=parseModelReply(JSON.stringify({message:'Preserved',plan,requirements:['A'],acceptanceCriteria:['B'],done:false,actions:[{type:'tool_call',name:'git_status',arguments:{args:['--short']}},{type:'tool_call',name:'file_create',arguments:{path:'new.ts',content:'ok'}},{type:'tool_call',name:'lint_run',arguments:{}}]}));assert.deepEqual(metadata.plan,plan);assert.equal(metadata.done,false);assert.deepEqual(metadata.acceptanceCriteria,['B']);assert.deepEqual(metadata.actions[0].args,['status','--short']);assert.equal(metadata.actions[1].createOnly,true);assert.equal(metadata.actions[2].checkKind,'lint');
});
test('prose, unknown tools, malformed arguments and argument name overrides cannot become actions',()=>{
  for(const value of ['Please run npm install',{type:'tool_call',name:'not_registered',arguments:{}},{type:'tool_call',name:'read',arguments:'{"path":"a.ts"}'},{type:'tool_call',name:'read',arguments:[]},{type:'tool_call',name:'read',arguments:{tool:'command',command:'npm install'}},{message:'Bad',actions:[{type:'tool_call',name:'read',arguments:{path:22}}]}])assert.throws(()=>parseModelReply(typeof value==='string'?value:JSON.stringify(value)));
});
test('prototype property names are never registered tool aliases',()=>{
  for(const name of ['__proto__','constructor','toString','hasOwnProperty'])assert.throws(()=>parseModelReply(JSON.stringify({type:'tool_call',name,arguments:{path:'a.ts'}})),/Unknown tool/);
});
test('typed native normalization failures use the same bounded repair budget',async()=>{
  const {StructuredResponseError}=require('../electron/dist/services/agent/providerActions.js');
  const once=harness([new StructuredResponseError('Malformed native arguments'),final]);await once.agent.run('Inspect');assert.equal(once.requests,2);assert.deepEqual(once.actions,[]);
  const failed=harness(Array.from({length:3},()=>new StructuredResponseError('Malformed native arguments')));await assert.rejects(failed.agent.run('Inspect'),/3 structured-output attempts/);assert.equal(failed.requests,3);assert.deepEqual(failed.actions,[]);
});
test('a malformed action batch is rejected before any valid prefix executes',async()=>{
  const invalid=JSON.stringify({message:'Inspect',actions:[{tool:'read',path:'a.ts'},{type:'tool_call',name:'unregistered',arguments:{}}]});const h=harness([invalid,invalid,invalid]);await assert.rejects(h.agent.run('Inspect'));assert.equal(h.requests,3);assert.deepEqual(h.actions,[]);
});
test('one malformed reply repairs once and then executes validated canonical read',async()=>{
  const h=harness(['not JSON',JSON.stringify({message:'Inspect',actions:[{type:'tool_call',name:'file_read',arguments:{path:'a.ts'}}]}),final]);await h.agent.run('Inspect');assert.equal(h.requests,3);assert.equal(h.actions.length,1);assert.equal(h.actions[0].tool,'read');
});
test('three malformed replies exhaust the repair budget with zero tool execution',async()=>{
  const h=harness(['bad','bad','bad',final]);await assert.rejects(h.agent.run('Inspect'));assert.equal(h.requests,3);assert.deepEqual(h.actions,[]);assert.equal(h.agent.state.status,'blocked');
});
test('oversized canonical payloads and excessive action batches remain bounded',()=>{
  assert.throws(()=>parseModelReply(JSON.stringify({message:'Oversize',actions:[{type:'tool_call',name:'write',arguments:{path:'a.ts',content:'a'.repeat(1024*1024+1)}}]})));
  assert.throws(()=>parseModelReply(JSON.stringify({message:'Too many',actions:Array.from({length:11},()=>({type:'tool_call',name:'read',arguments:{path:'a.ts'}}))})));
});
test('empty-file edit search remains valid while the tool layer enforces empty-file CAS',()=>{
  const edit={path:'empty.ts',search:'',replacement:'first line',expectedHash:'a'.repeat(64)};
  assert.equal(parseModelReply(JSON.stringify({message:'Edit empty file',actions:[{type:'tool_call',name:'edit',arguments:edit}]})).actions[0].search,'');
  assert.equal(parseModelReply(JSON.stringify({message:'Patch empty file',actions:[{type:'tool_call',name:'patch',arguments:{edits:[edit]}}]})).actions[0].edits[0].search,'');
});
test('provider errors are never retried as structured output repairs',async()=>{
  const h=harness([new Error('Network unavailable'),final]);await assert.rejects(h.agent.run('Inspect'),/Network unavailable/);assert.equal(h.requests,1);assert.deepEqual(h.actions,[]);
  const aborted=new Error('Request aborted');aborted.name='AbortError';const a=harness([aborted,final]);await assert.rejects(a.agent.run('Inspect'),/aborted/);assert.equal(a.requests,1);assert.deepEqual(a.actions,[]);
});
test('a permission failure does not consume parser repair retries',async()=>{
  const h=harness([JSON.stringify({message:'Inspect',actions:[{type:'tool_call',name:'read',arguments:{path:'a.ts'}}]}),final],{deny:true});await h.agent.run('Inspect');assert.equal(h.requests,2);assert.equal(h.actions.length,1);
});
