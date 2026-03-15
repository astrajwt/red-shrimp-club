// Red Shrimp Lab — App (auto-login, top horizontal navigation)

import { useEffect, useRef, useState } from 'react'
import { useAuthStore } from './store/auth'
import { agentsApi, tasksApi } from './lib/api'
import { socketClient } from './lib/socket'
import { useServiceStatus } from './lib/service-status'
import {
  playSfxMessage, playSfxAgentOnline, playSfxComplete, playSfxError,
  playSfxTaskDocLinked, playSfxAllTasksDone,
} from './lib/sfx'
import { recentlySentIds } from './lib/sent-tracker'
import { registerPushNotifications } from './lib/push'
import ChannelsView from './pages/ChannelsView'
import AgentsPage from './pages/AgentsPage'
import TasksBoard from './pages/TasksBoard'
import MemoryBrowser from './pages/MemoryBrowser'
import MachinesPage from './pages/MachinesPage'
import OnboardingPage from './pages/OnboardingPage'
import RecipePage from './pages/RecipePage'
import ChronoPage from './pages/ChronoPage'
import LoginPage from './pages/LoginPage'
import SearchPage from './pages/SearchPage'
import HomePage from './pages/HomePage'
import BulletinBoard from './pages/BulletinBoard'

type Page = 'home' | 'channels' | 'search' | 'tasks' | 'agents' | 'memory' | 'machines' | 'recipe' | 'chrono' | 'bulletin'

const NAV: { id: Page; label: string }[] = [
  { id: 'home',     label: 'home'     },
  { id: 'channels', label: 'channels' },
  { id: 'search',   label: 'search'   },
  { id: 'memory',   label: 'vault'    },
  { id: 'tasks',    label: 'tasks'    },
  { id: 'agents',   label: 'agents'   },
  { id: 'machines', label: 'machines' },
  { id: 'recipe',   label: 'recipe'   },
  { id: 'chrono',   label: 'chrono'   },
  { id: 'bulletin', label: 'bulletin' },
]

