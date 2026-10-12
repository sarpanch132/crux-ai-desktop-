import { useState } from 'react';
import { ArrowLeft, BookOpen, Bot, BarChart3, Code2, FlaskConical, Globe, Pen, Plus, Search, Shield, Sparkles, Terminal, Wrench, X } from 'lucide-react';
import { useStore } from '../hooks/useStore';
import { Button } from './ui/button';
import type { AgentDefinition, Capability, DefinitionDraft, DefinitionIcon, DefinitionMetadata, SkillDefinition } from '../../../electron/services/agent/contracts';

const icons = {sparkles: Sparkles, bot: Bot, code: Code2, search: Search, shield: Shield, terminal: Terminal, book: BookOpen, wrench: Wrench, pen: Pen, chart: BarChart3, globe: Globe, flask: FlaskConical};
const capabilities: Capability[] = ['read', 'write', 'delete', 'execute', 'gitRead', 'gitMutate', 'installDependencies', 'browser', 'computerControl'];
const toolNames: Record<Capability,string> = {read:'Read files',write:'Write files',delete:'Delete files',execute:'Run commands',gitRead:'Read Git',gitMutate:'Change Git',installDependencies:'Install dependencies',browser:'Inspect web pages',computerControl:'Computer control'};
export function DefinitionLogo({definition}: {definition: Pick<DefinitionMetadata,'icon'|'logoDataUrl'>}) {
  const Icon = icons[definition.icon] ?? Bot;
  return <span className="definition-logo">{definition.logoDataUrl ? <img src={definition.logoDataUrl} alt="" className="h-full w-full rounded-lg object-cover"/> : <Icon aria-hidden="true"/>}</span>;
}
function toDraft(definition: AgentDefinition | SkillDefinition): DefinitionDraft {
  return {name:definition.name,handle:definition.handle,description:definition.description,instructions:definition.instructions,enabled:definition.enabled,icon:definition.icon,logoDataUrl:definition.logoDataUrl,keywords:definition.keywords,callableAgentIds:definition.callableAgentIds,callableSkillIds:definition.callableSkillIds,...('allowedCapabilities' in definition ? {allowedCapabilities:definition.allowedCapabilities,skillIds:definition.skillIds} : {toolRequirements:definition.toolRequirements,definitionOfDone:definition.definitionOfDone})};
}
export function AgentsSkillsPanel() {
  const store = useStore();
  const [query,setQuery] = useState('');
  const [busy,setBusy] = useState(false);
  const [discard,setDiscard] = useState(false);
  const [confirmDelete,setConfirmDelete] = useState(false);
  const [github,setGithub] = useState('');
  const [logoError,setLogoError] = useState('');
  const draft = store.definitionDraft;
  const kind = draft?.kind ?? store.hubTab;
  const values = draft?.values;
  const change = (patch: Partial<DefinitionDraft>) => {if(draft) store.setDefinitionDraft({...draft,dirty:true,values:{...draft.values,...patch}});};
  const edit = (definition?: AgentDefinition | SkillDefinition) => {setDiscard(false);setConfirmDelete(false);setLogoError('');store.setDefinitionDraft({kind:store.hubTab,id:definition?.id,revision:definition?.revision,dirty:!definition,values:definition ? toDraft(definition) : {name:'',handle:'',description:'',instructions:'',enabled:true,icon:store.hubTab==='agent'?'bot':'book',keywords:[],allowedCapabilities:['read'],skillIds:[],toolRequirements:[],callableAgentIds:[],callableSkillIds:[]}});};
  const act = async (operation: () => Promise<unknown>) => {setBusy(true);try {await operation();} finally {setBusy(false);}};
  const back = () => {if(draft?.dirty) setDiscard(true);else store.setDefinitionDraft(null);};
  const toggle = (field:'allowedCapabilities'|'toolRequirements'|'skillIds'|'callableAgentIds'|'callableSkillIds',value:string,checked:boolean) => {
    const entries = (values?.[field] ?? []) as string[];
    change({[field]:checked ? [...entries,value] : entries.filter(entry => entry !== value)});
  };
  const uploadLogo = async (file?: File) => {
    if(!file) return;setLogoError('');
    if(!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size > 128*1024) {setLogoError('Choose a PNG, JPEG, or WebP under 128 KB.');return;}
    const reader = new FileReader();reader.onload = () => {if(typeof reader.result === 'string') change({logoDataUrl:reader.result});};reader.onerror = () => setLogoError('Unable to read this image.');reader.readAsDataURL(file);
  };
  const definitions = store.hubTab === 'agent' ? store.catalog.agents : store.catalog.skills;
  const matches = definitions.filter(item => `${item.name} ${item.handle} ${item.description}`.toLowerCase().includes(query.toLowerCase()));
  const invalid = !values?.name.trim() || !/^[a-z][a-z0-9_-]{0,31}$/.test(values?.handle ?? '') || !values?.instructions.trim();
  return <section className="agents-hub" aria-label="Agents and Skills" onKeyDown={event=>{if(event.key === 'Escape'){event.stopPropagation();store.setHubOpen(false);}}}>
    <header className="hub-heading"><h2>Agents & Skills</h2><button className="panel-icon-button" aria-label="Close Agents and Skills" title="Close Agents and Skills" onClick={() => store.setHubOpen(false)}><X aria-hidden="true" className="h-4 w-4"/></button></header>
    {!draft && <div className="hub-tabs" role="tablist" aria-label="Definition type"><button role="tab" aria-selected={store.hubTab==='agent'} onClick={() => {store.setHubTab('agent');setQuery('');}}>Agents</button><button role="tab" aria-selected={store.hubTab==='skill'} onClick={() => {store.setHubTab('skill');setQuery('');}}>Skills</button></div>}
    <div className="hub-scroll">
      {store.catalogError && <p role="alert" className="field-error mb-4">{store.catalogError}</p>}
      {draft && values ? <><button className="hub-back" onClick={back}><ArrowLeft aria-hidden="true" className="h-3.5 w-3.5"/>All {kind === 'agent' ? 'agents' : 'skills'}</button>
        {discard && <div className="mb-5"><p className="hub-help">Discard your unsaved changes?</p><Button variant="outline" onClick={() => setDiscard(false)}>Keep editing</Button><Button className="ml-2" onClick={() => {store.setDefinitionDraft(null);setDiscard(false);}}>Discard changes</Button></div>}
        <form onSubmit={(event) => {event.preventDefault();void act(() => store.saveDefinition(kind,{...values,keywords:(values.keywords ?? []).map(phrase=>phrase.trim()).filter(Boolean)},draft.id,draft.revision));}}><fieldset className="definition-editor" disabled={busy || store.isGenerating}>
          <label htmlFor="definition-name">Name<input id="definition-name" autoFocus required maxLength={100} value={values.name} onChange={(event) => change({name:event.target.value})}/></label>
          <label htmlFor="definition-handle">Handle<input id="definition-handle" required maxLength={32} value={values.handle} placeholder="reviewer" onChange={(event) => change({handle:event.target.value})}/><small>Use @{values.handle || 'handle'} at the start of a message. Lowercase letters, digits, hyphens, and underscores.</small></label>
          <div><p className="text-xs">Logo</p><div className="logo-options">{(Object.keys(icons) as DefinitionIcon[]).map(icon => {const Icon=icons[icon];return <button key={icon} type="button" className="definition-logo" title={icon} aria-label={`${icon} logo`} aria-pressed={values.icon===icon && !values.logoDataUrl} onClick={() => change({icon,logoDataUrl:''})}><Icon aria-hidden="true"/></button>;})}</div><label className="mt-3">Upload logo<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void uploadLogo(event.target.files?.[0])}/><small>PNG, JPEG, or WebP, up to 128 KB and 512 × 512. Image content is validated when saved.</small></label>{values.logoDataUrl && <div className="mt-3"><DefinitionLogo definition={{icon:values.icon ?? 'bot',logoDataUrl:values.logoDataUrl}}/></div>}{logoError && <p role="alert" className="field-error">{logoError}</p>}</div>
          <label htmlFor="definition-description">Description<textarea id="definition-description" maxLength={1000} value={values.description ?? ''} onChange={(event) => change({description:event.target.value})} placeholder="What this helps you do"/></label>
          <label htmlFor="definition-instructions">How it works<textarea id="definition-instructions" required maxLength={60000} value={values.instructions} onChange={(event) => change({instructions:event.target.value})} placeholder="Describe its responsibilities and approach"/></label>
          <label htmlFor="definition-keywords">Automatic triggers<textarea id="definition-keywords" value={(values.keywords ?? []).join('\n')} onChange={(event) => change({keywords:event.target.value.split('\n')})} placeholder="One phrase per line"/><small>Literal phrases in your message choose a matching definition. Leave empty for manual invocation.</small></label>
          <label className="inline-check"><input type="checkbox" checked={values.enabled ?? true} onChange={(event) => change({enabled:event.target.checked})}/>Enabled</label>
          <details><summary>Advanced permissions and integrations</summary><div className="definition-advanced">
            <fieldset className="definition-checks"><legend>{kind==='agent' ? 'Allowed tools' : 'Required tools'}</legend><p className="hub-help">{kind==='agent' ? 'Limits existing session access; selecting tools never grants permission.' : 'Requirements describe what the skill needs; they never grant permission.'}</p>{capabilities.map(capability => <label className="inline-check" key={capability}><input type="checkbox" checked={(kind==='agent'?values.allowedCapabilities:values.toolRequirements)?.includes(capability) ?? false} onChange={(event) => toggle(kind==='agent'?'allowedCapabilities':'toolRequirements',capability,event.target.checked)}/>{toolNames[capability]}</label>)}</fieldset>
            {kind==='agent' && <fieldset className="definition-checks"><legend>Attached skills</legend>{store.catalog.skills.map(skill => <label className="inline-check" key={skill.id}><input type="checkbox" checked={values.skillIds?.includes(skill.id) ?? false} onChange={(event) => toggle('skillIds',skill.id,event.target.checked)}/>{skill.name}{!skill.enabled && ' (disabled)'}</label>)}{!store.catalog.skills.length && <p className="hub-help">Create or import a skill to attach it.</p>}</fieldset>}
            <fieldset className="definition-checks"><legend>Callable agents</legend>{store.catalog.agents.filter(agent=>agent.id!==draft.id).map(agent => <label className="inline-check" key={agent.id}><input type="checkbox" checked={values.callableAgentIds?.includes(agent.id) ?? false} onChange={(event) => toggle('callableAgentIds',agent.id,event.target.checked)}/>{agent.name}</label>)}{!store.catalog.agents.length && <p className="hub-help">Saved agents appear here.</p>}</fieldset>
            <fieldset className="definition-checks"><legend>Callable skills</legend>{store.catalog.skills.filter(skill=>skill.id!==draft.id).map(skill => <label className="inline-check" key={skill.id}><input type="checkbox" checked={values.callableSkillIds?.includes(skill.id) ?? false} onChange={(event) => toggle('callableSkillIds',skill.id,event.target.checked)}/>{skill.name}</label>)}{!store.catalog.skills.length && <p className="hub-help">Saved skills appear here.</p>}</fieldset>
          </div></details>
          <div className="definition-actions"><Button type="submit" disabled={busy || store.isGenerating || invalid}>{busy?'Saving…':draft.id?'Save definition':`Create ${kind}`}</Button>{draft.id && <button type="button" className="hub-danger" disabled={busy || store.isGenerating} onClick={() => setConfirmDelete(true)}>Delete {kind}</button>}</div>
          {confirmDelete && draft.id && draft.revision !== undefined && <div><p className="hub-help">Delete {values.name}? References must be removed first.</p><Button type="button" variant="outline" disabled={busy} onClick={() => setConfirmDelete(false)}>Cancel</Button><Button type="button" className="ml-2" disabled={busy || store.isGenerating} onClick={() => void act(() => store.removeDefinition(kind,draft.id!,draft.revision!))}>Confirm delete</Button></div>}
        </fieldset></form>
      </> : <><div className="hub-list-actions"><input className="hub-search" aria-label={`Search ${store.hubTab==='agent'?'agents':'skills'}`} value={query} placeholder="Search" onChange={(event) => setQuery(event.target.value)}/><Button size="sm" disabled={store.isGenerating} onClick={() => edit()}><Plus aria-hidden="true" className="mr-1 h-4 w-4"/>Create</Button></div>
        {store.catalogLoading && <p className="hub-help" role="status">Loading definitions…</p>}
        {matches.map(definition => <div className="definition-card" key={definition.id}><button className="definition-open" aria-label={`Edit ${definition.name}`} onClick={() => edit(definition)}><DefinitionLogo definition={definition}/><span className="definition-copy"><strong>{definition.name}</strong><small>@{definition.handle}</small></span></button><label className="definition-toggle"><input type="checkbox" aria-label={`Enable ${definition.name}`} checked={definition.enabled} disabled={busy || store.isGenerating} onChange={(event) => void act(() => store.saveDefinition(store.hubTab,{...toDraft(definition),enabled:event.target.checked},definition.id,definition.revision))}/>Enabled</label></div>)}
        {!matches.length && !store.catalogLoading && <p className="hub-empty">{query ? 'No definitions match your search.' : store.hubTab==='agent' ? 'Create an agent for a repeatable way of working.' : 'Create or import a skill to reuse an instruction set.'}</p>}
        {store.hubTab==='skill' && <div className="hub-import"><label className="w-full text-xs">GitHub skill URL<input className="hub-search" aria-label="GitHub skill URL" value={github} onChange={(event) => setGithub(event.target.value)} placeholder="https://github.com/owner/repository"/></label><Button size="sm" variant="outline" disabled={busy || store.isGenerating || !github.trim()} onClick={() => void act(async () => {if(await store.importGithubSkill(github.trim())) setGithub('');})}>Import from GitHub</Button><Button size="sm" variant="outline" disabled={busy || store.isGenerating || !store.activeConversationId} onClick={() => void act(async () => {const result=await window.electron.agent.installSkill(store.activeConversationId!);if(result.success) await store.refreshCatalog();else useStore.setState({catalogError:result.error??'Import failed.'});})}>Import SKILL.md</Button><p className="hub-help">You can also paste a GitHub link in chat and ask to install the skill. Imports require confirmation.</p></div>}
      </>}
      {!draft && <details className="settings-advanced"><summary>Advanced routing</summary><label className="mt-4 flex items-center gap-2 text-xs"><input type="checkbox" aria-label="Match intent with AI" checked={store.routingSemantic} disabled={busy || store.isGenerating} onChange={event=>void act(()=>store.setRoutingSemantic(event.target.checked))}/>Match intent with AI</label><p className="hub-help">When keywords do not match, uses an extra model request through your current provider. Uncertain matches use Default. Off by default.</p></details>}
    </div>
    {store.isGenerating && <p className="hub-notice" role="status">Changes are available after the current run. Your draft is kept here.</p>}
  </section>;
}
