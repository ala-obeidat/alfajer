package com.alaobeidat.alfajer.call

import android.content.Context
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.PeerConnectionFactory
import org.webrtc.audio.JavaAudioDeviceModule

/** Process-wide WebRTC singletons. The EGL context is shared by the
 *  encoder, decoder, camera capture and the on-screen renderers. */
object RtcEngine {
    val eglBase: EglBase by lazy { EglBase.create() }

    @Volatile private var factory: PeerConnectionFactory? = null

    fun factory(context: Context): PeerConnectionFactory {
        factory?.let { return it }
        synchronized(this) {
            factory?.let { return it }
            val app = context.applicationContext
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(app).createInitializationOptions()
            )
            // Hardware AEC/NS where the device has them; WebRTC's software
            // APM covers the rest. Same goal as the web client's
            // echoCancellation/noiseSuppression constraints: no echo when the
            // peer is on loudspeaker.
            val adm = JavaAudioDeviceModule.builder(app)
                .setUseHardwareAcousticEchoCanceler(true)
                .setUseHardwareNoiseSuppressor(true)
                .createAudioDeviceModule()
            val ctx = eglBase.eglBaseContext
            val f = PeerConnectionFactory.builder()
                .setAudioDeviceModule(adm)
                .setVideoEncoderFactory(DefaultVideoEncoderFactory(ctx, true, true))
                .setVideoDecoderFactory(DefaultVideoDecoderFactory(ctx))
                .createPeerConnectionFactory()
            adm.release() // the factory holds its own reference
            factory = f
            return f
        }
    }
}
