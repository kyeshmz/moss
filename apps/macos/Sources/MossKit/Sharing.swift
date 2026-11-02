import Foundation

public enum ContentSource: String, Codable, CaseIterable, Sendable {
    case meeting, notes, transcript, summary

    public var label: String {
        switch self {
        case .meeting: "Whole meeting"
        case .notes: "Notes"
        case .transcript: "Transcript"
        case .summary: "Current summary"
        }
    }
}

public enum ExportFormat: String, Codable, CaseIterable, Sendable {
    case markdown, text, json
    public var label: String {
        switch self {
        case .markdown: "Markdown"
        case .text: "Plain text"
        case .json: "JSON"
        }
    }
    public var fileExtension: String {
        switch self {
        case .markdown: "md"
        case .text: "txt"
        case .json: "json"
        }
    }
}

public struct AgentWorkOptions: Encodable, Equatable, Sendable {
    public let source: ContentSource
    public let instruction: String
    public let requestID: String
    public let agentID: String
    public let model: SummaryModel
    public let consent = true

    public init(source: ContentSource, instruction: String, requestID: UUID = UUID(), selection: OpenCodeSummaryOptions) {
        self.source = source
        self.instruction = instruction
        self.requestID = requestID.uuidString
        agentID = selection.agentID
        model = selection.model
    }

    public var selection: OpenCodeSummaryOptions { .init(agentID: agentID, model: model) }
}

public struct AgentWork: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let source: ContentSource
    public let instruction: String
    public let markdown: String
    public let sourceRevision: Int
    public let agentID: String
    public let model: SummaryModel
    public let createdAt: String

    public func writeMarkdown(to url: URL) throws {
        try Data(markdown.utf8).write(to: url, options: .withoutOverwriting)
    }
}

public struct DriveCatalog: Codable, Equatable, Sendable {
    public struct Server: Codable, Equatable, Sendable {
        public enum Status: String, Codable, Sendable { case connected, pending, disabled, failed, needs_auth }
        public let name: String
        public let title: String?
        public let status: Status
    }
    public let available: Bool
    public let message: String
    public let servers: [Server]
}

public struct DriveConnectionOptions: Encodable, Equatable, Sendable {
    public let server: String
    public let url: String?
    public let consent = true

    public init(server: String, url: String? = nil) throws {
        guard !server.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw APIError(message: "Choose a configured server or enter a new server name.")
        }
        if let url {
            guard let parsed = URLComponents(string: url), parsed.scheme == "https", parsed.host?.isEmpty == false,
                  parsed.user == nil, parsed.password == nil, parsed.query == nil, parsed.fragment == nil else {
                throw APIError(message: "Use an HTTPS MCP endpoint without credentials, query, or fragment. No endpoint is supplied automatically.")
            }
        }
        self.server = server
        self.url = url
    }
}

public struct DriveExportOptions: Encodable, Equatable, Sendable {
    public let server: String
    public let source: ContentSource
    public let folderID: String?
    public let agentID: String
    public let model: SummaryModel
    public let consent = true

    public init(server: String, source: ContentSource, folderID: String? = nil, selection: OpenCodeSummaryOptions) {
        self.server = server
        self.source = source
        self.folderID = folderID
        agentID = selection.agentID
        model = selection.model
    }
    public var selection: OpenCodeSummaryOptions { .init(agentID: agentID, model: model) }
}

public struct DriveExportHandoff: Codable, Equatable, Sendable {
    public enum Status: String, Codable, Sendable { case submitted }
    public let sessionID: String
    public let status: Status
    public let message: String
}

public struct AudioImportHealth: Codable, Equatable, Sendable {
    public let available: Bool
    public let message: String
    public let formats: [String]
    public let maxBytes: Int
    public let maxDurationMs: Int
}

public struct ChosenAudioFile: Equatable, Sendable {
    public static let maximumBytes = 100 * 1_024 * 1_024
    public let meetingID: String
    public let filename: String
    public let bytes: Data

    public init(meetingID: String, filename: String, bytes: Data) throws {
        guard !bytes.isEmpty, bytes.count <= Self.maximumBytes else {
            throw APIError(message: "Choose one nonempty audio file no larger than 100 MiB.")
        }
        self.meetingID = meetingID
        self.filename = filename
        self.bytes = bytes
    }

