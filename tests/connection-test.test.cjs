const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const {createRequire}=require('node:module');
const {Readable}=require('node:stream');
const localRequire=createRequire(path.resolve('electron/dist/services/aiService.js'));
const secret='sk-TEST-SECRET-never-return-73910';
const logs=[];
const result={exports:{}};
const safeStorage={isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(`encrypted:${value}`),decryptString:value=>value.toString().replace(/^encrypted:/,'')};
vm.runInNewContext(fs.readFileSync('electron/dist/services/aiService.js','utf8'),{exports:result.exports,require:name=>name==='electron'?{safeStorage}:name==='electron-log'?{warn:(...args)=>logs.push(args),info:(...args)=>logs.push(args),error:(...args)=>logs.push(args)}:localRequire(name),Buffer,process,setTimeout,clearTimeout,URL,AbortController});
const {AIService}=result.exports;
function fixture(values=new Map()){
  const service=new AIService({get:key=>values.get(key),set:(key,value)=>values.set(key,value),delete:key=>values.delete(key)});
  if(!values.size)service.updateSettings({provider:'openai',model:'gpt-4.1-mini',apiKey:secret});
  return{service,values};
}
const completed=()=>({status:200,headers:{'x-request-id':'req_fixture'},data:{id:'chatcmpl_fixture',object:'chat.completion',choices:[{message:{role:'assistant',content:'OK'},finish_reason:'stop'}]}});
function safe(value){assert(!JSON.stringify(value).includes(secret),'Secret sentinel must not leave backend');assert(!JSON.stringify(value).includes('Authorization'),'Authorization must not leave backend');}

test('diagnostic and actual chat share saved model, key, endpoint and OpenAI payload',async()=>{
  const{service}=fixture();const calls=[];
  service.httpClient.post=async(url,body,config)=>{calls.push({url,body,config});return completed();};
  const diagnostic=await service.testConnection();assert.equal(diagnostic.success,true);assert.equal(diagnostic.provider,'openai');assert.equal(diagnostic.model,'gpt-4.1-mini');safe(diagnostic);
  assert.equal(await service.chat([{role:'user',content:'Hi'}]),'OK');
  assert.equal(calls.length,2);
  for(const call of calls){assert.equal(call.url,'https://api.openai.com/v1/chat/completions');assert.equal(call.body.model,'gpt-4.1-mini');assert.equal(call.config.headers.Authorization,`Bearer ${secret}`);assert.equal(call.body.max_tokens,undefined);assert.equal(typeof call.body.max_completion_tokens,'number');}
  assert(calls[0].body.max_completion_tokens<=64,'Diagnostic output budget stays small');assert(calls[0].config.timeout<=15000);safe(service.getConnectionTest());safe(service.getPublicSettings());safe(logs);
});

test('OpenAI streaming shares authentication and model-aware request builder',async()=>{
  const{service}=fixture();service.updateSettings({model:'o3-mini'});const calls=[];
  service.httpClient.post=async(url,body,config)=>{calls.push({url,body,config});return body.stream?{status:200,headers:{'content-type':'text/event-stream'},data:Readable.from(['data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n'])}:completed();};
  assert.equal((await service.testConnection()).success,true);assert.equal(await service.chatStreaming([{role:'user',content:'Hi'}],undefined,()=>{}),'OK');
  for(const call of calls){assert.equal(call.body.model,'o3-mini');assert.equal(call.body.temperature,undefined);assert.equal(call.body.max_tokens,undefined);assert.equal(call.config.headers.Authorization,`Bearer ${secret}`);}
});

test('HTTP failure classes are actionable, secret-safe and never retried',async()=>{
  const cases=[[401,'invalid_api_key','authentication'],[403,'permission_denied','permission'],[404,'model_not_found','model'],[429,'rate_limit_exceeded','rate_limit'],[429,'insufficient_quota','quota'],[500,'server_error','provider'],[418,'unrecognized','unknown']];
  for(const[status,code,category]of cases){const{service}=fixture();let count=0;service.httpClient.post=async()=>{count++;return{status,headers:{'x-request-id':'req_safe'},data:{error:{code,type:code,message:`Authorization Bearer ${secret}`}}};};const answer=await service.testConnection();assert.equal(answer.success,false);assert.equal(answer.status,status);assert.equal(answer.category,category);assert.equal(count,1);safe(answer);safe(service.getConnectionTest());safe(logs);}
});

