import { PUBLIC_SIGNALING_URL, PUBLIC_TURN_URL } from '$env/static/public';
import { negotiateUse, appliedKinds } from './e2ee/transform-core';

const DEFAULT_SIGNALING_URL = 'http://localhost:3000';

function toWsUrl(httpUrl: string): string {
  return httpUrl.replace(/^http(s?):/, 'ws$1:');
}

export type CallQuality =
  | { kind: 'connecting'; rttMs: null; lossPct: null }
  | { kind: 'direct'; rttMs: number | null; lossPct: number | null }
  | { kind: 'relay';  rttMs: number | null; lossPct: number | null }
  | { kind: 'reconnecting'; rttMs: null; lossPct: null }
  | { kind: 'failed'; rttMs: null; lossPct: null };

/**
 * State of the end-to-end security layer on top of DTLS-SRTP.
 *
 *   'connecting' — handshake not finished
 *   'dtls-srtp'  — both peers connected, but the script-transform layer is
 *                  NOT in use (peer browser lacks RTCRtpScriptTransform or
 *                  the negotiation didn't agree). Media is still encrypted
 *                  end-to-end via DTLS-SRTP, which the signaling and TURN
 *                  servers cannot decrypt.
 *   'e2ee'       — script-transform applied. Each video frame has an extra
 *                  AES-256-GCM layer on top of DTLS-SRTP, with per-direction
 *                  HKDF keys. A breach of the DTLS layer would still not
 *                  expose video plaintext.
 */
export type SecurityState = 'connecting' | 'dtls-srtp' | 'e2ee';

/**
 * Constructor options for WebRTCManager.create(): lets callers ask for an
 * audio-only call from the very first getUserMedia (no flash of camera light).
 */
export interface CreateOpts {
  audioOnly?: boolean;
}

export class WebRTCManager {
  public pc: RTCPeerConnection;
  public localStream: MediaStream | null = null;
  private ws: WebSocket;
  private roomId: string;
  private ecdhKeyPair: CryptoKeyPair | null = null;
  private sharedSecret: CryptoKey | null = null;
  private worker: Worker;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private wsQueue: any[] = [];

  // E2EE capability negotiation
  // myE2EESupport / peerE2EESupport refer to the BASELINE script-transform
  // path — covers video. The newer audio path is negotiated independently
  // via myAudioE2EESupport / peerAudioE2EESupport so that older clients
  // (current production, video-E2EE-only) can keep talking to newer
  // clients without their audio dropping out: in mixed-version calls
  // only video gets the extended layer; audio stays on DTLS-SRTP.
  private myE2EESupport: boolean;
  private peerE2EESupport = false;
  public useE2EE = false;
  private myAudioE2EESupport: boolean;
  private peerAudioE2EESupport = false;
  public useAudioE2EE = false;
  private sharedKeyReady = false;
  private transformedSenders = new WeakSet<RTCRtpSender>();
  private transformedReceivers = new WeakSet<RTCRtpReceiver>();

  // SDP role determines which HKDF label produces our outbound AES-GCM key
  // vs the peer's outbound key (which we use for inbound). The initiator
  // who calls createOffer is 'offerer'; the peer that responds is 'answerer'.
  private localSdpRole: 'offerer' | 'answerer' | null = null;

  /** True if the browser exposes the RTCRtpScriptTransform API we rely on. */
  static isE2EESupported(): boolean {
    return typeof globalThis !== 'undefined'
      && typeof (globalThis as any).RTCRtpScriptTransform !== 'undefined';
  }

  private setSecurityState(s: SecurityState) {
    if (this.securityState === s) return;
    this.securityState = s;
    this.onSecurityStateChange?.(s);
  }

  public onRemoteTrack?: (track: MediaStreamTrack, streams: readonly MediaStream[]) => void;
  public onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
  public onCallEnded?: (byRemote: boolean) => void;
  public onRemoteIdentity?: (identity: string) => void;
  public onRoomFull?: () => void;
  public onPeerJoined?: () => void;
  public onJoinRequest?: (name: string) => void;
  public onJoinAccepted?: () => void;
  public onJoinRejected?: () => void;
  public onChat?: (text: string, fromIdentity?: string) => void;
  public onQualityChange?: (q: CallQuality) => void;
  public onIceRestart?: () => void;
  /** Fires once both peers have exchanged public keys. Same 5-digit value
   *  is produced on both sides; users compare aloud to detect a MITM. */
  public onSafetyCode?: (code: string) => void;
  /** Fires whenever the negotiated security state changes. */
  public onSecurityStateChange?: (s: SecurityState) => void;

