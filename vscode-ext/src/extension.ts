import * as vscode from 'vscode';
import { ApiClient } from './api/client';
import { SocketManager } from './socket/socket-manager';
import { AgentSelector } from './agents/agent-selector';
import { ChatController } from './chat/chat-controller';
import { ChatPanel } from './chat/chat-panel';
import { VaultTreeProvider } from './vault/vault-tree-provider';
import { VaultPreview } from './vault/vault-preview';
import { captureCodeContext, captureFileContext } from './context/code-context';

export function activate(context: vscode.ExtensionContext) {
  const api = new ApiClient();
  const socketManager = new SocketManager();
  const agentSelector = new AgentSelector(api, context.workspaceState);
  const chatController = new ChatController(api);
  const vaultTree = new VaultTreeProvider(api);
  const vaultPreview = new VaultPreview(api);

  // Chat panel (panel area - right side)
  const chatPanel = new ChatPanel(
    context.extensionUri, agentSelector, socketManager, chatController,
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('redShrimp.chatView', chatPanel),
  );

  // Vault tree view
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('redShrimp.vaultView', vaultTree),
  );

  // Update agent status from socket
  socketManager.onAgentStatus(({ agentId, status, activity }) => {
    agentSelector.updateAgentStatus(agentId, status, activity);
  });

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('redShrimp.selectAgent', () => {
      agentSelector.showPicker();
    }),

    vscode.commands.registerCommand('redShrimp.sendSelection', () => {
      const ctx = captureCodeContext();
      if (ctx) {
        chatPanel.setCodeContext(ctx);
        vscode.commands.executeCommand('redShrimp.chatView.focus');
      } else {
        vscode.window.showWarningMessage('No text selected');
      }
    }),

    vscode.commands.registerCommand('redShrimp.refreshVault', () => {
      vaultTree.refresh();
    }),

    vscode.commands.registerCommand('redShrimp.previewVaultFile', (filePath: string) => {
      vaultPreview.openPreview(filePath);
    }),
  );

  // Track active editor → push file context to chat panel
  const pushFileContext = () => {
    const fileCtx = captureFileContext();
    chatPanel.setFileContext(fileCtx);
  };
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => pushFileContext()),
    vscode.window.onDidChangeTextEditorSelection(() => pushFileContext()),
  );
  pushFileContext();

  // Connect socket on startup
  socketManager.connect();
  agentSelector.restore();

  context.subscriptions.push({
    dispose() {
      socketManager.dispose();
      agentSelector.dispose();
      vaultTree.dispose();
    },
  });
}

export function deactivate() {}
