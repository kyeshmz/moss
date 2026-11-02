import Foundation
import Observation

@MainActor @Observable
public final class Workspace {
    public private(set) var meetings: [Meeting] = []
    public var selectedID: String?
    public private(set) var health: Health?
    public private(set) var connectionError: String?
    public var errorMessage: String?
    public private(set) var isWorking = false
    public private(set) var isPreparing = false
    public private(set) var deletingID: String?
    public private(set) var drafts: [String: MeetingDraft] = [:]
    public private(set) var savingIDs: Set<String> = []
    public private(set) var saveErrors: [String: String] = [:]
    public private(set) var conflictedIDs: Set<String> = []
    public private(set) var draftPersistenceError: String?
    public private(set) var opencodeCatalog: OpenCodeSummaryCatalog?
    public private(set) var opencodeCatalogError: String?
    public private(set) var isLoadingOpenCodeCatalog = false
    public private(set) var opencodeSelection: OpenCodeSummaryOptions?
    public private(set) var hasRecordingWork = false
    public private(set) var chosenAudioFile: ChosenAudioFile?
    public private(set) var isImportingAudioFile = false
    public private(set) var audioImportError: String?
    public private(set) var driveCatalog: DriveCatalog?
    public private(set) var driveCatalogError: String?
    public private(set) var isLoadingDriveCatalog = false
    public private(set) var driveHandoffs: [String: DriveExportHandoff] = [:]
    @ObservationIgnored private let api: APIClient
    @ObservationIgnored private let draftStore: DraftStore
    @ObservationIgnored private var recoveryBlocked = false
    @ObservationIgnored private var inFlightEdits: [String: MeetingDraft] = [:]
    @ObservationIgnored private var scheduledSaves: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var audioImportTask: Task<Meeting, Error>?

    public init(api: APIClient = APIClient(), draftStore: DraftStore = .application) {
        self.api = api
        self.draftStore = draftStore
        restoreDrafts()
    }
    public var selectedMeeting: Meeting? { meetings.first { $0.id == selectedID } }
    public var hasUnsavedChanges: Bool { !savingIDs.isEmpty || drafts.values.contains { $0.isDirty } }
    public var blocksCapture: Bool { isWorking || chosenAudioFile != nil }
    public var canImportAudioFile: Bool { health?.hex.state == .ready && health?.audioImport?.available != false }
    public var selectedAgentIsTextOnlyForDrive: Bool {
        opencodeSelection.map { Self.textOnlyDriveAgents.contains($0.agentID) } ?? false
    }
    private static let textOnlyDriveAgents: Set<String> = ["moss-summary", "moss-reviewer", "moss-editor"]

    public func setRecordingHasWork(_ value: Bool) { hasRecordingWork = value }

    public func draft(for meeting: Meeting) -> MeetingDraft {
        drafts[meeting.id] ?? MeetingDraft(meeting: meeting)
    }

    public func edit(_ meeting: Meeting, title: String? = nil, notes: String? = nil) {
        guard deletingID != meeting.id else { return }
        var draft = draft(for: meeting)
        if let title { draft.title = title }
        if let notes { draft.notes = notes }
        drafts[meeting.id] = draft.isDirty || savingIDs.contains(meeting.id) ? draft : nil
        if !conflictedIDs.contains(meeting.id) { saveErrors[meeting.id] = nil }
        if !draft.isDirty, !savingIDs.contains(meeting.id) {
            conflictedIDs.remove(meeting.id)
            saveErrors[meeting.id] = nil
        }
        persistDrafts()
        scheduleSave(meeting.id)
    }

