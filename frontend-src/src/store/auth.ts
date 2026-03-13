/**
 * @file auth.ts — Zustand 认证状态管理 Store
 * @description 管理用户认证的全局状态，提供：
 *   1. init() — 应用启动时的认证初始化（token 恢复 / 自动登录）
 *   2. login() / register() — 手动登录和注册
 *   3. logout() — 登出（清除 token + 断开 WebSocket）
 *
 * 状态：
 *   - user: 当前登录用户信息（null 表示未登录）
 *   - loading: 初始化是否完成（true 时显示加载界面）
 *
 * 认证流程：
 *   init() 首先尝试用 localStorage 中的 token 恢复会话，
 *   若无 token 则自动使用预设账号登录（单用户本地部署模式）。
 *   登录成功后自动建立 WebSocket 连接。
 */

import { create } from 'zustand'
import { authApi, tokenStore, type User } from '../lib/api'
import { socketClient } from '../lib/socket'

/** Auth Store 的状态和操作接口定义 */
interface AuthState {
  user: User | null       // 当前用户（null = 未登录）
  loading: boolean        // 初始化进行中标志
  login: (username: string, password: string) => Promise<void>
  register: (username: string, password: string, displayName?: string) => Promise<void>
  logout: () => Promise<void>
  init: () => Promise<void>
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  loading: true,

  /**
   * 认证初始化 — 在 main.tsx 的 Root 组件挂载时调用
   * 流程：
   *   1. 检查 localStorage 中是否有 access token
   *   2. 有 token → 调用 /auth/me 验证有效性
   *   3. 无 token 或验证失败 → 使用预设账号自动登录（先尝试 login，失败则 register）
   *   4. 全部失败 → 设置 loading=false，显示登录页
   */
  init: async () => {
    // 尝试用已有 token 恢复会话
    const token = tokenStore.getAccess()
    if (token) {
      try {
        const { user } = await authApi.me()
        set({ user, loading: false })
        socketClient.connect()
        return
      } catch {
        tokenStore.clear()  // token 无效，清除
      }
    }

    // 自动登录 — 单用户本地部署模式（无需手动注册）
    const AUTO_EMAIL = 'jwt@local.dev'
    const AUTO_PASS  = 'redshrimp'
    const AUTO_NAME  = 'Jwt2077'
    try {
      // 先尝试登录，若用户不存在则自动注册
      let result
      try {
        result = await authApi.login(AUTO_EMAIL, AUTO_PASS)
      } catch {
        result = await authApi.register(AUTO_EMAIL, AUTO_PASS, AUTO_NAME)
      }
      tokenStore.set(result.accessToken, result.refreshToken)
      set({ user: result.user, loading: false })
      socketClient.connect()
    } catch {
      set({ loading: false })  // 自动登录也失败，等待用户手动操作
    }
  },

  /** 手动登录 — 保存 token、更新用户状态、建立 WebSocket 连接 */
  login: async (username, password) => {
    const { accessToken, refreshToken, user } = await authApi.login(username, password)
    tokenStore.set(accessToken, refreshToken)
    set({ user })
    socketClient.connect()
  },

  /** 注册新用户 — 注册成功后自动登录 */
  register: async (username, password, displayName) => {
    const { accessToken, refreshToken, user } = await authApi.register(username, password, displayName)
    tokenStore.set(accessToken, refreshToken)
    set({ user })
    socketClient.connect()
  },

  /** 登出 — 通知服务端 → 清除本地 token → 断开 WebSocket → 清空用户状态 */
  logout: async () => {
    await authApi.logout().catch(() => {})  // 服务端登出失败不影响本地清理
    tokenStore.clear()
    socketClient.disconnect()
    set({ user: null })
  },
}))
