// Red Shrimp Lab — Audio Player
// Floating bottom-right control bar: background music + SFX toggle

import { useEffect, useRef, useState } from 'react'
import { setSfxMuted, isSfxMuted } from '../lib/sfx'

// Background music playlist — place MP3s in public/audio/ to enable
const BGM_PLAYLIST = [
  { title: 'Cyberpunk Alleyway', src: '/audio/bgm-alleyway.mp3' },
  { title: 'Cyberpunk Ambient',  src: '/audio/bgm-ambient.mp3'  },
]

export default function AudioPlayer() {
  const [expanded, setExpanded] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [trackIdx, setTrackIdx] = useState(0)
  const [volume, setVolume] = useState(0.35)
  const [sfxOn, setSfxOn] = useState(!isSfxMuted())
  const [noFile, setNoFile] = useState(false)
  const audioRef = useRef<HTMLAudioElement>(null)

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.volume = volume
    audio.loop = false
  }, [volume])

  // Auto-advance to next track
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const onEnd = () => setTrackIdx(i => (i + 1) % BGM_PLAYLIST.length)
    audio.addEventListener('ended', onEnd)
    return () => audio.removeEventListener('ended', onEnd)
  }, [])

  // Apply track change
  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !playing) return
    audio.src = BGM_PLAYLIST[trackIdx].src
    setNoFile(false)
    audio.play().catch(() => { setNoFile(true); setPlaying(false) })
  }, [trackIdx])

  const togglePlay = async () => {
    const audio = audioRef.current
    if (!audio) return
    if (playing) {
      audio.pause()
      setPlaying(false)
    } else {
      audio.src = BGM_PLAYLIST[trackIdx].src
      setNoFile(false)
      try {
        await audio.play()
        setPlaying(true)
      } catch {
        setNoFile(true)
      }
    }
  }

  const nextTrack = () => {
    setTrackIdx(i => (i + 1) % BGM_PLAYLIST.length)
    if (playing) {
      const audio = audioRef.current
      if (!audio) return
      audio.src = BGM_PLAYLIST[(trackIdx + 1) % BGM_PLAYLIST.length].src
      audio.play().catch(() => { setNoFile(true); setPlaying(false) })
    }
  }

  const toggleSfx = () => {
    const next = !sfxOn
    setSfxOn(next)
    setSfxMuted(!next)
  }

  const track = BGM_PLAYLIST[trackIdx]

  return (
    <div
      className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-1"
      style={{ fontFamily: '"Share Tech Mono", monospace' }}
    >
      <audio ref={audioRef} preload="none" />

      {/* Expanded panel */}
      {expanded && (
        <div className="border-[3px] border-black bg-[#1e1a20] text-[#e7dfd3] shadow-[4px_4px_0_rgba(0,0,0,0.8)]" style={{ width: 240 }}>
          {/* Header */}
          <div className="border-b-[3px] border-black px-3 py-2 bg-[#141018]">
            <div className="text-[10px] text-[#6bc5e8] uppercase tracking-widest">audio</div>
          </div>

          {/* BGM controls */}
          <div className="px-3 py-3 border-b-[2px] border-[#2a2228]">
            <div className="text-[10px] text-[#4a4048] uppercase mb-2">background music</div>
            <div className="text-[11px] text-[#9a8888] truncate mb-2">{track.title}</div>
            <div className="flex items-center gap-2">
              <button
                onClick={togglePlay}
                className="border-[2px] border-[#3a3535] px-2 py-1 text-[11px] hover:border-[#c0392b] hover:text-[#c0392b] transition-colors"
              >
                {playing ? 'pause' : 'play'}
              </button>
              <button
                onClick={nextTrack}
                className="border-[2px] border-[#3a3535] px-2 py-1 text-[11px] hover:border-[#6bc5e8] hover:text-[#6bc5e8] transition-colors"
              >
                next
              </button>
              {noFile && (
                <span className="text-[10px] text-[#c0392b]">no file</span>
              )}
            </div>
            {/* Volume */}
            <div className="flex items-center gap-2 mt-2">
              <span className="text-[10px] text-[#4a4048]">vol</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={volume}
                onChange={e => {
                  const v = parseFloat(e.target.value)
                  setVolume(v)
                  if (audioRef.current) audioRef.current.volume = v
                }}
                className="flex-1 accent-[#c0392b] h-1 cursor-pointer"
              />
              <span className="text-[10px] text-[#4a4048] w-6">{Math.round(volume * 100)}</span>
            </div>
            <div className="text-[10px] text-[#3a3535] mt-1.5 leading-relaxed">
              place MP3s in public/audio/ to enable
            </div>
          </div>

          {/* SFX controls */}
          <div className="px-3 py-3">
            <div className="text-[10px] text-[#4a4048] uppercase mb-2">sound effects</div>
            <div className="text-[11px] text-[#6a5858] mb-2 leading-relaxed">
              msg / shrimp / task
            </div>
            <button
              onClick={toggleSfx}
              className={`border-[2px] px-2 py-1 text-[11px] transition-colors ${
                sfxOn
                  ? 'border-[#3abfa0] text-[#3abfa0] hover:border-[#c0392b] hover:text-[#c0392b]'
                  : 'border-[#3a3535] text-[#3a3535] hover:border-[#3abfa0] hover:text-[#3abfa0]'
              }`}
            >
              sfx {sfxOn ? 'on' : 'off'}
            </button>
          </div>
        </div>
      )}

      {/* Toggle button */}
      <button
        onClick={() => setExpanded(e => !e)}
        className={`border-[3px] border-black px-3 py-1.5 text-[11px] uppercase tracking-wider shadow-[3px_3px_0_rgba(0,0,0,0.8)] transition-colors ${
          expanded || playing
            ? 'bg-[#c0392b] text-white'
            : 'bg-[#1e1a20] text-[#4a4048] hover:text-[#9a8888] hover:border-[#c0392b]'
        }`}
      >
        {playing ? '>> audio' : '~~ audio'}
      </button>
    </div>
  )
}
