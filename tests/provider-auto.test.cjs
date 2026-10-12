const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const {createRequire}=require('node:module');
const {Readable}=require('node:stream');
const localRequire=createRequire(path.resolve('electron/dist/services/aiService.js'));
const secret='sk-QA-AUTO-SECRET-193728';
const logs=[];
const moduleResult={exports:{}};
const safeStorage={isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(`encrypted:${value}`),decryptString:value=>value.toString().replace(/^encrypted:/,'')};
vm.runInNewContext(fs.readFileSync('electron/dist/services/aiService.js','utf8'),{exports:moduleResult.exports,require:name=>name==='electron'?{safeStorage}:name==='electron-log'?{warn:(...args)=>logs.push(args),info:(...args)=>logs.push(args),error:(...args)=>logs.push(args)}:localRequire(name),Buffer,process,setTimeout,clearTimeout,URL,AbortController});
const {AIService}=moduleResult.exports;
function fixture(ids=['gpt-4.1-mini','gpt-4.1-nano']){
  const values=new Map();const service=new AIService({get:key=>values.get(key),set:(key,value)=>values.set(key,value),delete:key=>values.delete(key)});
  service.updateSettings({provider:'openai',model:ids[0]||'gpt-unlisted',apiKey:secret});
  service.httpClient.get=async()=>({status:200,data:{data:ids.map(id=>({id}))}});
  return{service,values};
}
const completed=()=>({status:200,headers:{'x-request-id':'req_auto_fixture'},data:{choices:[{message:{content:'OK'},finish_reason:'stop'}]}});
const failure=(status,code)=>({status,headers:{'x-request-id':`req_${secret}`},data:{error:{code,type:code,message:`Authorization Bearer ${secret}`}}});
function safe(value){assert(!JSON.stringify(value).includes(secret));assert(!JSON.stringify(value).includes('Authorization'));}

