// Real Electron IPC/UI and Axios requests against an isolated local fixture.
// This does not contact OpenAI or verify a paid account.
const {_electron:electron,expect}=require('@playwright/test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
async function main(){
  const root=path.resolve(__dirname,'..');const temp=await fs.mkdtemp(path.join(os.tmpdir(),'crux-connection-'));const profile=path.join(temp,'profile');await fs.mkdir(profile);
  const project=path.join(temp,'project');await fs.mkdir(project);
  const secret='sk-connection-fixture-secret-7462';const calls=[];let mode='success';
  const server=http.createServer(async(req,res)=>{
    if(req.url.endsWith('/models')){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:[{id:'gpt-4.1-mini'},{id:'fixture-unavailable'}]}));return;}
    let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);calls.push({body,authorization:req.headers.authorization,url:req.url});
    const status=mode==='invalid'?401:body.model==='fixture-unavailable'?404:200;
    if(status!==200){res.writeHead(status,{'Content-Type':'application/json','x-request-id':'req_fixture'});res.end(JSON.stringify({error:{code:status===401?'invalid_api_key':'model_not_found',message:secret}}));return;}
    const agent=body.messages[0]?.content.includes('You are Crux AI');
    const content=agent?JSON.stringify({message:'Fixture plan response verified',requirements:['Inspect without changing files'],plan:{summary:'Read-only fixture plan',architecture:'Existing project',tasks:['Review requirements'],risks:[],acceptanceCriteria:['No files changed'],checks:[]}}):'OK';
    if(body.stream){res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta:{content}}]})}\n\ndata: [DONE]\n\n`);}
    else{res.writeHead(200,{'Content-Type':'application/json','x-request-id':'req_fixture'});res.end(JSON.stringify({id:'chatcmpl_fixture',choices:[{message:{role:'assistant',content:'OK'},finish_reason:'stop'}]}));}
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  await fs.writeFile(path.join(profile,'config.json'),JSON.stringify({ai:{settings:{provider:'openai',model:'gpt-4.1-mini',openaiBaseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:secret}}}));
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;let app;const browserLogs=[];const responses=[];
  try{
    const packaged=process.argv.includes('--packaged');app=await electron.launch({...(packaged?{executablePath:process.env.CRUX_TEST_EXECUTABLE}:{}),args:[...(packaged?[]:[root]),`--user-data-dir=${profile}`],env,timeout:45000});
    app.process().stdout?.on('data',data=>browserLogs.push(data.toString()));app.process().stderr?.on('data',data=>browserLogs.push(data.toString()));
    let page;for(let i=0;i<100;i++){page=app.windows().find(win=>win.url().startsWith('http://localhost:5173')||win.url().startsWith('file://'));if(page)break;await new Promise(resolve=>setTimeout(resolve,100));}assert(page);
    await page.setViewportSize({width:1440,height:900});await app.evaluate(({dialog},selected)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[selected]});},project);
    page.on('console',message=>browserLogs.push(message.text()));page.on('pageerror',error=>browserLogs.push(error.message));
    await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:/^Settings/}).click();
    const button=page.getByRole('button',{name:'Test Connection',exact:true});await expect(button).toBeEnabled({timeout:30000});await button.click();await expect(page.getByRole('button',{name:'Connected',exact:true})).toBeVisible({timeout:20000});
    const diagnostic=await page.evaluate(()=>window.electron.ai.getConnectionTest());responses.push(diagnostic);assert.equal(diagnostic.data.success,true);
    const chat=await page.evaluate(()=>window.electron.ai.chat([{role:'user',content:'Hi'}]));responses.push(chat);assert.equal(chat.data,'OK');
    const streamed=await page.evaluate(async()=>{const stream=window.electron.ai.stream([{role:'user',content:'Hi'}]);return await new Promise((resolve,reject)=>{let output='';stream.onChunk(chunk=>{output+=chunk;});stream.onDone(()=>resolve(output));stream.onError(reject);});});assert.equal(streamed,'OK');
    for(const call of calls){assert.equal(call.authorization,`Bearer ${secret}`);assert.equal(call.body.model,'gpt-4.1-mini');assert.equal(call.url,'/v1/chat/completions');}
    const artifacts=path.join(root,'tests/artifacts');await fs.mkdir(artifacts,{recursive:true});await page.locator('.connection-diagnostic').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(artifacts,'crux-connection-success.png'),fullPage:true});
    await page.getByRole('button',{name:'New chat',exact:true}).click();await page.getByRole('combobox',{name:'Choose project'}).selectOption('__open__');await expect(page.getByRole('combobox',{name:'Choose project'})).toHaveValue(project);
    await page.getByRole('combobox',{name:'Agent mode'}).selectOption('plan');await page.getByRole('textbox',{name:'Message',exact:true}).fill('Plan a read-only review');await page.getByRole('button',{name:'Send message',exact:true}).click();await expect(page.locator('.chat-message.assistant').getByText(/Fixture plan response verified/)).toBeVisible({timeout:20000});await expect(page.getByRole('combobox',{name:'Agent mode'})).toBeEnabled();assert.deepEqual(await fs.readdir(project),[],'Plan-mode chat changes no project files');
    const actualAgent=calls.find(call=>call.body.messages[0]?.content.includes('You are Crux AI'));assert(actualAgent);assert.equal(actualAgent.authorization,`Bearer ${secret}`);assert.equal(actualAgent.body.model,'gpt-4.1-mini');
    await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:/^Settings/}).click();
    mode='invalid';await page.getByRole('button',{name:'Connected',exact:true}).click();await expect(page.getByRole('button',{name:'Connection failed',exact:true})).toBeVisible();responses.push(await page.evaluate(()=>window.electron.ai.getConnectionTest()));await expect(page.locator('.connection-result').getByText(/OpenAI rejected the API credentials/)).toBeVisible();
    mode='success';await page.getByRole('combobox',{name:'Model',exact:true}).selectOption('fixture-unavailable');await expect.poll(async()=> (await page.evaluate(()=>window.electron.ai.getSettings())).data.model).toBe('fixture-unavailable');await page.getByRole('button',{name:'Test Connection',exact:true}).click();await expect(page.locator('.connection-result').getByText(/configured model could not be accessed/)).toBeVisible();responses.push(await page.evaluate(()=>window.electron.ai.getConnectionTest()));
    await page.locator('.connection-diagnostic').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(artifacts,'crux-connection-error.png'),fullPage:true});
    // Changing model invalidates prior results; diagnostic status never gates chat.
    await page.getByRole('combobox',{name:'Model',exact:true}).selectOption('gpt-4.1-mini');await expect.poll(async()=> (await page.evaluate(()=>window.electron.ai.getConnectionTest())).data).toBe(null);
    mode='invalid';await page.locator('.conversation-link').first().click();await page.getByRole('textbox',{name:'Message',exact:true}).fill('Plan another review');await page.getByRole('button',{name:'Send message',exact:true}).click();const settingsAction=page.getByRole('button',{name:'Open AI Settings',exact:true});await expect(settingsAction).toBeVisible({timeout:20000});await settingsAction.click();await expect(page.getByRole('heading',{name:'Connect your AI',exact:true})).toBeVisible();mode='success';
    await page.getByRole('combobox',{name:'Model',exact:true}).selectOption('gpt-4.1-mini');await expect.poll(async()=> (await page.evaluate(()=>window.electron.ai.getSettings())).data.model).toBe('gpt-4.1-mini');await new Promise(resolve=>server.close(resolve));
    await page.getByRole('button',{name:'Test Connection',exact:true}).click();await expect(page.locator('.connection-result').getByText(/could not reach OpenAI/)).toBeVisible();responses.push(await page.evaluate(()=>window.electron.ai.getConnectionTest()));
    responses.push(await page.evaluate(()=>window.electron.ai.getSettings()));assert(!JSON.stringify(responses).includes(secret));assert(!JSON.stringify(browserLogs).includes(secret));
    const config=await fs.readFile(path.join(profile,'config.json'),'utf8');assert(!config.includes(secret),'No plaintext credential persisted');
    const logDirectory=await app.evaluate(({app})=>app.getPath('logs'));for(const entry of await fs.readdir(logDirectory,{withFileTypes:true}).catch(()=>[])){if(entry.isFile()){const text=await fs.readFile(path.join(logDirectory,entry.name),'utf8');assert(!text.includes(secret),'Credential must not appear in server logs');}}
    console.log('PASS: Test Connection, actual chat and streaming share saved OpenAI settings; auth/model errors and secret isolation verified using local fixture.');
  }finally{if(app)await app.close();if(server.listening)await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
