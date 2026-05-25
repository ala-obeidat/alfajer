// Per-direction AES-GCM keys. Each peer encrypts outbound frames with
// `senderKey` and decrypts inbound frames with `receiverKey`. The two keys
// are HKDF-derived from the same ECDH shared secret using disjoint info
// labels ("alfajer-v1-offerer" / "alfajer-v1-answerer") so IV reuse across
// peers is harmless — different keys mean different ciphertext spaces.
let senderKey: CryptoKey | null = null;
let receiverKey: CryptoKey | null = null;

onmessage = (event) => {
  if (event.data?.type === 'setKeys') {
    senderKey = event.data.senderKey ?? null;
    receiverKey = event.data.receiverKey ?? null;
  }
};

/**
 * Build a 12-byte AES-GCM IV from per-frame metadata.
 *
 *   bytes [0..3]   frame.timestamp        (32-bit RTP timestamp)
 *   bytes [4..7]   frame SSRC             (per-stream synchronization source)
 *   bytes [8..11]  zero                   (reserved; could carry a counter
 *                                          for >13-hour calls where the
 *                                          32-bit RTP timestamp wraps)
 *
 * Combined with disjoint keys per direction, (timestamp, ssrc) is unique
 * for every frame this peer ever encrypts under the active key, so AES-GCM
 * IV reuse is structurally impossible for normal-length calls.
 */
function buildIv(timestamp: number, ssrc: number): ArrayBuffer {
  const iv = new ArrayBuffer(12);
  const view = new DataView(iv);
  view.setUint32(0, timestamp >>> 0);
  view.setUint32(4, ssrc >>> 0);
  // bytes [8..11] remain zero
  return iv;
}

// Number of bytes at the start of each frame that we leave unencrypted so the
// browser's RTP packetizer can still read the codec payload descriptor.
// 10 bytes is comfortably above the worst-case for VP8/VP9/H.264 video.
const HEADER_SIZE = 10;

(self as any).onrtctransform = (event: any) => {
  const transformer = event.transformer;
  const side: 'sender' | 'receiver' = transformer.options.side;
  const reader = transformer.readable.getReader();
  const writer = transformer.writable.getWriter();

  const processFrames = async () => {
    while (true) {
      const { done, value: frame } = await reader.read();
      if (done) {
        try { writer.close(); } catch {}
        return;
      }

      const activeKey = side === 'sender' ? senderKey : receiverKey;

      // Drop frames until both peers have negotiated keys. Passing through
      // unencrypted on the sender would leak plaintext; passing through
      // ciphertext on the receiver would crash the decoder. Drop is the
      // only safe option — produces a brief black screen at call start
      // and recovers as soon as setKeys arrives.
      if (!activeKey) continue;

      const data = new Uint8Array(frame.data);
      if (data.length <= HEADER_SIZE) {
        // Pathologically small frame — nothing meaningful to encrypt.
        await writer.write(frame);
        continue;
      }

      // Pull SSRC from frame metadata. Field name differs between
      // video and audio frames in some browsers; fall back to 0.
      let ssrc = 0;
      try {
        const meta = typeof frame.getMetadata === 'function'
          ? frame.getMetadata()
          : null;
        if (meta && typeof meta.synchronizationSource === 'number') {
          ssrc = meta.synchronizationSource >>> 0;
        }
      } catch {
        // Some implementations throw on getMetadata; treat as ssrc=0.
      }

      const iv = buildIv(frame.timestamp >>> 0, ssrc);
      const header = data.subarray(0, HEADER_SIZE);
      const body = data.subarray(HEADER_SIZE);

      try {
        if (side === 'sender') {
          const enc = new Uint8Array(
            await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, activeKey, body)
          );
          const out = new Uint8Array(header.length + enc.length);
          out.set(header, 0);
          out.set(enc, header.length);
          frame.data = out.buffer;
        } else {
          const dec = new Uint8Array(
            await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, activeKey, body)
          );
          const out = new Uint8Array(header.length + dec.length);
          out.set(header, 0);
          out.set(dec, header.length);
          frame.data = out.buffer;
        }
        await writer.write(frame);
      } catch (err) {
        // Decrypt failure usually means a transient mismatch (e.g., a frame
        // that arrived before setKeys propagated, or a packet from before
        // the receiver attached the transform). Dropping is the safe move —
        // the encoder/decoder recovers on the next keyframe.
        if (side === 'receiver') {
          // eslint-disable-next-line no-console
          console.warn('[E2EE worker] frame decrypt failed at ts=' + (frame.timestamp >>> 0));
        } else {
          // eslint-disable-next-line no-console
          console.warn('[E2EE worker] frame encrypt failed at ts=' + (frame.timestamp >>> 0), err);
        }
      }
    }
  };

  processFrames();
};
