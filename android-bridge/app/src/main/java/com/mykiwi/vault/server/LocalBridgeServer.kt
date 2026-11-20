package com.mykiwi.vault.server

import android.content.Context
import android.util.Base64
import com.mykiwi.vault.data.RawJsonStorage
import com.mykiwi.vault.data.VaultDatabase
import com.mykiwi.vault.model.ProductRecord
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors

class LocalBridgeServer(
    private val appContext: Context,
    private val port: Int = DEFAULT_PORT,
    private val onEventCallback: ((eventType: String, detail: String?) -> Unit)? = null
) {
    private val db = VaultDatabase.getInstance(appContext)
    private val executor = Executors.newCachedThreadPool()
    private val wsClients = CopyOnWriteArrayList<WsSession>()

    @Volatile
    private var running = false
    private var serverSocket: ServerSocket? = null

    fun start() {
        if (running) return
        running = true
        executor.execute {
            try {
                val srv = ServerSocket(port, 32, InetAddress.getByName("127.0.0.1"))
                srv.reuseAddress = true
                serverSocket = srv
                while (running) {
                    val socket = try {
                        srv.accept()
                    } catch (_: Exception) {
                        if (!running) break else continue
                    }
                    executor.execute { handleConnection(socket) }
                }
            } catch (_: Exception) {
                running = false
            }
        }
    }

    fun stop() {
        running = false
        for (client in wsClients) {
            client.closeQuietly()
        }
        wsClients.clear()
        try {
            serverSocket?.close()
        } catch (_: Exception) {
        }
        serverSocket = null
    }

    fun connectedClientCount(): Int = wsClients.size

    fun broadcastJson(payload: JSONObject) {
        val text = payload.toString()
        for (session in wsClients) {
            if (!session.sendText(text)) {
                wsClients.remove(session)
                session.closeQuietly()
            }
        }
    }

    fun broadcastWake(forceResume: Boolean = false) {
        broadcastJson(
            JSONObject().apply {
                put("type", "wake")
                put("forceResume", forceResume)
                put("ts", System.currentTimeMillis())
            }
        )
    }

    private fun handleConnection(socket: Socket) {
        try {
            socket.soTimeout = 30_000
            val input = BufferedInputStream(socket.getInputStream())
            val output = socket.getOutputStream()

            val requestLine = readAsciiLine(input) ?: run {
                socket.close()
                return
            }
            val parts = requestLine.split(" ")
            if (parts.size < 2) {
                socket.close()
                return
            }
            val method = parts[0].uppercase()
            val fullTarget = parts[1]
            val path = fullTarget.substringBefore('?')
            val query = fullTarget.substringAfter('?', "")

            val headers = mutableMapOf<String, String>()
            while (true) {
                val line = readAsciiLine(input) ?: break
                if (line.isEmpty()) break
                val colon = line.indexOf(':')
                if (colon > 0) {
                    val k = line.substring(0, colon).trim().lowercase()
                    val v = line.substring(colon + 1).trim()
                    headers[k] = v
                }
            }

            // Check WebSocket Upgrade (RFC 6455)
            if (method == "GET" &&
                headers["upgrade"]?.equals("websocket", ignoreCase = true) == true &&
                !headers["sec-websocket-key"].isNullOrBlank()
            ) {
                socket.soTimeout = 0 // persistent socket
                handleWebSocket(socket, input, output, headers["sec-websocket-key"]!!)
                return
            }

            // CORS preflight
            if (method == "OPTIONS") {
                writeHttpResponse(output, 204, "No Content", "text/plain", ByteArray(0))
                socket.close()
                return
            }

            val contentLength = headers["content-length"]?.toIntOrNull()?.coerceIn(0, MAX_BODY_BYTES) ?: 0
            val bodyBytes = if (contentLength > 0) readExactBytes(input, contentLength) else ByteArray(0)
            val bodyStr = if (bodyBytes.isNotEmpty()) String(bodyBytes, Charsets.UTF_8) else ""

            routeHttpRequest(method, path, query, bodyStr, output)
            socket.close()
        } catch (_: Exception) {
            try {
                socket.close()
            } catch (_: Exception) {
            }
        }
    }

    private fun routeHttpRequest(
        method: String,
        path: String,
        query: String,
        body: String,
        output: OutputStream
    ) {
        try {
            when {
                method == "GET" && path == "/api/health" -> {
                    val stats = db.getStats()
                    val res = JSONObject().apply {
                        put("ok", true)
                        put("app", "ShopVault")
                        put("package", appContext.packageName)
                        put("kiwiConnected", wsClients.size > 0)
                        put("wsClients", wsClients.size)
                        put("totalProducts", stats.totalProducts)
                        put("queuedCount", stats.queuedCount)
                        put("processingCount", stats.processingCount)
                    }
                    writeJsonResponse(output, 200, res)
                }

                method == "GET" && path == "/api/jobs/next" -> {
                    val job = db.claimNextQueuedJob()
                    val res = JSONObject().apply {
                        put("ok", true)
                        put("job", job?.toJsonObject() ?: JSONObject.NULL)
                    }
                    if (job != null) {
                        onEventCallback?.invoke("JOB_CLAIMED", job.targetUrl)
                    }
                    writeJsonResponse(output, 200, res)
                }

                method == "POST" && path.matches(Regex("""^/api/jobs/\d+/complete$""")) -> {
                    val jobId = path.split("/")[3].toLong()
                    val existingJob = db.getQueueJobById(jobId)
                    val payload = JSONObject(body)
                    val productObj = payload.getJSONObject("product")
                    val rawJsonStr = payload.optString("rawJson", "")

                    val tempRecord = ProductRecord.fromExtensionJson(
                        obj = productObj,
                        fallbackAffiliateUrl = existingJob?.affiliateUrl,
                        rawJsonPath = null
                    )

                    val savedRawPath = if (rawJsonStr.isNotBlank()) {
                        RawJsonStorage.saveRawResponse(
                            context = appContext,
                            platform = tempRecord.sourcePlatform,
                            shopId = tempRecord.shopId,
                            itemId = tempRecord.itemId,
                            rawJson = rawJsonStr
                        )
                    } else {
                        null
                    }

                    val savedId = db.upsertProduct(tempRecord.copy(rawJsonPath = savedRawPath))
                    db.completeQueueJob(jobId, savedId)
                    onEventCallback?.invoke("PRODUCT_SAVED", tempRecord.title)

                    writeJsonResponse(
                        output,
                        200,
                        JSONObject().apply {
                            put("ok", true)
                            put("productId", savedId)
                            put("rawJsonPath", savedRawPath ?: JSONObject.NULL)
                        }
                    )
                }

                method == "POST" && path.matches(Regex("""^/api/jobs/\d+/fail$""")) -> {
                    val jobId = path.split("/")[3].toLong()
                    val payload = if (body.isNotBlank()) JSONObject(body) else JSONObject()
                    val status = payload.optString("status", VaultDatabase.STATUS_FAILED)
                    val reason = payload.optString("reason", "Gagal menangkap data")
                    db.failQueueJob(jobId, status, reason)
                    onEventCallback?.invoke("JOB_FAILED:$status", reason)

                    writeJsonResponse(output, 200, JSONObject().put("ok", true))
                }

                method == "GET" && path == "/api/products" -> {
                    val qParam = parseQueryParam(query, "q")
                    val products = db.listProducts(qParam)
                    val arr = JSONArray()
                    for (p in products) {
                        arr.put(p.toJsonObject())
                    }
                    writeJsonResponse(
                        output,
                        200,
                        JSONObject().apply {
                            put("ok", true)
                            put("count", products.size)
                            put("products", arr)
                        }
                    )
                }

                method == "GET" && path.matches(Regex("""^/api/products/\d+$""")) -> {
                    val productId = path.substringAfterLast('/').toLong()
                    val p = db.getProductById(productId)
                    if (p == null) {
                        writeJsonResponse(output, 404, JSONObject().put("ok", false).put("error", "Not found"))
                    } else {
                        writeJsonResponse(output, 200, JSONObject().put("ok", true).put("product", p.toJsonObject()))
                    }
                }

                method == "GET" && path.matches(Regex("""^/api/products/\d+/raw$""")) -> {
                    val productId = path.split("/")[3].toLong()
                    val p = db.getProductById(productId)
                    val raw = RawJsonStorage.readRawResponse(p?.rawJsonPath)
                    if (raw == null) {
                        writeJsonResponse(output, 404, JSONObject().put("ok", false).put("error", "Raw JSON not found"))
                    } else {
                        writeHttpResponse(output, 200, "OK", "application/json; charset=utf-8", raw.toByteArray(Charsets.UTF_8))
                    }
                }

                method == "POST" && path == "/api/enqueue" -> {
                    val payload = JSONObject(body)
                    val url = payload.optString("url", "").trim()
                    if (url.isEmpty()) {
                        writeJsonResponse(output, 400, JSONObject().put("ok", false).put("error", "url wajib diisi"))
                    } else {
                        val queueId = db.enqueueShare(url, url)
                        onEventCallback?.invoke("ENQUEUE_REQUESTED", url)
                        writeJsonResponse(output, 200, JSONObject().put("ok", true).put("queueId", queueId))
                    }
                }

                else -> {
                    writeJsonResponse(output, 404, JSONObject().put("ok", false).put("error", "Endpoint tidak ditemukan"))
                }
            }
        } catch (e: Exception) {
            writeJsonResponse(
                output,
                500,
                JSONObject().put("ok", false).put("error", e.message ?: "Internal server error")
            )
        }
    }

    // =========================================================================
    // RFC 6455 WebSocket Implementation
    // =========================================================================
    private fun handleWebSocket(
        socket: Socket,
        input: InputStream,
        output: OutputStream,
        secKey: String
    ) {
        val acceptSeed = secKey.trim() + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        val sha1 = MessageDigest.getInstance("SHA-1").digest(acceptSeed.toByteArray(Charsets.US_ASCII))
        val acceptKey = Base64.encodeToString(sha1, Base64.NO_WRAP)

        val handshake = buildString {
            append("HTTP/1.1 101 Switching Protocols\r\n")
            append("Upgrade: websocket\r\n")
            append("Connection: Upgrade\r\n")
            append("Sec-WebSocket-Accept: ").append(acceptKey).append("\r\n\r\n")
        }
        output.write(handshake.toByteArray(Charsets.US_ASCII))
        output.flush()

        val session = WsSession(socket, output)
        wsClients.add(session)
        onEventCallback?.invoke("KIWI_CONNECTED", null)

        try {
            val fragmentBuffer = ByteArrayOutputStream()
            var fragmentedOpcode = 0

            while (running && !socket.isClosed) {
                val b0 = input.read()
                if (b0 == -1) break
                val b1 = input.read()
                if (b1 == -1) break

                val fin = (b0 and 0x80) != 0
                val opcode = b0 and 0x0F
                val masked = (b1 and 0x80) != 0
                var payloadLen = (b1 and 0x7F).toLong()

                if (payloadLen == 126L) {
                    val ext = readExactBytes(input, 2)
                    payloadLen = (((ext[0].toInt() and 0xFF) shl 8) or (ext[1].toInt() and 0xFF)).toLong()
                } else if (payloadLen == 127L) {
                    val ext = readExactBytes(input, 8)
                    payloadLen = 0L
                    for (i in 0 until 8) {
                        payloadLen = (payloadLen shl 8) or (ext[i].toLong() and 0xFFL)
                    }
                }

                if (payloadLen > MAX_BODY_BYTES) break

                val maskKey = if (masked) readExactBytes(input, 4) else null
                val frameData = readExactBytes(input, payloadLen.toInt())
                if (masked && maskKey != null) {
                    for (i in frameData.indices) {
                        frameData[i] = (frameData[i].toInt() xor (maskKey[i % 4].toInt())).toByte()
                    }
                }

                when (opcode) {
                    0x8 -> { // Close
                        session.sendFrame(0x8, ByteArray(0))
                        break
                    }
                    0x9 -> { // Ping -> Pong
                        session.sendFrame(0xA, frameData)
                    }
                    0xA -> { // Pong
                    }
                    0x1, 0x2 -> {
                        if (fin) {
                            if (opcode == 0x1) {
                                handleWsMessage(session, String(frameData, Charsets.UTF_8))
                            }
                        } else {
                            fragmentBuffer.reset()
                            fragmentedOpcode = opcode
                            fragmentBuffer.write(frameData)
                        }
                    }
                    0x0 -> { // Continuation
                        fragmentBuffer.write(frameData)
                        if (fin && fragmentedOpcode == 0x1) {
                            handleWsMessage(session, fragmentBuffer.toByteArray().toString(Charsets.UTF_8))
                            fragmentBuffer.reset()
                        }
                    }
                }
            }
        } catch (_: Exception) {
        } finally {
            wsClients.remove(session)
            session.closeQuietly()
            onEventCallback?.invoke("KIWI_DISCONNECTED", null)
        }
    }

    private fun handleWsMessage(session: WsSession, text: String) {
        try {
            val msg = JSONObject(text)
            if (msg.optString("type") == "ping") {
                session.sendText(JSONObject().put("type", "pong").put("ts", System.currentTimeMillis()).toString())
            }
        } catch (_: Exception) {
        }
    }

    private fun writeJsonResponse(output: OutputStream, code: Int, json: JSONObject) {
        val statusText = when (code) {
            200 -> "OK"
            400 -> "Bad Request"
            404 -> "Not Found"
            else -> "Error"
        }
        writeHttpResponse(
            output,
            code,
            statusText,
            "application/json; charset=utf-8",
            json.toString().toByteArray(Charsets.UTF_8)
        )
    }

    private fun writeHttpResponse(
        output: OutputStream,
        code: Int,
        statusText: String,
        contentType: String,
        body: ByteArray
    ) {
        val headers = buildString {
            append("HTTP/1.1 ").append(code).append(' ').append(statusText).append("\r\n")
            append("Content-Type: ").append(contentType).append("\r\n")
            append("Content-Length: ").append(body.size).append("\r\n")
            append("Access-Control-Allow-Origin: *\r\n")
            append("Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS\r\n")
            append("Access-Control-Allow-Headers: Content-Type, Authorization\r\n")
            append("Access-Control-Allow-Private-Network: true\r\n")
            append("Connection: close\r\n\r\n")
        }
        output.write(headers.toByteArray(Charsets.US_ASCII))
        if (body.isNotEmpty()) {
            output.write(body)
        }
        output.flush()
    }

    private fun readAsciiLine(input: InputStream): String? {
        val buf = ByteArrayOutputStream()
        while (true) {
            val b = input.read()
            if (b == -1) {
                return if (buf.size() == 0) null else buf.toByteArray().toString(Charsets.US_ASCII)
            }
            if (b == '\n'.code) break
            if (b != '\r'.code) {
                buf.write(b)
                if (buf.size() > 8192) break
            }
        }
        return buf.toByteArray().toString(Charsets.US_ASCII)
    }

    private fun readExactBytes(input: InputStream, count: Int): ByteArray {
        val out = ByteArray(count)
        var offset = 0
        while (offset < count) {
            val read = input.read(out, offset, count - offset)
            if (read == -1) throw EOFException("Unexpected EOF")
            offset += read
        }
        return out
    }

    private fun parseQueryParam(query: String, key: String): String? {
        if (query.isBlank()) return null
        for (pair in query.split('&')) {
            val idx = pair.indexOf('=')
            val k = if (idx >= 0) pair.substring(0, idx) else pair
            if (k == key && idx >= 0) {
                return java.net.URLDecoder.decode(pair.substring(idx + 1), "UTF-8")
            }
        }
        return null
    }

    private class WsSession(
        private val socket: Socket,
        private val output: OutputStream
    ) {
        private val writeLock = Any()

        fun sendText(text: String): Boolean {
            return sendFrame(0x1, text.toByteArray(Charsets.UTF_8))
        }

        fun sendFrame(opcode: Int, payload: ByteArray): Boolean {
            synchronized(writeLock) {
                return try {
                    val header = ByteArrayOutputStream()
                    header.write(0x80 or (opcode and 0x0F))
                    val len = payload.size
                    when {
                        len <= 125 -> header.write(len)
                        len <= 65535 -> {
                            header.write(126)
                            header.write((len shr 8) and 0xFF)
                            header.write(len and 0xFF)
                        }
                        else -> {
                            header.write(127)
                            val l = len.toLong()
                            for (shift in 56 downTo 0 step 8) {
                                header.write(((l shr shift) and 0xFFL).toInt())
                            }
                        }
                    }
                    output.write(header.toByteArray())
                    if (payload.isNotEmpty()) {
                        output.write(payload)
                    }
                    output.flush()
                    true
                } catch (_: Exception) {
                    false
                }
            }
        }

        fun closeQuietly() {
            try {
                socket.close()
            } catch (_: Exception) {
            }
        }
    }

    companion object {
        const val DEFAULT_PORT = 8765
        private const val MAX_BODY_BYTES = 15 * 1024 * 1024 // 15 MB
    }
}
