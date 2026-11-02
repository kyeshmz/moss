import Foundation

struct StoredDraft: Codable, Equatable, Sendable {
    let meetingID: String
    let draft: MeetingDraft
    let hasConflict: Bool
}

public struct DraftStore: Sendable {
    public static var application: DraftStore {
        DraftStore(fileURL: URL.applicationSupportDirectory.appendingPathComponent("Moss/NativeDrafts/drafts.json"))
    }

    static let maximumFileBytes = 16 * 1_024 * 1_024
    static let maximumDrafts = 100
    public let fileURL: URL

    private struct Archive: Codable {
        let version: Int
        let records: [StoredDraft]
    }

    public init(fileURL: URL) { self.fileURL = fileURL }

    func load() throws -> [StoredDraft] {
        let manager = FileManager.default
        guard manager.fileExists(atPath: fileURL.path) else { return [] }
        try checkFile()
        let data = try Data(contentsOf: fileURL)
        guard data.count <= Self.maximumFileBytes else { throw invalidArchive() }
        let archive = try JSONDecoder().decode(Archive.self, from: data)
        guard archive.version == 1 else { throw invalidArchive() }
        try validate(archive.records)
        return archive.records
    }

    func save(_ records: [StoredDraft]) throws {
        try validate(records)
        let data = try JSONEncoder().encode(Archive(version: 1, records: records))
        guard data.count <= Self.maximumFileBytes else { throw invalidArchive() }
        let manager = FileManager.default
        let directory = fileURL.deletingLastPathComponent()
        try manager.createDirectory(at: directory, withIntermediateDirectories: true,
                                    attributes: [.posixPermissions: 0o700])
        let attributes = try manager.attributesOfItem(atPath: directory.path)
        guard attributes[.type] as? FileAttributeType == .typeDirectory else { throw invalidArchive() }
        try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        if manager.fileExists(atPath: fileURL.path) { try checkFile() }
        try data.write(to: fileURL, options: .atomic)
        try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
        let handle = try FileHandle(forWritingTo: fileURL)
        defer { try? handle.close() }
        try handle.synchronize()
    }

    private func checkFile() throws {
        let attributes = try FileManager.default.attributesOfItem(atPath: fileURL.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              let size = attributes[.size] as? NSNumber, size.intValue <= Self.maximumFileBytes else {
            throw invalidArchive()
        }
    }

    private func validate(_ records: [StoredDraft]) throws {
        guard records.count <= Self.maximumDrafts,
              Set(records.map(\.meetingID)).count == records.count,
              records.allSatisfy({ UUID(uuidString: $0.meetingID) != nil && $0.draft.isDirty && $0.draft.isValidForPersistence }) else {
            throw invalidArchive()
        }
    }

    private func invalidArchive() -> APIError {
        APIError(message: "The native draft file is invalid or exceeds its recovery limits. The existing file was left untouched.")
    }
}
