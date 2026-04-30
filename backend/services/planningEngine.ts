import { EventEmitter } from 'events';
import { AgentConfig } from '../types/index.js';
import log from 'electron-log';

export interface ExecutionPlan {
  id: string;
  goal: string;
  steps: Task[];
  allowRetry: boolean;
  maxRetries: number;
  timeout: number;
  dependencies: string[];
  createdAt: number;
}

export interface Task {
  id: string;
  type: 'read' | 'write' | 'edit' | 'execute' | 'analyze' | 'search' | 'diagnose' | 'create' | 'delete';
  title: string;
  description: string;
  file?: string;
  content?: string;
  edits?: FileEdit[];
  command?: string;
  cwd?: string;
  timeout?: number;
  pattern?: string;
  path?: string;
  code?: string;
  error?: string;
  context?: any;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  dependencies: string[];
  result?: any;
}

export interface FileEdit {
  type: 'replace' | 'insert' | 'delete';
  startLine?: number;
  endLine?: number;
  content?: string;
  afterLine?: number;
  beforeLine?: number;
}

export interface Context {
  type: 'request' | 'repository' | 'file' | 'memory' | 'summary';
  content: any;
  analysis?: any;
  metadata?: any;
  timestamp: number;
}

export class PlanningEngine extends EventEmitter {
  private config: AgentConfig;
  private models = new Map<string, any>();

  constructor(config: AgentConfig) {
    super();
    this.config = config;
  }

  async generatePlan(request: string, context: Context[]): Promise<ExecutionPlan> {
    log.info('Generating execution plan for:', request);

    const prompt = this.buildPlanPrompt(request, context);
    
    let plan: ExecutionPlan;
    
    try {
      plan = await this.callModel(prompt);
    } catch (error) {
      log.error('Failed to generate plan with AI, using fallback:', error);
      plan = this.generateFallbackPlan(request, context);
    }

    plan.id = `plan_${Date.now()}`;
    plan.createdAt = Date.now();
    
    this.validatePlan(plan);
    this.emit('plan:generated', plan);
    
    return plan;
  }

  private buildPlanPrompt(request: string, context: Context[]): string {
    const contextSummary = this.summarizeContext(context);
    
    return `You are an expert coding agent planner. Generate a detailed execution plan.

User Request:
${request}

Repository Context:
${contextSummary}

Generate a JSON execution plan with this exact structure:
{
  "goal": "Brief description of the goal",
  "allowRetry": true,
  "maxRetries": 3,
  "timeout": 300000,
  "dependencies": [],
  "steps": [
    {
      "id": "step_1",
      "type": "read|write|edit|execute|analyze|search|diagnose|create|delete",
      "title": "Step title",
      "description": "What this step does",
      "file": "optional file path",
      "command": "optional command",
      "content": "optional file content",
      "edits": [{"type": "replace", "startLine": 1, "endLine": 10, "content": "..."}],
      "dependencies": [],
      "status": "pending"
    }
  ]
}

For file edits, use line numbers. For commands, specify cwd and timeout.
Respond with ONLY valid JSON, no explanation.`;
  }

  private summarizeContext(context: Context[]): string {
    return context.slice(0, 10).map(c => {
      switch (c.type) {
        case 'request':
          return `Request: ${c.content}`;
        case 'repository':
          return `Repo: ${c.content.files?.length || 0} files, ${c.content.structure?.substring(0, 200)}`;
        case 'file':
          return `File: ${c.metadata?.path} (${c.content?.length || 0} chars)`;
        default:
          return `Context: ${JSON.stringify(c.content).substring(0, 100)}`;
      }
    }).join('\n');
  }

  private async callModel(prompt: string): Promise<ExecutionPlan> {
    const { AIService } = await import('./aiService.js');
    
    const response = await AIService.chat([
      { role: 'system', content: 'You are an expert coding agent planner.' },
      { role: 'user', content: prompt },
    ]);

    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Could not parse plan JSON');
    }

