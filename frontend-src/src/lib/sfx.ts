// Red Shrimp Lab — Sound Effects
// Uses MP3 files from public/audio/ when available, synthesizes otherwise.

let ctx: AudioContext | null = null
let muted = false

function getCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext()
  if (ctx.state === 'suspended') ctx.resume()
  return ctx
}

export function setSfxMuted(m: boolean) { muted = m }
export function isSfxMuted() { return muted }

// Try to play an MP3 file; if it fails (missing/error), run fallback synthesis
async function playFile(src: string, fallback: () => void): Promise<void> {
  if (muted) return
  const audio = new Audio(src)
  audio.volume = 0.5
  try {
    await audio.play()
  } catch {
    fallback()
  }
}

// ── New message — short prompt tone ────────────────────────────────────────
export function playSfxMessage() {
  playFile('/audio/sfx-message.mp3', synthesizeMessage)
}

function synthesizeMessage() {
  try {
    const c = getCtx()
    for (const [freq, delay] of [[1046, 0], [1318, 0.06]] as const) {
      const osc = c.createOscillator()
      const gain = c.createGain()
      osc.connect(gain); gain.connect(c.destination)
      osc.type = 'sine'
      osc.frequency.setValueAtTime(freq, c.currentTime + delay)
      gain.gain.setValueAtTime(0.0001, c.currentTime + delay)
      gain.gain.linearRampToValueAtTime(0.08, c.currentTime + delay + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + delay + 0.18)
      osc.start(c.currentTime + delay); osc.stop(c.currentTime + delay + 0.18)
    }
  } catch { /* ignore */ }
}

// ── Agent online — glass clink ─────────────────────────────────────────────
export function playSfxAgentOnline() {
  playFile('/audio/sfx-agent-online.mp3', synthesizeAgentOnline)
}

function synthesizeAgentOnline() {
  try {
    const c = getCtx()
    for (const [freq, delay] of [[880, 0], [1100, 0.05]] as const) {
      const osc = c.createOscillator()
      const gain = c.createGain()
      osc.connect(gain); gain.connect(c.destination)
      osc.type = 'triangle'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0, c.currentTime + delay)
      gain.gain.linearRampToValueAtTime(0.15, c.currentTime + delay + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + delay + 0.5)
      osc.start(c.currentTime + delay); osc.stop(c.currentTime + delay + 0.5)
    }
  } catch { /* ignore */ }
}

// ── Task complete — ice cubes in glass ────────────────────────────────────
export function playSfxComplete() {
  playFile('/audio/sfx-complete.mp3', synthesizeComplete)
}

function synthesizeComplete() {
  try {
    const c = getCtx()
    for (const [freq, delay, gainLevel] of [[2100, 0, 0.12], [1680, 0.08, 0.09], [2380, 0.16, 0.08]] as const) {
      const osc = c.createOscillator()
      const gain = c.createGain()
      const filter = c.createBiquadFilter()
      osc.connect(filter); filter.connect(gain); gain.connect(c.destination)
      osc.type = 'triangle'
      osc.frequency.setValueAtTime(freq, c.currentTime + delay)
      osc.frequency.exponentialRampToValueAtTime(Math.max(700, freq * 0.45), c.currentTime + delay + 0.12)
      filter.type = 'highpass'
      filter.frequency.value = 900
      gain.gain.setValueAtTime(0.0001, c.currentTime + delay)
      gain.gain.linearRampToValueAtTime(gainLevel, c.currentTime + delay + 0.008)
      gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + delay + 0.18)
      osc.start(c.currentTime + delay)
      osc.stop(c.currentTime + delay + 0.18)
    }
  } catch { /* ignore */ }
}

// ── Task created — soft ping ───────────────────────────────────────────────
export function playSfxTaskCreate() {
  playFile('/audio/sfx-task-create.mp3', synthesizeTaskCreate)
}

function synthesizeTaskCreate() {
  try {
    const c = getCtx()
    const osc = c.createOscillator()
    const gain = c.createGain()
    osc.connect(gain); gain.connect(c.destination)
    osc.type = 'sine'
    osc.frequency.setValueAtTime(660, c.currentTime)
    osc.frequency.linearRampToValueAtTime(880, c.currentTime + 0.06)
    gain.gain.setValueAtTime(0.12, c.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.3)
    osc.start(); osc.stop(c.currentTime + 0.3)
  } catch { /* ignore */ }
}

// ── Task doc linked — paper rustle ────────────────────────────────────────
export function playSfxTaskDocLinked() {
  playFile('/audio/sfx-doc-linked.mp3', synthesizeDocLinked)
}

function synthesizeDocLinked() {
  try {
    const c = getCtx()
    const buf = c.createBuffer(1, Math.floor(c.sampleRate * 0.15), c.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) * 0.15
    }
    const src = c.createBufferSource()
    const filter = c.createBiquadFilter()
    src.buffer = buf
    filter.type = 'highpass'; filter.frequency.value = 3000
    src.connect(filter); filter.connect(c.destination)
    src.start()
  } catch { /* ignore */ }
}

// ── All tasks done — celebration ──────────────────────────────────────────
export function playSfxAllTasksDone() {
  playFile('/audio/sfx-all-done.mp3', synthesizeAllDone)
}

function synthesizeAllDone() {
  try {
    const c = getCtx()
    for (const [freq, delay] of [[523, 0], [659, 0.1], [784, 0.2], [1047, 0.3]] as const) {
      const osc = c.createOscillator()
      const gain = c.createGain()
      osc.connect(gain); gain.connect(c.destination)
      osc.type = 'triangle'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0, c.currentTime + delay)
      gain.gain.linearRampToValueAtTime(0.2, c.currentTime + delay + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + delay + 0.5)
      osc.start(c.currentTime + delay); osc.stop(c.currentTime + delay + 0.5)
    }
  } catch { /* ignore */ }
}

// ── Agent crashed / error ──────────────────────────────────────────────────
export function playSfxError() {
  if (muted) return
  try {
    const c = getCtx()
    for (const [freq, delay] of [[400, 0], [300, 0.15]] as const) {
      const osc = c.createOscillator()
      const gain = c.createGain()
      osc.connect(gain); gain.connect(c.destination)
      osc.type = 'sawtooth'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.1, c.currentTime + delay)
      gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + delay + 0.2)
      osc.start(c.currentTime + delay); osc.stop(c.currentTime + delay + 0.2)
    }
  } catch { /* ignore */ }
}