export default function App() {
  const { loading, user, init } = useAuthStore()
  const service = useServiceStatus()
  const [page, setPage] = useState<Page>('home')
  const [onboarding, setOnboarding] = useState<boolean | null>(null) // null=checking
  const [reviewingCount, setReviewingCount] = useState(0)
  const [requestedChannelId, setRequestedChannelId] = useState<string | null>(null)
  const [requestedDocPath, setRequestedDocPath] = useState<string | null>(null)
  const serviceReachableRef = useRef(true)

  // Check if onboarding needed (no agents yet)
  useEffect(() => {
    if (!user) return
    agentsApi.list()
      .then(agents => {
        setOnboarding(agents.length === 0)
      })
      .catch(() => setOnboarding(false))
  }, [user])

  // Register push notifications after login
  useEffect(() => {
    if (!user) return
    registerPushNotifications().catch(() => {})
  }, [user])

  useEffect(() => {
    if (!user) {
      setReviewingCount(0)
      return
    }

    const reloadReviewingCount = () => {
      tasksApi.reviewSummary()
        .then(({ reviewingCount }) => setReviewingCount(reviewingCount))
        .catch(() => {})
    }

    reloadReviewingCount()

    const unsubscribers = [
      socketClient.on('task:created', () => reloadReviewingCount()),
      socketClient.on('task:updated', () => reloadReviewingCount()),
      socketClient.on('task:completed', () => reloadReviewingCount()),
    ]

    return () => unsubscribers.forEach(unsub => unsub())
  }, [user])

  // Wire up SFX to socket events
  useEffect(() => {
    if (!user) return
    const unsub = [
      socketClient.on('message', (data) => {
        const msg = (data as {
          message?: {
            id?: string
            sender_id?: string
            sender_name?: string
            sender_type?: 'human' | 'agent'
          }
        }).message
        if (!msg) return

        // Suppress sound for own messages (check both ID comparison and sent tracker)
        if (msg.id && recentlySentIds.has(msg.id)) {
          recentlySentIds.delete(msg.id)
          return
        }
        const isOwnHumanMessage =
          msg.sender_type === 'human' &&
          (
            (msg.sender_id && msg.sender_id === user.id) ||
            (msg.sender_name && msg.sender_name === user.name)
          )

        if (!isOwnHumanMessage) playSfxMessage()
      }),
      socketClient.on('agent:started', ({ agentId }) => {
        playSfxAgentOnline()
      }),
      socketClient.on('agent:log', ({ level }) => {
        if (level === 'ERROR') {
          playSfxError()
        }
      }),
      socketClient.on('agent:stopped', () => {}),
      socketClient.on('agent:offline', () => {}),
      socketClient.on('agent:crashed', () => {
        playSfxError()
      }),
      socketClient.on('task:completed',    () => playSfxComplete()),
      socketClient.on('task:all_completed',() => playSfxAllTasksDone()),
      socketClient.on('task:doc_added',    () => playSfxTaskDocLinked()),
    ]
    return () => unsub.forEach(fn => fn())
  }, [user])

  useEffect(() => {
    if (serviceReachableRef.current && !service.reachable) {
      playSfxError()
    }
    serviceReachableRef.current = service.reachable
  }, [service.reachable])

  useEffect(() => {
    const handleError = () => playSfxError()
    window.addEventListener('error', handleError)
    window.addEventListener('unhandledrejection', handleError)
    return () => {
      window.removeEventListener('error', handleError)
      window.removeEventListener('unhandledrejection', handleError)
    }
  }, [])

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
    return <LoginPage onSuccess={() => setOnboarding(null)} />
  }

  // Show onboarding for first-time users
  if (user && onboarding) {
    return <OnboardingPage onComplete={() => setOnboarding(false)} />
  }

  const openChannelFromSearch = (channelId: string) => {
    setRequestedChannelId(channelId)
    setPage('channels')
  }

  const openDoc = (path: string) => {
    setRequestedDocPath(path)
    setPage('memory')
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
              <span className="inline-flex items-center gap-2">
                {n.label}
                {n.id === 'tasks' && reviewingCount > 0 && (
                  <span className="min-w-[18px] h-[18px] rounded-full bg-[#c0392b] px-1 text-[10px] leading-[18px] text-black text-center">
                    {reviewingCount > 99 ? '99+' : reviewingCount}
                  </span>
                )}
              </span>
            </button>
          )
        })}

        {/* Spacer + user */}
        <div className="flex-1" />
        <div className="text-[11px] text-[#4a4048] py-2 pl-3 select-none border-l border-[#2a2228] ml-1">
          {user.name}
        </div>
      </nav>

      {/* ── Page content — pages stay mounted to preserve scroll position ── */}
      <div className="flex-1 overflow-hidden relative">
        <div className="h-full" style={{ display: page === 'home' ? 'block' : 'none' }}>
          <HomePage onNavigate={(p, d) => { setPage(p as Page) }} />
        </div>
        <div className="h-full" style={{ display: page === 'channels' ? 'block' : 'none' }}>
          <ChannelsView requestedChannelId={requestedChannelId} onOpenDoc={openDoc} />
        </div>
        <div className="h-full" style={{ display: page === 'search' ? 'block' : 'none' }}>
          <SearchPage onOpenChannel={openChannelFromSearch} />
        </div>
        <div className="h-full" style={{ display: page === 'tasks' ? 'block' : 'none' }}>
          <TasksBoard onOpenDoc={openDoc} />
        </div>
        <div className="h-full" style={{ display: page === 'agents' ? 'block' : 'none' }}>
          <AgentsPage />
        </div>
        <div className="h-full" style={{ display: page === 'memory' ? 'block' : 'none' }}>
          <MemoryBrowser initialPath={requestedDocPath} />
        </div>
        <div className="h-full" style={{ display: page === 'machines' ? 'block' : 'none' }}>
          <MachinesPage />
        </div>
        <div className="h-full" style={{ display: page === 'recipe' ? 'block' : 'none' }}>
          <RecipePage />
        </div>
        <div className="h-full" style={{ display: page === 'chrono' ? 'block' : 'none' }}>
          <ChronoPage />
        </div>
        <div className="h-full" style={{ display: page === 'bulletin' ? 'block' : 'none' }}>
          <BulletinBoard onOpenDoc={openDoc} />
        </div>
      </div>
    </div>
  )
}
