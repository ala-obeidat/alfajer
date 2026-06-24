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
//
// The per-frame crypto + header logic lives in ./transform-core so the unit
// tests can import the exact same code this worker runs.
import { buildIv, headerSizeFor, encryptFrame, decryptFrame } from './transform-core';

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

(self as any).onrtctransform = (event: any) => {
  const transformer = event.transformer;
  const side: 'sender' | 'receiver' = transformer.options.side;
  const kind: 'audio' | 'video' = transformer.options.kind ?? 'video';
  const headerSize = headerSizeFor(kind);

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

      try {
        const out = side === 'sender'
          ? await encryptFrame(data, headerSize, activeKey, iv)
          : await decryptFrame(data, headerSize, activeKey, iv);
        frame.data = out.buffer;
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
