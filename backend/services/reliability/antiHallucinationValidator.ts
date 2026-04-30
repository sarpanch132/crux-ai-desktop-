import { EventEmitter } from 'events';
import log from 'electron-log';

export interface ValidationResult {
  valid: boolean;
  confidence: number;
  issues: ValidationIssue[];
  verified: boolean;
}

export interface ValidationIssue {
  type: 'hallucination' | 'incomplete' | 'uncertain' | 'contradiction';
  severity: 'high' | 'medium' | 'low';
  message: string;
  evidence?: string;
}

export interface HallucinationPattern {
  pattern: RegExp;
  description: string;
  severity: 'high' | 'medium' | 'low';
}

export class AntiHallucinationValidator extends EventEmitter {
  private patterns: HallucinationPattern[] = [
    {
      pattern: /^(created|updated|deleted|fixed)\s+successfully/i,
      description: 'Unverified success claim',
      severity: 'high',
    },
    {
      pattern: /all\s+tests?\s+passed/i,
      description: 'Unverified test pass',
      severity: 'high',
    },
    {
      pattern: /no\s+errors?\s+found/i,
      description: 'Unverified error absence',
      severity: 'medium',
    },
    {
      pattern: /successfully\s+(written|modified|executed)/i,
      description: 'Unverified operation',
      severity: 'high',
    },
    {
      pattern: /completed\s+without\s+issues/i,
      description: 'Unverified completion',
      severity: 'medium',
    },
    {
      pattern: /verified\s+and\s+working/i,
      description: 'Unverified verification',
      severity: 'high',
    },
  ];

  private uncertaintyPhrases = [
    'probably',
    'likely',
    'might',
    'could be',
    'should be',
    'assumed',
    'presumably',
  ];

  constructor() {
    super();
  }

  addPattern(pattern: HallucinationPattern): void {
    this.patterns.push(pattern);
  }

  validateClaim(claim: string, verification?: () => Promise<boolean>): ValidationResult {
    const issues: ValidationIssue[] = [];
    let confidence = 1.0;

    for (const p of this.patterns) {
      if (p.pattern.test(claim)) {
        issues.push({
          type: 'hallucination',
          severity: p.severity,
          message: p.description,
          evidence: claim,
        });

        if (p.severity === 'high') confidence -= 0.4;
        else if (p.severity === 'medium') confidence -= 0.2;
      }
    }

    for (const phrase of this.uncertaintyPhrases) {
      if (claim.toLowerCase().includes(phrase)) {
        issues.push({
          type: 'uncertain',
          severity: 'low',
          message: `Uncertain phrase detected: "${phrase}"`,
        });
        confidence -= 0.1;
      }
    }

    confidence = Math.max(0, Math.min(1, confidence));

    const valid = issues.filter(i => i.severity === 'high').length === 0;

    this.emit('validated', { claim, valid, confidence, issues });

    return {
      valid,
      confidence,
      issues,
      verified: false,
    };
  }

  async verifyWithEvidence(
    claim: string,
    evidence: string | string[]
  ): Promise<ValidationResult> {
    const basicValidation = this.validateClaim(claim);
    
    if (basicValidation.confidence >= 0.8) {
      return { ...basicValidation, verified: true };
    }

    const evidenceList = Array.isArray(evidence) ? evidence : [evidence];
    const hasSupportingEvidence = evidenceList.some(e => 
      e.toLowerCase().includes(claim.toLowerCase().split(' ')[0])
    );

    if (hasSupportingEvidence) {
      basicValidation.confidence += 0.3;
      basicValidation.verified = true;
    }

    return basicValidation;
  }

  validateFileEdit(
    operation: { path: string; action: string },
    verification: { fileExists?: boolean; content?: string }
  ): ValidationResult {
    const issues: ValidationIssue[] = [];
    let confidence = 1.0;

    if (operation.action === 'create' || operation.action === 'modify') {
      if (!verification.fileExists) {
        issues.push({
          type: 'uncertain',
          severity: 'medium',
          message: 'File may not exist after operation',
          evidence: operation.path,
        });
        confidence -= 0.3;
      }

      if (!verification.content || verification.content.length === 0) {
        issues.push({
          type: 'hallucination',
          severity: 'high',
          message: 'No content verification provided',
        });
        confidence -= 0.5;
      }
    }

    return {
      valid: issues.filter(i => i.severity === 'high').length === 0,
      confidence: Math.max(0, confidence),
      issues,
      verified: verification.fileExists ?? false,
    };
  }

