import type { AgentDefinition, CatalogSnapshot, ResolvedRoute, RouteSelection, SkillDefinition } from './contracts.js';

export class RouterError extends Error {
  constructor(public code: string, message: string, public candidateAgentIds: string[] = []) { super(message); this.name = 'RouterError'; }
}

function tokens(text: string): string[] { return text.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}_-]+/gu) ?? []; }
function plainText(text: string): string {
  return text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, ' ')
    .replace(/`[^`\n]*(?:`|$)/g, ' ').replace(/\S+@\S+/g, ' ');
}
function matches(text: string[], phrase: string): boolean {
  const wanted = tokens(phrase);
  return wanted.length > 0 && text.some((_word, index) => wanted.every((word, offset) => text[index + offset] === word));
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}

export function resolveInput(text: string, catalog: CatalogSnapshot, selection?: RouteSelection): ResolvedRoute {
  if (typeof text !== 'string' || !text.trim() || text.length > 50000) throw new RouterError('invalid-text', 'Enter a task of at most 50,000 characters.');
  if (selection && selection.catalogRevision !== catalog.revision) throw new RouterError('stale-catalog', 'Definitions changed. Refresh the route before sending.');
  const definitions = [...catalog.agents, ...catalog.skills];
  let executionText = text.trim(); let agent: AgentDefinition | undefined;
  const explicitSkills: string[] = []; const handles = new Set<string>();
  let hasMentions = false;
  while (executionText.startsWith('@')) {
    const token = executionText.match(/^\S+/)?.[0] ?? '';
    // Emails and code/body mentions are ordinary task data, never partial handles.
    if (!/^@[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(token)) break;
    const handle = token.slice(1).toLowerCase();
    if (handles.has(handle)) throw new RouterError('duplicate-handle', `@${handle} was selected more than once.`);
    handles.add(handle); hasMentions = true;
    const definition = definitions.find(item => item.handle === handle);
    if (!definition) throw new RouterError('unknown-handle', `Unknown handle @${handle}.`);
    if (!definition.enabled) throw new RouterError('disabled-handle', `@${handle} is disabled. Enable it or remove the mention.`);
    const namedAgent = catalog.agents.find(item => item.id === definition.id);
    if (namedAgent) {
      if (agent) throw new RouterError('multiple-agents', 'Select one leading agent handle.', [agent.id, namedAgent.id]);
      agent = namedAgent;
    } else explicitSkills.push(definition.id);
    executionText = executionText.slice(token.length).trimStart();
  }
  if (hasMentions && !executionText.trim()) throw new RouterError('empty-task', 'Add a task after the selected handles.');
  const enabledAgent = (id: string) => {
    const found = catalog.agents.find(item => item.id === id);
    if (!found?.enabled) throw new RouterError('invalid-selection', 'The selected agent is missing or disabled.');
    return found;
  };
  if (selection?.agentId !== undefined) {
    const picked = selection.agentId === null ? undefined : enabledAgent(selection.agentId);
    if (hasMentions && agent?.id !== picked?.id) throw new RouterError('selection-conflict', 'The selected agent conflicts with the leading handle.');
    agent = picked;
  }
  if (selection?.skillIds !== undefined) {
    if (!Array.isArray(selection.skillIds) || selection.skillIds.length > 5 || new Set(selection.skillIds).size !== selection.skillIds.length) throw new RouterError('invalid-selection', 'Select each skill once.');
    if (hasMentions && (selection.skillIds.length !== explicitSkills.length || selection.skillIds.some(id => !explicitSkills.includes(id)))) {
      throw new RouterError('selection-conflict', 'Selected skills conflict with the leading handles.');
    }
    if (!hasMentions) explicitSkills.push(...selection.skillIds);
  }
  const automatic = !hasMentions && !selection;
  const taskTokens = tokens(plainText(text)); const matchedKeywords: string[] = [];
  if (automatic) {
    const candidates = catalog.agents.filter(item => item.enabled).map(item => {
      const phrases = item.keywords.filter(phrase => matches(taskTokens, phrase));
      return {item, phrases, score: Math.max(0, ...phrases.map(phrase => tokens(phrase).length))};
    }).filter(item => item.score > 0);
    const score = Math.max(0, ...candidates.map(item => item.score));
    const best = candidates.filter(item => item.score === score);
    if (best.length > 1) throw new RouterError('ambiguous-agent', 'Several agents match equally. Choose an agent before sending.', best.map(item => item.item.id));
    if (best[0]) {agent = best[0].item; matchedKeywords.push(...best[0].phrases);}
  }
  const skillIds = [...explicitSkills, ...(agent?.skillIds ?? [])];
  if (automatic) for (const skill of catalog.skills.filter(item => item.enabled)) {
    const phrases = skill.keywords.filter(phrase => matches(taskTokens, phrase));
    if (phrases.length) {skillIds.push(skill.id); matchedKeywords.push(...phrases);}
  }
  const unique = [...new Set(skillIds)];
  if (unique.length > 5) throw new RouterError('too-many-skills', 'A route can use at most five skills. Narrow the selection or trigger phrases.');
  const skills: SkillDefinition[] = unique.map(id => {
    const skill = catalog.skills.find(item => item.id === id);
    if (!skill?.enabled) throw new RouterError('invalid-skill', 'A selected or attached skill is missing or disabled.');
    return skill;
  });
  const injected = [agent?.instructions ?? '', ...skills.map(skill => `${skill.name}\n${skill.description}\n${skill.instructions}\n${skill.definitionOfDone.join('\n')}`)].join('\n');
  if (Buffer.byteLength(injected) > 24 * 1024) throw new RouterError('route-too-large', 'Selected instructions exceed the 24 KiB route limit. Shorten the definitions or select fewer skills.');
  const selected = [...(agent ? [agent] : []), ...skills];
  const allowedAgentIds = [...new Set(selected.flatMap(item => item.callableAgentIds))].filter(id => catalog.agents.some(item => item.id === id && item.enabled));
  const allowedSkillIds = [...new Set(selected.flatMap(item => item.callableSkillIds))].filter(id => catalog.skills.some(item => item.id === id && item.enabled));
  const source = hasMentions || selection ? 'explicit' : agent || skills.length ? 'keyword' : 'default';
  const route: ResolvedRoute = {source, catalogRevision: catalog.revision, originalText: text, executionText,
    ...(agent ? {agent} : {}), skills, matchedKeywords: [...new Set(matchedKeywords)],
    reason: source === 'default' ? 'No enabled trigger matched; using Default.' : source === 'explicit' ? 'Using your explicit selection.' : 'Matched enabled trigger phrases.',
    allowedAgentIds, allowedSkillIds};
  return freeze(JSON.parse(JSON.stringify(route)) as ResolvedRoute);
}

export const resolveRoute = resolveInput;