    private func scheduleSave(_ id: String) {
        scheduledSaves[id]?.cancel()
        scheduledSaves[id] = nil
        guard !conflictedIDs.contains(id), drafts[id]?.isDirty == true else { return }
        scheduledSaves[id] = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(800)) } catch { return }
            guard let self else { return }
            self.scheduledSaves[id] = nil
            await self.save(id)
        }
    }

    @discardableResult public func save(_ id: String) async -> Bool {
        guard deletingID != id else { return false }
        guard !savingIDs.contains(id) else { return false }
        guard !conflictedIDs.contains(id) else { return false }
        guard let snapshot = drafts[id], snapshot.isDirty else { return true }
        scheduledSaves[id]?.cancel()
        scheduledSaves[id] = nil
        savingIDs.insert(id)
        defer { savingIDs.remove(id) }
        return await saveSnapshot(id, snapshot: snapshot)
    }

    @discardableResult public func replaceConflictingFieldsAfterConfirmation(_ id: String) async -> Bool {
        guard conflictedIDs.contains(id), deletingID != id, !savingIDs.contains(id),
              let approvedDraft = drafts[id] else { return false }
        savingIDs.insert(id)
        defer { savingIDs.remove(id) }
        do {
            let fresh = try await api.meetings()
            guard let meeting = fresh.first(where: { $0.id == id }) else {
                throw APIError(message: "This meeting no longer exists on the service. Your local draft is kept.")
            }
            guard drafts[id] == approvedDraft else {
                throw APIError(message: "Your draft changed during the conflict check. Review it and confirm replacement again.")
            }
            var replacement = approvedDraft
            replacement.replaceConflictingBases(on: meeting)
            drafts[id] = replacement.isDirty ? replacement : nil
            conflictedIDs.remove(id)
            saveErrors[id] = nil
            merge(meeting)
            persistDrafts()
            guard replacement.isDirty else { return true }
            return await saveSnapshot(id, snapshot: replacement)
        } catch {
            saveErrors[id] = error.localizedDescription
            return false
        }
    }

    private func saveSnapshot(_ id: String, snapshot: MeetingDraft) async -> Bool {
        inFlightEdits[id] = snapshot
        persistDrafts()
        do {
            let meeting = try await api.updateMeeting(id, patch: snapshot.patch)
            if var current = drafts[id] {
                current.acknowledge(snapshot, returned: meeting)
                drafts[id] = current.isDirty ? current : nil
            }
            merge(meeting)
            saveErrors[id] = nil
            conflictedIDs.remove(id)
            inFlightEdits[id] = nil
            persistDrafts()
            if drafts[id]?.isDirty == true { scheduleSave(id) }
            return drafts[id]?.isDirty != true
        } catch {
            if let current = drafts[id] {
                let recovered = current.recoveringUncertainSave(snapshot)
                drafts[id] = recovered.isDirty ? recovered : nil
            }
            inFlightEdits[id] = nil
            if (error as? APIError)?.statusCode == 409 {
                conflictedIDs.insert(id)
                scheduledSaves[id]?.cancel()
                scheduledSaves[id] = nil
            }
            saveErrors[id] = error.localizedDescription
            persistDrafts()
            return false
        }
    }

    public func refresh() async {
        await refreshHealth()
        do {
            let incoming = try await api.meetings()
            // Keep local drafts visible even if another client deletes their meeting.
            meetings.removeAll { old in !incoming.contains { $0.id == old.id } && drafts[old.id] == nil }
            for meeting in incoming { merge(meeting) }
            if selectedID == nil { selectedID = meetings.first?.id }
        } catch { errorMessage = error.localizedDescription }
    }

    public func refreshHealth() async {
        do {
            health = try await api.health()
            connectionError = nil
        } catch {
            health = nil
            connectionError = "Cannot reach the local Moss service at 127.0.0.1:4310. \(error.localizedDescription)"
        }
    }

    public func prepareEngine() async {
        guard !isPreparing else { return }
        isPreparing = true
        defer { isPreparing = false }
        do { health = try await api.prepareEngine(); connectionError = nil }
        catch { errorMessage = error.localizedDescription }
    }

    public func refreshOpenCodeCatalog() async {
        guard !isLoadingOpenCodeCatalog, !isWorking else { return }
        isLoadingOpenCodeCatalog = true
        defer { isLoadingOpenCodeCatalog = false }
        do {
            let catalog = try await api.opencodeSummaryCatalog()
            opencodeSelection = catalog.selection(preserving: opencodeSelection)
            opencodeCatalog = catalog
            opencodeCatalogError = nil
        } catch {
            opencodeCatalog = nil
            opencodeSelection = nil
            opencodeCatalogError = error.localizedDescription
        }
    }

    public func selectOpenCodeAgent(_ id: String) {
        guard !isWorking, !isLoadingOpenCodeCatalog, let selection = opencodeSelection,
              opencodeCatalog?.agents.contains(where: { $0.id == id }) == true else { return }
        opencodeSelection = OpenCodeSummaryOptions(agentID: id, model: selection.model)
    }

    public func selectOpenCodeModel(_ model: SummaryModel) {
        guard !isWorking, !isLoadingOpenCodeCatalog, let selection = opencodeSelection else { return }
        let next = OpenCodeSummaryOptions(agentID: selection.agentID, model: model)
        guard opencodeCatalog?.contains(next) == true else { return }
        opencodeSelection = next
    }

    public func selectOpenCodeVariant(_ variant: String?) {
        guard let model = opencodeSelection?.model else { return }
        selectOpenCodeModel(SummaryModel(id: model.id, providerID: model.providerID, variant: variant))
    }

    public func createMeeting() async {
        guard !isWorking, !hasRecordingWork else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            let meeting = try await api.createMeeting()
            merge(meeting)
            selectedID = meeting.id
        } catch { errorMessage = error.localizedDescription }
    }

    public func deleteMeeting(_ id: String) async {
        guard !isWorking, !hasRecordingWork else { return }
        guard chosenAudioFile?.meetingID != id else {
            errorMessage = "Import or remove the selected audio file before deleting its meeting. The original file is unchanged."
            return
        }
        guard !savingIDs.contains(id) else {
            errorMessage = "Wait for notes to finish saving before deleting the meeting."
            return
        }
        scheduledSaves[id]?.cancel()
        scheduledSaves[id] = nil
        isWorking = true
        deletingID = id
        defer {
            isWorking = false
            deletingID = nil
            if drafts[id]?.isDirty == true { scheduleSave(id) }
        }
        do {
            try await api.deleteMeeting(id)
            scheduledSaves[id]?.cancel()
            scheduledSaves[id] = nil
            drafts[id] = nil
            saveErrors[id] = nil
            conflictedIDs.remove(id)
            persistDrafts()
            meetings.removeAll { $0.id == id }
            if selectedID == id { selectedID = meetings.first?.id }
        } catch { errorMessage = error.localizedDescription }
    }

    @discardableResult public func importTranscript(_ id: String, text: String) async -> Bool {
        guard !isWorking, !hasRecordingWork else { return false }
        isWorking = true
        defer { isWorking = false }
        do { merge(try await api.importTranscript(id, text: text)); return true }
        catch { errorMessage = error.localizedDescription; return false }
    }

    public func summarize(_ id: String, kind: SummaryKind, options: OpenCodeSummaryOptions? = nil) async {
        guard !isWorking, !hasRecordingWork else { return }
        if kind == .opencode {
            guard !isLoadingOpenCodeCatalog, let options, opencodeCatalog?.contains(options) == true else {
                errorMessage = "Refresh OpenCode models and confirm an available agent and model before summarizing."
                return
            }
        }
        isWorking = true
        defer { isWorking = false }
        guard await save(id) else {
            errorMessage = "Save your latest notes before generating highlights. Your draft is still here."
            return
        }
        do { merge(try await api.summarize(id, kind: kind, options: options)) }
        catch { errorMessage = error.localizedDescription }
    }

    public func exportMarkdown(_ id: String) async throws -> String {
        guard !isWorking else { throw APIError(message: "Wait for the current action before exporting.") }
        isWorking = true
        defer { isWorking = false }
        guard await save(id) else {
            throw APIError(message: "Notes have not finished saving. Retry Save before exporting.")
        }
        return try await api.exportMarkdown(id)
    }

    public func uploadAudio(_ id: String, chunk: AudioChunk) async throws {
        guard !isImportingAudioFile else { throw APIError(message: "Finish the audio file import before uploading microphone audio.") }
        merge(try await api.uploadAudio(id, chunk: chunk))
    }

    public func export(_ id: String, format: ExportFormat) async throws -> Data {
        guard !isWorking else { throw APIError(message: "Wait for the current action before exporting.") }
        isWorking = true
        defer { isWorking = false }
        guard await save(id) else { throw APIError(message: "Notes have not finished saving. Retry Save before exporting.") }
        return try await api.export(id, format: format)
    }

    public func chooseAudioFile(_ id: String, url: URL) async {
        guard !isWorking, !hasRecordingWork else {
            errorMessage = "Finish the current action and pending microphone uploads before choosing an audio file."
            return
        }
        guard chosenAudioFile == nil else {
            audioImportError = "One file at a time. Import or remove the current selection first. The original file is unchanged."
            return
        }
        isWorking = true
        defer { isWorking = false }
        do {
            chosenAudioFile = try await Task.detached { try ChosenAudioFile.read(meetingID: id, url: url) }.value
            audioImportError = nil
        } catch { audioImportError = error.localizedDescription }
    }

    public func removeChosenAudioFile() {
        guard !isWorking else { return }
        chosenAudioFile = nil
        audioImportError = nil
    }

    @discardableResult public func importChosenAudioFile(consent: Bool) async -> Bool {
        guard !isWorking, !hasRecordingWork, let file = chosenAudioFile else { return false }
        guard consent else {
            audioImportError = "Participant consent is required. Dropping a file does not authorize transcription."
            return false
        }
        guard canImportAudioFile else {
            audioImportError = health?.hex.state != .ready
                ? "Prepare the Hex model in the sidebar first. Audio-file import requires the local engine to be ready. Your chosen file is kept."
                : "Audio-file import is unavailable. Check the local ffmpeg status. Your chosen file is kept."
            return false
        }
        isWorking = true
        audioImportError = nil
        defer { isWorking = false; isImportingAudioFile = false; audioImportTask = nil }
        guard await save(file.meetingID) else {
            audioImportError = "Save your latest notes before importing. Your draft and chosen audio file are kept."
            return false
        }
        isImportingAudioFile = true
        let task = Task { try await api.importAudioFile(file, consent: consent) }
        audioImportTask = task
        do {
            let meeting = try await task.value
            merge(meeting)
            chosenAudioFile = nil
            return true
        } catch {
            audioImportError = "\(error.localizedDescription) The chosen file is kept for retry. Cancellation can race an acknowledgement; identical retries are deduplicated by the service. The original file is unchanged."
            return false
        }
    }

    public func cancelAudioImport() { audioImportTask?.cancel() }

    public func prepareAgentWork(_ id: String, source: ContentSource, instruction: String) async -> AgentWorkConfirmation? {
        guard !isWorking, !hasRecordingWork, !isLoadingOpenCodeCatalog,
              let selection = opencodeSelection, opencodeCatalog?.contains(selection) == true else { return nil }
        guard !instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            errorMessage = "Enter an instruction for the selected agent."
            return nil
        }
        isWorking = true
        defer { isWorking = false }
        guard await save(id), let meeting = meetings.first(where: { $0.id == id }) else {
            errorMessage = "Save your latest notes before asking an agent. Your draft is still here."
            return nil
        }
        return AgentWorkConfirmation(meeting: meeting, options: AgentWorkOptions(source: source, instruction: instruction, selection: selection))
    }

    @discardableResult public func runAgentWork(_ confirmation: AgentWorkConfirmation) async -> Bool {
        guard !isWorking, !hasRecordingWork else { return false }
        guard !isLoadingOpenCodeCatalog, opencodeCatalog?.contains(confirmation.options.selection) == true else {
            errorMessage = "Refresh OpenCode and review an available agent and model again."
            return false
        }
        isWorking = true
        defer { isWorking = false }
        guard await save(confirmation.meetingID) else {
            errorMessage = "Save your latest notes before asking an agent. Your draft is still here."
            return false
        }
        guard matches(confirmation.snapshot, id: confirmation.meetingID) else { return false }
        do {
            merge(try await api.agentWork(confirmation.meetingID, options: confirmation.options))
            return true
        } catch { errorMessage = error.localizedDescription; return false }
    }

    public func refreshDriveCatalog() async {
        guard !isWorking, !isLoadingDriveCatalog else { return }
        isLoadingDriveCatalog = true
        defer { isLoadingDriveCatalog = false }
        do { driveCatalog = try await api.driveCatalog(); driveCatalogError = nil }
        catch { driveCatalog = nil; driveCatalogError = error.localizedDescription }
    }

    public func connectDrive(_ options: DriveConnectionOptions) async {
        guard !isWorking, !hasRecordingWork, !isLoadingDriveCatalog else { return }
        if options.url != nil, driveCatalog?.servers.contains(where: { $0.name == options.server }) == true {
            driveCatalogError = "This server already exists. Select it without an endpoint; existing configuration will not be overwritten."
            return
        }
        isWorking = true
        defer { isWorking = false }
        do { driveCatalog = try await api.connectDrive(options); driveCatalogError = nil }
        catch { driveCatalogError = error.localizedDescription }
    }

    public func prepareDriveExport(_ id: String, server: String, source: ContentSource, folderID: String?) async -> DriveExportConfirmation? {
        guard !isWorking, !hasRecordingWork, !isLoadingOpenCodeCatalog, !isLoadingDriveCatalog,
              let selection = opencodeSelection, opencodeCatalog?.contains(selection) == true,
              driveCatalog?.servers.contains(where: { $0.name == server && $0.status == .connected }) == true else { return nil }
        guard validateDriveAgent(selection) else { return nil }
        isWorking = true
        defer { isWorking = false }
        guard await save(id), let meeting = meetings.first(where: { $0.id == id }) else {
            errorMessage = "Save your latest notes before sending a Drive handoff. Your draft is still here."
            return nil
        }
        let options = DriveExportOptions(server: server, source: source, folderID: folderID, selection: selection)
        return DriveExportConfirmation(meeting: meeting, options: options)
    }

    @discardableResult public func exportDrive(_ confirmation: DriveExportConfirmation) async -> Bool {
        guard !isWorking, !hasRecordingWork else { return false }
        let options = confirmation.options
        guard validateDriveAgent(options.selection) else { return false }
        guard !isLoadingOpenCodeCatalog, !isLoadingDriveCatalog, opencodeCatalog?.contains(options.selection) == true,
              driveCatalog?.servers.contains(where: { $0.name == options.server && $0.status == .connected }) == true else {
            errorMessage = "Refresh and review the connected Drive server, agent, and model again."
            return false
        }
        isWorking = true
        defer { isWorking = false }
        guard await save(confirmation.meetingID) else {
            errorMessage = "Save your latest notes before sending a Drive handoff. Your draft is still here."
            return false
        }
        guard matches(confirmation.snapshot, id: confirmation.meetingID) else { return false }
        do {
            driveHandoffs[confirmation.meetingID] = try await api.exportDrive(confirmation.meetingID, options: options)
            return true
        } catch { errorMessage = error.localizedDescription; return false }
    }

    private func matches(_ snapshot: ContentSnapshot, id: String) -> Bool {
        guard let meeting = meetings.first(where: { $0.id == id }), snapshot.matches(meeting) else {
            errorMessage = "The selected source changed after confirmation. Review it in a new confirmation before sending."
            return false
        }
        return true
    }

    private func validateDriveAgent(_ selection: OpenCodeSummaryOptions) -> Bool {
        guard !Self.textOnlyDriveAgents.contains(selection.agentID) else {
            errorMessage = "Choose moss-drive or another Drive-capable agent above. moss-summary, moss-reviewer, and moss-editor are text-only and cannot export to Drive."
            return false
        }
        return true
    }

    private func merge(_ meeting: Meeting) {
        if let index = meetings.firstIndex(where: { $0.id == meeting.id }) {
            guard meeting.revision >= meetings[index].revision else { return }
            meetings[index] = meeting
        } else { meetings.append(meeting) }
        if var draft = drafts[meeting.id], !savingIDs.contains(meeting.id) {
            draft.rebase(on: meeting)
            drafts[meeting.id] = draft.isDirty ? draft : nil
            if !draft.isDirty { saveErrors[meeting.id] = nil }
            persistDrafts()
        }
        meetings.sort { $0.updatedAt > $1.updatedAt }
    }

    public func retryDraftPersistence() {
        if recoveryBlocked { restoreDrafts() }
        if !recoveryBlocked { persistDrafts() }
    }

    private func restoreDrafts() {
        do {
            let records = try draftStore.load()
            for record in records where drafts[record.meetingID] == nil {
                drafts[record.meetingID] = record.draft
                if record.hasConflict { conflictedIDs.insert(record.meetingID) }
                if !meetings.contains(where: { $0.id == record.meetingID }) {
                    meetings.append(record.draft.recoveredMeeting(id: record.meetingID))
                }
            }
            if selectedID == nil { selectedID = meetings.first?.id }
            recoveryBlocked = false
            draftPersistenceError = nil
        } catch {
            recoveryBlocked = true
            showDraftPersistenceError(error)
        }
    }

    private func persistDrafts() {
        guard !recoveryBlocked else { return }
        let records = drafts.compactMap { id, draft -> StoredDraft? in
            let recovered = inFlightEdits[id].map { draft.recoveringUncertainSave($0) } ?? draft
            guard recovered.isDirty else { return nil }
            return StoredDraft(meetingID: id, draft: recovered,
                               hasConflict: conflictedIDs.contains(id) || inFlightEdits[id] != nil)
        }.sorted { $0.meetingID < $1.meetingID }
        do {
            try draftStore.save(records)
            draftPersistenceError = nil
        } catch { showDraftPersistenceError(error) }
    }

    private func showDraftPersistenceError(_ error: Error) {
        draftPersistenceError = "Draft recovery is not safe to rely on. Keep Moss open until your edits save. \(error.localizedDescription) Draft file: \(draftStore.fileURL.path)"
    }
}
