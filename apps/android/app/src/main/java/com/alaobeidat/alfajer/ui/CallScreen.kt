package com.alaobeidat.alfajer.ui

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material.icons.filled.Cameraswitch
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.PhoneInTalk
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.filled.VideocamOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.alaobeidat.alfajer.Config
import com.alaobeidat.alfajer.call.CallManager
import com.alaobeidat.alfajer.call.CallState
import com.alaobeidat.alfajer.call.Phase
import com.alaobeidat.alfajer.call.Quality
import com.alaobeidat.alfajer.call.QualityKind
import com.alaobeidat.alfajer.call.SasVerification
import com.alaobeidat.alfajer.call.SecurityState
import com.alaobeidat.alfajer.core.Identity
import com.alaobeidat.alfajer.core.RoomCode
import kotlinx.coroutines.delay
import kotlin.math.roundToInt

private val CallBg = Color(0xFF0B1120)
private val Glass = Color(0xCC111827)

@Composable
fun CallScreen(manager: CallManager) {
    val st by manager.state.collectAsStateWithLifecycle()
    val localTrack by manager.localVideo.collectAsStateWithLifecycle()
    val remoteTrack by manager.remoteVideo.collectAsStateWithLifecycle()
    val context = LocalContext.current
    var showSas by rememberSaveable { mutableStateOf(false) }
    var showChat by rememberSaveable { mutableStateOf(false) }

    // A call keeps the screen awake; Back sends the app to the background
    // (the call continues via the foreground service) instead of hanging up.
    val view = LocalView.current
    DisposableEffect(Unit) {
        view.keepScreenOn = true
        onDispose { view.keepScreenOn = false }
    }
    BackHandler { (context as? Activity)?.moveTaskToBack(true) }

    LaunchedEffect(showChat) { manager.setChatOpen(showChat) }

    Box(Modifier.fillMaxSize().background(CallBg)) {
        // ---- Remote side
        val remote = remoteTrack
        if (st.connected && remote != null && st.remoteVideoEnabled) {
            VideoRenderer(remote, Modifier.fillMaxSize())
        } else if (st.connected) {
            RemoteAvatar(st, Modifier.align(Alignment.Center))
        }

        // ---- Self-view PiP
        val local = localTrack
        if (local != null && !st.cameraOff) {
            SelfView(local, mirror = st.frontCamera, speaking = st.localSpeaking)
        }

        // ---- Top pills
        if (st.connected) {
            TopPills(st, onSecurityClick = { showSas = true }, modifier = Modifier.align(Alignment.TopStart))
        }

        // ---- Pre-connection overlays
        if (!st.connected) {
            PreConnectOverlay(st, Modifier.align(Alignment.Center))
        }

        // ---- Controls
        Controls(
            st,
            manager,
            onChat = { showChat = true },
            modifier = Modifier.align(Alignment.BottomCenter),
        )
    }

    st.incomingKnock?.let { name ->
        AlertDialog(
            onDismissRequest = {},
            title = { Text("Someone wants to join") },
            text = {
                Text("${Identity.pretty(name).ifEmpty { name }} is asking to join this call. Only accept people you invited.")
            },
            confirmButton = { Button(onClick = { manager.acceptJoin() }) { Text("Accept") } },
            dismissButton = { TextButton(onClick = { manager.rejectJoin() }) { Text("Reject") } },
        )
    }

    if (showSas) SasDialog(st, manager, onDismiss = { showSas = false })
    if (showChat) ChatSheet(st, manager, onDismiss = { showChat = false })
}

// ------------------------------------------------------------------ pieces

