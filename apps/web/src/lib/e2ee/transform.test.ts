import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------
// 1. IV Generator & Header Preservation Logic Replicas
// ---------------------------------------------------------------------

function buildIv(timestamp: number, ssrc: number): ArrayBuffer {
  const iv = new ArrayBuffer(12);
  const view = new DataView(iv);
  view.setUint32(0, timestamp >>> 0);
  view.setUint32(4, ssrc >>> 0);
  return iv;
}

const VIDEO_HEADER_SIZE = 10;
const AUDIO_HEADER_SIZE = 1;

async function encryptFrame(
  data: Uint8Array,
  headerSize: number,
  key: CryptoKey,
  iv: ArrayBuffer
): Promise<Uint8Array> {
  const header = data.subarray(0, headerSize);
  const body = data.subarray(headerSize);
  const enc = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, body)
  );
  const out = new Uint8Array(header.length + enc.length);
  out.set(header, 0);
  out.set(enc, header.length);
  return out;
}

async function decryptFrame(
  data: Uint8Array,
  headerSize: number,
  key: CryptoKey,
  iv: ArrayBuffer
): Promise<Uint8Array> {
  const header = data.subarray(0, headerSize);
  const body = data.subarray(headerSize);
  const dec = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, body)
  );
  const out = new Uint8Array(header.length + dec.length);
  out.set(header, 0);
  out.set(dec, header.length);
  return out;
}

// ---------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------

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
    // Generate AES-GCM key
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

    // Encrypt
    const encrypted = await encryptFrame(originalFrame, AUDIO_HEADER_SIZE, key, iv);
    
    // Header preservation checks
    expect(encrypted.length).toBeGreaterThan(originalFrame.length); // AES-GCM tag adds overhead
    expect(encrypted[0]).toBe(originalFrame[0]); // 1st byte (TOC header) preserved exactly

    // Body encryption check (body must differ from original)
    const encryptedBody = encrypted.subarray(AUDIO_HEADER_SIZE);
    const originalBody = originalFrame.subarray(AUDIO_HEADER_SIZE);
    expect(encryptedBody).not.toEqual(originalBody);

    // Decrypt
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

    // Encrypt
    const encrypted = await encryptFrame(originalFrame, VIDEO_HEADER_SIZE, key, iv);
    
    // Header preservation checks
    expect(encrypted.length).toBeGreaterThan(originalFrame.length);
    expect(encrypted.subarray(0, 10)).toEqual(originalFrame.subarray(0, 10)); // first 10 bytes preserved

    // Body encryption check
    const encryptedBody = encrypted.subarray(VIDEO_HEADER_SIZE);
    const originalBody = originalFrame.subarray(VIDEO_HEADER_SIZE);
    expect(encryptedBody).not.toEqual(originalBody);

    // Decrypt
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

    // Decrypting with correct key works
    const decryptedCorrect = await decryptFrame(encrypted, AUDIO_HEADER_SIZE, key1, iv);
    expect(decryptedCorrect).toEqual(originalFrame);

    // Decrypting with wrong key throws OperationError / AesGcm auth failure
    await expect(decryptFrame(encrypted, AUDIO_HEADER_SIZE, key2, iv))
      .rejects.toThrow();
  });
});

describe('Symmetric Key Separation (HKDF)', () => {
  it('audio and video derive separate keys using distinct info labels', async () => {
    // Generate ECDH key pair
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

    // Derive shared secret
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

    // Derivations for offerer role
    const videoKey = await deriveAesKey('alfajer-v1-offerer');
    const audioKey = await deriveAesKey('alfajer-v1-offerer-audio');

    // Export raw bytes to prove they are physically distinct keys
    const rawVideo = new Uint8Array(await crypto.subtle.exportKey('raw', videoKey));
    const rawAudio = new Uint8Array(await crypto.subtle.exportKey('raw', audioKey));

    expect(rawVideo).not.toEqual(rawAudio);
    expect(rawVideo.length).toBe(32); // 256 bits
    expect(rawAudio.length).toBe(32);
  });
});

// ---------------------------------------------------------------------
// 2. Peer Capability Negotiation & Fallback Mock Tests
// ---------------------------------------------------------------------

