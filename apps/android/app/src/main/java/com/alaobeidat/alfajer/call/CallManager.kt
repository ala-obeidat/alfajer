package com.alaobeidat.alfajer.call

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
import com.alaobeidat.alfajer.Config
import com.alaobeidat.alfajer.core.CallKeys
import com.alaobeidat.alfajer.core.EcdhKeyPair
import com.alaobeidat.alfajer.core.Identity
import com.alaobeidat.alfajer.core.SdpRole
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.Camera1Enumerator
import org.webrtc.Camera2Enumerator
import org.webrtc.CameraEnumerator
import org.webrtc.CameraVideoCapturer
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.RTCStatsReport
import org.webrtc.RtpTransceiver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import java.util.concurrent.TimeUnit

/**
 * Native port of the web client's WebRTCManager + call page logic
 * (apps/web/src/lib/webrtc.ts, apps/web/src/routes/call/[roomId]/+page.svelte).
 *
 * The wire protocol is identical, so an Android peer can call a browser peer
 * and vice versa:
 *   joiner  → request_join(identity)        host → join_accept | join_reject
 *   joiner  → join            host (offerer) → offer{sdp, ecdhPublicKey}
 *   joiner (answerer) → answer{sdp, ecdhPublicKey}; both ↔ candidate
 *   on connect both → identity, media_state; chat is AES-GCM sealed.
 *
 * All state mutation and signaling handling run on one serial dispatcher,
 * so messages are processed strictly in arrival order.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class CallManager private constructor(
    context: Context,
    val roomId: String,
    identity: String,
    isInitiator: Boolean,
    audioOnly: Boolean,
    iceServers: List<PeerConnection.IceServer>,
    http: OkHttpClient,
) {
    private val app = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default.limitedParallelism(1))

    private val _state = MutableStateFlow(
        CallState(
            roomId = roomId,
            identity = identity,
            isInitiator = isInitiator,
            audioOnly = audioOnly,
            phase = if (isInitiator) Phase.WAITING else Phase.REQUESTING,
            cameraOff = audioOnly,
        )
    )
    val state: StateFlow<CallState> = _state.asStateFlow()

    private val _localVideo = MutableStateFlow<VideoTrack?>(null)
    val localVideo: StateFlow<VideoTrack?> = _localVideo.asStateFlow()
    private val _remoteVideo = MutableStateFlow<VideoTrack?>(null)
    val remoteVideo: StateFlow<VideoTrack?> = _remoteVideo.asStateFlow()

    private val inbox = Channel<JSONObject>(Channel.UNLIMITED)
    private val factory = RtcEngine.factory(app)
    private val audioRouter = AudioRouter(app)

    private val signaling = SignalingClient(
        http,
        Config.signalingWsUrl(roomId),
        object : SignalingClient.Listener {
            override fun onMessage(msg: JSONObject) {
                inbox.trySend(msg)
            }

            override fun onClosed(code: Int) {
                scope.launch { onSocketClosed(code) }
            }
        },
    )

    private val pc: PeerConnection = factory.createPeerConnection(
        PeerConnection.RTCConfiguration(iceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        },
        object : PeerConnection.Observer {
            override fun onIceCandidate(candidate: IceCandidate) {
                send(
                    JSONObject()
                        .put("type", "candidate")
                        .put(
                            "payload",
                            JSONObject()
                                .put("candidate", candidate.sdp)
                                .put("sdpMid", candidate.sdpMid)
                                .put("sdpMLineIndex", candidate.sdpMLineIndex)
                        )
                )
            }

            override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
                scope.launch { onPeerConnectionState(newState) }
            }

            override fun onIceConnectionChange(newState: PeerConnection.IceConnectionState) {
                // Only the offerer can restart ICE; the answerer waits for
                // the fresh offer (same as the web client).
                if (newState == PeerConnection.IceConnectionState.FAILED) scope.launch { tryIceRestart() }
            }

            override fun onTrack(transceiver: RtpTransceiver) {
                val track = transceiver.receiver.track()
                if (track is VideoTrack) _remoteVideo.value = track
                // Remote audio plays through the audio device module directly.
            }

            override fun onSignalingChange(newState: PeerConnection.SignalingState) {}
            override fun onIceConnectionReceivingChange(receiving: Boolean) {}
            override fun onIceGatheringChange(newState: PeerConnection.IceGatheringState) {}
            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}
            override fun onAddStream(stream: MediaStream) {}
            override fun onRemoveStream(stream: MediaStream) {}
            override fun onDataChannel(channel: DataChannel) {}
            override fun onRenegotiationNeeded() {}
        },
    ) ?: error("PeerConnection creation failed")

    // Crypto state — fresh ECDH pair per handshake, discarded on cleanup.
    private var role: SdpRole? = null
    private var ecdh: EcdhKeyPair? = null
    private var keys: CallKeys? = null
    // Messages typed before the chat key exists wait here as plaintext in
    // memory only; they are never sent unencrypted.
    private val chatQueue = ArrayList<String>()
    private var chatNextId = 1L
    private var chatOpen = false

    private val pendingCandidates = ArrayList<IceCandidate>()
    private var iceRestartInFlight = false
    private var monitorJob: Job? = null
    private var mediaStarted = false
    private var cleanedUp = false

    // Local media
    private var audioSource: AudioSource? = null
    private var audioTrack: AudioTrack? = null
    private var videoSource: VideoSource? = null
    private var videoTrack: VideoTrack? = null
    private var capturer: CameraVideoCapturer? = null
    private var captureHelper: SurfaceTextureHelper? = null
    private var capturing = false

    init {
        scope.launch {
            for (msg in inbox) {
                if (cleanedUp) break
                try {
                    handleSignal(msg)
                } catch (e: Exception) {
                    Log.w(TAG, "signal '${msg.optString("type")}' failed", e)
                }
            }
        }
    }

    private fun begin() {
        scope.launch {
            if (_state.value.isInitiator) {
                // The host confirmed on the home screen, so media starts now.
                if (startMedia()) send(JSONObject().put("type", "join"))
            } else {
                send(JSONObject().put("type", "request_join").put("payload", _state.value.identity))
            }
        }
    }

    // ---------------------------------------------------------------- public API

    fun acceptJoin() = scope.launch {
        if (_state.value.incomingKnock == null) return@launch
        send(JSONObject().put("type", "join_accept"))
        _state.update { it.copy(incomingKnock = null) }
    }

    fun rejectJoin() = scope.launch {
        if (_state.value.incomingKnock == null) return@launch
        send(JSONObject().put("type", "join_reject"))
        _state.update { it.copy(incomingKnock = null) }
    }

    fun toggleMute() = scope.launch {
        val track = audioTrack ?: return@launch
        val muted = !_state.value.muted
        track.setEnabled(!muted)
        _state.update { it.copy(muted = muted) }
    }

    fun toggleCamera() = scope.launch {
        val track = videoTrack ?: return@launch
        val off = !_state.value.cameraOff
        track.setEnabled(!off)
        // Release the camera while it's off so the privacy LED goes dark.
        if (off) stopCapture() else startCapture()
        _state.update { it.copy(cameraOff = off) }
        sendVideoState()
    }

    fun switchCamera() = scope.launch {
        val cap = capturer ?: return@launch
        cap.switchCamera(object : CameraVideoCapturer.CameraSwitchHandler {
            override fun onCameraSwitchDone(isFrontCamera: Boolean) {
                _state.update { it.copy(frontCamera = isFrontCamera) }
            }

            override fun onCameraSwitchError(errorDescription: String?) {
                notify(CallNotice.Error("Could not switch camera."))
            }
        })
    }

    fun toggleSpeaker() = scope.launch {
        val on = audioRouter.setSpeaker(!_state.value.speakerOn)
        _state.update { it.copy(speakerOn = on) }
    }

    fun setChatOpen(open: Boolean) = scope.launch {
        chatOpen = open
        if (open) _state.update { it.copy(unreadChat = 0) }
    }

    fun sendChat(text: String) = scope.launch {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return@launch
        val k = keys
        if (k == null) chatQueue.add(trimmed) else sealAndSend(k, trimmed)
        appendChat(fromMe = true, text = trimmed)
    }

    fun setSasVerification(v: SasVerification) = scope.launch {
        _state.update { it.copy(sasVerification = v) }
        when (v) {
            SasVerification.VERIFIED -> notify(CallNotice.Success("Connection verified"))
            SasVerification.MISMATCH -> notify(CallNotice.Error("Connection NOT verified — consider ending the call"))
            SasVerification.PENDING -> Unit
        }
    }

    fun hangUp() = scope.launch {
        if (cleanedUp) return@launch
        send(JSONObject().put("type", "end"))
        finish(EndReason.HANGUP)
    }

    // ---------------------------------------------------------------- signaling

    private fun send(msg: JSONObject) = signaling.send(msg)

    private suspend fun handleSignal(msg: JSONObject) {
        when (msg.optString("type")) {
            "join" -> {
                _state.update { it.copy(peerJoined = true) }
                makeOffer()
            }
            "offer" -> handleOffer(msg)
            "answer" -> handleAnswer(msg)
            "candidate" -> handleCandidate(msg.optJSONObject("payload") ?: return)
            "chat" -> handleChat(msg)
            "end" -> {
                val who = Identity.pretty(_state.value.remoteIdentity).ifEmpty { "the other user" }
                notify(CallNotice.Info("Call ended by $who"))
                finish(EndReason.REMOTE_ENDED)
            }
            "identity" -> {
                val id = (msg.opt("payload") as? String)?.take(64) ?: return
                _state.update { it.copy(remoteIdentity = id) }
                if (_state.value.connected) notify(CallNotice.Success("${Identity.pretty(id)} joined"))
            }
            "media_state" -> {
                val video = msg.optJSONObject("payload")?.optBoolean("video", false) ?: false
                _state.update { it.copy(remoteVideoEnabled = video) }
            }
            "request_join" -> {
                if (_state.value.isInitiator) {
                    val name = (msg.opt("payload") as? String)?.take(64)?.ifEmpty { null } ?: "Someone"
                    _state.update { it.copy(incomingKnock = name) }
                }
            }
            "join_accept" -> {
                if (!_state.value.isInitiator && !mediaStarted) {
                    _state.update { it.copy(phase = Phase.WAITING) }
                    if (startMedia()) send(JSONObject().put("type", "join"))
                }
            }
            "join_reject" -> {
                notify(CallNotice.Warn("Your request to join was rejected."))
                finish(EndReason.REJECTED)
            }
        }
    }

    private suspend fun makeOffer() {
        role = SdpRole.OFFERER
        val pair = EcdhKeyPair.generate().also { ecdh = it }
        val offer = pc.awaitCreateOffer()
        pc.awaitSetLocal(offer)
        send(sdpMessage("offer", offer, pair))
    }

    private suspend fun handleOffer(msg: JSONObject) {
        _state.update { it.copy(peerJoined = true) }
        role = SdpRole.ANSWERER
        // Fresh key pair for every offer (incl. ICE-restart re-offers), like
        // the web client; the SAS is recomputed and re-verification required.
        val pair = EcdhKeyPair.generate().also { ecdh = it }
        val sdp = msg.optJSONObject("payload")?.optString("sdp")?.takeIf { it.isNotEmpty() } ?: return
        pc.awaitSetRemote(SessionDescription(SessionDescription.Type.OFFER, sdp))
        flushCandidates()
        val answer = pc.awaitCreateAnswer()
        pc.awaitSetLocal(answer)
        deriveKeys(msg.optString("ecdhPublicKey"))
        send(sdpMessage("answer", answer, pair))
    }

    private suspend fun handleAnswer(msg: JSONObject) {
        val sdp = msg.optJSONObject("payload")?.optString("sdp")?.takeIf { it.isNotEmpty() } ?: return
        pc.awaitSetRemote(SessionDescription(SessionDescription.Type.ANSWER, sdp))
        deriveKeys(msg.optString("ecdhPublicKey"))
        flushCandidates()
    }

    private fun handleCandidate(payload: JSONObject) {
        // org.json's optString() turns JSON null into "null"; guard explicitly.
        val mid = if (payload.isNull("sdpMid")) "0" else payload.optString("sdpMid").ifEmpty { "0" }
        val candidate = IceCandidate(
            mid,
            payload.optInt("sdpMLineIndex", 0),
            payload.optString("candidate"),
        )
        if (candidate.sdp.isEmpty()) return // end-of-candidates marker
        if (pc.remoteDescription != null) pc.addIceCandidate(candidate) else pendingCandidates.add(candidate)
    }

    private fun flushCandidates() {
        pendingCandidates.forEach { pc.addIceCandidate(it) }
        pendingCandidates.clear()
    }

    private fun sdpMessage(type: String, sdp: SessionDescription, pair: EcdhKeyPair) =
        JSONObject()
            .put("type", type)
            .put("payload", JSONObject().put("type", type).put("sdp", sdp.description))
            .put("ecdhPublicKey", pair.publicBase64)
            // The extra media script-transform layer is web-only and switched
            // off there too, so we negotiate DTLS-SRTP (still end-to-end).
            .put("e2eeSupported", false)
            .put("audioE2EESupported", false)

    private fun deriveKeys(peerPublicBase64: String) {
        val pair = ecdh ?: return
        val myRole = role ?: return
        val derived = try {
            CallKeys.derive(pair, peerPublicBase64, myRole)
        } catch (e: Exception) {
            Log.w(TAG, "key derivation failed", e)
            return
        }
        keys = derived
        _state.update {
            it.copy(
                safetyCode = derived.safetyCode,
                // A new code is a new trust decision.
                sasVerification = if (it.safetyCode == derived.safetyCode) it.sasVerification else SasVerification.PENDING,
                security = SecurityState.DTLS_SRTP,
            )
        }
        val queued = chatQueue.toList()
        chatQueue.clear()
        queued.forEach { sealAndSend(derived, it) }
    }

    private suspend fun tryIceRestart() {
        if (iceRestartInFlight || role != SdpRole.OFFERER || cleanedUp) return
        val pair = ecdh ?: return
        iceRestartInFlight = true
        notify(CallNotice.Warn("Reconnecting…"))
        try {
            pc.restartIce()
            val offer = pc.awaitCreateOffer()
            pc.awaitSetLocal(offer)
            send(sdpMessage("offer", offer, pair))
        } catch (e: Exception) {
            Log.w(TAG, "ICE restart failed", e)
        } finally {
            iceRestartInFlight = false
        }
    }

    // ---------------------------------------------------------------- chat

    private fun sealAndSend(k: CallKeys, text: String) {
        val sealed = k.chat.seal(text)
        send(
            JSONObject()
                .put("type", "chat")
                .put("enc", true)
                .put("iv", sealed.ivBase64)
                .put("payload", sealed.payloadBase64)
        )
    }

    private fun handleChat(msg: JSONObject) {
        // STRICT: only encrypted chat is accepted; anything else may be a
        // forgery injected by someone who knows the protocol shape.
        val iv = msg.opt("iv")
        val payload = msg.opt("payload")
        if (msg.opt("enc") != true || iv !is String || payload !is String) return
        val text = keys?.chat?.open(iv, payload) ?: return
        appendChat(fromMe = false, text = text)
        if (!chatOpen) notify(CallNotice.Info("New message: " + text.take(60)))
    }

    private fun appendChat(fromMe: Boolean, text: String) {
        val m = ChatMessage(chatNextId++, fromMe, text, System.currentTimeMillis())
        _state.update {
            it.copy(chat = it.chat + m, unreadChat = if (!fromMe && !chatOpen) it.unreadChat + 1 else it.unreadChat)
        }
    }

    // ---------------------------------------------------------------- media

    private fun granted(permission: String) =
        app.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    /** Acquire local media with the same graceful degradation as the web
     *  client: no camera → audio only; no mic → video only; neither → fail. */
    private suspend fun startMedia(): Boolean {
        if (mediaStarted) return true
        mediaStarted = true
        val st = _state.value
        val hasMic = granted(Manifest.permission.RECORD_AUDIO)
        val wantVideo = !st.audioOnly
        val hasCamera = wantVideo && granted(Manifest.permission.CAMERA)

        if (hasMic) {
            val src = factory.createAudioSource(MediaConstraints())
            audioSource = src
            audioTrack = factory.createAudioTrack("alfajer-audio", src).also {
                pc.addTrack(it, listOf(STREAM_ID))
            }
        }
        var videoOk = false
        if (hasCamera) {
            videoOk = withContext(Dispatchers.Main) { createVideo() }
            videoTrack?.let { pc.addTrack(it, listOf(STREAM_ID)) }
        }

        if (!hasMic && !videoOk) {
            notify(CallNotice.Error("Could not access camera/microphone. Check app permissions."))
            finish(EndReason.MEDIA_FAILED)
            return false
        }
        if (wantVideo && !videoOk) notify(CallNotice.Warn("Camera unavailable — joining with audio only."))
        if (!hasMic) notify(CallNotice.Warn("Microphone unavailable — the other person won't hear you."))

        // Video calls default to the loudspeaker, voice calls to the earpiece.
        audioRouter.start(speaker = videoOk)
        _state.update {
            it.copy(
                hasLocalAudio = hasMic,
                hasLocalVideo = videoOk,
                cameraOff = !videoOk,
                speakerOn = videoOk,
            )
        }
        CallService.start(app, withMic = hasMic, withCamera = videoOk)
        return true
    }

    private fun createVideo(): Boolean {
        val enumerator: CameraEnumerator =
            if (Camera2Enumerator.isSupported(app)) Camera2Enumerator(app) else Camera1Enumerator(true)
        val names = enumerator.deviceNames
        val name = names.firstOrNull { enumerator.isFrontFacing(it) } ?: names.firstOrNull() ?: return false
        val cap = enumerator.createCapturer(name, null) ?: return false
        val helper = SurfaceTextureHelper.create("AlfajerCapture", RtcEngine.eglBase.eglBaseContext)
        val source = factory.createVideoSource(false)
        cap.initialize(helper, app, source.capturerObserver)
        capturer = cap
        captureHelper = helper
        videoSource = source
        startCapture()
        val track = factory.createVideoTrack("alfajer-video", source)
        videoTrack = track
        _localVideo.value = track
        _state.update { it.copy(frontCamera = enumerator.isFrontFacing(name), canSwitchCamera = names.size > 1) }
        return true
    }

    private fun startCapture() {
        if (capturing) return
        capturer?.startCapture(1280, 720, 30)
        capturing = true
    }

    private fun stopCapture() {
        if (!capturing) return
        try {
            capturer?.stopCapture()
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
        capturing = false
    }

    private fun sendVideoState() {
        val st = _state.value
        send(JSONObject().put("type", "media_state").put("payload", JSONObject().put("video", st.hasLocalVideo && !st.cameraOff)))
    }

    // ---------------------------------------------------------------- connection

    private fun onPeerConnectionState(s: PeerConnection.PeerConnectionState) {
        if (cleanedUp) return
        when (s) {
            PeerConnection.PeerConnectionState.CONNECTED -> {
                val wasConnected = _state.value.connected
                _state.update {
                    it.copy(phase = Phase.CONNECTED, connectedAtMillis = it.connectedAtMillis ?: System.currentTimeMillis())
                }
                if (!wasConnected) {
                    send(JSONObject().put("type", "identity").put("payload", _state.value.identity))
                    // Tell the peer our initial camera state so their avatar
                    // overlay is right from the first frame.
                    sendVideoState()
                    startMonitor()
                    _state.value.remoteIdentity?.let { notify(CallNotice.Success("${Identity.pretty(it)} joined")) }
                }
            }
            PeerConnection.PeerConnectionState.DISCONNECTED ->
                _state.update { it.copy(quality = Quality(QualityKind.RECONNECTING)) }
            PeerConnection.PeerConnectionState.FAILED ->
                _state.update { it.copy(quality = Quality(QualityKind.FAILED)) }
            else -> Unit
        }
    }

    private fun startMonitor() {
        monitorJob?.cancel()
        monitorJob = scope.launch {
            while (isActive && !cleanedUp) {
                try {
                    applyStats(pc.awaitStats())
                } catch (e: Exception) {
                    Log.w(TAG, "stats failed", e)
                }
                delay(STATS_INTERVAL_MS)
            }
        }
    }

    private fun applyStats(report: RTCStatsReport) {
        val stats = report.statsMap
        var localLevel = 0.0
        var remoteLevel = 0.0
        var lossPct: Double? = null
        var pairId: String? = null
        for (s in stats.values) {
            val m = s.members
            when (s.type) {
                "transport" -> (m["selectedCandidatePairId"] as? String)?.let { pairId = it }
                "media-source" -> if (m["kind"] == "audio") localLevel = (m["audioLevel"] as? Number)?.toDouble() ?: 0.0
                "inbound-rtp" -> when (m["kind"]) {
                    "audio" -> remoteLevel = (m["audioLevel"] as? Number)?.toDouble() ?: 0.0
                    "video" -> {
                        val lost = (m["packetsLost"] as? Number)?.toDouble() ?: 0.0
                        val recv = (m["packetsReceived"] as? Number)?.toDouble() ?: 0.0
                        if (lost + recv > 0) lossPct = Math.round(lost / (lost + recv) * 1000) / 10.0
                    }
                }
            }
        }
        val pair = pairId?.let { stats[it] }
            ?: stats.values.firstOrNull { it.type == "candidate-pair" && it.members["nominated"] == true && it.members["state"] == "succeeded" }
        val local = (pair?.members?.get("localCandidateId") as? String)?.let { stats[it] }
        val rttMs = (pair?.members?.get("currentRoundTripTime") as? Number)?.let { Math.round(it.toDouble() * 1000).toInt() }

        val quality = when (pc.iceConnectionState()) {
            PeerConnection.IceConnectionState.FAILED -> Quality(QualityKind.FAILED)
            PeerConnection.IceConnectionState.DISCONNECTED -> Quality(QualityKind.RECONNECTING)
            PeerConnection.IceConnectionState.NEW, PeerConnection.IceConnectionState.CHECKING ->
                Quality(if (iceRestartInFlight) QualityKind.RECONNECTING else QualityKind.CONNECTING)
            else -> Quality(
                if (local?.members?.get("candidateType") == "relay") QualityKind.RELAY else QualityKind.DIRECT,
                rttMs,
                lossPct,
            )
        }
        val st = _state.value
        _state.update {
            it.copy(
                quality = quality,
                localSpeaking = !st.muted && localLevel > SPEAKING_LEVEL,
                remoteSpeaking = remoteLevel > SPEAKING_LEVEL,
            )
        }
    }

    // ---------------------------------------------------------------- teardown

    private fun onSocketClosed(code: Int) {
        if (cleanedUp) return
        if (code == 1008) {
            notify(CallNotice.Error("Room is full — calls are 1-to-1 and this one is sealed."))
            finish(EndReason.ROOM_FULL)
        } else {
            val who = Identity.pretty(_state.value.remoteIdentity).ifEmpty { "the other user" }
            notify(CallNotice.Info("Call ended by $who"))
            finish(EndReason.REMOTE_ENDED)
        }
    }

    private fun finish(reason: EndReason) {
        if (cleanedUp) return
        cleanedUp = true
        monitorJob?.cancel()
        // Drop anything never encrypted — it never left the device.
        chatQueue.clear()
        keys = null
        ecdh = null
        _localVideo.value = null
        _remoteVideo.value = null
        signaling.close()
        inbox.close()
        stopCapture()
        try {
            pc.dispose()
        } catch (e: Exception) {
            Log.w(TAG, "pc dispose failed", e)
        }
        capturer?.dispose()
        captureHelper?.dispose()
        videoTrack?.dispose()
        audioTrack?.dispose()
        videoSource?.dispose()
        audioSource?.dispose()
        capturer = null
        captureHelper = null
        videoSource = null
        audioSource = null
        videoTrack = null
        audioTrack = null
        if (mediaStarted) audioRouter.stop()
        CallService.stop(app)
        _state.update { it.copy(phase = Phase.ENDED, endReason = reason, incomingKnock = null) }
        CallSession.onEnded(this)
        scope.cancel()
    }

    private fun notify(n: CallNotice) {
        CallSession.notices.tryEmit(n)
    }

    companion object {
        private const val TAG = "AlfajerCall"
        private const val STREAM_ID = "alfajer"
        private const val STATS_INTERVAL_MS = 500L
        private const val SPEAKING_LEVEL = 0.04

        private val http: OkHttpClient by lazy {
            OkHttpClient.Builder()
                .pingInterval(20, TimeUnit.SECONDS)
                .readTimeout(0, TimeUnit.MILLISECONDS)
                .build()
        }

        suspend fun create(
            context: Context,
            roomId: String,
            identity: String,
            isInitiator: Boolean,
            audioOnly: Boolean,
        ): CallManager {
            val iceServers = withContext(Dispatchers.IO) { fetchIceServers(identity) }
            return CallManager(context, roomId, identity, isInitiator, audioOnly, iceServers, http).also { it.begin() }
        }

        /** STUN plus short-lived HMAC TURN credentials from the signaling
         *  server. TURN failure is non-fatal, exactly like the web client. */
        private fun fetchIceServers(identity: String): List<PeerConnection.IceServer> {
            val servers = mutableListOf(PeerConnection.IceServer.builder(Config.STUN_URL).createIceServer())
            val turnUrls = Config.turnUrls
            if (turnUrls.isEmpty()) return servers
            try {
                val url = "${Config.SIGNALING_URL}/turn-credentials".toHttpUrl().newBuilder()
                    .addQueryParameter("username", identity)
                    .build()
                http.newCall(Request.Builder().url(url).build()).execute().use { res ->
                    if (!res.isSuccessful) {
                        Log.w(TAG, "TURN credential fetch failed: ${res.code}")
                        return servers
                    }
                    val json = JSONObject(res.body?.string().orEmpty())
                    servers += PeerConnection.IceServer.builder(turnUrls)
                        .setUsername(json.getString("username"))
                        .setPassword(json.getString("credential"))
                        .createIceServer()
                }
            } catch (e: Exception) {
                Log.w(TAG, "TURN credential fetch error; continuing without TURN", e)
            }
            return servers
        }
    }
}
