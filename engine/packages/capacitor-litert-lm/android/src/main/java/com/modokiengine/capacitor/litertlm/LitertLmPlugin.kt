package com.modokiengine.capacitor.litertlm

import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.Conversation
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

@CapacitorPlugin(name = "LitertLm")
class LitertLmPlugin : Plugin() {

    companion object {
        private const val TAG = "LitertLm"
    }

    private var engine: Engine? = null
    private var conversation: Conversation? = null
    private var currentConversationId: String? = null
    private var status = "idle"
    private var modelName = ""
    private var errorMessage = ""
    private val scope = CoroutineScope(Dispatchers.IO + Job())

    @PluginMethod
    fun isModelDownloaded(call: PluginCall) {
        val filename = call.getString("filename")
        if (filename == null) {
            call.reject("filename is required")
            return
        }

        val modelsDir = File(context.filesDir, "models")
        val modelFile = File(modelsDir, filename)
        val result = JSObject()
        result.put("exists", modelFile.exists())
        result.put("path", modelFile.absolutePath)
        if (modelFile.exists()) {
            Log.i(TAG, "Model found: ${modelFile.absolutePath} (${modelFile.length() / 1_000_000}MB)")
        }
        call.resolve(result)
    }

    @PluginMethod
    fun downloadModel(call: PluginCall) {
        val url = call.getString("url")
        val filename = call.getString("filename")
        if (url == null || filename == null) {
            call.reject("url and filename are required")
            return
        }

        val modelsDir = File(context.filesDir, "models")
        modelsDir.mkdirs()
        val destFile = File(modelsDir, filename)

        // Already downloaded?
        if (destFile.exists() && destFile.length() > 100_000_000) {
            Log.i(TAG, "Model already exists: ${destFile.absolutePath} (${destFile.length() / 1_000_000}MB)")
            val result = JSObject()
            result.put("ok", true)
            result.put("path", destFile.absolutePath)
            call.resolve(result)
            return
        }

        Log.i(TAG, "Downloading model from $url to ${destFile.absolutePath}")
        notifyLoadProgress(0.0)

        scope.launch {
            var connection: HttpURLConnection? = null
            try {
                // Follow redirects (HuggingFace uses redirects)
                var currentUrl = url
                var redirectCount = 0
                while (redirectCount < 5) {
                    connection = URL(currentUrl).openConnection() as HttpURLConnection
                    connection.connectTimeout = 30_000
                    connection.readTimeout = 60_000
                    connection.instanceFollowRedirects = false
                    connection.connect()

                    val responseCode = connection.responseCode
                    if (responseCode in 300..399) {
                        currentUrl = connection.getHeaderField("Location")
                        connection.disconnect()
                        redirectCount++
                        continue
                    }
                    break
                }

                val conn = connection!!
                if (conn.responseCode != 200) {
                    throw Exception("HTTP ${conn.responseCode}: ${conn.responseMessage}")
                }

                val totalBytes = conn.contentLengthLong
                Log.i(TAG, "Download size: ${totalBytes / 1_000_000}MB")

                val tmpFile = File(modelsDir, "$filename.tmp")
                val inputStream = conn.inputStream
                val outputStream = FileOutputStream(tmpFile)
                val buffer = ByteArray(256 * 1024) // 256KB buffer
                var bytesRead: Int
                var totalRead = 0L
                var lastProgressUpdate = 0L

                while (inputStream.read(buffer).also { bytesRead = it } != -1) {
                    outputStream.write(buffer, 0, bytesRead)
                    totalRead += bytesRead

                    // Throttle progress updates to every 500KB
                    if (totalRead - lastProgressUpdate > 500_000) {
                        val progress = if (totalBytes > 0) {
                            totalRead.toDouble() / totalBytes.toDouble()
                        } else {
                            0.0
                        }
                        notifyLoadProgress(progress.coerceAtMost(0.99))
                        lastProgressUpdate = totalRead
                    }
                }

                outputStream.flush()
                outputStream.close()
                inputStream.close()

                // Rename tmp to final (atomic-ish on same filesystem)
                tmpFile.renameTo(destFile)

                notifyLoadProgress(1.0)
                Log.i(TAG, "Download complete: ${destFile.absolutePath} (${destFile.length() / 1_000_000}MB)")

                val result = JSObject()
                result.put("ok", true)
                result.put("path", destFile.absolutePath)
                call.resolve(result)
            } catch (e: Exception) {
                Log.e(TAG, "Download failed: ${e.message}", e)
                notifyError("Download failed: ${e.message}")
                val result = JSObject()
                result.put("ok", false)
                result.put("path", "")
                call.resolve(result)
            } finally {
                connection?.disconnect()
            }
        }
    }