@Composable
private fun RemoteAvatar(st: CallState, modifier: Modifier) {
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        Box(
            Modifier
                .size(132.dp)
                .border(4.dp, if (st.remoteSpeaking) Emerald else Color.Transparent, CircleShape)
                .padding(6.dp)
                .clip(CircleShape)
                .background(Brand),
            contentAlignment = Alignment.Center,
        ) {
            Text(Identity.initial(st.remoteIdentity), color = Color.White, fontSize = 52.sp, fontWeight = FontWeight.Bold)
        }
        Spacer(Modifier.height(12.dp))
        Text(Identity.pretty(st.remoteIdentity), color = Color.White, style = MaterialTheme.typography.titleMedium)
        if (!st.remoteVideoEnabled && !st.audioOnly) {
            Text("Camera is off", color = Slate, style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun SelfView(track: org.webrtc.VideoTrack, mirror: Boolean, speaking: Boolean) {
    BoxWithConstraints(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
        val density = LocalDensity.current
        val margin = 12.dp
        val pipW = 108.dp
        val pipH = 152.dp
        // Room for the control bar so the PiP can't hide behind it.
        val bottomReserve = 104.dp
        val maxX = with(density) { (maxWidth - pipW - margin * 2).toPx() }.coerceAtLeast(0f)
        val maxY = with(density) { (maxHeight - pipH - margin * 2 - bottomReserve).toPx() }.coerceAtLeast(0f)
        var offset by remember { mutableStateOf(Offset.Zero) }
        Box(
            Modifier
                .align(Alignment.TopEnd)
                .padding(top = margin + 44.dp, end = margin)
                .offset { IntOffset(offset.x.roundToInt(), offset.y.roundToInt()) }
                .size(pipW, pipH)
                .border(2.dp, if (speaking) Emerald else Color.White.copy(alpha = 0.25f), RoundedCornerShape(14.dp))
                .padding(2.dp)
                .pointerInput(maxX, maxY) {
                    detectDragGestures { change, drag ->
                        change.consume()
                        // Anchored top-end: x moves left (negative), y moves down.
                        offset = Offset(
                            (offset.x + drag.x).coerceIn(-maxX, 0f),
                            (offset.y + drag.y).coerceIn(0f, maxY),
                        )
                    }
                },
        ) {
            VideoRenderer(track, Modifier.fillMaxSize(), mirror = mirror, onTop = true)
        }
    }
}

@Composable
private fun TopPills(st: CallState, onSecurityClick: () -> Unit, modifier: Modifier) {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            now = System.currentTimeMillis()
            delay(1000)
        }
    }
    Row(
        modifier.statusBarsPadding().padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val (color, label) = qualityBadge(st.quality)
        Pill {
            Box(Modifier.size(8.dp).clip(CircleShape).background(color))
            Text(label, color = Color.White, style = MaterialTheme.typography.labelMedium)
            st.quality.rttMs?.let { Text("${it}ms", color = Slate, style = MaterialTheme.typography.labelSmall) }
        }
        Pill(Modifier.clickable(onClick = onSecurityClick)) {
            val (icon, text) = when {
                st.sasVerification == SasVerification.MISMATCH -> "⚠️" to "Warning"
                st.sasVerification == SasVerification.VERIFIED -> "✅" to "Verified"
                st.security == SecurityState.DTLS_SRTP -> "🔐" to "DTLS-SRTP"
                else -> "⏳" to "Securing…"
            }
            Text(icon, fontSize = 12.sp)
            Text(text, color = Color.White, style = MaterialTheme.typography.labelMedium)
            st.safetyCode?.let { Text(it, color = Slate, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.labelSmall) }
        }
        st.connectedAtMillis?.let {
            Pill { Text(formatDuration(now - it), color = Color.White, style = MaterialTheme.typography.labelMedium) }
        }
    }
}

@Composable
private fun Pill(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Surface(shape = RoundedCornerShape(50), color = Glass, modifier = modifier) {
        Row(
            Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) { content() }
    }
}

private fun qualityBadge(q: Quality): Pair<Color, String> = when (q.kind) {
    QualityKind.DIRECT -> Emerald to "Direct"
    QualityKind.RELAY -> Amber to "Relay"
    QualityKind.RECONNECTING -> Amber to "Reconnecting"
    QualityKind.FAILED -> Danger to "Failed"
    QualityKind.CONNECTING -> Slate to "Connecting"
}

private fun formatDuration(ms: Long): String {
    val total = (ms / 1000).coerceAtLeast(0)
    return "%02d:%02d".format(total / 60, total % 60)
}

@Composable
private fun PreConnectOverlay(st: CallState, modifier: Modifier) {
    val context = LocalContext.current
    Column(
        modifier.widthIn(max = 420.dp).padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        when {
            st.phase == Phase.REQUESTING -> {
                CircularProgressIndicator(color = Color.White)
                Text("Joining call…", color = Color.White, style = MaterialTheme.typography.headlineSmall)
                Text("Waiting for the host to accept", color = Slate)
            }
            st.isInitiator && !st.peerJoined -> {
                Text("Share this room code", color = Color.White, style = MaterialTheme.typography.headlineSmall)
                Text(
                    RoomCode.grouped(st.roomId),
                    color = Color.White,
                    fontSize = 40.sp,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.clickable { copy(context, "Room code", st.roomId) },
                )
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedButton(onClick = { copy(context, "Alfajer link", Config.shareUrl(st.roomId)) }) {
                        Icon(Icons.Filled.ContentCopy, contentDescription = null, tint = Color.White, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.size(6.dp))
                        Text("Copy link", color = Color.White)
                    }
                    Button(onClick = { shareInvite(context, st.roomId) }) {
                        Icon(Icons.Filled.Share, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.size(6.dp))
                        Text("Share")
                    }
                }
                TextButton(onClick = { shareWhatsApp(context, st.roomId) }) { Text("Send via WhatsApp", color = Emerald) }
                Text(
                    "⚠ Anyone with this code can try to join — you'll be asked to accept them.",
                    color = Amber,
                    style = MaterialTheme.typography.bodySmall,
                    textAlign = TextAlign.Center,
                )
            }
            else -> {
                CircularProgressIndicator(color = Color.White)
                Text("Connecting…", color = Color.White, style = MaterialTheme.typography.headlineSmall)
                Text("Setting up an end-to-end encrypted channel", color = Slate)
            }
        }
    }
}

