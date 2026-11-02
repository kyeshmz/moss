import Foundation

public struct APIError: LocalizedError, Sendable {
    public let message: String
    public let statusCode: Int?
    public init(message: String, statusCode: Int? = nil) { self.message = message; self.statusCode = statusCode }
    public var errorDescription: String? { message }
}

private final class LocalSessionDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

public struct APIClient: Sendable {
    public static let origin = URL(string: "http://127.0.0.1:4310/api")!
    private static let summaryTimeout: TimeInterval = 150
    private static let localSession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpShouldSetCookies = false
        return URLSession(configuration: configuration, delegate: LocalSessionDelegate(), delegateQueue: nil)
    }()
    private let session: URLSession
    private let audioImportTimeout: TimeInterval

    public init(session: URLSession? = nil, audioImportTimeout: TimeInterval = 1_800) {
        self.session = session ?? Self.localSession
        self.audioImportTimeout = audioImportTimeout
    }

    public func health() async throws -> Health {
        try await json("health")
    }

    public func prepareEngine() async throws -> Health {
        try await json("engine/prepare", method: "POST", body: Data("{}".utf8), timeout: 900)
    }

    public func meetings() async throws -> [Meeting] {
        try await json("meetings")
    }

    public func createMeeting() async throws -> Meeting {
        try await json("meetings", method: "POST", body: Data("{}".utf8))
    }

    public func updateMeeting(_ id: String, patch: MeetingPatch) async throws -> Meeting {
        try await json("meetings/\(id)", method: "PATCH", body: JSONEncoder().encode(patch))
    }

    public func deleteMeeting(_ id: String) async throws {
        struct Result: Decodable { let ok: Bool }
        let result: Result = try await json("meetings/\(id)", method: "DELETE")
        guard result.ok else { throw APIError(message: "The service did not delete the meeting.") }
    }

    public func importTranscript(_ id: String, text: String) async throws -> Meeting {
        struct Import: Encodable { let text: String }
        return try await json("meetings/\(id)/transcript", method: "POST", body: JSONEncoder().encode(Import(text: text)))
    }

    public func opencodeSummaryCatalog() async throws -> OpenCodeSummaryCatalog {
        try await json("summary/opencode")
    }

    public func summarize(_ id: String, kind: SummaryKind, options: OpenCodeSummaryOptions? = nil) async throws -> Meeting {
        guard (kind == .opencode) == (options != nil) else {
            throw APIError(message: "OpenCode summaries require a confirmed agent and model selection. Other summary kinds do not accept OpenCode options.")
        }
        struct SummaryRequest: Encodable {
            let kind: SummaryKind
            let agentID: String?
            let model: SummaryModel?
            let consent: Bool?
        }
        let body = SummaryRequest(kind: kind, agentID: options?.agentID, model: options?.model, consent: options?.consent)
        let encoded = try JSONEncoder().encode(body)
        return try await withThrowingTaskGroup(of: Meeting.self) { group in
            group.addTask {
                try await json("meetings/\(id)/summary", method: "POST", body: encoded, timeout: Self.summaryTimeout)
            }
            group.addTask {
                try await Task.sleep(for: .seconds(Self.summaryTimeout))
                throw URLError(.timedOut)
            }
            defer { group.cancelAll() }
            return try await group.next()!
        }
    }

    public func uploadAudio(_ id: String, chunk: AudioChunk) async throws -> Meeting {
        let data = try await request("meetings/\(id)/audio", method: "POST", body: chunk.wav,
                                     contentType: "audio/wav", timeout: 300,
                                     headers: ["X-Chunk-Id": chunk.id.uuidString, "X-Start-Ms": String(chunk.startMs)])
        return try JSONDecoder().decode(Meeting.self, from: data)
    }

    public func exportMarkdown(_ id: String) async throws -> String {
        let data = try await request("meetings/\(id)/export")
        guard let markdown = String(data: data, encoding: .utf8) else {
            throw APIError(message: "The service returned invalid Markdown.")
        }
        return markdown
    }

    public func export(_ id: String, format: ExportFormat) async throws -> Data {
        try await request("meetings/\(id)/export", query: [URLQueryItem(name: "format", value: format.rawValue)])
    }

    public func importAudioFile(_ file: ChosenAudioFile, consent: Bool) async throws -> Meeting {
        guard consent else { throw APIError(message: "Participant consent is required before audio transcription.") }
        let filename = file.filename.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~")) ?? "audio"
        let data = try await boundedRequest("meetings/\(file.meetingID)/audio-file", body: file.bytes,
                                            contentType: "application/octet-stream", timeout: audioImportTimeout,
                                            headers: ["X-Audio-Consent": "1", "X-File-Name": filename])
        return try JSONDecoder().decode(Meeting.self, from: data)
    }

    public func agentWork(_ id: String, options: AgentWorkOptions) async throws -> Meeting {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let data = try await boundedRequest("meetings/\(id)/agent-work", body: encoder.encode(options), timeout: 150)
        return try JSONDecoder().decode(Meeting.self, from: data)
    }

    public func driveCatalog() async throws -> DriveCatalog { try await json("drive") }

    public func connectDrive(_ options: DriveConnectionOptions) async throws -> DriveCatalog {
        try await json("drive/connect", method: "POST", body: JSONEncoder().encode(options), timeout: 150)
    }

    public func exportDrive(_ id: String, options: DriveExportOptions) async throws -> DriveExportHandoff {
        let data = try await boundedRequest("meetings/\(id)/drive-export", body: JSONEncoder().encode(options), timeout: 150)
        return try JSONDecoder().decode(DriveExportHandoff.self, from: data)
    }

    private func boundedRequest(_ path: String, body: Data, contentType: String = "application/json",
                                timeout: TimeInterval, headers: [String: String] = [:]) async throws -> Data {
        try await withThrowingTaskGroup(of: Data.self) { group in
            group.addTask { try await request(path, method: "POST", body: body, contentType: contentType, timeout: timeout, headers: headers) }
            group.addTask { try await Task.sleep(for: .seconds(timeout)); throw URLError(.timedOut) }
            defer { group.cancelAll() }
            return try await group.next()!
        }
    }

    private func json<T: Decodable>(_ path: String, method: String = "GET", body: Data? = nil,
                                    timeout: TimeInterval = 30) async throws -> T {
        let data = try await request(path, method: method, body: body, timeout: timeout)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func request(_ path: String, method: String = "GET", body: Data? = nil,
                         contentType: String = "application/json", timeout: TimeInterval = 30,
                         headers: [String: String] = [:], query: [URLQueryItem] = []) async throws -> Data {
        var url = URLComponents(url: Self.origin.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { url.queryItems = query }
        var request = URLRequest(url: url.url!)
        request.httpMethod = method
        request.httpBody = body
        request.timeoutInterval = timeout
        request.setValue("1", forHTTPHeaderField: "X-Moss-Client")
        request.setValue("application/json, text/markdown, text/plain", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError(message: "The local service did not return an HTTP response.")
        }
        guard (200..<300).contains(http.statusCode) else {
            struct Failure: Decodable { let error: String }
            let detail = (try? JSONDecoder().decode(Failure.self, from: data).error)
                ?? "Local service request failed (HTTP \(http.statusCode))."
            throw APIError(message: detail, statusCode: http.statusCode)
        }
        return data
    }
}