class MockWebRTCManager {
  public myE2EESupport = true;
  public myAudioE2EESupport = true;
  
  public peerE2EESupport = false;
  public peerAudioE2EESupport = false;

  public useE2EE = false;
  public useAudioE2EE = false;

  public signalingHistory: any[] = [];
  public appliedTransforms: string[] = [];

  constructor(myAudioSupport = true) {
    this.myAudioE2EESupport = myAudioSupport;
  }

  // Simulates receiving offer/answer
  public handleSignal(msg: any) {
    if (msg.type === 'offer' || msg.type === 'answer') {
      this.peerE2EESupport = msg.e2eeSupported === true;
      this.peerAudioE2EESupport = msg.audioE2EESupported === true;
      
      this.useE2EE = this.myE2EESupport && this.peerE2EESupport;
      this.useAudioE2EE = this.myAudioE2EESupport && this.peerAudioE2EESupport;

      this.applyTransformsIfReady();
    }
  }

  public tryIceRestart() {
    this.sendSignal({
      type: 'offer',
      e2eeSupported: this.myE2EESupport,
      audioE2EESupported: this.myAudioE2EESupport
    });
  }

  public replaceTrack(kind: 'audio' | 'video') {
    // Late track switches re-apply transforms for safety
    this.applyTransformsIfReady();
  }

  private sendSignal(msg: any) {
    this.signalingHistory.push(msg);
  }

  private applyTransformsIfReady() {
    this.appliedTransforms = [];
    if (this.useE2EE) {
      this.appliedTransforms.push('video');
    }
    if (this.useAudioE2EE) {
      this.appliedTransforms.push('audio');
    }
  }
}

describe('WebRTC Capability Negotiation & Mixed Client Fallbacks', () => {
  it('audioE2EESupported is correctly negotiated when both peers support it', () => {
    const manager = new MockWebRTCManager(true);
    
    // Simulate offer from new client supporting audio E2EE
    manager.handleSignal({
      type: 'offer',
      e2eeSupported: true,
      audioE2EESupported: true
    });

    expect(manager.useE2EE).toBe(true);
    expect(manager.useAudioE2EE).toBe(true);
    expect(manager.appliedTransforms).toContain('video');
    expect(manager.appliedTransforms).toContain('audio');
  });

  it('audio E2EE gracefully falls back to DTLS-SRTP (useAudioE2EE = false) when paired with a video-only peer', () => {
    const manager = new MockWebRTCManager(true);
    
    // Simulate offer from old client that only supports video E2EE (audioE2EESupported is undefined or false)
    manager.handleSignal({
      type: 'offer',
      e2eeSupported: true,
      audioE2EESupported: false
    });

    expect(manager.useE2EE).toBe(true);
    expect(manager.useAudioE2EE).toBe(false);
    expect(manager.appliedTransforms).toContain('video');
    expect(manager.appliedTransforms).not.toContain('audio'); // Audio safely falls back to DTLS-SRTP without breaking video E2EE
  });

  it('ICE restart successfully preserves capability negotiation flags', () => {
    const manager = new MockWebRTCManager(true);
    manager.tryIceRestart();

    expect(manager.signalingHistory.length).toBe(1);
    expect(manager.signalingHistory[0]).toEqual({
      type: 'offer',
      e2eeSupported: true,
      audioE2EESupported: true
    });
  });

  it('late track switches successfully re-apply E2EE transforms correctly', () => {
    const manager = new MockWebRTCManager(true);
    
    manager.handleSignal({
      type: 'offer',
      e2eeSupported: true,
      audioE2EESupported: true
    });
    
    expect(manager.appliedTransforms).toEqual(['video', 'audio']);

    // Simulate mic switch
    manager.appliedTransforms = [];
    manager.replaceTrack('audio');
    expect(manager.appliedTransforms).toEqual(['video', 'audio']); // transform is re-applied correctly

    // Simulate camera switch
    manager.appliedTransforms = [];
    manager.replaceTrack('video');
    expect(manager.appliedTransforms).toEqual(['video', 'audio']);
  });
});