@Composable
private fun Controls(st: CallState, manager: CallManager, onChat: () -> Unit, modifier: Modifier) {
    Row(
        modifier
            .navigationBarsPadding()
            .padding(16.dp)
            .clip(RoundedCornerShape(32.dp))
            .background(Glass)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (st.hasLocalAudio) {
            RoundButton(
                if (st.muted) Icons.Filled.MicOff else Icons.Filled.Mic,
                if (st.muted) "Unmute" else "Mute",
                highlighted = st.muted,
            ) { manager.toggleMute() }
        }
        if (st.hasLocalVideo) {
            RoundButton(
                if (st.cameraOff) Icons.Filled.VideocamOff else Icons.Filled.Videocam,
                if (st.cameraOff) "Camera on" else "Camera off",
                highlighted = st.cameraOff,
            ) { manager.toggleCamera() }
            if (st.canSwitchCamera && !st.cameraOff) {
                RoundButton(Icons.Filled.Cameraswitch, "Switch camera") { manager.switchCamera() }
            }
        }
        if (st.phase != Phase.REQUESTING) {
            RoundButton(
                if (st.speakerOn) Icons.AutoMirrored.Filled.VolumeUp else Icons.Filled.PhoneInTalk,
                if (st.speakerOn) "Use earpiece" else "Use speaker",
            ) { manager.toggleSpeaker() }
        }
        if (st.connected) {
            Box {
                RoundButton(Icons.AutoMirrored.Filled.Chat, "Chat", onClick = onChat)
                if (st.unreadChat > 0) {
                    Box(
                        Modifier.align(Alignment.TopEnd).size(18.dp).clip(CircleShape).background(Danger),
                        contentAlignment = Alignment.Center,
                    ) { Text(st.unreadChat.coerceAtMost(9).toString(), color = Color.White, fontSize = 11.sp) }
                }
            }
        }
        RoundButton(Icons.Filled.CallEnd, "End call", background = Danger) { manager.hangUp() }
    }
}

@Composable
private fun RoundButton(
    icon: ImageVector,
    description: String,
    highlighted: Boolean = false,
    background: Color = if (highlighted) Color.White else Color.White.copy(alpha = 0.14f),
    onClick: () -> Unit,
) {
    IconButton(
        onClick = onClick,
        modifier = Modifier.size(52.dp).clip(CircleShape).background(background),
    ) {
        Icon(icon, contentDescription = description, tint = if (highlighted) CallBg else Color.White)
    }
}

