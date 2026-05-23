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
      await rtcManager.startCall();
    } catch (e) {
      console.error('Failed to get media devices', e);
      alert('Could not access camera/microphone.');
    }
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

    <div class="video-wrapper local-video-wrapper">
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
    <button class="danger" onclick={endCall}>End Call</button>
  </div>
</div>

<style>
  .call-container {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background-color: #000;
    position: relative;
  }
  
  .overlay-status {
    position: absolute;
    inset: 0;
    z-index: 20;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background-color: rgba(0, 0, 0, 0.8);
    color: white;
    gap: 1.5rem;
  }
  
  .share-box {
    display: flex;
    gap: 0.5rem;
    background: var(--bg-secondary);
    padding: 1rem;
    border-radius: 8px;
    align-items: center;
  }
  
  .share-box input {
    width: 300px;
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
  }

  .actions {
    display: flex;
    gap: 1rem;
  }

  .invite-overlay input {
    padding: 0.75rem 1rem;
    border-radius: 6px;
    border: 1px solid var(--text-muted);
    background: var(--bg-primary);
    color: var(--text-primary);
    width: 250px;
    font-size: 1rem;
  }
  
  .video-wrapper {
    position: relative;
    width: 100%;
    height: 100%;
  }

  .remote-video-wrapper {
    flex: 1;
  }
  
  .remote-video {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  
  .local-video-wrapper {
    position: absolute;
    inset-block-end: 2rem;
    inset-inline-end: 2rem;
    width: 200px;
    z-index: 10;
  }

  .local-video {
    width: 100%;
    border-radius: 12px;
    box-shadow: 0 4px 6px rgb(0 0 0 / 30%);
  }

  .name-badge {
    position: absolute;
    inset-block-end: 1rem;
    inset-inline-start: 1rem;
    background: rgba(0, 0, 0, 0.6);
    color: white;
    padding: 0.25rem 0.75rem;
    border-radius: 4px;
    font-size: 0.875rem;
    z-index: 20;
    pointer-events: none;
  }
  
  .controls {
    display: flex;
    gap: 1rem;
    padding-block: 1.5rem;
    justify-content: center;
    align-items: center;
    background-color: var(--bg-secondary);
  }
  
  .timer {
    font-variant-numeric: tabular-nums;
    font-size: 1.25rem;
    font-weight: 700;
    padding-inline-end: 1rem;
  }
  
  button.danger {
    background-color: var(--danger);
  }
</style>
