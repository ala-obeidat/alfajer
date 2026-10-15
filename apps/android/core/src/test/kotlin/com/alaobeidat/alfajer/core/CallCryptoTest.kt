package com.alaobeidat.alfajer.core

import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Interop tests against a vector produced by real WebCrypto running the same
 * calls as apps/web/src/lib/webrtc.ts. If these pass, an Android peer and a
 * browser peer agree on the SAS and can read each other's chat.
 */
class CallCryptoTest {
    private val vector: Map<String, String> = run {
        val json = javaClass.classLoader!!.getResource("webcrypto-vector.json")!!.readText()
        Regex("\"(\\w+)\":\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").findAll(json)
            .associate { it.groupValues[1] to it.groupValues[2] }
    }
    private val b64 = Base64.getDecoder()

    private fun pair(prefix: String) = EcdhKeyPair.fromPrivateScalar(
        b64.decode(vector["${prefix}Private"]), b64.decode(vector["${prefix}Public"])
    )

    @Test
    fun `public key encodes to the same raw bytes WebCrypto exports`() {
        assertEquals(vector["offererPublic"], pair("offerer").publicBase64)
        assertEquals(vector["answererPublic"], pair("answerer").publicBase64)
    }

    @Test
    fun `both roles compute the browser's safety code`() {
        val asOfferer = CallKeys.derive(pair("offerer"), vector["answererPublic"]!!, SdpRole.OFFERER)
        val asAnswerer = CallKeys.derive(pair("answerer"), vector["offererPublic"]!!, SdpRole.ANSWERER)
        assertEquals(vector["sas"], asOfferer.safetyCode)
        assertEquals(vector["sas"], asAnswerer.safetyCode)
    }

    @Test
    fun `decrypts chat sealed by the web client`() {
        val keys = CallKeys.derive(pair("answerer"), vector["offererPublic"]!!, SdpRole.ANSWERER)
        assertEquals(vector["chatText"], keys.chat.open(vector["chatIv"]!!, vector["chatPayload"]!!))
    }

    @Test
    fun `rejects tampered or malformed chat`() {
        val keys = CallKeys.derive(pair("answerer"), vector["offererPublic"]!!, SdpRole.ANSWERER)
        val ct = b64.decode(vector["chatPayload"]).also { it[0] = (it[0].toInt() xor 1).toByte() }
        assertNull(keys.chat.open(vector["chatIv"]!!, Base64.getEncoder().encodeToString(ct)))
        assertNull(keys.chat.open("not base64!", vector["chatPayload"]!!))
        assertNull(keys.chat.open(Base64.getEncoder().encodeToString(ByteArray(8)), vector["chatPayload"]!!))
    }

    @Test
    fun `fresh key pairs round-trip chat and agree on SAS`() {
        val a = EcdhKeyPair.generate()
        val b = EcdhKeyPair.generate()
        assertEquals(65, a.publicRaw.size)
        val ka = CallKeys.derive(a, b.publicBase64, SdpRole.OFFERER)
        val kb = CallKeys.derive(b, a.publicBase64, SdpRole.ANSWERER)
        assertEquals(ka.safetyCode, kb.safetyCode)
        val sealed = ka.chat.seal("hi")
        assertEquals("hi", kb.chat.open(sealed.ivBase64, sealed.payloadBase64))
        assertNotEquals(sealed.ivBase64, ka.chat.seal("hi").ivBase64)
    }

    @Test
    fun `HKDF matches RFC 5869 test case 3 (empty salt and info)`() {
        val ikm = ByteArray(22) { 0x0b }
        val okm = Hkdf.sha256(ikm, ByteArray(0), ByteArray(0), 42)
        assertEquals(
            "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8",
            okm.joinToString("") { "%02x".format(it) }
        )
    }

    @Test
    fun `room codes and identities match the web formats`() {
        repeat(200) {
            val code = RoomCode.generate()
            assertEquals(9, code.length)
            assertTrue(RoomCode.isValid(code))
        }
        assertTrue(RoomCode.isValid("123456"))
        assertTrue(!RoomCode.isValid("12345") && !RoomCode.isValid("1234567890") && !RoomCode.isValid("12a456"))
        assertEquals("123 456 789", RoomCode.grouped("123456789"))
        assertEquals("123456789", RoomCode.sanitize("123-456 7890"))
        val id = Identity.generate("Ala O.")
        assertTrue(Regex("^@alao-[0-9a-f]{4}$").matches(id), id)
        assertTrue(Identity.generate("علاء").startsWith("@gest-"))
        assertEquals("alao", Identity.pretty(id))
        assertEquals("A", Identity.initial(id))
    }
}