@Composable
private fun SasDialog(st: CallState, manager: CallManager, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Verify this call") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                val code = st.safetyCode
                if (code == null) {
                    Text("Computing safety code…")
                    return@Column
                }
                Text(
                    code,
                    fontSize = 40.sp,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    color = when (st.sasVerification) {
                        SasVerification.VERIFIED -> Emerald
                        SasVerification.MISMATCH -> Danger
                        SasVerification.PENDING -> MaterialTheme.colorScheme.onSurface
                    },
                    modifier = Modifier.fillMaxWidth(),
                    textAlign = TextAlign.Center,
                )
                Text(
                    "Both of you should see the same 5 digits. Read them aloud to each other. " +
                        "If they match, no one is impersonating your peer. If they don't, the connection " +
                        "is not safe — end the call.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text("Video: 🔐 DTLS-SRTP   Audio: 🔐 DTLS-SRTP   Chat: 🔒 AES-GCM", style = MaterialTheme.typography.bodySmall)
                Text(
                    "Media is end-to-end encrypted with WebRTC's DTLS-SRTP — no signaling or TURN server can " +
                        "decrypt it. Chat adds AES-256-GCM with a key from an ECDH P-256 / HKDF exchange.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                )
                when (st.sasVerification) {
                    SasVerification.PENDING -> Unit
                    SasVerification.VERIFIED -> Text("✅ Verified. You've confirmed the safety code matches.", color = Emerald)
                    SasVerification.MISMATCH -> Text(
                        "⚠ Code mismatch reported. A signaling-server attacker may be intercepting this call. End it now and try again.",
                        color = Danger,
                    )
                }
            }
        },
        confirmButton = {
            if (st.safetyCode != null && st.sasVerification == SasVerification.PENDING) {
                Button(onClick = { manager.setSasVerification(SasVerification.VERIFIED) }) { Text("Codes match") }
            } else if (st.sasVerification != SasVerification.PENDING) {
                TextButton(onClick = { manager.setSasVerification(SasVerification.PENDING) }) { Text("Undo") }
            }
        },
        dismissButton = {
            Row {
                if (st.safetyCode != null && st.sasVerification == SasVerification.PENDING) {
                    TextButton(
                        onClick = { manager.setSasVerification(SasVerification.MISMATCH) },
                        colors = ButtonDefaults.textButtonColors(contentColor = Danger),
                    ) { Text("Don't match") }
                }
                TextButton(onClick = onDismiss) { Text("Close") }
            }
        },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatSheet(st: CallState, manager: CallManager, onDismiss: () -> Unit) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var input by rememberSaveable { mutableStateOf("") }
    val list = rememberLazyListState()
    LaunchedEffect(st.chat.size) {
        if (st.chat.isNotEmpty()) list.animateScrollToItem(st.chat.size - 1)
    }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet) {
        Column(Modifier.fillMaxWidth().imePadding().padding(horizontal = 16.dp)) {
            Text("Encrypted chat", style = MaterialTheme.typography.titleMedium)
            Text(
                "AES-256-GCM — the server only relays ciphertext.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
            )
            Spacer(Modifier.height(8.dp))
            LazyColumn(
                state = list,
                modifier = Modifier.fillMaxWidth().heightIn(min = 160.dp, max = 380.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                items(st.chat, key = { it.id }) { m ->
                    Box(Modifier.fillMaxWidth(), contentAlignment = if (m.fromMe) Alignment.CenterEnd else Alignment.CenterStart) {
                        Surface(
                            shape = RoundedCornerShape(14.dp),
                            color = if (m.fromMe) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant,
                        ) {
                            Text(
                                m.text,
                                color = if (m.fromMe) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface,
                                modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp).widthIn(max = 280.dp),
                            )
                        }
                    }
                }
            }
            Row(Modifier.fillMaxWidth().padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = input,
                    onValueChange = { input = it.take(2000) },
                    placeholder = { Text("Message") },
                    modifier = Modifier.weight(1f),
                    maxLines = 4,
                )
                IconButton(
                    onClick = {
                        if (input.isNotBlank()) {
                            manager.sendChat(input)
                            input = ""
                        }
                    },
                ) { Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send") }
            }
        }
    }
}

// ------------------------------------------------------------------ sharing

private fun inviteText(roomId: String) =
    "Join my private Alfajer call.\nRoom code: $roomId\n${Config.shareUrl(roomId)}"

private fun copy(context: Context, label: String, text: String) {
    val cm = context.getSystemService(ClipboardManager::class.java) ?: return
    cm.setPrimaryClip(ClipData.newPlainText(label, text))
}

private fun shareInvite(context: Context, roomId: String) {
    val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, inviteText(roomId))
    context.startActivity(Intent.createChooser(send, "Invite to call"))
}

private fun shareWhatsApp(context: Context, roomId: String) {
    val uri = Uri.parse("https://wa.me/?text=" + Uri.encode(inviteText(roomId)))
    try {
        context.startActivity(Intent(Intent.ACTION_VIEW, uri))
    } catch (_: Exception) {
        shareInvite(context, roomId)
    }
}
