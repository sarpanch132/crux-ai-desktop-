import { EventEmitter } from 'events';
import * as ts from 'typescript';
import * as path from 'path';
import * as fs from 'fs';
import log from 'electron-log';

export interface Symbol {
  id: string;
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'variable' | 'constant' | 'module' | 'export' | 'import';
  file: string;
  line: number;
  column: number;
  endLine?: number;
  signature?: string;
  scope: 'public' | 'private' | 'protected' | 'internal';
  references: string[];
  exports: string[];
  imports: string[];
  dependencies: string[];
  metadata?: Record<string, any>;
}

export interface FunctionCall {
  caller: string;
  callee: string;
  file: string;
  line: number;
}

export interface ClassHierarchy {
  name: string;
  extends?: string;
  implements: string[];
  methods: string[];
  properties: string[];
}

export interface DependencyEdge {
  source: string;
  target: string;
  type: 'import' | 'export' | 'inheritance' | 'composition' | 'association';
  weight: number;
}

export interface CodeGraph {
  nodes: Map<string, Symbol>;
  edges: DependencyEdge[];
  callGraph: FunctionCall[];
  classHierarchies: Map<string, ClassHierarchy>;
  imports: Map<string, string[]>;
  exports: Map<string, string[]>;
}

export interface GraphQuery {
  symbolName?: string;
  file?: string;
  kind?: string;
  depth?: number;
  type?: 'dependencies' | 'dependents' | 'callers' | 'callees' | 'all';
}

export interface QueryResult {
  symbols: Symbol[];
  paths: string[][];
  metrics: {
    totalSymbols: number;
    totalEdges: number;
    maxDepth: number;
  };
}

export class SemanticCodeGraph extends EventEmitter {
  private graph: CodeGraph;
  private index: Map<string, Symbol> = new Map();
  private fileIndex: Map<string, Symbol[]> = new Map();
  private symbolLookup: Map<string, Symbol[]> = new Map();
  private language: string = 'typescript';
  private incrementalMode: boolean = false;

  constructor() {
    super();
    this.graph = {
      nodes: new Map(),
      edges: [],
      callGraph: [],
      classHierarchies: new Map(),
      imports: new Map(),
      exports: new Map(),
    };
  }

  async indexProject(rootPath: string, options: {
    languages?: string[];
    incremental?: boolean;
    ignore?: string[];
  } = {}): Promise<void> {
    const languages = options.languages || ['typescript', 'javascript'];
    const ignore = options.ignore || ['node_modules', '.git', 'dist', 'build'];
    this.incrementalMode = options.incremental || false;

    log.info(`Indexing project: ${rootPath}`);

    for (const lang of languages) {
      this.language = lang;
      const files = await this.findSourceFiles(rootPath, lang, ignore);
      
      for (const file of files) {
        await this.indexFile(file);
      }
    }

    this.buildRelationships();
    this.emit('indexed', { files: this.fileIndex.size, symbols: this.graph.nodes.size });
    
    log.info(`Indexed ${this.graph.nodes.size} symbols from ${this.fileIndex.size} files`);
  }

