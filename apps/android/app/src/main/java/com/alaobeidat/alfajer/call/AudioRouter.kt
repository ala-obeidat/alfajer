package com.alaobeidat.alfajer.call

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build

/** Puts the device in voice-call audio mode and switches between the
 *  earpiece and the loudspeaker. */
class AudioRouter(context: Context) {
    private val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private var focus: AudioFocusRequest? = null
    private var previousMode = AudioManager.MODE_NORMAL

    fun start(speaker: Boolean) {
        previousMode = am.mode
        val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            )
            .build()
        am.requestAudioFocus(req)
        focus = req
        am.mode = AudioManager.MODE_IN_COMMUNICATION
        setSpeaker(speaker)
    }

    /** Returns whether the loudspeaker is now in use. */
    fun setSpeaker(on: Boolean): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val wanted = if (on) AudioDeviceInfo.TYPE_BUILTIN_SPEAKER else AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
            val device = am.availableCommunicationDevices.firstOrNull { it.type == wanted }
            if (device != null) {
                am.setCommunicationDevice(device)
            } else if (!on) {
                am.clearCommunicationDevice() // no earpiece (tablet): system default
            }
            return am.communicationDevice?.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
        }
        @Suppress("DEPRECATION")
        am.isSpeakerphoneOn = on
        @Suppress("DEPRECATION")
        return am.isSpeakerphoneOn
    }

    fun stop() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            am.clearCommunicationDevice()
        } else {
            @Suppress("DEPRECATION")
            am.isSpeakerphoneOn = false
        }
        am.mode = previousMode
        focus?.let(am::abandonAudioFocusRequest)
        focus = null
    }
}
