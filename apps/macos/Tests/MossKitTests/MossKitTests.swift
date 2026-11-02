import Foundation
import Testing
@testable import MossKit

private struct StubResponse: Sendable {
    let status: Int
    let data: Data
    init(_ data: Data, status: Int = 200) { self.data = data; self.status = status }
}

private final class StubState: @unchecked Sendable {
    private let lock = NSLock()
    private var requests: [URLRequest] = []
    private var handler: (@Sendable (URLRequest) throws -> StubResponse)?

    func reset(_ handler: @escaping @Sendable (URLRequest) throws -> StubResponse) {
        lock.withLock { self.handler = handler; requests = [] }
    }

    func respond(_ request: URLRequest) throws -> StubResponse {
        var captured = request
        if captured.httpBody == nil, let stream = captured.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var data = Data()
            var bytes = [UInt8](repeating: 0, count: 4_096)
            while stream.hasBytesAvailable {
                let count = stream.read(&bytes, maxLength: bytes.count)
                if count <= 0 { break }
                data.append(contentsOf: bytes.prefix(count))
            }
            captured.httpBody = data
        }
        let callback = lock.withLock { requests.append(captured); return handler }
        guard let callback else { throw URLError(.badServerResponse) }
        return try callback(captured)
    }

    var recorded: [URLRequest] { lock.withLock { requests } }
}

