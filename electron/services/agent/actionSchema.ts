import type { ToolRequest } from './contracts';
import { normalizeToolRequest } from './toolRegistry';

export interface NormalizedAction { type:'tool_call'; name:string; arguments:Record<string,unknown>; }
const fields = new Set(['path','content','pattern','command','args','url','verification','timeoutMs','sessionId','createOnly','checkKind','recursive','destination','search','replacement','expectedHash','edits','changeId','targetId','targetKind','task']);
const object = (value:unknown):value is Record<string,unknown> => !!value && typeof value==='object' && !Array.isArray(value);
export function normalizeAction(value:unknown):NormalizedAction {
  if(!object(value))throw new Error('Action must be an object.');
  if(value.type==='tool_call') {
    if(typeof value.name!=='string'||!value.name.trim()||!object(value.arguments)||Object.keys(value).some(key=>!['type','name','arguments'].includes(key)))throw new Error('Tool call requires a name and object arguments.');
    return {type:'tool_call',name:value.name,arguments:value.arguments};
  }
  if(typeof value.tool!=='string')throw new Error('Action is missing its tool name.');
  const {tool,...args}=value;
  return {type:'tool_call',name:tool,arguments:args};
}
export function validateAction(value:unknown):ToolRequest {
  const action=normalizeAction(value);
  if(Object.keys(action.arguments).some(key=>!fields.has(key)))throw new Error('Unknown tool argument.');
  const request=normalizeToolRequest({tool:action.name,...action.arguments} as ToolRequest);
  for(const key of ['path','content','pattern','command','url','sessionId','destination','search','replacement','expectedHash','changeId','targetId','targetKind','task'] as const) {
    if(request[key]!==undefined && typeof request[key]!=='string')throw new Error(`Invalid tool ${key}.`);
  }
  for(const key of ['verification','createOnly','recursive'] as const)if(request[key]!==undefined && typeof request[key]!=='boolean')throw new Error(`Invalid tool ${key}.`);
  if(request.timeoutMs!==undefined && (!Number.isInteger(request.timeoutMs)||request.timeoutMs<1||request.timeoutMs>120000))throw new Error('Invalid tool timeout.');
  if(request.checkKind!==undefined && !['test','lint','typecheck','build'].includes(request.checkKind))throw new Error('Invalid check kind.');
  if(request.args!==undefined && (!Array.isArray(request.args)||request.args.length>30||request.args.some(arg=>typeof arg!=='string'||arg.length>8000)))throw new Error('Invalid tool arguments.');
  if((request.content?.length??0)>1024*1024||(request.command?.length??0)>4096)throw new Error('Tool payload exceeds the execution limit.');
  const required = (key:keyof ToolRequest) => {if(typeof request[key]!=='string'||!(request[key] as string).trim())throw new Error(`Tool ${request.tool} requires ${key}.`);};
  if(['read','write','delete','mkdir','edit','move'].includes(request.tool))required('path');
  if(request.tool==='write' && request.content===undefined)throw new Error('Write requires content.');
  if(request.tool==='edit'){if(request.search===undefined)throw new Error('Edit requires search.');if(request.replacement===undefined)throw new Error('Edit requires replacement.');}
  if(request.tool==='move')required('destination');
  if(['command','process_start'].includes(request.tool))required('command');
  if(request.tool==='process_stop')required('sessionId');
  if(['search','file_search','symbol_search','find_references'].includes(request.tool))required('pattern');
  if(request.tool==='browser')required('url');
  if(['revert','accept'].includes(request.tool))required('changeId');
  if(request.tool==='delegate' && (!['agent','skill'].includes(request.targetKind??'')||!request.targetId||!request.task?.trim()||request.task.length>8000))throw new Error('Invalid delegation request.');
  if(request.edits!==undefined){
    if(!Array.isArray(request.edits)||request.edits.length>50||request.edits.some(edit=>!object(edit)||Object.keys(edit).some(key=>!['path','search','replacement','expectedHash'].includes(key))||['path','search','replacement','expectedHash'].some(key=>typeof edit[key]!=='string')||!edit.path.trim()||!edit.expectedHash))throw new Error('Invalid patch edits.');
  }
  if(request.tool==='patch' && !request.edits?.length)throw new Error('Patch requires edits.');
  return request;
}
