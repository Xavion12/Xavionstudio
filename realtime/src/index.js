/**
 * RealtimeHub — the live-updates switchboard for Xavion Fitness (see backend/src/core/realtime.py).
 *
 * - Sockets arrive from the main Worker, which has already checked the user's ticket and put the
 *   socket's tags in X-Realtime-Tags (user:<id>, role:<ROLE>, sid:<session>, member:<id>).
 * - The main Worker POSTs https://hub.internal/publish {messages: [{to, except, event, close}]}:
 *   each event goes to every socket with any `to` tag and none of the `except` tags.
 * - https://hub.internal/presence lists the sessions with an open app (Security page "online").
 *
 * Uses the WebSocket Hibernation API: idle connections cost nothing, and "ping" is answered
 * with "pong" without waking the object.
 */
import { DurableObject } from 'cloudflare:workers'

const MAX_TAGS = 10

export class RealtimeHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  async fetch(request) {
    const url = new URL(request.url)
    if (url.hostname === 'hub.internal') {
      if (request.method === 'POST' && url.pathname === '/publish') return this.publish(await request.json())
      if (url.pathname === '/presence') return Response.json({ sessions: this.sessions() })
      return new Response('Not found', { status: 404 })
    }
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket.', { status: 426 })
    let tags = []
    try {
      tags = JSON.parse(request.headers.get('X-Realtime-Tags') || '[]')
    } catch {
      tags = []
    }
    if (!Array.isArray(tags) || tags.length === 0) return new Response('Forbidden', { status: 403 })
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    this.ctx.acceptWebSocket(server, tags.slice(0, MAX_TAGS).map((t) => String(t).slice(0, 64)))
    return new Response(null, { status: 101, webSocket: client })
  }

  publish({ messages = [] } = {}) {
    let delivered = 0
    for (const message of messages) {
      const skip = new Set()
      for (const tag of message.except || []) for (const ws of this.ctx.getWebSockets(tag)) skip.add(ws)
      const sent = new Set()
      const text = JSON.stringify(message.event)
      for (const tag of message.to || []) {
        for (const ws of this.ctx.getWebSockets(tag)) {
          if (sent.has(ws) || skip.has(ws)) continue
          sent.add(ws)
          try {
            ws.send(text)
            if (message.close) ws.close(4000, 'Signed out')
            delivered += 1
          } catch {
            // the socket is already closing
          }
        }
      }
    }
    return Response.json({ delivered })
  }

  sessions() {
    const found = new Set()
    for (const ws of this.ctx.getWebSockets()) {
      for (const tag of this.ctx.getTags(ws)) if (tag.startsWith('sid:')) found.add(tag.slice(4))
    }
    return [...found]
  }

  async webSocketMessage(ws, message) {
    if (message === 'ping') ws.send('pong')
  }

  async webSocketClose(ws, code) {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'Closing')
    } catch {
      // already closed
    }
  }

  async webSocketError(ws) {
    try {
      ws.close(1011, 'Error')
    } catch {
      // already closed
    }
  }
}

// No public routes: this Worker is reached only through the main Worker's REALTIME binding.
export default {
  fetch() {
    return new Response('Not found', { status: 404 })
  },
}
