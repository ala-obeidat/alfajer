# Alfajer

**Alfajer** is a fully anonymous, private, secret **1-to-1** video/audio
calling PWA. No accounts, no databases, no logs, no analytics, no cookies.
Just a 6-digit room code, a session-only nickname, and the other person.

Live: <https://alfajer.alaobeidat.com>

## What it does

- Open the home page, type a nickname, and either:
  - **Start new call** — generates a random 6-digit room code and drops
    you into the room. Share the code (or the link) via WhatsApp, the
    native share sheet, or copy-to-clipboard.
  - **Join existing call** — type the 6-digit room code your peer sent.
- Optional **voice-only call** checkbox: never opens the camera.
- Calls are strictly 1-to-1. Rooms **seal** the moment two peers connect —
  a third browser trying the same code is rejected by the signaling
  server with WebSocket close code 1008.
- When both peers leave, the room is gone. There is nothing to "delete"
  because nothing was ever persisted.

## In-call features

| Feature | What it does |
|---|---|
| **Picture-in-Picture** | Local self-view in the top-right, draggable anywhere on screen. Clamped so it can't be lost off-edge. |
| **Switch camera (Flip)** | Front ↔ back on phones. Uses `facingMode` first, falls back to deviceId enumeration; shown on any touch device. |
| **Devices menu** | Native selects for microphone, speaker (`setSinkId` on Chrome/Edge), and camera. Choices persist in `localStorage` and auto-apply on the next call. |
| **End-to-end encrypted chat** | Sidebar with text messages. Encrypted with a third HKDF-derived AES-GCM key (label `alfajer-v1-chat`) — signaling server only sees opaque ciphertext + IV. |
| **Screen sharing** | Desktop browsers only (mobile platforms don't implement `getDisplayMedia`). `RTCRtpSender.replaceTrack` swaps the video track in place, no renegotiation. |
| **Connection quality pill** | Live `Direct / Relay / Reconnecting / Failed` indicator with RTT, polled from `pc.getStats()` every 2 s. |
| **Speaking indicator** | AnalyserNode FFT taps each audio track and pulses an emerald ring around whoever's producing voice. |
| **Auto-reconnect** | ICE-restart on `iceConnectionState === 'failed'`. Toast announces "Reconnecting…". |
| **Camera-off avatar** | When the peer turns their camera off, the area renders their nickname initial in a circle instead of going black. |
| **Light / dark / auto theme** | Top-right toggle cycles through; auto follows `prefers-color-scheme`. |
| **Native share / WhatsApp** | One-tap invite share with prefilled message. Uses `navigator.share` on mobile. |
| **PWA install** | Captures `beforeinstallprompt`, surfaces a dismissable install card on the home page. Adds Alfajer to the device home screen with the shield icon. |

## Privacy guarantees

- **No persistent storage.** Rooms live only in the signaling server's
  process memory. No database, no Redis, no log files. Server crashes
  wipe state.
- **No payload logging.** Production signaling logs are silent; the dev
  log emits only message type with room IDs and peer IDs redacted.
- **No accounts.** Your identity is a session-only string in
  `sessionStorage` and disappears the instant you close the tab.
- **DTLS-SRTP** media encryption between peers is on by default (WebRTC).
- **E2EE script-transform** layer with per-direction AES-256-GCM keys
  derived via HKDF from a P-256 ECDH exchange — automatically engaged
  when both peers signal support during SDP. See "E2EE notes" below.
- **No third-party trackers, analytics, or cookies.**
- **Strict CSP, HSTS, COOP, X-Frame-Options DENY, Permissions-Policy**
  on the frontend. Google Translate auto-translate suppressed app-wide.

## Architecture

Bun-managed monorepo:

| Path | What it is |
|------|------------|
| `apps/web` | SvelteKit 5 PWA (English-only), `adapter-static`, deployed to Cloudflare Workers Static Assets. |
| `apps/signaling` | Bun + ElysiaJS WebSocket signaling server with TypeBox-validated payloads. In-memory room registry. |
| `infra/coturn` | Hardened CoTURN configuration + env-driven install script (Let's Encrypt cert, renewal hook, hardened defaults). |

Production topology:

- `alfajer.alaobeidat.com` → Cloudflare Workers (static SvelteKit build,
  served via the CF edge; CSP-locked).
- `signaling.alaobeidat.com` → Caddy reverse-proxy with auto-TLS →
  Bun signaling on port 3000.
- `turn.alaobeidat.com:3478` → CoTURN STUN + TURN over UDP / TCP.
- `turn.alaobeidat.com:5349` → CoTURN TURNS over TLS.
- Single Hetzner Cloud CAX (ARM64) box runs CoTURN + Caddy +
  signaling under systemd. Auto-renewal hooks stop and start Caddy
  around certbot so port 80 is free for the HTTP-01 challenge.

### ICE / TURN transports offered to clients

`PUBLIC_TURN_URL` is a comma-separated list. WebRTC's ICE algorithm
gathers candidates across all of them and picks the lowest-latency
working path:

```
turn:turn.alaobeidat.com:3478?transport=udp        # fastest, used when UDP is allowed
turns:turn.alaobeidat.com:5349?transport=tcp        # most universal fallback (TLS over TCP)
```

STUN (`stun:stun.l.google.com:19302`) handles natural NAT punching
first; TURN is only used when peers can't reach each other directly.

## Local development

Requirements: [Bun](https://bun.sh/) ≥ 1.2.

```bash
bun install
bun run dev      # starts signaling on :3000 and web on :5173 in parallel
bun run test     # vitest across workspaces
bun run lint     # ESLint
bun run lint:css # Stylelint
```

For local web → local signaling, no env vars are needed — the web
client falls back to `ws://localhost:3000` when `PUBLIC_SIGNALING_URL`
is unset.

## Deployment

### Frontend → Cloudflare Workers Static Assets

- **Build command:** `cd apps/web && bun install --no-frozen-lockfile && bun run build`
- **Deploy command:** `cd apps/web && npx wrangler deploy`
- **Required env vars (Production):**
  - `PUBLIC_SIGNALING_URL` — e.g. `https://signaling.alaobeidat.com`
  - `PUBLIC_TURN_URL` — comma-separated TURN URLs, e.g.
    `turn:turn.alaobeidat.com:3478?transport=udp,turns:turn.alaobeidat.com:5349?transport=tcp`

### Signaling auto-deploy (GitHub Actions)

Pushes to `main` that touch `apps/signaling/**` trigger
`.github/workflows/deploy-signaling.yml`, which rsyncs the source to
`/root/alfajer/apps/signaling/` on the server, runs
`bun install --production`, and restarts the `alfajer-signaling`
systemd unit. Required repository secrets:

| Secret | What goes in it |
|---|---|
| `DEPLOY_HOST` | Your server's public IP or hostname |
| `DEPLOY_USER` | `root` (or whatever account owns `/root/alfajer/`) |
| `DEPLOY_SSH_KEY` | The contents of your SSH private key file (PEM format) |
| `DEPLOY_HOST_KEY` | The server's SSH host pubkey lines (`ssh-keyscan -t ed25519,rsa <your-server-ip>` output) |

### CoTURN install (one-shot, server-side)

```bash
TURN_DOMAIN=turn.example.com \
TURN_REALM=app.example.com \
LETSENCRYPT_EMAIL=you@example.com \
TURN_STATIC_AUTH_SECRET=$(openssl rand -hex 32) \
bash infra/coturn/install.sh
```

The script installs `coturn` + `certbot`, fetches a Let's Encrypt cert,
installs the deploy renewal hook, and installs the pre/post hooks that
stop and start Caddy around renewals (so port 80 is free for the
HTTP-01 challenge).

## Operations

### Rotating the TURN secret (90-day cadence)

From the project root on the Windows host:

```cmd
update-secret.bat
```

The script reads `SERVER_IP`, `SERVER_USER`, `SSH_KEY_PATH` from the
gitignored `deploy-secrets.local.txt`, generates a fresh 64-char hex
secret with the OS RNG, pipes it over SSH stdin (never appears in any
process listing), and runs `update-secret.sh` on the server. The
server-side script patches both `/etc/turnserver.conf` and
`apps/signaling/.env`, restarts coturn + signaling, and backs up the
previous values to `/root/alfajer-secret-backups/`. On success the
local `deploy-secrets.local.txt` is also rewritten.

If any step fails, the local file is left **untouched** so the state
on PC and server doesn't drift apart.

## E2EE notes

Per-frame AES-256-GCM video encryption via `RTCRtpScriptTransform` is
enabled at runtime when **both** peers advertise support in their SDP
offer/answer (`e2eeSupported` flag). Peers that lack the API (older
Safari, older Chrome Android) fall back transparently to plain WebRTC,
which is still encrypted by DTLS-SRTP between peers — the signaling
and TURN servers never see plaintext.

Key derivation chain when E2EE is engaged:

```
P-256 ECDH (public keys exchanged over signaling)
        │
        ▼ deriveBits → 256 raw bytes
        │
        ▼ HKDF-SHA-256 with disjoint info labels
        │
        ├── senderKey   = HKDF(K, "alfajer-v1-<my-role>")    ← encrypt only
        ├── receiverKey = HKDF(K, "alfajer-v1-<peer-role>")  ← decrypt only
        └── chatKey     = HKDF(K, "alfajer-v1-chat")         ← encrypt + decrypt
                            where role ∈ {offerer, answerer}
```

`my-role` is `offerer` for the peer that called `createOffer` and
`answerer` for the other. The two video labels produce independent
AES-GCM keys, so an IV collision across peers is structurally impossible
to exploit — the ciphertexts live in different keyed spaces. Per-frame
video IV is `timestamp(4) ‖ ssrc(4) ‖ 0(4)`, unique per frame under
each key. Chat uses a random 96-bit IV per message.

Only video frames go through the transform; Opus audio packets are too
small for the worker's 10-byte header-preservation scheme and stay
protected by DTLS-SRTP. The 32-bit video timestamp wraps after ~13 hours
of continuous streaming; realistic 1-to-1 calls never approach that, but
a counter in the IV trailer is the documented next step if needed.

## Security headers (frontend)

The Cloudflare `_headers` file applies, on every response:

- `Content-Security-Policy: default-src 'self'; script-src 'self'
  'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:; font-src 'self'; connect-src 'self'
  https://signaling.alaobeidat.com wss://signaling.alaobeidat.com;
  media-src 'self' blob:; worker-src 'self' blob:; manifest-src 'self';
  frame-ancestors 'none'; form-action 'self'; base-uri 'self';
  object-src 'none'; upgrade-insecure-requests`
- `Strict-Transport-Security: max-age=31536000; includeSubDomains`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: no-referrer`
- `Permissions-Policy: camera=(self), microphone=(self),
  display-capture=(self), geolocation=()`
- `Cross-Origin-Opener-Policy: same-origin`

Caching: hashed `_app/immutable/*` assets get `max-age=1y, immutable`;
`sw.js` gets `must-revalidate`; the manifest is cached for an hour.

## Browser support

| Browser | Calls | E2EE (script-transform) | Screen sharing | PWA install |
|---|---|---|---|---|
| Chrome desktop | ✓ | ✓ | ✓ | ✓ |
| Chrome Android | ✓ | ✓ | ✗ (no `getDisplayMedia` on phones) | ✓ |
| Safari macOS | ✓ | ✓ | ✓ | ✓ |
| Safari iOS | ✓ | ✓ (iOS 16.4+) | ✗ (not implemented on iPhone) | ✓ |
| Firefox desktop | ✓ | partial | ✓ | partial |
| Edge | ✓ | ✓ | ✓ | ✓ |

Peers that don't support `RTCRtpScriptTransform` participate in calls
normally; E2EE just isn't applied on top of DTLS-SRTP for that pair.

## License

Private — not open source. All rights reserved.
