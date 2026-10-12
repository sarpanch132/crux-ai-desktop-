const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const {createRequire}=require('node:module');
const {Readable}=require('node:stream');
const secret='sk-VERIFICATION-QA-SECRET-97102';
function fixture(ids=Array.from({length:7},(_,i)=>`gpt-qa-${i}`),provider='openai'){
  const clock={now:Date.now()};class ClockDate extends Date{constructor(...args){super(...(args.length?args:[clock.now]));}static now(){return clock.now;}}
  const localRequire=createRequire(path.resolve('electron/dist/services/aiService.js'));const moduleResult={exports:{}};const logs=[];
  const safeStorage={isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(`encrypted:${value}`),decryptString:value=>value.toString().replace(/^encrypted:/,'')};
  vm.runInNewContext(fs.readFileSync('electron/dist/services/aiService.js','utf8'),{exports:moduleResult.exports,require:name=>name==='electron'?{safeStorage}:name==='electron-log'?{info:(...args)=>logs.push(args),warn:(...args)=>logs.push(args),error:(...args)=>logs.push(args)}:localRequire(name),Buffer,process,setTimeout,clearTimeout,URL,AbortController,Date:ClockDate});
  const values=new Map();const service=new moduleResult.exports.AIService({get:key=>values.get(key),set:(key,value)=>values.set(key,value),delete:key=>values.delete(key)});const calls=[];
  service.httpClient.get=async()=>({status:200,data:{data:ids.map(id=>({id}))}});
  service.httpClient.post=async(url,body,config)=>{calls.push({url,body,config});return completed();};
  service.updateSettings({provider,model:ids[0]||'',apiKey:secret});
  return{service,calls,clock,logs,values};
}
function completed(){return{status:200,headers:{},data:{choices:[{message:{content:'OK'},finish_reason:'stop'}]}};}
function failed(status,code,headers={}){return{status,headers,data:{error:{code,type:code,message:secret}}};}
async function until(service,predicate){for(let i=0;i<1600;i++){const status=service.getModelVerification();if(predicate(status))return status;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error(`Verification did not settle: ${JSON.stringify(service.getModelVerification())}`);}
const settled=service=>until(service,status=>['completed','paused','error','canceled'].includes(status.state));
function safe(value){assert(!JSON.stringify(value).includes(secret));assert(!JSON.stringify(value).includes('Authorization'));}

test('one exhaustive scan tests more than four candidates and exposes only real passes',async()=>{
  const{service,calls,logs}=fixture();let active=0,maxActive=0;service.httpClient.post=async(url,body,config)=>{active++;maxActive=Math.max(maxActive,active);calls.push({url,body,config});await new Promise(resolve=>setTimeout(resolve,4));active--;return body.model==='gpt-qa-1'?failed(404,'model_not_found'):completed();};assert.deepEqual(Array.from(await service.getModels()),[]);const status=await settled(service);assert.equal(status.state,'completed');assert.equal(calls.length,7);assert.equal(maxActive,1);assert.equal(status.passed,6);assert.equal(status.failed,1);assert.equal(status.untested,0);const models=await service.getModels();assert.equal(models.length,6);assert(!models.some(model=>model.id==='gpt-qa-1'));assert(models.every(model=>model.status==='ready'&&model.healthy));for(const call of calls){assert(call.body.max_completion_tokens<=128);assert(call.config.timeout<=15000);}safe(models);safe(status);safe(logs);
});
test('polling and cache expiry never silently repeat the billable catalog pass',async()=>{
  const{service,calls,clock}=fixture(['gpt-qa-1','gpt-qa-2']);await service.getModels();await settled(service);const count=calls.length;for(let i=0;i<6;i++)await service.getModels();assert.equal(calls.length,count);clock.now+=25*60*60_000;assert.equal((await service.getModels()).length,0);await new Promise(resolve=>setTimeout(resolve,30));assert.equal(calls.length,count);safe(service.getModelVerification());
});
test('large provider catalogs retain every fresh pass rather than the former Auto cache limit',async()=>{
  const{service,calls}=fixture(Array.from({length:130},(_,i)=>`gpt-large-${i}`));await service.getModels();const status=await settled(service);assert.equal(status.passed,130);assert.equal(calls.length,130);assert.equal((await service.getModels()).length,130);
});
test('restart restores finite completed scan without rebilling and expired passes require explicit retest',async()=>{
  const{service,clock,values}=fixture(['gpt-qa-1','gpt-qa-2']);await service.getModels();await settled(service);const restored=new service.constructor({get:key=>values.get(key),set:(key,value)=>values.set(key,value),delete:key=>values.delete(key)});let requests=0;restored.httpClient.get=async()=>({status:200,data:{data:[{id:'gpt-qa-1'},{id:'gpt-qa-2'}]}});restored.httpClient.post=async()=>{requests++;return completed();};assert.equal((await restored.getModels()).length,2);assert.equal(requests,0);clock.now+=25*60*60_000;assert.equal((await restored.getModels()).length,0);await new Promise(resolve=>setTimeout(resolve,30));assert.equal(requests,0);restored.startModelVerification(true);await settled(restored);assert.equal(requests,2);assert.equal((await restored.getModels()).length,2);
});
test('manual selected-model change preserves the same scan scope and remaining candidates',async()=>{
  const{service,calls}=fixture();let release;let entered;const firstStarted=new Promise(resolve=>entered=resolve);service.httpClient.post=async(url,body,config)=>{calls.push({url,body,config});if(calls.length===1){entered();await new Promise(resolve=>release=resolve);}return completed();};await service.getModels();await firstStarted;service.updateSettings({model:'gpt-qa-6',autoModel:false});release();const status=await settled(service);assert.equal(status.state,'completed');assert.equal(calls.length,7);assert.equal(service.getSettings().model,'gpt-qa-6');
});
test('cancel aborts remaining probes and a late success never becomes visible',async()=>{
  const{service,calls}=fixture();let release;let entered;const started=new Promise(resolve=>entered=resolve);service.httpClient.post=async(url,body,config)=>{calls.push({url,body,config});entered();await new Promise(resolve=>release=resolve);return completed();};await service.getModels();await started;service.cancelModelVerification();release();await new Promise(resolve=>setTimeout(resolve,30));assert.equal(service.getModelVerification().state,'canceled');assert.equal(calls.length,1);assert.equal((await service.getModels()).length,0);assert.equal(calls.length,1);
});
test('credential changes cannot publish stale verified models from an old in-flight request',async()=>{
  const{service}=fixture(['gpt-old']);let release;let entered;const started=new Promise(resolve=>entered=resolve);service.httpClient.post=async()=>{entered();await new Promise(resolve=>release=resolve);return completed();};await service.getModels();await started;service.httpClient.get=async()=>({status:200,data:{data:[{id:'gpt-new'}]}});service.httpClient.post=async()=>failed(401,'invalid_api_key');service.updateSettings({apiKey:`${secret}-new`});release();await service.getModels();await settled(service);assert.equal((await service.getModels()).length,0);safe(service.getModelVerification());
});
test('429 pauses without disabling candidates and resume honors Retry-After',async()=>{
  const{service,calls,clock}=fixture(['gpt-qa-1','gpt-qa-2']);service.httpClient.post=async(url,body,config)=>{calls.push({url,body,config});return calls.length===1?failed(429,'rate_limit_exceeded',{'retry-after':'3'}):completed();};await service.getModels();const paused=await until(service,status=>status.state==='paused');assert.equal(calls.length,1);assert(paused.untested>0);assert.equal(paused.failed,0);assert(paused.retryAt>=clock.now+3000);service.resumeModelVerification();await new Promise(resolve=>setTimeout(resolve,20));assert.equal(calls.length,1);clock.now=paused.retryAt+1;service.resumeModelVerification();assert.equal((await settled(service)).state,'completed');assert.equal(calls.length,3);assert.equal((await service.getModels()).length,2);
});
test('incomplete or empty responses stay hidden rather than masquerading as passes',async()=>{
  const{service}=fixture(['gpt-empty','gpt-length','gpt-good']);service.httpClient.post=async(url,body)=>body.model==='gpt-good'?completed():{status:200,headers:{},data:{choices:[{message:{content:body.model==='gpt-empty'?'':'partial'},finish_reason:body.model==='gpt-empty'?'stop':'length'}]}};await service.getModels();await settled(service);assert.deepEqual(Array.from(await service.getModels(),model=>model.id),['gpt-good']);
});
test('authentication and account quota stop the scan with remaining models untested',async()=>{
  for(const [status,code] of [[401,'invalid_api_key'],[429,'insufficient_quota']]){const{service,calls}=fixture();service.httpClient.post=async(url,body,config)=>{calls.push({url,body,config});return failed(status,code);};await service.getModels();const result=await settled(service);assert.equal(calls.length,1);assert(result.untested>=6);assert.equal((await service.getModels()).length,0);safe(result);}
});
test('OpenRouter verifies documented free router without inventing free model aliases',async()=>{
  const{service,calls}=fixture(['vendor/paid','vendor/actual:free'],'openrouter');service.httpClient.post=async(url,body,config)=>{calls.push({url,body,config});return body.model==='vendor/paid'?failed(402,'insufficient_credits'):completed();};await service.getModels();const status=await settled(service);assert.equal(status.state,'completed');const ids=Array.from(await service.getModels(),model=>model.id);assert(ids.includes('openrouter/free'));assert(ids.includes('vendor/actual:free'));assert(!ids.includes('vendor/paid'));assert(!ids.includes('vendor/paid:free'));assert(calls.slice(0,2).every(call=>call.body.model==='openrouter/free'||call.body.model==='vendor/actual:free'));safe(status);safe(ids);
});
test('verified selection uses the shared saved configuration in actual chat and stream',async()=>{
  const{service}=fixture(['gpt-good']);await service.getModels();await settled(service);service.updateSettings({model:'gpt-good'});const calls=[];service.httpClient.post=async(url,body,config)=>{calls.push({url,body,config});return body.stream?{status:200,headers:{'content-type':'text/event-stream'},data:Readable.from(['data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n'])}:completed();};assert.equal(await service.chat([{role:'user',content:'Hi'}]),'OK');assert.equal(await service.chatStreaming([{role:'user',content:'Hi'}],undefined,()=>{}),'OK');assert.equal(calls.length,2);for(const call of calls){assert.equal(call.body.model,'gpt-good');assert.equal(call.config.headers.Authorization,`Bearer ${secret}`);assert.equal(call.url,'https://api.openai.com/v1/chat/completions');}
});
