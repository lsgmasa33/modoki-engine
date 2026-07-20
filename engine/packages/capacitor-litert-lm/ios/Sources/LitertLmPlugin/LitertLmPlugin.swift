import Capacitor
import Foundation
import MediaPipeTasksGenAI

/// Chat message for building Gemma 4 conversation context.
private struct ChatEntry {
    let role: String  // "user" or "model"
    let content: String
}

@objc(LitertLmPlugin)
public class LitertLmPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "LitertLmPlugin"
    public let jsName = "LitertLm"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "downloadModel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isModelDownloaded", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "loadModel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "createConversation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sendMessage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "dispose", returnType: CAPPluginReturnPromise),
    ]

    private var llmInference: LlmInference?
    private var status = "idle"
    private var modelName = ""
    private var errorMessage = ""
    private var conversations: [String: [ChatEntry]] = [:]
    private var nextConversationId = 0
    fileprivate var downloadSession: URLSession?
    fileprivate var downloadDelegate: DownloadDelegate?
    private var downloadTask: URLSessionDownloadTask?

    /// Models directory inside app's Documents folder.
    private var modelsDir: URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return docs.appendingPathComponent("models")
    }

    // MARK: - Download

    @objc func isModelDownloaded(_ call: CAPPluginCall) {
        guard let filename = call.getString("filename") else {
            call.reject("filename is required")
            return
        }

        let modelFile = modelsDir.appendingPathComponent(filename)
        let exists = FileManager.default.fileExists(atPath: modelFile.path)
        if exists {
            print("[LitertLm] Model found: \(modelFile.path)")
        }
        call.resolve([
            "exists": exists,
            "path": modelFile.path,
        ])
    }

    @objc func downloadModel(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"),
              let filename = call.getString("filename"),
              let url = URL(string: urlString) else {
            call.reject("url and filename are required")
            return
        }

        let destFile = modelsDir.appendingPathComponent(filename)

        // Already downloaded?
        if FileManager.default.fileExists(atPath: destFile.path) {
            if let attrs = try? FileManager.default.attributesOfItem(atPath: destFile.path),
               let size = attrs[.size] as? Int64, size > 100_000_000 {
                print("[LitertLm] Model already exists: \(destFile.path) (\(size / 1_000_000)MB)")
                call.resolve(["ok": true, "path": destFile.path])
                return
            }
        }

        // Create models directory
        try? FileManager.default.createDirectory(at: modelsDir, withIntermediateDirectories: true)

        print("[LitertLm] Downloading model from \(urlString)")
        notifyLoadProgress(0.0)

        // Store delegate and session as properties to prevent deallocation.
        let delegate = DownloadDelegate(plugin: self, call: call, destFile: destFile)
        self.downloadDelegate = delegate
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForResource = 3600  // 1 hour timeout for 2GB download
        let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
        self.downloadSession = session
        downloadTask = session.downloadTask(with: url)
        downloadTask?.resume()
        print("[LitertLm] Download task started")
    }

    // MARK: - Model Loading

    @objc func loadModel(_ call: CAPPluginCall) {
        guard let modelPath = call.getString("modelPath") else {
            call.reject("modelPath is required")
            return
        }

        if status == "loading" {
            call.reject("Already loading a model")
            return
        }

        status = "loading"
        modelName = (modelPath as NSString).lastPathComponent
        notifyLoadProgress(0.0)

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }

            do {
                // Resolve path
                let resolvedPath: String
                if modelPath.hasPrefix("/") {
                    resolvedPath = modelPath
                } else {
                    resolvedPath = self.modelsDir.appendingPathComponent(modelPath).path
                }

                guard FileManager.default.fileExists(atPath: resolvedPath) else {
                    self.status = "error"
                    self.errorMessage = "Model file not found: \(modelPath)"
                    self.notifyError(self.errorMessage)
                    call.resolve(["ok": false])
                    return
                }

                let fileSize = (try? FileManager.default.attributesOfItem(atPath: resolvedPath)[.size] as? Int64) ?? 0
                print("[LitertLm] Loading model from: \(resolvedPath) (\(fileSize / 1_000_000)MB)")

                self.notifyLoadProgress(0.3)

                let options = LlmInference.Options(modelPath: resolvedPath)
                options.maxTokens = call.getInt("maxTokens") ?? 1024

                self.notifyLoadProgress(0.5)

                let inference = try LlmInference(options: options)

                self.notifyLoadProgress(1.0)

                self.llmInference = inference
                self.status = "ready"

                print("[LitertLm] Model loaded successfully")
                call.resolve(["ok": true])
            } catch {
                print("[LitertLm] Failed to load model: \(error)")
                self.status = "error"
                self.errorMessage = error.localizedDescription
                self.notifyError(self.errorMessage)
                call.resolve(["ok": false])
            }
        }
    }

    // MARK: - Status

    @objc func getStatus(_ call: CAPPluginCall) {
        call.resolve([
            "status": status,
            "modelName": modelName,
            "errorMessage": errorMessage,
        ])
    }

    // MARK: - Conversation

    @objc func createConversation(_ call: CAPPluginCall) {
        guard llmInference != nil, status == "ready" else {
            call.reject("Model not loaded")
            return
        }

        nextConversationId += 1
        let id = String(nextConversationId)
        conversations[id] = []

        call.resolve(["conversationId": id])
    }

    @objc func sendMessage(_ call: CAPPluginCall) {
        guard let conversationId = call.getString("conversationId"),
              let message = call.getString("message") else {
            call.reject("conversationId and message are required")
            return
        }

        guard let llm = llmInference, status == "ready" else {
            call.reject("No active conversation")
            return
        }

        guard var history = conversations[conversationId] else {
            call.reject("Unknown conversation: \(conversationId)")
            return
        }

        // Add user message to history
        history.append(ChatEntry(role: "user", content: message))
        conversations[conversationId] = history

        // Build Gemma 4 prompt
        let prompt = buildPrompt(history: history)

        status = "generating"

        // Use the legacy LlmInference API with callback-based streaming.
        // The Session API requires async/await context; the legacy API
        // uses callbacks and works from any thread.
        do {
            var fullResponse = ""

            try llm.generateResponseAsync(
                inputText: prompt,
                progress: { [weak self] partialResponse, error in
                    guard let self = self else { return }

                    if let error = error {
                        print("[LitertLm] Streaming error: \(error)")
                        return
                    }

                    guard let partial = partialResponse else { return }

                    // Detect cumulative vs individual tokens
                    let newToken: String
                    if partial.hasPrefix(fullResponse) && partial.count > fullResponse.count {
                        newToken = String(partial.dropFirst(fullResponse.count))
                        fullResponse = partial
                    } else {
                        newToken = partial
                        fullResponse += partial
                    }

                    if !newToken.isEmpty {
                        self.notifyListeners("tokenReceived", data: [
                            "conversationId": conversationId,
                            "token": newToken,
                            "done": false,
                        ])
                    }
                },
                completion: { [weak self] in
                    guard let self = self else { return }

                    // Signal completion
                    self.notifyListeners("tokenReceived", data: [
                        "conversationId": conversationId,
                        "token": "",
                        "done": true,
                    ])

                    // Store assistant response
                    history.append(ChatEntry(role: "model", content: fullResponse))
                    self.conversations[conversationId] = history

                    self.status = "ready"
                    call.resolve(["ok": true])
                }
            )
        } catch {
            print("[LitertLm] Inference failed: \(error)")
            self.status = "error"
            self.errorMessage = error.localizedDescription
            self.notifyError(self.errorMessage)
            call.resolve(["ok": false])
        }
    }

    // MARK: - Dispose

    @objc func dispose(_ call: CAPPluginCall) {
        downloadTask?.cancel()
        downloadTask = nil
        downloadSession?.invalidateAndCancel()
        downloadSession = nil
        downloadDelegate = nil
        llmInference = nil
        conversations.removeAll()
        status = "idle"
        modelName = ""
        errorMessage = ""
        call.resolve(["ok": true])
    }

    // MARK: - Helpers

    /// Build a Gemma 4 chat prompt from conversation history.
    private func buildPrompt(history: [ChatEntry]) -> String {
        var prompt = ""
        for entry in history {
            prompt += "<|turn>\(entry.role)\n\(entry.content)<turn|>\n"
        }
        prompt += "<|turn>model\n"
        return prompt
    }

    func notifyLoadProgress(_ progress: Double) {
        notifyListeners("loadProgress", data: ["progress": progress])
    }

    private func notifyError(_ message: String) {
        notifyListeners("error", data: ["message": message])
    }
}

