// Pure E2EE frame + negotiation logic, shared by the worker, WebRTCManager,
// and the unit tests. Keeping it here (instead of inline in the worker /
// webrtc.ts) means the tests exercise the SHIPPING code rather than a copy.
// (Before this split, transform.test.ts re-implemented all of this and stayed
// green even when the real worker logic was corrupted.)

// Per-kind header preservation sizes.
//   Video: VP8/VP9/H.264 payload descriptors fit under 10 bytes; preserving
//          them keeps the RTP packetizer happy.
//   Audio: the Opus TOC byte (1 byte) carries the config the decoder needs to
//          parse the rest; everything after it is encryptable payload.
export const VIDEO_HEADER_SIZE = 10;
export const AUDIO_HEADER_SIZE = 1;

export function headerSizeFor(kind: 'audio' | 'video'): number {
  return kind === 'audio' ? AUDIO_HEADER_SIZE : VIDEO_HEADER_SIZE;
}

/**
 * Build a 12-byte AES-GCM IV from per-frame metadata.
 *   bytes [0..3]  frame.timestamp (32-bit RTP timestamp)
 *   bytes [4..7]  frame SSRC
 *   bytes [8..11] zero (reserved)
 *
 * (timestamp, ssrc) is unique for every frame this peer encrypts under the
 * active key for normal-length calls; combined with disjoint keys per
 * direction AND per kind, AES-GCM IV reuse is structurally impossible.
 */
export function buildIv(timestamp: number, ssrc: number): ArrayBuffer {
  const iv = new ArrayBuffer(12);
  const view = new DataView(iv);
  view.setUint32(0, timestamp >>> 0);
  view.setUint32(4, ssrc >>> 0);
  return iv;
}

/** Preserve the first `headerSize` bytes verbatim; AES-GCM-encrypt the rest. */
export async function encryptFrame(
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

/** Inverse of encryptFrame: preserve the header, AES-GCM-decrypt the body. */
export async function decryptFrame(
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

/**
 * E2EE capability negotiation: the extended script-transform layer is used for
 * a media kind only when BOTH peers advertised support for it. A mixed-version
 * call (new client ↔ old video-only client) therefore keeps video E2EE while
 * audio falls back to DTLS-SRTP.
 */
export function negotiateUse(mySupport: boolean, peerSupport: boolean): boolean {
  return mySupport && peerSupport;
}

/** Which media kinds get the transform applied, given the negotiated flags. */
export function appliedKinds(
  useVideoE2EE: boolean,
  useAudioE2EE: boolean
): Array<'audio' | 'video'> {
  const kinds: Array<'audio' | 'video'> = [];
  if (useVideoE2EE) kinds.push('video');
  if (useAudioE2EE) kinds.push('audio');
  return kinds;
}
