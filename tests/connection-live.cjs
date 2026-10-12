// Opt-in live check: keys stay in Electron main memory; the user's profile is read-only.
const {_electron: electron} = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function main() {
  const configPath = process.env.CRUX_LIVE_CONFIG;
  if (!configPath) throw new Error('Set CRUX_LIVE_CONFIG only after authorizing two minimal live requests.');
  const root = path.resolve(__dirname, '..');
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'crux-live-diagnostic-'));
  const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    // Chromium's Windows credential wrapping is profile-bound. Copy only its
    // encrypted OS key container, never plaintext credentials or user settings.
    if (process.platform === 'win32') await fs.copyFile(path.join(path.dirname(configPath), 'Local State'), path.join(profile, 'Local State'));
    app = await electron.launch({args:[root, `--user-data-dir=${profile}`], env, timeout:45000});
    const result = await app.evaluate(async ({app}, {source,chatOnly,autoMode,freeRouter}) => {
      const requireMain = process.mainModule.require.bind(process.mainModule);
      const fs = requireMain('node:fs');
      const {AIService} = requireMain(app.getAppPath() + '/electron/dist/services/aiService.js');
      const values = JSON.parse(fs.readFileSync(source, 'utf8'));
      const get = key => key.split('.').reduce((value, part) => value?.[part], values);
      const set = (key, value) => {
        const parts = key.split('.'); let target = values;
        for (const part of parts.slice(0,-1)) target = target[part] ??= {};
        target[parts.at(-1)] = value;
      };
      const service = new AIService({get,set,delete:key => {
        const parts = key.split('.'); const parent = get(parts.slice(0,-1).join('.'));
        if (parent) delete parent[parts.at(-1)];
      }});
      let stage = 'load_settings';
      try {
        const settings = service.getSettings();
        if (!settings.provider || !settings.apiKey || !settings.model) return {available:false};
        if (freeRouter && settings.provider === 'openrouter') { service.updateSettings({model:'openrouter/free',autoModel:false}); settings.model='openrouter/free'; }
        let auto;
        if (autoMode) {
          stage = 'auto_model'; auto = await service.findWorkingModel();
          if (!auto.success) return {available:true,auto,chatSuccess:false};
        }
        stage = 'test_connection';
        const test = chatOnly || autoMode ? null : await service.testConnection();
        if (test && !test.success) return {available:true,test,chatSuccess:false};
        try {
          const reply = await service.chat([{role:'user',content:'Reply with OK.'}], {maxTokens:64,timeoutMs:15000});
          return {available:true,test,auto,chatSuccess:typeof reply === 'string' && !!reply.trim(),sameConfiguration:service.getSettings().model === (auto?.model ?? settings.model)};
        } catch {return {available:true,test,chatSuccess:false,message:'Live chat did not return a valid completion.'};}
      } catch (error) {
        const text = typeof error?.message === 'string' ? error.message : '';
        const reason = /decrypt|encrypt/i.test(text) ? 'credential_decryption' : /storage|keyring/i.test(text) ? 'credential_storage' : /URL|endpoint|protocol/i.test(text) ? 'endpoint_configuration' : 'settings_configuration';
        return {available:false,stage,reason,message:'The saved connection could not be securely loaded.'};
      }
    }, {source:configPath,chatOnly:process.argv.includes('--chat-only'),autoMode:process.argv.includes('--auto'),freeRouter:process.argv.includes('--free-router')});
    console.log(JSON.stringify(result));
    if (result.available && ((result.test && !result.test.success) || !result.chatSuccess)) process.exitCode = 1;
  } finally {if (app) await app.close(); const relative=path.relative(path.resolve(os.tmpdir()),path.resolve(profile)); if(path.isAbsolute(relative)||relative.startsWith('..')||!/^crux-live-diagnostic-[^\\/]+$/.test(relative))throw new Error('Unsafe temporary profile'); await fs.rm(profile,{recursive:true,force:true});}
}
main().catch(() => {console.error('Live connection verification could not complete.');process.exitCode=1;});
