package com.alaobeidat.alfajer.call

enum class Phase {
    /** Joiner: WebSocket open, knock sent, waiting for the host. */
    REQUESTING,

    /** Media is live; waiting for the other peer to arrive / connect. */
    WAITING,

    CONNECTED,
    ENDED,
}

enum class QualityKind { CONNECTING, DIRECT, RELAY, RECONNECTING, FAILED }

data class Quality(val kind: QualityKind, val rttMs: Int? = null, val lossPct: Double? = null)

/** Mirrors the web client's SecurityState. The extra script-transform media
 *  layer is disabled on the web too, so a live call settles on DTLS-SRTP. */
enum class SecurityState { CONNECTING, DTLS_SRTP }

enum class SasVerification { PENDING, VERIFIED, MISMATCH }

enum class EndReason { HANGUP, REMOTE_ENDED, ROOM_FULL, REJECTED, MEDIA_FAILED }

data class ChatMessage(val id: Long, val fromMe: Boolean, val text: String, val at: Long)

data class CallState(
    val roomId: String,
    val identity: String,
    val isInitiator: Boolean,
    val audioOnly: Boolean,
    val phase: Phase,
    val peerJoined: Boolean = false,
    val connectedAtMillis: Long? = null,
    val remoteIdentity: String? = null,
    val remoteVideoEnabled: Boolean = true,
    val incomingKnock: String? = null,
    val muted: Boolean = false,
    val cameraOff: Boolean = false,
    val hasLocalVideo: Boolean = false,
    val hasLocalAudio: Boolean = false,
    val frontCamera: Boolean = true,
    val canSwitchCamera: Boolean = false,
    val speakerOn: Boolean = false,
    val quality: Quality = Quality(QualityKind.CONNECTING),
    val security: SecurityState = SecurityState.CONNECTING,
    val safetyCode: String? = null,
    val sasVerification: SasVerification = SasVerification.PENDING,
    val chat: List<ChatMessage> = emptyList(),
    val unreadChat: Int = 0,
    val localSpeaking: Boolean = false,
    val remoteSpeaking: Boolean = false,
    val endReason: EndReason? = null,
) {
    val connected: Boolean get() = phase == Phase.CONNECTED
}

sealed interface CallNotice {
    val text: String

    data class Info(override val text: String) : CallNotice
    data class Success(override val text: String) : CallNotice
    data class Warn(override val text: String) : CallNotice
    data class Error(override val text: String) : CallNotice
}
