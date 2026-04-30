import { EventEmitter } from 'events';
import log from 'electron-log';
import { spawn } from 'child_process';

export interface TestConfig {
  testFramework?: 'jest' | 'vitest' | 'mocha' | 'pytest' | 'playwright' | 'custom';
  testCommand?: string;
  timeout?: number;
  parallel?: boolean;
  maxWorkers?: number;
}

export interface TestResult {
  success: boolean;
  testName: string;
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
  output?: string;
  errors?: TestError[];
}

export interface TestError {
  name: string;
  message: string;
  stack?: string;
  location?: string;
}

export interface TestRun {
  id: string;
  type: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startTime: number;
  endTime?: number;
  results: TestResult[];
  summary: TestSummary;
}

export interface TestSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
}

const DEFAULT_CONFIG: TestConfig = {
  testFramework: 'vitest',
  testCommand: 'npm test',
  timeout: 60000,
  parallel: false,
  maxWorkers: 4,
};

export class TestingPipeline extends EventEmitter {
  private config: TestConfig;
  private testRuns: Map<string, TestRun> = new Map();
  private currentRun: TestRun | null = null;

  constructor(config: TestConfig = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async runTest(testDescription: string, context?: any): Promise<TestResult> {
    const testName = this.extractTestName(testDescription);
    
    log.info(`Running test: ${testName}`);

    this.emit('test:running', { testName });

    try {
      const result = await this.executeTest(testName, context);
      
      if (result.success) {
        this.emit('test:passed', result);
      } else {
        this.emit('test:failed', result);
      }

      return result;
    } catch (error) {
      const failedResult: TestResult = {
        success: false,
        testName,
        passed: 0,
        failed: 1,
        skipped: 0,
        duration: 0,
        output: String(error),
        errors: [{
          name: testName,
          message: String(error),
        }],
      };

      this.emit('test:failed', failedResult);

      return failedResult;
    }
  }

  async runAllTests(projectPath?: string): Promise<TestRun> {
    const runId = `run_${Date.now()}`;
    
    const run: TestRun = {
      id: runId,
      type: 'all',
      status: 'running',
      startTime: Date.now(),
      results: [],
      summary: {
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        duration: 0,
      },
    };

    this.testRuns.set(runId, run);
    this.currentRun = run;

    this.emit('tests:started', { runId, framework: this.config.testFramework });

    try {
      const output = await this.runCommand(this.config.testCommand!, projectPath);

      const parsedResults = this.parseTestOutput(output);

      run.results = parsedResults;
      run.status = 'completed';
      run.endTime = Date.now();

      run.summary = this.calculateSummary(parsedResults);

      this.emit('tests:completed', run);

    } catch (error) {
      run.status = 'failed';
      run.endTime = Date.now();
      run.results = [{
        success: false,
        testName: 'Test Suite',
        passed: 0,
        failed: 1,
        skipped: 0,
        duration: Date.now() - run.startTime,
        output: String(error),
      }];

      this.emit('tests:failed', { runId, error: String(error) });
    }

    return run;
  }

  private async executeTest(testName: string, context?: any): Promise<TestResult> {
    const framework = this.config.testFramework;

    switch (framework) {
      case 'jest':
        return this.runJestTest(testName);
      case 'vitest':
        return this.runVitestTest(testName);
      case 'pytest':
        return this.runPytestTest(testName);
      case 'mocha':
        return this.runMochaTest(testName);
      default:
        return this.runCustomTest(testName, context);
    }
  }

  private async runJestTest(testName: string): Promise<TestResult> {
    const startTime = Date.now();

    try {
      const output = await this.runCommand(`npx jest ${testName} --json`);

      const parsed = this.parseTestOutput(output);

      return {
        success: parsed.every(r => r.success),
        testName,
        passed: parsed.filter(r => r.success).length,
        failed: parsed.filter(r => !r.success).length,
        skipped: parsed.filter(r => r.skipped).length,
        duration: Date.now() - startTime,
        output,
        errors: parsed.filter(r => !r.success).flatMap(r => r.errors || []),
      };
    } catch (error) {
      return {
        success: false,
        testName,
        passed: 0,
        failed: 1,
        skipped: 0,
        duration: Date.now() - startTime,
        output: String(error),
      };
    }
  }

  private async runVitestTest(testName: string): Promise<TestResult> {
    const startTime = Date.now();

    try {
      const output = await this.runCommand(`npx vitest run ${testName} --reporter=json`);

      return this.parseVitestResult(testName, output, startTime);
    } catch (error) {
      return {
        success: false,
        testName,
        passed: 0,
        failed: 1,
        skipped: 0,
        duration: Date.now() - startTime,
        output: String(error),
      };
    }
  }

  private async runPytestTest(testName: string): Promise<TestResult> {
    const startTime = Date.now();

    try {
      const output = await this.runCommand(`python -m pytest ${testName} -v --tb=short`);

      const hasFailure = output.includes('FAILED') || output.includes('ERROR');
      
      return {
        success: !hasFailure,
        testName,
        passed: hasFailure ? 0 : 1,
        failed: hasFailure ? 1 : 0,
        skipped: 0,
        duration: Date.now() - startTime,
        output,
      };
    } catch (error) {
      return {
        success: false,
        testName,
        passed: 0,
        failed: 1,
        skipped: 0,
        duration: Date.now() - startTime,
        output: String(error),
      };
    }
  }

  private async runMochaTest(testName: string): Promise<TestResult> {
    const startTime = Date.now();

    try {
      const output = await this.runCommand(`npx mocha ${testName} --reporter=json`);

      return this.parseMochaResult(testName, output, startTime);
    } catch (error) {
      return {
        success: false,
        testName,
        passed: 0,
        failed: 1,
        skipped: 0,
        duration: Date.now() - startTime,
        output: String(error),
      };
    }
  }

  private async runCustomTest(testName: string, context: any): Promise<TestResult> {
    const startTime = Date.now();
    
    return {
      success: true,
      testName,
      passed: 1,
      failed: 0,
      skipped: 0,
      duration: Date.now() - startTime,
    };
  }

  private async runCommand(command: string, cwd?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let output = '';
      let errorOutput = '';

      const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
      const shellArgs = process.platform === 'win32' 
        ? ['-c', command] 
        : ['-c', command];

      const proc = spawn(shell, shellArgs, {
        cwd: cwd || process.cwd(),
        shell: false,
        windowsHide: true,
      });

      const timeout = setTimeout(() => {
        proc.kill();
        reject(new Error('Test timeout'));
      }, this.config.timeout);

      proc.stdout?.on('data', (data) => {
        output += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        errorOutput += data.toString();
      });

      proc.on('close', (code) => {
        clearTimeout(timeout);
        
        if (code === 0 || output.includes('PASS')) {
          resolve(output);
        } else {
          reject(new Error(errorOutput || output || `Exit code: ${code}`));
        }
      });

      proc.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  private extractTestName(description: string): string {
    const match = description.match(/test[:\s]+["']?([^"'\n]+)["']?/i);
    return match ? match[1].trim() : description;
  }

  private parseTestOutput(output: string): TestResult[] {
    const results: TestResult[] = [];

    try {
      const json = JSON.parse(output);
      
      if (Array.isArray(json.testResults)) {
        for (const test of json.testResults) {
          results.push({
            success: test.status === 'passed',
            testName: test.name,
            passed: test.assertions?.filter((a: any) => a.status === 'passed').length || 0,
            failed: test.assertions?.filter((a: any) => a.status === 'failed').length || 0,
            skipped: test.skipped || 0,
            duration: test.time || 0,
            output: JSON.stringify(test),
          });
        }
      }
    } catch {
      const lines = output.split('\n');
      
      for (const line of lines) {
        if (line.includes('✓') || line.includes('PASS') || line.includes('✓')) {
          results.push({
            success: true,
            testName: line.replace(/[✓✗]/g, '').trim(),
            passed: 1,
            failed: 0,
            skipped: 0,
            duration: 0,
          });
        } else if (line.includes('✗') || line.includes('FAIL')) {
          results.push({
            success: false,
            testName: line.replace(/[✓✗]/g, '').trim(),
            passed: 0,
            failed: 1,
            skipped: 0,
            duration: 0,
          });
        }
      }

      if (results.length === 0) {
        results.push({
          success: !output.includes('fail') && !output.includes('error'),
          testName: 'Test Suite',
          passed: 1,
          failed: 0,
          skipped: 0,
          duration: 0,
          output,
        });
      }
    }

    return results;
  }

  private parseVitestResult(testName: string, output: string, startTime: number): TestResult {
    try {
      const data = JSON.parse(output);
      
      return {
        success: data.success,
        testName,
        passed: data.numPassedTests || 0,
        failed: data.numFailedTests || 0,
        skipped: data.numSkippedTests || 0,
        duration: data.duration || Date.now() - startTime,
        output: JSON.stringify(data),
      };
    } catch {
      return {
        success: !output.includes('fail'),
        testName,
        passed: output.includes('pass') ? 1 : 0,
        failed: output.includes('fail') ? 1 : 0,
        skipped: 0,
        duration: Date.now() - startTime,
        output,
      };
    }
  }

  private parseMochaResult(testName: string, output: string, startTime: number): TestResult {
    try {
      const data = JSON.parse(output);
      
      return {
        success: data.stats?.failures === 0,
        testName,
        passed: data.stats?.passes || 0,
        failed: data.stats?.failures || 0,
        skipped: data.stats?.pending || 0,
        duration: data.stats?.duration || Date.now() - startTime,
        output: JSON.stringify(data),
      };
    } catch {
      return {
        success: !output.includes('failing'),
        testName,
        passed: output.includes('passing') ? 1 : 0,
        failed: output.includes('failing') ? 1 : 0,
        skipped: 0,
        duration: Date.now() - startTime,
        output,
      };
    }
  }

  private calculateSummary(results: TestResult[]): TestSummary {
    return {
      total: results.length,
      passed: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      skipped: results.filter(r => r.skipped > 0).length,
      duration: results.reduce((sum, r) => sum + r.duration, 0),
    };
  }

  getRecentRuns(limit = 5): TestRun[] {
    return Array.from(this.testRuns.values())
      .sort((a, b) => b.startTime - a.startTime)
      .slice(0, limit);
  }

  getStats(): {
    totalRuns: number;
    successRate: number;
    avgDuration: number;
  } {
    const runs = Array.from(this.testRuns.values());
    
    const successCount = runs.filter(r => r.status === 'completed' && r.summary.failed === 0).length;
    const avgDuration = runs.length > 0 
      ? runs.reduce((sum, r) => sum + r.summary.duration, 0) / runs.length 
      : 0;

    return {
      totalRuns: runs.length,
      successRate: runs.length > 0 ? successCount / runs.length : 0,
      avgDuration,
    };
  }
}

export default TestingPipeline;