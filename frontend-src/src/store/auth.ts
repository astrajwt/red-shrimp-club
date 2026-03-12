// Red Shrimp Lab — Auth Store (Zustand)

import { create } from 'zustand'
import { authApi, tokenStore, type User } from '../lib/api'
import { socketClient } from '../lib/socket'

interface AuthState {
  user: User | null
  loading: boolean
  login: (username: string, password: string) => Promise<void>
  register: (username: string, password: string, displayName?: string) => Promise<void>
  logout: () => Promise<void>
  init: () => Promise<void>
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  loading: true,

  init: async () => {
    // Try existing token first
    const token = tokenStore.getAccess()
    if (token) {
      try {
        const user = await authApi.me()
        set({ user, loading: false })
        socketClient.connect()
        return
      } catch {
        tokenStore.clear()
      }
    }

    // Auto-login for single-user local deployment
    const AUTO_EMAIL = 'jwt@local.dev'
    const AUTO_PASS  = 'redshrimp'
    const AUTO_NAME  = 'Jwt2077'
    try {
      // Try login first, register if not exists
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
      set({ loading: false })
    }
  },

  login: async (username, password) => {
    const { accessToken, refreshToken, user } = await authApi.login(username, password)
    tokenStore.set(accessToken, refreshToken)
    set({ user })
    socketClient.connect()
  },

  register: async (username, password, displayName) => {
    const { accessToken, refreshToken, user } = await authApi.register(username, password, displayName)
    tokenStore.set(accessToken, refreshToken)
    set({ user })
    socketClient.connect()
  },

  logout: async () => {
    await authApi.logout().catch(() => {})
    tokenStore.clear()
    socketClient.disconnect()
    set({ user: null })
  },
}))
