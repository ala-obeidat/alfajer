# Alfajer

Alfajer is a stateless, privacy-first WebRTC 1:1 video/audio calling PWA. It strictly enforces anonymity with End-to-End Encryption (E2EE), zero persistent storage (no DB, no Redis, no logs), and logical-only CSS.

## Architecture

This project is a monorepo utilizing Bun workspaces:
- `apps/web`: SvelteKit frontend configured as a PWA, localized natively to Arabic (default) and English.
- `apps/signaling`: ElysiaJS + Bun WebSocket signaling server with TypeBox validation.
- `infra/coturn`: Hardened CoTURN configuration.

## Key Features
- **Privacy-First Design**: No server-side persistence. No IP logs. No payload inspection. No analytics. No Cookies.
- **True Statelessness**: Rooms are tracked purely in-memory. If a call drops, the room is annihilated.
- **E2EE**: Encrypted media streams utilizing `RTCRtpScriptTransform` with AES-256-GCM. Shared keys are established via ECDH over the signaling channel.
- **RTL Native**: Complete localization and Right-to-Left alignment enforcement through logical CSS properties (physical CSS like `margin-left` are actively linted against).

## Local Development

### Requirements
- [Bun](https://bun.sh/)
- Node (Optional for certain scripts)

### Running Locally

1. Install dependencies:
```bash
bun install
```

2. Start development servers (frontend and signaling concurrently):
```bash
bun run dev
```

3. Run Tests (Vitest across workspaces):
```bash
bun run test
```

4. Run Linting (ESLint + Stylelint):
```bash
bun run lint
bun run lint:css
```