  validateCommandResult(
    command: string,
    result: { success: boolean; stdout: string; stderr: string; exitCode?: number }
  ): ValidationResult {
    const issues: ValidationIssue[] = [];
    let confidence = 1.0;

    if (result.success && result.stderr.length > 0 && !result.stderr.includes('warn')) {
      issues.push({
        type: 'contradiction',
        severity: 'high',
        message: 'Command succeeded but has stderr output',
        evidence: result.stderr,
      });
      confidence -= 0.3;
    }

    if (result.success && !result.stdout && !result.stderr) {
      issues.push({
        type: 'incomplete',
        severity: 'medium',
        message: 'No output to verify success',
      });
      confidence -= 0.2;
    }

    if (result.exitCode === undefined) {
      issues.push({
        type: 'uncertain',
        severity: 'medium',
        message: 'No exit code returned',
      });
      confidence -= 0.2;
    }

    return {
      valid: issues.filter(i => i.severity === 'high').length === 0,
      confidence: Math.max(0, confidence),
      issues,
      verified: result.exitCode === 0,
    };
  }

  validateTestResult(testOutput: string): ValidationResult {
    const issues: ValidationIssue[] = [];
    let confidence = 1.0;

    const hasFailures = /\d+\s+failing/i.test(testOutput);
    const hasPassing = /\d+\s+passing/i.test(testOutput);

    if (hasFailures) {
      const failMatch = testOutput.match(/(\d+)\s+failing/);
      if (failMatch && parseInt(failMatch[1]) > 0) {
        issues.push({
          type: 'hallucination',
          severity: 'high',
          message: 'Tests failed but claim may indicate success',
        });
        confidence -= 0.5;
      }
    }

    if (!hasPassing && !hasFailures) {
      issues.push({
        type: 'incomplete',
        severity: 'medium',
        message: 'Cannot parse test output',
      });
      confidence -= 0.4;
    }

    return {
      valid: issues.filter(i => i.severity === 'high').length === 0,
      confidence: Math.max(0, confidence),
      issues,
      verified: hasPassing && !hasFailures,
    };
  }
}

export class ConfidenceScorer extends EventEmitter {
  private baseScore: number;
  private factors: Map<string, number> = new Map();

  constructor() {
    super();
    this.baseScore = 0.5;
    this.initializeFactors();
  }

  private initializeFactors(): void {
    this.factors.set('verification', 0.3);
    this.factors.set('evidence', 0.2);
    this.factors.set('retry', 0.1);
    this.factors.set('cross_check', 0.15);
    this.factors.set('stability', 0.15);
    this.factors.set('history', 0.1);
  }

  calculateScore(params: {
    hasVerification?: boolean;
    hasEvidence?: boolean;
    pastSuccessRate?: number;
    crossChecked?: boolean;
    stableContext?: boolean;
    retryCount?: number;
  }): number {
    let score = this.baseScore;

    if (params.hasVerification) score += this.factors.get('verification')!;
    if (params.hasEvidence) score += this.factors.get('evidence')!;
    if (params.crossChecked) score += this.factors.get('cross_check')!;
    if (params.stableContext) score += this.factors.get('stability')!;
    if (params.retryCount && params.retryCount > 0) score -= params.retryCount * 0.05;

    if (params.pastSuccessRate !== undefined) {
      score += params.pastSuccessRate * this.factors.get('history')!;
    }

    score = Math.max(0, Math.min(1, score));

    this.emit('score:calculated', { score, params });

    return score;
  }

  isConfident(score: number, threshold: number = 0.7): boolean {
    return score >= threshold;
  }

  explainScore(score: number): string {
    if (score >= 0.9) return 'Highly confident';
    if (score >= 0.7) return 'Confident';
    if (score >= 0.5) return 'Moderate confidence';
    if (score >= 0.3) return 'Low confidence';
    return 'Very low confidence - requires verification';
  }
}

export default AntiHallucinationValidator;