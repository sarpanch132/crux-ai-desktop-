const {test}=require('node:test');const assert=require('node:assert/strict');const {Readable}=require('node:stream');
const {agentReply,agentStream}=require('../electron/dist/services/agent/providerActions.js');
const reply={message:'Inspecting',actions:[{type:'tool_call',name:'read',arguments:{path:'README.md'}}],done:false};
const data=v=>`data: ${JSON.stringify(v)}\n\n`;
test('native compatible response envelope preserves plan and canonical action arguments',()=>{
 const plan={summary:'Plan',tasks:[]};const result=JSON.parse(agentReply({choices:[{message:{content:null,tool_calls:[{function:{name:'crux_reply',arguments:JSON.stringify({...reply,plan})}}]},finish_reason:'tool_calls'}]},'compatible'));assert.deepEqual(result,{...reply,plan});
 const direct=JSON.parse(agentReply({choices:[{message:{content:'Reading now',tool_calls:[{function:{name:'file_read',arguments:'{"path":"README.md"}'}}]}}]},'compatible'));assert.equal(direct.message,'Reading now');assert.equal(direct.actions[0].name,'file_read');assert.equal(direct.actions[0].arguments.path,'README.md');
});
test('compatible SSE accumulates split native arguments, previews incrementally and returns only complete reply',async()=>{
 const text=JSON.stringify(reply);const preview=[];const chunks=[data({choices:[{delta:{tool_calls:[{index:0,function:{name:'crux_reply',arguments:text.slice(0,30)}}]}}]}),data({choices:[{delta:{tool_calls:[{index:0,function:{arguments:text.slice(30)}}]},finish_reason:'tool_calls'}]}),'data: [DONE]\n\n'];
 const result=JSON.parse(await agentStream(Readable.from(chunks),'sse','compatible',v=>preview.push(v)));assert.deepEqual(result,reply);assert(preview.length>=2);assert(preview.some(v=>v.length<text.length));
});
test('Anthropic native blocks and streamed input_json_delta normalize to the same canonical reply',async()=>{
 assert.deepEqual(JSON.parse(agentReply({content:[{type:'tool_use',name:'crux_reply',input:reply}],stop_reason:'tool_use'},'anthropic')),reply);
 const result=await agentStream(Readable.from([data({type:'content_block_start',index:0,content_block:{type:'tool_use',name:'crux_reply',input:{}}}),data({type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(reply)}}),data({type:'message_stop'})]),'sse','anthropic');assert.deepEqual(JSON.parse(result),reply);
});
test('Ollama native argument objects and complete NDJSON normalize without text fabrication',async()=>{
 const body={message:{content:'',tool_calls:[{function:{name:'crux_reply',arguments:reply}}]},done:true};assert.deepEqual(JSON.parse(agentReply(body,'ollama')),reply);assert.deepEqual(JSON.parse(await agentStream(Readable.from([JSON.stringify(body)+'\n']),'ndjson','ollama')),reply);
});
test('malformed, identity overrides, unknown and prototype native calls are rejected',()=>{
 for(const[name,args]of[['unknown','{}'],['read','{"tool":"delete","path":"README.md"}'],['read','{"__proto__":{"evil":true}}'],['crux_reply','{"message":']])assert.throws(()=>agentReply({choices:[{message:{tool_calls:[{function:{name,arguments:args}}]}}]},'compatible'),/Invalid agent structured response/);
});
test('native reply envelope omissions require schema repair rather than prose-only completion',()=>{
 for(const args of [{message:'Describes reading only'},{message:'Read',actions:[]},{message:'Read',done:false},{message:'Read',actions:[],done:'false'}])assert.throws(()=>agentReply({choices:[{message:{tool_calls:[{function:{name:'crux_reply',arguments:JSON.stringify(args)}}]}}]},'compatible'),/requires message, actions and done/);
});
test('partial or truncated native streams cannot become executable replies',async()=>{
 const event=data({choices:[{delta:{tool_calls:[{index:0,function:{name:'crux_reply',arguments:JSON.stringify(reply)}}]}}]});await assert.rejects(agentStream(Readable.from([event]),'sse','compatible'),/before its completion event/);
 await assert.rejects(agentStream(Readable.from([event,data({choices:[{delta:{},finish_reason:'length'}]}),'data: [DONE]\n\n']),'sse','compatible'),/truncated/);
 await assert.rejects(agentStream(Readable.from([data({choices:[{delta:{tool_calls:[{index:0,function:{name:'crux_reply',arguments:'{"message":'}}]}}]}),'data: [DONE]\n\n']),'sse','compatible'),/complete JSON/);
});
