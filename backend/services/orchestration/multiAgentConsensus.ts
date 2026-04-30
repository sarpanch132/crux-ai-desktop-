import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import log from 'electron-log';

export type AgentRole = 'planner' | 'coder' | 'debugger' | 'reviewer' | 'security' | 'qa' | 'architecture' | 'deployment' | 'verifier';

export interface AgentCapability {
  name: string;
  strength: number;
  domain: string[];
}

export interface AgentResponse {
  agentId: string;
  role: AgentRole;
  content: string;
  confidence: number;
  reasoning: string[];
  evidence: string[];
  timestamp: number;
  duration: number;
}

export interface ConsensusConfig {
  minAgents: number;
  votingThreshold: number;
  confidenceThreshold: number;
  maxRounds: number;
  enableVerification: boolean;
  verificationRounds: number;
}

export interface ConsensusResult {
  consensus: boolean;
  agreedContent: string;
  confidence: number;
  votes: number;
  disagreement?: string;
  responses: AgentResponse[];
  verification?: VerificationResult;
}

export interface VerificationResult {
  passed: boolean;
  issues: VerificationIssue[];
  score: number;
}

export interface VerificationIssue {
  type: 'security' | 'correctness' | 'performance' | 'style' | 'safety';
  severity: 'critical' | 'high' | 'medium' | 'low';
  description: string;
  suggestion?: string;
}

export interface ConsensusTask {
  id: string;
  description: string;
  requiredRoles: AgentRole[];
  context: string;
  input?: any;
}

class Agent extends EventEmitter {
  readonly id: string;
  readonly role: AgentRole;
  readonly name: string;
  readonly capabilities: AgentCapability[];
  
  private status: 'idle' | 'thinking' | 'responding' | 'error' = 'idle';
  private currentTask: ConsensusTask | null = null;
  private executor: ((task: ConsensusTask) => Promise<AgentResponse>) | null = null;

  constructor(
    id: string,
    role: AgentRole,
    name: string,
    capabilities: AgentCapability[]
  ) {
    super();
    this.id = id;
    this.role = role;
    this.name = name;
    this.capabilities = capabilities;
  }

  setExecutor(fn: (task: ConsensusTask) => Promise<AgentResponse>): void {
    this.executor = fn;
  }

  async execute(task: ConsensusTask): Promise<AgentResponse> {
    this.currentTask = task;
    this.status = 'thinking';
    this.emit('agent:thinking', { agent: this, task });

    const startTime = Date.now();

    try {
      this.status = 'responding';
      
      let response: AgentResponse;
      
      if (this.executor) {
        response = await this.executor(task);
      } else {
        response = await this.defaultExecute(task);
      }

      response.duration = Date.now() - startTime;
      this.status = 'idle';
      this.emit('agent:completed', { agent: this, response });

      return response;
    } catch (error) {
      this.status = 'error';
      this.emit('agent:error', { agent: this, error });

      return {
        agentId: this.id,
        role: this.role,
        content: '',
        confidence: 0,
        reasoning: [],
        evidence: [],
        timestamp: Date.now(),
        duration: Date.now() - startTime,
      };
    }
  }

  private async defaultExecute(task: ConsensusTask): Promise<AgentResponse> {
    await new Promise(resolve => setTimeout(resolve, 100));

    return {
      agentId: this.id,
      role: this.role,
      content: `[${this.role}] Processed: ${task.description}`,
      confidence: 0.8,
      reasoning: [`Analyzed task for ${this.role} domain`],
      evidence: ['Task analysis complete'],
      timestamp: Date.now(),
      duration: 0,
    };
  }

  getStatus(): string {
    return this.status;
  }

  getStrengthFor(task: string): number {
    for (const cap of this.capabilities) {
      if (cap.domain.some(d => task.toLowerCase().includes(d))) {
        return cap.strength;
      }
    }
    return 0.5;
  }
}

export class MultiAgentConsensus extends EventEmitter {
  private agents: Map<string, Agent> = new Map();
  private config: ConsensusConfig;
  private sharedMemory: Map<string, any> = new Map();
  private messageBus: EventEmitter = new EventEmitter();
  private taskHistory: Map<string, ConsensusResult[]> = new Map();

  constructor(config: Partial<ConsensusConfig> = {}) {
    super();
    this.config = {
      minAgents: config.minAgents ?? 3,
      votingThreshold: config.votingThreshold ?? 0.6,
      confidenceThreshold: config.confidenceThreshold ?? 0.7,
      maxRounds: config.maxRounds ?? 3,
      enableVerification: config.enableVerification ?? true,
      verificationRounds: config.verificationRounds ?? 2,
    };

    this.initializeDefaultAgents();
  }

