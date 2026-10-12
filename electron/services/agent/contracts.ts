export type AgentMode = 'plan' | 'code' | 'debug';
export type AccessLevel = 'full' | 'medium' | 'restricted';
export type Capability = 'read' | 'write' | 'delete' | 'execute' | 'gitRead' | 'gitMutate' | 'browser' | 'computerControl' | 'installDependencies';
export type AgentStatus = 'understanding' | 'gathering_context' | 'planning' | 'implementing' | 'testing' | 'debugging' | 'verifying' | 'completed' | 'blocked';
export interface Plan { summary: string; architecture: string; tasks: string[]; risks: string[]; acceptanceCriteria: string[]; checks: string[]; }
export interface RepositoryMetadata { languages: string[]; frameworks: string[]; packageManagers: string[]; sourceDirectories: string[]; tests: string[]; configuration: string[]; routes: string[]; databases: string[]; migrations: string[]; environmentNames: string[]; scripts: Record<string, string>; monorepo: boolean; truncated: boolean; }
export interface RepoContext { projectPath: string | null; files: string[]; notes: string[]; metadata?: RepositoryMetadata; inspectedFiles?: string[]; }
export interface TrackedChange { id: string; path: string; beforeHash: string | null; afterHash: string | null; operation: 'write' | 'delete'; timestamp: number; reviewed: boolean; }
export interface ChangeDetail extends TrackedChange { before: string | null; after: string | null; }
export interface Diagnostic { file?: string; line?: number; column?: number; code?: string; severity: 'error' | 'warning'; source: string; message: string; command?: string; exitCode?: number | null; }
export interface Skill { id: string; name: string; description: string; instructions: string; toolRequirements: Capability[]; definitionOfDone: string[]; source: string; }
export type DefinitionKind = 'agent' | 'skill';
export type DefinitionIcon = 'sparkles' | 'bot' | 'code' | 'search' | 'shield' | 'terminal' | 'book' | 'wrench' | 'pen' | 'chart' | 'globe' | 'flask';
export interface DefinitionMetadata {
  id: string; revision: number; name: string; handle: string; description: string;
  enabled: boolean; icon: DefinitionIcon; logoDataUrl?: string; keywords: string[];
  instructions: string; callableAgentIds: string[]; callableSkillIds: string[];
  createdAt: number; updatedAt: number;
}
export interface AgentDefinition extends DefinitionMetadata { allowedCapabilities: Capability[]; skillIds: string[]; }
export interface SkillProvenance { kind: 'created' | 'legacy' | 'local' | 'github'; sourceUrl?: string; commit?: string; importedAt?: number; fileCount?: number; totalBytes?: number; }
export interface SkillDefinition extends Skill, DefinitionMetadata { provenance: SkillProvenance; }
export interface DefinitionDraft {
  name: string; handle: string; instructions: string; description?: string; enabled?: boolean;
  icon?: DefinitionIcon; logoDataUrl?: string; keywords?: string[];
  callableAgentIds?: string[]; callableSkillIds?: string[];
  allowedCapabilities?: Capability[]; skillIds?: string[];
  toolRequirements?: Capability[]; definitionOfDone?: string[];
}
export interface CatalogSnapshot { revision: number; agents: AgentDefinition[]; skills: SkillDefinition[]; }
export interface RouteSelection { catalogRevision: number; agentId?: string | null; skillIds?: string[]; }
export interface ResolvedRoute {
  source: 'default' | 'explicit' | 'keyword' | 'semantic'; catalogRevision: number;
  originalText: string; executionText: string; agent?: AgentDefinition; skills: SkillDefinition[];
  matchedKeywords: string[]; reason: string; allowedAgentIds: string[]; allowedSkillIds: string[];
}
export interface FileChange { path: string; operation: 'write' | 'delete' | 'mkdir'; timestamp: number; }
export interface TestResult { command: string; exitCode: number | null; output: string; passed: boolean; timestamp: number; revision: number; }
export interface AgentError { message: string; timestamp: number; stage: AgentStatus; }
export interface AgentPermissions { level: AccessLevel; allowedPaths: string[]; capabilities: Record<Capability, boolean>; revision: number; sandboxAvailable: boolean; }
export interface AuditEntry { id: string; timestamp: number; sessionId: string; tool: string; target: string; outcome: 'requested' | 'approved' | 'denied' | 'completed' | 'error'; detail: string; }
export interface ApprovalRequest { id: string; sessionId: string; tool: string; target: string; reason: string; expiresAt: number; allowSession: boolean; }
export interface AgentState {
  problems?: Diagnostic[]; inspectedFiles?: string[]; iterations?: number; autoFix?: boolean; iterationLimit?: number;
  id: string; mode: AgentMode; objective: string; requirements: string[]; acceptanceCriteria: string[];
  plan?: Plan; route?: ResolvedRoute; routeCapabilities?: Capability[]; repoContext: RepoContext; activeSkills: Skill[]; changedFiles: FileChange[];
  testResults: TestResult[]; errors: AgentError[]; status: AgentStatus; blockedReason?: string;
  revision: number; running: boolean; history: {role: 'user' | 'assistant'; content: string}[];
}
export interface AgentSnapshot { state: AgentState; permissions: AgentPermissions; approvals: ApprovalRequest[]; audit: AuditEntry[]; skills: Skill[]; }
export interface FileEdit { path: string; search: string; replacement: string; expectedHash: string; }
export interface ToolRequest { tool: 'read' | 'list' | 'search' | 'write' | 'delete' | 'mkdir' | 'command' | 'git' | 'browser' | 'computer' | 'delegate' | 'context' | 'edit' | 'patch' | 'move' | 'file_search' | 'symbol_search' | 'find_references' | 'changes' | 'revert' | 'accept' | 'project_tree' | 'file_read' | 'file_create' | 'file_edit' | 'file_delete' | 'file_move' | 'code_search' | 'directory_create' | 'terminal_run' | 'git_status' | 'git_diff' | 'git_log' | 'git_branch' | 'check' | 'diagnostics' | 'tool_registry' | 'test_run' | 'lint_run' | 'typecheck_run' | 'build_run' | 'process_start' | 'process_stop' | 'processes'; timeoutMs?: number; sessionId?: string; createOnly?: boolean; checkKind?: 'test' | 'lint' | 'typecheck' | 'build'; recursive?: boolean; destination?: string; search?: string; replacement?: string; expectedHash?: string; edits?: FileEdit[]; changeId?: string; targetId?: string; targetKind?: DefinitionKind; task?: string; path?: string; content?: string; pattern?: string; command?: string; args?: string[]; url?: string; verification?: boolean; }
export interface CommandResult { command: string; exitCode: number | null; output: string; timedOut: boolean; sessionId?: string; cwd?: string; stdout?: string; stderr?: string; durationMs?: number; execution?: 'host' | 'container'; }
export interface AgentProgress { sessionId: string; projectPath: string | null; runId: string; sequence: number; text: string; }
export interface AgentAPI {
  setExecutionOptions: (id: string, options: {autoFix?:boolean;iterationLimit?:number}) => Promise<{success:boolean;data?:AgentSnapshot;error?:string}>;
  onProgress?: (callback: (event: AgentProgress) => void) => () => void;
  routingOptions: () => Promise<{success:boolean;data?:{semantic:boolean};error?:string}>;
  setSemanticRouting: (enabled:boolean) => Promise<{success:boolean;data?:{semantic:boolean};error?:string}>;
  catalog: () => Promise<{success: boolean; data?: CatalogSnapshot; error?: string}>;
  saveDefinition: (kind: DefinitionKind, draft: DefinitionDraft, id?: string, expectedRevision?: number) => Promise<{success: boolean; data?: CatalogSnapshot; error?: string}>;
  removeDefinition: (kind: DefinitionKind, id: string, expectedRevision: number) => Promise<{success: boolean; data?: CatalogSnapshot; error?: string}>;
  importGithub: (url: string) => Promise<{success: boolean; data?: CatalogSnapshot; error?: string}>;
  previewRoute: (text: string, selection?: RouteSelection) => Promise<{success: boolean; data?: ResolvedRoute; error?: string}>;
  resetRoute: (id: string) => Promise<{success: boolean; data?: AgentSnapshot; error?: string}>;
  open: (id: string) => Promise<{success: boolean; data?: AgentSnapshot; error?: string}>;
  snapshot: (id: string) => Promise<{success: boolean; data?: AgentSnapshot; error?: string}>;
  setMode: (id: string, mode: AgentMode) => Promise<{success: boolean; data?: AgentSnapshot; error?: string}>;
  setAccess: (id: string, level: AccessLevel) => Promise<{success: boolean; data?: AgentSnapshot; error?: string}>;
  configure: (id: string, capabilities: Partial<Record<Capability, boolean>>, allowedPaths: string[]) => Promise<{success: boolean; data?: AgentSnapshot; error?: string}>;
  run: (id: string, objective: string, attachments: string[], selection?: RouteSelection, runId?: string) => Promise<{success: boolean; data?: {message: string; snapshot: AgentSnapshot}; error?: string}>;
  stop: (id: string) => Promise<{success: boolean; error?: string}>;
  approve: (id: string, requestId: string, decision: 'once' | 'session' | 'deny') => Promise<{success: boolean; error?: string}>;
  installSkill: (id: string) => Promise<{success: boolean; data?: AgentSnapshot; error?: string}>;
  buildSkill: (id: string, name: string, description: string, instructions: string) => Promise<{success: boolean; data?: AgentSnapshot; error?: string}>;
  removeSkill: (id: string, skillId: string) => Promise<{success: boolean; data?: AgentSnapshot; error?: string}>;
  execute: (id: string, request: ToolRequest) => Promise<{success: boolean; data?: unknown; error?: string}>;
}
