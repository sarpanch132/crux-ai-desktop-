import { EventEmitter } from 'events';
import log from 'electron-log';

export interface ParsedCode {
  symbols: CodeSymbol[];
  imports: ImportInfo[];
  exports: ExportInfo[];
  errors?: string[];
}

export interface CodeSymbol {
  id: string;
  name: string;
  type: 'function' | 'class' | 'method' | 'variable' | 'constant' | 'interface' | 'type' | 'enum';
  visibility: 'public' | 'private' | 'protected';
  line: number;
  endLine: number;
  fileId?: string;
  signature?: string;
  params?: string[];
  returnType?: string;
  documentation?: string;
}

export interface ImportInfo {
  path: string;
  local: string;
  isDefault: boolean;
  isNamespace: boolean;
  line: number;
}

export interface ExportInfo {
  name: string;
  isDefault: boolean;
  line: number;
}

const LANGUAGE_PATTERNS: Record<string, LanguagePatternConfig> = {
  typescript: {
    function: /(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\([^)]*\)/g,
    class: /(?:export\s+)?class\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
    method: /(?:public|private|protected)?\s*(?:async\s+)?([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\([^)]*\)\s*(?::\s*[a-zA-Z_$][a-zA-Z0-9_$<>]*)?\s*\{/g,
    variable: /(?:export\s+)?(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
    interface: /(?:export\s+)?interface\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
    type: /(?:export\s+)?type\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
    import: /import\s+(?:type\s+)?(?:\{[^}]*\}|\*[^\s]+|default\s+[a-zA-Z_$][a-zA-Z0-9_$]*)\s+from\s+['"]([^'"]+)['"]/g,
    export: /export\s+(?:default\s+)?(?:\{[^}]*\}|[a-zA-Z_$][a-zA-Z0-9_$]*)/g,
  },
  javascript: {
    function: /(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\([^)]*\)/g,
    class: /(?:export\s+)?class\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
    variable: /(?:export\s+)?(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
    import: /import\s+(?:\{[^}]*\}|\*[^\s]+|default\s+[a-zA-Z_$][a-zA-Z0-9_$]*)\s+from\s+['"]([^'"]+)['"]/g,
    export: /export\s+(?:default\s+)?(?:\{[^}]*\}|[a-zA-Z_$][a-zA-Z0-9_$]*)/g,
  },
  python: {
    function: /(?:def\s+)([a-zA-Z_][a-zA-Z0-9_]*)\s*\([^)]*\):/g,
    class: /(?:class\s+)([a-zA-Z_][a-zA-Z0-9_]*)\s*[:(]/g,
    variable: /(?:[a-zA-Z_][a-zA-Z0-9_]*)\s*=/g,
    import: /^(?:from\s+([a-zA-Z_.]+)\s+)?import\s+(?:(?:[a-zA-Z_][a-zA-Z0-9_]*,?\s*)+)/gm,
  },
  rust: {
    function: /(?:pub\s+)?(?:async\s+)?fn\s+([a-zA-Z_][a-zA-Z0-9_]*)/g,
    struct: /(?:pub\s+)?struct\s+([a-zA-Z_][a-zA-Z0-9_]*)/g,
    enum: /(?:pub\s+)?enum\s+([a-zA-Z_][a-zA-Z0-9_]*)/g,
    impl: /impl\s+(?:[a-zA-Z_][a-zA-Z0-9_]*)/g,
    use: /use\s+([a-zA-Z_:][a-zA-Z0-9_:]*)/g,
  },
  go: {
    function: /func\s+(?:\([a-zA-Z_*]+\s+\*?[a-zA-Z_][a-zA-Z0-9_]*\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g,
    struct: /type\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+struct/g,
    interface: /type\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+interface/g,
    import: /import\s+(?:"([^"]+)"|\(([^)]+)\))/g,
  },
};

interface LanguagePatternConfig {
  function?: RegExp;
  class?: RegExp;
  method?: RegExp;
  variable?: RegExp;
  constant?: RegExp;
  interface?: RegExp;
  type?: RegExp;
  enum?: RegExp;
  import?: RegExp;
  export?: RegExp;
  struct?: RegExp;
  impl?: RegExp;
  use?: RegExp;
}

export class CodeParser extends EventEmitter {
  private patterns: Map<string, LanguagePatternConfig>;

  constructor() {
    super();
    this.patterns = LANGUAGE_PATTERNS;
  }

  async parse(content: string, language: string): Promise<ParsedCode> {
    const result: ParsedCode = {
      symbols: [],
      imports: [],
      exports: [],
    };

    try {
      const patterns = this.patterns.get(language) || this.patterns.get('javascript');
      
      if (!patterns) {
        return result;
      }

      const lines = content.split('\n');

      for (const line of lines) {
        line.match(patterns.import || /xxx/) as any;
      }

      result.symbols = this.extractSymbols(content, patterns, language);
      result.imports = this.extractImports(content, patterns);
      result.exports = this.extractExports(content, patterns);
    } catch (error) {
      log.warn('Parse error:', error);
      result.errors = [String(error)];
    }

    return result;
  }

  private extractSymbols(
    content: string,
    patterns: LanguagePatternConfig,
    language: string
  ): CodeSymbol[] {
    const symbols: CodeSymbol[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      if (patterns.function) {
        patterns.function.lastIndex = 0;
        const funcMatch = patterns.function.exec(line);
        if (funcMatch) {
          symbols.push({
            id: `sym_${lineNum}`,
            name: funcMatch[1],
            type: 'function',
            visibility: this.getVisibility(line),
            line: lineNum,
            endLine: this.findEndLine(lines, i, language),
          });
        }
      }

      if (patterns.class) {
        patterns.class.lastIndex = 0;
        const classMatch = patterns.class.exec(line);
        if (classMatch) {
          symbols.push({
            id: `sym_${lineNum}`,
            name: classMatch[1],
            type: 'class',
            visibility: this.getVisibility(line),
            line: lineNum,
            endLine: this.findEndLine(lines, i, language),
          });
        }
      }

      if (patterns.method) {
        patterns.method.lastIndex = 0;
        const methodMatch = patterns.method.exec(line);
        if (methodMatch) {
          symbols.push({
            id: `sym_${lineNum}`,
            name: methodMatch[1],
            type: 'method',
            visibility: this.getVisibility(line),
            line: lineNum,
            endLine: this.findEndLine(lines, i, language),
          });
        }
      }

      if (patterns.interface) {
        patterns.interface.lastIndex = 0;
        const interfaceMatch = patterns.interface.exec(line);
        if (interfaceMatch) {
          symbols.push({
            id: `sym_${lineNum}`,
            name: interfaceMatch[1],
            type: 'interface',
            visibility: this.getVisibility(line),
            line: lineNum,
            endLine: this.findEndLine(lines, i, language),
          });
        }
      }

      if (patterns.type) {
        patterns.type.lastIndex = 0;
        const typeMatch = patterns.type.exec(line);
        if (typeMatch) {
          symbols.push({
            id: `sym_${lineNum}`,
            name: typeMatch[1],
            type: 'type',
            visibility: this.getVisibility(line),
            line: lineNum,
            endLine: this.findEndLine(lines, i, language),
          });
        }
      }

      if (patterns.variable) {
        patterns.variable.lastIndex = 0;
        const varMatch = patterns.variable.exec(line);
        if (varMatch && !line.includes('=') ) {
          symbols.push({
            id: `sym_${lineNum}`,
            name: varMatch[1],
            type: 'variable',
            visibility: this.getVisibility(line),
            line: lineNum,
            endLine: lineNum,
          });
        }
      }
    }

    return symbols;
  }

  private extractImports(content: string, patterns: LanguagePatternConfig): ImportInfo[] {
    const imports: ImportInfo[] = [];
    const lines = content.split('\n');

    if (!patterns.import) return imports;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      patterns.import.lastIndex = 0;
      const match = patterns.import.exec(line);

      if (match) {
        const path = match[1] || match[2];
        
        imports.push({
          path: path || '',
          local: path?.includes('.') || false,
          isDefault: line.includes('default'),
          isNamespace: line.includes('*'),
          line: i + 1,
        });
      }
    }

    return imports;
  }

  private extractExports(content: string, patterns: LanguagePatternConfig): ExportInfo[] {
    const exports: ExportInfo[] = [];
    const lines = content.split('\n');

    if (!patterns.export) return exports;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      patterns.export.lastIndex = 0;
      const match = patterns.export.exec(line);

      if (match) {
        exports.push({
          name: match[1] || '*',
          isDefault: line.includes('default'),
          line: i + 1,
        });
      }
    }

    return exports;
  }

  private getVisibility(line: string): 'public' | 'private' | 'protected' {
    if (line.includes('private') || line.startsWith('#')) {
      return 'private';
    }
    if (line.includes('protected')) {
      return 'protected';
    }
    return 'public';
  }

  private findEndLine(lines: string[], startIndex: number, language: string): number {
    const startLine = lines[startIndex];
    
    if (language === 'typescript' || language === 'javascript') {
      let braceCount = 0;
      
      for (let i = startIndex; i < lines.length; i++) {
        const line = lines[i];
        for (const char of line) {
          if (char === '{') braceCount++;
          if (char === '}') braceCount--;
        }
        
        if (braceCount === 0 && i > startIndex) {
          return i + 1;
        }
      }
    }

    if (language === 'python') {
      let indent = this.getIndent(startLine);
      
      for (let i = startIndex + 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === '' || this.getIndent(line) <= indent) {
          return i + 1;
        }
      }
    }

    return startIndex + 1;
  }

  private getIndent(line: string): number {
    return line.search(/\S/);
  }

  parseDocumentation(content: string): string {
    const lines = content.split('\n');
    const docLines: string[] = [];
    let inDoc = false;

    for (const line of lines) {
      if (line.includes('/**') || line.includes('"""')) {
        inDoc = true;
        continue;
      }
      
      if (line.includes('*/') || line.includes('"""')) {
        inDoc = false;
        break;
      }
      
      if (inDoc) {
        docLines.push(line.replace(/^\s*\*?\s*/, ''));
      }
    }

    return docLines.join(' ').trim();
  }
}

export default CodeParser;