  private initializeDefaultAgents(): void {
    this.registerAgent(new Agent('planner-1', 'planner', 'Planner', [
      { name: 'planning', strength: 0.9, domain: ['plan', 'architecture', 'design'] },
      { name: 'reasoning', strength: 0.8, domain: ['analyze', 'strategy'] },
    ]));

    this.registerAgent(new Agent('coder-1', 'coder', 'Coder', [
      { name: 'coding', strength: 0.95, domain: ['code', 'implement', 'write'] },
      { name: 'refactoring', strength: 0.8, domain: ['refactor', 'improve'] },
    ]));

    this.registerAgent(new Agent('debugger-1', 'debugger', 'Debugger', [
      { name: 'debugging', strength: 0.9, domain: ['bug', 'fix', 'error', 'issue'] },
      { name: 'diagnosis', strength: 0.85, domain: ['debug', 'troubleshoot'] },
    ]));

    this.registerAgent(new Agent('reviewer-1', 'reviewer', 'Reviewer', [
      { name: 'review', strength: 0.9, domain: ['review', 'check', 'verify'] },
      { name: 'quality', strength: 0.85, domain: ['quality', 'best practice'] },
    ]));

    this.registerAgent(new Agent('security-1', 'security', 'Security', [
      { name: 'security', strength: 0.95, domain: ['security', 'vulnerability', 'safe'] },
      { name: 'audit', strength: 0.9, domain: ['audit', 'secure'] },
    ]));

    this.registerAgent(new Agent('qa-1', 'qa', 'QA', [
      { name: 'testing', strength: 0.9, domain: ['test', 'verify', 'validate'] },
      { name: 'quality', strength: 0.85, domain: ['quality', 'coverage'] },
    ]));

    this.registerAgent(new Agent('arch-1', 'architecture', 'Architect', [
      { name: 'architecture', strength: 0.95, domain: ['architecture', 'structure', 'system'] },
      { name: 'design', strength: 0.9, domain: ['design', 'pattern'] },
    ]));

    this.registerAgent(new Agent('deploy-1', 'deployment', 'Deployer', [
      { name: 'deployment', strength: 0.9, domain: ['deploy', 'deploy', 'release'] },
      { name: 'infrastructure', strength: 0.85, domain: ['infra', 'cloud', 'docker'] },
    ]));

    this.registerAgent(new Agent('verifier-1', 'verifier', 'Verifier', [
      { name: 'verification', strength: 0.95, domain: ['verify', 'validate', 'confirm'] },
      { name: 'validation', strength: 0.9, domain: ['check', 'ensure'] },
    ]));
  }

  registerAgent(agent: Agent): void {
    this.agents.set(agent.id, agent);
    log.info(`Agent registered: ${agent.name} (${agent.role})`);
  }

  unregisterAgent(agentId: string): boolean {
    return this.agents.delete(agentId);
  }

  getAgent(agentId: string): Agent | undefined {
    return this.agents.get(agentId);
  }

  getAgentsByRole(role: AgentRole): Agent[] {
    return Array.from(this.agents.values()).filter(a => a.role === role);
  }

  async achieveConsensus(task: ConsensusTask): Promise<ConsensusResult> {
    log.info(`Achieving consensus for task: ${task.id}`);

    const selectedAgents = this.selectAgents(task.requiredRoles);
    
    if (selectedAgents.length < this.config.minAgents) {
      return {
        consensus: false,
        agreedContent: '',
        confidence: 0,
        votes: 0,
        disagreement: 'Insufficient agents available',
        responses: [],
      };
    }

    this.emit('consensus:started', { task, agents: selectedAgents.map(a => a.id) });

    let round = 0;
    let responses: AgentResponse[] = [];
    let verification: VerificationResult | undefined;

    while (round < this.config.maxRounds) {
      round++;
      
      const roundPromises = selectedAgents.map(agent => 
        this.executeWithCommunication(agent, task, responses)
      );

      const roundResponses = await Promise.allSettled(roundPromises);
      
      const successfulResponses = roundResponses
        .filter((r): r is PromiseFulfilledResult<AgentResponse> => r.status === 'fulfilled')
        .map(r => r.value);

      responses = [...responses, ...successfulResponses];

      if (this.checkConsensus(responses)) {
        break;
      }

      this.emit('consensus:round', { round, responses: successfulResponses });
    }

    const finalResult = this.computeConsensus(responses);

    if (this.config.enableVerification && finalResult.consensus) {
      verification = await this.verify(finalResult.agreedContent, task);
      finalResult.verification = verification;
    }

    const history = this.taskHistory.get(task.id) || [];
    history.push(finalResult);
    this.taskHistory.set(task.id, history);

    this.emit('consensus:completed', { task, result: finalResult });

    return finalResult;
  }

