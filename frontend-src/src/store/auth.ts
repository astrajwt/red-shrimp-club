// Red Shrimp Lab — Auth Store (Zustand)

import { create } from 'zustand'
import { authApi, tokenStore, type User } from '../lib/api'
import { socketClient } from '../lib/socket'

const AUTO_LOGIN_IDENTITY = import.meta.env.VITE_AUTO_LOGIN_IDENTITY?.trim() || ''
const AUTO_LOGIN_NAME = import.meta.env.VITE_AUTO_LOGIN_NAME?.trim() || ''
const AUTO_LOGIN_ENABLED = Boolean(import.meta.env.DEV && AUTO_LOGIN_IDENTITY)

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
    set({ loading: true })

    try {
      const user = await authApi.me()
      set({ user, loading: false })
      socketClient.connect()
      return
    } catch {
      tokenStore.clear()
    }

    try {
      if (!AUTO_LOGIN_ENABLED) throw new Error('auto-login disabled')
      let auth
      try {
        auth = await authApi.login(AUTO_LOGIN_IDENTITY)
      } catch {
        auth = await authApi.register(AUTO_LOGIN_IDENTITY, AUTO_LOGIN_NAME || AUTO_LOGIN_IDENTITY)
      }
      tokenStore.set(auth.accessToken, auth.refreshToken)
      set({ user: auth.user, loading: false })
      socketClient.connect()
    } catch {
      tokenStore.clear()
      set({ loading: false })
    }
  },

  login: async (email?: string) => {
    if (!email) throw new Error('Username required')
    const { accessToken, refreshToken, user } = await authApi.login(email)
    tokenStore.set(accessToken, refreshToken)
    set({ user })
    socketClient.connect()
  },

  register: async (email?: string, name?: string) => {
    if (!email) throw new Error('Username required')
    const fallbackName = name?.trim() || email.split('@')[0] || email
    const { accessToken, refreshToken, user } = await authApi.register(email, fallbackName)
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
