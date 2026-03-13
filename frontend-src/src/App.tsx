// Red Shrimp Lab — App (auto-login, top horizontal navigation)

import { useEffect, useState } from 'react'
import { useAuthStore } from './store/auth'
import { agentsApi } from './lib/api'
import { socketClient } from './lib/socket'
import { useServiceStatus } from './lib/service-status'
import {
  playSfxMessage, playSfxAgentOnline, playSfxComplete, playSfxError,
  playSfxTaskCreate, playSfxTaskDocLinked, playSfxAllTasksDone,
} from './lib/sfx'
import ChannelsView from './pages/ChannelsView'
import AgentsPage from './pages/AgentsPage'
import TasksBoard from './pages/TasksBoard'
import ActivityPage from './pages/ActivityPage'
import DocBrowser from './pages/DocBrowser'
import MachinesPage from './pages/MachinesPage'
import OnboardingPage from './pages/OnboardingPage'
import AudioPlayer from './pages/AudioPlayer'
import SettingsPage from './pages/SettingsPage'

type Page = 'channels' | 'tasks' | 'agents' | 'activity' | 'docs' | 'machines' | 'settings'

const NAV: { id: Page; label: string }[] = [
  { id: 'channels', label: 'channels' },
  { id: 'docs',     label: 'docs'     },
  { id: 'tasks',    label: 'tasks'    },
  { id: 'agents',   label: 'agents'   },
  { id: 'activity', label: 'activity' },
  { id: 'machines', label: 'machines' },
]

export default function App() {
  const { loading, user } = useAuthStore()
  const service = useServiceStatus()
  const [page, setPage] = useState<Page>('channels')
  const [onboarding, setOnboarding] = useState<boolean | null>(null) // null=checking

  // Check if onboarding needed (no agents yet)
  useEffect(() => {
    if (!user) return
    agentsApi.list()
      .then(agents => setOnboarding(agents.length === 0))
      .catch(() => setOnboarding(false))
  }, [user])

  // Wire up SFX to socket events
  useEffect(() => {
    if (!user) return
    const unsub = [
      socketClient.on('message',           () => playSfxMessage()),
      socketClient.on('agent:started',     () => playSfxMessage()),
      socketClient.on('task:created',      () => playSfxMessage()),
      socketClient.on('task:completed',    () => playSfxMessage()),
      socketClient.on('task:all_completed',() => playSfxMessage()),
      socketClient.on('task:doc_added',    () => playSfxMessage()),
      socketClient.on('agent:crashed',     () => playSfxMessage()),
    ]
    return () => unsub.forEach(fn => fn())
  }, [user])

  if (loading || (user && onboarding === null)) {
    return (
      <div
        className="min-h-screen bg-[#0e0c10] flex items-center justify-center text-[#4a4048]"
        style={{ fontFamily: '"Share Tech Mono", monospace' }}
      >
        {service.reachable ? 'connecting...' : 'backend unavailable'}
      </div>
    )
  }

  if (!user) {
    return (
      <div
        className="min-h-screen bg-[#0e0c10] flex items-center justify-center text-[#4a4048]"
        style={{ fontFamily: '"Share Tech Mono", monospace' }}
      >
        {service.reachable ? 'preparing workspace...' : 'backend unavailable'}
      </div>
    )
  }

  // Show onboarding for first-time users
  if (user && onboarding) {
    return <OnboardingPage onComplete={() => setOnboarding(false)} />
  }

  return (
    <div
      className="flex flex-col h-screen bg-[#0e0c10] text-[#e7dfd3]"
      style={{ fontFamily: '"Share Tech Mono", "Courier New", monospace' }}
    >
      {!service.reachable && (
        <div className="shrink-0 border-b-[3px] border-black bg-[#2b1414] px-4 py-2 text-[12px] text-[#f3c6bf]">
          {service.message ?? 'Backend unavailable.'}
        </div>
      )}

      {/* ── Top navigation bar ── */}
      <nav className="shrink-0 flex items-center border-b-[3px] border-black bg-[#110e12] px-4 gap-1">
        {/* Brand */}
        <div className="text-[13px] text-[#c0392b] uppercase tracking-widest mr-4 py-2 select-none">
          red-shrimp
        </div>

        {/* Nav buttons */}
        {NAV.map(n => {
          const active = page === n.id
          return (
            <button
              key={n.id}
              onClick={() => setPage(n.id)}
              className={`px-3 py-2 text-[12px] uppercase tracking-wider border-b-[3px] transition-colors ${
                active
                  ? 'border-[#c0392b] text-[#e7dfd3]'
                  : 'border-transparent text-[#6a6068] hover:text-[#c8bdb8]'
              }`}
            >
              {n.label}
            </button>
          )
        })}

        {/* Spacer + settings + user */}
        <div className="flex-1" />
        <button
          onClick={() => setPage('settings')}
          className={`px-3 py-2 text-[12px] uppercase tracking-wider border-b-[3px] transition-colors ${
            page === 'settings'
              ? 'border-[#c0392b] text-[#e7dfd3]'
              : 'border-transparent text-[#6a6068] hover:text-[#c8bdb8]'
          }`}
        >
          settings
        </button>
        <div className="text-[11px] text-[#4a4048] py-2 pl-3 select-none border-l border-[#2a2228] ml-1">
          {user.name}
        </div>
      </nav>

      {/* ── Page content ── */}
      <div className="flex-1 overflow-hidden">
        {page === 'channels' && <ChannelsView />}
        {page === 'tasks'    && <TasksBoard />}
        {page === 'agents'   && <AgentsPage />}
        {page === 'activity' && <ActivityPage />}
        {page === 'docs'     && <DocBrowser />}
        {page === 'machines' && <MachinesPage />}
        {page === 'settings' && <SettingsPage />}
      </div>

      {/* Global audio player — fixed bottom-right */}
      {user && <AudioPlayer />}
    </div>
  )
}
