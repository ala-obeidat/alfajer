<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { page } from '$app/stores';
  import { WebRTCManager, type CallQuality, type SecurityState } from '$lib/webrtc';
  import { goto } from '$app/navigation';
  import { getOrGenerateIdentity, getIdentity, clearIdentity } from '$lib/identity';
  import { prefs } from '$lib/prefs';
  import { toast } from '$lib/toast.svelte';
  import Icon from '$lib/Icon.svelte';

  let roomId = $page.params.roomId;
  let identity = $state('');
  let remoteIdentity = $state('');
  let remoteNickInitial = $derived(remoteIdentity?.match(/^@(.)/)?.[1]?.toUpperCase() ?? '?');

  let knockName = $state('');
  let knockStatus = $state<'idle' | 'requesting'>('idle');
  let incomingKnock = $state<string | null>(null);

  let localVideoRef: HTMLVideoElement;
  let remoteVideoRef: HTMLVideoElement;

  let rtcManager: WebRTCManager | null = null;

  let isMuted = $state(false);
  let isCameraOff = $state(false);

  let durationMs = $state(0);
  let timerRaf: number;
  let connectionStartTime = 0;

  let peerJoined = $state(false);
  let callConnected = $state(false);
  let codeCopied = $state(false);
  let linkCopied = $state(false);

  // Call modes
  let isInitiator = $page.url.searchParams.has('init');
  let audioOnlyParam = $page.url.searchParams.get('audio') === '1';
  let preSetIdentity = typeof sessionStorage !== 'undefined' ? getIdentity() : null;
  let autoKnocking = !isInitiator && !!preSetIdentity;
  let hasJoined = $state(isInitiator);
  let mediaReady = $state(false); // gated by the permission pre-prompt
  let needsPreprompt = $state(!isInitiator && !!preSetIdentity);

  let shareUrl = typeof window !== 'undefined' ?
    window.location.href.replace('?init=true', '').replace('&audio=1', '').replace('?audio=1', '') : '';

  // Connection-quality pill
  let quality = $state<CallQuality>({ kind: 'connecting', rttMs: null, lossPct: null });

  // Security state + SAS verification code
  let securityState = $state<SecurityState>('connecting');
  let safetyCode = $state<string | null>(null);
  let sasExpanded = $state(false);

  // Devices
  let videoInputs = $state<MediaDeviceInfo[]>([]);
  let audioInputs = $state<MediaDeviceInfo[]>([]);
  let audioOutputs = $state<MediaDeviceInfo[]>([]);
  let currentCameraId = $state('');
  let currentMicId = $state('');
  let currentSpeakerId = $state('');
  let showDeviceMenu = $state(false);
  const speakerSelectSupported = typeof HTMLMediaElement !== 'undefined'
    && 'setSinkId' in HTMLMediaElement.prototype;

  // Draggable PiP
  let localOffset = $state({ x: 0, y: 0 });
  let localWrapperEl: HTMLDivElement | undefined;
  let dragStart: { px: number; py: number; ox: number; oy: number } | null = null;

  let canFlip = $derived(
    videoInputs.length > 1 ||
    (typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches)
  );

  // Speaking-indicator state
  let localSpeaking = $state(false);
  let remoteSpeaking = $state(false);
  let speakingRafs: number[] = [];

  // Camera-off plaque for the remote side
  let remoteVideoFps = $state<number | null>(null);
  let remoteVideoOff = $derived(callConnected && remoteVideoFps !== null && remoteVideoFps === 0);

  // Aspect-ratio CSS var
  function applyRemoteAspect(width: number, height: number) {
    if (!height) return;
    document.documentElement.style.setProperty('--remote-aspect', String(width / height));
  }

  // Chat
  let chatOpen = $state(false);
  let chatInput = $state('');
  let chatLog = $state<Array<{ id: number; from: 'me' | 'them'; text: string; t: number }>>([]);
  let chatScrollEl: HTMLDivElement | undefined;
  let chatNextId = 1;

  // Screen share — only offer it on platforms that actually implement it.
  // Mobile phone browsers expose getDisplayMedia on the global but always
  // reject with NotAllowedError because the OS-level capture flow isn't
  // wired in. iOS Safari simply doesn't implement it. Restrict to:
  //   * the API exists, AND
  //   * the device is NOT a phone-class touch device (coarse pointer +
  //     iPhone/iPad/Android UA + small viewport).
  let isScreenSharing = $state(false);
  function canScreenShare(): boolean {
    if (typeof navigator === 'undefined') return false;
    const md: any = navigator.mediaDevices as any;
    if (!md || typeof md.getDisplayMedia !== 'function') return false;
    const ua = navigator.userAgent || '';
    const isMobilePhone =
      /iPhone|iPod|Android.*Mobile/i.test(ua) ||
      (window.matchMedia('(pointer: coarse)').matches && window.innerWidth < 820);
    return !isMobilePhone;
  }
  const screenShareSupported = canScreenShare();

  function notify(msg: string, variant: 'info' | 'success' | 'warn' | 'error' = 'info') {
    toast.push(msg, variant);
  }

  onMount(async () => {
    if (isInitiator) {
      identity = getOrGenerateIdentity();
      rtcManager = await WebRTCManager.create(roomId, identity, { audioOnly: audioOnlyParam });
      isCameraOff = audioOnlyParam;
      setupRtcCallbacks();
      // Initiator starts media immediately (they confirmed on the home page).
      await startMediaAndCall();
    } else if (preSetIdentity) {
      identity = preSetIdentity;
      knockName = identity;
      // Permission pre-prompt: user must explicitly tap "Start" before we
      // request camera + mic. Avoids out-of-context permission dialogs.
      // mediaReady stays false until user clicks the pre-prompt button.
    } else {
      // Direct link landing — show the original knock dialog so the joiner
      // can type their name.
      needsPreprompt = false;
    }
  });

  async function confirmPreprompt() {
    needsPreprompt = false;
    knockStatus = 'requesting';
    rtcManager = await WebRTCManager.create(roomId, identity, { audioOnly: audioOnlyParam });
    isCameraOff = audioOnlyParam;
    setupRtcCallbacks();
    rtcManager.requestJoin(identity);
  }

  function setupRtcCallbacks() {
    if (!rtcManager) return;

    rtcManager.onPeerJoined = () => {
      peerJoined = true;
    };

    rtcManager.onRemoteTrack = (track, streams) => {
      if (remoteVideoRef && streams[0]) {
        if (remoteVideoRef.srcObject !== streams[0]) {
          remoteVideoRef.srcObject = streams[0];
          remoteVideoRef.play().catch(e => {
            if (e.name !== 'AbortError') console.error('Play failed:', e);
          });
        }
      }
      if (track.kind === 'audio' && streams[0]) {
        attachSpeakingMonitor(streams[0], false);
      }
    };

    rtcManager.onConnectionStateChange = (state) => {
      if (state === 'connected') {
        callConnected = true;
        connectionStartTime = performance.now();
        startTimer();
        rtcManager?.sendIdentity(identity);
        rtcManager?.startQualityMonitor();
        if (peerJoined && remoteIdentity) notify(`${prettyId(remoteIdentity)} joined`, 'success');
        // Restore preferred speaker output if any
        const sp = prefs.getSpeakerId();
        if (sp && remoteVideoRef && 'setSinkId' in remoteVideoRef) {
          (remoteVideoRef as any).setSinkId?.(sp).catch(() => {});
        }
      } else if (state === 'disconnected' || state === 'failed') {
        stopTimer();
        callConnected = false;
        peerJoined = false;
        rtcManager?.stopQualityMonitor();
      }
    };

    rtcManager.onRemoteIdentity = (id) => {
      remoteIdentity = id;
      if (callConnected) notify(`${prettyId(id)} joined`, 'success');
    };

    rtcManager.onCallEnded = (byRemote) => {
      if (byRemote) {
        notify(`Call ended by ${prettyId(remoteIdentity) || 'the other user'}`, 'info');
        setTimeout(() => goto('/'), 1200);
      }
    };

    rtcManager.onRoomFull = () => {
      notify('Room is full — calls are 1-to-1 and this one is sealed.', 'error');
      setTimeout(() => goto('/'), 1500);
    };

    rtcManager.onJoinRequest = (name) => {
      incomingKnock = name;
    };

    rtcManager.onJoinAccepted = async () => {
      knockStatus = 'idle';
      hasJoined = true;
      mediaReady = true;
      await startMediaAndCall();
    };

    rtcManager.onJoinRejected = () => {
      notify('Your request to join was rejected.', 'warn');
      setTimeout(() => goto('/'), 1500);
    };

    rtcManager.onChat = (text) => {
      chatLog.push({ id: chatNextId++, from: 'them', text, t: Date.now() });
      autoScrollChat();
      if (!chatOpen) notify('New message: ' + text.slice(0, 60), 'info');
    };

    rtcManager.onQualityChange = (q) => { quality = q; };
    rtcManager.onIceRestart = () => { notify('Reconnecting…', 'warn'); };
    rtcManager.onSecurityStateChange = (s) => {
      const prev = securityState;
      securityState = s;
      if (prev !== 'e2ee' && s === 'e2ee') notify('End-to-end encryption engaged', 'success', 3500);
    };
    rtcManager.onSafetyCode = (code) => { safetyCode = code; };
  }

  function prettyId(id: string): string {
    const m = id?.match(/^@([^-]+)/);
    return m ? m[1] : (id || '');
  }

  async function startMediaAndCall() {
    if (!rtcManager) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: !audioOnlyParam
      });
      if (localVideoRef && !audioOnlyParam) {
        localVideoRef.srcObject = stream;
      }
      await rtcManager.setLocalStream(stream);
      currentCameraId = stream.getVideoTracks()[0]?.getSettings().deviceId || '';
      currentMicId = stream.getAudioTracks()[0]?.getSettings().deviceId || '';
      // Restore device preferences if set previously
      await applyDevicePrefs();
      await refreshDevices();
      navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
      attachSpeakingMonitor(stream, true);
      // Detect peer's camera-off via inbound-rtp.framesPerSecond
      startRemoteFpsMonitor();
      await rtcManager.startCall();
    } catch (e) {
      console.error('Failed to get media devices', e);
      notify('Could not access camera/microphone. Check browser permissions.', 'error');
    }
  }

  async function applyDevicePrefs() {
    if (!rtcManager) return;
    const wantMic = prefs.getMicId();
    if (wantMic && wantMic !== currentMicId) {
      // Only switch if the device exists
      try {
        const list = await navigator.mediaDevices.enumerateDevices();
        if (list.some(d => d.deviceId === wantMic && d.kind === 'audioinput')) {
          await switchMic(wantMic, true);
        }
      } catch {}
    }
    const wantCam = prefs.getCameraId();
    if (wantCam && wantCam !== currentCameraId && !audioOnlyParam) {
      try {
        const list = await navigator.mediaDevices.enumerateDevices();
        if (list.some(d => d.deviceId === wantCam && d.kind === 'videoinput')) {
          await switchCamera(wantCam, true);
        }
      } catch {}
    }
  }

  async function refreshDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      videoInputs = devices.filter(d => d.kind === 'videoinput');
      audioInputs = devices.filter(d => d.kind === 'audioinput');
      audioOutputs = devices.filter(d => d.kind === 'audiooutput');
    } catch (e) {
      console.warn('enumerateDevices failed', e);
    }
  }

  function inferFacing(label: string | undefined): 'user' | 'environment' | undefined {
    const l = (label || '').toLowerCase();
    if (l.includes('back') || l.includes('rear') || l.includes('environment')) return 'environment';
    if (l.includes('front') || l.includes('user') || l.includes('selfie') || l.includes('face')) return 'user';
    return undefined;
  }

  async function acquireVideo(constraints: MediaStreamConstraints[]): Promise<MediaStream | null> {
    for (const c of constraints) {
      try { return await navigator.mediaDevices.getUserMedia(c); } catch (e) { console.warn('getUserMedia failed', c, e); }
    }
    return null;
  }

  async function applyNewVideoStream(stream: MediaStream) {
    if (!rtcManager) return;
    const newTrack = stream.getVideoTracks()[0];
    if (!newTrack) return;
    await rtcManager.replaceVideoTrack(newTrack);
    if (localVideoRef && rtcManager.localStream) {
      localVideoRef.srcObject = rtcManager.localStream;
    }
    if (isCameraOff) rtcManager.toggleVideo(false);
    currentCameraId = newTrack.getSettings().deviceId || '';
    if (currentCameraId) prefs.setCameraId(currentCameraId);
    await refreshDevices();
  }

  async function switchCamera(deviceId: string, silent = false) {
    if (!rtcManager || !deviceId || deviceId === currentCameraId) return;
    const target = videoInputs.find(d => d.deviceId === deviceId);
    const targetFacing = inferFacing(target?.label);
    rtcManager.localStream?.getVideoTracks().forEach(t => t.stop());
    const attempts: MediaStreamConstraints[] = [
      { video: { deviceId: { exact: deviceId } }, audio: false }
    ];
    if (targetFacing) {
      attempts.push({ video: { facingMode: { exact: targetFacing } }, audio: false });
      attempts.push({ video: { facingMode: { ideal: targetFacing } }, audio: false });
    }
    attempts.push({ video: true, audio: false });
    const stream = await acquireVideo(attempts);
    if (!stream) {
      if (!silent) notify('Could not switch camera. Reload to restore.', 'error');
      return;
    }
    await applyNewVideoStream(stream);
  }

  async function cycleCamera() {
    if (!rtcManager) return;
    const currentTrack = rtcManager.localStream?.getVideoTracks()[0];
    const settings = currentTrack?.getSettings();
    const currentFacing = (settings?.facingMode as 'user' | 'environment' | undefined)
      ?? inferFacing(videoInputs.find(d => d.deviceId === currentCameraId)?.label);
    const targetFacing: 'user' | 'environment' = currentFacing === 'environment' ? 'user' : 'environment';
    rtcManager.localStream?.getVideoTracks().forEach(t => t.stop());
    const attempts: MediaStreamConstraints[] = [
      { video: { facingMode: { exact: targetFacing } }, audio: false },
      { video: { facingMode: { ideal: targetFacing } }, audio: false }
    ];
    if (videoInputs.length > 1) {
      const idx = videoInputs.findIndex(d => d.deviceId === currentCameraId);
      const next = videoInputs[(idx + 1) % videoInputs.length];
      if (next && next.deviceId !== currentCameraId) {
        attempts.push({ video: { deviceId: { exact: next.deviceId } }, audio: false });
      }
    }
    attempts.push({ video: true, audio: false });
    const stream = await acquireVideo(attempts);
    if (!stream) { notify('Could not switch camera.', 'error'); return; }
    await applyNewVideoStream(stream);
  }

  async function switchMic(deviceId: string, silent = false) {
    if (!rtcManager || !deviceId || deviceId === currentMicId) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId } }, video: false
      });
      const newTrack = stream.getAudioTracks()[0];
      await rtcManager.replaceAudioTrack(newTrack);
      if (rtcManager.localStream) rtcManager.toggleAudio(!isMuted);
      currentMicId = newTrack.getSettings().deviceId || deviceId;
      prefs.setMicId(currentMicId);
      attachSpeakingMonitor(stream, true);
    } catch (e) {
      if (!silent) notify('Could not switch microphone.', 'error');
      console.error(e);
    }
  }

  async function switchSpeaker(deviceId: string) {
    if (!remoteVideoRef || !deviceId) return;
    if (!('setSinkId' in remoteVideoRef)) {
      notify('Browser does not allow choosing the audio output.', 'warn');
      return;
    }
    try {
      // @ts-ignore
      await remoteVideoRef.setSinkId(deviceId);
      currentSpeakerId = deviceId;
      prefs.setSpeakerId(deviceId);
    } catch (e) {
      notify('Could not switch speaker.', 'error');
      console.error(e);
    }
  }

  // ---- Speaking detection ----
  function attachSpeakingMonitor(stream: MediaStream, isLocal: boolean) {
    const audio = stream.getAudioTracks()[0];
    if (!audio) return;
    try {
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      const src = ctx.createMediaStreamSource(new MediaStream([audio]));
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      let lastFlip = 0;
      const SPEAKING = 22; // tweakable threshold
      const tick = () => {
        analyser.getByteFrequencyData(data);
        let sum = 0; for (let i = 0; i < data.length; i++) sum += data[i];
        const avg = sum / data.length;
        const now = performance.now();
        const speaking = avg > SPEAKING;
        if (now - lastFlip > 120) {
          if (isLocal && localSpeaking !== speaking) { localSpeaking = speaking; lastFlip = now; }
          if (!isLocal && remoteSpeaking !== speaking) { remoteSpeaking = speaking; lastFlip = now; }
        }
        speakingRafs.push(requestAnimationFrame(tick));
      };
      tick();
    } catch (e) {
      console.warn('speaking monitor failed', e);
    }
  }

  // ---- Remote camera-off detection ----
  let fpsPollHandle: number | null = null;
  function startRemoteFpsMonitor() {
    stopRemoteFpsMonitor();
    fpsPollHandle = setInterval(async () => {
      if (!rtcManager) return;
      try {
        const stats = await rtcManager.pc.getStats();
        let videoFps: number | null = null;
        stats.forEach(r => {
          if (r.type === 'inbound-rtp' && (r as any).kind === 'video') {
            const f = (r as any).framesPerSecond;
            if (typeof f === 'number') videoFps = f;
          }
        });
        remoteVideoFps = videoFps;
      } catch {}
    }, 2000) as unknown as number;
  }
  function stopRemoteFpsMonitor() {
    if (fpsPollHandle !== null) { clearInterval(fpsPollHandle); fpsPollHandle = null; }
  }

  // ---- Aspect ratio detection ----
  function onRemoteLoaded() {
    if (!remoteVideoRef) return;
    applyRemoteAspect(remoteVideoRef.videoWidth, remoteVideoRef.videoHeight);
  }

  // ---- Chat ----
  async function sendChat() {
    if (!chatInput.trim() || !rtcManager) return;
    const text = chatInput.trim();
    await rtcManager.sendChat(text);
    chatLog.push({ id: chatNextId++, from: 'me', text, t: Date.now() });
    chatInput = '';
    autoScrollChat();
  }
  async function autoScrollChat() {
    await tick();
    if (chatScrollEl) chatScrollEl.scrollTop = chatScrollEl.scrollHeight;
  }

  // ---- Screen share ----
  async function toggleScreenShare() {
    if (!rtcManager) return;
    if (!screenShareSupported) {
      notify("Screen sharing isn't supported on this device. Try a desktop browser.", 'warn');
      return;
    }
    if (isScreenSharing) {
      await rtcManager.stopScreenShare();
      isScreenSharing = false;
      notify('Stopped sharing screen.', 'info');
    } else {
      try {
        await rtcManager.startScreenShare();
        isScreenSharing = true;
        notify('Sharing screen — only the peer sees this.', 'success');
      } catch (e: any) {
        const name = e?.name || '';
        if (name === 'NotAllowedError' || name === 'AbortError') {
          // User canceled the OS-level picker — no toast needed.
        } else if (name === 'NotSupportedError') {
          notify("Your browser doesn't support screen sharing.", 'warn');
        } else {
          notify('Could not start screen sharing.', 'error');
        }
        console.warn(e);
      }
    }
  }

  // ---- Knock flow for direct-link visitors ----
  async function sendJoinRequest() {
    if (!knockName) return;
    knockStatus = 'requesting';
    identity = knockName;
    prefs.setNickname(knockName);
    if (!rtcManager) {
      rtcManager = await WebRTCManager.create(roomId, identity, { audioOnly: audioOnlyParam });
      isCameraOff = audioOnlyParam;
      setupRtcCallbacks();
    }
    rtcManager.requestJoin(knockName);
  }

  function acceptIncoming() {
    if (incomingKnock) {
      rtcManager?.acceptJoin();
      incomingKnock = null;
    }
  }
  function rejectIncoming() {
    if (incomingKnock) { rtcManager?.rejectJoin(); incomingKnock = null; }
  }

  onDestroy(() => {
    stopTimer();
    stopRemoteFpsMonitor();
    speakingRafs.forEach(h => cancelAnimationFrame(h));
    // Detach MediaStreams from the <video> elements explicitly. Without this,
    // some Chromium versions keep the underlying RTCRtpReceiver alive in a
    // detached state across navigations, slowly growing the heap. The
    // audit caught this as a Medium-severity leak.
    if (localVideoRef)  { try { (localVideoRef as any).srcObject = null;  } catch {} }
    if (remoteVideoRef) { try { (remoteVideoRef as any).srcObject = null; } catch {} }
    rtcManager?.endCall();
    if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
      navigator.mediaDevices.removeEventListener('devicechange', refreshDevices);
    }
  });

  function startTimer() {
    const tickT = () => { durationMs = performance.now() - connectionStartTime; timerRaf = requestAnimationFrame(tickT); };
    timerRaf = requestAnimationFrame(tickT);
  }
  function stopTimer() { if (timerRaf) cancelAnimationFrame(timerRaf); }

  function toggleMute() { isMuted = !isMuted; rtcManager?.toggleAudio(!isMuted); }
  function toggleCamera() { isCameraOff = !isCameraOff; rtcManager?.toggleVideo(!isCameraOff); }
  function endCall() { rtcManager?.endCall(); goto('/'); }
  function formatDuration(ms: number) {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60).toString().padStart(2, '0');
    const s = (totalSec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }
  function groupedRoomCode(code: string): string {
    // Three-digit grouping for readability. 9-digit current format renders
    // as "123 456 789"; legacy 6-digit codes still render as "123 456".
    if (code.length === 9) return `${code.slice(0,3)} ${code.slice(3,6)} ${code.slice(6)}`;
    if (code.length === 6) return `${code.slice(0,3)} ${code.slice(3)}`;
    return code;
  }

  // ---- Copy actions (with long-press option on touch) ----
  let copyPressTimer: number | null = null;
  function startCopyPress() {
    if (copyPressTimer !== null) return;
    copyPressTimer = setTimeout(() => { void copyCode(); copyPressTimer = null; }, 280) as unknown as number;
  }
  function cancelCopyPress() {
    if (copyPressTimer !== null) { clearTimeout(copyPressTimer); copyPressTimer = null; }
  }
  async function copyCode() {
    try {
      await navigator.clipboard.writeText(roomId);
      codeCopied = true; setTimeout(() => codeCopied = false, 1800);
    } catch { notify('Copy failed; long-press to select the digits.', 'warn'); }
  }
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      linkCopied = true; setTimeout(() => linkCopied = false, 2000);
    } catch { notify('Copy failed.', 'warn'); }
  }
  function shareWhatsApp() {
    const text = `Join my private Alfajer call.\nRoom code: ${roomId}\n${shareUrl}`;
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener,noreferrer');
  }
  async function nativeShare() {
    if (typeof navigator === 'undefined' || !('share' in navigator)) return;
    try {
      await navigator.share({ title: 'Alfajer call', text: `Join my private Alfajer call. Room code: ${roomId}`, url: shareUrl });
    } catch (_) { /* user canceled */ }
  }
  const canNativeShare = typeof navigator !== 'undefined' && 'share' in navigator;

  // ---- Draggable PiP ----
  function onLocalPointerDown(e: PointerEvent) {
    if (!localWrapperEl) return;
    dragStart = { px: e.clientX, py: e.clientY, ox: localOffset.x, oy: localOffset.y };
    localWrapperEl.setPointerCapture(e.pointerId);
  }
  function onLocalPointerMove(e: PointerEvent) {
    if (!dragStart || !localWrapperEl) return;
    const dx = e.clientX - dragStart.px;
    const dy = e.clientY - dragStart.py;
    const rect = localWrapperEl.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const proposedX = dragStart.ox + dx;
    const proposedY = dragStart.oy + dy;
    const minOffX = -((rect.left - dragStart.ox) + rect.width - 24);
    const maxOffX = (vw - (rect.left - dragStart.ox) - 24);
    const minOffY = -((rect.top - dragStart.oy) + rect.height - 24);
    const maxOffY = (vh - (rect.top - dragStart.oy) - 24);
    localOffset = {
      x: Math.min(maxOffX, Math.max(minOffX, proposedX)),
      y: Math.min(maxOffY, Math.max(minOffY, proposedY))
    };
  }
  function onLocalPointerUp(e: PointerEvent) {
    if (!localWrapperEl) return;
    try { localWrapperEl.releasePointerCapture(e.pointerId); } catch {}
    dragStart = null;
  }

  function qualityBadge(q: CallQuality): { color: string; label: string; tooltip: string } {
    switch (q.kind) {
      case 'direct': return {
        color: '#10b981',
        label: 'Direct',
        tooltip: 'Peer-to-peer connection (best path)' + (q.rttMs != null ? ` · ${q.rttMs}ms` : '') + (q.lossPct != null ? ` · ${q.lossPct}% loss` : '')
      };
      case 'relay': return {
        color: '#f59e0b',
        label: 'Relay',
        tooltip: 'Routed through TURN' + (q.rttMs != null ? ` · ${q.rttMs}ms` : '') + (q.lossPct != null ? ` · ${q.lossPct}% loss` : '')
      };
      case 'reconnecting': return { color: '#f59e0b', label: 'Reconnecting', tooltip: 'Trying to recover the connection' };
      case 'failed': return { color: '#ef4444', label: 'Failed', tooltip: 'Connection lost' };
      default: return { color: '#94a3b8', label: 'Connecting', tooltip: 'Negotiating ICE candidates' };
    }
  }