private final class StubProtocol: URLProtocol, @unchecked Sendable {
    static let state = StubState()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let result = try Self.state.respond(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: result.status,
                                           httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: result.data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() { }
}

private func fixtureData() throws -> Data {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { root.deleteLastPathComponent() }
    return try Data(contentsOf: root.appendingPathComponent("packages/contracts/fixtures/meeting.json"))
}

private let opencodeCatalogData = Data(#"""
{"available":true,"message":"Choose a server model.","agents":[{"id":"general","name":"General"},{"id":"moss-summary","name":"Moss summary","description":"Summarizes meeting notes."}],"models":[{"id":"chat-model","providerID":"test-a","name":"Chat A","variants":["high","low"]},{"id":"chat-model","providerID":"test-b","name":"Chat B","variants":["fast"]}]}
"""#.utf8)

private func fixture(_ changes: [String: Any] = [:]) throws -> Meeting {
    let data = try changedFixture(changes)
    return try JSONDecoder().decode(Meeting.self, from: data)
}

private func changedFixture(_ changes: [String: Any]) throws -> Data {
    var object = try #require(JSONSerialization.jsonObject(with: fixtureData()) as? [String: Any])
    for (key, value) in changes { object[key] = value }
    return try JSONSerialization.data(withJSONObject: object)
}

private func client(_ handler: @escaping @Sendable (URLRequest) throws -> StubResponse) -> APIClient {
    StubProtocol.state.reset(handler)
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StubProtocol.self]
    return APIClient(session: URLSession(configuration: configuration))
}

private func temporaryDraftStore() -> DraftStore {
    let package = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent()
    return DraftStore(fileURL: package.appendingPathComponent(".build/draft-tests/\(UUID().uuidString)/drafts.json"))
}

private final class RequestGate: Sendable {
    let arrived = AsyncStream<Void>.makeStream()
    let release = DispatchSemaphore(value: 0)

    func waitForRelease() throws {
        arrived.continuation.yield(())
        guard release.wait(timeout: .now() + 5) == .success else { throw URLError(.timedOut) }
    }
}

private final class SuspendedRequests: @unchecked Sendable {
    private let lock = NSLock()
    private var event = AsyncStream<Void>.makeStream()
    private var stopped = AsyncStream<Void>.makeStream()
    func reset() { lock.withLock { event = AsyncStream<Void>.makeStream(); stopped = AsyncStream<Void>.makeStream() } }
    var stream: AsyncStream<Void> { lock.withLock { event.stream } }
    func start() { lock.withLock { _ = event.continuation.yield(()) } }
    func stop() { lock.withLock { _ = stopped.continuation.yield(()) } }

    func waitForStop() async throws -> Bool {
        let stream = lock.withLock { stopped.stream }
        return try await withThrowingTaskGroup(of: Bool.self) { group in
            group.addTask { for await _ in stream { return true }; return false }
            group.addTask { try await Task.sleep(for: .seconds(2)); throw URLError(.timedOut) }
            defer { group.cancelAll() }
            return try await group.next()!
        }
    }
}

private final class SuspendedAudioProtocol: URLProtocol, @unchecked Sendable {
    static let events = SuspendedRequests()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let result = try StubProtocol.state.respond(request)
            if request.url?.path.hasSuffix("/audio-file") == true {
                Self.events.start()
                return
            }
            let response = HTTPURLResponse(url: request.url!, statusCode: result.status, httpVersion: "HTTP/1.1", headerFields: [:])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: result.data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() { Self.events.stop() }
}

private func audioTestFile(_ data: Data = Data([1, 2, 3, 4])) throws -> URL {
    let directory = temporaryDraftStore().fileURL.deletingLastPathComponent()
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let url = directory.appendingPathComponent("音声 consent #1.m4a")
    try data.write(to: url, options: .withoutOverwriting)
    return url
}

private let driveCatalogData = Data(#"{"available":true,"message":"Use OpenCode /mcps to authenticate.","servers":[{"name":"chosen-drive","title":"User selected Drive","status":"connected"},{"name":"other-service","status":"needs_auth"}]}"#.utf8)
private let driveHandoffData = Data(#"{"sessionID":"ses_fixture_only","status":"submitted","message":"Open OpenCode to approve Drive tools and verify the file."}"#.utf8)
private let readyHealthData = Data(#"{"name":"Moss","apiVersion":1,"hex":{"state":"ready","model":"fixture","message":"Ready"},"ai":{"configured":false,"remote":false},"audioImport":{"available":true,"message":"Local ffmpeg ready","formats":["wav","m4a"],"maxBytes":104857600,"maxDurationMs":7200000}}"#.utf8)

private func requestBody(_ request: URLRequest) throws -> [String: Any] {
    let data = try #require(request.httpBody)
    return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
}

private final class EditingService: @unchecked Sendable {
    private let lock = NSLock()
    private var meeting: Meeting
    private var failing = false
    private var nextConcurrentNotes: String?

    init(_ meeting: Meeting) { self.meeting = meeting }
    var current: Meeting { lock.withLock { meeting } }
    func failSaves(_ value: Bool) { lock.withLock { failing = value } }
    func changeNotesBeforeNextPatch(_ value: String) { lock.withLock { nextConcurrentNotes = value } }

    func respond(_ request: URLRequest) throws -> StubResponse {
        try lock.withLock {
            if request.url?.path == "/api/health" {
                return StubResponse(Data(#"{"error":"No engine needed for editing tests"}"#.utf8), status: 503)
            }
            if request.httpMethod == "GET" { return StubResponse(try JSONEncoder().encode([meeting])) }
            guard request.httpMethod == "PATCH" else { throw URLError(.unsupportedURL) }
            if failing { return StubResponse(Data(#"{"error":"Disk is full"}"#.utf8), status: 500) }
            var object = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(meeting)) as? [String: Any])
            if let notes = nextConcurrentNotes {
                object["notes"] = notes
                object["revision"] = meeting.revision + 1
                meeting = try JSONDecoder().decode(Meeting.self, from: JSONSerialization.data(withJSONObject: object))
                nextConcurrentNotes = nil
            }
            let body = try #require(request.httpBody)
            let patch = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
            let expected = try #require(patch["expected"] as? [String: String])
            for field in ["title", "notes"] where patch[field] != nil {
                guard expected[field] == object[field] as? String else {
                    return StubResponse(Data(#"{"error":"These fields changed in another client."}"#.utf8), status: 409)
                }
            }
            for field in ["title", "notes"] where patch[field] != nil { object[field] = patch[field] }
            object["revision"] = meeting.revision + 1
            let data = try JSONSerialization.data(withJSONObject: object)
            meeting = try JSONDecoder().decode(Meeting.self, from: data)
            return StubResponse(data)
        }
    }
}

@Suite(.serialized)
struct MossKitTests {
    @Test func sharedWireFixtureDecodesExactly() throws {
        let meeting = try JSONDecoder().decode(Meeting.self, from: fixtureData())
        #expect(meeting.id == "be197276-e0d0-42f7-9b58-c4d3ed567b8e")
        #expect(meeting.title == "Contract fixture")
        #expect(meeting.notes == "An explicit test fixture, never seeded into user data.")
        #expect(meeting.createdAt == "2026-11-02T12:00:00.000Z")
        #expect(meeting.updatedAt == "2026-11-02T12:01:00.000Z")
        #expect(meeting.revision == 2)
        #expect(meeting.segments.count == 1)
        #expect(meeting.segments[0].durationMs == 20_000)
        #expect(meeting.segments[0].text == "We will review the prototype on Friday.")
        #expect(meeting.segments[0].timestamp == "0:00")
        #expect(meeting.summary?.kind == .extractive)
        #expect(meeting.summary?.sourceRevision == 2)
        #expect(meeting.summary?.opencode == nil)
        #expect(!meeting.summaryIsStale)
        let roundtrip = try JSONDecoder().decode(Meeting.self, from: JSONEncoder().encode(meeting))
        #expect(roundtrip == meeting)
        #expect(try fixture(["summary": NSNull()]).summary == nil)
        #expect(try fixture(["revision": 3]).summaryIsStale)
    }

    @Test func opencodeWireTypesRoundtripAndResultKindStaysAI() throws {
        let catalog = try JSONDecoder().decode(OpenCodeSummaryCatalog.self, from: opencodeCatalogData)
        #expect(catalog.available)
        #expect(catalog.agents[0].description == nil)
        #expect(catalog.agents[1].description == "Summarizes meeting notes.")
        #expect(catalog.models.map(\.providerID) == ["test-a", "test-b"])
        #expect(catalog.models[0].variants == ["high", "low"])
        #expect(try JSONDecoder().decode(OpenCodeSummaryCatalog.self, from: JSONEncoder().encode(catalog)) == catalog)
        let selection = try #require(catalog.selection(preserving: nil))
        #expect(selection.agentID == "moss-summary")
        #expect(selection.model == SummaryModel(id: "chat-model", providerID: "test-a"))
        #expect(selection.consent)
        #expect(try JSONDecoder().decode(OpenCodeSummaryOptions.self, from: JSONEncoder().encode(selection)) == selection)
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(OpenCodeSummaryOptions.self, from: Data(#"{"agentID":"general","model":{"id":"chat-model","providerID":"test-a"},"consent":false}"#.utf8))
        }
        for variant in [String?.none, "high"] {
            var model: [String: String] = ["id": "chat-model", "providerID": "test-a"]
            if let variant { model["variant"] = variant }
            let meeting = try fixture(["summary": ["markdown": "## Summary", "kind": "ai", "sourceRevision": 2,
                                                    "opencode": ["agentID": "moss-summary", "model": model]]])
            #expect(meeting.summary?.kind == .ai)
            #expect(meeting.summary?.opencode?.model.variant == variant)
            #expect(meeting.summary?.opencode?.agentID == "moss-summary")
            #expect(try JSONDecoder().decode(Meeting.self, from: JSONEncoder().encode(meeting)) == meeting)
        }
        #expect(throws: DecodingError.self) {
            try fixture(["summary": ["markdown": "Invalid result kind", "kind": "opencode", "sourceRevision": 2]])
        }
    }

    @Test func catalogSelectionsUseOnlyReturnedAgentProviderModelAndVariantIDs() throws {
        let catalog = try JSONDecoder().decode(OpenCodeSummaryCatalog.self, from: opencodeCatalogData)
        let valid = OpenCodeSummaryOptions(agentID: "general", model: SummaryModel(id: "chat-model", providerID: "test-b", variant: "fast"))
        #expect(catalog.contains(valid))
        #expect(catalog.selection(preserving: valid) == valid)
        for invalid in [
            OpenCodeSummaryOptions(agentID: "hidden", model: valid.model),
            OpenCodeSummaryOptions(agentID: "general", model: SummaryModel(id: "guessed", providerID: "test-b")),
            OpenCodeSummaryOptions(agentID: "general", model: SummaryModel(id: "chat-model", providerID: "guessed")),
            OpenCodeSummaryOptions(agentID: "general", model: SummaryModel(id: "chat-model", providerID: "test-b", variant: "high"))
        ] { #expect(!catalog.contains(invalid)) }
        let missing = OpenCodeSummaryOptions(agentID: "removed", model: SummaryModel(id: "removed", providerID: "removed", variant: "removed"))
        #expect(catalog.selection(preserving: missing) == catalog.selection(preserving: nil))
        let withoutPreferredAgent = try JSONDecoder().decode(OpenCodeSummaryCatalog.self, from: Data(#"{"available":true,"message":"Ready","agents":[{"id":"only-returned","name":"Only"}],"models":[{"id":"only-model","providerID":"only-provider","name":"Only model","variants":[]}]}"#.utf8))
        #expect(withoutPreferredAgent.selection(preserving: nil)?.agentID == "only-returned")
        #expect(withoutPreferredAgent.selection(preserving: nil)?.model.variant == nil)
        for available in [false, true] {
            let empty = try JSONDecoder().decode(OpenCodeSummaryCatalog.self, from: Data("{\"available\":\(available),\"message\":\"No models\",\"agents\":[],\"models\":[]}".utf8))
            #expect(empty.selection(preserving: valid) == nil)
            #expect(!empty.contains(valid))
        }
    }

    @Test func opencodeCatalogAndSummaryRequestsMatchTheContract() async throws {
        let data = try fixtureData()
        let api = client { request in
            request.url?.path == "/api/summary/opencode" ? StubResponse(opencodeCatalogData) : StubResponse(data)
        }
        let catalog = try await api.opencodeSummaryCatalog()
        #expect(catalog.agents.count == 2)
        for variant in [String?.none, "high"] {
            let options = OpenCodeSummaryOptions(agentID: "moss-summary", model: SummaryModel(id: "chat-model", providerID: "test-a", variant: variant))
            _ = try await api.summarize("meeting", kind: .opencode, options: options)
        }
        _ = try await api.summarize("meeting", kind: .ai)
        let requests = StubProtocol.state.recorded
        #expect(requests.map(\.httpMethod) == ["GET", "POST", "POST", "POST"])
        #expect(requests.allSatisfy { $0.value(forHTTPHeaderField: "X-Moss-Client") == "1" })
        #expect(requests.allSatisfy { $0.url?.host == "127.0.0.1" && $0.url?.port == 4310 })
        #expect(requests[0].httpBody == nil)
        #expect(requests[0].timeoutInterval == 30)
        for (index, variant) in [String?.none, "high"].enumerated() {
            let request = requests[index + 1]
            #expect(request.url?.path == "/api/meetings/meeting/summary")
            #expect(request.timeoutInterval == 150)
            #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
            let bodyData = try #require(request.httpBody)
            let body = try #require(JSONSerialization.jsonObject(with: bodyData) as? [String: Any])
            #expect(Set(body.keys) == Set(["kind", "agentID", "model", "consent"]))
            #expect(body["kind"] as? String == "opencode")
            #expect(body["agentID"] as? String == "moss-summary")
            #expect(body["consent"] as? Bool == true)
            let model = try #require(body["model"] as? [String: String])
            #expect(model["id"] == "chat-model")
            #expect(model["providerID"] == "test-a")
            #expect(model["variant"] == variant)
        }
        #expect(requests[3].timeoutInterval == 150)
        #expect(try JSONSerialization.jsonObject(with: #require(requests[3].httpBody)) as? [String: String] == ["kind": "ai"])
        do { _ = try await api.summarize("meeting", kind: .opencode); Issue.record("Expected missing selection to fail before HTTP") }
        catch { #expect(error is APIError) }
        do {
            _ = try await api.summarize("meeting", kind: .extractive, options: try #require(catalog.selection(preserving: nil)))
            Issue.record("Expected misplaced options to fail before HTTP")
        } catch { #expect(error is APIError) }
        #expect(StubProtocol.state.recorded.count == 4)
    }

    @Test @MainActor func catalogRefreshReconcilesSelectionsAndSurfacesUnavailableAndErrors() async throws {
        let unavailable = Data(#"{"available":false,"message":"Start the OpenCode server, then refresh.","agents":[],"models":[]}"#.utf8)
        let api = client { _ in
            switch StubProtocol.state.recorded.count {
            case 1, 4: return StubResponse(opencodeCatalogData)
            case 2: return StubResponse(unavailable)
            default: return StubResponse(Data(#"{"error":"Discovery failed"}"#.utf8), status: 503)
            }
        }
        let workspace = Workspace(api: api, draftStore: temporaryDraftStore())
        await workspace.refreshOpenCodeCatalog()
        #expect(!workspace.isLoadingOpenCodeCatalog)
        #expect(workspace.opencodeSelection?.agentID == "moss-summary")
        workspace.selectOpenCodeAgent("general")
        workspace.selectOpenCodeModel(SummaryModel(id: "chat-model", providerID: "test-b"))
        workspace.selectOpenCodeVariant("fast")
        let selected = workspace.opencodeSelection
        workspace.selectOpenCodeAgent("hidden")
        workspace.selectOpenCodeModel(SummaryModel(id: "chat-model", providerID: "unknown"))
        workspace.selectOpenCodeVariant("high")
        #expect(workspace.opencodeSelection == selected)
        await workspace.refreshOpenCodeCatalog()
        #expect(workspace.opencodeCatalog?.available == false)
        #expect(workspace.opencodeCatalog?.message == "Start the OpenCode server, then refresh.")
        #expect(workspace.opencodeSelection == nil)
        #expect(workspace.opencodeCatalogError == nil)
        await workspace.refreshOpenCodeCatalog()
        #expect(workspace.opencodeCatalog == nil)
        #expect(workspace.opencodeSelection == nil)
        #expect(workspace.opencodeCatalogError == "Discovery failed")
        await workspace.refreshOpenCodeCatalog()
        #expect(workspace.opencodeCatalogError == nil)
        #expect(workspace.opencodeSelection?.agentID == "moss-summary")
    }

    @Test(arguments: [SummaryKind.extractive, .ai, .opencode])
    @MainActor func summarySavesDirtyDraftBeforeGeneration(_ kind: SummaryKind) async throws {
        let original = try fixture()
        let originalData = try fixtureData()
        let saved = try changedFixture(["notes": "Latest notes", "revision": 3])
        let result = try changedFixture(["notes": "Latest notes", "revision": 3,
                                         "summary": ["markdown": "Saved notes summary", "kind": kind == .extractive ? "extractive" : "ai", "sourceRevision": 3]])
        let api = client { request in
            switch request.url?.path {
            case "/api/health": return StubResponse(Data(#"{"error":"No engine needed"}"#.utf8), status: 503)
            case "/api/summary/opencode": return StubResponse(opencodeCatalogData)
            case "/api/meetings": return StubResponse(Data("[".utf8) + originalData + Data("]".utf8))
            case let path? where path.hasSuffix("/summary"): return StubResponse(result)
            default: return StubResponse(saved)
            }
        }
        let store = temporaryDraftStore()
        let workspace = Workspace(api: api, draftStore: store)
        await workspace.refresh()
        await workspace.refreshOpenCodeCatalog()
        workspace.edit(original, notes: "Latest notes")
        await workspace.summarize(original.id, kind: kind, options: kind == .opencode ? workspace.opencodeSelection : nil)
        let writes = StubProtocol.state.recorded.filter { $0.httpMethod != "GET" }
        #expect(writes.map(\.httpMethod) == ["PATCH", "POST"])
        #expect(writes[1].url?.path == "/api/meetings/\(original.id)/summary")
        let patchData = try #require(writes[0].httpBody)
        let patch = try #require(JSONSerialization.jsonObject(with: patchData) as? [String: Any])
        #expect(patch["notes"] as? String == "Latest notes")
        #expect(patch["expected"] as? [String: String] == ["notes": original.notes])
        #expect(patch["title"] == nil)
        #expect(workspace.selectedMeeting?.summary?.markdown == "Saved notes summary")
        #expect(workspace.selectedMeeting?.summaryIsStale == false)
        #expect(!workspace.hasUnsavedChanges)
        #expect(!workspace.isWorking)
        #expect(try store.load().isEmpty)
    }

    @Test(arguments: [SummaryKind.extractive, .ai, .opencode], [500, 409])
    @MainActor func failedSaveBlocksSummaryAndKeepsRecoverableDraft(_ kind: SummaryKind, _ status: Int) async throws {
        let original = try fixture()
        let data = try fixtureData()
        let api = client { request in
            if request.httpMethod == "PATCH" { return StubResponse(Data(#"{"error":"Save rejected"}"#.utf8), status: status) }
            if request.url?.path == "/api/health" { return StubResponse(Data(#"{"error":"No engine needed"}"#.utf8), status: 503) }
            if request.url?.path == "/api/summary/opencode" { return StubResponse(opencodeCatalogData) }
            return StubResponse(Data("[".utf8) + data + Data("]".utf8))
        }
        let store = temporaryDraftStore()
        let workspace = Workspace(api: api, draftStore: store)
        await workspace.refresh()
        await workspace.refreshOpenCodeCatalog()
        workspace.edit(original, notes: "Keep these unsaved notes")
        await workspace.summarize(original.id, kind: kind, options: kind == .opencode ? workspace.opencodeSelection : nil)
        #expect(StubProtocol.state.recorded.filter { $0.httpMethod != "GET" }.map(\.httpMethod) == ["PATCH"])
        #expect(!StubProtocol.state.recorded.contains { $0.url?.path.hasSuffix("/summary") == true })
        #expect(workspace.saveErrors[original.id] == "Save rejected")
        #expect(workspace.errorMessage?.contains("Your draft is still here") == true)
        #expect(workspace.drafts[original.id]?.notes == "Keep these unsaved notes")
        #expect(workspace.drafts[original.id]?.patch.expected.notes == original.notes)
        #expect(workspace.conflictedIDs.contains(original.id) == (status == 409))
        #expect(!workspace.isWorking)
        let restored = Workspace(api: api, draftStore: store)
        #expect(restored.drafts[original.id] == workspace.drafts[original.id])
        #expect(restored.conflictedIDs.contains(original.id) == (status == 409))
    }

    @Test @MainActor func editsDuringSummarySaveStopGenerationAndConcurrentOperations() async throws {
        let original = try fixture()
        let data = try fixtureData()
        let saved = try changedFixture(["notes": "Submitted notes", "revision": 3])
        let gate = RequestGate()
        let api = client { request in
            if request.httpMethod == "PATCH" { try gate.waitForRelease(); return StubResponse(saved) }
            if request.url?.path == "/api/health" { return StubResponse(Data(#"{"error":"No engine needed"}"#.utf8), status: 503) }
            return StubResponse(Data("[".utf8) + data + Data("]".utf8))
        }
        let workspace = Workspace(api: api, draftStore: temporaryDraftStore())
        await workspace.refresh()
        workspace.edit(original, notes: "Submitted notes")
        let summarizing = Task { await workspace.summarize(original.id, kind: .extractive) }
        for await _ in gate.arrived.stream { break }
        #expect(workspace.isWorking)
        await workspace.summarize(original.id, kind: .ai)
        await workspace.createMeeting()
        workspace.edit(original, notes: "Typed during save")
        gate.release.signal()
        await summarizing.value
        #expect(!workspace.isWorking)
        #expect(workspace.drafts[original.id]?.notes == "Typed during save")
        #expect(workspace.drafts[original.id]?.patch.expected.notes == "Submitted notes")
        #expect(StubProtocol.state.recorded.filter { $0.httpMethod != "GET" }.map(\.httpMethod) == ["PATCH"])
        #expect(workspace.errorMessage?.contains("Your draft is still here") == true)
    }

    @Test @MainActor func missingCatalogSelectionsBlockSummaryBeforeSaving() async throws {
        let original = try fixture()
        let api = client { _ in StubResponse(opencodeCatalogData) }
        let workspace = Workspace(api: api, draftStore: temporaryDraftStore())
        await workspace.refreshOpenCodeCatalog()
        workspace.edit(original, notes: "Keep this draft")
        for options in [nil,
                        OpenCodeSummaryOptions(agentID: "removed-agent", model: SummaryModel(id: "chat-model", providerID: "test-a")),
                        OpenCodeSummaryOptions(agentID: "moss-summary", model: SummaryModel(id: "chat-model", providerID: "test-b", variant: "high"))] {
            await workspace.summarize(original.id, kind: .opencode, options: options)
            #expect(workspace.errorMessage?.contains("confirm an available agent and model") == true)
        }
        #expect(StubProtocol.state.recorded.count == 1)
        #expect(workspace.drafts[original.id]?.notes == "Keep this draft")
        #expect(!workspace.isWorking)
    }

    @Test @MainActor func summaryUsesConfirmedOptionsAndLocksCatalogDuringSave() async throws {
        let original = try fixture()
        let data = try fixtureData()
        let saved = try changedFixture(["notes": "Confirmed notes", "revision": 3])
        let result = try changedFixture(["notes": "Confirmed notes", "revision": 3,
                                         "summary": ["markdown": "OpenCode result", "kind": "ai", "sourceRevision": 3,
                                                     "opencode": ["agentID": "moss-summary", "model": ["id": "chat-model", "providerID": "test-a", "variant": "high"]]]])
        let gate = RequestGate()
        let api = client { request in
            if request.url?.path == "/api/summary/opencode" { return StubResponse(opencodeCatalogData) }
            if request.httpMethod == "PATCH" { try gate.waitForRelease(); return StubResponse(saved) }
            if request.url?.path.hasSuffix("/summary") == true { return StubResponse(result) }
            if request.url?.path == "/api/health" { return StubResponse(Data(#"{"error":"No engine needed"}"#.utf8), status: 503) }
            return StubResponse(Data("[".utf8) + data + Data("]".utf8))
        }
        let workspace = Workspace(api: api, draftStore: temporaryDraftStore())
        await workspace.refresh()
        await workspace.refreshOpenCodeCatalog()
        workspace.selectOpenCodeVariant("high")
        let confirmed = try #require(workspace.opencodeSelection)
        workspace.selectOpenCodeAgent("general")
        workspace.selectOpenCodeModel(SummaryModel(id: "chat-model", providerID: "test-b"))
        let current = workspace.opencodeSelection
        workspace.edit(original, notes: "Confirmed notes")
        let summarizing = Task { await workspace.summarize(original.id, kind: .opencode, options: confirmed) }
        for await _ in gate.arrived.stream { break }
        #expect(workspace.isWorking)
        workspace.selectOpenCodeAgent("moss-summary")
        workspace.selectOpenCodeVariant("fast")
        await workspace.refreshOpenCodeCatalog()
        #expect(workspace.opencodeSelection == current)
        gate.release.signal()
        await summarizing.value
        let request = try #require(StubProtocol.state.recorded.last)
        let bodyData = try #require(request.httpBody)
        let body = try #require(JSONSerialization.jsonObject(with: bodyData) as? [String: Any])
        #expect(body["agentID"] as? String == confirmed.agentID)
        #expect(body["model"] as? [String: String] == ["id": "chat-model", "providerID": "test-a", "variant": "high"])
        #expect(StubProtocol.state.recorded.filter { $0.url?.path == "/api/summary/opencode" }.count == 1)
        #expect(workspace.selectedMeeting?.summary?.kind == .ai)
        #expect(workspace.selectedMeeting?.summary?.opencode?.agentID == confirmed.agentID)
        #expect(workspace.selectedMeeting?.summary?.opencode?.model == confirmed.model)
        #expect(workspace.opencodeSelection == current)
    }

    @Test @MainActor func failedSummaryKeepsSavedNotesAndStalePreviousResult() async throws {
        let original = try fixture()
        let data = try fixtureData()
        let saved = try changedFixture(["notes": "Saved before failure", "revision": 3])
        let api = client { request in
            if request.url?.path == "/api/summary/opencode" { return StubResponse(opencodeCatalogData) }
            if request.httpMethod == "PATCH" { return StubResponse(saved) }
            if request.url?.path.hasSuffix("/summary") == true { return StubResponse(Data(#"{"error":"OpenCode generation failed"}"#.utf8), status: 503) }
            if request.url?.path == "/api/health" { return StubResponse(Data(#"{"error":"No engine needed"}"#.utf8), status: 503) }
            return StubResponse(Data("[".utf8) + data + Data("]".utf8))
        }
        let store = temporaryDraftStore()
        let workspace = Workspace(api: api, draftStore: store)
        await workspace.refresh()
        await workspace.refreshOpenCodeCatalog()
        workspace.edit(original, notes: "Saved before failure")
        await workspace.summarize(original.id, kind: .opencode, options: workspace.opencodeSelection)
        #expect(workspace.errorMessage == "OpenCode generation failed")
        #expect(workspace.selectedMeeting?.notes == "Saved before failure")
        #expect(workspace.selectedMeeting?.summary == original.summary)
        #expect(workspace.selectedMeeting?.summaryIsStale == true)
        #expect(!workspace.hasUnsavedChanges)
        #expect(!workspace.isWorking)
        #expect(try store.load().isEmpty)
    }

    @Test func draftKeepsEditsAcrossTranscriptUpdatesAndSaveResponses() throws {
        let meeting = try fixture()
        var draft = MeetingDraft(meeting: meeting)
        draft.notes = "My unsaved thought"
        #expect(draft.patch == MeetingPatch(notes: "My unsaved thought", expected: .init(notes: meeting.notes)))
        draft.rebase(on: try fixture(["revision": 3, "title": "Remote title"]))
        #expect(draft.title == "Remote title")
        #expect(draft.notes == "My unsaved thought")
        let snapshot = draft
        draft.notes = "Typed while saving"
        draft.acknowledge(snapshot, returned: try fixture(["revision": 4, "title": "Remote title", "notes": snapshot.notes]))
        #expect(draft.notes == "Typed while saving")
        #expect(draft.isDirty)
        #expect(draft.patch == MeetingPatch(notes: "Typed while saving", expected: .init(notes: snapshot.notes)))
        let latest = draft
        draft.acknowledge(latest, returned: try fixture(["title": latest.title, "notes": latest.notes]))
        #expect(!draft.isDirty)
    }

    @Test func normalizedTitleAcknowledgesWithoutClobberingNewEdits() throws {
        var draft = MeetingDraft(meeting: try fixture())
        draft.title = "  Review  "
        let snapshot = draft
        draft.acknowledge(snapshot, returned: try fixture(["title": "Review"]))
        #expect(draft.title == "Review")
        #expect(!draft.isDirty)
    }

    @Test func dirtyFieldRefreshKeepsOriginalPrecondition() throws {
        let original = try fixture()
        var draft = MeetingDraft(meeting: original)
        draft.notes = "Native edit"
        draft.rebase(on: try fixture(["notes": "Other client's edit", "revision": 3]))
        let body = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(draft.patch)) as? [String: Any])
        #expect(body["notes"] as? String == "Native edit")
        #expect((body["expected"] as? [String: String])?["notes"] == original.notes)
        #expect(body["title"] == nil)
    }

    @Test func saveResponseDoesNotRebaseAFieldEditedAfterTheRequestStarted() throws {
        let original = try fixture()
        var draft = MeetingDraft(meeting: original)
        draft.notes = "Submitted notes"
        let snapshot = draft
        draft.title = "New native title"
        draft.acknowledge(snapshot, returned: try fixture(["notes": snapshot.notes, "title": "Remote title", "revision": 3]))
        #expect(draft.patch == MeetingPatch(title: "New native title", expected: .init(title: original.title)))
    }

    @Test func wavContainsLittleEndianMonoPCMHeaderAndSamples() {
        let pcm = Data([0, 0, 255, 127, 0, 128, 255, 255])
        let wav = WAV.encode(pcm: pcm)
        #expect(wav.count == 44 + pcm.count)
        #expect(String(data: wav[0..<4], encoding: .utf8) == "RIFF")
        #expect(Array(wav[4..<8]) == [44, 0, 0, 0])
        #expect(String(data: wav[8..<16], encoding: .utf8) == "WAVEfmt ")
        #expect(Array(wav[20..<24]) == [1, 0, 1, 0])
        #expect(Array(wav[24..<28]) == [128, 62, 0, 0])
        #expect(Array(wav[28..<36]) == [0, 125, 0, 0, 2, 0, 16, 0])
        #expect(String(data: wav[36..<40], encoding: .utf8) == "data")
        #expect(Array(wav[40..<44]) == [8, 0, 0, 0])
        #expect(Data(wav.dropFirst(44)) == pcm)
    }

    @Test func pendingAudioIsSequentialBoundedAndOnlyRemovedOnAcknowledgment() throws {
        let ledger = PendingAudio(startMs: 20_000)
        let pcm = Data(repeating: 7, count: PendingAudio.chunkBytes)
        #expect(ledger.append(pcm))
        #expect(ledger.pending.count == 1)
        let first = try #require(ledger.pending.first)
        #expect(first.startMs == 20_000)
        #expect(first.pcm == pcm)
        #expect(ledger.pending.first?.id == first.id)
        #expect(ledger.append(Data(repeating: 8, count: 3_200)))
        ledger.finish()
        #expect(ledger.pending.count == 2)
        #expect(ledger.pending[1].startMs == 40_000)
        #expect(ledger.pending[1].pcm.count == 3_200)
        #expect(!ledger.append(pcm))
        #expect(ledger.pending[0] == first)
        ledger.acknowledge(first.id)
        #expect(ledger.pending.count == 1)
        ledger.acknowledge(first.id)
        #expect(ledger.pending.count == 1)

        let bounded = PendingAudio()
        for _ in 0..<5 { #expect(bounded.append(pcm)) }
        #expect(!bounded.append(pcm))
        #expect(!bounded.isAccepting)
        bounded.finish()
        #expect(bounded.pending.count == 6)
        #expect(bounded.pending.last?.startMs == 100_000)
        #expect(bounded.pending.reduce(0) { $0 + $1.pcm.count } == 3_840_000)
    }

    @Test func acknowledgedChunksAllowLongRecordingsWithoutGrowingQueue() {
        let ledger = PendingAudio()
        let pcm = Data(repeating: 0, count: PendingAudio.chunkBytes)
        for _ in 0..<20 {
            #expect(ledger.append(pcm))
            #expect(ledger.pending.count == 1)
            if let chunk = ledger.pending.first { ledger.acknowledge(chunk.id) }
        }
        #expect(ledger.pending.isEmpty)
        #expect(ledger.isAccepting)
        ledger.finish()
        #expect(ledger.pending.isEmpty)
    }

    @Test func httpBoundaryMatchesEveryRouteAndAudioRetryIdentity() async throws {
        let data = try fixtureData()
        let api = client { request in
            switch request.url?.path {
            case "/api/health", "/api/engine/prepare":
                return StubResponse(Data(#"{"name":"Moss","apiVersion":1,"hex":{"state":"ready","model":"test","message":"Ready"},"ai":{"configured":false,"remote":false}}"#.utf8))
            case "/api/meetings" where request.httpMethod == "GET":
                return StubResponse(Data("[".utf8) + data + Data("]".utf8))
            case let path? where path.hasSuffix("/export"):
                return StubResponse(Data("# Exported meeting\n".utf8))
            case _ where request.httpMethod == "DELETE": return StubResponse(Data(#"{"ok":true}"#.utf8))
            default: return StubResponse(data)
            }
        }
        let id = try fixture().id
        #expect(try await api.health().hex.state == .ready)
        #expect(try await api.prepareEngine().apiVersion == 1)
        #expect(try await api.meetings().count == 1)
        _ = try await api.createMeeting()
        _ = try await api.updateMeeting(id, patch: MeetingPatch(notes: "Local notes", expected: .init(notes: "Original notes")))
        _ = try await api.importTranscript(id, text: "Imported text")
        _ = try await api.summarize(id, kind: .extractive)
        let chunk = AudioChunk(startMs: 40_000, pcm: Data([0, 0, 1, 0]))
        _ = try await api.uploadAudio(id, chunk: chunk)
        _ = try await api.uploadAudio(id, chunk: chunk)
        #expect(try await api.exportMarkdown(id) == "# Exported meeting\n")
        try await api.deleteMeeting(id)
        let requests = StubProtocol.state.recorded
        #expect(requests.count == 11)
        #expect(requests.allSatisfy { $0.value(forHTTPHeaderField: "X-Moss-Client") == "1" })
        #expect(requests.allSatisfy { $0.url?.host == "127.0.0.1" && $0.url?.port == 4310 })
        #expect(requests.map { $0.httpMethod } == ["GET", "POST", "GET", "POST", "PATCH", "POST", "POST", "POST", "POST", "GET", "DELETE"])
        #expect(requests[4].url?.path == "/api/meetings/\(id)")
        let patch = try #require(requests[4].httpBody)
        let patchObject = try #require(JSONSerialization.jsonObject(with: patch) as? [String: Any])
        #expect(patchObject["notes"] as? String == "Local notes")
        #expect(patchObject["expected"] as? [String: String] == ["notes": "Original notes"])
        #expect(patchObject["title"] == nil)
        #expect(requests[5].url?.path == "/api/meetings/\(id)/transcript")
        let imported = try #require(requests[5].httpBody)
        #expect(try JSONSerialization.jsonObject(with: imported) as? [String: String] == ["text": "Imported text"])
        #expect(requests[6].url?.path == "/api/meetings/\(id)/summary")
        let summary = try #require(requests[6].httpBody)
        #expect(try JSONSerialization.jsonObject(with: summary) as? [String: String] == ["kind": "extractive"])
        #expect(requests[7].value(forHTTPHeaderField: "Content-Type") == "audio/wav")
        #expect(requests[7].value(forHTTPHeaderField: "X-Start-Ms") == "40000")
        #expect(requests[7].value(forHTTPHeaderField: "X-Chunk-Id") == chunk.id.uuidString)
        #expect(requests[8].value(forHTTPHeaderField: "X-Chunk-Id") == chunk.id.uuidString)
        #expect(requests[7].httpBody == chunk.wav)
        #expect(requests[8].httpBody == chunk.wav)
        #expect(requests[1].timeoutInterval == 900)
    }

    @Test func failedAudioRemainsAvailableForAnIdenticalRetry() async throws {
        let data = try fixtureData()
        let api = client { _ in
            StubProtocol.state.recorded.count == 1
                ? StubResponse(Data(#"{"error":"Hex inference failed"}"#.utf8), status: 500)
                : StubResponse(data)
        }
        let ledger = PendingAudio()
        #expect(ledger.append(Data(repeating: 1, count: 3_200)))
        ledger.finish()
        let chunk = try #require(ledger.pending.first)
        do {
            _ = try await api.uploadAudio("meeting", chunk: chunk)
            Issue.record("Expected inference failure")
        } catch { #expect(error.localizedDescription == "Hex inference failed") }
        #expect(ledger.pending.first == chunk)
        _ = try await api.uploadAudio("meeting", chunk: try #require(ledger.pending.first))
        ledger.acknowledge(chunk.id)
        #expect(ledger.pending.isEmpty)
        let requests = StubProtocol.state.recorded
        #expect(requests[0].httpBody == requests[1].httpBody)
        #expect(requests[0].value(forHTTPHeaderField: "X-Chunk-Id") == requests[1].value(forHTTPHeaderField: "X-Chunk-Id"))
    }

    @Test func serverFailureSurfacesItsMessage() async throws {
        let api = client { _ in StubResponse(Data(#"{"error":"Hex is not installed."}"#.utf8), status: 503) }
        do { _ = try await api.health(); Issue.record("Expected HTTP 503 to throw") }
        catch { #expect(error.localizedDescription == "Hex is not installed.") }
    }

    @Test @MainActor func workspaceKeepsDirtyDraftAcrossSwitchRefreshUploadAndSaveFailure() async throws {
        let data = try fixtureData()
        let second = try changedFixture(["id": "second-meeting", "title": "Other meeting"])
        let updated = try changedFixture(["revision": 3])
        let api = client { request in
            if request.httpMethod == "PATCH" {
                return StubResponse(Data(#"{"error":"Disk is full"}"#.utf8), status: 500)
            }
            if request.url?.path == "/api/health" {
                return StubResponse(Data(#"{"error":"Engine unavailable"}"#.utf8), status: 503)
            }
            if request.url?.path == "/api/meetings" {
                return StubResponse(Data("[".utf8) + data + Data(",".utf8) + second + Data("]".utf8))
            }
            return StubResponse(updated)
        }
        let workspace = Workspace(api: api, draftStore: temporaryDraftStore())
        await workspace.refresh()
        let meeting = try #require(workspace.meetings.first { $0.id != "second-meeting" })
        workspace.edit(meeting, notes: "Keep this local draft")
        workspace.selectedID = "second-meeting"
        await workspace.refresh()
        try await workspace.uploadAudio(meeting.id, chunk: AudioChunk(startMs: 20_000, pcm: Data([0, 0])))
        await workspace.refresh()
        workspace.selectedID = meeting.id
        #expect(workspace.draft(for: meeting).notes == "Keep this local draft")
        #expect(workspace.selectedMeeting?.revision == 3)
        #expect(await workspace.save(meeting.id) == false)
        #expect(workspace.saveErrors[meeting.id] == "Disk is full")
        #expect(workspace.draft(for: meeting).notes == "Keep this local draft")
        #expect(workspace.hasUnsavedChanges)
    }

    @Test @MainActor func successfulSaveClearsDraftAndExportUsesServerMarkdown() async throws {
        let data = try fixtureData()
        let saved = try changedFixture(["revision": 3, "notes": "Saved locally"])
        let api = client { request in
            if request.url?.path == "/api/health" {
                return StubResponse(Data(#"{"error":"unavailable"}"#.utf8), status: 503)
            }
            if request.httpMethod == "PATCH" { return StubResponse(saved) }
            if request.url?.path.hasSuffix("/export") == true { return StubResponse(Data("# Server export".utf8)) }
            return StubResponse(Data("[".utf8) + data + Data("]".utf8))
        }
        let workspace = Workspace(api: api, draftStore: temporaryDraftStore())
        await workspace.refresh()
        let meeting = try #require(workspace.selectedMeeting)
        workspace.edit(meeting, notes: "Saved locally")
        #expect(await workspace.save(meeting.id))
        #expect(!workspace.hasUnsavedChanges)
        #expect(workspace.selectedMeeting?.notes == "Saved locally")
        #expect(try await workspace.exportMarkdown(meeting.id) == "# Server export")
    }

    @Test @MainActor func revertingToOriginalNotesWhileSaveIsInFlightStillSavesTheRevert() async throws {
        let data = try fixtureData()
        let intermediate = try changedFixture(["revision": 3, "notes": "Intermediate edit"])
        let reverted = try changedFixture(["revision": 4])
        let original = try fixture()
        let gate = RequestGate()
        let api = client { request in
            if request.url?.path == "/api/health" {
                return StubResponse(Data(#"{"error":"unavailable"}"#.utf8), status: 503)
            }
            if request.httpMethod == "PATCH" {
                let patches = StubProtocol.state.recorded.filter { $0.httpMethod == "PATCH" }
                if patches.count == 1 {
                    try gate.waitForRelease()
                    return StubResponse(intermediate)
                }
                return StubResponse(reverted)
            }
            return StubResponse(Data("[".utf8) + data + Data("]".utf8))
        }
        let workspace = Workspace(api: api, draftStore: temporaryDraftStore())
        await workspace.refresh()
        workspace.edit(original, notes: "Intermediate edit")
        let saving = Task { await workspace.save(original.id) }
        for await _ in gate.arrived.stream { break }
        workspace.edit(original, notes: original.notes)
        #expect(workspace.hasUnsavedChanges)
        gate.release.signal()
        #expect(await saving.value == false)
        #expect(workspace.draft(for: original).notes == original.notes)
        #expect(workspace.drafts[original.id]?.isDirty == true)
        #expect(await workspace.save(original.id))
        #expect(!workspace.hasUnsavedChanges)
        #expect(workspace.selectedMeeting?.notes == original.notes)
    }

    @Test @MainActor func twoClientsConflictWithoutRebasingAndOnlyConfirmedReplacementCanProceed() async throws {
        let original = try fixture()
        let service = EditingService(original)
        let api = client { try service.respond($0) }
        let first = Workspace(api: api, draftStore: temporaryDraftStore())
        let secondStore = temporaryDraftStore()
        let second = Workspace(api: api, draftStore: secondStore)
        await first.refresh()
        await second.refresh()
        first.edit(original, notes: "First client's notes")
        second.edit(original, notes: "Second client's notes")
        #expect(await first.save(original.id))
        await second.refresh()
        #expect(second.drafts[original.id]?.patch.expected.notes == original.notes)
        #expect(await second.save(original.id) == false)
        #expect(service.current.notes == "First client's notes")
        #expect(second.conflictedIDs.contains(original.id))
        second.edit(try #require(second.selectedMeeting), notes: "Second client's revised notes")
        let requestCount = StubProtocol.state.recorded.count
        #expect(await second.save(original.id) == false)
        await second.refresh()
        #expect(second.drafts[original.id]?.patch.expected.notes == original.notes)
        try await Task.sleep(for: .milliseconds(900))
        #expect(StubProtocol.state.recorded.count == requestCount + 2)

        let restored = Workspace(api: api, draftStore: secondStore)
        #expect(restored.conflictedIDs.contains(original.id))
        #expect(restored.drafts[original.id]?.notes == "Second client's revised notes")
        let beforeReplacement = StubProtocol.state.recorded.count
        #expect(await restored.replaceConflictingFieldsAfterConfirmation(original.id))
        let requests = Array(StubProtocol.state.recorded.dropFirst(beforeReplacement))
        #expect(requests.map(\.httpMethod) == ["GET", "PATCH"])
        let patchData = try #require(requests.last?.httpBody)
        let patch = try #require(JSONSerialization.jsonObject(with: patchData) as? [String: Any])
        #expect(patch["expected"] as? [String: String] == ["notes": "First client's notes"])
        #expect(patch["title"] == nil)
        #expect(service.current.notes == "Second client's revised notes")
        #expect(!restored.conflictedIDs.contains(original.id))
        #expect(try secondStore.load().isEmpty)
    }

    @Test @MainActor func twoClientsEditingDisjointFieldsPreserveBothChanges() async throws {
        let original = try fixture()
        let service = EditingService(original)
        let api = client { try service.respond($0) }
        let first = Workspace(api: api, draftStore: temporaryDraftStore())
        let second = Workspace(api: api, draftStore: temporaryDraftStore())
        await first.refresh()
        await second.refresh()
        first.edit(original, title: "Remote title")
        second.edit(original, notes: "Native notes")
        #expect(await first.save(original.id))
        #expect(await second.save(original.id))
        #expect(service.current.title == "Remote title")
        #expect(service.current.notes == "Native notes")
        #expect(second.selectedMeeting?.title == "Remote title")
        let patches = StubProtocol.state.recorded.filter { $0.httpMethod == "PATCH" }
        let patchData = try #require(patches.last?.httpBody)
        let last = try #require(JSONSerialization.jsonObject(with: patchData) as? [String: Any])
        #expect(last["title"] == nil)
        #expect(last["expected"] as? [String: String] == ["notes": original.notes])
    }

    @Test @MainActor func confirmedReplacementStillRejectsANewerConcurrentEdit() async throws {
        let original = try fixture()
        let service = EditingService(original)
        let api = client { try service.respond($0) }
        let workspace = Workspace(api: api, draftStore: temporaryDraftStore())
        await workspace.refresh()
        workspace.edit(original, notes: "My draft")
        service.changeNotesBeforeNextPatch("Other client")
        #expect(await workspace.save(original.id) == false)
        service.changeNotesBeforeNextPatch("Yet another edit")
        #expect(await workspace.replaceConflictingFieldsAfterConfirmation(original.id) == false)
        #expect(workspace.conflictedIDs.contains(original.id))
        #expect(workspace.drafts[original.id]?.notes == "My draft")
        #expect(workspace.drafts[original.id]?.patch.expected.notes == "Other client")
        #expect(service.current.notes == "Yet another edit")
        let count = StubProtocol.state.recorded.count
        #expect(await workspace.save(original.id) == false)
        #expect(StubProtocol.state.recorded.count == count)
    }

    @Test @MainActor func failedSaveRestoresDraftAndOriginalBaseFromPrivateAtomicFile() async throws {
        let original = try fixture()
        let service = EditingService(original)
        let api = client { try service.respond($0) }
        let store = temporaryDraftStore()
        let workspace = Workspace(api: api, draftStore: store)
        await workspace.refresh()
        workspace.edit(original, notes: "Recover after a failed save")
        service.failSaves(true)
        #expect(await workspace.save(original.id) == false)
        #expect(workspace.saveErrors[original.id] == "Disk is full")
        #expect(workspace.draftPersistenceError == nil)
        let manager = FileManager.default
        let fileMode = try #require(manager.attributesOfItem(atPath: store.fileURL.path)[.posixPermissions] as? NSNumber)
        let directoryMode = try #require(manager.attributesOfItem(atPath: store.fileURL.deletingLastPathComponent().path)[.posixPermissions] as? NSNumber)
        #expect(fileMode.intValue == 0o600)
        #expect(directoryMode.intValue == 0o700)
        let restored = Workspace(api: api, draftStore: store)
        #expect(restored.selectedMeeting?.id == original.id)
        #expect(restored.drafts[original.id]?.notes == "Recover after a failed save")
        #expect(restored.drafts[original.id]?.patch.expected.notes == original.notes)
        #expect(restored.hasUnsavedChanges)
        await restored.refresh()
        service.failSaves(false)
        service.changeNotesBeforeNextPatch("Edited elsewhere during restart")
        #expect(await restored.save(original.id) == false)
        #expect(restored.conflictedIDs.contains(original.id))
        #expect(await restored.replaceConflictingFieldsAfterConfirmation(original.id))
        #expect(try store.load().isEmpty)
        #expect(Workspace(api: api, draftStore: store).drafts.isEmpty)
    }

    @Test @MainActor func inFlightRevertIsRecoverableEvenIfTheRequestCommitsAfterACrash() async throws {
        let original = try fixture()
        let committed = try changedFixture(["notes": "Intermediate edit", "revision": 3])
        let reverted = try changedFixture(["revision": 4])
        let gate = RequestGate()
        let api = client { request in
            if request.httpMethod == "PATCH" {
                if StubProtocol.state.recorded.filter({ $0.httpMethod == "PATCH" }).count == 1 {
                    try gate.waitForRelease()
                    return StubResponse(committed)
                }
                return StubResponse(reverted)
            }
            if request.url?.path == "/api/health" { return StubResponse(Data(#"{"error":"unavailable"}"#.utf8), status: 503) }
            return StubResponse(Data("[".utf8) + (try fixtureData()) + Data("]".utf8))
        }
        let store = temporaryDraftStore()
        let workspace = Workspace(api: api, draftStore: store)
        await workspace.refresh()
        workspace.edit(original, notes: "Intermediate edit")
        let saving = Task { await workspace.save(original.id) }
        for await _ in gate.arrived.stream { break }
        workspace.edit(original, notes: original.notes)
        let restored = Workspace(api: api, draftStore: store)
        #expect(restored.drafts[original.id]?.notes == original.notes)
        #expect(restored.drafts[original.id]?.isDirty == true)
        #expect(restored.conflictedIDs.contains(original.id))
        #expect(restored.drafts[original.id]?.patch.expected.notes == "Intermediate edit")
        gate.release.signal()
        #expect(await saving.value == false)
        #expect(await workspace.save(original.id))
        #expect(workspace.selectedMeeting?.notes == original.notes)
    }

    @Test @MainActor func corruptRecoveryIsVisibleAndNeverOverwrittenByRefreshOrEdits() async throws {
        let original = try fixture()
        let service = EditingService(original)
        let api = client { try service.respond($0) }
        let store = temporaryDraftStore()
        let corrupt = Data("{broken archive".utf8)
        try FileManager.default.createDirectory(at: store.fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try corrupt.write(to: store.fileURL)
        let workspace = Workspace(api: api, draftStore: store)
        #expect(workspace.draftPersistenceError != nil)
        await workspace.refresh()
        workspace.edit(original, notes: "New in-memory draft")
        #expect(workspace.draftPersistenceError != nil)
        workspace.retryDraftPersistence()
        #expect(workspace.draftPersistenceError != nil)
        #expect(try Data(contentsOf: store.fileURL) == corrupt)
        #expect(workspace.drafts[original.id]?.notes == "New in-memory draft")
        #expect(await workspace.save(original.id))
        #expect(workspace.draftPersistenceError != nil)
    }

    @Test @MainActor func draftWriteFailureStaysVisibleAndCanBeRetriedWithoutLosingEdits() async throws {
        let original = try fixture()
        let service = EditingService(original)
        let api = client { try service.respond($0) }
        let store = temporaryDraftStore()
        let directory = store.fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("not a directory".utf8).write(to: directory)
        let workspace = Workspace(api: api, draftStore: store)
        await workspace.refresh()
        workspace.edit(original, notes: "Keep this despite a storage error")
        let message = try #require(workspace.draftPersistenceError)
        await workspace.refresh()
        #expect(workspace.draftPersistenceError == message)
        #expect(workspace.drafts[original.id]?.notes == "Keep this despite a storage error")
        try FileManager.default.removeItem(at: directory)
        workspace.retryDraftPersistence()
        #expect(workspace.draftPersistenceError == nil)
        #expect(try store.load().first?.draft.notes == "Keep this despite a storage error")
        #expect(await workspace.save(original.id))
    }

    @Test func draftArchiveValidationRejectsInvalidIDsDuplicatesBoundsAndVersions() throws {
        let original = try fixture()
        var draft = MeetingDraft(meeting: original)
        draft.notes = "Valid draft"
        let record = StoredDraft(meetingID: original.id, draft: draft, hasConflict: false)
        let store = temporaryDraftStore()
        try store.save([record])
        let validData = try Data(contentsOf: store.fileURL)
        #expect(throws: (any Error).self) { try store.save([record, record]) }
        #expect(throws: (any Error).self) {
            try store.save([StoredDraft(meetingID: "../invalid", draft: draft, hasConflict: false)])
        }
        let tooMany = (0...DraftStore.maximumDrafts).map { _ in
            StoredDraft(meetingID: UUID().uuidString, draft: draft, hasConflict: false)
        }
        #expect(throws: (any Error).self) { try store.save(tooMany) }
        draft.title = String(repeating: "x", count: 4_097)
        #expect(throws: (any Error).self) {
            try store.save([StoredDraft(meetingID: original.id, draft: draft, hasConflict: false)])
        }
        draft.title = original.title
        draft.notes = String(repeating: "x", count: 1_048_577)
        #expect(throws: (any Error).self) {
            try store.save([StoredDraft(meetingID: original.id, draft: draft, hasConflict: false)])
        }
        #expect(try Data(contentsOf: store.fileURL) == validData)
        var archive = try #require(JSONSerialization.jsonObject(with: validData) as? [String: Any])
        archive["version"] = 999
        try JSONSerialization.data(withJSONObject: archive).write(to: store.fileURL)
        #expect(throws: (any Error).self) { try store.load() }
        archive["version"] = 1
        archive["records"] = [["meetingID": original.id, "draft": ["notes": 12], "hasConflict": false]]
        try JSONSerialization.data(withJSONObject: archive).write(to: store.fileURL)
        #expect(throws: (any Error).self) { try store.load() }
        let handle = try FileHandle(forWritingTo: store.fileURL)
        try handle.truncate(atOffset: UInt64(DraftStore.maximumFileBytes + 1))
        try handle.close()
        #expect(throws: (any Error).self) { try store.load() }
    }

    @Test func recoveryRejectsSymlinkFilesWithoutChangingTheirTarget() throws {
        let original = try fixture()
        var draft = MeetingDraft(meeting: original)
        draft.notes = "Private draft"
        let store = temporaryDraftStore()
        let target = store.fileURL.deletingLastPathComponent().appendingPathComponent("unrelated.json")
        try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        let untouched = Data("Unrelated file".utf8)
        try untouched.write(to: target)
        try FileManager.default.createSymbolicLink(at: store.fileURL, withDestinationURL: target)
        #expect(throws: (any Error).self) { try store.load() }
        #expect(throws: (any Error).self) {
            try store.save([StoredDraft(meetingID: original.id, draft: draft, hasConflict: false)])
        }
        #expect(try Data(contentsOf: target) == untouched)
    }
}

extension MossKitTests {
    @Test func sharingWireTypesKeepLegacyFixturesAndOptionalFields() throws {
        #expect(try fixture().agentWork == nil)
        #expect(try fixture(["audioImportHashes": ["opaque-service-metadata"]]).notes == fixture().notes)
        let oldHealth = Data(#"{"name":"Moss","apiVersion":1,"hex":{"state":"idle","model":"fixture","message":"Ready"},"ai":{"configured":false,"remote":false}}"#.utf8)
        #expect(try JSONDecoder().decode(Health.self, from: oldHealth).audioImport == nil)
        var healthObject = try #require(JSONSerialization.jsonObject(with: oldHealth) as? [String: Any])
        healthObject["audioImport"] = ["available": true, "message": "ffmpeg ready", "formats": ["wav", "m4a"], "maxBytes": 104_857_600, "maxDurationMs": 7_200_000]
        let health = try JSONDecoder().decode(Health.self, from: JSONSerialization.data(withJSONObject: healthObject))
        #expect(health.audioImport?.maxBytes == ChosenAudioFile.maximumBytes)
        #expect(health.audioImport?.maxDurationMs == 7_200_000)
        let result: [String: Any] = ["id": "result-id", "source": "notes", "instruction": "Review", "markdown": "# Separate result", "sourceRevision": 2,
                                     "agentID": "general", "model": ["id": "chat-model", "providerID": "test-a"], "createdAt": "2026-11-02T12:00:00.000Z"]
        let meeting = try fixture(["agentWork": [result]])
        #expect(meeting.agentWork?.first?.source == .notes)
        #expect(meeting.agentWork?.first?.markdown == "# Separate result")
        #expect(meeting.notes == (try fixture()).notes)
        #expect(try JSONDecoder().decode(Meeting.self, from: JSONEncoder().encode(meeting)) == meeting)
        #expect(ContentSource.allCases.map(\.rawValue) == ["meeting", "notes", "transcript", "summary"])
        #expect(ExportFormat.allCases.map(\.fileExtension) == ["md", "txt", "json"])
        let catalog = try JSONDecoder().decode(DriveCatalog.self, from: driveCatalogData)
        #expect(catalog.servers.map(\.name) == ["chosen-drive", "other-service"])
        #expect(catalog.servers[1].status == .needs_auth)
        #expect(catalog.servers[1].title == nil)
        #expect(try JSONDecoder().decode(DriveCatalog.self, from: JSONEncoder().encode(catalog)) == catalog)
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(DriveExportHandoff.self, from: Data(#"{"sessionID":"fixture","status":"uploaded","message":"Wrong claim"}"#.utf8))
        }
    }

    @Test func sharingRequestsAreFlatAndExportsUseARealQuery() async throws {
        let data = try fixtureData()
        let api = client { request in
            switch request.url?.path {
            case "/api/drive", "/api/drive/connect": return StubResponse(driveCatalogData)
            case let path? where path.hasSuffix("/drive-export"): return StubResponse(driveHandoffData)
            case let path? where path.hasSuffix("/export"): return StubResponse(Data("exported".utf8))
            default: return StubResponse(data)
            }
        }
        let selection = OpenCodeSummaryOptions(agentID: "general", model: SummaryModel(id: "chat-model", providerID: "test-b", variant: "fast"))
        let requestID = UUID()
        let options = AgentWorkOptions(source: .transcript, instruction: "Find decisions", requestID: requestID, selection: selection)
        _ = try await api.agentWork("meeting", options: options)
        _ = try await api.agentWork("meeting", options: options)
        _ = try await api.driveCatalog()
        _ = try await api.connectDrive(DriveConnectionOptions(server: "chosen-drive"))
        _ = try await api.connectDrive(DriveConnectionOptions(server: "new-drive", url: "https://mcp.example.invalid/drive"))
        let handoff = try await api.exportDrive("meeting", options: DriveExportOptions(server: "chosen-drive", source: .summary, folderID: "folder-fixture", selection: selection))
        #expect(handoff.status == .submitted)
        #expect(handoff.sessionID == "ses_fixture_only")
        for format in ExportFormat.allCases { #expect(try await api.export("meeting", format: format) == Data("exported".utf8)) }
        #expect(try await api.exportMarkdown("meeting") == "exported")
        let requests = StubProtocol.state.recorded
        #expect(requests.count == 10)
        #expect(requests.allSatisfy { $0.value(forHTTPHeaderField: "X-Moss-Client") == "1" && $0.url?.host == "127.0.0.1" })
        for request in requests.prefix(2) {
            #expect(request.url?.path == "/api/meetings/meeting/agent-work")
            #expect(request.httpMethod == "POST")
            #expect(request.timeoutInterval == 150)
            let body = try requestBody(request)
            #expect(Set(body.keys) == Set(["source", "instruction", "requestID", "agentID", "model", "consent"]))
            #expect(body["requestID"] as? String == requestID.uuidString)
            #expect(body["source"] as? String == "transcript")
            #expect(body["instruction"] as? String == "Find decisions")
            #expect(body["agentID"] as? String == "general")
            #expect(body["model"] as? [String: String] == ["id": "chat-model", "providerID": "test-b", "variant": "fast"])
            #expect(body["consent"] as? Bool == true)
        }
        #expect(requests[0].httpBody == requests[1].httpBody)
        let existingConnect = try requestBody(requests[3])
        #expect(Set(existingConnect.keys) == Set(["server", "consent"]))
        #expect(existingConnect["consent"] as? Bool == true)
        let addedConnect = try requestBody(requests[4])
        #expect(addedConnect["url"] as? String == "https://mcp.example.invalid/drive")
        #expect(addedConnect["consent"] as? Bool == true)
        let exported = try requestBody(requests[5])
        #expect(Set(exported.keys) == Set(["source", "server", "folderID", "agentID", "model", "consent"]))
        #expect(exported["source"] as? String == "summary")
        #expect(exported["folderID"] as? String == "folder-fixture")
        #expect(exported["server"] as? String == "chosen-drive")
        #expect(exported["consent"] as? Bool == true)
        for (index, format) in ExportFormat.allCases.enumerated() {
            #expect(requests[index + 6].url?.path == "/api/meetings/meeting/export")
            #expect(requests[index + 6].url?.query == "format=\(format.rawValue)")
        }
        #expect(requests[9].url?.query == nil)
    }

    @Test func driveEndpointValidationNeverInventsOrAcceptsCredentials() throws {
        for url in ["http://mcp.example.invalid/drive", "https://user:pass@mcp.example.invalid/drive", "https://mcp.example.invalid/drive?token=secret", "https://mcp.example.invalid/drive#token", "", "not-a-url"] {
            #expect(throws: APIError.self) { try DriveConnectionOptions(server: "drive", url: url) }
        }
        #expect(throws: APIError.self) { try DriveConnectionOptions(server: " ") }
        #expect(try DriveConnectionOptions(server: "existing").url == nil)
    }

    @Test func audioFileBoundaryRequiresConsentAndEncodesTheFilename() async throws {
        let data = try fixtureData()
        let api = client { _ in StubResponse(data) }
        let file = try ChosenAudioFile(meetingID: "meeting", filename: "音声 #1\r\n.m4a", bytes: Data([1, 2, 3]))
        do { _ = try await api.importAudioFile(file, consent: false); Issue.record("Missing consent must not send audio") }
        catch { #expect(error is APIError) }
        #expect(StubProtocol.state.recorded.isEmpty)
        _ = try await api.importAudioFile(file, consent: true)
        let request = try #require(StubProtocol.state.recorded.first)
        #expect(request.url?.path == "/api/meetings/meeting/audio-file")
        #expect(request.httpMethod == "POST")
        #expect(request.timeoutInterval == 1_800)
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/octet-stream")
        #expect(request.value(forHTTPHeaderField: "X-Audio-Consent") == "1")
        #expect(request.value(forHTTPHeaderField: "X-File-Name") == "%E9%9F%B3%E5%A3%B0%20%231%0D%0A.m4a")
        #expect(request.httpBody == file.bytes)
    }

    @Test func chosenAudioFileIsBoundedAndNeverModifiesTheOriginal() throws {
        let url = try audioTestFile()
        let bytes = try Data(contentsOf: url)
        let file = try ChosenAudioFile.read(meetingID: "meeting", url: url)
        #expect(file.bytes == bytes)
        #expect(file.filename == url.lastPathComponent)
        #expect(try Data(contentsOf: url) == bytes)
        #expect(throws: APIError.self) { try ChosenAudioFile.read(meetingID: "meeting", url: URL(string: "https://example.invalid/file.mp3")!) }
        #expect(throws: APIError.self) { try ChosenAudioFile(meetingID: "meeting", filename: "empty.wav", bytes: Data()) }
        let oversized = try audioTestFile()
        let handle = try FileHandle(forWritingTo: oversized)
        try handle.truncate(atOffset: UInt64(ChosenAudioFile.maximumBytes + 1))
        try handle.close()
        #expect(throws: APIError.self) { try ChosenAudioFile.read(meetingID: "meeting", url: oversized) }
    }

    @Test @MainActor func audioDropDoesNotImportAndFailureKeepsFileForIdenticalRetry() async throws {
        let original = try fixture()
        let data = try fixtureData()
        let saved = try changedFixture(["notes": "Save before import", "revision": 3])
        let imported = try changedFixture(["notes": "Save before import", "revision": 4])
        let api = client { request in
            if request.httpMethod == "PATCH" { return StubResponse(saved) }
            if request.url?.path.hasSuffix("/audio-file") == true {
                return StubProtocol.state.recorded.filter { $0.url?.path.hasSuffix("/audio-file") == true }.count == 1
                    ? StubResponse(Data(#"{"error":"Conversion failed"}"#.utf8), status: 422) : StubResponse(imported)
            }
            if request.url?.path == "/api/health" { return StubResponse(readyHealthData) }
            return StubResponse(Data("[".utf8) + data + Data("]".utf8))
        }
        let workspace = Workspace(api: api, draftStore: temporaryDraftStore())
        await workspace.refresh()
        let url = try audioTestFile()
        await workspace.chooseAudioFile(original.id, url: url)
        let chosen = try #require(workspace.chosenAudioFile)
        #expect(!StubProtocol.state.recorded.contains { $0.httpMethod == "POST" })
        #expect(!workspace.isWorking)
        #expect(workspace.blocksCapture)
        await workspace.chooseAudioFile("other", url: try audioTestFile(Data([9])))
        #expect(workspace.chosenAudioFile == chosen)
        #expect(await workspace.importChosenAudioFile(consent: false) == false)
        #expect(!StubProtocol.state.recorded.contains { $0.httpMethod == "POST" })
        workspace.edit(original, notes: "Save before import")
        #expect(await workspace.importChosenAudioFile(consent: true) == false)
        #expect(workspace.chosenAudioFile == chosen)
        #expect(workspace.audioImportError?.contains("Conversion failed") == true)
        #expect(workspace.selectedMeeting?.notes == "Save before import")
        #expect(workspace.selectedMeeting?.summary == original.summary)
        #expect(!workspace.isImportingAudioFile)
        #expect(await workspace.importChosenAudioFile(consent: true))
        #expect(workspace.chosenAudioFile == nil)
        #expect(workspace.audioImportError == nil)
        let writes = StubProtocol.state.recorded.filter { $0.httpMethod != "GET" }
        #expect(writes.map(\.httpMethod) == ["PATCH", "POST", "POST"])
        #expect(writes[1].httpBody == writes[2].httpBody)
        #expect(writes[1].value(forHTTPHeaderField: "X-File-Name") == writes[2].value(forHTTPHeaderField: "X-File-Name"))
        #expect(try Data(contentsOf: url) == chosen.bytes)
    }

    @Test @MainActor func audioCancellationKeepsSelectionAndRejectsConflictingJobs() async throws {
        let original = try fixture()
        let data = try fixtureData()
        StubProtocol.state.reset { request in
            if request.url?.path == "/api/health" { return StubResponse(readyHealthData) }
            if request.url?.path == "/api/meetings" { return StubResponse(Data("[".utf8) + data + Data("]".utf8)) }
            return StubResponse(data)
        }
        SuspendedAudioProtocol.events.reset()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SuspendedAudioProtocol.self]
        let workspace = Workspace(api: APIClient(session: URLSession(configuration: configuration)), draftStore: temporaryDraftStore())
        await workspace.refresh()
        await workspace.chooseAudioFile(original.id, url: try audioTestFile())
        let file = workspace.chosenAudioFile
        let stream = SuspendedAudioProtocol.events.stream
        let importing = Task { await workspace.importChosenAudioFile(consent: true) }
        for await _ in stream { break }
        #expect(workspace.isWorking && workspace.isImportingAudioFile)
        await workspace.createMeeting()
        await workspace.deleteMeeting(original.id)
        await workspace.summarize(original.id, kind: .extractive)
        #expect(await workspace.importTranscript(original.id, text: "Conflicting text") == false)
        workspace.removeChosenAudioFile()
        #expect(workspace.chosenAudioFile == file)
        workspace.cancelAudioImport()
        #expect(await importing.value == false)
        #expect(workspace.chosenAudioFile == file)
        #expect(workspace.audioImportError?.contains("kept for retry") == true)
        #expect(!workspace.isWorking && !workspace.isImportingAudioFile)
        #expect(try await SuspendedAudioProtocol.events.waitForStop())
        #expect(StubProtocol.state.recorded.filter { $0.httpMethod == "POST" }.count == 1)
    }

    @Test func audioRequestHasAWallClockDeadlineThatCancelsURLSession() async throws {
        let data = try fixtureData()
        StubProtocol.state.reset { _ in StubResponse(data) }
        SuspendedAudioProtocol.events.reset()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SuspendedAudioProtocol.self]
        let api = APIClient(session: URLSession(configuration: configuration), audioImportTimeout: 0.2)
        let file = try ChosenAudioFile(meetingID: "meeting", filename: "deadline.wav", bytes: Data([1]))
        let start = ContinuousClock.now
        do { _ = try await api.importAudioFile(file, consent: true); Issue.record("Suspended request must hit wall-clock deadline") }
        catch { #expect((error as? URLError)?.code == .timedOut) }
        #expect(start.duration(to: .now) < .seconds(2))
        #expect(try await SuspendedAudioProtocol.events.waitForStop())
    }

    @Test @MainActor func recordingGuardRejectsFileSelectionAndCollaborationWithoutDataLoss() async throws {
        let original = try fixture()
        let api = client { _ in StubResponse(opencodeCatalogData) }
        let workspace = Workspace(api: api, draftStore: temporaryDraftStore())
        await workspace.refreshOpenCodeCatalog()
        workspace.edit(original, notes: "Keep this draft")
        workspace.setRecordingHasWork(true)
        let before = StubProtocol.state.recorded.count
        await workspace.chooseAudioFile(original.id, url: try audioTestFile())
        #expect(workspace.chosenAudioFile == nil)
        #expect(await workspace.prepareAgentWork(original.id, source: .notes, instruction: "Review") == nil)
        #expect(await workspace.prepareDriveExport(original.id, server: "chosen-drive", source: .notes, folderID: nil) == nil)
        await workspace.createMeeting()
        #expect(StubProtocol.state.recorded.count == before)
        #expect(workspace.drafts[original.id]?.notes == "Keep this draft")
        workspace.setRecordingHasWork(false)
    }

    @Test @MainActor func agentWorkUsesSavedImmutableConfirmationAndStableRetryID() async throws {
        let original = try fixture()
        let data = try fixtureData()
        let saved = try changedFixture(["notes": "Confirmed source", "revision": 3])
        let result: [String: Any] = ["id": "result-id", "source": "notes", "instruction": "Review decisions", "markdown": "Separate result", "sourceRevision": 3,
                                     "agentID": "moss-summary", "model": ["id": "chat-model", "providerID": "test-a"], "createdAt": "2026-11-02T12:00:00.000Z"]
        let response = try changedFixture(["notes": "Confirmed source", "revision": 3, "agentWork": [result]])
        let api = client { request in
            if request.url?.path == "/api/summary/opencode" { return StubResponse(opencodeCatalogData) }
            if request.httpMethod == "PATCH" { return StubResponse(saved) }
            if request.url?.path.hasSuffix("/agent-work") == true {
                return StubProtocol.state.recorded.filter { $0.url?.path.hasSuffix("/agent-work") == true }.count == 1
                    ? StubResponse(Data(#"{"error":"Response lost; retry same request"}"#.utf8), status: 503) : StubResponse(response)
            }
            if request.url?.path == "/api/health" { return StubResponse(readyHealthData) }
            return StubResponse(Data("[".utf8) + data + Data("]".utf8))
        }
        let workspace = Workspace(api: api, draftStore: temporaryDraftStore())
        await workspace.refresh()
        await workspace.refreshOpenCodeCatalog()
        workspace.edit(original, notes: "Confirmed source")
        let confirmation = try #require(await workspace.prepareAgentWork(original.id, source: .notes, instruction: "Review decisions"))
        #expect(confirmation.snapshot.content == "Confirmed source")
        #expect(UUID(uuidString: confirmation.options.requestID) != nil)
        #expect(confirmation.disclosure.contains("remain in OpenCode session history"))
        #expect(confirmation.disclosure.contains("provider (test-a)"))
        workspace.selectOpenCodeAgent("general")
        workspace.selectOpenCodeModel(SummaryModel(id: "chat-model", providerID: "test-b"))
        #expect(await workspace.runAgentWork(confirmation) == false)
        #expect(workspace.selectedMeeting?.notes == "Confirmed source")
        #expect(workspace.selectedMeeting?.summary == original.summary)
        #expect(workspace.selectedMeeting?.agentWork == nil)
        #expect(await workspace.runAgentWork(confirmation))
        #expect(workspace.selectedMeeting?.agentWork?.count == 1)
        #expect(workspace.selectedMeeting?.summary == original.summary)
        #expect(!workspace.hasUnsavedChanges)
        let writes = StubProtocol.state.recorded.filter { $0.httpMethod != "GET" }
        #expect(writes.map(\.httpMethod) == ["PATCH", "POST", "POST"])
        #expect(writes[1].httpBody == writes[2].httpBody)
        let body = try requestBody(writes[1])
        #expect(body["agentID"] as? String == "moss-summary")
        #expect(body["requestID"] as? String == confirmation.options.requestID)
        let next = try #require(await workspace.prepareAgentWork(original.id, source: .notes, instruction: "Review decisions"))
        #expect(next.options.requestID != confirmation.options.requestID)
    }

    @Test @MainActor func changedSourceRequiresNewAgentConfirmation() async throws {
        let original = try fixture()
        let data = try fixtureData()
        let saved = try changedFixture(["notes": "Changed after review", "revision": 3])
        let api = client { request in
            if request.url?.path == "/api/summary/opencode" { return StubResponse(opencodeCatalogData) }
            if request.httpMethod == "PATCH" { return StubResponse(saved) }
            if request.url?.path == "/api/health" { return StubResponse(readyHealthData) }
            return StubResponse(Data("[".utf8) + data + Data("]".utf8))
        }
        let workspace = Workspace(api: api, draftStore: temporaryDraftStore())
        await workspace.refresh()
        await workspace.refreshOpenCodeCatalog()
        let confirmation = try #require(await workspace.prepareAgentWork(original.id, source: .notes, instruction: "Review"))
        workspace.edit(original, notes: "Changed after review")
        #expect(await workspace.runAgentWork(confirmation) == false)
        #expect(workspace.errorMessage?.contains("source changed after confirmation") == true)
        #expect(!StubProtocol.state.recorded.contains { $0.url?.path.hasSuffix("/agent-work") == true })
        #expect(confirmation.snapshot.content == original.notes)
    }

    @Test(arguments: [500, 409]) @MainActor func failedSaveBlocksNewSharingActionsAndRetainsDraftAndFile(_ status: Int) async throws {
        let original = try fixture()
        let data = try fixtureData()
        let api = client { request in
            if request.url?.path == "/api/summary/opencode" { return StubResponse(opencodeCatalogData) }
            if request.url?.path == "/api/drive" { return StubResponse(driveCatalogData) }
            if request.httpMethod == "PATCH" { return StubResponse(Data(#"{"error":"Save rejected"}"#.utf8), status: status) }
            if request.url?.path == "/api/health" { return StubResponse(readyHealthData) }
            return StubResponse(Data("[".utf8) + data + Data("]".utf8))
        }
        let store = temporaryDraftStore()
        let workspace = Workspace(api: api, draftStore: store)
        await workspace.refresh()
        await workspace.refreshOpenCodeCatalog()
        await workspace.refreshDriveCatalog()
        workspace.selectOpenCodeAgent("general")
        await workspace.chooseAudioFile(original.id, url: try audioTestFile())
        let file = workspace.chosenAudioFile
        workspace.edit(original, notes: "Recover this draft")
        #expect(await workspace.prepareAgentWork(original.id, source: .meeting, instruction: "Review") == nil)
        #expect(await workspace.prepareDriveExport(original.id, server: "chosen-drive", source: .notes, folderID: nil) == nil)
        #expect(await workspace.importChosenAudioFile(consent: true) == false)
        for format in ExportFormat.allCases {
            do { _ = try await workspace.export(original.id, format: format); Issue.record("Export must require a successful save") }
            catch { #expect(error is APIError) }
        }
        #expect(!StubProtocol.state.recorded.contains { $0.httpMethod == "POST" || $0.url?.path.hasSuffix("/export") == true })
        #expect(workspace.chosenAudioFile == file)
        #expect(workspace.drafts[original.id]?.notes == "Recover this draft")
        #expect(workspace.selectedMeeting?.summary == original.summary)
        #expect(workspace.conflictedIDs.contains(original.id) == (status == 409))
        #expect(try store.load().first?.draft.notes == "Recover this draft")
    }

    @Test @MainActor func driveHandoffSavesFirstUsesConfirmedOptionsAndOnlyClaimsSubmitted() async throws {
        let original = try fixture()
        let data = try fixtureData()
        let saved = try changedFixture(["notes": "Saved Drive source", "revision": 3])
        let api = client { request in
            if request.url?.path == "/api/summary/opencode" { return StubResponse(opencodeCatalogData) }
            if request.url?.path == "/api/drive" { return StubResponse(driveCatalogData) }
            if request.httpMethod == "PATCH" { return StubResponse(saved) }
            if request.url?.path.hasSuffix("/drive-export") == true { return StubResponse(driveHandoffData) }
            if request.url?.path == "/api/health" { return StubResponse(readyHealthData) }
            return StubResponse(Data("[".utf8) + data + Data("]".utf8))
        }
        let workspace = Workspace(api: api, draftStore: temporaryDraftStore())
        await workspace.refresh()
        await workspace.refreshOpenCodeCatalog()
        await workspace.refreshDriveCatalog()
        workspace.selectOpenCodeAgent("general")
        #expect(await workspace.prepareDriveExport(original.id, server: "other-service", source: .notes, folderID: nil) == nil)
        workspace.edit(original, notes: "Saved Drive source")
        let confirmation = try #require(await workspace.prepareDriveExport(original.id, server: "chosen-drive", source: .notes, folderID: "chosen-folder"))
        #expect(confirmation.snapshot.content == "Saved Drive source")
        #expect(confirmation.disclosure.contains("No tool write is automatically approved"))
        #expect(confirmation.disclosure.contains("Execute and Code Mode are denied"))
        #expect(confirmation.disclosure.contains("codemode:false"))
        workspace.selectOpenCodeAgent("moss-summary")
        #expect(await workspace.exportDrive(confirmation))
        #expect(workspace.driveHandoffs[original.id]?.sessionID == "ses_fixture_only")
        #expect(workspace.driveHandoffs[original.id]?.status == .submitted)
        #expect(workspace.selectedMeeting?.notes == "Saved Drive source")
        #expect(workspace.selectedMeeting?.summary == original.summary)
        let writes = StubProtocol.state.recorded.filter { $0.httpMethod != "GET" }
        #expect(writes.map(\.httpMethod) == ["PATCH", "POST"])
        let body = try requestBody(writes[1])
        #expect(body["agentID"] as? String == confirmation.options.agentID)
        #expect(body["folderID"] as? String == "chosen-folder")
        #expect(body["source"] as? String == "notes")
        #expect(body["server"] as? String == "chosen-drive")
    }

    @Test @MainActor func driveCatalogErrorsCanRefreshAndConnectNeverOverwritesConfiguration() async throws {
        let api = client { request in
            if StubProtocol.state.recorded.count == 1 { return StubResponse(Data(#"{"error":"OpenCode unavailable"}"#.utf8), status: 503) }
            return StubResponse(driveCatalogData)
        }
        let workspace = Workspace(api: api, draftStore: temporaryDraftStore())
        await workspace.refreshDriveCatalog()
        #expect(workspace.driveCatalog == nil)
        #expect(workspace.driveCatalogError == "OpenCode unavailable")
        await workspace.refreshDriveCatalog()
        #expect(workspace.driveCatalog?.servers.count == 2)
        #expect(workspace.driveCatalogError == nil)
        let before = StubProtocol.state.recorded.count
        await workspace.connectDrive(try DriveConnectionOptions(server: "chosen-drive", url: "https://mcp.example.invalid/drive"))
        #expect(StubProtocol.state.recorded.count == before)
        #expect(workspace.driveCatalogError?.contains("will not be overwritten") == true)
        await workspace.connectDrive(try DriveConnectionOptions(server: "chosen-drive"))
        #expect(StubProtocol.state.recorded.last?.url?.path == "/api/drive/connect")
        #expect(workspace.driveCatalogError == nil)
    }

    @Test func selectedSourcesDoNotLeakUnselectedMeetingContent() throws {
        let meeting = try fixture(["notes": "private notes", "summary": ["markdown": "private summary", "kind": "ai", "sourceRevision": 2]])
        #expect(ContentSnapshot(meeting: meeting, source: .notes).content == "private notes")
        let transcript = ContentSnapshot(meeting: meeting, source: .transcript)
        #expect(!transcript.content.contains("private notes") && !transcript.content.contains("private summary"))
        #expect(ContentSnapshot(meeting: meeting, source: .summary).content == "private summary")
        let whole = ContentSnapshot(meeting: meeting, source: .meeting)
        #expect(whole.content.contains("private summary") && whole.content.contains("private notes"))
        #expect(whole.content.contains(meeting.segments[0].text))
        #expect(!whole.matches(try fixture(["notes": "changed"])))
        #expect(transcript.matches(try fixture(["notes": "changed"])))
    }

    @Test func resultMarkdownDownloadCannotOverwriteExistingFiles() throws {
        let result = try JSONDecoder().decode(AgentWork.self, from: Data(##"{"id":"result","source":"summary","instruction":"Review","markdown":"# Independent result\n","sourceRevision":2,"agentID":"general","model":{"id":"model","providerID":"provider"},"createdAt":"2026-11-02T12:00:00Z"}"##.utf8))
        let original = try audioTestFile(Data("Existing document".utf8))
        #expect(throws: (any Error).self) { try result.writeMarkdown(to: original) }
        #expect(try Data(contentsOf: original) == Data("Existing document".utf8))
        let output = original.deletingLastPathComponent().appendingPathComponent("new-result.md")
        try result.writeMarkdown(to: output)
        #expect(try String(contentsOf: output, encoding: .utf8) == "# Independent result\n")
    }

    @Test func wholeMeetingConfirmationIncludesPreviousAgentResults() throws {
        let result: [String: Any] = ["id": "previous", "source": "notes", "instruction": "Review", "markdown": "Previous agent output", "sourceRevision": 2,
                                     "agentID": "moss-reviewer", "model": ["id": "model", "providerID": "provider"], "createdAt": "2026-11-02T12:00:00Z"]
        let meeting = try fixture(["agentWork": [result]])
        let snapshot = ContentSnapshot(meeting: meeting, source: .meeting)
        #expect(snapshot.content.contains("Previous agent output"))
        #expect(!snapshot.matches(try fixture()))
        #expect(!ContentSnapshot(meeting: meeting, source: .notes).content.contains("Previous agent output"))
    }

    @Test @MainActor func editsWhilePreparingAgentConfirmationKeepTheDraftAndStopTheAction() async throws {
        let original = try fixture()
        let data = try fixtureData()
        let saved = try changedFixture(["notes": "Submitted notes", "revision": 3])
        let gate = RequestGate()
        let api = client { request in
            if request.url?.path == "/api/summary/opencode" { return StubResponse(opencodeCatalogData) }
            if request.httpMethod == "PATCH" { try gate.waitForRelease(); return StubResponse(saved) }
            if request.url?.path == "/api/health" { return StubResponse(readyHealthData) }
            return StubResponse(Data("[".utf8) + data + Data("]".utf8))
        }
        let workspace = Workspace(api: api, draftStore: temporaryDraftStore())
        await workspace.refresh()
        await workspace.refreshOpenCodeCatalog()
        workspace.edit(original, notes: "Submitted notes")
        let preparing = Task { await workspace.prepareAgentWork(original.id, source: .notes, instruction: "Review") }
        for await _ in gate.arrived.stream { break }
        workspace.edit(original, notes: "Typed during save")
        gate.release.signal()
        #expect(await preparing.value == nil)
        #expect(workspace.drafts[original.id]?.notes == "Typed during save")
        #expect(workspace.drafts[original.id]?.patch.expected.notes == "Submitted notes")
        #expect(!StubProtocol.state.recorded.contains { $0.httpMethod == "POST" })
    }

    @Test @MainActor func failedDriveHandoffKeepsSavedOriginalsAndKnownSubmittedSession() async throws {
        let original = try fixture()
        let data = try fixtureData()
        let api = client { request in
            if request.url?.path == "/api/summary/opencode" { return StubResponse(opencodeCatalogData) }
            if request.url?.path == "/api/drive" { return StubResponse(driveCatalogData) }
            if request.url?.path.hasSuffix("/drive-export") == true {
                return StubProtocol.state.recorded.filter { $0.url?.path.hasSuffix("/drive-export") == true }.count == 1
                    ? StubResponse(driveHandoffData) : StubResponse(Data(#"{"error":"Submission outcome unknown; check OpenCode"}"#.utf8), status: 503)
            }
            if request.url?.path == "/api/health" { return StubResponse(readyHealthData) }
            return StubResponse(Data("[".utf8) + data + Data("]".utf8))
        }
        let workspace = Workspace(api: api, draftStore: temporaryDraftStore())
        await workspace.refresh()
        await workspace.refreshOpenCodeCatalog()
        await workspace.refreshDriveCatalog()
        workspace.selectOpenCodeAgent("general")
        let confirmation = try #require(await workspace.prepareDriveExport(original.id, server: "chosen-drive", source: .summary, folderID: nil))
        #expect(await workspace.exportDrive(confirmation))
        let previous = workspace.driveHandoffs[original.id]
        #expect(await workspace.exportDrive(confirmation) == false)
        #expect(workspace.errorMessage?.contains("outcome unknown") == true)
        #expect(workspace.driveHandoffs[original.id] == previous)
        #expect(workspace.selectedMeeting == original)
        #expect(!workspace.isWorking)
    }

    @Test(arguments: ContentSource.allCases) func agentWireSourceValuesStayExact(_ source: ContentSource) async throws {
        let data = try fixtureData()
        let api = client { _ in StubResponse(data) }
        let selection = OpenCodeSummaryOptions(agentID: "general", model: SummaryModel(id: "model", providerID: "provider"))
        _ = try await api.agentWork("meeting", options: AgentWorkOptions(source: source, instruction: "Inspect selected content", selection: selection))
        let request = try #require(StubProtocol.state.recorded.first)
        #expect(try requestBody(request)["source"] as? String == source.rawValue)
    }

    @Test(arguments: ["unavailable", "idle", "preparing", "error", "ready"])
    @MainActor func audioImportRequiresReadyHexAndAvailableFFmpeg(_ state: String) async throws {
        let original = try fixture()
        let data = try fixtureData()
        var object = try #require(JSONSerialization.jsonObject(with: readyHealthData) as? [String: Any])
        object["hex"] = ["state": state, "model": "fixture", "message": "Prepare the model first"]
        object["audioImport"] = ["available": state != "ready", "message": "Fixture ffmpeg", "formats": ["wav"], "maxBytes": 104_857_600, "maxDurationMs": 7_200_000]
        let health = try JSONSerialization.data(withJSONObject: object)
        let api = client { request in
            if request.url?.path == "/api/health" { return StubResponse(health) }
            return StubResponse(Data("[".utf8) + data + Data("]".utf8))
        }
        let workspace = Workspace(api: api, draftStore: temporaryDraftStore())
        await workspace.refresh()
        await workspace.chooseAudioFile(original.id, url: try audioTestFile())
        let file = workspace.chosenAudioFile
        #expect(!workspace.canImportAudioFile)
        #expect(await workspace.importChosenAudioFile(consent: true) == false)
        #expect(workspace.chosenAudioFile == file)
        #expect(workspace.audioImportError?.contains(state == "ready" ? "ffmpeg" : "Prepare the Hex model") == true)
        #expect(!StubProtocol.state.recorded.contains { $0.httpMethod == "POST" })
        #expect(!workspace.isWorking)
    }

    @Test(arguments: ["moss-summary", "moss-reviewer", "moss-editor"])
    @MainActor func driveExportRejectsKnownTextOnlyAgentsBeforeSubmitting(_ agent: String) async throws {
        let original = try fixture()
        let data = try fixtureData()
        var catalog = try #require(JSONSerialization.jsonObject(with: opencodeCatalogData) as? [String: Any])
        catalog["agents"] = [["id": agent, "name": "Text-only profile"], ["id": "general", "name": "General"]]
        let catalogData = try JSONSerialization.data(withJSONObject: catalog)
        let api = client { request in
            if request.url?.path == "/api/summary/opencode" { return StubResponse(catalogData) }
            if request.url?.path == "/api/drive" { return StubResponse(driveCatalogData) }
            if request.url?.path == "/api/health" { return StubResponse(readyHealthData) }
            return StubResponse(Data("[".utf8) + data + Data("]".utf8))
        }
        let workspace = Workspace(api: api, draftStore: temporaryDraftStore())
        await workspace.refresh()
        await workspace.refreshOpenCodeCatalog()
        await workspace.refreshDriveCatalog()
        workspace.selectOpenCodeAgent(agent)
        #expect(workspace.selectedAgentIsTextOnlyForDrive)
        #expect(await workspace.prepareDriveExport(original.id, server: "chosen-drive", source: .meeting, folderID: nil) == nil)
        let options = DriveExportOptions(server: "chosen-drive", source: .meeting, selection: try #require(workspace.opencodeSelection))
        #expect(await workspace.exportDrive(DriveExportConfirmation(meeting: original, options: options)) == false)
        #expect(workspace.errorMessage?.contains("Choose moss-drive") == true)
        #expect(!StubProtocol.state.recorded.contains { $0.httpMethod == "POST" })
        workspace.selectOpenCodeAgent("general")
        #expect(!workspace.selectedAgentIsTextOnlyForDrive)
    }
}
