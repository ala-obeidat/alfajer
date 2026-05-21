# Deployment Guide for Alfajer

This guide provides instructions to deploy Alfajer into a production environment utilizing Docker, Caddy (for SSL & reverse proxy), and a hardened CoTURN server.

## 1. CoTURN Installation

Provision a VPS dedicated to CoTURN (or use the same host for small scale).
Upload the `infra/coturn/` directory to the server.

Execute the install script:
```bash
cd infra/coturn
chmod +x install.sh
sudo ./install.sh
```

Ensure you update `static-auth-secret` in `turnserver.conf` with a strong cryptographic random string and match this string in your signaling server's environment variables.

## 2. Environment Setup

Create a `.env` file in the root (for docker) or in `apps/signaling/` directly:
```env
PORT=3000
TURN_STATIC_AUTH_SECRET=your_super_secret_key
ALLOWED_ORIGIN=https://your-domain.com
```

## 3. Deployment with PM2 (or Docker)

Since Alfajer is built with Bun and SvelteKit (static adapter):

### Frontend (`apps/web`)
Build the static site:
```bash
bun --cwd apps/web run build
```
Deploy the `apps/web/build` directory to any static host (e.g., Cloudflare Pages, Vercel, Netlify, or Caddy/Nginx).

### Signaling Server (`apps/signaling`)
Run the signaling server via Bun:
```bash
bun --cwd apps/signaling run src/index.ts
```

Alternatively, you can build it into a self-contained executable:
```bash
bun build apps/signaling/src/index.ts --compile --outfile signaling-server
./signaling-server
```

## 4. Reverse Proxy & SSL (Caddy Example)

If hosting on a single VPS, use Caddy for automatic HTTPS:

`/etc/caddy/Caddyfile`:
```
your-domain.com {
  root * /path/to/alfajer/apps/web/build
  file_server

  # Proxy WebSocket connections to signaling server
  reverse_proxy /call/* localhost:3000
  reverse_proxy /turn-credentials localhost:3000
}
```

Reload Caddy: `sudo systemctl reload caddy`.

## 5. Security Checklist
- [ ] Turn off all logging in the reverse proxy to maintain strict privacy.
- [ ] Verify CoTURN `denied-peer-ip` rules to prevent internal server SSRF via TURN.
- [ ] Ensure HTTPS is enforced. E2EE (RTCRtpScriptTransform) requires a Secure Context.