  /** The latest computed 5-digit MITM-verification code, or null if the
   *  ECDH handshake hasn't finished yet. */
  public safetyCode: string | null = null;
  /** Latest reported security state. */
  public securityState: SecurityState = 'connecting';

  // Chat encryption — separate AES-GCM key derived from the same ECDH secret
  // via HKDF with a distinct label. Both peers derive an identical key so
  // either side can encrypt or decrypt. Random IV per message.
  private chatKey: CryptoKey | null = null;
  // Outbound chat queue: messages composed before the chat key is derived
  // wait here instead of being sent in cleartext. Flushed in deriveSharedSecret.
  private chatOutboundQueue: string[] = [];
  // Aggregated stats for the connection-quality indicator.
  private statsInterval: number | null = null;
  private currentQuality: CallQuality = { kind: 'connecting', rttMs: null, lossPct: null };
  private iceRestartInFlight = false;

  /** True if this call should never request video (initial getUserMedia
   *  call asks for audio only). The user can still flip camera on mid-call. */
  public audioOnly = false;

  static async create(roomId: string, username: string, opts: CreateOpts = {}): Promise<WebRTCManager> {
    const signalingUrl = PUBLIC_SIGNALING_URL || DEFAULT_SIGNALING_URL;
    const iceServers: RTCIceServer[] = [
      { urls: 'stun:stun.l.google.com:19302' }
    ];

    if (PUBLIC_TURN_URL) {
      try {
        const credsRes = await fetch(
          `${signalingUrl}/turn-credentials?username=${encodeURIComponent(username)}`
        );
        if (credsRes.ok) {
          const creds = await credsRes.json() as { username: string; credential: string };
          // Support comma-separated URLs in PUBLIC_TURN_URL so we can offer
          // multiple TURN transports at once (e.g. UDP for low latency when
          // direct STUN punching fails but UDP is still allowed, plus
          // TURNS/TCP as the universal fallback for restrictive networks).
          // WebRTC's ICE algorithm picks the lowest-latency working
          // candidate, so adding URLs is monotonically a performance win.
          const turnUrls = PUBLIC_TURN_URL.split(',').map(s => s.trim()).filter(Boolean);
          iceServers.push({
            urls: turnUrls.length === 1 ? turnUrls[0] : turnUrls,
            username: creds.username,
            credential: creds.credential
          });
        } else {
          console.warn('TURN credential fetch failed, status', credsRes.status);
        }
      } catch (e) {
        console.warn('TURN credential fetch error, continuing without TURN', e);
      }
    }

    const m = new WebRTCManager(roomId, signalingUrl, iceServers);
    m.audioOnly = !!opts.audioOnly;
    return m;
  }

