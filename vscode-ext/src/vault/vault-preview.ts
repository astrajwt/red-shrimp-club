import * as vscode from 'vscode';
import { marked } from 'marked';
import type { ApiClient } from '../api/client';

export class VaultPreview {
  constructor(private api: ApiClient) {}

  async openPreview(filePath: string): Promise<void> {
    const content = await this.api.get<{ content: string }>(
      `/api/daemon/obsidian/file?path=${encodeURIComponent(filePath)}`
    );

    const panel = vscode.window.createWebviewPanel(
      'redShrimp.vaultPreview',
      filePath.split('/').pop() || 'Preview',
      vscode.ViewColumn.One,
      { enableScripts: false },
    );

    const htmlContent = await marked.parse(content.content || '');

    panel.webview.html = /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <style>
    body {
      font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
      font-size: 14px;
      color: #e0e0e0;
      background: #1a1a2e;
      padding: 20px;
      line-height: 1.6;
    }
    h1, h2, h3 { color: #e74c3c; margin-top: 1.2em; }
    a { color: #f39c12; }
    code {
      background: #0f1929;
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 13px;
    }
    pre {
      background: #0f1929;
      padding: 12px;
      border-radius: 6px;
      overflow-x: auto;
      border: 1px solid #2a2a4a;
    }
    pre code { padding: 0; background: none; }
    blockquote {
      border-left: 3px solid #f39c12;
      padding-left: 12px;
      color: #aaa;
      margin: 8px 0;
    }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #2a2a4a; padding: 6px 10px; text-align: left; }
    th { background: #16213e; }
    img { max-width: 100%; }
    hr { border: none; border-top: 1px solid #2a2a4a; margin: 16px 0; }
  </style>
</head>
<body>${htmlContent}</body>
</html>`;
  }
}