</script>

<div class="call-container">
  <!-- Connection-quality + security pills in the top-left -->
  {#if callConnected}
    <div class="top-pills" in:fade>
      <div class="quality-pill" title={qualityBadge(quality).tooltip}>
        <span class="dot" style="background:{qualityBadge(quality).color}"></span>
        <span>{qualityBadge(quality).label}</span>
        {#if quality.rttMs != null}<span class="rtt">{quality.rttMs}ms</span>{/if}
      </div>

      <!-- E2EE state + SAS verification code. Click to expand and read
           the explanation aloud with your peer. -->
      <button
        type="button"
        class="security-pill"
        class:e2ee={securityState === 'e2ee'}
        class:dtls={securityState === 'dtls-srtp'}
        class:connecting={securityState === 'connecting'}
        onclick={() => sasExpanded = !sasExpanded}
        aria-expanded={sasExpanded}
        aria-label="Security details"
      >
        <span aria-hidden="true">
          {#if securityState === 'e2ee'}🔒{:else if securityState === 'dtls-srtp'}🔐{:else}⏳{/if}
        </span>
        <span>
          {#if securityState === 'e2ee'}E2EE{:else if securityState === 'dtls-srtp'}DTLS-SRTP{:else}Securing…{/if}
        </span>
        {#if safetyCode}
          <span class="sas-mini">{safetyCode}</span>
        {/if}
      </button>
    </div>

    {#if sasExpanded}
      <div class="sas-card" in:fly={{ y: -8, duration: 180 }} out:fade={{ duration: 120 }}>
        <header>
          <strong>Verify this call</strong>
          <button class="ctrl" onclick={() => sasExpanded = false} aria-label="Close">×</button>
        </header>
        {#if safetyCode}
          <div class="sas-digits" aria-label="Safety code">{safetyCode}</div>
          <p class="sas-explain">
            Both you and your peer should see the <strong>same 5 digits</strong>.
            Read them aloud to each other to confirm no one has intercepted the call.
            Different codes mean the connection is not safe — end the call.
          </p>
        {:else}
          <p class="sas-explain">Computing safety code…</p>
        {/if}
        <div class="sas-state-line">
          <span class="dot" style="background:{securityState === 'e2ee' ? '#10b981' : securityState === 'dtls-srtp' ? '#f59e0b' : '#94a3b8'}"></span>
          {#if securityState === 'e2ee'}
            <span>End-to-end encryption is active. Even the signaling server can't see your video.</span>
          {:else if securityState === 'dtls-srtp'}
            <span>This call uses DTLS-SRTP (peer-to-peer encryption). Your peer's browser doesn't support the extra E2EE layer, but no server in between can decrypt your media.</span>
          {:else}
            <span>Negotiating secure channel…</span>
          {/if}
        </div>
      </div>
    {/if}
  {/if}

  {#if needsPreprompt}
    <div class="overlay-status invite-overlay" in:fade>
      <div class="card">
        <h2>Ready to join?</h2>
        <p class="muted">
          Alfajer will ask for camera + microphone on the next screen.
          Streams never leave the call — no recording, no logs.
        </p>
        <div class="actions">
          <button class="primary" onclick={confirmPreprompt}>Start</button>
          <button class="ghost" onclick={() => goto('/')}>Cancel</button>
        </div>
      </div>
    </div>
  {:else if !hasJoined}
    <div class="overlay-status invite-overlay" in:fade>
      {#if knockStatus === 'requesting'}
        <h2>Joining call…</h2>
        <p>Waiting for the host to accept</p>
      {:else}
        <div class="card">
          <span class="invited-pill">📩 Someone invited you to a private call</span>
          <h2>Enter your name to join</h2>
          <input type="text" placeholder="Your nickname" bind:value={knockName} />
          <button class="primary" onclick={sendJoinRequest} disabled={!knockName}>Ask to join</button>
        </div>
      {/if}
    </div>
  {:else if !callConnected}
    <div class="overlay-status" in:fade>
      {#if !peerJoined}
        <h2>Share this room code</h2>
        <button
          type="button"
          class="room-code"
          onpointerdown={startCopyPress}
          onpointerup={cancelCopyPress}
          onpointercancel={cancelCopyPress}
          onpointerleave={cancelCopyPress}
          onclick={copyCode}
          title="Tap to copy code"
          aria-label="Room code, tap to copy"
        >
          <span class="digits">{groupedRoomCode(roomId)}</span>
          <span class="copy-state">
            {#if codeCopied}<Icon name="check" size={14} /> Copied!{:else}<Icon name="copy" size={14} /> tap to copy{/if}
          </span>
        </button>

        <div class="share-row">
          <button class="share-btn wa" onclick={shareWhatsApp} aria-label="Share via WhatsApp">
            <span aria-hidden="true">WhatsApp</span>
          </button>
          <button class="share-btn" onclick={copyLink} aria-label="Copy invite link">
            <Icon name="copy" size={16} /><span>{linkCopied ? 'Link copied' : 'Copy link'}</span>
          </button>
          {#if canNativeShare}
            <button class="share-btn" onclick={nativeShare} aria-label="More share options">
              <Icon name="share" size={16} /><span>Share…</span>
            </button>
          {/if}
        </div>

        <p class="hint">Or share this link:<br /><span class="link-line">{shareUrl}</span></p>
      {:else}
        <h2>Connecting securely…</h2>
      {/if}
    </div>
  {/if}

  {#if incomingKnock}
    <div class="overlay-status knock-overlay" in:fade>
      <div class="card">
        <h2>{incomingKnock} wants to join</h2>
        <div class="actions">
          <button onclick={acceptIncoming}>Accept</button>
          <button class="danger" onclick={rejectIncoming}>Reject</button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Visually hidden live region that announces speaker changes to
       assistive tech. The threshold-cross debounce in attachSpeakingMonitor
       keeps this from spamming the screen reader. -->
  <div class="sr-only" aria-live="polite" aria-atomic="true">
    {#if remoteSpeaking}{prettyId(remoteIdentity) || 'Remote peer'} is speaking{/if}
  </div>

  <div class="videos">
    <div class="video-wrapper remote-video-wrapper" class:speaking={remoteSpeaking}>
      {#if remoteVideoOff}
        <div class="video-off-state" in:fade>
          <div class="avatar">{remoteNickInitial}</div>
          <div class="off-label">{prettyId(remoteIdentity) || 'Connected'}</div>
          <div class="off-sub">Camera off</div>
        </div>
      {:else}
        <video
          bind:this={remoteVideoRef}
          autoplay
          playsinline
          onloadedmetadata={onRemoteLoaded}
          class="remote-video"
        ></video>
      {/if}
      {#if remoteIdentity}
        <div class="name-badge">{prettyId(remoteIdentity)}</div>
      {/if}
    </div>

    {#if !audioOnlyParam}
      <div
        class="video-wrapper local-video-wrapper"
        class:dragging={dragStart !== null}
        class:speaking={localSpeaking}
        bind:this={localWrapperEl}
        onpointerdown={onLocalPointerDown}
        onpointermove={onLocalPointerMove}
        onpointerup={onLocalPointerUp}
        onpointercancel={onLocalPointerUp}
        style="transform: translate({localOffset.x}px, {localOffset.y}px)"
        role="presentation"
      >
        <video bind:this={localVideoRef} autoplay muted playsinline class="local-video"></video>
        <div class="name-badge">{prettyId(identity)} (You)</div>
      </div>
    {/if}
  </div>

  <div class="controls" class:audio-only={audioOnlyParam || isCameraOff}>
    <div class="timer" aria-label="Call duration">{formatDuration(durationMs)}</div>
    <button class="ctrl" onclick={toggleMute} title={isMuted ? 'Unmute' : 'Mute'} aria-label={isMuted ? 'Unmute' : 'Mute'} class:active={isMuted}>
      <Icon name={isMuted ? 'micOff' : 'mic'} size={22} />
    </button>
    {#if !audioOnlyParam}
      <button class="ctrl" onclick={toggleCamera} title={isCameraOff ? 'Turn camera on' : 'Turn camera off'} aria-label={isCameraOff ? 'Camera on' : 'Camera off'} class:active={isCameraOff}>
        <Icon name={isCameraOff ? 'camOff' : 'cam'} size={22} />
      </button>
    {/if}
    {#if canFlip && !audioOnlyParam && !isCameraOff}
      <button class="ctrl" onclick={cycleCamera} title="Switch camera" aria-label="Switch camera">
        <Icon name="flip" size={22} />
      </button>
    {/if}
    {#if screenShareSupported}
      <button class="ctrl" onclick={toggleScreenShare} class:active={isScreenSharing} title={isScreenSharing ? 'Stop sharing' : 'Share screen'} aria-label="Share screen">
        <Icon name="screenShare" size={22} />
      </button>
    {/if}
    <button class="ctrl" onclick={() => chatOpen = !chatOpen} class:active={chatOpen} title="Chat" aria-label="Chat">
      <Icon name="chat" size={22} />
    </button>
    <button class="ctrl" onclick={() => { refreshDevices(); showDeviceMenu = !showDeviceMenu; }} title="Devices" aria-label="Devices" aria-haspopup="dialog">
      <Icon name="gear" size={22} />
    </button>
    <button class="ctrl danger" onclick={endCall} title="End call" aria-label="End call">
      <Icon name="hangup" size={22} />
    </button>
  </div>

  {#if showDeviceMenu}
    <div
      class="device-backdrop"
      onclick={() => (showDeviceMenu = false)}
      onkeydown={(e) => { if (e.key === 'Escape') showDeviceMenu = false; }}
      role="button"
      tabindex="-1"
      aria-label="Close device picker"
      transition:fade={{ duration: 120 }}
    ></div>
    <div class="device-menu" role="dialog" aria-label="Audio &amp; video devices" transition:fly={{ y: 12, duration: 180 }}>
      <div class="device-row">
        <label>
          <span>Microphone</span>
          <select value={currentMicId} onchange={(e) => switchMic((e.currentTarget as HTMLSelectElement).value)}>
            {#if audioInputs.length === 0}<option value="">(none detected)</option>{/if}
            {#each audioInputs as d}
              <option value={d.deviceId}>{d.label || `Microphone ${d.deviceId.slice(0, 6)}`}</option>
            {/each}
          </select>
        </label>
      </div>
      <div class="device-row">
        <label>
          <span>Speaker / Audio output</span>
          {#if speakerSelectSupported}
            <select value={currentSpeakerId} onchange={(e) => switchSpeaker((e.currentTarget as HTMLSelectElement).value)}>
              {#if audioOutputs.length === 0}<option value="">(none detected — your OS controls output)</option>{/if}
              {#each audioOutputs as d}
                <option value={d.deviceId}>{d.label || `Output ${d.deviceId.slice(0, 6)}`}</option>
              {/each}
            </select>
          {:else}
            <span class="hint">Not supported in this browser — use OS-level audio routing.</span>
          {/if}
        </label>
      </div>
      {#if !audioOnlyParam}
        <div class="device-row">
          <label>
            <span>Camera</span>
            <select value={currentCameraId} onchange={(e) => switchCamera((e.currentTarget as HTMLSelectElement).value)}>
              {#if videoInputs.length === 0}<option value="">(none detected)</option>{/if}
              {#each videoInputs as d}
                <option value={d.deviceId}>{d.label || `Camera ${d.deviceId.slice(0, 6)}`}</option>
              {/each}
            </select>
          </label>
        </div>
      {/if}
      <button class="device-close" onclick={() => (showDeviceMenu = false)}>Close</button>
    </div>
  {/if}

  {#if chatOpen}
    <aside class="chat" transition:fly={{ x: 320, duration: 200 }}>
      <header>
        <span>Chat</span>
        <button class="ctrl ghost" onclick={() => chatOpen = false} aria-label="Close chat"><Icon name="close" size={18} /></button>
      </header>
      <div class="chat-log" bind:this={chatScrollEl}>
        {#each chatLog as m (m.id)}
          <div class="msg msg-{m.from}">
            <span class="bubble">{m.text}</span>
          </div>
        {:else}
          <div class="chat-empty">No messages yet. Say hi 👋</div>
        {/each}
      </div>
      <form
        class="chat-input"
        onsubmit={(e) => { e.preventDefault(); void sendChat(); }}
      >
        <input
          type="text"
          bind:value={chatInput}
          placeholder="Type a message…"
          autocomplete="off"
          maxlength="1000"
        />
        <button class="ctrl" type="submit" disabled={!chatInput.trim()} aria-label="Send">
          <Icon name="send" size={20} />
        </button>
      </form>
    </aside>
  {/if}
</div>

<style>
  .call-container {
    display: flex;
    flex-direction: column;
    position: fixed;
    inset: 0;
    background-color: #000;
    overflow: hidden;
    z-index: 1;
  }

  /* Screen-reader-only utility: takes the element out of visual flow without
     hiding it from assistive tech (display:none would). */
  .sr-only {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  /* Top-left pill stack */
  .top-pills {
    position: absolute;
    inset-block-start: max(env(safe-area-inset-top, 0px), 0.6rem);
    inset-inline-start: max(env(safe-area-inset-left, 0px), 0.6rem);
    z-index: 45;
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    max-inline-size: calc(100vw - 1.2rem);
  }
  .quality-pill, .security-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.35rem 0.65rem;
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(8px);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 999px;
    color: white;
    font-size: 0.78rem;
    cursor: pointer;
  }
  .quality-pill { cursor: default; }
  .quality-pill .dot {
    inline-size: 7px; block-size: 7px; border-radius: 50%;
  }
  .quality-pill .rtt {
    opacity: 0.7;
    font-variant-numeric: tabular-nums;
  }
  .security-pill {
    transition: background 0.15s ease, border-color 0.15s ease;
  }
  .security-pill:hover { background: rgba(0, 0, 0, 0.75); }
  .security-pill.e2ee  { border-color: rgba(16, 185, 129, 0.6); }
  .security-pill.dtls  { border-color: rgba(245, 158, 11, 0.6); }
  .security-pill.connecting { border-color: rgba(148, 163, 184, 0.5); }
  .security-pill .sas-mini {
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.12em;
    opacity: 0.85;
    padding-inline-start: 0.35rem;
    border-inline-start: 1px solid rgba(255, 255, 255, 0.18);
  }

  .sas-card {
    position: absolute;
    inset-block-start: max(env(safe-area-inset-top, 0px), 3.2rem);
    inset-inline-start: max(env(safe-area-inset-left, 0px), 0.6rem);
    z-index: 46;
    inline-size: min(360px, calc(100vw - 1.2rem));
    background: rgba(15, 23, 42, 0.97);
    backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 14px;
    padding: 1rem 1rem 0.9rem;
    color: white;
    box-shadow: 0 12px 30px rgb(0 0 0 / 50%);
  }
  .sas-card header {
    display: flex; align-items: center; justify-content: space-between;
    margin-block-end: 0.6rem;
  }
  .sas-card header .ctrl {
    inline-size: 28px; min-block-size: 28px;
    padding: 0; border-radius: 999px;
    background: rgba(255, 255, 255, 0.08);
    color: white; border: none; cursor: pointer;
    font-size: 1.05rem; line-height: 1;
  }
  .sas-digits {
    font-size: clamp(2rem, 9vw, 2.6rem);
    font-weight: 700;
    letter-spacing: 0.35em;
    text-align: center;
    font-variant-numeric: tabular-nums;
    padding: 0.5rem 0;
    color: white;
    user-select: all;
  }
  .sas-explain {
    font-size: 0.88rem;
    color: rgba(255, 255, 255, 0.78);
    margin: 0.25rem 0 0.7rem;
    line-height: 1.45;
  }
  .sas-state-line {
    display: flex; align-items: flex-start; gap: 0.5rem;
    font-size: 0.82rem; color: rgba(255, 255, 255, 0.7);
    padding-block-start: 0.6rem;
    border-block-start: 1px solid rgba(255, 255, 255, 0.08);
  }
  .sas-state-line .dot {
    inline-size: 8px; block-size: 8px; border-radius: 50%;
    flex-shrink: 0; margin-block-start: 0.35rem;
  }

  .overlay-status {
    position: absolute; inset: 0; z-index: 30;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    background-color: rgba(0, 0, 0, 0.8);
    color: white; gap: 1.5rem; padding: 1rem; text-align: center;
  }

  .invited-pill {
    display: inline-block;
    padding: 0.35rem 0.85rem;
    border-radius: 999px;
    background: var(--code-bg);
    border: 1px solid var(--border);
    color: var(--text-secondary);
    font-size: 0.85rem;
    margin-block-end: 0.35rem;
  }

  .card {
    background-color: var(--bg-secondary);
    padding: 2rem; border-radius: 12px;
    display: flex; flex-direction: column; gap: 1rem;
    align-items: center;
    box-shadow: 0 10px 15px -3px rgb(0 0 0 / 20%);
    max-inline-size: 100%;
    color: var(--text-primary);
  }
  .card .muted { color: var(--text-secondary); font-size: 0.95rem; max-inline-size: 28ch; }
  .actions { display: flex; gap: 1rem; flex-wrap: wrap; justify-content: center; }
  .actions button { min-block-size: 44px; padding-inline: 1.2rem; border-radius: 999px; }
  .actions .ghost { background: transparent; color: var(--text-primary); border: 1px solid var(--border-strong); }

  .invite-overlay input {
    padding: 0.75rem 1rem; border-radius: 6px;
    border: 1px solid var(--text-muted);
    background: var(--bg-primary); color: var(--text-primary);
    inline-size: min(250px, 100%); font-size: 1rem;
  }

  .room-code {
    display: inline-flex; flex-direction: column; align-items: center; gap: 0.3rem;
    padding: 0.9rem 1.4rem; background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.18); border-radius: 14px;
    color: white; font-size: clamp(1.8rem, 7vw, 2.5rem); font-weight: 700;
    letter-spacing: 0.18em; font-variant-numeric: tabular-nums;
    cursor: pointer; min-block-size: auto;
  }
  .room-code .digits { user-select: all; }
  .room-code .copy-state {
    display: inline-flex; align-items: center; gap: 0.3rem;
    font-size: 0.72rem; font-weight: 400; letter-spacing: 0.08em;
    color: rgba(255,255,255,0.75); text-transform: uppercase;
  }
  .room-code:hover { background: rgba(255, 255, 255, 0.12); }

  .share-row { display: flex; gap: 0.6rem; flex-wrap: wrap; justify-content: center; max-inline-size: 100%; }
  .share-btn {
    display: inline-flex; align-items: center; gap: 0.45rem;
    padding: 0.6rem 1rem; border-radius: 999px;
    background: rgba(255, 255, 255, 0.1); color: white;
    border: 1px solid rgba(255, 255, 255, 0.18);
    font-size: 0.95rem; min-block-size: 44px; cursor: pointer;
  }
  .share-btn:hover { background: rgba(255, 255, 255, 0.16); }
  .share-btn.wa { background: #25D366; border-color: #25D366; color: white; }
  .share-btn.wa:hover { background: #1ebe5d; }

  .hint { margin: 0; color: var(--text-secondary); font-size: 0.85rem; text-align: center; max-inline-size: 90vw; }
  .link-line { color: var(--text-primary); word-break: break-all; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8rem; }

  .videos {
    position: relative; flex: 1; min-block-size: 0; overflow: hidden;
  }

  .video-wrapper { position: relative; transition: box-shadow 0.15s ease; }
  .video-wrapper.speaking { box-shadow: 0 0 0 4px rgba(16, 185, 129, 0.85); }

  .remote-video-wrapper { inline-size: 100%; block-size: 100%; }
  .remote-video {
    inline-size: 100%; block-size: 100%;
    object-fit: cover; background-color: #000;
  }

  .video-off-state {
    inline-size: 100%; block-size: 100%;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    color: white; gap: 0.5rem; background: linear-gradient(135deg, #1e293b, #0f172a);
  }
  .avatar {
    inline-size: 96px; block-size: 96px;
    border-radius: 50%; background: var(--accent); color: white;
    display: flex; align-items: center; justify-content: center;
    font-size: 3rem; font-weight: 700;
  }
  .off-label { font-size: 1.1rem; font-weight: 600; }
  .off-sub { font-size: 0.85rem; color: var(--text-secondary); }

  .local-video-wrapper {
    position: absolute;
    inset-block-start: max(env(safe-area-inset-top, 0px), 1rem);
    inset-inline-end: 1rem;
    inline-size: clamp(110px, 22vw, 200px);
    z-index: 10;
    cursor: grab; touch-action: none; user-select: none; will-change: transform;
  }
  .local-video-wrapper.dragging { cursor: grabbing; }
  .local-video { inline-size: 100%; border-radius: 12px; box-shadow: 0 4px 6px rgb(0 0 0 / 30%); display: block; pointer-events: none; }

  .name-badge {
    position: absolute; inset-block-end: 0.5rem; inset-inline-start: 0.5rem;
    background: rgba(0, 0, 0, 0.6); color: white;
    padding: 0.25rem 0.6rem; border-radius: 4px; font-size: 0.875rem;
    z-index: 20; pointer-events: none;
  }

  .controls {
    position: absolute; inset-block-end: 0; inset-inline-start: 0; inset-inline-end: 0;
    z-index: 40;
    display: flex; flex-wrap: wrap; gap: 0.65rem; padding: 1rem;
    justify-content: center; align-items: center;
    background: linear-gradient(to top, rgba(0, 0, 0, 0.75), rgba(0, 0, 0, 0));
    pointer-events: none;
  }
  .controls > * { pointer-events: auto; }

  .ctrl {
    inline-size: 48px; min-block-size: 48px;
    padding: 0; border-radius: 999px;
    background: rgba(40, 40, 50, 0.85); color: white; border: none;
    display: inline-flex; align-items: center; justify-content: center;
    cursor: pointer; backdrop-filter: blur(6px);
  }
  .ctrl:hover { background: rgba(60, 60, 75, 0.95); }
  .ctrl.active { background: rgba(96, 165, 250, 0.95); }
  .ctrl.danger { background: var(--danger); }
  .ctrl.danger:hover { background: var(--danger-hover); }
  .ctrl:disabled { opacity: 0.5; }

  .timer {
    font-variant-numeric: tabular-nums;
    font-size: 1rem; font-weight: 700; color: white;
    padding: 0.4rem 0.8rem; border-radius: 999px;
    background: rgba(0, 0, 0, 0.6);
  }

  .device-backdrop {
    position: absolute; inset: 0; z-index: 45;
    background: rgba(0, 0, 0, 0.5); border: none; padding: 0;
  }

  .device-menu {
    position: absolute; inset-block-end: 5.5rem; inset-inline-start: 50%;
    transform: translateX(-50%); z-index: 50;
    background: var(--bg-secondary); border-radius: 12px; padding: 1.25rem;
    box-shadow: 0 10px 30px rgb(0 0 0 / 50%);
    display: flex; flex-direction: column; gap: 0.75rem;
    inline-size: min(380px, calc(100vw - 2rem));
    max-block-size: calc(100dvh - 8rem); overflow-y: auto;
  }

  .device-menu .device-row label { display: flex; flex-direction: column; gap: 0.4rem; color: var(--text-primary); font-size: 0.95rem; }
  .device-menu select {
    background: var(--bg-primary); color: var(--text-primary);
    border: 1px solid var(--text-secondary); border-radius: 8px;
    padding-block: 0.6rem; padding-inline: 0.75rem; font-size: 0.95rem; outline: none;
  }
  .device-menu select:focus { border-color: var(--accent); }
  .device-menu .hint { color: var(--text-secondary); font-size: 0.85rem; }

  .device-close {
    align-self: flex-end; margin-block-start: 0.25rem;
    padding-block: 0.5rem; padding-inline: 1rem; border-radius: 8px;
    background: var(--accent); color: white; border: none; cursor: pointer;
  }

  /* Chat */
  .chat {
    position: absolute;
    inset-block-start: 0; inset-block-end: 5.5rem; inset-inline-end: 0;
    z-index: 42; inline-size: min(360px, 100vw);
    background: rgba(15, 23, 42, 0.95); backdrop-filter: blur(12px);
    color: white; display: flex; flex-direction: column;
    border-inline-start: 1px solid rgba(255, 255, 255, 0.1);
  }
  .chat header { display: flex; align-items: center; justify-content: space-between; padding: 0.85rem 1rem; border-block-end: 1px solid rgba(255, 255, 255, 0.08); font-weight: 600; }
  .chat-log { flex: 1; overflow-y: auto; padding: 0.85rem 1rem; display: flex; flex-direction: column; gap: 0.5rem; }
  .chat-empty { color: var(--text-secondary); font-size: 0.9rem; text-align: center; padding: 2rem 0; }
  .msg { display: flex; }
  .msg-me { justify-content: flex-end; }
  .msg .bubble {
    max-inline-size: 80%; padding: 0.5rem 0.85rem; border-radius: 14px;
    background: rgba(255, 255, 255, 0.1); font-size: 0.95rem; word-wrap: break-word;
  }
  .msg-me .bubble { background: var(--accent); color: white; }
  .chat-input { display: flex; gap: 0.5rem; padding: 0.75rem; border-block-start: 1px solid rgba(255, 255, 255, 0.08); }
  .chat-input input {
    flex: 1; background: var(--bg-primary); color: var(--text-primary);
    border: 1px solid var(--border); border-radius: 10px; padding: 0.55rem 0.85rem; min-block-size: 42px;
  }
  .chat-input .ctrl { inline-size: 42px; min-block-size: 42px; }

  @media (max-width: 600px) {
    .local-video-wrapper { inset-inline-end: 0.75rem; inline-size: clamp(90px, 28vw, 140px); }
    .controls { gap: 0.45rem; padding: 0.75rem; }
    .timer { font-size: 0.9rem; padding: 0.3rem 0.6rem; }
    .chat { inline-size: 100vw; inset-inline-start: 0; }
  }
</style>
