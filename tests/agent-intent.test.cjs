const {test}=require('node:test');
const assert=require('node:assert/strict');
const {AgentRuntime,githubInstallIntent}=require('../electron/dist/services/agent/runtime.js');
const {resolveInput}=require('../electron/dist/services/agent/inputRouter.js');
const agent={id:'a'.repeat(24),revision:1,name:'Reviewer',handle:'reviewer',enabled:true,instructions:'private workflow',description:'Review code for bugs',keywords:['review code'],icon:'shield',createdAt:1,updatedAt:1,allowedCapabilities:['read'],skillIds:[],callableAgentIds:[],callableSkillIds:[]};
const catalog={revision:1,agents:[agent],skills:[]};
function fixture(reply){const values=new Map();const calls=[];const ai={chat:async(messages,options)=>{calls.push({messages,options});if(reply instanceof Error)throw reply;return JSON.stringify(reply);}};const runtime=new AgentRuntime({get:k=>values.get(k),set:(k,v)=>values.set(k,v)},ai,{}, {},process.cwd(),()=>{});return{runtime,calls};}
test('AI intent is opt-in and deterministic keyword previews make no model request',async()=>{
  const f=fixture({agentId:agent.id,skillIds:[],match:'strong'});
  const route=resolveInput('Examine potential defects',catalog);
  assert.equal((await f.runtime.semanticRoute(route,catalog,new AbortController().signal)).source,'default');
  f.runtime.setSemanticRouting(true);
  assert.equal((await f.runtime.semanticRoute(resolveInput('review code',catalog),catalog,new AbortController().signal)).source,'keyword');
  assert.equal(f.calls.length,0);
});
test('opt-in classifier uses only bounded task metadata and resolves a registered ID',async()=>{
  const f=fixture({agentId:agent.id,skillIds:[],match:'strong'});f.runtime.setSemanticRouting(true);
  const result=await f.runtime.semanticRoute(resolveInput('Find defects ```private-code``` '+ 'task '.repeat(1000),catalog),catalog,new AbortController().signal);
  assert.equal(result.source,'semantic');assert.equal(result.agent.id,agent.id);assert.match(result.reason,/not a calibrated/);
  const sent=JSON.parse(f.calls[0].messages[1].content);
  assert(sent.task.length<=2000);assert(!sent.task.includes('private-code'));assert(!JSON.stringify(sent).includes('private workflow'));
  assert.equal(f.calls[0].options.maxTokens,400);
});
test('invalid, uncertain and failed intent classifications fall back without invented routes',async()=>{
  for(const reply of [{agentId:'missing',skillIds:[],match:'strong'},{agentId:agent.id,skillIds:['missing'],match:'strong'},{agentId:agent.id,skillIds:[],match:'none'},new Error('network')]){
    const f=fixture(reply);f.runtime.setSemanticRouting(true);
    assert.equal((await f.runtime.semanticRoute(resolveInput('Find defects',catalog),catalog,new AbortController().signal)).source,'default');
  }
});
test('canceled classifier cannot start later execution',async()=>{
  const controller=new AbortController();const f=fixture({agentId:agent.id,skillIds:[],match:'strong'});f.runtime.setSemanticRouting(true);controller.abort();
  await assert.rejects(f.runtime.semanticRoute(resolveInput('Find defects',catalog),catalog,controller.signal),/canceled/);
});
test('only a direct human install request with one GitHub skill link routes to installation',()=>{
  const url='https://github.com/owner/repo/tree/main/a';
  assert.equal(githubInstallIntent('Please install this skill '+url),url);
  for(const text of ['Review code mentioning install skill '+url,'Explain this skill '+url,'```Install this skill '+url+'```'])assert.equal(githubInstallIntent(text),null);
  assert.throws(()=>githubInstallIntent('Install skill '+url+' '+url),/one GitHub/);
});