test('Auto stops immediately on account quota and leaves configured model intact',async()=>{
  const{service}=fixture();let attempts=0;service.httpClient.post=async()=>{attempts++;return failure(429,'insufficient_quota');};const result=await service.findWorkingModel();assert.equal(result.success,false);assert.equal(result.category,'quota');assert.equal(attempts,1);assert.equal(service.getSettings().model,'gpt-4.1-mini');safe(result);safe(logs);safe(service.getPublicSettings());
});
test('Auto skips inaccessible models and saves only a catalog model proven through chat',async()=>{
  const{service}=fixture();const calls=[];service.httpClient.post=async(url,body,config)=>{calls.push({url,body,config});return body.model==='gpt-4.1-mini'?failure(404,'model_not_found'):completed();};const result=await service.findWorkingModel();assert.equal(result.success,true);assert.equal(result.model,'gpt-4.1-nano');assert.equal(service.getSettings().model,'gpt-4.1-nano');assert.equal(calls.length,2);for(const call of calls){assert.equal(call.config.headers.Authorization,`Bearer ${secret}`);assert.equal(call.url,'https://api.openai.com/v1/chat/completions');assert(call.body.max_completion_tokens<=64);assert(call.config.timeout<=15000);}safe(result);
});
test('Auto never fabricates models when catalog is empty',async()=>{
  const{service}=fixture([]);let calls=0;service.httpClient.post=async()=>{calls++;return completed();};const result=await service.findWorkingModel();assert.equal(result.success,false);assert.equal(calls,0);assert.equal(service.getSettings().model,'gpt-unlisted');safe(result);
});
test('a settings change during Auto preserves the newer manual selection',async()=>{
  const{service}=fixture();let entered;const started=new Promise(resolve=>entered=resolve);let finish;service.httpClient.post=async()=>{entered();return await new Promise(resolve=>finish=resolve);};const pending=service.findWorkingModel();await started;service.updateSettings({model:'gpt-4.1-nano',autoModel:false});finish(completed());const result=await pending;assert.equal(result.success,false);assert.equal(result.category,'configuration_changed');assert.equal(service.getSettings().model,'gpt-4.1-nano');safe(result);
});
test('Auto bounds probing and leaves exhausted candidates unverified',async()=>{
  const{service}=fixture(Array.from({length:8},(_,index)=>`gpt-4.1-mini-${index}`));let calls=0;service.httpClient.post=async()=>{calls++;return failure(404,'model_not_found');};const result=await service.findWorkingModel();assert.equal(result.success,false);assert(calls<=4);assert(calls>0);safe(result);
});
test('rate limiting is distinct from quota and does not trigger model fallback',async()=>{
  const{service}=fixture();let calls=0;service.httpClient.post=async()=>{calls++;return failure(429,'rate_limit_exceeded');};const result=await service.findWorkingModel();assert.equal(result.category,'rate_limit');assert.equal(calls,1);safe(result);
});
test('authentication failure stops after one request',async()=>{
  const{service}=fixture();let calls=0;service.httpClient.post=async()=>{calls++;return failure(401,'invalid_api_key');};const result=await service.findWorkingModel();assert.equal(result.success,false);assert.equal(calls,1);assert.equal(result.category,'authentication');assert.equal(service.getSettings().model,'gpt-4.1-mini');safe(result);
});
test('network and timeout failures stop probing and return sanitized diagnostics',async()=>{
  for(const [code,category] of [['ERR_NETWORK','network'],['ECONNABORTED','timeout']]){const{service}=fixture();let calls=0;service.httpClient.post=async()=>{calls++;throw Object.assign(new Error(secret),{isAxiosError:true,code});};const result=await service.findWorkingModel();assert.equal(result.success,false);assert.equal(result.category,category);assert.equal(calls,1);safe(result);}
});
test('inconclusive tiny reasoning output permits a bounded next candidate without verifying the first',async()=>{
  const{service}=fixture();let calls=0;service.httpClient.post=async()=>++calls===1?{status:200,headers:{},data:{choices:[{message:{content:''},finish_reason:'length'}]}}:completed();const result=await service.findWorkingModel();assert.equal(result.success,true);assert.equal(calls,2);assert.equal(result.model,'gpt-4.1-nano');const first=(await service.getRawModels()).find(model=>model.id==='gpt-4.1-mini');assert.equal(first.status,'unverified');safe(result);
});
test('manual chat and streaming keep exact saved model and never send an Auto sentinel',async()=>{
  const{service}=fixture();service.updateSettings({autoModel:false,model:'gpt-4.1-nano'});const calls=[];service.httpClient.post=async(url,body,config)=>{calls.push({url,body,config});return body.stream?{status:200,headers:{'content-type':'text/event-stream'},data:Readable.from(['data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n'])}:completed();};assert.equal(await service.chat([{role:'user',content:'Hi'}]),'OK');assert.equal(await service.chatStreaming([{role:'user',content:'Hi'}],undefined,()=>{}),'OK');assert.equal(calls.length,2);for(const call of calls){assert.equal(call.body.model,'gpt-4.1-nano');assert.equal(call.config.headers.Authorization,`Bearer ${secret}`);assert.equal(call.url,'https://api.openai.com/v1/chat/completions');}
});
test('rejected Auto sentinel settings leave the prior actual model unchanged',async()=>{
  const{service}=fixture();for(const model of ['auto','__auto__']){assert.throws(()=>service.updateSettings({model}),/Auto|selection mode|actual.*model/i);assert.equal(service.getSettings().model,'gpt-4.1-mini');}service.httpClient.post=async(url,body)=>{assert.equal(body.model,'gpt-4.1-mini');return completed();};assert.equal(await service.chat([{role:'user',content:'Hi'}]),'OK');
});
test('catalog availability alone does not claim a model was verified',async()=>{
  const{service}=fixture();const models=await service.getRawModels();assert(models.length);for(const model of models){assert.equal(model.healthy,false);assert.equal(model.status,'unverified');}safe(models);
});
test('cached Auto selection does not refresh verification expiry or last real test time',async()=>{
  const{service}=fixture();let calls=0;service.httpClient.post=async()=>{calls++;return completed();};const initial=await service.findWorkingModel();assert.equal(initial.success,true);const key=service.verificationKey(service.getSettings());const baseline={...service.verifiedModels.get(key)};const diagnostic=service.getConnectionTest();await new Promise(resolve=>setTimeout(resolve,10));for(let attempt=0;attempt<3;attempt++){const cached=await service.findWorkingModel();assert.equal(cached.success,true);assert.equal(cached.attempts,0);assert.equal(service.verifiedModels.get(key).expiresAt,baseline.expiresAt);assert.equal(service.verifiedModels.get(key).testedAt,baseline.testedAt);assert.equal(service.getConnectionTest().testedAt,diagnostic.testedAt);}assert.equal(calls,1);service.verifiedModels.get(key).expiresAt=Date.now()-1;await service.findWorkingModel();assert.equal(calls,2);
});
test('hostile model metadata cannot reflect the saved credential to the renderer',async()=>{
  const{service}=fixture();service.httpClient.get=async()=>({status:200,data:{data:[{id:`gpt-${secret}`,name:secret},{id:'gpt-4.1-nano',name:`Model ${secret}`}]}});safe(await service.getRawModels());service.httpClient.post=async()=>completed();safe(await service.findWorkingModel());safe(service.getPublicSettings());
});
test('explicit capability metadata requires text input and text output',async()=>{
  const{service}=fixture();service.updateSettings({provider:'openrouter',apiKey:secret});service.httpClient.get=async()=>({status:200,data:{data:[{id:'vendor/image-reader',architecture:{input_modalities:['image'],output_modalities:['text']}},{id:'vendor/image-maker',architecture:{input_modalities:['text'],output_modalities:['image']}},{id:'vendor/chat',architecture:{input_modalities:['text','image'],output_modalities:['text']}}]}});assert.deepEqual(Array.from(await service.getRawModels(),model=>model.id),['vendor/chat']);
});
