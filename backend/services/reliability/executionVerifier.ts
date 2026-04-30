import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import log from 'electron-log';

export interface VerificationConfig {
  verifyFileExists: boolean;
  verifyFileContent: boolean;
  verifyFileSize: boolean;
  verifyImportStatements: boolean;
  verifySyntax: boolean;
  verifyExports: boolean;
  strictMode: boolean;
}

export interface FileEdit {
  type: 'create' | 'modify' | 'delete';
  path: string;
  content?: string;
  oldContent?: string;
}

export interface VerificationResult {
  verified: boolean;
  errors: VerificationError[];
  warnings: VerificationWarning[];
  confidence: number;
  details: any;
}

export interface VerificationError {
  type: string;
  message: string;
  path?: string;
  line?: number;
  severity: 'error' | 'critical';
}

export interface VerificationWarning {
  type: string;
  message: string;
  path?: string;
}

export class ExecutionVerifier extends EventEmitter {
  private config: VerificationConfig;
  private verificationHistory: Map<string, VerificationResult> = new Map();
  private maxHistory: number = 500;

  constructor(config: Partial<VerificationConfig> = {}) {
    super();
    this.config = {
      verifyFileExists: config.verifyFileExists ?? true,
      verifyFileContent: config.verifyFileContent ?? true,
      verifyFileSize: config.verifyFileSize ?? true,
      verifyImportStatements: config.verifyImportStatements ?? true,
      verifySyntax: config.verifySyntax ?? true,
      verifyExports: config.verifyExports ?? true,
      strictMode: config.strictMode ?? false,
    };
  }

  async verifyFileOperation(operation: FileEdit): Promise<VerificationResult> {
    const errors: VerificationError[] = [];
    const warnings: VerificationWarning[] = [];
    let confidence = 1.0;

    log.info(`Verifying file operation: ${operation.type} - ${operation.path}`);

    try {
      switch (operation.type) {
        case 'create':
          await this.verifyCreateOperation(operation, errors, warnings);
          break;
        case 'modify':
          await this.verifyModifyOperation(operation, errors, warnings);
          break;
        case 'delete':
          await this.verifyDeleteOperation(operation, errors, warnings);
          break;
      }

      confidence = this.calculateConfidence(errors, warnings);

      const result: VerificationResult = {
        verified: errors.length === 0,
        errors,
        warnings,
        confidence,
        details: {
          operation,
          timestamp: Date.now(),
          verifiedAt: Date.now(),
        },
      };

      this.recordVerification(operation.path, result);
      this.emit('verification:complete', result);

      return result;
    } catch (error) {
      const errorResult: VerificationResult = {
        verified: false,
        errors: [
          {
            type: 'verification_error',
            message: String(error),
            severity: 'critical',
          },
        ],
        warnings,
        confidence: 0,
        details: { operation },
      };

      this.emit('verification:failed', errorResult);
      return errorResult;
    }
  }

  private async verifyCreateOperation(
    operation: FileEdit,
    errors: VerificationError[],
    warnings: VerificationWarning[]
  ): Promise<void> {
    if (fs.existsSync(operation.path)) {
      errors.push({
        type: 'file_exists',
        message: `File already exists: ${operation.path}`,
        path: operation.path,
        severity: 'error',
      });
      return;
    }

    if (!operation.content) {
      errors.push({
        type: 'empty_content',
        message: 'Cannot create file with empty content',
        path: operation.path,
        severity: 'error',
      });
      return;
    }

    if (this.config.verifySyntax && this.isCodeFile(operation.path)) {
      const syntaxError = await this.checkSyntax(operation.content, operation.path);
      if (syntaxError) {
        errors.push(syntaxError);
      }
    }

    if (this.config.verifyImportStatements) {
      const importErrors = this.checkImports(operation.content, operation.path);
      errors.push(...importErrors);
    }
  }

  private async verifyModifyOperation(
    operation: FileEdit,
    errors: VerificationError[],
    warnings: VerificationWarning[]
  ): Promise<void> {
    if (!fs.existsSync(operation.path)) {
      errors.push({
        type: 'file_not_found',
        message: `File does not exist: ${operation.path}`,
        path: operation.path,
        severity: 'error',
      });
      return;
    }

    if (!operation.content && !operation.oldContent) {
      const content = fs.readFileSync(operation.path, 'utf-8');
      operation.content = content;
      warnings.push({
        type: 'content_not_provided',
        message: 'Using current file content for verification',
        path: operation.path,
      });
    }

    if (operation.content && this.config.verifySyntax && this.isCodeFile(operation.path)) {
      const syntaxError = await this.checkSyntax(operation.content, operation.path);
      if (syntaxError) {
        errors.push(syntaxError);
      }
    }

    if (operation.content && this.config.verifyExports) {
      const exportErrors = this.checkExports(operation.content, operation.path);
      errors.push(...exportErrors);
    }
  }

  private async verifyDeleteOperation(
    operation: FileEdit,
    errors: VerificationError[],
    warnings: VerificationWarning[]
  ): Promise<void> {
    if (!fs.existsSync(operation.path)) {
      warnings.push({
        type: 'file_not_found',
        message: 'Attempting to delete non-existent file',
        path: operation.path,
      });
      return;
    }

    const stats = fs.statSync(operation.path);
    if (stats.isDirectory()) {
      errors.push({
        type: 'is_directory',
        message: 'Cannot delete directory with file operation',
        path: operation.path,
        severity: 'error',
      });
    }
  }

