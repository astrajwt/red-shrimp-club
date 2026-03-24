import * as vscode from 'vscode';
import type { Agent, Channel } from '../api/types';
import { ApiClient } from '../api/client';

const SELECTED_AGENT_KEY = 'redShrimp.selectedAgentId';

export class AgentSelector {
  private statusBarItem: vscode.StatusBarItem;
  private _selectedAgent: Agent | undefined;
  private _dmChannel: Channel | undefined;

  private _onDidSelect = new vscode.EventEmitter<{ agent: Agent; channel: Channel }>();
  readonly onDidSelect = this._onDidSelect.event;

  constructor(private api: ApiClient, private workspaceState: vscode.Memento) {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBarItem.command = 'redShrimp.selectAgent';
    this.statusBarItem.tooltip = 'Click to select an agent';
    this.updateStatusBar();
  }

  get selectedAgent(): Agent | undefined { return this._selectedAgent; }
  get dmChannel(): Channel | undefined { return this._dmChannel; }

  async showPicker(): Promise<void> {
    const agents = await this.api.get<Agent[]>('/api/agents');
    const items = agents.map(a => ({
      label: a.name,
      description: `${a.model_provider}/${a.model_id}`,
      detail: statusIcon(a.status) + ' ' + (a.activity || a.status),
      agent: a,
    }));

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select an agent to chat with',
    });

    if (picked) {
      await this.selectAgent(picked.agent);
    }
  }

  async selectAgent(agent: Agent): Promise<void> {
    this._selectedAgent = agent;
    await this.workspaceState.update(SELECTED_AGENT_KEY, agent.id);

    // Open or get DM channel
    this._dmChannel = await this.api.post<Channel>('/api/channels/dm', { agentId: agent.id });
    this.updateStatusBar();
    this._onDidSelect.fire({ agent, channel: this._dmChannel });
  }

  async restore(): Promise<void> {
    const savedId = this.workspaceState.get<string>(SELECTED_AGENT_KEY);
    if (!savedId) { return; }

    try {
      const agents = await this.api.get<Agent[]>('/api/agents');
      const agent = agents.find(a => a.id === savedId);
      if (agent) {
        await this.selectAgent(agent);
      }
    } catch {
      // silently fail on restore
    }
  }

  updateAgentStatus(agentId: string, status: string, activity?: string): void {
    if (this._selectedAgent?.id === agentId) {
      this._selectedAgent.status = status as Agent['status'];
      if (activity !== undefined) { this._selectedAgent.activity = activity; }
      this.updateStatusBar();
    }
  }

  private updateStatusBar(): void {
    if (this._selectedAgent) {
      const icon = statusIcon(this._selectedAgent.status);
      this.statusBarItem.text = `${icon} ${this._selectedAgent.name}`;
      this.statusBarItem.show();
    } else {
      this.statusBarItem.text = '$(comment-discussion) Select Agent';
      this.statusBarItem.show();
    }
  }

  dispose(): void {
    this.statusBarItem.dispose();
    this._onDidSelect.dispose();
  }
}

function statusIcon(status: string): string {
  switch (status) {
    case 'running': case 'online': return '$(circle-filled)';
    case 'idle': case 'sleeping': return '$(circle-outline)';
    case 'error': case 'crashed': return '$(error)';
    default: return '$(circle-outline)';
  }
}
