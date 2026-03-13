/**
 * @file main.tsx — React 应用入口
 * @description 前端应用的启动文件，职责：
 *   1. 挂载 React 根节点到 DOM (#root)
 *   2. 在 Root 组件中触发 auth store 的初始化（自动登录 / token 校验）
 *   3. 启用 StrictMode 进行开发时的额外检查
 *
 * 初始化流程：Root mount → useEffect 调用 init() → 尝试 token 恢复或自动登录 → App 渲染
 */

import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import { useAuthStore } from './store/auth'

/**
 * Root 包装组件 — 负责在首次挂载时触发认证初始化
 * init() 会尝试用 localStorage 中的 token 恢复会话，
 * 若无 token 则自动登录本地开发账号（单用户部署模式）
 */
function Root() {
  const init = useAuthStore(s => s.init)
  useEffect(() => { init() }, [])
  return <App />
}

// 将 React 应用挂载到 HTML 中的 #root 节点
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>
)
