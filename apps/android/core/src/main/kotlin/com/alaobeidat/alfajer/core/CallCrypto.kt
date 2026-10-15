package com.alaobeidat.alfajer.core

import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Wire-compatible port of the web client's call crypto
 * (apps/web/src/lib/webrtc.ts). Every byte layout here must match what the
 * browser's WebCrypto produces, or a native peer can't talk to a web peer:
 *
 *   - ECDH over P-256; public keys travel as the base64 of the 65-byte
 *     uncompressed point (WebCrypto `exportKey('raw')`).
 *   - HKDF-SHA-256, empty salt, info = UTF-8 label, 32-byte output.
 *   - Chat: AES-256-GCM, random 12-byte IV, ciphertext ‖ 16-byte tag.
 *   - SAS: SHA-256(offererPub ‖ answererPub), first 4 bytes big-endian
 *     uint32 mod 100000, zero-padded to 5 digits.
 */
enum class SdpRole(val label: String) {
    OFFERER("offerer"),
    ANSWERER("answerer");

    val peer: SdpRole get() = if (this == OFFERER) ANSWERER else OFFERER
}

class EcdhKeyPair private constructor(private val keyPair: KeyPair) {

    /** 65-byte uncompressed point: 0x04 ‖ X(32) ‖ Y(32). */
    val publicRaw: ByteArray = encodePoint(keyPair.public as ECPublicKey)

    val publicBase64: String get() = Base64.getEncoder().encodeToString(publicRaw)

    /** Raw 32-byte ECDH shared secret with the peer's raw public key. */
    fun agree(peerPublicRaw: ByteArray): ByteArray {
        val peerKey = decodePoint(peerPublicRaw)
        val ka = KeyAgreement.getInstance("ECDH")
        ka.init(keyPair.private)
        ka.doPhase(peerKey, true)
        return ka.generateSecret()
    }

    companion object {
        private const val COORD_LEN = 32

        private val P256: ECParameterSpec by lazy {
            val params = AlgorithmParameters.getInstance("EC")
            params.init(ECGenParameterSpec("secp256r1"))
            params.getParameterSpec(ECParameterSpec::class.java)
        }

        fun generate(random: SecureRandom = SecureRandom()): EcdhKeyPair {
            val gen = KeyPairGenerator.getInstance("EC")
            gen.initialize(ECGenParameterSpec("secp256r1"), random)
            return EcdhKeyPair(gen.generateKeyPair())
        }

        /** Test hook: rebuild a key pair from a known private scalar. */
        internal fun fromPrivateScalar(d: ByteArray, publicRaw: ByteArray): EcdhKeyPair {
            val priv = KeyFactory.getInstance("EC")
                .generatePrivate(java.security.spec.ECPrivateKeySpec(BigInteger(1, d), P256))
            return EcdhKeyPair(KeyPair(decodePoint(publicRaw), priv))
        }

        fun encodePoint(key: ECPublicKey): ByteArray {
            val out = ByteArray(1 + 2 * COORD_LEN)
            out[0] = 0x04
            writeCoord(key.w.affineX, out, 1)
            writeCoord(key.w.affineY, out, 1 + COORD_LEN)
            return out
        }

        fun decodePoint(raw: ByteArray): ECPublicKey {
            require(raw.size == 1 + 2 * COORD_LEN && raw[0] == 0x04.toByte()) {
                "Expected a 65-byte uncompressed P-256 point"
            }
            val x = BigInteger(1, raw.copyOfRange(1, 1 + COORD_LEN))
            val y = BigInteger(1, raw.copyOfRange(1 + COORD_LEN, raw.size))
            val spec = ECPublicKeySpec(ECPoint(x, y), P256)
            return KeyFactory.getInstance("EC").generatePublic(spec) as ECPublicKey
        }

        private fun writeCoord(v: BigInteger, out: ByteArray, offset: Int) {
            val bytes = v.toByteArray() // may carry a leading sign byte or be short
            val src = if (bytes.size > COORD_LEN) bytes.copyOfRange(bytes.size - COORD_LEN, bytes.size) else bytes
            System.arraycopy(src, 0, out, offset + COORD_LEN - src.size, src.size)
        }
    }
}

