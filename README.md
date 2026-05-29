# Alfajer

**Alfajer** is a fully anonymous, private, secret **1-to-1** video/audio
calling PWA. No accounts, no databases, no logs, no analytics, no cookies.
Just a 9-digit room code, a session-only nickname, and the other person.

Live: <https://alfajer.alaobeidat.com>

## What it does

- Open the home page, type a nickname, and either:
  - **Start new call** — generates a random 9-digit room code (out of 1
    billion possible values) and drops you into the room. Share the code
    (or the link) via WhatsApp, the native share sheet, or
    copy-to-clipboard.
  - **Join existing call** — type the 9-digit room code your peer sent.
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

## Security & privacy

Alfajer is built to deserve its "private and anonymous" claim. Every
control below is in place and verified live. None of this depends on
trusting the operator — the architecture removes the ability to
exfiltrate data even if the operator wanted to.

### Cryptography

| Control | Implementation |
|---|---|
| Per-peer media encryption | DTLS-SRTP (WebRTC baseline) |
| Additional video E2EE layer | AES-256-GCM via `RTCRtpScriptTransform`, gated on a capability handshake — engaged only when both peers signal support |
| Key exchange | Elliptic-curve Diffie-Hellman over P-256 (Web Crypto `generateKey` + `deriveBits`) |
| Key derivation | HKDF-SHA-256 with disjoint info labels per direction (`alfajer-v1-offerer`, `alfajer-v1-answerer`, `alfajer-v1-chat`) |
| Per-direction keys | Sender and receiver hold independent AES-GCM keys (`encrypt`-only / `decrypt`-only usages) — an IV collision between peers is structurally impossible to exploit |
| IV structure | 12 bytes = `timestamp(4) ‖ ssrc(4) ‖ 0(4)` — unique per frame under each key |
| Chat encryption | Separate AES-GCM key derived from the same ECDH secret; random 96-bit IV per message; the signaling server only ever sees opaque ciphertext + IV. Messages composed before the chat key is derived are **queued in JS memory and never sent over the wire as plaintext**; the receive side strictly rejects any incoming non-encrypted chat frame. |
| Key material exposure | All `CryptoKey`s created with `extractable: false`; non-extractable in the worker too. The JS-visible view of the raw ECDH `deriveBits` output is `.fill(0)`'d after the HKDF base key is constructed. |
| MITM detection (SAS) | After ECDH, each peer hashes both public keys in canonical order (offerer's first) and renders the first 4 bytes of SHA-256 as a 5-digit code. Both peers see the **same** code; a signaling-server MITM that swapped keys would produce divergent codes. Users compare verbally — a mismatch unambiguously reveals an active attack. ZRTP-style design. |
| Security-state indicator | Visible UI badge during the call: 🔒 **E2EE** (script-transform engaged), 🔐 **DTLS-SRTP** (peer browser lacks the API, falling back to baseline WebRTC encryption), or ⏳ **Securing…** (handshake in progress). No silent downgrade. |

### Transport security headers

Applied to every response from the frontend domain via Cloudflare `_headers`:

| Header | Value | Purpose |
|---|---|---|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains; preload` | HSTS preload-eligible; forces HTTPS for all current and future subdomains |
| `Content-Security-Policy` | `default-src 'self'` + scoped `connect-src` to signaling only + `worker-src 'self' blob:` + `frame-ancestors 'none'` + `object-src 'none'` + `upgrade-insecure-requests` | Locks down where scripts, styles, media, and connections can come from |
| `X-Content-Type-Options` | `nosniff` | Disables MIME-sniffing attacks |
| `X-Frame-Options` | `DENY` | Stops clickjacking via iframe embedding |
| `Referrer-Policy` | `no-referrer` | Room URLs never leak via the Referer header |
| `Permissions-Policy` | `camera=(self), microphone=(self), display-capture=(self), geolocation=()` | Camera/mic/screen-share allowed only same-origin; geolocation blocked entirely |
| `Cross-Origin-Opener-Policy` | `same-origin` | Process-isolates the page from any popup opener |

Caching: hashed `_app/immutable/*` assets get `max-age=1y, immutable`;
the service worker gets `must-revalidate`; the manifest is 1 hour.

### DNS chain of trust

| Control | What it does |
|---|---|
| **DNSSEC** | Algorithm 13 (ECDSA P-256 / SHA-256) signatures published; DS record at the `.com` parent; validating resolvers reject forged responses. AD-flag verified end-to-end. |
| **CAA records** | Apex `alaobeidat.com` whitelists only Let's Encrypt + the major CAs Cloudflare may use (`pki.goog`, `ssl.com`, `comodoca.com`, `digicert.com`). Any other CA attempting to issue a cert is blocked at the CA layer. `iodef` record points to an operator email for violation reports. |
| **Subdomain proxy split** | Frontend proxied through Cloudflare (DDoS absorption, edge cert termination). Signaling + TURN DNS-only direct to origin — UDP can't traverse a Cloudflare proxy and TLS termination matters end-to-end for WebRTC trust. |

### Signaling-layer defenses

| Control | What it does |
|---|---|
| **WebSocket Origin allowlist** | Inbound WS upgrades are rejected (close code 1008) unless the `Origin` header matches the configured allowlist. Defeats Cross-Site WebSocket Hijacking from any other browser-origin page. |
| **Per-IP rate limit on `/turn-credentials`** | 20 requests / minute / IP. Beyond that, 429 with `Retry-After: 60`. Stops attackers from minting unlimited HMAC credentials to abuse the TURN relay as free bandwidth. |
| **Per-IP rate limit on WebSocket upgrades** | 30 connections / minute / IP. Brute-forcing the 1B-code room space from a single IP would take ~63 years; even a 1000-IP botnet needs ~3 weeks. |
| **Frame size cap** | Inbound WS messages over 64 KB trigger close code 1009 ("Message too big"). Real SDP / ICE / chat payloads stay under 16 KB; this rejects memory-exhaustion attacks. |
| **TypeBox schema validation** | Every inbound message is validated against a typed schema (`type`, `payload`, `ecdhPublicKey`, `e2eeSupported`, `enc`, `iv`). Forward-compatible — unknown fields are forwarded but not interpreted. |
| **9-digit room codes** | 1 billion possible values. Codes are generated by the browser's cryptographic RNG, not a deterministic counter. Legacy 6-digit codes still work for backward compatibility. |
| **Room seal + knock acceptance** | A second peer connecting to an active room must be explicitly accepted by the initiator via a knock dialog. A third peer trying to join is rejected with close code 1008. |
| **No payload / IP / room-ID logging** | Production signaling emits no application-level logs. In dev only, the message *type* is logged with the room and peer IDs redacted. |

### TURN-layer defenses

| Control | What it does |
|---|---|
| **Short-lived HMAC credentials** | Each browser gets a TURN credential valid for 1 hour, derived as HMAC-SHA1 of `(expiry-timestamp:username, secret)`. Stale credentials are rejected by CoTURN. |
| **Two transports, ICE-prioritized** | Plain `turn:` on UDP (low latency) plus `turns:` on TLS/TCP (works through restrictive networks). WebRTC picks the lowest-RTT candidate. |
| **Bandwidth quotas** | `user-quota=50` and `total-quota=200` cap how many simultaneous relay sessions a single credential or the whole server will hold. A leaked credential can't be used to flood the relay. |
| **Loopback / RFC 1918 peer blocking** | CoTURN config refuses to relay traffic destined for `10/8`, `192.168/16`, `172.16/12`, or `169.254/16` — defends against SSRF-style abuse where a relayed connection is used to reach the operator's internal network. |
| **TLS only** | `no-tlsv1` and `no-tlsv1_1` in the CoTURN config. Modern TLS 1.2+ only. |
| **Secret rotation** | One-command (`update-secret.bat`) atomic rotation every 90 days. Old configs preserved as backups; secret never appears on any command line or in any log. |

### Server hardening

| Control | What it does |
|---|---|
| **fail2ban (sshd jail)** | 5 failed SSH attempts in 10 minutes → 1-hour ban for that source IP. Auto-loaded jail; survives reboots. |
| **Unattended security upgrades** | `unattended-upgrades` configured for security-only origins. Patches land within 24 hours of release with no manual intervention. |
| **systemd hardening directives** | The signaling unit runs with `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict`, `ProtectHome=read-only`, `ProtectKernelTunables`, `ProtectKernelModules`, `ProtectControlGroups`, `RestrictSUIDSGID`, `LockPersonality`, `RestrictRealtime`, `SystemCallArchitectures=native`. Compromise of the signaling process can't escalate to the rest of the box. |
| **Hetzner cloud firewall** | Only the ports the app actually needs are open inbound; SSH limited to a single source IP. |
| **TLS auto-renewal** | Certbot timer + pre-hook stops Caddy → certbot binds port 80 → deploy-hook re-grants CoTURN read access to the cert → post-hook restarts Caddy. Survives unattended renewals every 60 days. |
| **No secrets in tracked source** | `.gitignore` covers `deploy-secrets.local.txt`, `.env`, and the Claude Code permission file. Git history scrubbed via `git-filter-repo` to remove an accidentally-committed prior secret. |

### Application-layer privacy

| Control | What it does |
|---|---|
| **No accounts** | Identity is a session-only string generated client-side and stored in `sessionStorage`. Closes when the tab does. |
| **No database, no Redis, no log files** | The signaling server holds room state in process memory. When the second peer leaves, the room is gone — nothing to "delete" because nothing was ever persisted. |
| **No third-party analytics, fonts, or trackers** | The frontend loads zero cross-origin resources at runtime. No Google Fonts, no Analytics, no Tag Manager. Confirmed via deep test — zero cross-origin URLs in any bundle. |
| **No cookies** | The app doesn't set, read, or rely on any cookies. |
| **Google Translate suppressed app-wide** | `translate="no"` + `notranslate` class + `<meta name="google" content="notranslate">` so the UI doesn't get rewritten mid-call. |
| **Forward secrecy** | Each call's ECDH keypair is fresh and discarded when the call ends. Capturing past traffic and stealing future keys reveals nothing about earlier calls. |

### Verified by automated and manual deep tests

- TLS cert chain validity, expiry, and renewal
- HSTS preload eligibility
- CSP enforcement under live interaction
- WebSocket Origin allowlist (positive + negative path)
- Per-IP rate limiter behaviour at the 20 / 30 boundary
- 64 KB frame cap triggers the documented close code
- TURN HMAC roundtrip consistency
- DNSSEC validating-resolver AD flag end-to-end
- No leaked secrets in any tracked file or deployed JS bundle (20+ bundles scanned)
- Git history free of prior secret references on every branch tip and in every reachable blob

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
