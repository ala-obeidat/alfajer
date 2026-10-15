package com.alaobeidat.alfajer.call

import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Holds the single active call (calls are strictly 1-to-1), so it survives
 *  activity recreation and can be reached from the foreground service. */
object CallSession {
    private val _active = MutableStateFlow<CallManager?>(null)
    val active: StateFlow<CallManager?> = _active.asStateFlow()

    /** User-facing toasts from the call engine. */
    val notices = MutableSharedFlow<CallNotice>(extraBufferCapacity = 32, onBufferOverflow = BufferOverflow.DROP_OLDEST)

    /** A call can fail during setup (e.g. no media) before it is handed
     *  over here; the lock keeps such a call from becoming "active". */
    fun set(manager: CallManager) {
        val previous: CallManager?
        synchronized(this) {
            if (manager.state.value.phase == Phase.ENDED) return
            previous = _active.value
            _active.value = manager
        }
        if (previous !== manager) previous?.hangUp()
    }

    internal fun onEnded(manager: CallManager) {
        synchronized(this) { _active.compareAndSet(manager, null) }
    }
}
