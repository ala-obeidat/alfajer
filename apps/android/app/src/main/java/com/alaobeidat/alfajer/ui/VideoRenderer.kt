package com.alaobeidat.alfajer.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import com.alaobeidat.alfajer.call.RtcEngine
import org.webrtc.RendererCommon
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoTrack

/** Renders a WebRTC video track. [onTop] puts the surface above other video
 *  surfaces (for the self-view PiP). */
@Composable
fun VideoRenderer(
    track: VideoTrack,
    modifier: Modifier = Modifier,
    mirror: Boolean = false,
    onTop: Boolean = false,
    fill: Boolean = true,
) {
    val context = LocalContext.current
    val renderer = remember {
        SurfaceViewRenderer(context).apply {
            init(RtcEngine.eglBase.eglBaseContext, null)
            setEnableHardwareScaler(true)
            if (onTop) setZOrderMediaOverlay(true)
        }
    }
    DisposableEffect(renderer) {
        onDispose { renderer.release() }
    }
    DisposableEffect(track, renderer) {
        try {
            track.addSink(renderer)
        } catch (_: IllegalStateException) {
            // Track already disposed (call ended this frame).
        }
        onDispose {
            try {
                track.removeSink(renderer)
            } catch (_: IllegalStateException) {
            }
        }
    }
    AndroidView(
        factory = { renderer },
        modifier = modifier,
        update = {
            it.setMirror(mirror)
            it.setScalingType(
                if (fill) RendererCommon.ScalingType.SCALE_ASPECT_FILL else RendererCommon.ScalingType.SCALE_ASPECT_FIT
            )
        },
    )
}
