package com.alaobeidat.alfajer

import android.content.Context

/** Cross-session preferences (the web client keeps these in localStorage).
 *  Call identities are NOT persisted: a fresh one is minted per call. */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("alfajer.prefs", Context.MODE_PRIVATE)

    var nickname: String
        get() = sp.getString(KEY_NICKNAME, "").orEmpty()
        set(v) = sp.edit().putString(KEY_NICKNAME, v).apply()

    var audioOnly: Boolean
        get() = sp.getBoolean(KEY_AUDIO_ONLY, false)
        set(v) = sp.edit().putBoolean(KEY_AUDIO_ONLY, v).apply()

    private companion object {
        const val KEY_NICKNAME = "nickname"
        const val KEY_AUDIO_ONLY = "audioOnly"
    }
}