  constructor(roomId: string, signalingUrl: string = DEFAULT_SIGNALING_URL, iceServers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]) {
    this.roomId = roomId;
    this.pc = new RTCPeerConnection({ iceServers });

    this.worker = new Worker(new URL('./e2ee/transform.worker.ts', import.meta.url), { type: 'module' });
    this.myE2EESupport = WebRTCManager.isE2EESupported();
    // Audio E2EE rides on the same RTCRtpScriptTransform API as video,
    // but uses a 1-byte Opus-TOC-preserving header instead of the 10-byte
    // video payload-descriptor preserve. Any browser that supports
    // script-transform supports audio too.
    this.myAudioE2EESupport = this.myE2EESupport;

    this.pc.ontrack = (event) => {
      // Hand the track to the UI immediately so the video element binds.
      this.onRemoteTrack?.(event.track, event.streams);
      // Apply the receive-side E2EE transform iff negotiation already agreed
      // and the shared key is set in the worker. Otherwise the call to
      // applyTransformsIfReady() in handleSignal() will re-attempt later.
      this.applyTransformsIfReady();
    };

    this.pc.onconnectionstatechange = () => {
      this.onConnectionStateChange?.(this.pc.connectionState);
    };

    this.pc.oniceconnectionstatechange = () => {
      const s = this.pc.iceConnectionState;
      if (s === 'failed') {
        // Attempt a single ICE restart automatically. Only the offerer
        // can initiate; the answerer just waits for the new offer.
        void this.tryIceRestart();
      }
    };

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignal({
          type: 'candidate',
          payload: event.candidate
        });
      }
    };

    this.ws = new WebSocket(`${toWsUrl(signalingUrl)}/call/${roomId}`);
    
    this.ws.onopen = () => {
      for (const msg of this.wsQueue) {
        this.ws.send(JSON.stringify(msg));
      }
      this.wsQueue = [];
    };

    this.ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data);
      await this.handleSignal(msg);
    };
    
    this.ws.onclose = (e) => {
      if (e.code === 1008) {
        // 1008: 'Room full' (server-rejected join into a sealed room) OR
        //       'Origin not allowed' (CSWSH guard rejected this origin).
        this.onRoomFull?.();
        return;
      }
      // 1000 = peer disconnected (server informs the survivor when the
      // other side hangs up or closes their tab). Without this branch the
      // survivor sat waiting for ICE timeout instead of seeing a clean
      // 'Call ended' UI — caught by the round-3 functional audit (B7).
      // 1006 = abnormal close (network drop on our side). The PC may still
      // recover via ICE restart; but if it doesn't, surface the failure.
      // Any other close code: treat as a remote end-of-call so the UI
      // doesn't hang forever waiting for a re-handshake that's not coming.
      this.onCallEnded?.(true);
    };
  }

  public async initECDH() {
    this.ecdhKeyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      // deriveBits is required because deriveSharedSecret() now feeds the
      // raw ECDH output through HKDF (instead of going straight to AES-GCM
      // via deriveKey). Without this usage the browser throws
      //   InvalidAccessError: key.usages does not permit this operation.
      ['deriveKey', 'deriveBits']
    );
  }

  public async setLocalStream(stream: MediaStream) {
    this.localStream = stream;
    for (const track of stream.getTracks()) {
      this.pc.addTrack(track, stream);
      // E2EE sender transform disabled — see note in ontrack handler above.
    }
  }

  public async replaceVideoTrack(newTrack: MediaStreamTrack) {
    if (!this.localStream) return;
    for (const old of this.localStream.getVideoTracks()) {
      this.localStream.removeTrack(old);
      old.stop();
    }
    this.localStream.addTrack(newTrack);
    const sender = this.pc.getSenders().find(s => s.track?.kind === 'video');
    if (sender) {
      await sender.replaceTrack(newTrack);
    } else {
      this.pc.addTrack(newTrack, this.localStream);
    }
  }

  public async replaceAudioTrack(newTrack: MediaStreamTrack) {
    if (!this.localStream) return;
    for (const old of this.localStream.getAudioTracks()) {
      this.localStream.removeTrack(old);
      old.stop();
    }
    this.localStream.addTrack(newTrack);
    const sender = this.pc.getSenders().find(s => s.track?.kind === 'audio');
    if (sender) {
      await sender.replaceTrack(newTrack);
    } else {
      this.pc.addTrack(newTrack, this.localStream);
    }
  }

  public requestJoin(name: string) {
    this.sendSignal({ type: 'request_join', payload: name });
  }

  public acceptJoin() {
    this.sendSignal({ type: 'join_accept' });
  }

  public rejectJoin() {
    this.sendSignal({ type: 'join_reject' });
  }

  public async startCall() {
    this.sendSignal({ type: 'join' });
  }

  private async makeOffer() {
    this.localSdpRole = 'offerer';
    await this.initECDH();
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);

    const rawPubKey = await crypto.subtle.exportKey('raw', this.ecdhKeyPair!.publicKey);
    const pubKeyBase64 = btoa(String.fromCharCode(...new Uint8Array(rawPubKey)));

    this.sendSignal({
      type: 'offer',
      payload: offer,
      ecdhPublicKey: pubKeyBase64,
      e2eeSupported: this.myE2EESupport,
      audioE2EESupported: this.myAudioE2EESupport
    });
  }

  private sendSignal(msg: any) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.wsQueue.push(msg);
    }
  }

  private async handleSignal(msg: any) {
    if (msg.type === 'join') {
      this.onPeerJoined?.();
      // The peer who receives 'join' will initiate the offer
      await this.makeOffer();
    } else if (msg.type === 'offer') {
      this.onPeerJoined?.(); // In case we are peer 2 and receiving offer
      this.localSdpRole = 'answerer';
      this.peerE2EESupport = msg.e2eeSupported === true;
      this.peerAudioE2EESupport = msg.audioE2EESupported === true;
      this.useE2EE = negotiateUse(this.myE2EESupport, this.peerE2EESupport);
      this.useAudioE2EE = negotiateUse(this.myAudioE2EESupport, this.peerAudioE2EESupport);

      await this.initECDH();
      await this.pc.setRemoteDescription(new RTCSessionDescription(msg.payload));
      await this.flushCandidates();

      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);

      const rawPubKey = await crypto.subtle.exportKey('raw', this.ecdhKeyPair!.publicKey);
      const pubKeyBase64 = btoa(String.fromCharCode(...new Uint8Array(rawPubKey)));

      await this.deriveSharedSecret(msg.ecdhPublicKey);

      this.sendSignal({
        type: 'answer',
        payload: answer,
        ecdhPublicKey: pubKeyBase64,
        e2eeSupported: this.myE2EESupport,
        audioE2EESupported: this.myAudioE2EESupport
      });

      this.applyTransformsIfReady();
    } else if (msg.type === 'answer') {
      this.peerE2EESupport = msg.e2eeSupported === true;
      this.peerAudioE2EESupport = msg.audioE2EESupported === true;
      this.useE2EE = negotiateUse(this.myE2EESupport, this.peerE2EESupport);
      this.useAudioE2EE = negotiateUse(this.myAudioE2EESupport, this.peerAudioE2EESupport);

      await this.pc.setRemoteDescription(new RTCSessionDescription(msg.payload));
      await this.deriveSharedSecret(msg.ecdhPublicKey);
      await this.flushCandidates();

      this.applyTransformsIfReady();
    } else if (msg.type === 'candidate') {
      if (this.pc.remoteDescription) {
        await this.pc.addIceCandidate(new RTCIceCandidate(msg.payload));
      } else {
        this.pendingCandidates.push(msg.payload);
      }
    } else if (msg.type === 'chat') {
      await this.handleChatMessage(msg);
    } else if (msg.type === 'end') {
      this.cleanup();
      this.onCallEnded?.(true);
    } else if (msg.type === 'identity') {
      this.onRemoteIdentity?.(msg.payload);
    } else if (msg.type === 'request_join') {
      this.onJoinRequest?.(msg.payload);
    } else if (msg.type === 'join_accept') {
      this.onJoinAccepted?.();
    } else if (msg.type === 'join_reject') {
      this.onJoinRejected?.();
    }
  }

  private async flushCandidates() {
    for (const candidate of this.pendingCandidates) {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
    this.pendingCandidates = [];
  }

  private async deriveSharedSecret(remotePubKeyBase64: string) {
    const binary = atob(remotePubKeyBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    const remotePubKey = await crypto.subtle.importKey(
      'raw',
      bytes,
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      []
    );

    // SAS (Short Authentication String) — ZRTP-style MITM detection.
    //
    // Both peers hash the two ECDH public keys in canonical order
    // (offerer's key first) and derive a 5-decimal-digit code from the
    // first 4 bytes of SHA-256. Both peers compute the same value when no
    // active MITM has swapped keys. A signaling-server attacker who
    // substitutes one peer's pubkey would cause the two computed SAS values
    // to diverge, which the users notice when they read the code aloud.
    //
    // 5 digits = 100,000 possibilities; the birthday-bound for an attacker
    // who can attempt N key substitutions before being noticed is ~sqrt(N)
    // collisions, so brute-forcing the SAS in real-time is infeasible.
    try {
      const myRawPub = new Uint8Array(
        await crypto.subtle.exportKey('raw', this.ecdhKeyPair!.publicKey)
      );
      const peerRawPub = bytes;
      const first  = this.localSdpRole === 'offerer' ? myRawPub  : peerRawPub;
      const second = this.localSdpRole === 'offerer' ? peerRawPub : myRawPub;
      const combined = new Uint8Array(first.length + second.length);
      combined.set(first, 0);
      combined.set(second, first.length);
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', combined));
      const sasInt = new DataView(digest.buffer).getUint32(0, false) % 100000;
      this.safetyCode = String(sasInt).padStart(5, '0');
      this.onSafetyCode?.(this.safetyCode);
    } catch (e) {
      console.warn('[SAS] derivation failed (non-fatal)', e);
    }

    // Derive 32 raw bytes of shared secret from ECDH, then expand those bytes
    // through HKDF into TWO independent AES-GCM keys — one per SDP direction.
    // With disjoint keys per direction, an IV collision between peers becomes
    // structurally harmless (different keys → different ciphertext spaces).
    const sharedBits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: remotePubKey },
      this.ecdhKeyPair!.privateKey,
      256
    );

    const hkdfBase = await crypto.subtle.importKey(
      'raw',
      sharedBits,
      'HKDF',
      false,
      ['deriveKey']
    );

    // Best-effort wipe of the JS-visible view of the raw ECDH output.
    // The CryptoKey hkdfBase now holds the secret inside the browser's
    // opaque crypto provider; the ArrayBuffer we just used is no longer
    // needed and shouldn't sit around in heap longer than necessary.
    // (V8 may have copied it internally — this is hygiene, not a guarantee.)
    try { new Uint8Array(sharedBits).fill(0); } catch { /* sealed buffer */ }

    const myRole = this.localSdpRole ?? 'offerer';
    const peerRole: 'offerer' | 'answerer' = myRole === 'offerer' ? 'answerer' : 'offerer';

    const encoder = new TextEncoder();
    const deriveAesKey = async (label: string, usage: KeyUsage) => crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(),
        info: encoder.encode(label)
      },
      hkdfBase,
      { name: 'AES-GCM', length: 256 },
      false,
      [usage]
    );

    // Video keys (existing label scheme — kept stable so a new client can
    // still encrypt video for an older client that hasn't redeployed yet).
    const videoSenderKey   = await deriveAesKey('alfajer-v1-' + myRole,   'encrypt');
    const videoReceiverKey = await deriveAesKey('alfajer-v1-' + peerRole, 'decrypt');

    // Audio keys (new label scheme — only used when both peers negotiated
    // audioE2EESupported). Keeping them separate from the video keys
    // means the (timestamp, ssrc) IV space can't collide between media
    // kinds even in pathological cases.
    const audioSenderKey   = await deriveAesKey('alfajer-v1-' + myRole   + '-audio', 'encrypt');
    const audioReceiverKey = await deriveAesKey('alfajer-v1-' + peerRole + '-audio', 'decrypt');

    // Keep a handle to the sender key for any future use; the worker
    // receives all four via postMessage.
    this.sharedSecret = videoSenderKey;

    this.worker.postMessage({
      type: 'setKeys',
      // Legacy names kept for backward compat with cached old workers.
      senderKey: videoSenderKey,
      receiverKey: videoReceiverKey,
      // Explicit per-kind names for the new worker.
      videoSenderKey,
      videoReceiverKey,
      audioSenderKey,
      audioReceiverKey
    });
    this.sharedKeyReady = true;

    // Baseline state after handshake: DTLS-SRTP only. If we'll be applying
    // the script-transform layer on top, applyTransformsIfReady() will
    // upgrade us to 'e2ee'. Either way the call is end-to-end encrypted.
    this.setSecurityState('dtls-srtp');

    // Derive a third symmetric key dedicated to in-call chat. Both peers
    // produce the same bytes since the HKDF label is identical on both
    // sides (no SDP-role split). Usages cover encrypt + decrypt because
    // either peer may send.
    this.chatKey = await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(),
        info: encoder.encode('alfajer-v1-chat')
      },
      hkdfBase,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );

    // Flush any messages the user typed before the key was ready. They
    // were held as plaintext in JS memory, never sent over the wire;
    // now they go out encrypted in order.
    await this.flushChatQueue();
  }

  /** Encrypts a UTF-8 chat string with the per-call chat key and sends it
   *  through the signaling channel. Random 96-bit IV per message — the
   *  signaling server never sees plaintext.
   *
   *  Privacy contract: this method NEVER sends plaintext. If the chat key
   *  isn't derived yet (the brief window between WS open and ECDH
   *  completion), the message is queued and emitted as ciphertext as soon
   *  as the key is available. If the call never establishes ECDH (e.g.
   *  peer disconnects mid-handshake) the queued messages are discarded
   *  on cleanup rather than ever leaving as plaintext.
   */
  public async sendChat(text: string): Promise<void> {
    if (!this.chatKey) {
      this.chatOutboundQueue.push(text);
      return;
    }
    await this.encryptAndSendChat(text);
  }

  private async encryptAndSendChat(text: string): Promise<void> {
    if (!this.chatKey) return; // belt-and-braces — keep contract even on race
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      this.chatKey,
      new TextEncoder().encode(text)
    );
    const b64 = (buf: ArrayBuffer | Uint8Array) => {
      const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      return btoa(s);
    };
    this.sendSignal({ type: 'chat', enc: true, iv: b64(iv), payload: b64(ct) });
  }

  private async flushChatQueue(): Promise<void> {
    if (!this.chatKey) return;
    const queued = this.chatOutboundQueue.splice(0);
    for (const text of queued) {
      try { await this.encryptAndSendChat(text); }
      catch (e) { console.warn('[chat] queued message failed to encrypt; dropped', e); }
    }
  }

  private async handleChatMessage(msg: any): Promise<void> {
    // STRICT: accept only encrypted chat. A plaintext payload may be an
    // injected message from an attacker who saw the protocol shape — we
    // drop it silently rather than risk surfacing forgery as if it were
    // a real peer message.
    if (msg.enc !== true || typeof msg.iv !== 'string' || typeof msg.payload !== 'string') {
      console.warn('[chat] dropping non-encrypted or malformed chat message');
      return;
    }
    if (!this.chatKey) {
      console.warn('[chat] received encrypted message before key derivation; dropping');
      return;
    }
    try {
      const fromB64 = (s: string) => {
        const bin = atob(s); const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
      };
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromB64(msg.iv) },
        this.chatKey,
        fromB64(msg.payload)
      );
      this.onChat?.(new TextDecoder().decode(plain));
    } catch (e) {
      // Auth-tag failure: tampering, wrong key, or out-of-order message.
      // Drop silently — the alternative is leaking integrity feedback.
      console.warn('[chat] decrypt failed', e);
    }
  }

  // ---- Connection-quality polling ----

  /** Starts a 2-second poll of pc.getStats() and emits a CallQuality each tick. */
  public startQualityMonitor() {
    this.stopQualityMonitor();
    const tick = async () => {
      const q = await this.computeQuality();
      if (q.kind !== this.currentQuality.kind
          || q.rttMs !== this.currentQuality.rttMs
          || q.lossPct !== this.currentQuality.lossPct) {
        this.currentQuality = q;
        this.onQualityChange?.(q);
      }
    };
    tick();
    this.statsInterval = setInterval(tick, 2000) as unknown as number;
  }

  public stopQualityMonitor() {
    if (this.statsInterval !== null) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
  }

  private async computeQuality(): Promise<CallQuality> {
    const ice = this.pc.iceConnectionState;
    if (ice === 'failed') return { kind: 'failed', rttMs: null, lossPct: null };
    if (ice === 'disconnected' || ice === 'checking' || ice === 'new') {
      return { kind: this.iceRestartInFlight ? 'reconnecting' : 'connecting', rttMs: null, lossPct: null };
    }
    try {
      const stats = await this.pc.getStats();
      let selectedPair: any = null;
      const candidates: Record<string, any> = {};
      stats.forEach(r => { if (r.type === 'local-candidate' || r.type === 'remote-candidate') candidates[r.id] = r; });
      stats.forEach(r => {
        if (r.type === 'candidate-pair' && (r as any).selected === true) selectedPair = r;
      });
      if (!selectedPair) {
        // Some browsers use 'transport.selectedCandidatePairId' instead.
        let transportPairId: string | undefined;
        stats.forEach(r => { if (r.type === 'transport' && (r as any).selectedCandidatePairId) transportPairId = (r as any).selectedCandidatePairId; });
        if (transportPairId) selectedPair = (stats as any).get?.(transportPairId);
      }
      let kind: 'direct' | 'relay' = 'direct';
      if (selectedPair) {
        const local = candidates[selectedPair.localCandidateId];
        if (local && local.candidateType === 'relay') kind = 'relay';
      }
      const rttSec = selectedPair?.currentRoundTripTime;
      const rttMs = typeof rttSec === 'number' ? Math.round(rttSec * 1000) : null;
      // Loss% — derive from inbound RTP if any stream is incoming
      let lossPct: number | null = null;
      stats.forEach(r => {
        if (r.type === 'inbound-rtp' && (r as any).kind === 'video') {
          const lost = (r as any).packetsLost ?? 0;
          const recv = (r as any).packetsReceived ?? 0;
          const total = lost + recv;
          if (total > 0) lossPct = Math.round((lost / total) * 1000) / 10;
        }
      });
      return { kind, rttMs, lossPct };
    } catch {
      return { kind: 'connecting', rttMs: null, lossPct: null };
    }
  }

  /** Attempts to restart ICE on connection failure. Caller must be the
   *  offerer (initiator); if we're the answerer we simply wait. */
  public async tryIceRestart(): Promise<boolean> {
    if (this.iceRestartInFlight) return false;
    if (this.localSdpRole !== 'offerer') return false;
    this.iceRestartInFlight = true;
    this.onIceRestart?.();
    try {
      const offer = await this.pc.createOffer({ iceRestart: true });
      await this.pc.setLocalDescription(offer);
      const raw = this.ecdhKeyPair
        ? await crypto.subtle.exportKey('raw', this.ecdhKeyPair.publicKey)
        : new ArrayBuffer(0);
      const pub = btoa(String.fromCharCode(...new Uint8Array(raw)));
      this.sendSignal({
        type: 'offer',
        payload: offer,
        ecdhPublicKey: pub,
        e2eeSupported: this.myE2EESupport,
        audioE2EESupported: this.myAudioE2EESupport
      });
      return true;
    } catch (e) {
      console.warn('[ice-restart] failed', e);
      return false;
    } finally {
      this.iceRestartInFlight = false;
    }
  }

  // ---- Screen-share toggle ----
  private screenStream: MediaStream | null = null;
  private prevVideoTrack: MediaStreamTrack | null = null;

  public isScreenSharing(): boolean { return this.screenStream !== null; }

  public async startScreenShare(): Promise<void> {
    if (!this.localStream) return;
    if (this.screenStream) return;
    const ds = await (navigator.mediaDevices as any).getDisplayMedia({ video: true, audio: false });
    this.screenStream = ds as MediaStream;
    const shareTrack = (ds as MediaStream).getVideoTracks()[0];
    if (!shareTrack) return;
    const sender = this.pc.getSenders().find(s => s.track?.kind === 'video');
    if (sender && sender.track) {
      this.prevVideoTrack = sender.track;
      await sender.replaceTrack(shareTrack);
    } else {
      this.pc.addTrack(shareTrack, this.localStream);
    }
    // When the user ends sharing via the browser's "Stop sharing" bar:
    shareTrack.onended = () => { void this.stopScreenShare(); };
  }

  public async stopScreenShare(): Promise<void> {
    if (!this.screenStream) return;
    const tracks = this.screenStream.getTracks();
    for (const t of tracks) t.stop();
    this.screenStream = null;
    const sender = this.pc.getSenders().find(s => s.track?.kind === 'video');
    if (sender && this.prevVideoTrack) {
      await sender.replaceTrack(this.prevVideoTrack);
      this.prevVideoTrack = null;
    }
  }

  /**
   * Applies the E2EE script transform to every relevant sender and receiver
   * IFF both peers signaled support during the offer/answer exchange AND the
   * AES-GCM shared key is in the worker. Called from several lifecycle points
   * (after answer, after offer-response, and from ontrack); each call is
   * idempotent thanks to the transformedSenders and transformedReceivers
   * WeakSets.
   *
   * Both video and audio streams can have the script transform layer applied.
   * Video uses a 10-byte preserved payload-descriptor header, and audio uses
   * a 1-byte preserved Opus TOC header. When paired with an older video-only
   * client, audio falls back to DTLS-SRTP.
   */
  private applyTransformsIfReady() {
    if (!this.useE2EE || !this.sharedKeyReady) return;
    if (typeof (globalThis as any).RTCRtpScriptTransform === 'undefined') return;

    const RST = (globalThis as any).RTCRtpScriptTransform;

    // Should this kind of media get the script-transform layer applied?
    // Video: gated on the original e2eeSupported handshake (useE2EE).
    // Audio: gated on the newer audioE2EESupported handshake (useAudioE2EE).
    //        Both peers signal both flags; when paired with an older
    //        video-only client, audio falls back to DTLS-SRTP only.
    const kindsToApply = new Set(appliedKinds(this.useE2EE, this.useAudioE2EE));
    const shouldApply = (kind: 'audio' | 'video'): boolean => kindsToApply.has(kind);

    // Sender side — apply per sender, deduped via WeakSet
    let anyApplied = false;
    for (const sender of this.pc.getSenders()) {
      if (this.transformedSenders.has(sender)) {
        anyApplied = true;
        continue;
      }
      const kind = sender.track?.kind as 'audio' | 'video' | undefined;
      if (kind !== 'audio' && kind !== 'video') continue;
      if (!shouldApply(kind)) continue;
      try {
        // @ts-expect-error — RTCRtpScriptTransform isn't in baseline lib.dom yet
        sender.transform = new RST(this.worker, { side: 'sender', kind });
        this.transformedSenders.add(sender);
        anyApplied = true;
      } catch (e) {
        console.warn(`[E2EE] sender.transform (${kind}) failed; continuing without E2EE on this sender`, e);
      }
    }
    if (anyApplied) this.setSecurityState('e2ee');

    // Receiver side — apply per receiver, deduped via WeakSet
    for (const receiver of this.pc.getReceivers()) {
      if (this.transformedReceivers.has(receiver)) continue;
      const kind = receiver.track?.kind as 'audio' | 'video' | undefined;
      if (kind !== 'audio' && kind !== 'video') continue;
      if (!shouldApply(kind)) continue;
      try {
        // @ts-expect-error — see note above
        receiver.transform = new RST(this.worker, { side: 'receiver', kind });
        this.transformedReceivers.add(receiver);
      } catch (e) {
        console.warn(`[E2EE] receiver.transform (${kind}) failed; this stream stays unencrypted`, e);
      }
    }
  }

  public toggleAudio(enabled: boolean) {
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(t => t.enabled = enabled);
    }
  }

  public toggleVideo(enabled: boolean) {
    if (this.localStream) {
      this.localStream.getVideoTracks().forEach(t => t.enabled = enabled);
    }
  }

  public endCall() {
    this.sendSignal({ type: 'end' });
    this.cleanup();
    this.onCallEnded?.(false);
  }

  public sendIdentity(identity: string) {
    this.sendSignal({ type: 'identity', payload: identity });
  }

  private cleanup() {
    this.stopQualityMonitor();
    if (this.screenStream) {
      this.screenStream.getTracks().forEach(t => t.stop());
      this.screenStream = null;
    }
    // Discard any queued chat messages that never got a chat key —
    // they were held in JS memory only, never transmitted. Wiping
    // before letting GC reclaim shortens their lifetime.
    this.chatOutboundQueue.forEach((_, i) => { this.chatOutboundQueue[i] = ''; });
    this.chatOutboundQueue.length = 0;
    this.pc.close();
    this.ws.close();
    this.worker.terminate();
    this.sharedSecret = null;
    this.chatKey = null;
    this.ecdhKeyPair = null;
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
    }
    sessionStorage.removeItem('alfajer_identity');
  }
}
