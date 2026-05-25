# Alfajer

**Alfajer** is a fully anonymous, private, secret **1-to-1** video/audio calling
PWA. No accounts, no databases, no logs, no analytics, no cookies. Just a
6-digit room code, your nickname for the session, and the other person.

Live: <https://alfajer.alaobeidat.com>

## What it does

- Open the home page, type a nickname, and either:
  - **Start new call** — generates a random 6-digit room code and drops you into
    the room. Share the code (or the link) over WhatsApp, native share sheet,
    or copy-to-clipboard.
  - **Join existing call** — type the 6-digit room code your peer sent you.
- Calls are 1-to-1. The room **seals** the moment two peers connect — a third
  browser trying the same code is rejected by the signaling server.
- When both peers leave, the room is gone. There is nothing to "delete"
  because nothing was ever persisted.

## Privacy guarantees

- **No persistent storage.** Rooms live only in the signaling server's process
  memory. No DB. No Redis. No log files. Server crashes wipe state.
- **No logs.** The signaling server intentionally does not log peer IPs, room
  IDs, signaling payloads, or call metadata.
- **No accounts.** Your "identity" is a session-only string that exists in
  `sessionStorage` and disappears the instant you close the tab.
- **DTLS-SRTP** media encryption is on by default — that's built into WebRTC.
  An additional script-transform AES-GCM layer is in the codebase but disabled
  pending a cross-browser capability handshake.

## Architecture

Bun-managed monorepo:

| Path | What it is |
|------|------------|
| `apps/web` | SvelteKit PWA (English-only), `adapter-static` → deployed to Cloudflare Workers/Pages. |
| `apps/signaling` | Bun + ElysiaJS WebSocket signaling server with TypeBox-validated payloads. In-memory room registry. |
| `infra/coturn` | Hardened CoTURN configuration + env-driven install script (Let's Encrypt cert, renewal hook, hardened defaults). |

Production topology:

- `alfajer.alaobeidat.com` → Cloudflare Workers (static SvelteKit build, served via CF edge).
- `signaling.alaobeidat.com` → Caddy reverse-proxy → Bun signaling on port 3000.
- `turn.alaobeidat.com:5349` → CoTURN with TURNS over TLS (port 443 reserved for Caddy).
- Single Hetzner Cloud CAX (ARM64) box runs CoTURN + Caddy + signaling under systemd.

## Local development

Requirements: [Bun](https://bun.sh/) ≥ 1.2.

```bash
bun install
bun run dev      # starts signaling on :3000 and web on :5173 in parallel
bun run test     # vitest across workspaces
bun run lint     # ESLint
bun run lint:css # Stylelint
```

For local web → local signaling, no env vars are needed — the web client
falls back to `ws://localhost:3000` when `PUBLIC_SIGNALING_URL` is unset.

## Deployment notes

The Cloudflare Pages build is configured to:

- **Build command:** `cd apps/web && bun install --no-frozen-lockfile && bun run build`
- **Deploy command:** `cd apps/web && npx wrangler deploy`
- **Required env vars (Production):**
  - `PUBLIC_SIGNALING_URL` — e.g. `https://signaling.alaobeidat.com`
  - `PUBLIC_TURN_URL` — e.g. `turns:turn.alaobeidat.com:5349?transport=tcp`

The server-side install is driven by `infra/coturn/install.sh`, which expects
`TURN_DOMAIN`, `TURN_REALM`, `LETSENCRYPT_EMAIL`, and `TURN_STATIC_AUTH_SECRET`
in the environment. The same secret must be set in `apps/signaling/.env` so
TURN authentication HMACs line up.

### Signaling auto-deploy

Pushes to `main` that touch `apps/signaling/**` trigger
`.github/workflows/deploy-signaling.yml`, which rsyncs the source to
`/root/alfajer/apps/signaling/` on the server, runs `bun install --production`,
and restarts the `alfajer-signaling` systemd unit. Required repository secrets:

| Secret | What goes in it |
|---|---|
| `DEPLOY_HOST` | Your server's public IP or hostname |
| `DEPLOY_USER` | `root` (or whatever account owns `/root/alfajer/`) |
| `DEPLOY_SSH_KEY` | The contents of your SSH private key file (PEM format) |
| `DEPLOY_HOST_KEY` | The server's SSH host pubkey lines (`ssh-keyscan -t ed25519,rsa <your-server-ip>` output) |

### Rotating the TURN secret (90-day cadence)

From the project root on the Windows host, just run:

```cmd
update-secret.bat
```

The script generates a fresh 64-char hex secret with the OS RNG, pipes it
over SSH to the server's `update-secret.sh`, which patches both
`/etc/turnserver.conf` and `apps/signaling/.env` atomically, restarts coturn
and alfajer-signaling, and backs up the previous values to
`/root/alfajer-secret-backups/`. On success the local
`deploy-secrets.local.txt` is also rewritten.

If anything in the chain fails, the local file is left **untouched** so the
state on PC and server doesn't drift apart.

### E2EE notes

Per-frame AES-256-GCM encryption via `RTCRtpScriptTransform` is enabled at
runtime when **both** peers advertise support in their SDP offer/answer (the
`e2eeSupported` flag). Peers that lack the API (older Safari, older Chrome
Android) fall back transparently to plain WebRTC, which is still encrypted by
DTLS-SRTP between peers — the signaling and TURN servers never see plaintext.

Key derivation chain when E2EE is engaged:

```
P-256 ECDH (public keys exchanged over signaling)
        │
        ▼ deriveBits → 256 raw bytes
        │
        ▼ HKDF-SHA-256 with two disjoint info labels
        │
        ├── senderKey   = HKDF(K, "alfajer-v1-<my-role>")     ← encrypt only
        └── receiverKey = HKDF(K, "alfajer-v1-<peer-role>")   ← decrypt only
                          where role ∈ {offerer, answerer}
```

`my-role` is `offerer` for the peer that called `createOffer` and `answerer`
for the other. The two labels produce independent AES-GCM keys, so an IV
collision across peers is structurally impossible to exploit — the
ciphertexts live in different keyed spaces. Per-frame IV is
`timestamp(4) ‖ ssrc(4) ‖ 0(4)`, unique per frame under each key.

Only video frames go through the transform; Opus audio packets are too small
for the worker's 10-byte header-preservation scheme and stay protected by
DTLS-SRTP. The 32-bit timestamp wraps after ~13 hours of continuous video;
realistic 1-to-1 calls never approach that, but a counter in the IV trailer
is the documented next step if needed.

## Browser support

- Tested on recent Chrome desktop and Chrome / Safari on mobile (Android & iOS).
- WebRTC + WebSocket + `getUserMedia` are the only browser APIs strictly
  required. Google Translate auto-translate is suppressed app-wide so the UI
  doesn't get rewritten mid-call.

## License

Private — not open source. All rights reserved.