  private selectAgents(requiredRoles: AgentRole[]): Agent[] {
    const selected: Agent[] = [];

    for (const role of requiredRoles) {
      const agents = this.getAgentsByRole(role);
      if (agents.length > 0) {
        agents.sort((a, b) => b.getStrengthFor(role) - a.getStrengthFor(role));
        selected.push(agents[0]);
      }
    }

    if (selected.length < this.config.minAgents) {
      const fallback = Array.from(this.agents.values())
        .filter(a => !selected.includes(a))
        .slice(0, this.config.minAgents - selected.length);
      selected.push(...fallback);
    }

    return selected;
  }

  private async executeWithCommunication(
    agent: Agent,
    task: ConsensusTask,
    priorResponses: AgentResponse[]
  ): Promise<AgentResponse> {
    const enrichedTask: ConsensusTask = {
      ...task,
      context: `${task.context}\n\nOther agents' perspectives:\n${priorResponses.map(r => 
        `[${r.role}]: ${r.content.slice(0, 200)}`
      ).join('\n')}`,
    };

    this.messageBus.emit('agent:message', {
      from: 'system',
      to: agent.id,
      content: task.description,
    });

    const response = await agent.execute(enrichedTask);

    this.broadcast(agent.id, response.content);

    return response;
  }

  private broadcast(fromAgentId: string, content: string): void {
    this.messageBus.emit('broadcast', { from: fromAgentId, content });
  }

  private checkConsensus(responses: AgentResponse[]): boolean {
    if (responses.length < this.config.minAgents) return false;

    const contents = responses.map(r => this.normalizeContent(r.content));
    const unique = new Set(contents);

    return unique.size === 1 || (contents.length - unique.size) / contents.length >= this.config.votingThreshold;
  }

  private normalizeContent(content: string): string {
    return content.replace(/\s+/g, ' ').toLowerCase().trim().slice(0, 100);
  }

  private computeConsensus(responses: AgentResponse[]): ConsensusResult {
    if (responses.length === 0) {
      return {
        consensus: false,
        agreedContent: '',
        confidence: 0,
        votes: 0,
        disagreement: 'No responses received',
        responses: [],
      };
    }

    const contentGroups = new Map<string, { response: AgentResponse; count: number }>();

    for (const response of responses) {
      const normalized = this.normalizeContent(response.content);
      const existing = contentGroups.get(normalized);
      
      if (existing) {
        existing.count++;
      } else {
        contentGroups.set(normalized, { response, count: 1 });
      }
    }

    let bestGroup = contentGroups.values().next().value;
    let bestCount = 0;

    for (const group of contentGroups.values()) {
      if (group.count > bestCount) {
        bestGroup = group;
        bestCount = group.count;
      }
    }

    const agreement = bestCount / responses.length;
    const avgConfidence = responses.reduce((sum, r) => sum + r.confidence, 0) / responses.length;

    return {
      consensus: agreement >= this.config.votingThreshold && avgConfidence >= this.config.confidenceThreshold,
      agreedContent: bestGroup?.response.content || '',
      confidence: avgConfidence,
      votes: bestCount,
      disagreement: agreement < this.config.votingThreshold ? 'Agents disagree' : undefined,
      responses,
    };
  }

  private async verify(content: string, task: ConsensusTask): Promise<VerificationResult> {
    const verifier = this.getAgentsByRole('verifier')[0];
    
    if (!verifier) {
      return { passed: true, issues: [], score: 1 };
    }

    const verificationTask: ConsensusTask = {
      id: `verify-${task.id}`,
      description: `Verify: ${content.slice(0, 100)}...`,
      requiredRoles: ['verifier', 'security', 'qa'],
      context: `Verify the following implementation for correctness, security, and quality:\n\n${content}`,
    };

    const result = await this.achieveConsensus(verificationTask);

    const issues: VerificationIssue[] = result.responses.map(r => ({
      type: 'correctness' as const,
      severity: r.confidence < 0.5 ? 'high' as const : 'medium' as const,
      description: r.content.slice(0, 100),
    }));

    return {
      passed: result.consensus && result.confidence >= this.config.confidenceThreshold,
      issues,
      score: result.confidence,
    };
  }

  getSharedMemory(key: string): any {
    return this.sharedMemory.get(key);
  }

  setSharedMemory(key: string, value: any): void {
    this.sharedMemory.set(key, value);
    this.messageBus.emit('memory:updated', { key, value });
  }

  clearSharedMemory(): void {
    this.sharedMemory.clear();
  }

  getAgentStates(): Record<string, { role: AgentRole; status: string }> {
    const states: Record<string, { role: AgentRole; status: string }> = {};
    
    for (const [id, agent] of this.agents) {
      states[id] = {
        role: agent.role,
        status: agent.getStatus(),
      };
    }

    return states;
  }

  getHistory(taskId: string): ConsensusResult[] {
    return this.taskHistory.get(taskId) || [];
  }
}

export const consensusEngine = new MultiAgentConsensus();
export default MultiAgentConsensus;