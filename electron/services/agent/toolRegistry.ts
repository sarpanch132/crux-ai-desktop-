import type { Capability, ToolRequest } from './contracts.js';

const aliases: Record<string, ToolRequest['tool']> = { project_tree: 'list', file_read: 'read', file_create: 'write', file_edit: 'edit', file_delete: 'delete', file_move: 'move', code_search: 'search', directory_create: 'mkdir', terminal_run: 'command', git_status: 'git', git_diff: 'git', git_log: 'git', git_branch: 'git', test_run: 'check', lint_run: 'check', typecheck_run: 'check', build_run: 'check' };
const canonical = ['read', 'list', 'search', 'write', 'delete', 'mkdir', 'command', 'git', 'browser', 'computer', 'delegate', 'context', 'edit', 'patch', 'move', 'file_search', 'symbol_search', 'find_references', 'changes', 'revert', 'accept', 'check', 'diagnostics', 'tool_registry', 'process_start', 'process_stop', 'processes'] as const;
export function resolveToolName(name: string): ToolRequest['tool'] | undefined { return (Object.prototype.hasOwnProperty.call(aliases,name) ? aliases[name] : undefined) || (canonical.includes(name as typeof canonical[number]) ? name as ToolRequest['tool'] : undefined); }
export function normalizeToolRequest(request: ToolRequest): ToolRequest {
  const tool = resolveToolName(request.tool);
  if (!tool) throw new Error('Unknown tool.');
  const normalized = { ...request, tool };
  if (request.tool === 'file_create') normalized.createOnly = true;
  if (request.tool.startsWith('git_')) normalized.args = [request.tool.slice(4), ...(request.args || [])];
  const checks: Record<string, ToolRequest['checkKind']> = { test_run: 'test', lint_run: 'lint', typecheck_run: 'typecheck', build_run: 'build' };
  if (checks[request.tool]) normalized.checkKind = checks[request.tool];
  return normalized;
}
export interface ToolDescriptor { name: string; capability?: Capability; available: boolean; description: string; reason?: string; }
export const TOOL_DESCRIPTORS: ToolDescriptor[] = canonical.filter(name => !['computer', 'browser', 'delegate', 'diagnostics'].includes(name)).map<ToolDescriptor>(name => ({ name, available: true, capability: (name === 'git' ? 'gitRead' : ['write', 'edit', 'patch', 'move', 'mkdir', 'revert'].includes(name) ? 'write' : name === 'delete' ? 'delete' : ['command', 'check', 'process_start', 'process_stop'].includes(name) ? 'execute' : 'read') as Capability, description: ['symbol_search', 'find_references'].includes(name) ? 'Bounded lexical search; no semantic language-server guarantees.' : `Project-scoped ${name} through the permission gateway.` })).concat([
  { name: 'diagnostics', available: false, description: 'Parsed diagnostics', reason: 'Read the current Problems view; no independent diagnostics tool is bound.' },
  { name: 'web_search', available: false, description: 'Documentation research', reason: 'Search adapter is not configured. No search was performed.' },
  { name: 'github_issue', available: false, description: 'GitHub development workflows', reason: 'GitHub development API adapter is not configured.' },
  { name: 'mcp', available: false, description: 'MCP development tools', reason: 'No MCP server tool binding is configured.' },
]);
