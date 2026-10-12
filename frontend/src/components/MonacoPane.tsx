import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor/editor/editor.api.js';
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker';
import 'monaco-editor/language/json/monaco.contribution.js';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import 'monaco-editor/languages/definitions/typescript/register.js';
import 'monaco-editor/languages/definitions/javascript/register.js';
import 'monaco-editor/languages/definitions/python/register.js';
import 'monaco-editor/languages/definitions/html/register.js';
import 'monaco-editor/languages/definitions/css/register.js';
import 'monaco-editor/languages/definitions/shell/register.js';
import 'monaco-editor/languages/definitions/markdown/register.js';
import type { Diagnostic } from '../../../electron/services/agent/contracts';

self.MonacoEnvironment = { getWorker: (_moduleId, label) => label === 'json' ? new JsonWorker() : new EditorWorker() };
monaco.editor.defineTheme('crux-code', {
  base: 'vs-dark', inherit: true, rules: [],
  colors: {'editor.background':'#191919','editorLineNumber.foreground':'#777777','editor.lineHighlightBackground':'#242424','editor.selectionBackground':'#444444','editorWidget.background':'#242424'},
});
const languages: Record<string,string> = {ts:'typescript',tsx:'typescript',js:'javascript',jsx:'javascript',py:'python',html:'html',css:'css',scss:'scss',sh:'shell',ps1:'powershell',md:'markdown',json:'json',rs:'rust',go:'go',yaml:'yaml',yml:'yaml'};
interface Props {path:string;value:string;before?:string;readOnly?:boolean;line?:number;onChange?:(value:string)=>void;diagnostics?:Diagnostic[];}
export function MonacoPane({path,value,before,readOnly=true,line,onChange,diagnostics=[]}:Props) {
  const host=useRef<HTMLDivElement>(null);
  const editor=useRef<monaco.editor.IStandaloneCodeEditor|null>(null);
  const diff=useRef<monaco.editor.IStandaloneDiffEditor|null>(null);
  const model=useRef<monaco.editor.ITextModel|null>(null);
  const change=useRef(onChange);change.current=onChange;
  const diffMode=before!==undefined;
  useEffect(()=>{
    if(!host.current)return;
    const language=languages[path.split('.').pop()?.toLowerCase()??'']??'plaintext';
    const modified=monaco.editor.createModel(value,language);model.current=modified;
    const options={theme:'crux-code',automaticLayout:true,fontSize:12,fontFamily:'Consolas, monospace',minimap:{enabled:false},scrollBeyondLastLine:false,readOnly,ariaLabel:diffMode?'Code diff':'File content',wordWrap:'off' as const,renderLineHighlight:'line' as const,padding:{top:10,bottom:10},accessibilitySupport:'auto' as const};
    let original:monaco.editor.ITextModel|undefined;
    if(diffMode){original=monaco.editor.createModel(before??'',language);diff.current=monaco.editor.createDiffEditor(host.current,{...options,renderSideBySide:false,originalEditable:false});diff.current.setModel({original,modified});}
    else {editor.current=monaco.editor.create(host.current,{...options,model:modified});}
    const subscription=modified.onDidChangeContent(()=>change.current?.(modified.getValue()));
    return()=>{subscription.dispose();editor.current?.dispose();diff.current?.dispose();editor.current=null;diff.current=null;modified.dispose();original?.dispose();model.current=null;};
    // Model lifetime follows file identity and view type; other props sync below.
  },[path,diffMode]);
  useEffect(()=>{if(model.current&&model.current.getValue()!==value)model.current.setValue(value);},[value]);
  useEffect(()=>{editor.current?.updateOptions({readOnly});diff.current?.updateOptions({readOnly});},[readOnly]);
  useEffect(()=>{const original=diff.current?.getOriginalEditor().getModel();if(original&&original.getValue()!==before)original.setValue(before??'');},[before]);
  useEffect(()=>{if(line){const target=editor.current??diff.current?.getModifiedEditor();target?.revealLineInCenter(line);target?.setPosition({lineNumber:line,column:1});}},[line,path,diffMode]);
  useEffect(()=>{if(!model.current)return;const key=(file:string)=>file.replaceAll('\\','/').toLowerCase();monaco.editor.setModelMarkers(model.current,'crux-checks',diagnostics.filter(item=>item.file&&key(item.file)===key(path)).map(item=>({startLineNumber:item.line??1,startColumn:item.column??1,endLineNumber:item.line??1,endColumn:(item.column??1)+1,message:item.message,code:item.code,source:item.source,severity:item.severity==='error'?monaco.MarkerSeverity.Error:monaco.MarkerSeverity.Warning})));},[diagnostics,path,diffMode]);
  return <div className="monaco-workspace-editor" ref={host}/>;
}
