<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/stores';
  import { WebRTCManager } from '$lib/webrtc';
  import { t } from 'svelte-i18n';
  import { goto } from '$app/navigation';
  import { getOrGenerateIdentity, clearIdentity } from '$lib/identity';
  
  let roomId = $page.params.roomId;
  let identity = $state('');
  let remoteIdentity = $state('');
  
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
  let linkCopied = $state(false);
  
  let isInitiator = $page.url.searchParams.has('init');
  let hasJoined = $state(isInitiator);

  // Clean URL for sharing
  let shareUrl = typeof window !== 'undefined' ?
    window.location.href.replace('?init=true', '') : '';

  // Device switching
  let videoInputs = $state<MediaDeviceInfo[]>([]);
  let audioInputs = $state<MediaDeviceInfo[]>([]);
  let audioOutputs = $state<MediaDeviceInfo[]>([]);
  let currentCameraId = $state<string>('');
  let currentMicId = $state<string>('');
  let currentSpeakerId = $state<string>('');
  let showDeviceMenu = $state(false);
  const speakerSelectSupported = typeof HTMLMediaElement !== 'undefined'
    && 'setSinkId' in HTMLMediaElement.prototype;

  // Draggable local video
  let localOffset = $state({ x: 0, y: 0 });
  let localWrapperEl: HTMLDivElement | undefined;
  let dragStart: { px: number; py: number; ox: number; oy: number } | null = null;

  // The Flip button is shown when we know we have 2+ cameras OR when the
  // device looks like a phone/tablet (coarse pointer). Mobile browsers often
  // mask deviceIds until permission is granted twice, so we rely on
  // facingMode for the switch and just need to surface the button.
  let canFlip = $derived(
    videoInputs.length > 1 ||
    (typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches)
  );

  onMount(async () => {
    identity = getOrGenerateIdentity(); // Auto-generates gest-xxxx if not present
    if (isInitiator) {
      rtcManager = await WebRTCManager.create(roomId, identity);
      setupRtcCallbacks();
      await startMediaAndCall();
    }
  });
  
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
    };
    
    rtcManager.onConnectionStateChange = (state) => {
      if (state === 'connected') {
        callConnected = true;
        connectionStartTime = performance.now();
        startTimer();
        rtcManager?.sendIdentity(identity);
      } else if (state === 'disconnected' || state === 'failed') {
        stopTimer();
        callConnected = false;
        peerJoined = false;
      }
    };
    
    rtcManager.onRemoteIdentity = (id) => {
      remoteIdentity = id;
    };
    
    rtcManager.onCallEnded = (byRemote) => {
      if (byRemote) {
        alert(`Call ended by ${remoteIdentity || 'the other user'}`);
        goto('/');
      }
    };
    
    rtcManager.onRoomFull = () => {
      alert('Room is full (Sealed).');
      goto('/');
    };

    rtcManager.onJoinRequest = (name) => {
      incomingKnock = name;
    };

    rtcManager.onJoinAccepted = async () => {
      knockStatus = 'idle';
      hasJoined = true;
      await startMediaAndCall();
    };

    rtcManager.onJoinRejected = () => {
      alert('Your request to join was rejected.');
      goto('/');
    };
  }

  async function startMediaAndCall() {
    if (!rtcManager) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      if (localVideoRef) {
        localVideoRef.srcObject = stream;
      }
      await rtcManager.setLocalStream(stream);
      currentCameraId = stream.getVideoTracks()[0]?.getSettings().deviceId || '';
      currentMicId = stream.getAudioTracks()[0]?.getSettings().deviceId || '';
      await refreshDevices();
      navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
      await rtcManager.startCall();
    } catch (e) {
      console.error('Failed to get media devices', e);
      alert('Could not access camera/microphone.');
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
      try {
        return await navigator.mediaDevices.getUserMedia(c);
      } catch (e) {
        console.warn('getUserMedia attempt failed', c, e);
      }
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
    if (isCameraOff) {
      // Preserve "Camera Off" state on the new track
      rtcManager.toggleVideo(false);
    }
    currentCameraId = newTrack.getSettings().deviceId || '';
    // Re-enumerate to pick up any newly-labeled devices
    await refreshDevices();
  }

  async function switchCamera(deviceId: string) {
    if (!rtcManager || !deviceId || deviceId === currentCameraId) return;
    const target = videoInputs.find(d => d.deviceId === deviceId);
    const targetFacing = inferFacing(target?.label);

    // Stop current video FIRST — Android holds the camera hardware otherwise
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
      alert('Could not switch camera. Reload the page to restore video.');
      return;
    }
    await applyNewVideoStream(stream);
  }

  async function cycleCamera() {
    if (!rtcManager) return;

    // Prefer facingMode for the Flip path — Android Chrome resolves it much
    // more reliably than deviceId, and on iOS Safari deviceIds are masked
    // until permission is granted twice in a row.
    const currentTrack = rtcManager.localStream?.getVideoTracks()[0];
    const settings = currentTrack?.getSettings();
    const currentFacing = (settings?.facingMode as 'user' | 'environment' | undefined)
      ?? inferFacing(videoInputs.find(d => d.deviceId === currentCameraId)?.label);
    const targetFacing: 'user' | 'environment' =
      currentFacing === 'environment' ? 'user' : 'environment';

    rtcManager.localStream?.getVideoTracks().forEach(t => t.stop());

    const attempts: MediaStreamConstraints[] = [
      { video: { facingMode: { exact: targetFacing } }, audio: false },
      { video: { facingMode: { ideal: targetFacing } }, audio: false }
    ];
    // Fall back to deviceId rotation through our enumerated list
    if (videoInputs.length > 1) {
      const idx = videoInputs.findIndex(d => d.deviceId === currentCameraId);
      const next = videoInputs[(idx + 1) % videoInputs.length];
      if (next && next.deviceId !== currentCameraId) {
        attempts.push({ video: { deviceId: { exact: next.deviceId } }, audio: false });
      }
    }
    // Last resort: any camera the OS will give us
    attempts.push({ video: true, audio: false });

    const stream = await acquireVideo(attempts);
    if (!stream) {
      alert('Could not switch camera. Reload the page to restore video.');
      return;
    }
    await applyNewVideoStream(stream);
  }

  async function switchMic(deviceId: string) {
    if (!rtcManager || !deviceId || deviceId === currentMicId) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId } },
        video: false
      });
      const newTrack = stream.getAudioTracks()[0];
      await rtcManager.replaceAudioTrack(newTrack);
      // Re-apply mute state to the new track
      if (rtcManager.localStream) {
        rtcManager.toggleAudio(!isMuted);
      }
      currentMicId = newTrack.getSettings().deviceId || deviceId;
    } catch (e) {
      console.error('switchMic failed', e);
      alert('Could not switch microphone.');
    }
  }

  async function switchSpeaker(deviceId: string) {
    if (!remoteVideoRef || !deviceId) return;
    if (!('setSinkId' in remoteVideoRef)) {
      alert('Your browser does not support selecting an audio output.');
      return;
    }
    try {
      // @ts-ignore — setSinkId is not in all TS lib targets
      await remoteVideoRef.setSinkId(deviceId);
      currentSpeakerId = deviceId;
    } catch (e) {
      console.error('switchSpeaker failed', e);
      alert('Could not switch speaker.');
    }
  }

  // Draggable local-video handlers
  function onLocalPointerDown(e: PointerEvent) {
    if (!localWrapperEl) return;
    dragStart = {
      px: e.clientX,
      py: e.clientY,
      ox: localOffset.x,
      oy: localOffset.y
    };
    didDrag = false;
    localWrapperEl.setPointerCapture(e.pointerId);
  }

  function onLocalPointerMove(e: PointerEvent) {
    if (!dragStart || !localWrapperEl) return;
    const dx = e.clientX - dragStart.px;
    const dy = e.clientY - dragStart.py;
    const rect = localWrapperEl.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Clamp so the box keeps at least 24px on-screen each direction.
    // rect already reflects the current transform, so we work in offset deltas.
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
  
  async function sendJoinRequest() {
    if (!knockName) return;
    knockStatus = 'requesting';
    identity = knockName;

    if (!rtcManager) {
      rtcManager = await WebRTCManager.create(roomId, identity);
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
    if (incomingKnock) {
      rtcManager?.rejectJoin();
      incomingKnock = null;
    }
  }
  
  onDestroy(() => {
    stopTimer();
    rtcManager?.endCall();
    if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
      navigator.mediaDevices.removeEventListener('devicechange', refreshDevices);
    }
  });
  
  function startTimer() {
    function tick() {
      durationMs = performance.now() - connectionStartTime;
      timerRaf = requestAnimationFrame(tick);
    }
    timerRaf = requestAnimationFrame(tick);
  }
  
  function stopTimer() {
    if (timerRaf) cancelAnimationFrame(timerRaf);
  }
  
  function toggleMute() {
    isMuted = !isMuted;
    rtcManager?.toggleAudio(!isMuted);
  }
  
  function toggleCamera() {
    isCameraOff = !isCameraOff;
    rtcManager?.toggleVideo(!isCameraOff);
  }
  
  function endCall() {
    rtcManager?.endCall();
    goto('/');
  }
  
  function formatDuration(ms: number) {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60).toString().padStart(2, '0');
    const s = (totalSec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }
  
  function copyLink() {
    navigator.clipboard.writeText(shareUrl)
      .then(() => {
        linkCopied = true;
        setTimeout(() => linkCopied = false, 2000);
      });
  }
</script>

<div class="call-container">
  {#if !hasJoined}
    <div class="overlay-status invite-overlay">
      <h2>You have been invited to a call</h2>
      {#if knockStatus === 'idle'}
        <input type="text" placeholder="Enter your name to join" bind:value={knockName} />
        <button onclick={sendJoinRequest} disabled={!knockName}>Ask to Join</button>
      {:else if knockStatus === 'requesting'}
        <p>Waiting for approval...</p>
      {/if}
    </div>
  {:else if !callConnected}
    <div class="overlay-status">
      {#if !peerJoined}
        <h2>Waiting for someone to join...</h2>
        <div class="share-box">
          <input type="text" readonly value={shareUrl} />
          <button onclick={copyLink}>{linkCopied ? 'Copied!' : 'Copy Link'}</button>
        </div>
      {:else}
        <h2>A user is joining the call... Connecting securely...</h2>
      {/if}
    </div>
  {/if}

  {#if incomingKnock}
    <div class="overlay-status knock-overlay">
      <div class="card">
        <h2>{incomingKnock} wants to join</h2>
        <div class="actions">
          <button onclick={acceptIncoming}>Accept</button>
          <button class="danger" onclick={rejectIncoming}>Reject</button>
        </div>
      </div>
    </div>
  {/if}

  <div class="videos">
    <div class="video-wrapper remote-video-wrapper">
      <video bind:this={remoteVideoRef} autoplay playsinline class="remote-video"></video>
      {#if remoteIdentity}
        <div class="name-badge">{remoteIdentity}</div>
      {/if}
    </div>

    <div
      class="video-wrapper local-video-wrapper"
      class:dragging={dragStart !== null}
      bind:this={localWrapperEl}
      onpointerdown={onLocalPointerDown}
      onpointermove={onLocalPointerMove}
      onpointerup={onLocalPointerUp}
      onpointercancel={onLocalPointerUp}
      style="transform: translate({localOffset.x}px, {localOffset.y}px)"
      role="presentation"
    >
      <video bind:this={localVideoRef} autoplay muted playsinline class="local-video"></video>
      <div class="name-badge">{identity} (You)</div>
    </div>
  </div>

  <div class="controls">
    <div class="timer">{formatDuration(durationMs)}</div>
    <button onclick={toggleMute}>
      {isMuted ? $t('unmute') : $t('mute')}
    </button>
    <button onclick={toggleCamera}>
      {isCameraOff ? $t('cameraOn') : $t('cameraOff')}
    </button>
    {#if canFlip}
      <button onclick={cycleCamera} title="Switch camera" aria-label="Switch camera">
        Flip
      </button>
    {/if}
    <button onclick={() => { refreshDevices(); showDeviceMenu = !showDeviceMenu; }} aria-haspopup="dialog">
      Devices
    </button>
    <button class="danger" onclick={endCall}>End Call</button>
  </div>

  {#if showDeviceMenu}
    <div
      class="device-backdrop"
      onclick={() => (showDeviceMenu = false)}
      onkeydown={(e) => { if (e.key === 'Escape') showDeviceMenu = false; }}
      role="button"
      tabindex="-1"
      aria-label="Close device picker"
    ></div>
    <div class="device-menu" role="dialog" aria-label="Audio &amp; video devices">
      <div class="device-row">
        <label>
          <span>Microphone</span>
          <select
            value={currentMicId}
            onchange={(e) => switchMic((e.currentTarget as HTMLSelectElement).value)}
          >
            {#if audioInputs.length === 0}
              <option value="">(none detected)</option>
            {/if}
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
            <select
              value={currentSpeakerId}
              onchange={(e) => switchSpeaker((e.currentTarget as HTMLSelectElement).value)}
            >
              {#if audioOutputs.length === 0}
                <option value="">(none detected — your OS controls output)</option>
              {/if}
              {#each audioOutputs as d}
                <option value={d.deviceId}>{d.label || `Output ${d.deviceId.slice(0, 6)}`}</option>
              {/each}
            </select>
          {:else}
            <span class="hint">Not supported in this browser — use OS-level audio routing.</span>
          {/if}
        </label>
      </div>

      <div class="device-row">
        <label>
          <span>Camera</span>
          <select
            value={currentCameraId}
            onchange={(e) => switchCamera((e.currentTarget as HTMLSelectElement).value)}
          >
            {#if videoInputs.length === 0}
              <option value="">(none detected)</option>
            {/if}
            {#each videoInputs as d}
              <option value={d.deviceId}>{d.label || `Camera ${d.deviceId.slice(0, 6)}`}</option>
            {/each}
          </select>
        </label>
      </div>

      <button class="device-close" onclick={() => (showDeviceMenu = false)}>Close</button>
    </div>
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

  .overlay-status {
    position: absolute;
    inset: 0;
    z-index: 30;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background-color: rgba(0, 0, 0, 0.8);
    color: white;
    gap: 1.5rem;
    padding: 1rem;
    text-align: center;
  }

  .share-box {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    background: var(--bg-secondary);
    padding: 1rem;
    border-radius: 8px;
    align-items: center;
    max-inline-size: 100%;
  }

  .share-box input {
    flex: 1;
    min-inline-size: 200px;
    inline-size: 300px;
    max-inline-size: 100%;
    background: var(--bg-primary);
  }

  .card {
    background-color: var(--bg-secondary);
    padding: 2rem;
    border-radius: 12px;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    align-items: center;
    box-shadow: 0 10px 15px -3px rgb(0 0 0 / 20%);
    max-inline-size: 100%;
  }

  .actions {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
    justify-content: center;
  }

  .invite-overlay input {
    padding: 0.75rem 1rem;
    border-radius: 6px;
    border: 1px solid var(--text-muted);
    background: var(--bg-primary);
    color: var(--text-primary);
    inline-size: min(250px, 100%);
    font-size: 1rem;
  }

  .videos {
    position: relative;
    flex: 1;
    min-block-size: 0;
    overflow: hidden;
  }

  .video-wrapper {
    position: relative;
  }

  .remote-video-wrapper {
    inline-size: 100%;
    block-size: 100%;
  }

  .remote-video {
    inline-size: 100%;
    block-size: 100%;
    object-fit: cover;
    background-color: #000;
  }

  .local-video-wrapper {
    position: absolute;
    inset-block-start: 1rem;
    inset-inline-end: 1rem;
    inline-size: clamp(110px, 22vw, 200px);
    z-index: 10;
    cursor: grab;
    touch-action: none;
    user-select: none;
    will-change: transform;
    transition: box-shadow 0.15s ease;
  }

  .local-video-wrapper.dragging {
    cursor: grabbing;
    box-shadow: 0 8px 24px rgb(0 0 0 / 50%);
  }

  .local-video {
    inline-size: 100%;
    border-radius: 12px;
    box-shadow: 0 4px 6px rgb(0 0 0 / 30%);
    display: block;
    pointer-events: none;
  }

  .name-badge {
    position: absolute;
    inset-block-end: 0.5rem;
    inset-inline-start: 0.5rem;
    background: rgba(0, 0, 0, 0.6);
    color: white;
    padding: 0.25rem 0.6rem;
    border-radius: 4px;
    font-size: 0.875rem;
    z-index: 20;
    pointer-events: none;
  }

  .controls {
    position: absolute;
    inset-block-end: 0;
    inset-inline-start: 0;
    inset-inline-end: 0;
    z-index: 40;
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    padding: 1rem;
    justify-content: center;
    align-items: center;
    background: linear-gradient(to top, rgba(0, 0, 0, 0.75), rgba(0, 0, 0, 0));
    pointer-events: none;
  }

  .controls > * {
    pointer-events: auto;
  }

  .controls button {
    min-block-size: 44px;
    padding-inline: 1rem;
    border-radius: 999px;
    background: rgba(40, 40, 50, 0.85);
    color: white;
    border: none;
    font-size: 0.95rem;
    cursor: pointer;
    backdrop-filter: blur(6px);
  }

  .controls button:hover {
    background: rgba(60, 60, 75, 0.95);
  }

  .controls button.danger {
    background: var(--danger);
  }

  .timer {
    font-variant-numeric: tabular-nums;
    font-size: 1.05rem;
    font-weight: 700;
    color: white;
    padding: 0.4rem 0.8rem;
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.6);
  }

  .device-backdrop {
    position: absolute;
    inset: 0;
    z-index: 45;
    background: rgba(0, 0, 0, 0.5);
    border: none;
    padding: 0;
  }

  .device-menu {
    position: absolute;
    inset-block-end: 5rem;
    inset-inline-start: 50%;
    transform: translateX(-50%);
    z-index: 50;
    background: var(--bg-secondary);
    border-radius: 12px;
    padding: 1.25rem;
    box-shadow: 0 10px 30px rgb(0 0 0 / 50%);
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    inline-size: min(380px, calc(100vw - 2rem));
    max-block-size: calc(100dvh - 8rem);
    overflow-y: auto;
  }

  .device-menu .device-row label {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    color: var(--text-primary);
    font-size: 0.95rem;
  }

  .device-menu select {
    background: var(--bg-primary);
    color: var(--text-primary);
    border: 1px solid var(--text-secondary);
    border-radius: 8px;
    padding-block: 0.6rem;
    padding-inline: 0.75rem;
    font-size: 0.95rem;
    outline: none;
  }

  .device-menu select:focus {
    border-color: var(--accent);
  }

  .device-menu .hint {
    color: var(--text-secondary);
    font-size: 0.85rem;
  }

  .device-close {
    align-self: flex-end;
    margin-block-start: 0.25rem;
    padding-block: 0.5rem;
    padding-inline: 1rem;
    border-radius: 8px;
    background: var(--accent);
    color: white;
    border: none;
    cursor: pointer;
  }

  @media (max-width: 600px) {
    .local-video-wrapper {
      inset-block-start: 0.75rem;
      inset-inline-end: 0.75rem;
      inline-size: clamp(90px, 28vw, 140px);
    }

    .controls {
      gap: 0.5rem;
      padding: 0.75rem;
    }

    .controls button {
      padding-inline: 0.75rem;
      font-size: 0.9rem;
    }

    .timer {
      font-size: 0.9rem;
      padding: 0.3rem 0.6rem;
    }

    .overlay-status h2 {
      font-size: 1.25rem;
    }
  }

  @media (max-width: 380px) {
    .controls {
      flex-direction: row;
      justify-content: space-around;
    }

    .controls button {
      padding-inline: 0.5rem;
    }
  }
</style>