    @PluginMethod
    fun loadModel(call: PluginCall) {
        val modelPath = call.getString("modelPath")
        if (modelPath == null) {
            call.reject("modelPath is required")
            return
        }

        if (status == "loading") {
            call.reject("Already loading a model")
            return
        }

        status = "loading"
        modelName = modelPath.substringAfterLast('/')
        notifyLoadProgress(0.0)

        scope.launch {
            try {
                notifyLoadProgress(0.1)

                // Resolve relative paths against app's internal files directory
                val resolvedPath = if (modelPath.startsWith("/")) {
                    modelPath
                } else {
                    java.io.File(context.filesDir, modelPath).absolutePath
                }

                val modelFile = java.io.File(resolvedPath)
                if (!modelFile.exists()) {
                    Log.e(TAG, "Model file not found: $resolvedPath")
                    status = "error"
                    errorMessage = "Model file not found: $modelPath"
                    notifyError(errorMessage)
                    val result = JSObject()
                    result.put("ok", false)
                    call.resolve(result)
                    return@launch
                }

                Log.i(TAG, "Loading model from: $resolvedPath (${modelFile.length() / 1_000_000}MB)")

                val config = EngineConfig(modelPath = resolvedPath)
                val eng = Engine(config)

                notifyLoadProgress(0.5)

                eng.initialize()

                notifyLoadProgress(1.0)

                engine = eng
                status = "ready"

                val result = JSObject()
                result.put("ok", true)
                call.resolve(result)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to load model: ${e.message}", e)
                status = "error"
                errorMessage = e.message ?: "Unknown error"
                notifyError(errorMessage)

                val result = JSObject()
                result.put("ok", false)
                call.resolve(result)
            }
        }
    }

    @PluginMethod
    fun getStatus(call: PluginCall) {
        val result = JSObject()
        result.put("status", status)
        result.put("modelName", modelName)
        result.put("errorMessage", errorMessage)
        call.resolve(result)
    }

    @PluginMethod
    fun createConversation(call: PluginCall) {
        val eng = engine
        if (eng == null || status != "ready") {
            call.reject("Model not loaded")
            return
        }

        scope.launch {
            try {
                // Close previous conversation if any
                conversation?.close()

                val conv = eng.createConversation()
                conversation = conv
                val id = UUID.randomUUID().toString()
                currentConversationId = id

                val result = JSObject()
                result.put("conversationId", id)
                call.resolve(result)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to create conversation: ${e.message}", e)
                call.reject("Failed to create conversation: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun sendMessage(call: PluginCall) {
        val conversationId = call.getString("conversationId")
        val message = call.getString("message")

        if (conversationId == null || message == null) {
            call.reject("conversationId and message are required")
            return
        }

        val conv = conversation
        if (conv == null || status != "ready") {
            call.reject("No active conversation")
            return
        }

        status = "generating"

        scope.launch {
            try {
                // Collect streaming tokens from the Kotlin Flow
                conv.sendMessageAsync(message).collect { token ->
                    val event = JSObject()
                    event.put("conversationId", conversationId)
                    event.put("token", token.toString())
                    event.put("done", false)
                    notifyListeners("tokenReceived", event)
                }

                // Signal completion
                val doneEvent = JSObject()
                doneEvent.put("conversationId", conversationId)
                doneEvent.put("token", "")
                doneEvent.put("done", true)
                notifyListeners("tokenReceived", doneEvent)

                status = "ready"

                val result = JSObject()
                result.put("ok", true)
                call.resolve(result)
            } catch (e: Exception) {
                Log.e(TAG, "Inference failed: ${e.message}", e)
                status = "error"
                errorMessage = e.message ?: "Inference failed"
                notifyError(errorMessage)

                val result = JSObject()
                result.put("ok", false)
                call.resolve(result)
            }
        }
    }

    @PluginMethod
    fun dispose(call: PluginCall) {
        scope.launch {
            try {
                conversation?.close()
                conversation = null
                currentConversationId = null

                engine?.close()
                engine = null

                status = "idle"
                modelName = ""
                errorMessage = ""

                val result = JSObject()
                result.put("ok", true)
                call.resolve(result)
            } catch (e: Exception) {
                Log.e(TAG, "Dispose failed: ${e.message}", e)
                call.reject("Dispose failed: ${e.message}")
            }
        }
    }

    override fun handleOnDestroy() {
        conversation?.close()
        conversation = null
        engine?.close()
        engine = null
        scope.cancel()
        Log.i(TAG, "Plugin destroyed")
    }

    private fun notifyLoadProgress(progress: Double) {
        val event = JSObject()
        event.put("progress", progress)
        notifyListeners("loadProgress", event)
    }

    private fun notifyError(message: String) {
        val event = JSObject()
        event.put("message", message)
        notifyListeners("error", event)
    }
}