  private isCodeFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return ['.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.go', '.rs', '.java'].includes(ext);
  }

  private async checkSyntax(
    content: string,
    filePath: string
  ): Promise<VerificationError | null> {
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.js' || ext === '.jsx') {
      try {
        new Function(content);
      } catch (error: any) {
        return {
          type: 'syntax_error',
          message: `Syntax error: ${error.message}`,
          path: filePath,
          severity: 'error',
        };
      }
    }

    return null;
  }

  private checkImports(content: string, filePath: string): VerificationError[] {
    const errors: VerificationError[] = [];
    const importRegex = /import\s+.*\s+from\s+['"]([^'"]+)['"]/g;
    let match;

    while ((match = importRegex.exec(content)) !== null) {
      const importPath = match[1];

      if (importPath.startsWith('.') || importPath.startsWith('/')) {
      } else if (!importPath.includes('node_modules') && !importPath.includes('@')) {
      }
    }

    return errors;
  }

  private checkExports(content: string, filePath: string): VerificationError[] {
    const errors: VerificationError[] = [];

    if (content.includes('export default') && !content.includes('export')) {
      errors.push({
        type: 'missing_export',
        message: 'File has export default but no explicit exports',
        path: filePath,
        severity: 'warning',
      });
    }

    return errors;
  }

  private calculateConfidence(
    errors: VerificationError[],
    warnings: VerificationWarning[]
  ): number {
    let confidence = 1.0;

    for (const error of errors) {
      if (error.severity === 'critical') confidence -= 0.5;
      else confidence -= 0.25;
    }

    for (const warning of warnings) {
      confidence -= 0.1;
    }

    return Math.max(0, confidence);
  }

  private recordVerification(path: string, result: VerificationResult): void {
    this.verificationHistory.set(path, result);
    if (this.verificationHistory.size > this.maxHistory) {
      const firstKey = this.verificationHistory.keys().next().value;
      if (firstKey) this.verificationHistory.delete(firstKey);
    }
  }

  async verifyCommandExecution(
    command: string,
    result: { success: boolean; stdout?: string; stderr?: string; exitCode?: number },
    expectedOutcomes: string[] = []
  ): Promise<VerificationResult> {
    const errors: VerificationError[] = [];
    const warnings: VerificationWarning[] = [];
    let confidence = 1.0;

    if (!result.success && !result.stderr && !result.stdout) {
      errors.push({
        type: 'silent_failure',
        message: 'Command failed without any output',
        severity: 'critical',
      });
      confidence -= 0.5;
    }

    if (result.exitCode === undefined) {
      errors.push({
        type: 'missing_exit_code',
        message: 'No exit code returned',
        severity: 'critical',
      });
      confidence -= 0.3;
    }

    for (const expected of expectedOutcomes) {
      if (!result.stdout?.includes(expected) && !result.stderr?.includes(expected)) {
        warnings.push({
          type: 'missing_expected_output',
          message: `Expected output not found: ${expected}`,
        });
      }
    }

    if (result.stderr?.toLowerCase().includes('error')) {
      warnings.push({
        type: 'stderr_has_error',
        message: 'stderr contains error text',
      });
    }

    return {
      verified: errors.length === 0,
      errors,
      warnings,
      confidence: Math.max(0, confidence),
      details: { command, result },
    };
  }

  async verifyTestResults(
    testOutput: string,
    expectedPass: number = 0,
    expectedFail: number = 0
  ): Promise<VerificationResult> {
    const errors: VerificationError[] = [];
    const warnings: VerificationWarning[] = [];
    let confidence = 1.0;

    const passMatch = testOutput.match(/(\d+)\s+passing/i);
    const failMatch = testOutput.match(/(\d+)\s+failing/i);

    const passCount = passMatch ? parseInt(passMatch[1]) : 0;
    const failCount = failMatch ? parseInt(failMatch[1]) : 0;

    if (expectedFail > 0 && failCount === 0) {
      warnings.push({
        type: 'unexpected_pass',
        message: 'Expected failures but all tests passed',
      });
    }

    if (failCount > 0 && expectedFail === 0) {
      errors.push({
        type: 'test_failures',
        message: `${failCount} tests failed`,
        severity: 'error',
      });
      confidence -= 0.5;
    }

    return {
      verified: errors.length === 0,
      errors,
      warnings,
      confidence: Math.max(0, confidence),
      details: { passCount, failCount },
    };
  }

  verifyFileIntegrity(filePath: string, expectedHash?: string): VerificationResult {
    const errors: VerificationError[] = [];
    const warnings: VerificationWarning[] = [];

    if (!fs.existsSync(filePath)) {
      return {
        verified: false,
        errors: [{ type: 'not_found', message: 'File not found', severity: 'error' }],
        warnings: [],
        confidence: 0,
        details: {},
      };
    }

    const content = fs.readFileSync(filePath);
    const actualHash = crypto.createHash('sha256').update(content).digest('hex');

    if (expectedHash && expectedHash !== actualHash) {
      errors.push({
        type: 'hash_mismatch',
        message: 'File content modified unexpectedly',
        path: filePath,
        severity: 'error',
      });
    }

    return {
      verified: errors.length === 0,
      errors,
      warnings,
      confidence: errors.length === 0 ? 1.0 : 0,
      details: { hash: actualHash, expectedHash },
    };
  }

  getVerificationHistory(path?: string): VerificationResult | VerificationResult[] | undefined {
    if (path) {
      return this.verificationHistory.get(path);
    }
    return Array.from(this.verificationHistory.values());
  }
}

export default ExecutionVerifier;