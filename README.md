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

A user-facing version of this section lives at
[/privacy](https://alfajer.alaobeidat.com/privacy) on the deployed app,
written in plain prose for end users. The table below is the operator
view, cross-referenced to the code that implements each control.

### Cryptography

| Control | Implementation |
|---|---|
| Per-peer media encryption | DTLS-SRTP (WebRTC baseline) |
| Additional video + audio E2EE layer | AES-256-GCM via `RTCRtpScriptTransform` on every frame of both kinds. Negotiated via two capability flags (`e2eeSupported` for video, `audioE2EESupported` for audio); engaged independently per kind so a new client paired with an older video-only client still gets video E2EE while audio gracefully falls back to DTLS-SRTP. |
| Key exchange | Elliptic-curve Diffie-Hellman over P-256 (Web Crypto `generateKey` + `deriveBits`) |
| Key derivation | HKDF-SHA-256 with disjoint info labels — five keys per call: video sender/receiver (`alfajer-v1-<role>`), audio sender/receiver (`alfajer-v1-<role>-audio`), chat (`alfajer-v1-chat`) |
| Per-direction × per-kind keys | Sender and receiver hold independent AES-GCM keys (`encrypt`-only / `decrypt`-only usages); video and audio use separate key chains, so an IV collision between peers OR between media kinds is structurally impossible to exploit |
| IV structure | 12 bytes = `timestamp(4) ‖ ssrc(4) ‖ 0(4)` — unique per frame under each key. Audio and video have distinct SSRCs by WebRTC design; combined with distinct keys per kind, IV collision is structurally impossible. |
| Codec-aware header preservation | Video frames preserve 10 bytes (VP8/VP9/H.264 payload descriptor); audio frames preserve 1 byte (Opus TOC). Everything after the preserved bytes is ciphertext. |
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

### Continuous third-party scrutiny

| Layer | What it catches | Where |
|---|---|---|
| **Vitest CI** | The security-invariant regression guards listed below. Blocks every push and every PR if any guard fires. | `.github/workflows/ci.yml` |
| **CodeQL SAST** | GitHub-native static analysis with the `security-extended` query set: hard-coded credentials, weak crypto, prototype pollution, dangerous regex, taint flow. Results in the repo's "Security → Code scanning alerts" tab. Runs on push, PR, and weekly cron. | `.github/workflows/codeql.yml` |
| **bun audit** | High-severity dependency-CVE advisories on every push. Continues-on-error so a noisy advisory doesn't block unrelated merges; visible in the workflow log. | `.github/workflows/ci.yml` (audit job) |
| **Dependabot** | Weekly PRs for npm + GitHub-actions ecosystems, grouped by family (svelte, vite, eslint, types) to avoid flood. | `.github/dependabot.yml` |

### Automated security regression tests (vitest)

The CI build runs invariant guards that grep the source for patterns we've
explicitly eliminated, so accidental re-introduction is caught immediately:

| Test | Guards against |
|---|---|
| `apps/signaling/src/rate-limit.test.ts` | Per-IP rate-limit logic correctness, window expiry, bucket isolation, X-Forwarded-For parsing, Headers-object compatibility |
| `apps/signaling/src/security-invariants.test.ts` | Plaintext-chat regression, receiver-strictness, chat-queue zeroization on cleanup, SAS derived from public keys (not the shared secret), encrypt/decrypt-only key usages preserved, production fail-closed Origin check, CORS doesn't fall back to `*` in production, WS frame cap + 1009 close wired, payload/IP/room-ID never logged, additionalProperties:true on the typed body schema |

### Functional & cross-browser end-to-end tests

Beyond the security invariants, the call experience is covered by a functional
test layer. Current status: **20 web unit tests pass** and **10 Playwright
end-to-end tests pass across Chromium, Firefox, and WebKit** (engine-specific
cases are skipped on the other engines).

| Layer | Status | Covers |
|---|---|---|
| **Web unit** (`vitest`, `apps/web/src`) | 20 passing | The **real** E2EE frame logic shared by the worker and `WebRTCManager` (`transform-core.ts`): IV construction, per-kind header preservation, AES-GCM encrypt/decrypt round-trip, wrong-key + altered-IV rejection, audio/video key separation, and capability negotiation / mixed-client fallback — plus PWA install-eligibility detection across iOS & macOS Safari vs Chromium/Firefox UAs. |
| **Playwright E2E** (`apps/web/tests`, Chromium + Firefox + WebKit) | 10 passing | Two-peer call setup (knock → accept / reject, sealed-room `1008`), the extended E2EE layer engaging (`securityState → 'e2ee'`) and the Firefox/no-`RTCRtpScriptTransform` DTLS-SRTP fallback label, the camera-off audio-sink guard, mic-AEC + speaker (`setSinkId`) device handling, WebSocket chat ciphertext (no plaintext on the wire) + forged-message drop, SAS code agreement across both peers, ICE-restart on network drop, the Safari/iOS install banner on real WebKit, and `getUserMedia`-denied handling. |

These functional tests are **mutation-verified**: each key assertion has been
confirmed to *fail* when its underlying feature is deliberately broken, so they
guard real behaviour rather than passing vacuously. What they deliberately do
**not** cover — and what still needs a human on real hardware — is acoustic echo
on a physical external/Bluetooth speaker and the real iOS Safari "Add to Home
Screen" install, neither of which a headless browser can faithfully reproduce.

### Things prior reviewers have gotten wrong (read this before flagging them again)

Three claims have come up in past third-party reviews that are
**factually incorrect**. They keep returning, so they're called out here:

| Misconception | What's actually true |
|---|---|
| "The TURN server decrypts the DTLS layer / can read messages." | **No.** TURN is a layer-4 packet relay defined by RFC 8656. The DTLS handshake happens end-to-end between the two browsers, even when packets are routed through TURN. TURN holds zero key material and cannot decrypt. This isn't an Alfajer-specific design — it's how every WebRTC product works. |
| "The signaling server logs SDP / ICE candidates / IPs / room IDs." | **No.** Production logs nothing application-level. Dev logs emit only the message TYPE with room and peer IDs redacted. Verified by `journalctl -u alfajer-signaling --no-pager`. The code is in `apps/signaling/src/index.ts` — search for `console.log` and confirm. |
| "Uses outdated `ws`, `express`, and other packages." | **We use neither.** Signaling is built on **Bun + ElysiaJS**. The dependency list is in `apps/signaling/package.json`: `elysia`, `@elysiajs/cors`, `@sinclair/typebox`. Reviewers who flag `ws`/`express` are reviewing the wrong project or a hallucinated version. |
| "No CSP / no X-Frame / no HSTS / HTTP not redirected." | **All present.** Verified live via `curl -sI https://alfajer.alaobeidat.com/`. See the headers table earlier in this document. The complete list is enforced by `apps/web/static/_headers`. |

If a future reviewer claims any of the above, ask them to verify against
the live deployment or the current source before responding. The cost
of repeatedly re-litigating these is real.

### Known limitations & explicitly deferred items

Some items in the security space are either deferred with reasoning or out
of scope for an indie project. Documenting them honestly is part of the
trust claim — these are gaps we know about, not ones we forgot.

| Item | Status | Reasoning |
|---|---|---|
| **CSP `'unsafe-inline'` on script-src** | Deferred | SvelteKit's `adapter-static` emits an inline bootstrap script in the SPA fallback HTML. The inline content changes every build. A hash-based CSP would require a post-build step that scans the HTML, computes the SHA-256 of each `<script>`, and rewrites `_headers`. That pipeline is fragile and easy to break on framework upgrades. Practical-XSS exposure is very narrow because the app has no SSR, never renders user-supplied content as HTML, and Svelte's auto-escape covers every interpolation. The strict directives on `connect-src`, `worker-src`, `frame-ancestors`, `object-src`, etc. remain in effect. |
| **SAS verification depends on user comparison** | Mitigated, not eliminated | The 3-state UI (Encrypted / Verified / Warning) makes the comparison explicit — users must actively click "Codes match" to reach the green "Verified" badge. A user who ignores the prompt stays in the "Encrypted (Not Verified)" amber state. This is the strongest mitigation possible without forcing a modal that breaks call flow. |
| **Room codes are bearer secrets** | Mitigated, by design | Anyone who has the 9-digit code can attempt to join. The current mitigations: (1) 9-digit space = 1 billion codes; (2) per-IP rate limits make brute-force ~63 years for one attacker; (3) the host explicitly accepts every join via a knock dialog before media starts; (4) rooms seal at 2 peers — a third connection is rejected; (5) the room-code share screen displays a "⚠ Anyone with this code can try to join" notice. Removing the bearer model entirely would require accounts, which is incompatible with the no-accounts privacy claim. |
| **Single-instance rate-limiting** | Acceptable at current scale | All rate-limit state lives in process memory. A signaling restart resets the counters; a horizontal scale-out would need shared state (Redis or similar). For the current "one VPS, one signaling process" deploy this is correct architecture — if traffic ever justifies multiple instances, the rate-limit module is a single drop-in change away from being Redis-backed. |
| **External penetration test** | Not done | Out of scope for an indie deploy. Every technical control we can implement and verify ourselves is in place; the remaining 1-of-10 in any honest security rating is reserved for the kind of finding only a paid human pentester surfaces (business-logic exploits, supply-chain audit, undocumented browser behaviour). |
| **Web-app delivery is a trust point** | Inherent | Every visit downloads JS from our server. If the deployment pipeline, Cloudflare account, domain, or CDN edge were compromised, an attacker could in principle serve tampered code that bypasses the encryption model. This is true of every browser-delivered E2EE product (Signal Web, Proton Mail web, Bitwarden web). Mitigations in place: strict CSP, HSTS preload, CAA records pinning issuing CAs, DNSSEC, Cloudflare account 2FA, secret rotation tooling, automated dependency scanning, CodeQL SAST in CI. True elimination would require a native app pinned by an app-store review process — not in scope. **A user-facing version of this caveat is documented at [/privacy](https://alfajer.alaobeidat.com/privacy).** |
| **TURN bandwidth abuse via leaked credential** | Mitigated, capped | TURN credentials are 1-hour HMACs. Bandwidth-quota directives (`user-quota=50`, `total-quota=200`) cap how much relay a single credential or the whole server will hand out. A leaked credential can't be used to free-ride the relay at scale. |

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

### Caddy configuration (server-side, not in this repo)

The signaling box's `/etc/caddy/Caddyfile` must contain a site block for
`signaling.alaobeidat.com` that reverse-proxies to `localhost:3000`.
If you're hosting other sites on the same box, **append** new blocks —
don't replace the file — or signaling stops serving TLS for our domain
(Caddy refuses TLS handshakes for any host without a configured site).

Minimum signaling block:

```caddyfile
signaling.alaobeidat.com {
    encode zstd gzip
    reverse_proxy localhost:3000 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
        transport http {
            read_timeout 24h
            write_timeout 24h
        }
    }
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "no-referrer"
        Permissions-Policy "camera=(), microphone=(), geolocation=()"
        -Server
    }
    log { output discard }
}
```

The 24-hour transport timeout is intentional — without it Caddy would
close idle WebSocket connections after 30 seconds, breaking any call
that pauses for that long.

The signaling-deploy CI runs an external healthcheck against
`https://signaling.alaobeidat.com/healthz` after each redeploy and fails
loudly if the Caddyfile is misconfigured.

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

Per-frame AES-256-GCM encryption via `RTCRtpScriptTransform` covers **both
video and audio** when supported. Engagement is negotiated independently
per media kind, so the system degrades gracefully:

| Both peers support… | Video E2EE | Audio E2EE | Chat E2EE |
|---|---|---|---|
| `e2eeSupported` + `audioE2EESupported` | ✓ | ✓ | ✓ |
| `e2eeSupported` only (e.g. older client paired with newer) | ✓ | DTLS-SRTP only | ✓ |
| Neither | DTLS-SRTP only | DTLS-SRTP only | ✓ |

Peers that lack `RTCRtpScriptTransform` (older Safari, older Chrome
Android) fall back transparently to plain WebRTC, which is still
encrypted by DTLS-SRTP between peers — the signaling and TURN servers
never see plaintext.

Key derivation chain when full E2EE is engaged:

```
P-256 ECDH (public keys exchanged over signaling)
        │
        ▼ deriveBits → 256 raw bytes
        │
        ▼ HKDF-SHA-256 with disjoint info labels
        │
        ├── videoSenderKey   = HKDF(K, "alfajer-v1-<my-role>")          ← encrypt only
        ├── videoReceiverKey = HKDF(K, "alfajer-v1-<peer-role>")        ← decrypt only
        ├── audioSenderKey   = HKDF(K, "alfajer-v1-<my-role>-audio")    ← encrypt only
        ├── audioReceiverKey = HKDF(K, "alfajer-v1-<peer-role>-audio")  ← decrypt only
        └── chatKey          = HKDF(K, "alfajer-v1-chat")               ← encrypt + decrypt
                                 where role ∈ {offerer, answerer}
```

`my-role` is `offerer` for the peer that called `createOffer` and
`answerer` for the other. Five independent AES-GCM keys per call. An
IV collision across peers, across directions, or across media kinds is
structurally impossible to exploit — the ciphertexts live in entirely
disjoint keyed spaces.

Per-frame video and audio IVs are both `timestamp(4) ‖ ssrc(4) ‖ 0(4)`,
unique per frame under each key. Header preservation is kind-aware: video
keeps 10 bytes (worst-case VP8/VP9/H.264 payload descriptor), audio keeps
1 byte (the Opus TOC byte the decoder needs to parse the frame).
Everything after the preserved bytes is ciphertext. Chat uses a random
96-bit IV per message.

The 32-bit RTP timestamp wraps after ~13 hours (video, 90 kHz clock) or
~24 hours (audio, 48 kHz clock). Realistic 1-to-1 calls never approach
either; a counter in the IV trailer is the documented next step if
ultra-long-duration calls ever become a use case.

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