    public static func read(meetingID: String, url: URL) throws -> Self {
        guard url.isFileURL else { throw APIError(message: "Drop a local audio file, not a web address.") }
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
        guard values.isRegularFile == true, let size = values.fileSize, size > 0, size <= maximumBytes else {
            throw APIError(message: "Choose one regular audio file no larger than 100 MiB.")
        }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let bytes = try handle.read(upToCount: maximumBytes + 1) ?? Data()
        return try Self(meetingID: meetingID, filename: url.lastPathComponent, bytes: bytes)
    }
}

public struct ContentSnapshot: Equatable, Sendable {
    public let source: ContentSource
    public let content: String
    private let original: Meeting

    public init(meeting: Meeting, source: ContentSource) {
        self.source = source
        original = meeting
        let transcript = meeting.segments.map(\.text).joined(separator: "\n\n")
        switch source {
        case .notes: content = meeting.notes
        case .transcript: content = transcript
        case .summary: content = meeting.summary?.markdown ?? ""
        case .meeting:
            let timedTranscript = meeting.segments.map { "[\($0.timestamp)] \($0.text)" }.joined(separator: "\n\n")
            let attribution = meeting.summary?.opencode.map { "OpenCode agent \($0.agentID), model \($0.model.providerID)/\($0.model.id)\($0.model.variant.map { " (\($0))" } ?? "")\n\n" } ?? ""
            let work = meeting.agentWork?.map { "### \($0.instruction)\n\n\($0.markdown)" }.joined(separator: "\n\n") ?? ""
            content = "# \(meeting.title)\n\n\(meeting.createdAt)\n\n## My notes\n\n\(meeting.notes)\n\n## Current summary\(meeting.summaryIsStale ? " (out of date)" : "")\n\n\(attribution)\(meeting.summary?.markdown ?? "")\n\n## Transcript\n\n\(timedTranscript)\(work.isEmpty ? "" : "\n\n## Agent results\n\n" + work)"
        }
    }

    public func matches(_ meeting: Meeting) -> Bool {
        if source == .meeting {
            return original.title == meeting.title && original.createdAt == meeting.createdAt
                && original.notes == meeting.notes && original.summary == meeting.summary
                && original.summaryIsStale == meeting.summaryIsStale && original.segments == meeting.segments && original.agentWork == meeting.agentWork
        }
        return content == ContentSnapshot(meeting: meeting, source: source).content
    }
}

public struct AgentWorkConfirmation: Equatable, Identifiable, Sendable {
    public var id: String { options.requestID }
    public let meetingID: String
    public let options: AgentWorkOptions
    public let snapshot: ContentSnapshot
    public init(meeting: Meeting, options: AgentWorkOptions) {
        meetingID = meeting.id
        self.options = options
        snapshot = ContentSnapshot(meeting: meeting, source: options.source)
    }
    public var disclosure: String { providerDisclosure(agent: options.agentID, model: options.model) }
}

public struct DriveExportConfirmation: Equatable, Identifiable, Sendable {
    public let id = UUID()
    public let meetingID: String
    public let options: DriveExportOptions
    public let snapshot: ContentSnapshot
    public init(meeting: Meeting, options: DriveExportOptions) {
        meetingID = meeting.id
        self.options = options
        snapshot = ContentSnapshot(meeting: meeting, source: options.source)
    }
    public var disclosure: String {
        providerDisclosure(agent: options.agentID, model: options.model)
            + "\n\nThis submits a request to create a Markdown file using MCP server \(options.server). Open OpenCode, approve the selected Drive tools, and verify the resulting file. Submission is not proof of upload. No tool write is automatically approved. Only native MCP actions for this selected server can ask for approval. Execute and Code Mode are denied. Existing servers need codemode:false in OpenCode."
    }
}

private func providerDisclosure(agent: String, model: SummaryModel) -> String {
    "Agent \(agent) · Model \(model.providerID)/\(model.id)\(model.variant.map { " · Variant \($0)" } ?? "")\n\nSelected content and instructions remain in OpenCode session history and may be sent to the model's provider (\(model.providerID)). Continue only with participant permission. The service reads the saved source at submission. Review the content below; originals are never replaced by agent results."
}
