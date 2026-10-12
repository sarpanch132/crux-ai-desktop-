const {test} = require('node:test');
const assert = require('node:assert/strict');
const {Readable} = require('node:stream');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');
const {providerText,messagePreview} = require('../electron/dist/services/agent/streamParser.js');
const {PermissionGateway} = require('../electron/dist/services/agent/permissionGateway.js');
const {AgentOrchestrator,createAgentState} = require('../electron/dist/services/agent/orchestrator.js');
async function collect(chunks,format,provider) {let text=''; for await(const part of providerText(Readable.from(chunks),format,provider))text+=part;return text;}

test('compatible SSE handles split UTF8/events and requires terminal event', async()=>{
  const bytes=Buffer.from('data: {"choices":[{"delta":{"content":"Hi ☃"}}]}\r\n\r\ndata: [DONE]\r\n\r\n');
  assert.equal(await collect([...bytes].map(byte=>Buffer.from([byte])),'sse','compatible'),'Hi ☃');
  await assert.rejects(collect(['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'],'sse','compatible'),/completion/);
});
test('Anthropic SSE emits only text deltas and Ollama NDJSON completes correctly',async()=>{
  assert.equal(await collect(['event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'],'sse','anthropic'),'hello');
  assert.equal(await collect(['{"message":{"content":"a"},"done":false}\n','{"message":{"content":"b"},"done":true}\n'],'ndjson','ollama'),'ab');
});
test('stream error, malformed JSON and oversized event fail instead of fabricating completion',async()=>{
  await assert.rejects(collect(['data: {"error":{"message":"private"}}\n\n'],'sse','compatible'),/Provider stream returned an error/);
  await assert.rejects(collect(['data: {broken}\n\n'],'sse','compatible'));
  await assert.rejects(collect(['x'.repeat(600*1024)],'sse','compatible'),/limit/);
});
test('partial presentation extracts top-level message only and decodes complete escapes',()=>{
  assert.equal(messagePreview('{"actions":[{"content":"message"}],"message":"Hi\\nthere\\u2603'),'Hi\nthere☃');
  assert.equal(messagePreview('{"message":"hello\\u26'),'hello');
  assert.equal(messagePreview('{"actions":[{"message":"hidden"}]}'),'');
});
test('agent scope intersects configured capabilities and command prerequisites, with revocation',async()=>{
  const gateway=new PermissionGateway('scope',process.cwd(),'code');
  gateway.setRouteCapabilities(['read','execute']);
  await assert.rejects(gateway.authorize({capability:'write',target:path.join(process.cwd(),'never.txt')}),/disabled/);
  await assert.rejects(gateway.authorize({capability:'execute',target:'node -e 1'}),/bypass disabled/);
  gateway.configure({write:true},[]); assert.equal(gateway.permissions.capabilities.write,false);
  gateway.setRouteCapabilities(null); assert.equal(gateway.permissions.capabilities.write,true);
});
test('partial malformed model action executes nothing and unrelated skills never load',async()=>{
  const gateway=new PermissionGateway('partial',process.cwd(),'plan'); let calls=0; let skillReads=0;
  const agent=new AgentOrchestrator({gateway,tools:{execute:async()=>{calls++;return[];}},skills:{list:async()=>{skillReads++;return[];}},model:{chat:async(_m,_o,onText)=>{onText('{"message":"working","actions":[{"tool":"write"');return '{"message":"working","actions":[';}},persist(){},emit(){}},createAgentState('partial',null));
  await assert.rejects(agent.run('inspect'),/invalid action response/); assert.equal(calls,0);assert.equal(skillReads,0);
});

const localRequire=createRequire(path.resolve('electron/dist/services/aiService.js')); const moduleResult={exports:{}};
const safeStorage={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from('encrypted:'+s),decryptString:b=>b.toString().replace(/^encrypted:/,'')};
vm.runInNewContext(fs.readFileSync('electron/dist/services/aiService.js','utf8'),{exports:moduleResult.exports,require:n=>n==='electron'?{safeStorage}:n==='electron-log'?{warn(){}}:localRequire(n),Buffer,process,setTimeout,clearTimeout,URL,AbortController});
function service(provider='custom'){const values=new Map();const result=new moduleResult.exports.AIService({get:k=>values.get(k),set:(k,v)=>values.set(k,v),delete:k=>values.delete(k)});result.updateSettings({provider,model:'actual',...(provider!=='custom'&&provider!=='ollama'?{apiKey:'fixture-key'}:{})});return result;}
test('actual AIService posts stream=true and publishes text before transport completes',async()=>{
  const ai=service();const stream=new Readable({read(){}});let published=false;
  ai.httpClient.post=async(_url,payload,config)=>{assert.equal(payload.stream,true);assert.equal(config.responseType,'stream');setImmediate(()=>stream.push('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'));return{status:200,headers:{'content-type':'text/event-stream'},data:stream};};
  const pending=ai.chatStreaming([{role:'user',content:'hi'}],{},text=>{assert.equal(text,'first');published=true;stream.push('data: [DONE]\n\n');stream.push(null);});
  assert.equal(await pending,'first');assert.equal(published,true);
});
test('actual provider payloads use Anthropic SSE and Ollama NDJSON',async()=>{
  for(const provider of ['anthropic','ollama']){
    const ai=service(provider);ai.httpClient.post=async(url,payload,config)=>{
      assert.equal(payload.stream,true);
      if(provider==='anthropic'){assert.equal(config.headers['x-api-key'],'fixture-key');assert.equal(payload.system,'system');}
      const data=provider==='anthropic'?'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\ndata: {"type":"message_stop"}\n\n':'{"message":{"content":"ok"},"done":true}\n';
      return{status:200,headers:{'content-type':provider==='ollama'?'application/x-ndjson':'text/event-stream'},data:Readable.from([data])};
    };
    assert.equal(await ai.chatStreaming([{role:'system',content:'system'},{role:'user',content:'task'}],{},()=>{}),'ok');
  }
});
test('transport abort after a partial event rejects instead of returning partial completion',async()=>{
  const ai=service();const stream=new Readable({read(){}});
  ai.httpClient.post=async(_url,_payload,config)=>{config.signal.addEventListener('abort',()=>stream.destroy(new Error('aborted')));setImmediate(()=>stream.push('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));return{status:200,headers:{'content-type':'text/event-stream'},data:stream};};
  await assert.rejects(ai.chatStreaming([{role:'user',content:'hi'}],{},()=>ai.abortStream()),/canceled/);
});
