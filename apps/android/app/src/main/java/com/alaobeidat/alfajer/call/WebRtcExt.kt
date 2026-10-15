package com.alaobeidat.alfajer.call

import kotlinx.coroutines.suspendCancellableCoroutine
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.RTCStatsReport
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class SdpException(message: String?) : Exception(message)

private abstract class BaseSdpObserver : SdpObserver {
    override fun onCreateSuccess(sdp: SessionDescription?) {}
    override fun onSetSuccess() {}
    override fun onCreateFailure(error: String?) {}
    override fun onSetFailure(error: String?) {}
}

suspend fun PeerConnection.awaitCreateOffer(constraints: MediaConstraints = MediaConstraints()): SessionDescription =
    suspendCancellableCoroutine { cont ->
        createOffer(object : BaseSdpObserver() {
            override fun onCreateSuccess(sdp: SessionDescription?) {
                if (sdp != null) cont.resume(sdp) else cont.resumeWithException(SdpException("null offer"))
            }
            override fun onCreateFailure(error: String?) = cont.resumeWithException(SdpException(error))
        }, constraints)
    }

suspend fun PeerConnection.awaitCreateAnswer(constraints: MediaConstraints = MediaConstraints()): SessionDescription =
    suspendCancellableCoroutine { cont ->
        createAnswer(object : BaseSdpObserver() {
            override fun onCreateSuccess(sdp: SessionDescription?) {
                if (sdp != null) cont.resume(sdp) else cont.resumeWithException(SdpException("null answer"))
            }
            override fun onCreateFailure(error: String?) = cont.resumeWithException(SdpException(error))
        }, constraints)
    }

suspend fun PeerConnection.awaitSetLocal(sdp: SessionDescription): Unit =
    suspendCancellableCoroutine { cont ->
        setLocalDescription(object : BaseSdpObserver() {
            override fun onSetSuccess() = cont.resume(Unit)
            override fun onSetFailure(error: String?) = cont.resumeWithException(SdpException(error))
        }, sdp)
    }

suspend fun PeerConnection.awaitSetRemote(sdp: SessionDescription): Unit =
    suspendCancellableCoroutine { cont ->
        setRemoteDescription(object : BaseSdpObserver() {
            override fun onSetSuccess() = cont.resume(Unit)
            override fun onSetFailure(error: String?) = cont.resumeWithException(SdpException(error))
        }, sdp)
    }

suspend fun PeerConnection.awaitStats(): RTCStatsReport =
    suspendCancellableCoroutine { cont -> getStats { report -> cont.resume(report) } }
