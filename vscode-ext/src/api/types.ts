export interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  created_at: string;
}

export interface Agent {
  id: string;
  name: string;
  description: string | null;
  model_provider: string;
  model_id: string;
  status: 'idle' | 'running' | 'online' | 'offline' | 'error' | 'starting' | 'sleeping';
  activity: string | null;
  activity_detail: string | null;
  last_heartbeat_at: string | null;
  workspace_path: string | null;
  role: string | null;
}

export interface Channel {
  id: string;
  name: string;
  type: 'dm' | 'channel';
  display_name: string;
  joined: boolean;
}

export interface MessageAttachment {
  file_id: string;
  filename: string;
  mime_type: string;
  size: number;
  url: string;
}

export interface MessageMention {
  id: string;
  name: string;
  type: 'agent' | 'human';
}

export interface Message {
  id: string;
  channel_id: string;
  sender_id: string;
  sender_type: 'human' | 'agent';
  sender_name: string;
  content: string;
  seq: number;
  attachments?: MessageAttachment[];
  mentions?: MessageMention[];
  thinking?: string | null;
  created_at: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  user: User;
}

export interface VaultEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: VaultEntry[];
}
