import { Elysia, t } from 'elysia';
import { cors } from '@elysiajs/cors';
import { roomManager } from './room';
import { generateTurnCredentials } from './turn';

const PORT = process.env.PORT || 3000;
const TURN_STATIC_AUTH_SECRET = process.env.TURN_STATIC_AUTH_SECRET || '';

// Signaling-only WebRTC handshake relay. Never logs payloads, IPs, or room IDs.
// Stateless room registry lives entirely in process memory — see ./room.
const app = new Elysia()
  .use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }))
  .onError(({ code, error }) => {
    // Errors only to stderr at WARN+, never including payload content, IPs, or room IDs.
    console.warn(`[WARN] Application error occurred. Code: ${code}`);
    return new Response('Internal Server Error', { status: 500 });
  })
  .get('/healthz', () => ({ ok: true }))
  .get('/turn-credentials', ({ query }) => {
    const username = query.username as string;
    if (!username) {
      return new Response('Missing username', { status: 400 });
    }
    return generateTurnCredentials(username, TURN_STATIC_AUTH_SECRET);
  }, {
    query: t.Object({
      username: t.String()
    })
  })
  .ws('/call/:roomId', {
    // Validate every inbound payload with TypeBox
    body: t.Object({
      type: t.String(),
      payload: t.Optional(t.Any()),
      ecdhPublicKey: t.Optional(t.String()),
      // Peer advertises its support for the RTCRtpScriptTransform E2EE path.
      // Only when BOTH peers send true does the client actually apply transforms.
      // Older clients that omit it are treated as not supporting E2EE.
      e2eeSupported: t.Optional(t.Boolean()),
      // E2EE chat fields. Both peers derive the same AES-GCM "chat" key from
      // the shared ECDH secret; this server only relays opaque ciphertext.
      //   enc = true   → payload is base64(AES-GCM ciphertext), iv = base64 nonce
      //   enc absent   → payload is plaintext (used only during the pre-key window)
      enc: t.Optional(t.Boolean()),
      iv:  t.Optional(t.String())
    }, {
      // Future-proofing: ignore unknown fields so a newer client can add
      // experimental message fields without immediately breaking older
      // signaling deployments.
      additionalProperties: true
    }),
    open(ws) {
      if (!ws.data.id) {
        ws.data.id = crypto.randomUUID();
      }
      const roomId = ws.data.params.roomId;
      // Privacy: never log peer IDs or room IDs.
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
      const roomId = ws.data.params.roomId;
      // Privacy: NEVER log message contents. Chat messages, SDP, and ICE
      // candidates can contain user-identifying information. Only emit the
      // message type at debug level so operators can verify the protocol
      // is flowing without seeing user data.
      try {
        const obj = typeof message === 'string' ? JSON.parse(message) : message;
        const t = (obj && typeof obj === 'object' && 'type' in obj) ? String((obj as any).type).slice(0, 32) : 'unknown';
        if (process.env.NODE_ENV !== 'production') {
          // Even in dev we log just type — not payload.
          console.log(`[WS] ${t} in room ***`);
        }
      } catch { /* ignore parse failures, never log raw */ }

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
        // If either peer disconnects, we should notify or close the other
        for (const peer of peers) {
          if (peer.data.id !== ws.data.id) {
            peer.close(1000, 'Peer disconnected');
          }
        }
      }
      
      // Purge the room entry immediately
      roomManager.leaveRoom(roomId, ws);
    }
  })
  .listen(PORT);

console.log(`Signaling server running on port ${PORT}`);
