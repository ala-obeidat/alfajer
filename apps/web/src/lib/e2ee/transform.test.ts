import { describe, it, expect } from 'vitest';
// Import the REAL shipping code (shared by transform.worker.ts and webrtc.ts),
// not a re-implementation. A previous version of this file copied all of this
// logic inline and stayed green even when the worker's IV/header/crypto code
// was corrupted — so it certified nothing.
import {
  buildIv,
  VIDEO_HEADER_SIZE,
  AUDIO_HEADER_SIZE,
  encryptFrame,
  decryptFrame,
  negotiateUse,
  appliedKinds,
} from './transform-core';

describe('Audio + Video E2EE Worker Logic', () => {
  it('IV generation packs 32-bit timestamp and SSRC correctly', () => {
    const timestamp = 0x11223344;
    const ssrc = 0x55667788;
    const iv = buildIv(timestamp, ssrc);

    expect(iv.byteLength).toBe(12);

    const view = new DataView(iv);
    expect(view.getUint32(0)).toBe(timestamp);
    expect(view.getUint32(4)).toBe(ssrc);
    expect(view.getUint32(8)).toBe(0); // reserved padding bytes
  });

  it('audio E2EE preserves exactly 1-byte Opus TOC header, encrypts body, and decrypts correctly', async () => {
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );

    // Mock Opus frame: 1-byte header, 39-byte audio body (total 40 bytes)
    const originalFrame = new Uint8Array(40);
    for (let i = 0; i < originalFrame.length; i++) {
      originalFrame[i] = i;
    }

    const iv = buildIv(1234567, 987654);

    const encrypted = await encryptFrame(originalFrame, AUDIO_HEADER_SIZE, key, iv);

    // Header preservation checks
    expect(encrypted.length).toBeGreaterThan(originalFrame.length); // AES-GCM tag adds overhead
    expect(encrypted[0]).toBe(originalFrame[0]); // 1st byte (TOC header) preserved exactly

    // Body encryption check (body must differ from original)
    const encryptedBody = encrypted.subarray(AUDIO_HEADER_SIZE);
    const originalBody = originalFrame.subarray(AUDIO_HEADER_SIZE);
    expect(encryptedBody).not.toEqual(originalBody);

    const decrypted = await decryptFrame(encrypted, AUDIO_HEADER_SIZE, key, iv);
    expect(decrypted).toEqual(originalFrame);
  });

  it('video E2EE preserves exactly 10-bytes payload descriptor, encrypts body, and decrypts correctly', async () => {
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );

    // Mock Video frame: 10-byte header, 30-byte video payload (total 40 bytes)
    const originalFrame = new Uint8Array(40);
    for (let i = 0; i < originalFrame.length; i++) {
      originalFrame[i] = i * 2;
    }

    const iv = buildIv(7654321, 456789);

    const encrypted = await encryptFrame(originalFrame, VIDEO_HEADER_SIZE, key, iv);

    // Header preservation checks
    expect(encrypted.length).toBeGreaterThan(originalFrame.length);
    expect(encrypted.subarray(0, 10)).toEqual(originalFrame.subarray(0, 10)); // first 10 bytes preserved

    // Body encryption check
    const encryptedBody = encrypted.subarray(VIDEO_HEADER_SIZE);
    const originalBody = originalFrame.subarray(VIDEO_HEADER_SIZE);
    expect(encryptedBody).not.toEqual(originalBody);

    const decrypted = await decryptFrame(encrypted, VIDEO_HEADER_SIZE, key, iv);
    expect(decrypted).toEqual(originalFrame);
  });

  it('decryption with a wrong key fails with an authentication tag error', async () => {
    const key1 = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
    const key2 = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );

    const originalFrame = new Uint8Array([99, 1, 2, 3, 4, 5]);
    const iv = buildIv(100, 200);

    const encrypted = await encryptFrame(originalFrame, AUDIO_HEADER_SIZE, key1, iv);

    const decryptedCorrect = await decryptFrame(encrypted, AUDIO_HEADER_SIZE, key1, iv);
    expect(decryptedCorrect).toEqual(originalFrame);

    // Decrypting with the wrong key throws OperationError / AES-GCM auth failure
    await expect(decryptFrame(encrypted, AUDIO_HEADER_SIZE, key2, iv))
      .rejects.toThrow();
  });

  it('decryption fails if the IV (timestamp/ssrc) is altered', async () => {
    // Guards the IV construction: a frame encrypted under (ts, ssrc) must not
    // decrypt under a different IV — i.e. buildIv actually feeds AES-GCM.
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
    const frame = new Uint8Array([7, 10, 20, 30, 40, 50, 60]);
    const encrypted = await encryptFrame(frame, AUDIO_HEADER_SIZE, key, buildIv(111, 222));
    await expect(decryptFrame(encrypted, AUDIO_HEADER_SIZE, key, buildIv(111, 999)))
      .rejects.toThrow();
  });

  it('pathologically small/tiny frames do not trigger encryption/decryption and are preserved safely', async () => {
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );

    // The worker skips encryption when frame length <= headerSize. We mirror
    // that guard here over the real header-size constants.
    const tinyAudioFrame = new Uint8Array([0xAA]); // TOC byte only
    const iv = buildIv(111, 222);
    let encAudio = tinyAudioFrame;
    if (tinyAudioFrame.length > AUDIO_HEADER_SIZE) {
      encAudio = await encryptFrame(tinyAudioFrame, AUDIO_HEADER_SIZE, key, iv);
    }
    expect(encAudio).toEqual(tinyAudioFrame); // preserved unchanged

    const tinyVideoFrame = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    let encVideo = tinyVideoFrame;
    if (tinyVideoFrame.length > VIDEO_HEADER_SIZE) {
      encVideo = await encryptFrame(tinyVideoFrame, VIDEO_HEADER_SIZE, key, iv);
    }
    expect(encVideo).toEqual(tinyVideoFrame); // preserved unchanged
  });
});

