// Red Shrimp Lab — Auth Store (Zustand)

import { create } from 'zustand'
import { authApi, tokenStore, type User } from '../lib/api'
import { socketClient } from '../lib/socket'

interface AuthState {
  user: User | null
  loading: boolean
  login: (_username?: string) => Promise<void>
  register: (_username?: string, _displayName?: string) => Promise<void>
  logout: () => Promise<void>
  init: () => Promise<void>
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  loading: true,

  init: async () => {
    try {
      const user = await authApi.me()
      set({ user, loading: false })
      socketClient.connect()
    } catch {
      tokenStore.clear()
      set({ loading: false })
    }
  },

  login: async () => {
    const user = await authApi.me()
    set({ user })
    socketClient.connect()
  },

  register: async () => {
    const user = await authApi.me()
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
