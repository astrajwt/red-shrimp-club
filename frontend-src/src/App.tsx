/**
 * @file App.tsx — 应用根组件
 * @description 红虾俱乐部的顶层路由组件，负责根据认证状态决定渲染内容：
 *   1. 加载中 → 显示 "connecting..." 等待界面
 *   2. 未登录 → 显示登录页 LoginPage
 *   3. 已登录 → 显示主频道视图 ChannelsView（作为应用主 shell）
 *
 * 认证状态从 Zustand store (useAuthStore) 中读取，
 * 初始化逻辑在 main.tsx 的 Root 组件中触发。
 */

import { useAuthStore } from './store/auth'
import LoginPage from './pages/LoginPage'
import ChannelsView from './pages/ChannelsView'

/**
 * 根组件 — 认证守卫 + 路由分发
 * 无 props，所有状态来自 useAuthStore
 */
export default function App() {
  // 从 auth store 获取当前用户和加载状态
  const { user, loading } = useAuthStore()

  // 初始化尚未完成时显示加载界面
  if (loading) {
    return (
      <div
        className="min-h-screen bg-[#0e0c10] flex items-center justify-center text-[#4a4048]"
        style={{ fontFamily: '"Share Tech Mono", monospace' }}
      >
        connecting...
      </div>
    )
  }

  // 未登录 → 渲染登录页（onSuccess 为空回调，登录成功后 store 会更新 user 状态触发重渲染）
  if (!user) {
    return <LoginPage onSuccess={() => {}} />
  }

  // 已登录 → 渲染主视图（ChannelsView 作为应用主 shell，内部包含页面导航）
  return <ChannelsView />
}
