// Actual Electron/provider UI fixture. No paid provider requests.
const {_electron:electron,expect}=require('@playwright/test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
async function main(){
  const root=path.resolve(__dirname,'..');const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'crux-auto-ui-'));const profile=path.join(temporary,'profile');await fs.mkdir(profile);
  const secret='sk-AUTO-ELECTRON-SECRET-612981';const calls=[];const logs=[];const responses=[];let mode='success';
  const server=http.createServer(async(req,res)=>{
    if(req.url.endsWith('/models')){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:[{id:'text-embedding-3-small'},{id:'gpt-image-1'},{id:'gpt-4.1-mini'},{id:'gpt-4.1-nano'}]}));return;}
    let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);calls.push({body,authorization:req.headers.authorization,url:req.url});const code=mode==='quota'?'insufficient_quota':body.model==='gpt-4.1-mini'?'model_not_found':undefined;
    if(code){res.writeHead(mode==='quota'?429:404,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{code,type:code,message:secret}}));return;}
    res.writeHead(200,{'Content-Type':body.stream?'text/event-stream':'application/json'});res.end(body.stream?'data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n':JSON.stringify({choices:[{message:{content:'OK'},finish_reason:'stop'}]}));
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  await fs.writeFile(path.join(profile,'config.json'),JSON.stringify({ai:{settings:{provider:'openai',model:'gpt-4.1-mini',autoModel:false,openaiBaseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:secret}}}));
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;let app;
  try{
    const packaged=process.argv.includes('--packaged');app=await electron.launch({...(packaged?{executablePath:process.env.CRUX_TEST_EXECUTABLE}:{}),args:[...(packaged?[]:[root]),`--user-data-dir=${profile}`],env,timeout:45000});app.process().stdout?.on('data',data=>logs.push(data.toString()));app.process().stderr?.on('data',data=>logs.push(data.toString()));
    let page;for(let count=0;count<150;count++){page=app.windows().find(win=>win.url().startsWith('http://localhost:5173')||win.url().startsWith('file://'));if(page)break;await new Promise(resolve=>setTimeout(resolve,100));}assert(page);page.on('console',message=>logs.push(message.text()));page.on('pageerror',error=>logs.push(error.message));await page.setViewportSize({width:1440,height:900});
    await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:/^Settings/}).click();const selector=page.getByRole('combobox',{name:'Model',exact:true});await expect(selector).toBeEnabled({timeout:30000});const options=await selector.locator('option').allTextContents();assert(!options.some(value=>/embedding|gpt-image/.test(value)));
    const autoValue=await selector.locator('option').filter({hasText:/^Auto/}).getAttribute('value');assert(autoValue);await selector.selectOption(autoValue);
    await expect.poll(async()=>{const settings=(await page.evaluate(()=>window.electron.ai.getSettings())).data;return settings.autoModel&&settings.model==='gpt-4.1-nano';},{timeout:20000}).toBe(true);
    const testedAt=(await page.evaluate(()=>window.electron.ai.getConnectionTest())).data.testedAt;const verifiedCalls=calls.length;await selector.selectOption('gpt-4.1-nano');await expect.poll(async()=>(await page.evaluate(()=>window.electron.ai.getSettings())).data.autoModel).toBe(false);await selector.selectOption(autoValue);await expect.poll(async()=>{const settings=(await page.evaluate(()=>window.electron.ai.getSettings())).data;return settings.autoModel&&settings.model==='gpt-4.1-nano';},{timeout:20000}).toBe(true);assert.equal(calls.length,verifiedCalls);assert.equal((await page.evaluate(()=>window.electron.ai.getConnectionTest())).data.testedAt,testedAt);
    const chat=await page.evaluate(()=>window.electron.ai.chat([{role:'user',content:'Hi'}]));responses.push(chat);assert.equal(chat.data,'OK');const streamed=await page.evaluate(async()=>{const stream=window.electron.ai.stream([{role:'user',content:'Hi'}]);return await new Promise((resolve,reject)=>{let text='';stream.onChunk(chunk=>text+=chunk);stream.onDone(()=>resolve(text));stream.onError(reject);});});assert.equal(streamed,'OK');assert.equal(calls[0].body.model,'gpt-4.1-mini');assert(calls.some(call=>call.body.model==='gpt-4.1-nano'&&call.body.stream));for(const call of calls){assert.equal(call.authorization,`Bearer ${secret}`);assert(!/auto/i.test(call.body.model));assert.equal(call.url,'/v1/chat/completions');}
    await page.getByRole('button',{name:'New chat',exact:true}).click();await expect(page.getByRole('combobox',{name:'Chat model'})).toHaveValue(autoValue);await page.getByRole('combobox',{name:'Chat model'}).selectOption('gpt-4.1-nano');await expect.poll(async()=>(await page.evaluate(()=>window.electron.ai.getSettings())).data.autoModel).toBe(false);
    await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:/^Settings/}).click();await expect(selector).toHaveValue('gpt-4.1-nano');const artifacts=path.join(root,'tests/artifacts');await fs.mkdir(artifacts,{recursive:true});await page.screenshot({path:path.join(artifacts,'crux-provider-auto.png'),fullPage:true});
    mode='quota';const countBefore=calls.length;responses.push(await page.evaluate(key=>window.electron.ai.updateSettings({apiKey:key}),`${secret}-quota`));await selector.selectOption(autoValue);await expect(page.getByText(/insufficient API quota|API quota|quota or spending limit|billing\/credits/i).first()).toBeVisible({timeout:20000});assert.equal(calls.length,countBefore+1,`Unexpected provider probes: ${JSON.stringify(calls.slice(countBefore).map(call=>call.body.model))}`);assert.equal((await page.evaluate(()=>window.electron.ai.getSettings())).data.model,'gpt-4.1-nano');
    for(const result of responses)assert(!JSON.stringify(result).includes(secret));assert(!logs.join('\n').includes(secret));console.log('PASS: provider filtering, Auto fallback, quota stop, real chat and synchronized manual model selection without credential leakage.');
  }finally{if(app)await app.close();await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
