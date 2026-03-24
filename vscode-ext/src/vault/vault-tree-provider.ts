import * as vscode from 'vscode';
import type { ApiClient } from '../api/client';
import type { VaultEntry } from '../api/types';

export class VaultItem extends vscode.TreeItem {
  constructor(
    public readonly entry: VaultEntry,
  ) {
    super(
      entry.name,
      entry.type === 'directory'
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );

    if (entry.type === 'file') {
      this.command = {
        command: 'redShrimp.previewVaultFile',
        title: 'Preview',
        arguments: [entry.path],
      };
      this.iconPath = new vscode.ThemeIcon('file');
    } else {
      this.iconPath = new vscode.ThemeIcon('folder');
    }

    this.tooltip = entry.path;
  }
}

export class VaultTreeProvider implements vscode.TreeDataProvider<VaultItem> {
  private _onDidChange = new vscode.EventEmitter<VaultItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private api: ApiClient) {}

  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  getTreeItem(element: VaultItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: VaultItem): Promise<VaultItem[]> {
    try {
      const path = element ? element.entry.path : '';
      const entries = await this.api.get<VaultEntry[]>(
        `/api/daemon/obsidian/tree?path=${encodeURIComponent(path)}`
      );
      return entries
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
          return a.name.localeCompare(b.name);
        })
        .map(e => new VaultItem(e));
    } catch {
      return [];
    }
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
