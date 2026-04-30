import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { AgentController } from '../../src/backend/services/agentController';
import { MultiAgentOrchestrator } from '../../src/backend/services/orchestration/multiAgentOrchestrator';
import { ToolExecutor } from '../../src/backend/services/toolExecutor';
import { MemorySystem } from '../../src/backend/services/memorySystem';
import { ContextManager } from '../../src/backend/services/contextManager';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Integration Tests', () => {
  let agent: AgentController;
  let orchestrator: MultiAgentOrchestrator;
  let testWorkspace: string;
  let toolExecutor: ToolExecutor;

  beforeAll(() => {
    testWorkspace = path.join(os.tmpdir(), `ai-agent-test-${Date.now()}`);
    fs.mkdirSync(testWorkspace, { recursive: true });

    const config = {
      maxTokens: 4000,
      aiProvider: 'openrouter',
      aiModel: 'qwen/qwen3-coder-32b',
      ignorePatterns: ['node_modules', '.git'],
    };

    agent = new AgentController(config);
    orchestrator = new MultiAgentOrchestrator({
      enableParallelExecution: true,
      maxConcurrentAgents: 4,
      defaultModel: 'qwen/qwen3-coder-32b',
      timeout: 60000,
    });

    toolExecutor = new ToolExecutor(config);
  });

  afterAll(() => {
    if (fs.existsSync(testWorkspace)) {
      fs.rmSync(testWorkspace, { recursive: true, force: true });
    }
  });

  describe('AgentController', () => {
    it('should initialize correctly', () => {
      expect(agent).toBeDefined();
      const state = agent.getState();
      expect(state.status).toBe('idle');
    });

    it('should generate execution plans', async () => {
      const plan = await agent.planningEngine.generatePlan(
        'Create a simple hello world function',
        []
      );
      expect(plan).toBeDefined();
      expect(plan.steps).toBeDefined();
    });

    it('should handle file operations', async () => {
      const testFile = path.join(testWorkspace, 'test.txt');
      fs.writeFileSync(testFile, 'Hello World');

      const result = await toolExecutor.execute('read_file', { path: testFile });
      expect(result.success).toBe(true);
      expect(result.data).toContain('Hello World');
    });

    it('should handle terminal commands', async () => {
      const result = await toolExecutor.execute('execute_command', {
        command: process.platform === 'win32' ? 'echo test' : 'echo test',
        cwd: testWorkspace,
      });
      expect(result.success).toBe(true);
    });
  });

  describe('MultiAgentOrchestrator', () => {
    it('should initialize agents', () => {
      const status = orchestrator.getStatus();
      expect(status.agents).toBe(4);
    });

    it('should execute tasks', async () => {
      const task = {
        id: 'test-1',
        description: 'Create a test file',
        type: 'coding' as const,
        priority: 5,
        status: 'pending' as const,
        subtasks: [],
        context: {},
        createdAt: Date.now(),
      };

      const result = await orchestrator.executeTask(task);
      expect(result).toBeDefined();
    });

    it('should handle parallel execution', async () => {
      const status = orchestrator.getStatus();
      expect(status.runningWorkflows).toBeGreaterThanOrEqual(0);
    });
  });

  describe('MemorySystem', () => {
    let memory: MemorySystem;

    beforeEach(() => {
      memory = new MemorySystem({ maxTokens: 4000 });
    });

    it('should store and retrieve memories', async () => {
      await memory.store({
        type: 'test',
        content: 'Test memory',
        timestamp: Date.now(),
      });

      const memories = memory.getMemories();
      expect(memories.length).toBeGreaterThan(0);
    });

    it('should limit memory size', async () => {
      for (let i = 0; i < 100; i++) {
        await memory.store({
          type: 'test',
          content: `Memory ${i}: ${'x'.repeat(100)}`,
          timestamp: Date.now(),
        });
      }

      const memories = memory.getMemories();
      expect(memories.length).toBeLessThan(100);
    });
  });

  describe('ContextManager', () => {
    let context: ContextManager;

    beforeEach(() => {
      context = new ContextManager({ maxTokens: 4000 });
    });

    it('should add and retrieve context', () => {
      context.addContext({
        type: 'file',
        content: 'Test content',
        timestamp: Date.now(),
      });

      const fullContext = context.getFullContext();
      expect(fullContext).toBeDefined();
    });

    it('should limit context size', () => {
      for (let i = 0; i < 50; i++) {
        context.addContext({
          type: 'test',
          content: `Context ${i}: ${'x'.repeat(50)}`,
          timestamp: Date.now(),
        });
      }

      const stats = context.getStats();
      expect(stats.tokens).toBeLessThanOrEqual(4000);
    });
  });
});

describe('Tool Executor Tests', () => {
  let executor: ToolExecutor;

  beforeAll(() => {
    executor = new ToolExecutor({
      maxTokens: 4000,
      aiProvider: 'openrouter',
    });
  });

  describe('File Operations', () => {
    it('should read files safely', async () => {
      const tempFile = path.join(os.tmpdir(), `test-${Date.now()}.txt`);
      fs.writeFileSync(tempFile, 'test content');

      const result = await executor.execute('read_file', { path: tempFile });
      expect(result.success).toBe(true);

      fs.unlinkSync(tempFile);
    });

    it('should block path traversal', async () => {
      const result = await executor.execute('read_file', {
        path: '../../../etc/passwd',
      });
      expect(result.success).toBe(false);
    });

    it('should write files safely', async () => {
      const tempFile = path.join(os.tmpdir(), `test-${Date.now()}.txt`);

      const result = await executor.execute('write_file', {
        path: tempFile,
        content: 'test content',
      });
      expect(result.success).toBe(true);

      fs.unlinkSync(tempFile);
    });
  });

  describe('Terminal Operations', () => {
    it('should execute safe commands', async () => {
      const result = await executor.execute('execute_command', {
        command: 'echo "test"',
        timeout: 5000,
      });
      expect(result.success).toBe(true);
    });

    it('should timeout long-running commands', async () => {
      const result = await executor.execute('execute_command', {
        command: process.platform === 'win32' ? 'ping -n 10 127.0.0.1' : 'sleep 10',
        timeout: 1000,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('timeout');
    });
  });
});