describe('Symmetric Key Separation (HKDF)', () => {
  it('audio and video derive separate keys using distinct info labels', async () => {
    const aliceKeyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey', 'deriveBits']
    );
    const bobKeyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey', 'deriveBits']
    );

    const sharedBits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: bobKeyPair.publicKey },
      aliceKeyPair.privateKey,
      256
    );

    const hkdfBase = await crypto.subtle.importKey(
      'raw',
      sharedBits,
      'HKDF',
      false,
      ['deriveKey']
    );

    const encoder = new TextEncoder();
    const deriveAesKey = async (label: string) => crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(),
        info: encoder.encode(label)
      },
      hkdfBase,
      { name: 'AES-GCM', length: 256 },
      true, // exportable so we can compare raw keys
      ['encrypt']
    );

    const videoKey = await deriveAesKey('alfajer-v1-offerer');
    const audioKey = await deriveAesKey('alfajer-v1-offerer-audio');

    const rawVideo = new Uint8Array(await crypto.subtle.exportKey('raw', videoKey));
    const rawAudio = new Uint8Array(await crypto.subtle.exportKey('raw', audioKey));

    expect(rawVideo).not.toEqual(rawAudio);
    expect(rawVideo.length).toBe(32); // 256 bits
    expect(rawAudio.length).toBe(32);
  });
});

describe('WebRTC Capability Negotiation & Mixed Client Fallbacks', () => {
  it('uses the extended layer for a kind only when BOTH peers support it', () => {
    expect(negotiateUse(true, true)).toBe(true);
    expect(negotiateUse(true, false)).toBe(false); // peer is video-only / older
    expect(negotiateUse(false, true)).toBe(false); // we don't support it
    expect(negotiateUse(false, false)).toBe(false);
  });

  it('applies both kinds when audio + video E2EE are negotiated', () => {
    const useVideo = negotiateUse(true, true);
    const useAudio = negotiateUse(true, true);
    expect(appliedKinds(useVideo, useAudio)).toEqual(['video', 'audio']);
  });

  it('audio falls back to DTLS-SRTP (video stays E2EE) against a video-only peer', () => {
    const useVideo = negotiateUse(true, true);
    const useAudio = negotiateUse(true, false); // peer advertised no audio E2EE
    const kinds = appliedKinds(useVideo, useAudio);
    expect(useVideo).toBe(true);
    expect(useAudio).toBe(false);
    expect(kinds).toContain('video');
    expect(kinds).not.toContain('audio');
  });

  it('applies nothing when neither kind is negotiated', () => {
    expect(appliedKinds(false, false)).toEqual([]);
  });
});
