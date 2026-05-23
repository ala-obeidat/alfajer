import { PUBLIC_SIGNALING_URL, PUBLIC_TURN_URL } from '$env/static/public';

const DEFAULT_SIGNALING_URL = 'http://localhost:3000';

function toWsUrl(httpUrl: string): string {
  return httpUrl.replace(/^http(s?):/, 'ws$1:');
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

  public onRemoteTrack?: (track: MediaStreamTrack, streams: readonly MediaStream[]) => void;
  public onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
  public onCallEnded?: (byRemote: boolean) => void;
  public onRemoteIdentity?: (identity: string) => void;
  public onRoomFull?: () => void;
  public onPeerJoined?: () => void;
  public onJoinRequest?: (name: string) => void;
  public onJoinAccepted?: () => void;
  public onJoinRejected?: () => void;

  static async create(roomId: string, username: string): Promise<WebRTCManager> {
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
          iceServers.push({
            urls: PUBLIC_TURN_URL,
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

    return new WebRTCManager(roomId, signalingUrl, iceServers);
  }

  constructor(roomId: string, signalingUrl: string = DEFAULT_SIGNALING_URL, iceServers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]) {
    this.roomId = roomId;
    this.pc = new RTCPeerConnection({ iceServers });

    this.worker = new Worker(new URL('./e2ee/transform.worker.ts', import.meta.url), { type: 'module' });

    this.pc.ontrack = (event) => {
      // E2EE script-transform path is disabled — RTCRtpScriptTransform support
      // diverges across browsers (notably Safari iOS and older Chrome Android),
      // and a partial deployment corrupts the receive stream. WebRTC's built-in
      // DTLS-SRTP still encrypts media in transit. Re-enable once we have a
      // negotiated capability check.
      this.onRemoteTrack?.(event.track, event.streams);
    };

    this.pc.onconnectionstatechange = () => {
      this.onConnectionStateChange?.(this.pc.connectionState);
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
        this.onRoomFull?.();
      }
    };
  }

  public async initECDH() {
    this.ecdhKeyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey']
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
    await this.initECDH();
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    
    const rawPubKey = await crypto.subtle.exportKey('raw', this.ecdhKeyPair!.publicKey);
    const pubKeyBase64 = btoa(String.fromCharCode(...new Uint8Array(rawPubKey)));

    this.sendSignal({
      type: 'offer',
      payload: offer,
      ecdhPublicKey: pubKeyBase64
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
        ecdhPublicKey: pubKeyBase64
      });
    } else if (msg.type === 'answer') {
      await this.pc.setRemoteDescription(new RTCSessionDescription(msg.payload));
      await this.deriveSharedSecret(msg.ecdhPublicKey);
      await this.flushCandidates();
    } else if (msg.type === 'candidate') {
      if (this.pc.remoteDescription) {
        await this.pc.addIceCandidate(new RTCIceCandidate(msg.payload));
      } else {
        this.pendingCandidates.push(msg.payload);
      }
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

    this.sharedSecret = await crypto.subtle.deriveKey(
      { name: 'ECDH', public: remotePubKey },
      this.ecdhKeyPair!.privateKey,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );

    // Send secret to worker
    this.worker.postMessage({ type: 'setKey', key: this.sharedSecret });
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
    this.pc.close();
    this.ws.close();
    this.worker.terminate();
    this.sharedSecret = null;
    this.ecdhKeyPair = null;
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
    }
    sessionStorage.removeItem('alfajer_identity');
  }
}
