import { Elysia, t } from 'elysia';
import { cors } from '@elysiajs/cors';
import { roomManager } from './room';
import { generateTurnCredentials } from './turn';
import { RateLimiter, clientIp } from './rate-limit';

const PORT = process.env.PORT || 3000;
const TURN_STATIC_AUTH_SECRET = process.env.TURN_STATIC_AUTH_SECRET || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';

// Per-IP rate limits. /turn-credentials is a HMAC mint; we cap it tightly so
// an attacker can't generate unlimited credentials and use the TURN server
// as a free relay. The WS upgrade limit blunts brute-force room-code
// enumeration without affecting a normal user (≈ 4 connects per call).
const turnCredLimiter = new RateLimiter(20,  'turn-creds');
const wsOpenLimiter   = new RateLimiter(30,  'ws-open');

// Origin whitelist for WebSocket upgrades — defends against Cross-Site
// WebSocket Hijacking. Browser code from any other origin is rejected
// before the upgrade completes. Native (non-browser) clients omit Origin
// entirely and are still allowed; the threat model targets a malicious
// page running in a victim's browser.
const ORIGIN_ALLOWLIST = new Set<string>(
  ALLOWED_ORIGIN
    ? ALLOWED_ORIGIN.split(',').map(s => s.trim()).filter(Boolean)
    : []
);

function isOriginAllowed(origin: string | undefined | null): boolean {
  if (!origin) return true;                       // native / curl / non-browser
  if (ORIGIN_ALLOWLIST.size === 0) return true;   // dev mode — no allowlist configured
  return ORIGIN_ALLOWLIST.has(origin);
}

// Signaling-only WebRTC handshake relay. Never logs payloads, IPs, or room IDs.
// Stateless room registry lives entirely in process memory — see ./room.
const app = new Elysia()
  // CORS: tight allowlist if configured, '*' only in dev.
  .use(cors({
    origin: ALLOWED_ORIGIN
      ? ALLOWED_ORIGIN.split(',').map(s => s.trim()).filter(Boolean)
      : '*'
  }))
  .onError(({ code }) => {
    console.warn(`[WARN] Application error occurred. Code: ${code}`);
    return new Response('Internal Server Error', { status: 500 });
  })
  .get('/healthz', () => ({ ok: true }))
  .get('/turn-credentials', ({ query, headers }) => {
    const ip = clientIp(headers as any);
    if (!turnCredLimiter.hit(ip)) {
      // 429 Too Many Requests — Retry-After hints the client to back off.
      return new Response('Too Many Requests', {
        status: 429,
        headers: { 'Retry-After': '60' }
      });
    }
    const username = (query as any).username as string;
    if (!username) {
      return new Response('Missing username', { status: 400 });
    }
    return generateTurnCredentials(username, TURN_STATIC_AUTH_SECRET);
  }, {
    query: t.Object({ username: t.String() })
  })
  .ws('/call/:roomId', {
    body: t.Object({
      type: t.String(),
      payload: t.Optional(t.Any()),
      ecdhPublicKey: t.Optional(t.String()),
      e2eeSupported: t.Optional(t.Boolean()),
      enc: t.Optional(t.Boolean()),
      iv:  t.Optional(t.String())
    }, {
      additionalProperties: true
    }),
    open(ws) {
      // --- Origin whitelist (CSWSH protection) ---
      const hdrs = (ws.data as any).headers as Record<string, string> | undefined;
      const origin = hdrs?.origin ?? hdrs?.Origin;
      if (!isOriginAllowed(origin)) {
        ws.close(1008, 'Origin not allowed');
        return;
      }

      // --- Per-IP rate limit (brute force protection) ---
      const ip = clientIp(hdrs as any);
      if (!wsOpenLimiter.hit(ip)) {
        ws.close(1013, 'Too many connections');
        return;
      }

      if (!ws.data.id) {
        ws.data.id = crypto.randomUUID();
      }
      const roomId = ws.data.params.roomId;
      if (process.env.NODE_ENV !== 'production') {
        console.log('[WS] peer connected');
      }
      if (!roomManager.joinRoom(roomId, ws)) {
        if (process.env.NODE_ENV !== 'production') {
          console.warn('[WS] room full — rejecting peer');
        }
        ws.close(1008, 'Room full');
        return;
      }
    },
    message(ws, message) {
      // Reject oversized frames. SDP and ICE messages stay comfortably under
      // 16 KB; chat ciphertexts are tiny. 64 KB is a generous cap that still
      // blocks an attacker from sending multi-megabyte payloads to exhaust
      // server memory or hammer the peer's parser.
      const MAX_MESSAGE_BYTES = 64 * 1024;
      const sizeOf = (m: unknown) =>
        typeof m === 'string' ? m.length :
        m instanceof Uint8Array ? m.byteLength :
        JSON.stringify(m).length;
      if (sizeOf(message) > MAX_MESSAGE_BYTES) {
        // Don't relay; close the abusing peer with policy-violation code.
        ws.close(1009, 'Message too big');
        return;
      }

      const roomId = ws.data.params.roomId;
      try {
        const obj = typeof message === 'string' ? JSON.parse(message) : message;
        const t = (obj && typeof obj === 'object' && 'type' in obj) ? String((obj as any).type).slice(0, 32) : 'unknown';
        if (process.env.NODE_ENV !== 'production') {
          console.log(`[WS] ${t} in room ***`);
        }
      } catch { /* never log raw */ }

      const peers = roomManager.getPeers(roomId);
      if (!peers) return;

      for (const peer of peers) {
        if (peer.data.id !== ws.data.id) {
          peer.send(typeof message === 'string' ? message : JSON.stringify(message));
        }
      }
    },
    close(ws) {
      const roomId = ws.data.params.roomId;
      const peers = roomManager.getPeers(roomId);
      if (peers) {
        for (const peer of peers) {
          if (peer.data.id !== ws.data.id) {
            peer.close(1000, 'Peer disconnected');
          }
        }
      }
      roomManager.leaveRoom(roomId, ws);
    }
  })
  .listen(PORT);

console.log(`Signaling server running on port ${PORT}`);
