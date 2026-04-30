import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import log from 'electron-log';
import * as fs from 'fs';
import * as path from 'path';

export interface CheckpointConfig {
  storageDirectory: string;
  maxCheckpoints: number;
  autoSave: boolean;
  autoSaveInterval: number;
}

export interface Checkpoint {
  id: string;
  sessionId: string;
  description: string;
  state: Record<string, any>;
  timestamp: number;
  parentId?: string;
  tags: string[];
}

export interface CheckpointMetadata {
  id: string;
  sessionId: string;
  description: string;
  timestamp: number;
  parentId?: string;
  tags: string[];
  size: number;
}

export interface RecoveryOptions {
  checkpointId?: string;
  latest?: boolean;
}

export class CheckpointRecovery extends EventEmitter {
  private config: CheckpointConfig;
  private checkpoints: Map<string, Checkpoint> = new Map();
  private sessionCheckpoints: Map<string, string[]> = new Map();
  private currentSessionId: string | null = null;
  private currentState: Record<string, any> = {};
  private autoSaveTimer: NodeJS.Timeout | null = null;
  private isInitialized: boolean = false;

  constructor(config: Partial<CheckpointConfig> = {}) {
    super();
    this.config = {
      storageDirectory: config.storageDirectory ?? './data/checkpoints',
      maxCheckpoints: config.maxCheckpoints ?? 50,
      autoSave: config.autoSave ?? true,
      autoSaveInterval: config.autoSaveInterval ?? 60000,
    };
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      if (!fs.existsSync(this.config.storageDirectory)) {
        fs.mkdirSync(this.config.storageDirectory, { recursive: true });
      }

      await this.loadCheckpointIndex();
      this.isInitialized = true;

      if (this.config.autoSave) {
        this.startAutoSave();
      }

      log.info('Checkpoint system initialized');
    } catch (error) {
      log.error('Checkpoint initialization failed:', error);
      throw error;
    }
  }

  private async loadCheckpointIndex(): Promise<void> {
    const indexPath = path.join(this.config.storageDirectory, 'index.json');
    
    if (fs.existsSync(indexPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        
        for (const metadata of data.checkpoints) {
          const checkpoint = await this.loadCheckpointFile(metadata.id);
          if (checkpoint) {
            this.checkpoints.set(metadata.id, checkpoint);
            
            const sessionList = this.sessionCheckpoints.get(metadata.sessionId) ?? [];
            sessionList.push(metadata.id);
            this.sessionCheckpoints.set(metadata.sessionId, sessionList);
          }
        }
      } catch (error) {
        log.warn('Failed to load checkpoint index:', error);
      }
    }
  }

  private async loadCheckpointFile(id: string): Promise<Checkpoint | null> {
    const filePath = path.join(this.config.storageDirectory, `${id}.json`);
    
    if (!fs.existsSync(filePath)) return null;

    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return data;
    } catch (error) {
      log.error(`Failed to load checkpoint ${id}:`, error);
      return null;
    }
  }

  startSession(sessionId: string, initialState?: Record<string, any>): void {
    this.currentSessionId = sessionId;
    this.currentState = initialState ?? {};
    
    log.info(`Started session: ${sessionId}`);
    this.emit('session:started', sessionId);
  }

  updateState(state: Record<string, any>): void {
    this.currentState = { ...this.currentState, ...state };
    this.emit('state:updated', this.currentState);
  }

  getState(): Record<string, any> {
    return { ...this.currentState };
  }

  async saveCheckpoint(description: string, options: {
    tags?: string[];
    parentId?: string;
    force?: boolean;
  } = {}): Promise<string> {
    if (!this.currentSessionId) {
      throw new Error('No active session');
    }

    const id = randomUUID();
    const checkpoint: Checkpoint = {
      id,
      sessionId: this.currentSessionId,
      description,
      state: JSON.parse(JSON.stringify(this.currentState)),
      timestamp: Date.now(),
      parentId: options.parentId,
      tags: options.tags ?? [],
    };

    await this.saveCheckpointFile(checkpoint);
    this.checkpoints.set(id, checkpoint);

    const sessionList = this.sessionCheckpoints.get(this.currentSessionId) ?? [];
    sessionList.push(id);
    this.sessionCheckpoints.set(this.currentSessionId, sessionList);

    await this.pruneOldCheckpoints();
    await this.saveCheckpointIndex();

    log.info(`Checkpoint saved: ${id} - ${description}`);
    this.emit('checkpoint:saved', { id, description });

    return id;
  }

  private async saveCheckpointFile(checkpoint: Checkpoint): Promise<void> {
    const filePath = path.join(this.config.storageDirectory, `${checkpoint.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(checkpoint, null, 2));
  }

  async loadCheckpoint(checkpointId: string): Promise<Record<string, any> | null> {
    const checkpoint = this.checkpoints.get(checkpointId);
    
    if (!checkpoint) {
      const loaded = await this.loadCheckpointFile(checkpointId);
      if (!loaded) return null;
      return loaded.state;
    }

    return checkpoint.state;
  }

  async recover(options: RecoveryOptions): Promise<Record<string, any> | null> {
    let checkpointId: string | null = null;

    if (options.checkpointId) {
      checkpointId = options.checkpointId;
    } else if (options.latest) {
      checkpointId = await this.getLatestCheckpointId();
    } else {
      checkpointId = await this.getLatestCheckpointId();
    }

    if (!checkpointId) {
      log.warn('No checkpoint found for recovery');
      return null;
    }

    const state = await this.loadCheckpoint(checkpointId);
    if (state) {
      this.currentState = state;
      log.info(`Recovered from checkpoint: ${checkpointId}`);
      this.emit('recovered', { checkpointId, state });
    }

    return state;
  }

  async getLatestCheckpointId(): Promise<string | null> {
    if (!this.currentSessionId) return null;

    const sessionList = this.sessionCheckpoints.get(this.currentSessionId) ?? [];
    if (sessionList.length === 0) return null;

    return sessionList[sessionList.length - 1];
  }

  async getCheckpointHistory(sessionId?: string): Promise<CheckpointMetadata[]> {
    const targetSession = sessionId ?? this.currentSessionId;
    
    if (!targetSession) return [];

    const sessionList = this.sessionCheckpoints.get(targetSession) ?? [];
    const metadata: CheckpointMetadata[] = [];

    for (const id of sessionList) {
      const checkpoint = this.checkpoints.get(id);
      if (checkpoint) {
        const filePath = path.join(this.config.storageDirectory, `${id}.json`);
        const size = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;

        metadata.push({
          id: checkpoint.id,
          sessionId: checkpoint.sessionId,
          description: checkpoint.description,
          timestamp: checkpoint.timestamp,
          parentId: checkpoint.parentId,
          tags: checkpoint.tags,
          size,
        });
      }
    }

    return metadata;
  }

  async deleteCheckpoint(checkpointId: string): Promise<boolean> {
    const checkpoint = this.checkpoints.get(checkpointId);
    
    if (!checkpoint) return false;

    const filePath = path.join(this.config.storageDirectory, `${checkpointId}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    this.checkpoints.delete(checkpointId);

    const sessionList = this.sessionCheckpoints.get(checkpoint.sessionId) ?? [];
    const filtered = sessionList.filter(id => id !== checkpointId);
    this.sessionCheckpoints.set(checkpoint.sessionId, filtered);

    await this.saveCheckpointIndex();
    
    log.info(`Checkpoint deleted: ${checkpointId}`);
    return true;
  }

  async rollback(checkpointId: string): Promise<boolean> {
    const state = await this.loadCheckpoint(checkpointId);
    
    if (!state) return false;

    this.currentState = state;
    
    await this.saveCheckpoint(`Rollback to ${checkpointId}`, { tags: ['rollback'] });
    
    log.info(`Rolled back to: ${checkpointId}`);
    this.emit('rolledback', { checkpointId });
    
    return true;
  }

  private async pruneOldCheckpoints(): Promise<void> {
    if (!this.currentSessionId) return;

    const sessionList = this.sessionCheckpoints.get(this.currentSessionId) ?? [];
    
    if (sessionList.length <= this.config.maxCheckpoints) return;

    const toDelete = sessionList.slice(0, sessionList.length - this.config.maxCheckpoints);
    
    for (const id of toDelete) {
      const filePath = path.join(this.config.storageDirectory, `${id}.json`);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      this.checkpoints.delete(id);
    }

    this.sessionCheckpoints.set(
      this.currentSessionId,
      sessionList.slice(-this.config.maxCheckpoints)
    );
  }

  private async saveCheckpointIndex(): Promise<void> {
    const metadata: CheckpointMetadata[] = [];
    
    for (const [id, checkpoint] of this.checkpoints) {
      const filePath = path.join(this.config.storageDirectory, `${id}.json`);
      const size = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;

      metadata.push({
        id: checkpoint.id,
        sessionId: checkpoint.sessionId,
        description: checkpoint.description,
        timestamp: checkpoint.timestamp,
        parentId: checkpoint.parentId,
        tags: checkpoint.tags,
        size,
      });
    }

    const indexPath = path.join(this.config.storageDirectory, 'index.json');
    fs.writeFileSync(indexPath, JSON.stringify({ checkpoints: metadata }, null, 2));
  }

  private startAutoSave(): void {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
    }

    this.autoSaveTimer = setInterval(async () => {
      if (this.currentSessionId && Object.keys(this.currentState).length > 0) {
        await this.saveCheckpoint('Auto-save', { tags: ['auto-save'] });
      }
    }, this.config.autoSaveInterval);
  }

  stopAutoSave(): void {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
  }

  async exportCheckpoint(checkpointId: string, destination: string): Promise<boolean> {
    const checkpoint = this.checkpoints.get(checkpointId);
    
    if (!checkpoint) return false;

    try {
      fs.writeFileSync(destination, JSON.stringify(checkpoint, null, 2));
      log.info(`Checkpoint exported: ${checkpointId} -> ${destination}`);
      return true;
    } catch (error) {
      log.error('Failed to export checkpoint:', error);
      return false;
    }
  }

  async importCheckpoint(source: string): Promise<string | null> {
    try {
      const data = JSON.parse(fs.readFileSync(source, 'utf-8'));
      
      if (!data.id || !data.state) {
        throw new Error('Invalid checkpoint format');
      }

      const newId = randomUUID();
      const checkpoint: Checkpoint = {
        ...data,
        id: newId,
        timestamp: Date.now(),
      };

      await this.saveCheckpointFile(checkpoint);
      this.checkpoints.set(newId, checkpoint);

      const sessionList = this.sessionCheckpoints.get(checkpoint.sessionId) ?? [];
      sessionList.push(newId);
      this.sessionCheckpoints.set(checkpoint.sessionId, sessionList);

      await this.saveCheckpointIndex();
      
      log.info(`Checkpoint imported: ${newId}`);
      return newId;
    } catch (error) {
      log.error('Failed to import checkpoint:', error);
      return null;
    }
  }

  async clearSession(sessionId?: string): Promise<void> {
    const targetSession = sessionId ?? this.currentSessionId;
    
    if (!targetSession) return;

    const sessionList = this.sessionCheckpoints.get(targetSession) ?? [];
    
    for (const id of sessionList) {
      const filePath = path.join(this.config.storageDirectory, `${id}.json`);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      this.checkpoints.delete(id);
    }

    this.sessionCheckpoints.delete(targetSession);
    await this.saveCheckpointIndex();
    
    log.info(`Session cleared: ${targetSession}`);
  }

  getSessionCheckpoints(): CheckpointMetadata[] {
    if (!this.currentSessionId) return [];
    return this.sessionCheckpoints.get(this.currentSessionId)?.map(id => {
      const checkpoint = this.checkpoints.get(id);
      if (!checkpoint) return null;
      
      return {
        id: checkpoint.id,
        sessionId: checkpoint.sessionId,
        description: checkpoint.description,
        timestamp: checkpoint.timestamp,
        parentId: checkpoint.parentId,
        tags: checkpoint.tags,
        size: 0,
      };
    }).filter(Boolean) as CheckpointMetadata[] ?? [];
  }

  getCurrentSession(): string | null {
    return this.currentSessionId;
  }

  getStatus(): { initialized: boolean; sessionId: string | null; checkpointCount: number } {
    return {
      initialized: this.isInitialized,
      sessionId: this.currentSessionId,
      checkpointCount: this.checkpoints.size,
    };
  }
}

export const createCheckpointRecovery = (config?: Partial<CheckpointConfig>): CheckpointRecovery => {
  return new CheckpointRecovery(config);
};

export default CheckpointRecovery;