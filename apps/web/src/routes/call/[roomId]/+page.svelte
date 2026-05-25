<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/stores';
  import { WebRTCManager } from '$lib/webrtc';
  import { t } from 'svelte-i18n';
  import { goto } from '$app/navigation';
  import { getOrGenerateIdentity, getIdentity, clearIdentity } from '$lib/identity';
  
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
  // Auto-knock path: if the user came in with an identity already set
  // (i.e. they went through the home page) we never show the redundant
  // "Enter your name to join" dialog. hasJoined becomes true once the
  // remote peer accepts.
  let preSetIdentity = typeof sessionStorage !== 'undefined' ? getIdentity() : null;
  let autoKnocking = !isInitiator && !!preSetIdentity;
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
    if (isInitiator) {
      identity = getOrGenerateIdentity();
      rtcManager = await WebRTCManager.create(roomId, identity);
      setupRtcCallbacks();
      await startMediaAndCall();
    } else if (preSetIdentity) {
      // Joiner who already entered a nickname on the home page —
      // auto-knock instead of showing the redundant overlay.
      identity = preSetIdentity;
      knockName = identity;
      knockStatus = 'requesting';
      rtcManager = await WebRTCManager.create(roomId, identity);
      setupRtcCallbacks();
      rtcManager.requestJoin(identity);
    }
    // else: pre-set identity is missing (someone opened a shared link
    // directly without going through the home page). Fall through and
    // render the knock overlay so they can type a name.
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

  function copyCode() {
    navigator.clipboard.writeText(roomId)
      .then(() => {
        codeCopied = true;
        setTimeout(() => codeCopied = false, 2000);
      });
  }

  function shareWhatsApp() {
    const text = `Join my private Alfajer call.\nRoom code: ${roomId}\n${shareUrl}`;
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener,noreferrer');
  }

  async function nativeShare() {
    if (typeof navigator === 'undefined' || !('share' in navigator)) return;
    try {
      await navigator.share({
        title: 'Alfajer call',
        text: `Join my private Alfajer call. Room code: ${roomId}`,
        url: shareUrl
      });
    } catch (_) {
      // User dismissed the share sheet — no-op
    }
  }

  let codeCopied = $state(false);
  const canNativeShare = typeof navigator !== 'undefined' && 'share' in navigator;
</script>

<div class="call-container">
  {#if !hasJoined}
    <div class="overlay-status invite-overlay">
      {#if knockStatus === 'requesting'}
        <h2>Joining call…</h2>
        <p>Waiting for the host to accept</p>
      {:else}
        <h2>You have been invited to a call</h2>
        <input type="text" placeholder="Enter your name to join" bind:value={knockName} />
        <button onclick={sendJoinRequest} disabled={!knockName}>Ask to Join</button>
      {/if}
    </div>
  {:else if !callConnected}
    <div class="overlay-status">
      {#if !peerJoined}
        <h2>Share this room code</h2>
        <button
          type="button"
          class="room-code"
          onclick={copyCode}
          title="Tap to copy code"
          aria-label="Room code {roomId}, tap to copy"
        >
          {roomId}
          <span class="room-code-hint">{codeCopied ? 'Copied!' : 'tap to copy'}</span>
        </button>

        <div class="share-row">
          <button class="share-btn wa" onclick={shareWhatsApp} aria-label="Share via WhatsApp">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path
                fill="currentColor"
                d="M19.05 4.91A10 10 0 0 0 4.86 19.39L4 23l3.74-.85a10 10 0 0 0 14.97-8.63 9.94 9.94 0 0 0-3.66-8.61Zm-7.07 15.43h-.01a8.32 8.32 0 0 1-4.24-1.17l-.3-.18-2.22.51.54-2.16-.2-.32a8.36 8.36 0 1 1 6.43 3.32Zm4.6-6.27c-.25-.13-1.49-.74-1.72-.82-.23-.08-.4-.13-.57.13-.17.25-.65.82-.8.99-.15.17-.3.19-.55.06a6.84 6.84 0 0 1-3.4-2.97c-.26-.45.26-.42.74-1.39.08-.17.04-.32-.02-.45-.06-.13-.57-1.37-.78-1.88-.21-.5-.42-.43-.57-.44h-.49a.95.95 0 0 0-.69.32 2.92 2.92 0 0 0-.9 2.16c0 1.27.93 2.5 1.06 2.67.13.17 1.82 2.78 4.41 3.9.62.27 1.1.43 1.48.55.62.2 1.18.17 1.62.1.5-.07 1.49-.6 1.71-1.18.21-.59.21-1.09.15-1.19-.06-.1-.23-.16-.49-.29Z"
              />
            </svg>
            <span>WhatsApp</span>
          </button>

          <button class="share-btn" onclick={copyLink} aria-label="Copy invite link">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 1 0-7-7l-1 1m1 9a5 5 0 0 0-7 0l-3 3a5 5 0 1 0 7 7l1-1"
              />
            </svg>
            <span>{linkCopied ? 'Link copied' : 'Copy link'}</span>
          </button>

          {#if canNativeShare}
            <button class="share-btn" onclick={nativeShare} aria-label="More share options">
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <path
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M16 6l-4-4-4 4M12 2v14"
                />
              </svg>
              <span>Share…</span>
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

  .room-code {
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    padding: 0.9rem 1.4rem;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 14px;
    color: white;
    font-size: clamp(1.8rem, 7vw, 2.5rem);
    font-weight: 700;
    letter-spacing: 0.35em;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
    user-select: all;
    min-block-size: auto;
  }

  .room-code:hover { background: rgba(255, 255, 255, 0.12); }

  .room-code-hint {
    font-size: 0.75rem;
    font-weight: 400;
    letter-spacing: 0.05em;
    color: var(--text-secondary);
    text-transform: uppercase;
  }

  .share-row {
    display: flex;
    gap: 0.6rem;
    flex-wrap: wrap;
    justify-content: center;
    max-inline-size: 100%;
  }

  .share-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.6rem 1rem;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.1);
    color: white;
    border: 1px solid rgba(255, 255, 255, 0.18);
    font-size: 0.95rem;
    min-block-size: 44px;
    cursor: pointer;
  }

  .share-btn:hover { background: rgba(255, 255, 255, 0.16); }

  .share-btn.wa {
    background: #25D366;
    border-color: #25D366;
    color: white;
  }

  .share-btn.wa:hover { background: #1ebe5d; }

  .hint {
    margin: 0;
    color: var(--text-secondary);
    font-size: 0.85rem;
    text-align: center;
    max-inline-size: 90vw;
  }

  .link-line {
    color: var(--text-primary);
    word-break: break-all;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.8rem;
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