    const plan = JSON.parse(jsonMatch[0]);
    
    if (!plan.steps || !Array.isArray(plan.steps)) {
      throw new Error('Invalid plan structure');
    }

    return plan;
  }

  private generateFallbackPlan(request: string, context: Context[]): ExecutionPlan {
    const requestLower = request.toLowerCase();
    const steps: Task[] = [];

    if (requestLower.includes('create') || requestLower.includes('add')) {
      steps.push({
        id: 'step_analyze',
        type: 'analyze',
        title: 'Analyze requirements',
        description: 'Analyze what needs to be created',
        status: 'pending',
        dependencies: [],
      });
      
      steps.push({
        id: 'step_create',
        type: 'create',
        title: 'Create file/component',
        description: 'Create the requested file or component',
        file: this.extractFilePath(request),
        content: '',
        status: 'pending',
        dependencies: ['step_analyze'],
      });
    } else if (requestLower.includes('fix') || requestLower.includes('bug')) {
      steps.push({
        id: 'step_diagnose',
        type: 'diagnose',
        title: 'Diagnose the issue',
        description: 'Find and understand the bug',
        status: 'pending',
        dependencies: [],
      });
      
      steps.push({
        id: 'step_fix',
        type: 'edit',
        title: 'Fix the issue',
        description: 'Apply the fix',
        status: 'pending',
        dependencies: ['step_diagnose'],
      });
    } else if (requestLower.includes('explain')) {
      steps.push({
        id: 'step_explain',
        type: 'read',
        title: 'Read relevant files',
        description: 'Read the files to explain',
        status: 'pending',
        dependencies: [],
      });
      
      steps.push({
        id: 'step_analyze',
        type: 'analyze',
        title: 'Analyze code',
        description: 'Analyze the code for explanation',
        status: 'pending',
        dependencies: ['step_explain'],
      });
    } else {
      steps.push({
        id: 'step_search',
        type: 'search',
        title: 'Search relevant code',
        description: 'Find relevant files',
        status: 'pending',
        dependencies: [],
      });
      
      steps.push({
        id: 'step_analyze',
        type: 'analyze',
        title: 'Analyze and modify',
        description: 'Analyze and make changes',
        status: 'pending',
        dependencies: ['step_search'],
      });
    }

    return {
      id: `plan_${Date.now()}`,
      goal: request,
      steps,
      allowRetry: true,
      maxRetries: 3,
      timeout: 300000,
      dependencies: [],
      createdAt: Date.now(),
    };
  }

  private extractFilePath(request: string): string {
    const match = request.match(/['"`]?([^:'"`\s]+\.[a-z]+)['"`]?/);
    return match ? match[1] : 'src/new-file.ts';
  }

  private validatePlan(plan: ExecutionPlan): void {
    if (!plan.steps || plan.steps.length === 0) {
      throw new Error('Plan has no steps');
    }

    const stepIds = new Set<string>();
    for (const step of plan.steps) {
      if (!step.id) {
        step.id = `step_${stepIds.size + 1}`;
      }
      if (stepIds.has(step.id)) {
        throw new Error(`Duplicate step ID: ${step.id}`);
      }
      stepIds.add(step.id);
      
      for (const dep of step.dependencies || []) {
        if (!stepIds.has(dep)) {
          log.warn(`Step ${step.id} has unmet dependency: ${dep}`);
        }
      }
    }
  }

  parseEditInstructions(instructions: string): FileEdit[] {
    const edits: FileEdit[] = [];
    
    const replaceRegex = /replace\s+lines?\s+(\d+)-(\d+)\s+with\s+([\s\S]*?)(?=\n\n|$)/gi;
    let match;
    
    while ((match = replaceRegex.exec(instructions)) !== null) {
      edits.push({
        type: 'replace',
        startLine: parseInt(match[1]),
        endLine: parseInt(match[2]),
        content: match[3].trim(),
      });
    }

    return edits;
  }
}

export default PlanningEngine;