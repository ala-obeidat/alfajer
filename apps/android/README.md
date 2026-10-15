# Alfajer for Android

Native Android client for Alfajer: Kotlin, Jetpack Compose, and Google's
libwebrtc (via [`io.getstream:stream-webrtc-android`](https://github.com/GetStream/webrtc-android)).
It uses the same signaling server, TURN relay and wire protocol as the web app,
so **an Android user can call a browser user and vice versa**.

## Layout

| Path | What it is |
|---|---|
| `core/` | Pure-Kotlin/JVM module: ECDH P-256, HKDF-SHA-256, AES-256-GCM chat, the 5-digit SAS, room codes and identities. Unit-tested against a vector produced by the browser's WebCrypto (`core/src/test/resources/webcrypto-vector.json`). |
| `app/…/call/` | Call engine. `CallManager` is the port of `apps/web/src/lib/webrtc.ts` plus the call page logic: knock → accept → offer/answer → ICE, ICE restart, chat, SAS, quality/speaking stats. `SignalingClient` (OkHttp WebSocket), `AudioRouter` (earpiece/speaker), `CallService` (foreground service so the call survives in the background). |
| `app/…/ui/` | Compose UI: home screen (nickname, start/join, voice-only) and the call screen (remote video or avatar, draggable self-view, quality + security pills, SAS verification, knock dialog, encrypted chat sheet, invite sharing). |

## Feature parity with the web app

| Web feature | Android |
|---|---|
| 9-digit room codes, knock + accept, sealed 1-to-1 rooms | ✓ same protocol |
| DTLS-SRTP media, ECDH/HKDF AES-GCM chat, SAS verification | ✓ byte-compatible (tested against WebCrypto) |
| Voice-only calls, camera-off avatar via `media_state` | ✓ |
| Flip camera, mute, camera on/off | ✓ (camera is released while off, so the privacy LED goes dark) |
| Speaker selection | Earpiece ↔ loudspeaker toggle |
| Connection-quality pill, speaking indicator, auto ICE restart | ✓ from `getStats()` |
| Share code / link / WhatsApp | ✓ Android share sheet; `https://<web host>/call/<code>` and `alfajer://call/<code>` open the app |
| PWA install, theme toggle | N/A — native app; follows the system light/dark theme |
| Screen sharing | Not yet (web only offers it on desktop) |
| Extra media script-transform E2EE layer | Off, same as the web app (`E2EE_TRANSFORM_ENABLED = false`) |

Android extras: the call keeps running in the background with an ongoing
notification (with an *End call* action), the screen stays awake during a call,
and `FLAG_SECURE` keeps call video and room codes out of screenshots and the
recent-apps thumbnail. Nothing is stored except the last nickname and the
voice-only preference; a fresh identity and key pair are made for every call.

## Build

Requirements: JDK 17 and the Android SDK (Android Studio Ladybug or newer
works out of the box).

```bash
cd apps/android
./gradlew :core:test            # crypto/interop tests (JVM only, no SDK needed)
./gradlew :app:assembleDebug    # app/build/outputs/apk/debug/app-debug.apk
./gradlew :app:installDebug     # install on a connected device
```

CI (`.github/workflows/android.yml`) runs the tests, builds the debug APK and
runs lint, and uploads the APK as a workflow artifact.

### Pointing at another deployment

Endpoints are baked into `BuildConfig` from `gradle.properties`:

```bash
# local signaling server from the emulator, no TURN:
./gradlew :app:installDebug -Palfajer.signalingUrl=http://10.0.2.2:3000 -Palfajer.turnUrls=
```

Debug builds allow cleartext `ws://`; release builds don't.

The signaling server accepts the app without config changes: its WebSocket
Origin allowlist only applies to browsers, and native clients send no
`Origin` header.

### Verified app links (optional)

To make invite links open the app without a chooser, publish
`https://<web host>/.well-known/assetlinks.json` with the SHA-256 fingerprint
of your release signing certificate:

```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "com.alaobeidat.alfajer",
    "sha256_cert_fingerprints": ["<your release cert SHA-256>"]
  }
}]
```

Without it, links still offer the app in the "Open with" chooser.

### Release signing

Release builds are minified but unsigned by default; configure a
`signingConfig` (keystore kept out of git — `*.jks`/`*.keystore` are ignored)
before publishing.
