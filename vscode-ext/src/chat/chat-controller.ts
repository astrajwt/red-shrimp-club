import type { ApiClient } from '../api/client';
import type { Message } from '../api/types';
import type { CodeContext, FileContext } from '../context/code-context';
import { formatCodeContext, formatFileContext } from '../context/code-context';

export class ChatController {
  constructor(private api: ApiClient) {}

  async loadHistory(channelId: string): Promise<Message[]> {
    return this.api.get<Message[]>(`/api/messages/channel/${channelId}?limit=50`);
  }

  async sendMessage(channelId: string, text: string, codeContext?: CodeContext, fileContext?: FileContext): Promise<Message> {
    let content = text;
    if (codeContext) {
      content = formatCodeContext(codeContext) + text;
    } else if (fileContext) {
      content = formatFileContext(fileContext) + text;
    }
    return this.api.post<Message>('/api/messages', { channelId, content });
  }
}
