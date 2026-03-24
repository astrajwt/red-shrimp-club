import * as vscode from 'vscode';
import { io, Socket } from 'socket.io-client';
import type { Message } from '../api/types';

export class SocketManager {
  private socket: Socket | null = null;
  private currentChannelId: string | null = null;

  private _onMessage = new vscode.EventEmitter<Message>();
  readonly onMessage = this._onMessage.event;

  private _onAgentStatus = new vscode.EventEmitter<{ agentId: string; status: string; activity?: string }>();
  readonly onAgentStatus = this._onAgentStatus.event;

  private get serverUrl(): string {
    return vscode.workspace.getConfiguration('redShrimp').get('serverUrl', 'http://localhost:3001');
  }

  connect(): void {
    if (this.socket?.connected) { return; }

    this.socket = io(this.serverUrl, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 2000,
    });

    this.socket.on('message', (msg: Message) => {
      this._onMessage.fire(msg);
    });

    this.socket.on('agent:started', (data: { agentId: string }) => {
      this._onAgentStatus.fire({ agentId: data.agentId, status: 'running' });
    });

    this.socket.on('agent:stopped', (data: { agentId: string }) => {
      this._onAgentStatus.fire({ agentId: data.agentId, status: 'offline' });
    });

    this.socket.on('agent:crashed', (data: { agentId: string }) => {
      this._onAgentStatus.fire({ agentId: data.agentId, status: 'error' });
    });

    this.socket.on('agent:activity', (data: { agentId: string; activity: string }) => {
      this._onAgentStatus.fire({ agentId: data.agentId, status: 'running', activity: data.activity });
    });
  }

  joinChannel(channelId: string): void {
    if (this.currentChannelId) {
      this.socket?.emit('leave:channel', this.currentChannelId);
    }
    this.currentChannelId = channelId;
    this.socket?.emit('join:channel', channelId);
  }

  disconnect(): void {
    if (this.currentChannelId) {
      this.socket?.emit('leave:channel', this.currentChannelId);
    }
    this.socket?.disconnect();
    this.socket = null;
    this.currentChannelId = null;
  }

  dispose(): void {
    this.disconnect();
    this._onMessage.dispose();
    this._onAgentStatus.dispose();
  }
}