// MARK: - Download Delegate

/// URLSession delegate that tracks download progress and moves the file on completion.
private class DownloadDelegate: NSObject, URLSessionDownloadDelegate {
    weak var plugin: LitertLmPlugin?
    let call: CAPPluginCall
    let destFile: URL

    init(plugin: LitertLmPlugin, call: CAPPluginCall, destFile: URL) {
        self.plugin = plugin
        self.call = call
        self.destFile = destFile
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didWriteData bytesWritten: Int64, totalBytesWritten: Int64,
                    totalBytesExpectedToWrite: Int64) {
        let progress: Double
        if totalBytesExpectedToWrite > 0 {
            progress = min(Double(totalBytesWritten) / Double(totalBytesExpectedToWrite), 0.99)
        } else {
            progress = 0.0
        }
        plugin?.notifyLoadProgress(progress)
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didFinishDownloadingTo location: URL) {
        do {
            // Remove existing file if any
            if FileManager.default.fileExists(atPath: destFile.path) {
                try FileManager.default.removeItem(at: destFile)
            }
            try FileManager.default.moveItem(at: location, to: destFile)

            let size = (try? FileManager.default.attributesOfItem(atPath: destFile.path)[.size] as? Int64) ?? 0
            print("[LitertLm] Download complete: \(destFile.path) (\(size / 1_000_000)MB)")
            plugin?.notifyLoadProgress(1.0)

            call.resolve(["ok": true, "path": destFile.path])
        } catch {
            print("[LitertLm] Failed to move downloaded file: \(error)")
            call.resolve(["ok": false, "path": ""])
        }
        cleanup(session)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error = error {
            print("[LitertLm] Download error: \(error)")
            plugin?.notifyListeners("error", data: ["message": "Download failed: \(error.localizedDescription)"])
            call.resolve(["ok": false, "path": ""])
            cleanup(session)
        }
    }

    private func cleanup(_ session: URLSession) {
        session.invalidateAndCancel()
        plugin?.downloadSession = nil
        plugin?.downloadDelegate = nil
    }
}
