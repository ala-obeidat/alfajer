package com.alaobeidat.alfajer.ui

import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.alaobeidat.alfajer.Prefs
import com.alaobeidat.alfajer.call.CallSession
import com.alaobeidat.alfajer.core.RoomCode
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val deepLinkCode = mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // Keep call video and room codes out of screenshots, screen recorders
        // and the recent-apps thumbnail.
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        deepLinkCode.value = roomCodeFrom(intent)
        val prefs = Prefs(this)
        setContent {
            AlfajerTheme {
                AlfajerApp(prefs, deepLinkCode.value) { deepLinkCode.value = null }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        roomCodeFrom(intent)?.let { deepLinkCode.value = it }
    }

    /** https://<web host>/call/<code> or alfajer://call/<code>. */
    private fun roomCodeFrom(intent: Intent?): String? {
        val uri = intent?.data ?: return null
        val segments = uri.pathSegments
        val code = when (uri.scheme) {
            "https" -> if (segments.size >= 2 && segments[0] == "call") segments[1] else null
            "alfajer" -> segments.firstOrNull()
            else -> null
        }
        return code?.takeIf(RoomCode::isValid)
    }
}

@Composable
private fun AlfajerApp(prefs: Prefs, deepLinkCode: String?, onDeepLinkConsumed: () -> Unit) {
    val active by CallSession.active.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) {
        CallSession.notices.collect { n ->
            scope.launch {
                snackbar.currentSnackbarData?.dismiss()
                snackbar.showSnackbar(n.text)
            }
        }
    }
    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        val call = active
        if (call != null) {
            CallScreen(call)
        } else {
            HomeScreen(prefs, deepLinkCode, onDeepLinkConsumed)
        }
        SnackbarHost(
            snackbar,
            Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = 112.dp),
        )
    }
}
