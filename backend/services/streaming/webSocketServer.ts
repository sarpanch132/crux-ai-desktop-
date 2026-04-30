import { EventEmitter } from 'events';
import { createServer, Server, IncomingMessage } from 'http';
import { WebSocket, WebSocketServer as WSServer } from 'ws';
import { randomUUID } from 'crypto';
import log from 'electron-log';
import * as url from 'url';

export interface WebSocketConfig {
  port: number;
  host: string;
  path?: string;
  pingInterval: number;
  pingTimeout: number;
  maxPayload: number;
}

export interface Client {
  id: string;
  socket: WebSocket;
  metadata: Record<string, any>;
  connectedAt: number;
  last Activity: number;
}

export interface Message {
  type: string;
  payload: any;
  clientId?: string;
  timestamp?: number;
}

export interface Room {
  id: string;
  clients: Set<string>;
  metadata: Record<string, any>;
}

export class WebSocketServer extends EventEmitter {
  private server: Server | null = null;
  private wss: WSServer | null = null;
  private config: WebSocketConfig;
  private clients: Map<string, Client> = new Map();
  private rooms: Map<string, Room> = new Map();
  private pingInterval: NodeJS.Timeout | null = null;
  private isInitialized: boolean = false;

  constructor(config: Partial<WebSocketConfig> = {}) {
    super();
    this.config = {
      port: config.port ?? 8080,
      host: config.host ?? 'localhost',
      path: config.path,
      pingInterval: config.pingInterval ?? 30000,
      pingTimeout: config.pingTimeout ?? 5000,
      maxPayload: config.maxPayload ?? 10 * 1024 * 1024,
    };
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      this.server = createServer();
      
      this.wss = new WSServer({
        server: this.server,
        path: this.config.path,
        maxPayload: this.config.maxPayload,
      });

      this.wss.on('connection', (socket, request) => {
        this.handleConnection(socket, request);
      });

      this.wss.on('error', (error) => {
        log.error('WebSocket server error:', error);
        this.emit('error', error);
      });

      this.server.listen(this.config.port, this.config.host, () => {
        log.info(`WebSocket server listening on ${this.config.host}:${this.config.port}`);
      });

      this.startPingInterval();
      this.isInitialized = true;
      
      this.emit('initialized');
    } catch (error) {
      log.error('WebSocket initialization failed:', error);
      throw error;
    }
  }

  private handleConnection(socket: WebSocket, request: IncomingMessage): void {
    const clientId = randomUUID();
    const parsedUrl = url.parse(request.url ?? '', true);
    
    const client: Client = {
      id: clientId,
      socket,
      metadata: {
        query: parsedUrl.query,
        headers: request.headers,
      },
      connectedAt: Date.now(),
      last Activity: Date.now(),
    };

    this.clients.set(clientId, client);

    socket.on('message', (data) => {
      this.handleMessage(clientId, data);
    });

    socket.on('pong', () => {
      client.last Activity = Date.now();
    });

    socket.on('close', (code, reason) => {
      this.handleDisconnect(clientId, code, reason.toString());
    });

    socket.on('error', (error) => {
      log.error(`Client ${clientId} error:`, error);
      this.emit('client:error', { clientId, error });
    });

    log.info(`Client connected: ${clientId}`);
    this.emit('client:connected', { clientId, metadata: client.metadata });
  }

  private handleMessage(clientId: string, data: WebSocket.Data): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    client.last Activity = Date.now();

    try {
      const message: Message = JSON.parse(data.toString());
      message.timestamp = Date.now();
      message.clientId = clientId;

      switch (message.type) {
        case 'join':
          this.joinRoom(clientId, message.payload.roomId);
          break;
        
        case 'leave':
          this.leaveRoom(clientId, message.payload.roomId);
          break;
        
        case 'room:message':
          this.broadcastToRoom(clientId, message.payload.roomId, {
            type: 'room:message',
            payload: message.payload,
            clientId,
            timestamp: message.timestamp,
          }, { exclude: clientId });
          break;
        
        case 'ping':
          this.sendToClient(clientId, { type: 'pong', payload: { timestamp: message.timestamp } });
          break;
        
        default:
          this.emit('message', message);
      }
    } catch (error) {
      log.error(`Failed to handle message from ${clientId}:`, error);
    }
  }

  private handleDisconnect(clientId: string, code: number, reason: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    for (const [, room] of this.rooms) {
      if (room.clients.has(clientId)) {
        room.clients.delete(clientId);
        this.broadcastToRoom(clientId, room.id, {
          type: 'client:left',
          payload: { clientId, roomId: room.id, reason },
        }, { exclude: clientId });
      }
    }

    this.clients.delete(clientId);
    
    log.info(`Client disconnected: ${clientId} (code: ${code})`);
    this.emit('client:disconnected', { clientId, code, reason });
  }

  sendToClient(clientId: string, message: Message): boolean {
    const client = this.clients.get(clientId);
    if (!client || client.socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      client.socket.send(JSON.stringify(message));
      return true;
    } catch (error) {
      log.error(`Failed to send message to ${clientId}:`, error);
      return false;
    }
  }

  broadcastToAll(message: Message, options: { exclude?: string[] } = {}): number {
    let sent = 0;
    
    for (const [clientId, client] of this.clients) {
      if (options.exclude?.includes(clientId)) continue;
      if (client.socket.readyState === WebSocket.OPEN) {
        if (this.sendToClient(clientId, message)) sent++;
      }
    }

    return sent;
  }

  broadcastToRoom(roomId: string, message: Message, options: { exclude?: string[] } = {}): number {
    const room = this.rooms.get(roomId);
    if (!room) return 0;

    let sent = 0;
    
    for (const clientId of room.clients) {
      if (options.exclude?.includes(clientId)) continue;
      if (this.sendToClient(clientId, message)) sent++;
    }

    return sent;
  }

  joinRoom(clientId: string, roomId: string): boolean {
    const client = this.clients.get(clientId);
    if (!client) return false;

    let room = this.rooms.get(roomId);
    
    if (!room) {
      room = {
        id: roomId,
        clients: new Set(),
        metadata: {},
      };
      this.rooms.set(roomId, room);
    }

    room.clients.add(clientId);
    
    this.sendToClient(clientId, {
      type: 'joined',
      payload: { roomId },
    });

    log.info(`Client ${clientId} joined room ${roomId}`);
    return true;
  }

  leaveRoom(clientId: string, roomId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;

    room.clients.delete(clientId);
    
    this.sendToClient(clientId, {
      type: 'left',
      payload: { roomId },
    });

    if (room.clients.size === 0) {
      this.rooms.delete(roomId);
    }

    log.info(`Client ${clientId} left room ${roomId}`);
    return true;
  }

  createRoom(roomId: string, metadata?: Record<string, any>): boolean {
    if (this.rooms.has(roomId)) return false;

    this.rooms.set(roomId, {
      id: roomId,
      clients: new Set(),
      metadata: metadata ?? {},
    });

    log.info(`Room created: ${roomId}`);
    return true;
  }

  deleteRoom(roomId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;

    for (const clientId of room.clients) {
      this.sendToClient(clientId, {
        type: 'room:deleted',
        payload: { roomId },
      });
    }

    this.rooms.delete(roomId);
    log.info(`Room deleted: ${roomId}`);
    return true;
  }

  getRoom(roomId: string): Room | null {
    return this.rooms.get(roomId) ?? null;
  }

  getRooms(): string[] {
    return Array.from(this.rooms.keys());
  }

  getClients(): string[] {
    return Array.from(this.clients.keys());
  }

  getClientCount(): number {
    return this.clients.size;
  }

  getRoomClientCount(roomId: string): number {
    const room = this.rooms.get(roomId);
    return room?.clients.size ?? 0;
  }

  private startPingInterval(): void {
    this.pingInterval = setInterval(() => {
      const now = Date.now();
      
      for (const [clientId, client] of this.clients) {
        if (client.socket.readyState !== WebSocket.OPEN) continue;
        
        if (now - client.lastActivity > this.config.pingTimeout + this.config.pingInterval) {
          client.socket.terminate();
          continue;
        }

        client.socket.ping();
      }
    }, this.config.pingInterval);
  }

  async close(): Promise<void> {
    for (const [, client] of this.clients) {
      client.socket.close(1000, 'Server shutting down');
    }

    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    if (this.wss) {
      await new Promise<void>(resolve => {
        this.wss!.close(() => resolve());
      });
      this.wss = null;
    }

    if (this.server) {
      await new Promise<void>(resolve => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }

    this.clients.clear();
    this.rooms.clear();
    this.isInitialized = false;

    log.info('WebSocket server closed');
  }

  getStatus(): { initialized: boolean; clients: number; rooms: number } {
    return {
      initialized: this.isInitialized,
      clients: this.clients.size,
      rooms: this.rooms.size,
    };
  }
}

export const createWebSocketServer = (config?: Partial<WebSocketConfig>): WebSocketServer => {
  return new WebSocketServer(config);
};

export default WebSocketServer;