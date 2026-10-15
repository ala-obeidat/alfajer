package com.alaobeidat.alfajer

/** Deployment endpoints, injected at build time (see app/build.gradle.kts). */
object Config {
    val SIGNALING_URL: String = BuildConfig.SIGNALING_URL.trimEnd('/')
    val WEB_URL: String = BuildConfig.WEB_URL.trimEnd('/')
    const val STUN_URL = "stun:stun.l.google.com:19302"

    /** Comma-separated TURN URLs (UDP for latency + TURNS/TCP for strict
     *  networks); ICE picks the best working path. */
    val turnUrls: List<String> = BuildConfig.TURN_URLS.split(',').map { it.trim() }.filter { it.isNotEmpty() }

    fun signalingWsUrl(roomId: String): String =
        SIGNALING_URL.replaceFirst(Regex("^http(s?):"), "ws$1:") + "/call/" + roomId

    /** Link that opens the same room in a browser — or in this app, via the
     *  deep-link intent filter. */
    fun shareUrl(roomId: String): String = "$WEB_URL/call/$roomId"
}
