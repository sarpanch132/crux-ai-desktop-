import { useEffect, useState } from 'react';
import { useStore } from '../hooks/useStore';
import { DefinitionLogo } from './AgentsSkillsPanel';

export function useMentionPicker() {
  const {catalog,composerValue,setComposerValue} = useStore();
  const [index,setIndex] = useState(0);
  const [dismissed,setDismissed] = useState(false);
  const match = composerValue.match(/^((?:@[a-z][a-z0-9_-]*\s+)*)@([a-z0-9_-]*)$/i);
  const query = match?.[2]?.toLowerCase();
  const suggestions = query === undefined ? [] : [...catalog.agents.map(item=>({...item,kind:'Agent'})),...catalog.skills.map(item=>({...item,kind:'Skill'}))].filter(item=>item.enabled && item.handle.startsWith(query)).slice(0,8);
  useEffect(() => {setIndex(0);setDismissed(false);},[composerValue]);
  const open = !dismissed && !!suggestions.length;
  const choose = (handle:string) => {setComposerValue(`${match?.[1] ?? ''}@${handle} `);setDismissed(true);};
  const onKeyDown = (event:React.KeyboardEvent<HTMLTextAreaElement>) => {
    if(!open) return false;
    if(event.key==='ArrowDown' || event.key==='ArrowUp') {event.preventDefault();setIndex(current=>(current+(event.key==='ArrowDown'?1:-1)+suggestions.length)%suggestions.length);return true;}
    if(event.key==='Escape') {event.preventDefault();setDismissed(true);return true;}
    if(event.key==='Enter' || event.key==='Tab') {event.preventDefault();choose(suggestions[Math.min(index,suggestions.length-1)].handle);return true;}
    return false;
  };
  const picker = open ? <div className="mention-picker" id="mention-options" role="listbox" aria-label="Agents and skills suggestions">{suggestions.map((item,itemIndex)=><button type="button" id={`mention-${itemIndex}`} className="mention-option" key={item.id} role="option" aria-selected={itemIndex===index} tabIndex={-1} onMouseDown={event=>event.preventDefault()} onClick={()=>choose(item.handle)}><DefinitionLogo definition={item}/><span><strong>@{item.handle}</strong><small>{item.name} · {item.kind}</small></span></button>)}</div> : null;
  return {onKeyDown,picker,open,activeId:open?`mention-${Math.min(index,suggestions.length-1)}`:undefined};
}

export function RoutePreview() {
  const {composerValue,routePreview,routeError,routeLoading,routeSelection,catalog,isGenerating,selectRoute,agentSnapshots,activeConversationId} = useStore();
  const retained = activeConversationId ? agentSnapshots[activeConversationId]?.state.route : undefined;
  if(!composerValue.trim() && !retained) return null;
  const route = routePreview ?? retained;
  return <div className="route-bar">
    <select aria-label="Agent routing" disabled={isGenerating} value={routeSelection?.agentId === null ? '__default__' : routeSelection?.agentId ?? '__auto__'} onChange={event=>selectRoute(event.target.value==='__auto__'?undefined:event.target.value==='__default__'?null:event.target.value)}><option value="__auto__">Automatic routing</option><option value="__default__">Default agent</option>{catalog.agents.filter(agent=>agent.enabled).map(agent=><option value={agent.id} key={agent.id}>{agent.name}</option>)}</select>
    {routeLoading ? <span role="status">Resolving…</span> : routeError ? <span className="field-error" role="alert">{routeError}</span> : route && <span title={route.reason}>{route.agent?.name ?? 'Default'}{route.skills.length ? ` · ${route.skills.map(skill=>skill.name).join(', ')}` : ''}</span>}
  </div>;
}
