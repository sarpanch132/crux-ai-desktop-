import { EventEmitter } from 'events';
import log from 'electron-log';

interface FileNode {
  id: string;
  path: string;
  relativePath: string;
  imports: string[];
  exports: string[];
  symbols: Map<string, any>;
}

interface DependencyEdge {
  from: string;
  to: string;
  type: 'import' | 're-export' | 'inherit';
  weight: number;
}

export class DependencyGraph extends EventEmitter {
  private rootPath: string;
  private files: Map<string, FileNode> = new Map();
  private edges: Map<string, DependencyEdge[]> = new Map();
  private adjacencyList: Map<string, Set<string>> = new Map();
  private reverseAdjacency: Map<string, Set<string>> = new Map();

  constructor(rootPath: string) {
    super();
    this.rootPath = rootPath;
  }

  addFile(file: any): void {
    const id = file.id;
    
    const node: FileNode = {
      id,
      path: file.path,
      relativePath: file.relativePath,
      imports: file.dependencies || [],
      exports: file.exports?.map((e: any) => e.name) || [],
      symbols: new Map(
        file.symbols?.map((s: any) => [s.name, s]) || []
      ),
    };

    this.files.set(id, node);
    this.createEdges(node);
  }

  private createEdges(node: FileNode): void {
    const edges: DependencyEdge[] = [];

    for (const importPath of node.imports) {
      const resolvedId = this.resolveImport(importPath, node.relativePath);
      const targetFile = this.findFile(resolvedId);
      
      if (targetFile) {
        edges.push({
          from: node.id,
          to: targetFile.id,
          type: 'import',
          weight: 1,
        });

        const adj = this.adjacencyList.get(node.id) || new Set();
        adj.add(targetFile.id);
        this.adjacencyList.set(node.id, adj);

        const reverse = this.reverseAdjacency.get(targetFile.id) || new Set();
        reverse.add(node.id);
        this.reverseAdjacency.set(targetFile.id, reverse);
      }
    }

    this.edges.set(node.id, edges);
  }

  build(): void {
    log.info(`Building dependency graph for ${this.files.size} files`);

    for (const node of this.files.values()) {
      this.createEdges(node);
    }

    this.emit('graph:built', { nodes: this.files.size, edges: this.edges.size });
  }

  private resolveImport(importPath: string, fromPath: string): string {
    if (importPath.startsWith('.')) {
      return importPath;
    }

    return importPath;
  }

  private findFile(idOrPath: string): FileNode | undefined {
    let file = this.files.get(idOrPath);

    if (!file) {
      for (const f of this.files.values()) {
        if (f.relativePath.includes(idOrPath) || f.path.includes(idOrPath)) {
          file = f;
          break;
        }
      }
    }

    return file;
  }

  getDirectDependencies(fileId: string): string[] {
    return Array.from(this.adjacencyList.get(fileId) || []);
  }

  getDependents(fileId: string): string[] {
    return Array.from(this.reverseAdjacency.get(fileId) || []);
  }

  getAllDependencies(fileId: string, depth = 3): Set<string> {
    const visited = new Set<string>();
    const queue: string[] = [fileId];

    for (let d = 0; d < depth && queue.length; d++) {
      const current = queue.shift()!;
      const deps = this.getDirectDependencies(current);

      for (const dep of deps) {
        if (!visited.has(dep)) {
          visited.add(dep);
          queue.push(dep);
        }
      }
    }

    visited.delete(fileId);
    return visited;
  }

  getAllDependents(fileId: string, depth = 3): Set<string> {
    const visited = new Set<string>();
    const queue: string[] = [fileId];

    for (let d = 0; d < depth && queue.length; d++) {
      const current = queue.shift()!;
      const deps = this.getDependents(current);

      for (const dep of deps) {
        if (!visited.has(dep)) {
          visited.add(dep);
          queue.push(dep);
        }
      }
    }

    visited.delete(fileId);
    return visited;
  }

  getFilesInOrder(fileId: string): string[] {
    const visited = new Set<string>();
    const order: string[] = [];

    const dfs = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);

      for (const dep of this.getAllDependencies(id)) {
        dfs(dep);
      }

      order.push(id);
    };

    dfs(fileId);
    return order;
  }

  getAffectedFiles(fileIds: string[]): Set<string> {
    const affected = new Set<string>();

    for (const id of fileIds) {
      affected.add(id);

      for (const dep of this.getAllDependents(id)) {
        affected.add(dep);
      }

      for (const dep of this.getAllDependencies(id)) {
        affected.add(dep);
      }
    }

    return affected;
  }

  findCircularDependencies(): Map<string, string[]> {
    const cycles = new Map<string, string[]>();
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const dfs = (nodeId: string, path: string[]): string[] | null => {
      if (recursionStack.has(nodeId)) {
        const cycleStart = path.indexOf(nodeId);
        return [...path.slice(cycleStart), nodeId];
      }

      if (visited.has(nodeId)) {
        return null;
      }

      visited.add(nodeId);
      recursionStack.add(nodeId);

      for (const dep of this.getDirectDependencies(nodeId)) {
        const cycle = dfs(dep, [...path, nodeId]);
        if (cycle) {
          return cycle;
        }
      }

      recursionStack.delete(nodeId);
      return null;
    };

    for (const nodeId of this.files.keys()) {
      visited.clear();
      recursionStack.clear();
      
      const cycle = dfs(nodeId, []);
      if (cycle) {
        cycles.set(nodeId, cycle);
      }
    }

    return cycles;
  }

  getGraphStats(): {
    nodes: number;
    edges: number;
    maxDependencies: number;
    maxDependents: number;
    avgDependencies: number;
  } {
    const dependencyCounts = Array.from(this.adjacencyList.values()).map(s => s.size);
    const dependentCounts = Array.from(this.reverseAdjacency.values()).map(s => s.size);

    return {
      nodes: this.files.size,
      edges: this.edges.size,
      maxDependencies: Math.max(...dependencyCounts, 0),
      maxDependents: Math.max(...dependentCounts, 0),
      avgDependencies: dependencyCounts.reduce((a, b) => a + b, 0) / this.files.size,
    };
  }

  getSymbolReferences(symbolName: string): FileNode[] {
    const references: FileNode[] = [];

    for (const file of this.files.values()) {
      if (file.symbols.has(symbolName) {
        references.push(file);
      }

      for (const depId of this.getAllDependents(file.id)) {
        const depFile = this.files.get(depId);
        if (depFile && depFile.exports.includes(symbolName)) {
          references.push(depFile);
        }
      }
    }

    return references;
  }

  clear(): void {
    this.files.clear();
    this.edges.clear();
    this.adjacencyList.clear();
    this.reverseAdjacency.clear();
  }
}

export default DependencyGraph;