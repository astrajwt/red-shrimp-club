import * as vscode from 'vscode';
import type { AuthTokens, User } from '../api/types';

const ACCESS_TOKEN_KEY = 'redShrimp.accessToken';
const REFRESH_TOKEN_KEY = 'redShrimp.refreshToken';
const USER_KEY = 'redShrimp.user';

export class AuthManager {
  private _onDidChange = new vscode.EventEmitter<boolean>();
  readonly onDidChange = this._onDidChange.event;
  private user: User | undefined;

  constructor(private secrets: vscode.SecretStorage, private globalState: vscode.Memento) {
    const saved = globalState.get<User>(USER_KEY);
    if (saved) { this.user = saved; }
  }

  get isAuthenticated(): boolean {
    return !!this.user;
  }

  getUser(): User | undefined {
    return this.user;
  }

  async getAccessToken(): Promise<string | undefined> {
    return this.secrets.get(ACCESS_TOKEN_KEY);
  }

  private get serverUrl(): string {
    return vscode.workspace.getConfiguration('redShrimp').get('serverUrl', 'http://localhost:3001');
  }

  async login(identity: string): Promise<User> {
    const res = await fetch(`${this.serverUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Login failed (${res.status}): ${body}`);
    }

    const data = await res.json() as AuthTokens;
    await this.secrets.store(ACCESS_TOKEN_KEY, data.accessToken);
    await this.secrets.store(REFRESH_TOKEN_KEY, data.refreshToken);
    this.user = data.user;
    await this.globalState.update(USER_KEY, data.user);
    vscode.commands.executeCommand('setContext', 'redShrimp.authenticated', true);
    this._onDidChange.fire(true);
    return data.user;
  }

  async tryRefresh(): Promise<boolean> {
    const refreshToken = await this.secrets.get(REFRESH_TOKEN_KEY);
    if (!refreshToken) { return false; }

    try {
      const res = await fetch(`${this.serverUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) { return false; }
      const data = await res.json() as { accessToken: string; refreshToken: string };
      await this.secrets.store(ACCESS_TOKEN_KEY, data.accessToken);
      await this.secrets.store(REFRESH_TOKEN_KEY, data.refreshToken);
      return true;
    } catch {
      return false;
    }
  }

  async logout(): Promise<void> {
    await this.secrets.delete(ACCESS_TOKEN_KEY);
    await this.secrets.delete(REFRESH_TOKEN_KEY);
    this.user = undefined;
    await this.globalState.update(USER_KEY, undefined);
    vscode.commands.executeCommand('setContext', 'redShrimp.authenticated', false);
    this._onDidChange.fire(false);
  }

  async restoreSession(): Promise<boolean> {
    const token = await this.secrets.get(ACCESS_TOKEN_KEY);
    if (token && this.user) {
      vscode.commands.executeCommand('setContext', 'redShrimp.authenticated', true);
      return true;
    }
    return false;
  }
}
