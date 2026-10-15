package com.alaobeidat.alfajer.call

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONException
import org.json.JSONObject

/**
 * WebSocket relay to the Alfajer signaling server (`/call/:roomId`).
 * Messages sent before the socket opens are queued, like the web client.
 * Native clients send no Origin header, which the server's CSWSH guard
 * explicitly allows.
 */
class SignalingClient(
    http: OkHttpClient,
    url: String,
    private val listener: Listener,
) {
    interface Listener {
        fun onMessage(msg: JSONObject)

        /** Server or network closed the socket. 1008 = room full / sealed. */
        fun onClosed(code: Int)
    }

    private val lock = Any()
    private val queue = ArrayList<String>()
    private var open = false
    private var closedByUs = false
    private var closeReported = false

    private val ws: WebSocket = http.newWebSocket(
        Request.Builder().url(url).build(),
        object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                synchronized(lock) {
                    open = true
                    queue.forEach(webSocket::send)
                    queue.clear()
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val msg = try {
                    JSONObject(text)
                } catch (_: JSONException) {
                    return
                }
                listener.onMessage(msg)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                reportClosed(code)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                reportClosed(code)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                reportClosed(1006)
            }
        },
    )

    private fun reportClosed(code: Int) {
        synchronized(lock) {
            open = false
            if (closedByUs || closeReported) return
            closeReported = true
        }
        listener.onClosed(code)
    }

    fun send(msg: JSONObject) {
        val text = msg.toString()
        synchronized(lock) {
            if (closedByUs) return
            if (open) ws.send(text) else queue.add(text)
        }
    }

    fun close() {
        synchronized(lock) {
            closedByUs = true
            queue.clear()
        }
        ws.close(1000, null)
    }
}
