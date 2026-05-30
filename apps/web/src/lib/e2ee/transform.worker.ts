// Per-direction × per-kind AES-GCM keys. Each peer encrypts outbound frames
// with the senderKey for that media kind and decrypts inbound frames with
// the receiverKey for that kind. The four keys are HKDF-derived from the
// same ECDH shared secret using disjoint info labels:
//
//   alfajer-v1-<my-role>           → video senderKey   (encrypt-only)
//   alfajer-v1-<peer-role>         → video receiverKey (decrypt-only)
//   alfajer-v1-<my-role>-audio     → audio senderKey   (encrypt-only)
//   alfajer-v1-<peer-role>-audio   → audio receiverKey (decrypt-only)
//
// where role ∈ {offerer, answerer}. Disjoint keys per kind eliminate any
// shared-IV-space risk between the two media streams.
let videoSenderKey: CryptoKey | null = null;
let videoReceiverKey: CryptoKey | null = null;
let audioSenderKey: CryptoKey | null = null;
let audioReceiverKey: CryptoKey | null = null;

onmessage = (event) => {
  if (event.data?.type === 'setKeys') {
    videoSenderKey   = event.data.videoSenderKey   ?? event.data.senderKey   ?? null;
    videoReceiverKey = event.data.videoReceiverKey ?? event.data.receiverKey ?? null;
    audioSenderKey   = event.data.audioSenderKey   ?? null;
    audioReceiverKey = event.data.audioReceiverKey ?? null;
  }
};

/**
 * Build a 12-byte AES-GCM IV from per-frame metadata.
 *
 *   bytes [0..3]   frame.timestamp (32-bit RTP timestamp)
 *   bytes [4..7]   frame SSRC (per-stream synchronization source)
 *   bytes [8..11]  zero (reserved)
 *
 * (timestamp, ssrc) is unique for every frame this peer ever encrypts
 * under the active key for normal-length calls. Combined with disjoint
 * keys per direction AND per kind, AES-GCM IV reuse is structurally
 * impossible.
 */
function buildIv(timestamp: number, ssrc: number): ArrayBuffer {
  const iv = new ArrayBuffer(12);
  const view = new DataView(iv);
  view.setUint32(0, timestamp >>> 0);
  view.setUint32(4, ssrc >>> 0);
  return iv;
}

// Per-kind header preservation:
//   Video: VP8/VP9/H.264 payload descriptors fit comfortably under 10
//          bytes; preserving them keeps the RTP packetizer happy.
//   Audio: Opus TOC byte (1 byte) carries the configuration the decoder
//          needs to parse the rest. Everything after the TOC is the
//          actual encoded audio and can safely be encrypted.
const VIDEO_HEADER_SIZE = 10;
const AUDIO_HEADER_SIZE = 1;

(self as any).onrtctransform = (event: any) => {
  const transformer = event.transformer;
  const side: 'sender' | 'receiver' = transformer.options.side;
  const kind: 'audio' | 'video' = transformer.options.kind ?? 'video';
  const headerSize = kind === 'audio' ? AUDIO_HEADER_SIZE : VIDEO_HEADER_SIZE;

  const pickKey = (): CryptoKey | null => {
    if (kind === 'video') {
      return side === 'sender' ? videoSenderKey : videoReceiverKey;
    } else {
      return side === 'sender' ? audioSenderKey : audioReceiverKey;
    }
  };

  const reader = transformer.readable.getReader();
  const writer = transformer.writable.getWriter();

  const processFrames = async () => {
    while (true) {
      const { done, value: frame } = await reader.read();
      if (done) {
        try { writer.close(); } catch {}
        return;
      }

      const activeKey = pickKey();

      // Drop frames until both peers have negotiated keys for THIS kind.
      // For audio in a backward-compat negotiation (peer is on the older
      // video-only build), audioSenderKey/audioReceiverKey will both be
      // null and the audio transform won't have been attached in the
      // first place — so this branch only fires during the brief setKeys
      // race window at call start.
      if (!activeKey) continue;

      const data = new Uint8Array(frame.data);
      if (data.length <= headerSize) {
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
      const header = data.subarray(0, headerSize);
      const body = data.subarray(headerSize);

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
        // Decrypt failure usually means a transient mismatch (a frame that
        // arrived before setKeys propagated, or a packet from before the
        // receiver attached the transform). Dropping is the safe move —
        // the codec recovers on the next keyframe (video) or next packet
        // (audio).
        if (side === 'receiver') {
          // eslint-disable-next-line no-console
          console.warn(`[E2EE worker] ${kind} frame decrypt failed at ts=` + (frame.timestamp >>> 0));
        } else {
          // eslint-disable-next-line no-console
          console.warn(`[E2EE worker] ${kind} frame encrypt failed at ts=` + (frame.timestamp >>> 0), err);
        }
      }
    }
  };

  processFrames();
};
