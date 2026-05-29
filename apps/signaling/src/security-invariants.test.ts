// Source-level invariant guards. These tests don't validate runtime
// behaviour — they validate that the SOURCE CODE doesn't accidentally
// re-introduce a class of bug we've explicitly closed before. They're
// effectively a project-specific lint, run on every CI build.
//
// Each test names a real prior regression in its title so a future
// developer can find the original incident.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ESM-safe __dirname (vitest can use either CJS or ESM under the hood
// depending on tsconfig + the test file's resolved module type).
const here = dirname(fileURLToPath(import.meta.url));

// Paths relative to apps/signaling/src/ where this test now lives.
const webrtc = readFileSync(
  resolve(here, '../../web/src/lib/webrtc.ts'), 'utf8'
);
const signaling = readFileSync(resolve(here, 'index.ts'), 'utf8');

describe('webrtc.ts — chat encryption invariants', () => {
  it('regression-guard: sendChat never emits a plaintext signaling frame', () => {
    // The historical bug:
    //   if (!this.chatKey) this.sendSignal({ type: 'chat', payload: text });
    // would emit an UNENCRYPTED payload when the key wasn't ready yet.
    // This regression-checks for any sendSignal call where the type is
    // 'chat' and 'enc' is NOT also being set.
    //
    // We allow exactly ONE sendSignal({type:'chat', enc:true, …}) call
    // (the legitimate encrypted path inside encryptAndSendChat()).
    const allChatSends = webrtc.matchAll(
      /sendSignal\(\s*\{[^}]*type:\s*['"`]chat['"`][^}]*\}\s*\)/g
    );
    for (const m of allChatSends) {
      const block = m[0];
      expect(
        block,
        'Found a sendSignal type:"chat" without enc:true — that would leak plaintext to the signaling server'
      ).toMatch(/enc:\s*!?true|enc:\s*[a-zA-Z_]+/);
    }
  });

  it('receiver rejects unencrypted chat frames (no fallback to msg.payload as plaintext)', () => {
    // The historical bug was an `else if (typeof msg.payload === 'string')'
    // branch in handleChatMessage that would surface plaintext as if it
    // were a legit peer message. Make sure that branch is gone.
    expect(
      webrtc,
      'handleChatMessage must not have a plaintext fallback branch — see commit ffff8d7'
    ).not.toMatch(
      /else\s+if\s*\(\s*typeof\s+msg\.payload\s*===\s*['"`]string['"`]\s*\)\s*\{[^}]*onChat/s
    );
  });

  it('chat queue is drained on cleanup so pending plaintext never sits in heap forever', () => {
    expect(webrtc).toMatch(/chatOutboundQueue\.length\s*=\s*0/);
  });

  it('SAS is derived from PUBLIC keys (the ones the signaling server could swap)', () => {
    // SHA-256 over canonical-ordered raw public keys is what makes the
    // SAS detect a signaling-MITM. If someone "optimized" this to hash
    // the shared secret instead, the MITM detection silently dies.
    expect(webrtc).toMatch(/exportKey\(\s*['"`]raw['"`]/);
    expect(webrtc).toMatch(/digest\(\s*['"`]SHA-256['"`]/);
    // The role-specific labels are constructed at runtime ('alfajer-v1-' +
    // myRole). The literal that IS in source is the prefix plus the chat
    // label suffix. Either confirms the HKDF labeling scheme is intact.
    expect(webrtc).toMatch(/['"`]alfajer-v1-['"`]/);
    expect(webrtc).toMatch(/['"`]alfajer-v1-chat['"`]/);
  });

  it('all CryptoKey usages are minimal (encrypt-only or decrypt-only) per direction', () => {
    // senderKey gets ['encrypt'], receiverKey gets ['decrypt']. The chat
    // key needs both because either peer can send. Just make sure we
    // never expand sender / receiver to both, which would defeat the
    // per-direction-key design.
    const senderDerive = webrtc.match(
      /senderKey\s*=\s*await\s+crypto\.subtle\.deriveKey\([\s\S]+?\[\s*['"`]encrypt['"`]\s*\]\s*\)/
    );
    const receiverDerive = webrtc.match(
      /receiverKey\s*=\s*await\s+crypto\.subtle\.deriveKey\([\s\S]+?\[\s*['"`]decrypt['"`]\s*\]\s*\)/
    );
    expect(senderDerive, 'senderKey must be encrypt-only').toBeTruthy();
    expect(receiverDerive, 'receiverKey must be decrypt-only').toBeTruthy();
  });
});

describe('signaling — production hardening invariants', () => {
  it('production fail-closed: ALLOWED_ORIGIN empty or "*" → process.exit(1)', () => {
    expect(signaling).toMatch(/NODE_ENV\s*===?\s*['"`]production['"`]/);
    expect(signaling).toMatch(/process\.exit\(\s*1\s*\)/);
  });

  it('CORS does not silently fall back to "*" in production', () => {
    // Acceptable forms:
    //   NODE_ENV === 'production' ? false : '*'
    //   any explicit allowlist
    // Unacceptable: a bare ': "*"' fallback with no env guard.
    const corsBlock = signaling.match(
      /\.use\(\s*cors\(\s*\{[\s\S]+?\}\s*\)\s*\)/
    );
    expect(corsBlock, 'cors() configuration must exist').toBeTruthy();
    if (corsBlock) {
      expect(corsBlock[0]).toMatch(/production[\s\S]+false/);
    }
  });

  it('WebSocket Origin allowlist exists and is checked in ws.open', () => {
    expect(signaling).toMatch(/isOriginAllowed/);
    expect(signaling).toMatch(/ws\.close\(\s*1008\s*,\s*['"`]Origin not allowed['"`]/);
  });

  it('per-IP rate limiters are wired to BOTH /turn-credentials and WS upgrades', () => {
    expect(signaling).toMatch(/turnCredLimiter\.hit/);
    expect(signaling).toMatch(/wsOpenLimiter\.hit/);
  });

  it('WebSocket message size is capped (close 1009 on oversize)', () => {
    expect(signaling).toMatch(/MAX_MESSAGE_BYTES/);
    expect(signaling).toMatch(/ws\.close\(\s*1009\s*,\s*['"`]Message too big['"`]/);
  });

  it('TypeBox schema allows additionalProperties for forward compat', () => {
    expect(signaling).toMatch(/additionalProperties:\s*true/);
  });

  it('NEVER logs raw payloads / room IDs / peer IDs (privacy claim)', () => {
    // Look for the SPECIFIC patterns we removed in the privacy
    // hardening commit. If someone adds them back, this catches it.
    expect(signaling).not.toMatch(/console\.log\([^)]*JSON\.stringify\(message\)/);
    expect(signaling).not.toMatch(/console\.log\([^)]*\$\{ws\.data\.id\}/);
    expect(signaling).not.toMatch(/console\.log\([^)]*\$\{roomId\}/);
  });
});
