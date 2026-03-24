import * as vscode from 'vscode';
import type { AgentSelector } from '../agents/agent-selector';
import type { SocketManager } from '../socket/socket-manager';
import type { ChatController } from './chat-controller';
import type { CodeContext, FileContext } from '../context/code-context';

export class ChatPanel implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private codeContext?: CodeContext;
  private fileContext?: FileContext;

  constructor(
    private extensionUri: vscode.Uri,
    private agentSelector: AgentSelector,
    private socketManager: SocketManager,
    private chatController: ChatController,
  ) {
    socketManager.onMessage(msg => {
      const channel = agentSelector.dmChannel;
      if (channel && msg.channel_id === channel.id) {
        this.postMessage({ type: 'message', message: msg });
      }
    });

    agentSelector.onDidSelect(async ({ channel }) => {
      socketManager.joinChannel(channel.id);
      const history = await this.chatController.loadHistory(channel.id);
      this.postMessage({ type: 'init', messages: history, agent: agentSelector.selectedAgent });
    });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')],
    };
    view.webview.html = this.getHtml(view.webview);

    view.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'send': {
          const channel = this.agentSelector.dmChannel;
          if (!channel) { return; }
          try {
            const sent = await this.chatController.sendMessage(channel.id, msg.text, this.codeContext, this.fileContext);
            this.postMessage({ type: 'message', message: sent });
            this.codeContext = undefined;
            this.postMessage({ type: 'codeContext', context: null });
          } catch (e: any) {
            vscode.window.showErrorMessage(`Send failed: ${e.message}`);
          }
          break;
        }
        case 'selectAgent': {
          await this.agentSelector.showPicker();
          break;
        }
        case 'ready': {
          await this.updateView();
          break;
        }
      }
    });
  }

  setCodeContext(ctx: CodeContext): void {
    this.codeContext = ctx;
    this.postMessage({ type: 'codeContext', context: ctx });
  }

  setFileContext(ctx: FileContext | undefined): void {
    this.fileContext = ctx;
    this.postMessage({ type: 'fileContext', context: ctx || null });
  }

  private async updateView(): Promise<void> {
    const agent = this.agentSelector.selectedAgent;
    const channel = this.agentSelector.dmChannel;
    if (!agent || !channel) {
      this.postMessage({ type: 'showAgentPicker' });
      return;
    }

    const history = await this.chatController.loadHistory(channel.id);
    this.postMessage({ type: 'init', messages: history, agent });
  }

  private postMessage(msg: unknown): void {
    this.view?.webview.postMessage(msg);
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'chat.js')
    );
    const nonce = getNonce();

    return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      --bg: #1a1a2e;
      --surface: #16213e;
      --border: #2a2a4a;
      --text: #e0e0e0;
      --text-muted: #888;
      --accent-red: #e74c3c;
      --accent-gold: #f39c12;
      --input-bg: #0f1929;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
      font-size: 13px;
      background: var(--bg);
      color: var(--text);
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    #agent-picker-view, #chat-view { display: none; flex-direction: column; height: 100%; }
    .active { display: flex !important; }

    /* Agent picker */
    #agent-picker-view { justify-content: center; align-items: center; gap: 12px; padding: 20px; }
    #agent-picker-view button {
      padding: 8px 16px; background: var(--accent-red); color: #fff; border: none;
      border-radius: 4px; cursor: pointer; font-size: 13px;
    }

    /* Chat */
    #messages {
      flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 6px;
    }
    .msg {
      padding: 6px 10px; border-radius: 6px; background: var(--surface);
      border-left: 3px solid var(--border); max-width: 100%; word-wrap: break-word;
    }
    .msg.human { border-left-color: var(--accent-red); }
    .msg.agent { border-left-color: var(--accent-gold); }
    .msg .sender { font-weight: 600; font-size: 12px; margin-bottom: 2px; }
    .msg.human .sender { color: var(--accent-red); }
    .msg.agent .sender { color: var(--accent-gold); }
    .msg .content { white-space: pre-wrap; line-height: 1.5; }
    .msg .time { font-size: 11px; color: var(--text-muted); margin-top: 2px; }

    /* File context bar */
    #file-context {
      padding: 3px 10px; background: #111827; border-bottom: 1px solid var(--border);
      font-size: 11px; color: var(--text-muted); display: none;
    }
    #file-context.visible { display: block; }

    /* Code context banner */
    #code-context {
      display: none; padding: 4px 10px; background: #1e2a3a; border-bottom: 1px solid var(--border);
      font-size: 12px; color: var(--accent-gold); align-items: center; gap: 6px;
    }
    #code-context.visible { display: flex; }
    #code-context .clear { cursor: pointer; margin-left: auto; color: var(--text-muted); }

    /* Input */
    #input-area {
      padding: 8px; border-top: 1px solid var(--border); display: flex; gap: 6px;
    }
    #input-area textarea {
      flex: 1; resize: none; padding: 6px 10px; background: var(--input-bg);
      border: 1px solid var(--border); color: var(--text); border-radius: 4px;
      font-family: inherit; font-size: 13px; min-height: 36px; max-height: 120px;
    }
    #input-area button {
      padding: 6px 12px; background: var(--accent-red); color: #fff; border: none;
      border-radius: 4px; cursor: pointer; align-self: flex-end;
    }
  </style>
</head>
<body>
  <div id="agent-picker-view">
    <h3 style="color:var(--accent-red)">Red Shrimp Lab</h3>
    <p style="color:var(--text-muted)">Choose an agent to start chatting</p>
    <button id="pick-agent-btn">Select Agent</button>
  </div>

  <div id="chat-view">
    <div id="file-context">
      <span id="file-ctx-label"></span>
    </div>
    <div id="code-context">
      <span id="ctx-label"></span>
      <span class="clear" id="ctx-clear">x</span>
    </div>
    <div id="messages"></div>
    <div id="input-area">
      <textarea id="msg-input" placeholder="Type a message..." rows="1"></textarea>
      <button id="send-btn">Send</button>
    </div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