test('untrusted provider code/request ID fields cannot echo credentials',async()=>{
  const{service}=fixture();service.httpClient.post=async()=>({status:401,headers:{'x-request-id':`req_${secret}`},data:{error:{code:secret,type:secret,message:secret}}});safe(await service.testConnection());safe(service.getConnectionTest());safe(logs);
});

test('quota error type is recognized when provider error code is absent',async()=>{
  const{service}=fixture();service.httpClient.post=async()=>({status:429,headers:{},data:{error:{code:null,type:'insufficient_quota',message:secret}}});const answer=await service.testConnection();assert.equal(answer.category,'quota');safe(answer);
});

test('model parameter rejection is classified as model access without leaking provider text',async()=>{
  const{service}=fixture();service.httpClient.post=async()=>({status:400,headers:{},data:{error:{code:'invalid_request_error',param:'model',message:secret}}});const answer=await service.testConnection();assert.equal(answer.success,false);assert.equal(answer.category,'model');safe(answer);
});

test('truncated visible output is not reported as a successful diagnostic',async()=>{
  const{service}=fixture();service.httpClient.post=async()=>{const response=completed();response.data.choices[0].finish_reason='length';return response;};assert.equal((await service.testConnection()).success,false);
});

test('network and timeout failures have safe categories',async()=>{
  for(const[code,category]of [['ENOTFOUND','network'],['ECONNREFUSED','network'],['ECONNABORTED','timeout'],['ETIMEDOUT','timeout']]){const{service}=fixture();service.httpClient.post=async()=>{const error=new Error(secret);error.isAxiosError=true;error.code=code;error.config={headers:{Authorization:secret}};throw error;};const answer=await service.testConnection();assert.equal(answer.success,false);assert.equal(answer.category,category);safe(answer);safe(logs);}
});

test('malformed successful responses and absent generated text never claim connected',async()=>{
  for(const data of [null,{}, {choices:[]},{choices:[{message:{content:null},finish_reason:'length'}]},{choices:[{message:{content:''}}]}]){const{service}=fixture();service.httpClient.post=async()=>({status:200,headers:{},data});const answer=await service.testConnection();assert.equal(answer.success,false);safe(answer);}
});

test('missing credentials/model fail locally without outbound requests',async()=>{
  for(const change of [{apiKey:''},{model:''}]){const{service}=fixture();service.updateSettings(change);let calls=0;service.httpClient.post=async()=>{calls++;return completed();};assert.equal((await service.testConnection()).success,false);assert.equal(calls,0);}
});

test('credential storage failures and unexpected exceptions remain secret-safe',async()=>{
  const{service}=fixture();service.getSettings=()=>{throw new Error(secret);};const unavailable=await service.testConnection();assert.equal(unavailable.success,false);assert.equal(unavailable.category,'configuration');safe(unavailable);
  const another=fixture().service;another.httpClient.post=async()=>{throw new Error(secret);};assert.equal((await another.testConnection()).success,false);safe(await another.testConnection());safe(logs);
});

test('last result survives reload and is invalidated when configuration changes',async()=>{
  const{service,values}=fixture();service.httpClient.post=async()=>completed();await service.testConnection();assert.equal(fixture(values).service.getConnectionTest().success,true);for(const change of [{model:'different-model'},{apiKey:'replacement-key'},{provider:'openrouter'}]){service.updateSettings(change);assert.equal(service.getConnectionTest(),null);}
});

test('deduplication bounds repeated clicks and stale completion cannot overwrite new configuration',async()=>{
  const{service}=fixture();let release;let count=0;service.httpClient.post=async()=>{count++;return await new Promise(resolve=>{release=resolve;});};const first=service.testConnection();const second=service.testConnection();await new Promise(resolve=>setImmediate(resolve));assert.equal(count,1);service.updateSettings({model:'changed'});release(completed());await Promise.all([first,second]);assert.equal(service.getConnectionTest(),null);safe(logs);
});
