import Foundation

public struct Segment: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let startMs: Double
    public let durationMs: Double
    public let text: String

    public var timestamp: String {
        let seconds = Int(max(0, startMs) / 1_000)
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
}

public enum SummaryKind: String, Codable, Sendable {
    case extractive, ai, opencode
}

public enum SummaryResultKind: String, Codable, Sendable {
    case extractive, ai
}

public struct SummaryModel: Codable, Hashable, Sendable {
    public let id: String
    public let providerID: String
    public let variant: String?

    public init(id: String, providerID: String, variant: String? = nil) {
        self.id = id
        self.providerID = providerID
        self.variant = variant
    }
}

public struct OpenCodeSummaryOptions: Codable, Equatable, Sendable {
    public let agentID: String
    public let model: SummaryModel
    public let consent: Bool

    public init(agentID: String, model: SummaryModel) {
        self.agentID = agentID
        self.model = model
        self.consent = true
    }

    private enum CodingKeys: String, CodingKey { case agentID, model, consent }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        agentID = try values.decode(String.self, forKey: .agentID)
        model = try values.decode(SummaryModel.self, forKey: .model)
        consent = try values.decode(Bool.self, forKey: .consent)
        guard consent else {
            throw DecodingError.dataCorruptedError(forKey: .consent, in: values, debugDescription: "OpenCode summary consent must be true.")
        }
    }
}

public struct OpenCodeSummaryCatalog: Codable, Equatable, Sendable {
    public struct Agent: Codable, Equatable, Identifiable, Sendable {
        public let id: String
        public let name: String
        public let description: String?
    }

    public struct Model: Codable, Equatable, Sendable {
        public let id: String
        public let providerID: String
        public let name: String
        public let variants: [String]

        public var summaryModel: SummaryModel { SummaryModel(id: id, providerID: providerID) }
    }

    public let available: Bool
    public let message: String
    public let agents: [Agent]
    public let models: [Model]

    public func contains(_ options: OpenCodeSummaryOptions) -> Bool {
        available && agents.contains { $0.id == options.agentID }
            && models.contains { model in
                model.id == options.model.id && model.providerID == options.model.providerID
                    && (options.model.variant.map { model.variants.contains($0) } ?? true)
            }
    }

    public func selection(preserving previous: OpenCodeSummaryOptions?) -> OpenCodeSummaryOptions? {
        guard available, let firstAgent = agents.first, let firstModel = models.first else { return nil }
        let agent = agents.first { $0.id == previous?.agentID }
            ?? agents.first { $0.id == "moss-summary" } ?? firstAgent
        let model = models.first { $0.id == previous?.model.id && $0.providerID == previous?.model.providerID } ?? firstModel
        let variant = previous?.model.variant.flatMap { model.variants.contains($0) ? $0 : nil }
        return OpenCodeSummaryOptions(agentID: agent.id, model: SummaryModel(id: model.id, providerID: model.providerID, variant: variant))
    }
}

public struct OpenCodeSummaryProvenance: Codable, Equatable, Sendable {
    public let agentID: String
    public let model: SummaryModel
}

public struct MeetingSummary: Codable, Equatable, Sendable {
    public let markdown: String
    public let kind: SummaryResultKind
    public let sourceRevision: Int
    public let opencode: OpenCodeSummaryProvenance?

    public init(markdown: String, kind: SummaryResultKind, sourceRevision: Int, opencode: OpenCodeSummaryProvenance? = nil) {
        self.markdown = markdown
        self.kind = kind
        self.sourceRevision = sourceRevision
        self.opencode = opencode
    }
}

public struct Meeting: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let createdAt: String
    public let updatedAt: String
    public let notes: String
    public let revision: Int
    public let segments: [Segment]
    public let summary: MeetingSummary?
    public var agentWork: [AgentWork]? = nil

    public var summaryIsStale: Bool {
        summary.map { $0.sourceRevision != revision } ?? false
    }
}

public struct Health: Codable, Equatable, Sendable {
    public struct Hex: Codable, Equatable, Sendable {
        public enum State: String, Codable, Sendable {
            case unavailable, idle, preparing, ready, error
        }
        public let state: State
        public let model: String
        public let message: String
    }

    public struct AI: Codable, Equatable, Sendable {
        public let configured: Bool
        public let remote: Bool
    }

    public let name: String
    public let apiVersion: Int
    public let hex: Hex
    public let ai: AI
    public var audioImport: AudioImportHealth? = nil
}

public struct MeetingPatch: Encodable, Equatable, Sendable {
    public struct Expected: Encodable, Equatable, Sendable {
        public let title: String?
        public let notes: String?

        public init(title: String? = nil, notes: String? = nil) {
            self.title = title
            self.notes = notes
        }
    }

    public let title: String?
    public let notes: String?
    public let expected: Expected

    public init(title: String? = nil, notes: String? = nil, expected: Expected) {
        self.title = title
        self.notes = notes
        self.expected = expected
    }
}
