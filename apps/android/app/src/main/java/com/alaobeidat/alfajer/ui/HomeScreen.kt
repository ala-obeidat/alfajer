package com.alaobeidat.alfajer.ui

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.alaobeidat.alfajer.Prefs
import com.alaobeidat.alfajer.R
import com.alaobeidat.alfajer.call.CallManager
import com.alaobeidat.alfajer.call.CallSession
import com.alaobeidat.alfajer.core.Identity
import com.alaobeidat.alfajer.core.RoomCode
import kotlinx.coroutines.launch

private data class PendingCall(val roomId: String, val nickname: String, val initiator: Boolean, val audioOnly: Boolean)

private fun Context.granted(permission: String) =
    checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun HomeScreen(prefs: Prefs, deepLinkCode: String?, onDeepLinkConsumed: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var nickname by rememberSaveable { mutableStateOf(prefs.nickname) }
    var joinMode by rememberSaveable { mutableStateOf(false) }
    var code by rememberSaveable { mutableStateOf("") }
    var audioOnly by rememberSaveable { mutableStateOf(prefs.audioOnly) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var pending by remember { mutableStateOf<PendingCall?>(null) }

    LaunchedEffect(deepLinkCode) {
        if (deepLinkCode != null) {
            code = deepLinkCode
            joinMode = true
            error = null
            onDeepLinkConsumed()
        }
    }

    fun launchCall(p: PendingCall) {
        busy = true
        scope.launch {
            try {
                val identity = Identity.generate(p.nickname)
                CallSession.set(CallManager.create(context, p.roomId, identity, p.initiator, p.audioOnly))
            } catch (_: Exception) {
                error = "Could not start the call. Check your connection."
            } finally {
                busy = false
            }
        }
    }

    val permissions = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        val p = pending ?: return@rememberLauncherForActivityResult
        pending = null
        val mic = context.granted(Manifest.permission.RECORD_AUDIO)
        val cam = !p.audioOnly && context.granted(Manifest.permission.CAMERA)
        if (!mic && !cam) {
            error = "Alfajer needs microphone or camera access to make a call."
        } else {
            launchCall(p)
        }
    }

    fun request(p: PendingCall) {
        pending = p
        val wanted = buildList {
            add(Manifest.permission.RECORD_AUDIO)
            if (!p.audioOnly) add(Manifest.permission.CAMERA)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) add(Manifest.permission.POST_NOTIFICATIONS)
        }
        permissions.launch(wanted.toTypedArray())
    }

    fun validNickname(): String? {
        val n = nickname.trim()
        if (n.isEmpty()) {
            error = "Please enter a nickname"
            return null
        }
        prefs.nickname = n
        prefs.audioOnly = audioOnly
        error = null
        return n
    }

    Column(
        Modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp, vertical = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(Modifier.height(24.dp))
        Image(painterResource(R.drawable.ic_shield), contentDescription = null, modifier = Modifier.size(72.dp))
        Spacer(Modifier.height(12.dp))
        Text("Alfajer", fontSize = 34.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(8.dp))
        Text(
            "Fully anonymous, private, secret 1-to-1 calls.",
            style = MaterialTheme.typography.bodyLarge,
            textAlign = TextAlign.Center,
        )
        Text(
            "No accounts. No logs. End-to-end via WebRTC.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.65f),
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(14.dp))
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Badge("🔒 End-to-end encrypted")
            Badge("📭 Nothing stored")
            Badge("⚡ Self-hosted")
        }
        Spacer(Modifier.height(24.dp))

        Card(Modifier.widthIn(max = 480.dp).fillMaxWidth(), shape = RoundedCornerShape(20.dp)) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(
                    value = nickname,
                    onValueChange = { nickname = it.take(32) },
                    label = { Text("Your nickname") },
                    placeholder = { Text("What should we call you?") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (!joinMode) {
                    Button(
                        onClick = { validNickname()?.let { request(PendingCall(RoomCode.generate(), it, true, audioOnly)) } },
                        enabled = !busy,
                        modifier = Modifier.fillMaxWidth().height(50.dp),
                    ) { Text("Start new call") }
                    OutlinedButton(
                        onClick = { if (validNickname() != null) joinMode = true },
                        enabled = !busy,
                        modifier = Modifier.fillMaxWidth().height(50.dp),
                    ) { Text("Join existing call") }
                } else {
                    OutlinedTextField(
                        value = code,
                        onValueChange = { code = RoomCode.sanitize(it) },
                        label = { Text("Room code") },
                        placeholder = { Text("123 456 789") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                        textStyle = MaterialTheme.typography.titleLarge,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Button(
                        onClick = {
                            val nick = validNickname() ?: return@Button
                            if (!RoomCode.isValid(code)) {
                                error = "Enter the room code"
                            } else {
                                request(PendingCall(code, nick, false, audioOnly))
                            }
                        },
                        enabled = !busy,
                        modifier = Modifier.fillMaxWidth().height(50.dp),
                    ) { Text("Join call") }
                    OutlinedButton(
                        onClick = {
                            joinMode = false
                            code = ""
                            error = null
                        },
                        enabled = !busy,
                        modifier = Modifier.fillMaxWidth().height(50.dp),
                    ) { Text("Back") }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = audioOnly, onCheckedChange = { audioOnly = it })
                    Text("Voice-only call (no video)")
                }
                if (busy) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                        Text("Connecting…")
                    }
                }
                error?.let {
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
        Spacer(Modifier.height(20.dp))
        Text(
            "Calls work with the Alfajer web app too — share the code or link with anyone.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f),
            textAlign = TextAlign.Center,
            modifier = Modifier.widthIn(max = 480.dp),
        )
    }
}

@Composable
private fun Badge(text: String) {
    Surface(shape = RoundedCornerShape(50), color = MaterialTheme.colorScheme.surfaceVariant) {
        Text(text, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp))
    }
}
