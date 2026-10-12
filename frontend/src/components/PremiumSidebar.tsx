import { useMemo, useState } from 'react';
import { Folder, Plus, Search } from 'lucide-react';
import { Input } from './ui/input';
import { useStore } from '../hooks/useStore';

export function PremiumSidebar() {
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const { isGenerating, currentView, conversations, activeConversationId, createConversation, selectConversation, recentProjects, activateProject } = useStore();
  const filtered = useMemo(() => conversations.filter((chat) => !query.trim() || chat.title.toLowerCase().includes(query.toLowerCase()) || chat.messages.some((message) => message.content.toLowerCase().includes(query.toLowerCase()))), [conversations, query]);
  const paths = [...new Set([...recentProjects, ...conversations.map((chat) => chat.projectPath).filter((path): path is string => !!path)])];
  const chats = (path: string | null) => filtered.filter((chat) => (chat.projectPath ?? null) === path);
  const renderChats = (path: string | null) => chats(path).map((chat) => <button key={chat.id} disabled={isGenerating} aria-current={currentView === 'chat' && activeConversationId === chat.id ? 'page' : undefined} onClick={() => selectConversation(chat.id)} className="conversation-link" title={chat.title}>{chat.title}</button>);
  return <nav className="crux-sidebar" aria-label="Projects and chats">
    <div className="sidebar-heading"><strong>Crux AI</strong><button className="panel-icon-button" aria-label="Search chats" title="Search chats" aria-expanded={searchOpen} onClick={() => setSearchOpen(!searchOpen)}><Search className="h-4 w-4" aria-hidden="true"/></button></div>
    <button className="new-chat-button" disabled={isGenerating} onClick={() => createConversation()}><Plus aria-hidden="true" className="h-4 w-4"/>New chat</button>
    {searchOpen && <div className="sidebar-search"><Input autoFocus aria-label="Search chats" placeholder="Search chats" value={query} onChange={(event) => setQuery(event.target.value)}/></div>}
    <div className="sidebar-list">
      {!!paths.length && <p className="sidebar-group-label">Projects</p>}
      {paths.map((path) => <section className="project-group" key={path}><button className="project-group-title" title={path} disabled={isGenerating} onClick={() => void activateProject(path)}><Folder aria-hidden="true" className="h-4 w-4 shrink-0"/><span>{path.split(/[\\/]/).filter(Boolean).pop() ?? path}</span></button><div className="project-chats">{renderChats(path)}</div></section>)}
      {!!chats(null).length && <section className="project-group"><p className="sidebar-group-label">Chats</p>{renderChats(null)}</section>}
      {!filtered.length && <p className="sidebar-empty">{query ? 'No matching chats.' : 'Your chats will appear here.'}</p>}
    </div>
  </nav>;
}