  private async findSourceFiles(rootPath: string, language: string, ignore: string[]): Promise<string[]> {
    const files: string[] = [];
    const extensions = this.getExtensions(language);

    const walk = (dir: string) => {
      if (ignore.some(i => dir.includes(i))) return;

      const entries = fs.readdirSync(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).slice(1);
          if (extensions.includes(ext)) {
            files.push(fullPath);
          }
        }
      }
    };

    walk(rootPath);
    return files;
  }

  private getExtensions(language: string): string[] {
    const map: Record<string, string[]> = {
      typescript: ['ts', 'tsx'],
      javascript: ['js', 'jsx'],
      python: ['py'],
      go: ['go'],
      java: ['java'],
      rust: ['rs'],
    };
    return map[language] || ['ts', 'js'];
  }

  async indexFile(filePath: string): Promise<void> {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const symbols = this.parseFile(content, filePath);

      const existing = this.fileIndex.get(filePath) || [];
      
      for (const symbol of symbols) {
        const id = `${filePath}:${symbol.name}`;
        symbol.id = id;
        
        this.graph.nodes.set(id, symbol);
        this.index.set(id, symbol);

        const byName = this.symbolLookup.get(symbol.name) || [];
        byName.push(symbol);
        this.symbolLookup.set(symbol.name, byName);
      }

      existing.forEach(s => this.graph.nodes.delete(`${filePath}:${s.name}`));
      this.fileIndex.set(filePath, symbols);

    } catch (error) {
      log.error(`Failed to index ${filePath}:`, error);
    }
  }

  private parseFile(content: string, filePath: string): Symbol[] {
    if (this.language === 'typescript' || this.language === 'javascript') {
      return this.parseTypeScript(content, filePath);
    }
    return [];
  }

  private parseTypeScript(content: string, filePath: string): Symbol[] {
    const symbols: Symbol[] = [];
    
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true
    );

    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node)) {
        symbols.push(this.extractFunction(node, filePath, content));
      } else if (ts.isClassDeclaration(node)) {
        symbols.push(this.extractClass(node, filePath, content));
      } else if (ts.isInterfaceDeclaration(node)) {
        symbols.push(this.extractInterface(node, filePath, content));
      } else if (ts.isTypeAliasDeclaration(node)) {
        symbols.push(this.extractType(node, filePath));
      } else if (ts.isVariableStatement(node)) {
        symbols.push(...this.extractVariables(node, filePath));
      } else if (ts.isImportDeclaration(node)) {
        symbols.push(this.extractImport(node, filePath));
      } else if (ts.isExportDeclaration(node)) {
        symbols.push(this.extractExport(node, filePath));
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return symbols;
  }

  private extractFunction(node: ts.FunctionDeclaration, filePath: string, content: string): Symbol {
    const name = node.name?.getText() || 'anonymous';
    const { line, column } = this.getPosition(node.name?.getStart() || 0, content);
    
    let signature = '';
    if (node.parameters.length) {
      const params = node.parameters.map(p => p.getText()).join(', ');
      signature = `(${params})`;
    }

    return {
      id: '',
      name,
      kind: 'function',
      file: filePath,
      line,
      column,
      endLine: node.getEnd(),
      signature,
      scope: this.getScope(node),
      references: [],
      exports: [],
      imports: [],
      dependencies: [],
    };
  }

  private extractClass(node: ts.ClassDeclaration, filePath: string, content: string): Symbol {
    const name = node.name?.getText() || 'AnonymousClass';
    const { line, column } = this.getPosition(node.name?.getStart() || 0, content);

    const extendsClause = node.heritageClauses?.find(c => c.token === ts.SyntaxKind.ExtendsKeyword);
    const extendsName = extendsClause?.types[0]?.getText();

    const implementsClause = node.heritageClauses?.find(c => c.token === ts.SyntaxKind.ImplementsKeyword);
    const implementsNames = implementsClause?.types.map(t => t.getText()) || [];

    const methods: string[] = [];
    const properties: string[] = [];

    node.members.forEach(member => {
      if (ts.isMethodDeclaration(member)) {
        methods.push(member.name?.getText() || 'method');
      } else if (ts.isPropertyDeclaration(member)) {
        properties.push(member.name?.getText() || 'property');
      }
    });

    this.graph.classHierarchies.set(name, {
      name,
      extends: extendsName,
      implements: implementsNames,
      methods,
      properties,
    });

    return {
      id: '',
      name,
      kind: 'class',
      file: filePath,
      line,
      column,
      scope: this.getScope(node),
      references: [],
      exports: [name],
      imports: [],
      dependencies: extendsName ? [extendsName] : [],
    };
  }

  private extractInterface(node: ts.InterfaceDeclaration, filePath: string, content: string): Symbol {
    const name = node.name.getText();
    const { line, column } = this.getPosition(node.name.getStart(), content);

    return {
      id: '',
      name,
      kind: 'interface',
      file: filePath,
      line,
      column,
      scope: this.getScope(node),
      references: [],
      exports: [name],
      imports: [],
      dependencies: [],
    };
  }

  private extractType(node: ts.TypeAliasDeclaration, filePath: string): Symbol {
    const name = node.name.getText();
    const { line, column } = this.getPosition(node.name.getStart(), node.getFullText());

    return {
      id: '',
      name,
      kind: 'type',
      file: filePath,
      line,
      column,
      scope: this.getScope(node),
      references: [],
      exports: [name],
      imports: [],
      dependencies: [],
    };
  }

  private extractVariables(node: ts.VariableStatement, filePath: string): Symbol[] {
    const symbols: Symbol[] = [];
    const { line, column } = this.getPosition(node.getStart(), node.getFullText());

    for (const decl of node.declarationList.declarations) {
      symbols.push({
        id: '',
        name: decl.name.getText(),
        kind: 'variable',
        file: filePath,
        line,
        column,
        scope: this.getScope(node),
        references: [],
        exports: [],
        imports: [],
        dependencies: [],
      });
    }

    return symbols;
  }

  private extractImport(node: ts.ImportDeclaration, filePath: string): Symbol {
    const moduleName = node.moduleSpecifier.getText().replace(/['"]/g, '');
    const { line, column } = this.getPosition(node.getStart(), node.getFullText());

    const namedImports: string[] = [];
    if (node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      for (const element of node.importClause.namedBindings.elements) {
        namedImports.push(element.name.getText());
      }
    }

    const imports = this.graph.imports.get(filePath) || [];
    imports.push(moduleName);
    this.graph.imports.set(filePath, imports);

    return {
      id: '',
      name: moduleName,
      kind: 'import',
      file: filePath,
      line,
      column,
      scope: 'public',
      references: [],
      exports: [],
      imports: namedImports,
      dependencies: [moduleName],
    };
  }

  private extractExport(node: ts.ExportDeclaration, filePath: string): Symbol {
    const { line, column } = this.getPosition(node.getStart(), node.getFullText());

    const exports: string[] = [];
    if (node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) {
        exports.push(element.name.getText());
      }
    }

    const existing = this.graph.exports.get(filePath) || [];
    this.graph.exports.set(filePath, [...existing, ...exports]);

    return {
      id: '',
      name: 'export',
      kind: 'export',
      file: filePath,
      line,
      column,
      scope: 'public',
      references: [],
      exports,
      imports: [],
      dependencies: [],
    };
  }

  private getPosition offset: number, content: string): { line: number; column: number } {
    const lines = content.slice(0, offset).split('\n');
    return {
      line: lines.length,
      column: lines[lines.length - 1].length + 1,
    };
  }

  private getScope(node: ts.Node): 'public' | 'private' | 'protected' | 'internal' {
    const modifiers = ts.getModifiers(node);
    
    if (modifiers?.some(m => m.kind === ts.SyntaxKind.PrivateKeyword)) return 'private';
    if (modifiers?.some(m => m.kind === ts.SyntaxKind.ProtectedKeyword)) return 'protected';
    if (modifiers?.some(m => m.kind === ts.SyntaxKind.PublicKeyword)) return 'public';
    
    return 'public';
  }

  private buildRelationships(): void {
    for (const [id, symbol] of this.graph.nodes) {
      if (symbol.dependencies.length > 0) {
        for (const dep of symbol.dependencies) {
          this.graph.edges.push({
            source: id,
            target: dep,
            type: 'import',
            weight: 1,
          });
        }
      }
    }

    for (const [sourceFile, imports] of this.graph.imports) {
      for (const [targetFile, exports] of this.graph.exports) {
        if (imports.some(i => targetFile.includes(i.replace(/.*\//, '')))) {
          for (const exp of exports) {
            this.graph.edges.push({
              source: sourceFile,
              target: targetFile,
              type: 'export',
              weight: 1,
            });
          }
        }
      }
    }
  }

  query(query: GraphQuery): QueryResult {
    let symbols: Symbol[] = [];

    if (query.symbolName) {
      symbols = this.symbolLookup.get(query.symbolName) || [];
    } else if (query.file) {
      symbols = this.fileIndex.get(query.file) || [];
    } else if (query.kind) {
      for (const symbol of this.graph.nodes.values()) {
        if (symbol.kind === query.kind) {
          symbols.push(symbol);
        }
      }
    }

    const paths = this.findPaths(query);
    const depths = symbols.map(s => this.getDepth(s.id));

    return {
      symbols,
      paths,
      metrics: {
        totalSymbols: this.graph.nodes.size,
        totalEdges: this.graph.edges.length,
        maxDepth: Math.max(...depths, 0),
      },
    };
  }

  findWhatBreaksIfThisChanges(symbolName: string): Symbol[] {
    const symbol = this.symbolLookup.get(symbolName)?.[0];
    if (!symbol) return [];

    const dependents: Symbol[] = [];

    for (const [id, sym] of this.graph.nodes) {
      if (sym.dependencies.includes(symbolName)) {
        dependents.push(sym);
      }

      if (sym.exports?.includes(symbolName)) {
        dependents.push(sym);
      }
    }

    return dependents;
  }

  findWhereUsed(symbolName: string): Symbol[] {
    const used: Symbol[] = [];

    for (const [, sym] of this.graph.nodes) {
      if (sym.references?.includes(symbolName)) {
        used.push(sym);
      }

      if (sym.imports?.includes(symbolName)) {
        used.push(sym);
      }
    }

    return used;
  }

  findCallers(functionName: string): FunctionCall[] {
    return this.graph.callGraph.filter(c => c.callee === functionName);
  }

  findCallees(functionName: string): FunctionCall[] {
    return this.graph.callGraph.filter(c => c.caller === functionName);
  }

  findPaths(query: GraphQuery): string[][] {
    const paths: string[][] = [];
    const startNode = query.symbolName;
    const maxDepth = query.depth || 5;

    if (!startNode) return paths;

    const visited = new Set<string>();
    const queue: { node: string; path: string[] }[] = [{ node: startNode, path: [startNode] }];

    while (queue.length > 0) {
      const current = queue.shift()!;
      
      if (current.path.length > maxDepth) continue;
      if (visited.has(current.node)) continue;
      visited.add(current.node);

      const edges = this.graph.edges.filter(e => e.source === current.node);
      
      for (const edge of edges) {
        const newPath = [...current.path, edge.target];
        
        if (query.type === 'dependencies') {
          paths.push(newPath);
        }

        queue.push({ node: edge.target, path: newPath });
      }
    }

    return paths;
  }

  private getDepth(symbolId: string): number {
    let maxDepth = 0;

    const visited = new Set<string>();
    const queue: { node: string; depth: number }[] = [{ node: symbolId, depth: 0 }];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current.node)) continue;
      visited.add(current.node);

      maxDepth = Math.max(maxDepth, current.depth);

      const edges = this.graph.edges.filter(e => e.source === current.node);
      for (const edge of edges) {
        queue.push({ node: edge.target, depth: current.depth + 1 });
      }
    }

    return maxDepth;
  }

  getGraph(): CodeGraph {
    return this.graph;
  }

  getMetrics(): {
    files: number;
    symbols: number;
    edges: number;
    classes: number;
    functions: number;
    imports: number;
  } {
    let functions = 0;
    let classes = 0;

    for (const symbol of this.graph.nodes.values()) {
      if (symbol.kind === 'function') functions++;
      if (symbol.kind === 'class') classes++;
    }

    return {
      files: this.fileIndex.size,
      symbols: this.graph.nodes.size,
      edges: this.graph.edges.length,
      classes,
      functions,
      imports: this.graph.imports.size,
    };
  }
}

export default SemanticCodeGraph;