import { Pool, PoolClient, QueryResult } from 'pg';
import log from 'electron-log';

export interface PostgresConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

export interface QueryOptions {
  params?: any[];
}

export class PostgresMemory {
  private pool: Pool | null = null;
  private config: PostgresConfig;
  private isInitialized: boolean = false;

  constructor(config: Partial<PostgresConfig> = {}) {
    this.config = {
      host: config.host ?? 'localhost',
      port: config.port ?? 5432,
      database: config.database ?? 'opencode',
      user: config.user ?? 'postgres',
      password: config.password ?? 'postgres',
      ssl: config.ssl ?? false,
      max: config.max ?? 10,
      idleTimeoutMillis: config.idleTimeoutMillis ?? 30000,
      connectionTimeoutMillis: config.connectionTimeoutMillis ?? 2000,
    };
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      this.pool = new Pool(this.config);

      const client = await this.pool.connect();
      await this.createTables(client);
      client.release();

      this.isInitialized = true;
      log.info('PostgreSQL memory initialized');
    } catch (error) {
      log.error('PostgreSQL initialization failed:', error);
      throw error;
    }
  }

  private async createTables(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS memories (
        id SERIAL PRIMARY KEY,
        key VARCHAR(500) UNIQUE NOT NULL,
        value TEXT NOT NULL,
        metadata JSONB,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        session_id VARCHAR(100) NOT NULL,
        role VARCHAR(20) NOT NULL,
        content TEXT NOT NULL,
        metadata JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        id SERIAL PRIMARY KEY,
        session_id VARCHAR(100) NOT NULL,
        state JSONB NOT NULL,
        description VARCHAR(500),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_memories_key ON memories(key);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_conversations_session ON conversations(session_id, created_at);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id, created_at);
    `);

    log.info('Memory tables created');
  }

  async setMemory(key: string, value: string, metadata?: Record<string, any>): Promise<void> {
    if (!this.pool) await this.initialize();

    const client = await this.pool!.connect();
    
    await client.query(
      `INSERT INTO memories (key, value, metadata, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (key) DO UPDATE SET
         value = EXCLUDED.value,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()`,
      [key, value, metadata ? JSON.stringify(metadata) : null]
    );

    client.release();
    log.info(`Memory saved: ${key}`);
  }

  async getMemory(key: string): Promise<{ value: string; metadata?: Record<string, any> } | null> {
    if (!this.pool) await this.initialize();

    const client = await this.pool!.connect();
    const result = await client.query(
      'SELECT value, metadata FROM memories WHERE key = $1',
      [key]
    );
    client.release();

    if (result.rows.length === 0) return null;

    return {
      value: result.rows[0].value,
      metadata: result.rows[0].metadata,
    };
  }

  async deleteMemory(key: string): Promise<void> {
    if (!this.pool) await this.initialize();

    const client = await this.pool!.connect();
    await client.query('DELETE FROM memories WHERE key = $1', [key]);
    client.release();
    log.info(`Memory deleted: ${key}`);
  }

  async getAllMemoryKeys(): Promise<string[]> {
    if (!this.pool) await this.initialize();

    const client = await this.pool!.connect();
    const result = await client.query('SELECT key FROM memories');
    client.release();

    return result.rows.map(r => r.key);
  }

  async saveConversation(
    sessionId: string,
    role: 'user' | 'assistant' | 'system',
    content: string,
    metadata?: Record<string, any>
  ): Promise<void> {
    if (!this.pool) await this.initialize();

    const client = await this.pool!.connect();
    await client.query(
      'INSERT INTO conversations (session_id, role, content, metadata) VALUES ($1, $2, $3, $4)',
      [sessionId, role, content, metadata ? JSON.stringify(metadata) : null]
    );
    client.release();
  }

  async getConversation(
    sessionId: string,
    options: { limit?: number; offset?: number } = {}
  ): Promise<{ role: string; content: string; createdAt: Date }[]> {
    if (!this.pool) await this.initialize();

    const { limit = 50, offset = 0 } = options;

    const client = await this.pool!.connect();
    const result = await client.query(
      `SELECT role, content, created_at FROM conversations 
       WHERE session_id = $1 
       ORDER BY created_at DESC 
       LIMIT $2 OFFSET $3`,
      [sessionId, limit, offset]
    );
    client.release();

    return result.rows.map(r => ({
      role: r.role,
      content: r.content,
      createdAt: r.created_at,
    }));
  }

  async clearConversation(sessionId: string): Promise<void> {
    if (!this.pool) await this.initialize();

    const client = await this.pool!.connect();
    await client.query('DELETE FROM conversations WHERE session_id = $1', [sessionId]);
    client.release();
    log.info(`Conversation cleared: ${sessionId}`);
  }

  async saveCheckpoint(
    sessionId: string,
    state: Record<string, any>,
    description?: string
  ): Promise<number> {
    if (!this.pool) await this.initialize();

    const client = await this.pool!.connect();
    const result = await client.query(
      'INSERT INTO checkpoints (session_id, state, description) VALUES ($1, $2, $3) RETURNING id',
      [sessionId, JSON.stringify(state), description ?? null]
    );
    client.release();

    log.info(`Checkpoint saved: ${sessionId}`);
    return result.rows[0].id;
  }

  async getCheckpoint(sessionId: string, checkpointId: number): Promise<Record<string, any> | null> {
    if (!this.pool) await this.initialize();

    const client = await this.pool!.connect();
    const result = await client.query(
      'SELECT state FROM checkpoints WHERE id = $1 AND session_id = $2',
      [checkpointId, sessionId]
    );
    client.release();

    if (result.rows.length === 0) return null;
    return result.rows[0].state;
  }

  async getLatestCheckpoint(sessionId: string): Promise<{ id: number; state: Record<string, any>; createdAt: Date } | null> {
    if (!this.pool) await this.initialize();

    const client = await this.pool!.connect();
    const result = await client.query(
      'SELECT id, state, created_at FROM checkpoints WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1',
      [sessionId]
    );
    client.release();

    if (result.rows.length === 0) return null;

    return {
      id: result.rows[0].id,
      state: result.rows[0].state,
      createdAt: result.rows[0].created_at,
    };
  }

  async getCheckpointHistory(sessionId: string): Promise<{ id: number; description?: string; createdAt: Date }[]> {
    if (!this.pool) await this.initialize();

    const client = await this.pool!.connect();
    const result = await client.query(
      'SELECT id, description, created_at FROM checkpoints WHERE session_id = $1 ORDER BY created_at DESC',
      [sessionId]
    );
    client.release();

    return result.rows.map(r => ({
      id: r.id,
      description: r.description,
      createdAt: r.created_at,
    }));
  }

  async deleteCheckpoint(sessionId: string, checkpointId: number): Promise<void> {
    if (!this.pool) await this.initialize();

    const client = await this.pool!.connect();
    await client.query('DELETE FROM checkpoints WHERE id = $1 AND session_id = $2', [
      checkpointId,
      sessionId,
    ]);
    client.release();
    log.info(`Checkpoint deleted: ${checkpointId}`);
  }

  async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    if (!this.pool) await this.initialize();

    const client = await this.pool!.connect();
    const result = await client.query(sql, params);
    client.release();

    return result.rows as T[];
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.isInitialized = false;
      log.info('PostgreSQL connection closed');
    }
  }

  getStatus(): { initialized: boolean; database: string } {
    return {
      initialized: this.isInitialized,
      database: this.config.database,
    };
  }
}

export const createPostgresMemory = (config?: Partial<PostgresConfig>): PostgresMemory => {
  return new PostgresMemory(config);
};

export default PostgresMemory;