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
      e2eeSupported: t.Optional(t.Boolean())
    }),
    open(ws) {
      if (!ws.data.id) {
        ws.data.id = crypto.randomUUID();
      }
      const roomId = ws.data.params.roomId;
      console.log(`[WS] Peer connected: ${ws.data.id} to room ${roomId}`);
      
      // Attempt to join the room
      if (!roomManager.joinRoom(roomId, ws)) {
        console.warn(`[WS] Room full: ${roomId}`);
        ws.close(1008, 'Room full');
        return;
      }
    },
    message(ws, message) {
      const roomId = ws.data.params.roomId;
      console.log(`[WS] Message from ${ws.data.id} in room ${roomId}:`, typeof message === 'string' ? message : JSON.stringify(message).substring(0, 100));
      
      const peers = roomManager.getPeers(roomId);
      if (!peers) return;

      // Broadcast message to the other peer in the room
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
