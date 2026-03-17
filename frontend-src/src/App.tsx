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
import { useIsMobile } from './lib/use-mobile'
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
type Page = 'home' | 'channels' | 'search' | 'tasks' | 'agents' | 'memory' | 'machines' | 'recipe' | 'chrono'

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
]

const MOBILE_TABS: { id: Page; label: string; icon: string }[] = [
  { id: 'home',     label: 'home',  icon: '⌂' },
  { id: 'channels', label: 'chat',  icon: '#' },
  { id: 'tasks',    label: 'tasks', icon: '✓' },
  { id: 'memory',   label: 'vault', icon: '⊡' },
  { id: 'agents',   label: 'agents',icon: '@' },
]

export default function App() {
  const { loading, user, init } = useAuthStore()
  const service = useServiceStatus()
  const isMobile = useIsMobile()
  const [page, setPage] = useState<Page>('home')
  const [onboarding, setOnboarding] = useState<boolean | null>(null) // null=checking
  const [reviewingCount, setReviewingCount] = useState(0)
  const [requestedChannelId, setRequestedChannelId] = useState<string | null>(null)
  const [requestedDoc, setRequestedDoc] = useState<{ path: string; seq: number } | null>(null)
  const serviceReachableRef = useRef(true)
  const currentNav = NAV.find(item => item.id === page)

  // Check if onboarding needed (no agents yet, or ?onboard=1 forced)
  useEffect(() => {
    if (!user) return
    if (new URLSearchParams(window.location.search).get('onboard') === '1') {
      setOnboarding(true)
      return
    }
    agentsApi.list()
      .then(agents => {
        setOnboarding(agents.length === 0)
      })
      .catch(() => setOnboarding(false))
  }, [user])

  // Register push notifications after login
  // iOS requires user gesture to trigger permission prompt — skip auto-register on iOS
  useEffect(() => {
    if (!user) return
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
    if (isIOS) return  // iOS: user must tap "开启通知" in Settings
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
    setRequestedDoc(prev => ({ path, seq: (prev?.seq ?? 0) + 1 }))
    setPage('memory')
  }

  return (
    <div
      className="flex flex-col overflow-hidden bg-[#0e0c10] text-[#e7dfd3]"
      style={{
        fontFamily: '"Share Tech Mono", "Courier New", monospace',
        height: isMobile ? '100dvh' : '100vh',
        paddingTop: isMobile ? 'var(--safe-area-top, 0px)' : undefined,
      }}
    >
      {!service.reachable && (
        <div className="shrink-0 border-b-[3px] border-black bg-[#2b1414] px-4 py-2 text-[12px] text-[#f3c6bf]">
          {service.message ?? 'Backend unavailable.'}
        </div>
      )}

      {isMobile ? (
        <>
          <header className="shrink-0 border-b-[3px] border-black bg-[#110e12] px-4 py-3" style={{ display: page === 'channels' ? 'none' : undefined }}>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[10px] text-[#c0392b] uppercase tracking-[0.28em]">red-shrimp</div>
                <div className="mt-1 text-[15px] uppercase tracking-[0.12em] text-[#e7dfd3]">
                  {currentNav?.label ?? page}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className={`text-[10px] uppercase ${service.reachable ? 'text-[#6bc5e8]' : 'text-[#f3c6bf]'}`}>
                  {service.reachable ? 'online' : 'offline'}
                </div>
                <div className="mt-1 max-w-[140px] truncate text-[11px] text-[#6a6068]">{user.name}</div>
              </div>
            </div>
          </header>
          <nav className="shrink-0 border-b-[3px] border-black bg-[#141118] px-2 py-1.5 overflow-x-auto scrollbar-none" style={{ display: page === 'channels' ? 'none' : undefined }}>
            <div className="flex gap-1.5">
              {NAV.map(n => {
                const active = page === n.id
                return (
                  <button
                    key={n.id}
                    onClick={() => setPage(n.id)}
                    className={`shrink-0 border-[2px] border-black px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] ${
                      active ? 'bg-[#1a2535] text-[#e7dfd3]' : 'bg-[#0e0c10] text-[#6a6068]'
                    }`}
                  >
                    {n.label}
                  </button>
                )
              })}
            </div>
          </nav>
        </>
      ) : (
        <nav className="shrink-0 flex items-center border-b-[3px] border-black bg-[#110e12] px-4 gap-1 overflow-x-auto scrollbar-none">
          {/* Brand */}
          <div className="hidden md:block text-[13px] text-[#c0392b] uppercase tracking-widest mr-4 py-2 select-none shrink-0">
            red-shrimp
          </div>

          {/* Nav buttons */}
          {NAV.map(n => {
            const active = page === n.id
            return (
              <button
                key={n.id}
                onClick={() => setPage(n.id)}
                className={`shrink-0 px-3 py-2 text-[12px] uppercase tracking-wider border-b-[3px] transition-colors whitespace-nowrap ${
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
          <div className="flex-1 shrink-0" />
          <div className="hidden md:block text-[11px] text-[#4a4048] py-2 pl-3 select-none border-l border-[#2a2228] ml-1 shrink-0">
            {user.name}
          </div>
        </nav>
      )}

      {/* ── Page content — pages stay mounted to preserve scroll position ── */}
      <div className="flex-1 min-h-0 overflow-hidden relative">
        <div className="h-full" style={{ display: page === 'home' ? 'block' : 'none' }}>
          <HomePage onNavigate={(p, d) => { setPage(p as Page) }} />
        </div>
        <div className="h-full" style={{ display: page === 'channels' ? 'block' : 'none' }}>
          <ChannelsView requestedChannelId={requestedChannelId} onOpenDoc={openDoc} onBack={isMobile ? () => setPage('home') : undefined} isVisible={page === 'channels'} />
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
          <MemoryBrowser requestedDoc={requestedDoc} />
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
      </div>

      {/* ── Bottom tab bar (mobile only, hidden on channels page) ── */}
      {isMobile && page !== 'channels' && (
        <nav
          className="fixed bottom-0 left-0 right-0 z-50 flex items-stretch border-t-[3px] border-black bg-[#110e12]"
          style={{ paddingBottom: 'var(--safe-area-bottom, 0px)' }}
        >
          {MOBILE_TABS.map(t => {
            const active = page === t.id
            return (
              <button
                key={t.id}
                onClick={() => setPage(t.id)}
                className={`flex-1 flex flex-col items-center justify-center py-2 text-[10px] uppercase tracking-wider transition-colors relative ${
                  active ? 'text-[#e7dfd3]' : 'text-[#6a6068]'
                }`}
              >
                {active && <div className="absolute top-0 left-1/4 right-1/4 h-[3px] bg-[#c0392b]" />}
                <span className="text-[18px] leading-none mb-0.5">{t.icon}</span>
                <span>{t.label}</span>
                {t.id === 'tasks' && reviewingCount > 0 && (
                  <span className="absolute top-1 right-1/4 min-w-[16px] h-[16px] rounded-full bg-[#c0392b] px-1 text-[9px] leading-[16px] text-black text-center">
                    {reviewingCount > 99 ? '99+' : reviewingCount}
                  </span>
                )}
              </button>
            )
          })}
        </nav>
      )}
    </div>
  )
}
