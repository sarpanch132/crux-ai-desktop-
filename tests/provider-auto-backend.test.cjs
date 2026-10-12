const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const {createRequire}=require('node:module');
const {Readable}=require('node:stream');
const localRequire=createRequire(path.resolve('electron/dist/services/aiService.js'));
const loaded={exports:{}};
const secret='sk-auto-secret-do-not-return-923';
vm.runInNewContext(fs.readFileSync('electron/dist/services/aiService.js','utf8'),{exports:loaded.exports,require:name=>name==='electron'?{safeStorage:{isEncryptionAvailable:()=>true,encryptString:v=>Buffer.from(v),decryptString:v=>v.toString()}}:name==='electron-log'?{warn(){}}:localRequire(name),Buffer,process,setTimeout,clearTimeout,URL,AbortController});
function fixture(models=['gpt-current','gpt-cheap-mini','gpt-other']) { const values=new Map(); const service=new loaded.exports.AIService({get:k=>values.get(k),set:(k,v)=>values.set(k,v),delete:k=>values.delete(k)}); service.updateSettings({provider:'openai',model:'gpt-current',apiKey:secret}); service.httpClient.get=async()=>({status:200,data:{data:models.map(id=>({id}))}}); return {service,values}; }
const ok=()=>({status:200,headers:{},data:{choices:[{message:{content:'OK'},finish_reason:'stop'}]}});
test('Auto skips inaccessible selected model, saves only proven model and shares chat/stream configuration',async()=>{
 const {service}=fixture();const calls=[];service.httpClient.post=async(url,body,config)=>{calls.push({url,body,config}); if(body.model==='gpt-current')return{status:404,data:{error:{code:'model_not_found'}},headers:{}}; if(body.stream)return{status:200,headers:{'content-type':'text/event-stream'},data:Readable.from(['data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n'])};return ok();};
 const result=await service.findWorkingModel();assert.equal(result.success,true);assert.equal(result.attempts,2);assert.equal(result.model,'gpt-cheap-mini');assert.equal(service.getPublicSettings().autoModel,true);
 assert.equal(await service.chat([{role:'user',content:'actual'}]),'OK');assert.equal(await service.chatStreaming([{role:'user',content:'actual-stream'}],undefined,()=>{}),'OK'); assert.equal(calls.length,4);
 for(const call of calls){assert.equal(call.config.headers.Authorization,`Bearer ${secret}`);assert.equal(call.url,'https://api.openai.com/v1/chat/completions');assert.notEqual(call.body.model,'Auto');}
 assert(!JSON.stringify(result).includes(secret));
});
test('Auto stops quota immediately even if provider labels model parameter, preserving settings',async()=>{
 const {service}=fixture();let calls=0;service.httpClient.post=async()=>{calls++;return{status:429,headers:{},data:{error:{code:'project_spend_limit_exceeded',param:'model',message:secret}}};};
 const result=await service.findWorkingModel();assert.equal(result.success,false);assert.equal(result.category,'quota');assert.equal(calls,1);assert.equal(service.getSettings().model,'gpt-current');assert.equal(service.getSettings().autoModel,false);assert(!JSON.stringify(result).includes(secret));assert.match(result.message,/spending limit/);
});
test('Auto is bounded to four attempts and probes no candidates from an empty catalog',async()=>{
 const {service}=fixture(['gpt-current','gpt-a','gpt-b','gpt-c','gpt-d','gpt-e']);let calls=0;service.httpClient.post=async()=>{calls++;return{status:404,headers:{},data:{error:{code:'model_not_found'}}};}; assert.equal((await service.findWorkingModel()).attempts,4);assert.equal(calls,4);
 service.httpClient.get=async()=>({status:200,data:{data:[]}});assert.equal((await service.findWorkingModel()).attempts,0);assert.equal(calls,4);
});
test('model list is unverified until probe and cache is key/provider scoped',async()=>{
 const {service}=fixture();service.httpClient.post=async()=>ok();assert.equal((await service.getRawModels())[0].status,'unverified');assert.equal((await service.findWorkingModel()).success,true);assert.equal((await service.getRawModels())[0].healthy,true);
 service.updateSettings({apiKey:'other-key'});assert.equal((await service.getRawModels())[0].healthy,false);assert.equal((await service.getRawModels())[0].status,'unverified');
});
test('duplicate diagnostics share requests and configuration changes cancel persistence',async()=>{
 const {service}=fixture();let calls=0;let release;service.httpClient.post=async()=>{calls++;return new Promise(resolve=>release=()=>resolve(ok()));};const first=service.findWorkingModel();const second=service.findWorkingModel();while(!release)await new Promise(resolve=>setTimeout(resolve,1));service.updateSettings({model:'different'});release();const [a,b]=await Promise.all([first,second]);assert.equal(a.success,false);assert.equal(a.category,'configuration_changed');assert.equal(b.success,false);assert.equal(calls,1);assert.equal(service.getSettings().model,'different');
});
test('failed actual chat invalidates Auto success and never retries the user prompt',async()=>{
 const {service}=fixture();service.httpClient.post=async()=>ok();await service.findWorkingModel();let calls=0;service.httpClient.post=async()=>{calls++;return{status:429,headers:{},data:{error:{code:'insufficient_quota'}}};};await assert.rejects(service.chat([{role:'user',content:'do not repeat this'}]),/quota/);assert.equal(calls,1);assert.equal((await service.getRawModels())[0].healthy,false);
});
test('stop while probing and busy apply guard preserve chosen model',async()=>{
 const {service}=fixture();let release;service.httpClient.post=async()=>new Promise(resolve=>release=()=>resolve(ok()));const pending=service.findWorkingModel();while(!release)await new Promise(resolve=>setTimeout(resolve,1));service.abortStream();release();assert.equal((await pending).success,false);assert.equal(service.getSettings().autoModel,false);
 service.httpClient.post=async()=>ok();const busy=await service.findWorkingModel(()=>false);assert.equal(busy.category,'configuration_changed');assert.equal(service.getSettings().autoModel,false);
});
test('cached Auto selection does not refresh verification expiry or last-test timestamp',async()=>{
 const {service}=fixture();let calls=0;service.httpClient.post=async()=>{calls++;return ok();};await service.findWorkingModel();
 const prior=service.getConnectionTest();const record=[...service.verifiedModels.values()][0];const expiresAt=record.expiresAt,testedAt=record.testedAt;
 await new Promise(resolve=>setTimeout(resolve,5));const cached=await service.findWorkingModel();assert.equal(cached.cached,true);assert.equal(calls,1);assert.equal(record.expiresAt,expiresAt);assert.equal(record.testedAt,testedAt);assert.equal(service.getConnectionTest().testedAt,prior.testedAt);
 record.expiresAt=Date.now()-1;await service.findWorkingModel();assert.equal(calls,2);
});

test('cached Auto publishes saved verification as the current OpenAI connection result',async()=>{
 const {service}=fixture();service.updateSettings({model:'gpt-cheap-mini'});const settings=service.getSettings();service.rememberVerified(settings,10*60_000,17);let probes=0;service.httpClient.post=async()=>{probes++;return ok();};
 const result=await service.findWorkingModel();const connection=service.getConnectionTest();assert.equal(result.success,true);assert.equal(result.cached,true);assert.equal(probes,0);assert.equal(connection?.success,true);assert.equal(connection?.model,'gpt-cheap-mini');assert.equal(connection?.latencyMs,17);assert.equal(Date.parse(connection?.testedAt||''),service.verifiedModels.get(service.verificationKey(service.getSettings())).testedAt);
});