object Hkdf {
    /** RFC 5869 HKDF-SHA-256. An empty salt is equivalent to HashLen zero
     *  bytes (HMAC zero-pads the key), which is what WebCrypto does. */
    fun sha256(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        val hashLen = 32
        require(length in 1..255 * hashLen)
        val saltKey = if (salt.isEmpty()) ByteArray(hashLen) else salt
        val prk = hmac(saltKey, ikm)
        val out = ByteArray(length)
        var t = ByteArray(0)
        var pos = 0
        var counter = 1
        while (pos < length) {
            t = hmac(prk, t + info + byteArrayOf(counter.toByte()))
            val n = minOf(t.size, length - pos)
            System.arraycopy(t, 0, out, pos, n)
            pos += n
            counter++
        }
        prk.fill(0)
        return out
    }

    private fun hmac(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(data)
    }
}

object Sas {
    /** 5-digit short authentication string; identical on both peers unless
     *  someone in the signaling path swapped public keys. */
    fun compute(offererPublicRaw: ByteArray, answererPublicRaw: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(offererPublicRaw + answererPublicRaw)
        val v = ((digest[0].toLong() and 0xff) shl 24) or
            ((digest[1].toLong() and 0xff) shl 16) or
            ((digest[2].toLong() and 0xff) shl 8) or
            (digest[3].toLong() and 0xff)
        return (v % 100_000).toString().padStart(5, '0')
    }
}

/** AES-256-GCM chat cipher keyed by HKDF('alfajer-v1-chat'). */
class ChatCipher(key: ByteArray, private val random: SecureRandom = SecureRandom()) {
    private val keySpec = SecretKeySpec(key.copyOf(), "AES")

    init {
        require(key.size == 32)
    }

    data class Sealed(val ivBase64: String, val payloadBase64: String)

    fun seal(plaintext: String): Sealed {
        val iv = ByteArray(IV_LEN).also(random::nextBytes)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, keySpec, GCMParameterSpec(TAG_BITS, iv))
        val ct = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        val b64 = Base64.getEncoder()
        return Sealed(b64.encodeToString(iv), b64.encodeToString(ct))
    }

    /** Returns null on any failure (bad base64, wrong key, tampering) —
     *  forged frames are dropped silently, like the web client does. */
    fun open(ivBase64: String, payloadBase64: String): String? = try {
        val dec = Base64.getDecoder()
        val iv = dec.decode(ivBase64)
        if (iv.size != IV_LEN) null else {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, keySpec, GCMParameterSpec(TAG_BITS, iv))
            String(cipher.doFinal(dec.decode(payloadBase64)), Charsets.UTF_8)
        }
    } catch (_: Exception) {
        null
    }

    companion object {
        private const val IV_LEN = 12
        private const val TAG_BITS = 128
    }
}

/** Everything a call derives once both ECDH public keys are known. */
class CallKeys(val safetyCode: String, val chat: ChatCipher) {
    companion object {
        const val CHAT_LABEL = "alfajer-v1-chat"

        fun derive(mine: EcdhKeyPair, peerPublicBase64: String, myRole: SdpRole): CallKeys {
            val peerRaw = Base64.getDecoder().decode(peerPublicBase64)
            val (first, second) =
                if (myRole == SdpRole.OFFERER) mine.publicRaw to peerRaw else peerRaw to mine.publicRaw
            val sas = Sas.compute(first, second)
            val shared = mine.agree(peerRaw)
            try {
                val chatKey = Hkdf.sha256(shared, ByteArray(0), CHAT_LABEL.toByteArray(), 32)
                val cipher = ChatCipher(chatKey)
                chatKey.fill(0)
                return CallKeys(sas, cipher)
            } finally {
                shared.fill(0)
            }
        }
    }
}
