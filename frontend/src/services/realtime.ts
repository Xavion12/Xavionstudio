import { useSyncExternalStore } from 'react'
import { invalidate } from '@/hooks/useApi'
import { API_BASE, post } from './api'

/**
 * Live updates: one WebSocket per open app (backend/src/core/realtime.py). The server only says
 * *what changed* ("payments", "attendance" ...); the screens showing that data reload it through
 * the normal API, so the socket never carries anyone's data.
 *
 * Reconnects by itself (1 s, 2 s, 4 s ... up to 30 s), right away when the tab comes back or the
 * network returns, and refreshes everything after a drop so nothing missed stays stale.
 */
export type LiveStatus = 'off' | 'connecting' | 'live' | 'retrying'

/** Server topic -> cache-key prefixes of the screens that show it (hooks/useApi). */
const TOPIC_KEYS: Record<string, string[]> = {
  attendance: ['attendance:', 'dashboard:', 'member', 'trainer:', 'portal:'],
  payments: ['payments:', 'memberships:', 'dashboard:', 'member', 'inbox', 'portal:'],
  memberships: ['memberships:', 'member', 'portal:'],
  members: ['member', 'dashboard:', 'trainer:'],
  dashboard: ['dashboard:', 'trainer:'],
  plans: ['plans:'],
  workouts: ['workouts:', 'member', 'portal:'],
  progress: ['progress:', 'member', 'portal:'],
  expenses: ['expenses:', 'dashboard:'],
  notifications: ['inbox', 'notifications:', 'portal:'],
  portal: ['portal:'],
  team: ['users:', 'trainers:', 'trainer:'],
  settings: ['settings'],
  security: ['security:'],
}

const PING_MS = 25_000
const MAX_RETRY_MS = 30_000

let status: LiveStatus = 'off'
const listeners = new Set<() => void>()
function setStatus(next: LiveStatus) {
  if (status === next) return
  status = next
  listeners.forEach((fn) => fn())
}

/** "live" while the app is connected — for a small indicator. */
export function useLiveStatus(): LiveStatus {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => status,
  )
}

let socket: WebSocket | null = null
let running = false
let attempts = 0
let everConnected = false
let pingTimer: number | undefined
let retryTimer: number | undefined
let flushTimer: number | undefined
let onSignedOut: (() => void) | null = null
const pending = new Set<string>()

function queue(topics: string[]) {
  topics.forEach((t) => pending.add(t))
  // Several changes in a burst (a payment touches payments, memberships, dashboard ...) -> one refresh.
  window.clearTimeout(flushTimer)
  flushTimer = window.setTimeout(() => {
    const prefixes = new Set<string>()
    for (const topic of pending) {
      if (topic === 'all') prefixes.add('')
      for (const key of TOPIC_KEYS[topic] ?? []) prefixes.add(key)
    }
    pending.clear()
    if (prefixes.size) invalidate(...prefixes)
  }, 250)
}

function socketUrl(path: string, ticket: string): string {
  const url = new URL(path, API_BASE || window.location.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('ticket', ticket)
  return url.toString()
}

async function open() {
  if (!running || socket) return
  setStatus(attempts ? 'retrying' : 'connecting')
  let ticket: { ticket: string; path: string }
  try {
    ticket = await post<{ ticket: string; path: string }>('/realtime/ticket')
  } catch {
    retry()
    return
  }
  if (!running || socket) return
  const ws = new WebSocket(socketUrl(ticket.path, ticket.ticket))
  socket = ws
  ws.onopen = () => {
    if (everConnected) invalidate('') // back after a drop: anything could have changed meanwhile
    everConnected = true
    attempts = 0
    setStatus('live')
    window.clearInterval(pingTimer)
    pingTimer = window.setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('ping'), PING_MS)
  }
  ws.onmessage = (message) => {
    if (typeof message.data !== 'string' || message.data === 'pong') return
    let event: { type?: string; topics?: string[] }
    try {
      event = JSON.parse(message.data)
    } catch {
      return
    }
    if (event.type === 'changed' && Array.isArray(event.topics)) queue(event.topics)
    else if (event.type === 'signed_out') {
      stop()
      onSignedOut?.()
    }
  }
  ws.onclose = () => {
    window.clearInterval(pingTimer)
    if (socket === ws) socket = null
    if (running) retry()
    else setStatus('off')
  }
}

function retry() {
  if (!running) return
  setStatus('retrying')
  window.clearTimeout(retryTimer)
  const delay = Math.min(MAX_RETRY_MS, 1000 * 2 ** attempts) + Math.random() * 500
  attempts += 1
  retryTimer = window.setTimeout(open, delay)
}

function wake() {
  if (!running || socket || document.visibilityState === 'hidden') return
  attempts = 0
  window.clearTimeout(retryTimer)
  void open()
}

/** Start live updates for the signed-in user; ``signedOut`` runs if an admin signs this device out. */
export function startLive(signedOut: () => void): void {
  onSignedOut = signedOut
  if (running) return
  running = true
  attempts = 0
  everConnected = false
  document.addEventListener('visibilitychange', wake)
  window.addEventListener('online', wake)
  void open()
}

export function stopLive(): void {
  stop()
  onSignedOut = null
}

function stop() {
  running = false
  window.clearTimeout(retryTimer)
  window.clearInterval(pingTimer)
  document.removeEventListener('visibilitychange', wake)
  window.removeEventListener('online', wake)
  const ws = socket
  socket = null
  if (ws && ws.readyState <= WebSocket.OPEN) ws.close(1000)
  setStatus('off')
}
