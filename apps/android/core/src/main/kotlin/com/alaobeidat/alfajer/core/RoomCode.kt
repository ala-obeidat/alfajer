package com.alaobeidat.alfajer.core

import java.security.SecureRandom

object RoomCode {
    private val VALID = Regex("^\\d{6,9}$")

    /** 9-digit code in [100000000, 999999999], same distribution as the web
     *  client (two 32-bit CSPRNG words mod 9e8). */
    fun generate(random: SecureRandom = SecureRandom()): String {
        val hi = random.nextInt().toLong() and 0xffffffffL
        val lo = random.nextInt().toLong() and 0xffffffffL
        val big = java.math.BigInteger.valueOf(hi).shiftLeft(32).or(java.math.BigInteger.valueOf(lo))
        val r = big.mod(java.math.BigInteger.valueOf(900_000_000L)).toLong()
        return (100_000_000L + r).toString()
    }

    /** Accepts current 9-digit codes and legacy 6-digit ones. */
    fun isValid(code: String): Boolean = VALID.matches(code)

    fun sanitize(input: String): String = input.filter { it in '0'..'9' }.take(9)

    fun grouped(code: String): String = when (code.length) {
        9 -> "${code.substring(0, 3)} ${code.substring(3, 6)} ${code.substring(6)}"
        6 -> "${code.substring(0, 3)} ${code.substring(3)}"
        else -> code
    }
}

object Identity {
    /** "@<nick>-<4 hex>" — same shape as the web client's session identity. */
    fun generate(nickname: String?, random: SecureRandom = SecureRandom()): String {
        val bytes = ByteArray(2).also(random::nextBytes)
        val hex = bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }
        val safe = nickname.orEmpty().filter { it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' }
            .lowercase().ifEmpty { "gest" }
        return "@$safe-$hex"
    }

    /** "@ala-1f2e" -> "ala". */
    fun pretty(identity: String?): String {
        if (identity.isNullOrEmpty()) return ""
        val m = Regex("^@([^-]+)").find(identity)
        return m?.groupValues?.get(1) ?: identity
    }

    fun initial(identity: String?): String =
        Regex("^@(.)").find(identity.orEmpty())?.groupValues?.get(1)?.uppercase() ?: "?"
}
