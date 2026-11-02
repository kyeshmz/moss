import AppKit
import MossKit
import SwiftUI
import UniformTypeIdentifiers

struct WorkspaceView: View {
    @Bindable var workspace: Workspace
    @Bindable var recording: RecordingSession
    @Environment(\.colorScheme) private var colorScheme
    @State private var search = ""
    @State private var importText = ""
    @State private var importingID: String?
    @State private var deletingID: String?
    @State private var confirmRecordingID: String?
    @State private var confirmAIID: String?
    @State private var confirmDiscardAudio = false
    @State private var replacingConflictID: String?

    private var theme: MossTheme { MossTheme(colorScheme: colorScheme) }

    private var filteredMeetings: [Meeting] {
        workspace.meetings.filter {
            search.isEmpty || workspace.draft(for: $0).title.localizedCaseInsensitiveContains(search)
                || workspace.draft(for: $0).notes.localizedCaseInsensitiveContains(search)
        }
    }

    var body: some View {
        NavigationSplitView {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 8) {
                    Text("Moss").font(.system(size: 14, weight: .semibold))
                    Spacer()
                    Button { Task { await workspace.createMeeting() } } label: {
                        Image(systemName: "plus").frame(width: 28, height: 28)
                    }
                    .buttonStyle(.borderless)
                    .help("New meeting").accessibilityLabel("New meeting")
                    .disabled(workspace.isWorking || recording.hasWork)
                }
                .padding(.horizontal, 16).frame(height: 36)
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").foregroundStyle(theme.muted)
                    TextField("Search meetings", text: $search).textFieldStyle(.plain)
                        .accessibilityLabel("Search meetings")
                }
                .padding(.horizontal, 8).frame(height: 28)
                .background(theme.base, in: RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(theme.border))
                .padding(.horizontal, 12).padding(.vertical, 8)
                HStack {
                    Text("Meetings")
                    Spacer()
                    Text("\(filteredMeetings.count)").monospacedDigit()
                }
                .foregroundStyle(theme.muted)
                .padding(.horizontal, 20).padding(.top, 8).padding(.bottom, 4)
                List(selection: $workspace.selectedID) {
                    ForEach(filteredMeetings) { meeting in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 6) {
                                Text(workspace.draft(for: meeting).title).lineLimit(1)
                                if workspace.drafts[meeting.id]?.isDirty == true {
                                    Image(systemName: "circle.fill").font(.system(size: 5))
                                        .accessibilityLabel("Unsaved changes")
                                }
                            }
                            Text(meeting.createdAt.isEmpty ? "Recovered draft" : dateLabel(meeting.createdAt))
                                .font(.system(size: 13, design: .monospaced)).foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 4).tag(meeting.id)
                    }
                }
                .listStyle(.sidebar).scrollContentBackground(.hidden)
                if filteredMeetings.isEmpty {
                    Text(search.isEmpty ? "No meetings yet." : "No matching meetings.")
                        .foregroundStyle(theme.muted)
                        .padding(.horizontal, 20).padding(.bottom, 16)
                }
                Rectangle().fill(theme.border).frame(height: 1)
                serviceStatus
            }
            .background(theme.deep)
            .navigationSplitViewColumnWidth(min: 252, ideal: MossTheme.sidebarWidth, max: 320)
        } detail: {
            VStack(spacing: 0) {
                if let message = workspace.draftPersistenceError {
                    HStack(alignment: .top, spacing: 12) {
                        Label(message, systemImage: "externaldrive.badge.exclamationmark")
                            .textSelection(.enabled)
                        Spacer()
                        Button("Retry draft recovery") { workspace.retryDraftPersistence() }
                    }
                    .padding(12).foregroundStyle(theme.danger).background(theme.dangerBackground)
                }
                if let message = workspace.errorMessage {
                    HStack(alignment: .top, spacing: 12) {
                        Label(message, systemImage: "exclamationmark.triangle").textSelection(.enabled)
                        Spacer()
                        Button("Dismiss") { workspace.errorMessage = nil }
                    }
                    .padding(12).background(theme.raised)
                }
                if recording.hasWork || recording.errorMessage != nil { recordingStatus }
                if let meeting = workspace.selectedMeeting {
                    meetingDetail(meeting)
                } else {
                    if let file = workspace.chosenAudioFile {
                        AudioImportControls(workspace: workspace, meetingID: file.meetingID, recordingHasWork: recording.hasWork)
                            .padding(16)
                    }
                    VStack(spacing: 12) {
                        Text("No meeting selected")
                            .font(.system(size: MossTheme.headingSize, weight: .medium))
                        Text("Create a meeting to take notes, record your microphone, or import a transcript.")
                            .foregroundStyle(theme.muted).multilineTextAlignment(.center)
                            .frame(maxWidth: 360)
                        Button("New meeting") { Task { await workspace.createMeeting() } }
                            .disabled(workspace.isWorking || recording.hasWork)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity).padding(24)
                }
            }
            .background(theme.base)
        }
        .navigationSplitViewStyle(.balanced)
        .font(.system(size: MossTheme.controlSize))
        .foregroundStyle(theme.text)
        .buttonStyle(.bordered)
        .controlSize(.small)
        .tint(theme.accent)
        .toolbarBackground(theme.deep, for: .windowToolbar)
        .toolbarBackground(.visible, for: .windowToolbar)
        .toolbar {
            Button { Task { await workspace.refresh() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
        }
        .task {
            await workspace.refresh()
            await workspace.refreshOpenCodeCatalog()
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(3)) } catch { return }
                await workspace.refreshHealth()
            }
        }
        .onDisappear { recording.stop() }
        .sheet(isPresented: Binding(get: { importingID != nil }, set: { if !$0 { importingID = nil } })) {
            importSheet
        }
        .alert("Delete this meeting?", isPresented: Binding(get: { deletingID != nil }, set: { if !$0 { deletingID = nil } })) {
            Button("Cancel", role: .cancel) { deletingID = nil }
            Button("Delete meeting", role: .destructive) {
                if let id = deletingID { Task { await workspace.deleteMeeting(id) } }
                deletingID = nil
            }
        } message: { Text("This removes the meeting and any local unsaved notes. This cannot be undone.") }
        .alert("Record microphone audio?", isPresented: Binding(get: { confirmRecordingID != nil }, set: { if !$0 { confirmRecordingID = nil } })) {
            Button("Cancel", role: .cancel) { confirmRecordingID = nil }
            Button("I have consent. Record") {
                if let id = confirmRecordingID, let meeting = workspace.meetings.first(where: { $0.id == id }) {
                    Task { await recording.start(meeting) }
                }
                confirmRecordingID = nil
            }
        } message: {
            Text("Get consent from every participant first. Moss records only your microphone, not system audio or other call participants directly. PCM audio is sent to the local service for Hex transcription. Failed uploads stay in memory until retried or explicitly discarded.")
        }
        .alert("Generate an AI summary?", isPresented: Binding(get: { confirmAIID != nil }, set: { if !$0 { confirmAIID = nil } })) {
            Button("Cancel", role: .cancel) { confirmAIID = nil }
            Button("Generate AI summary") {
                if let id = confirmAIID { Task { await workspace.summarize(id, kind: .ai) } }
                confirmAIID = nil
            }
        } message: {
            Text(workspace.health?.ai.remote == true
                 ? "This sends the meeting notes and transcript to the service's configured remote AI provider. Continue only if participants permit this."
                 : "This sends meeting notes and transcript to the service's configured AI endpoint. Extracted highlights do not use AI.")
        }
        .alert("Discard pending audio?", isPresented: $confirmDiscardAudio) {
            Button("Keep audio", role: .cancel) { }
            Button("Discard audio", role: .destructive) { recording.discardPending() }
        } message: { Text("Unsaved audio will be permanently lost. Save the pending WAV files first if you want to keep them.") }
        .alert("Replace conflicting fields?", isPresented: Binding(get: { replacingConflictID != nil }, set: { if !$0 { replacingConflictID = nil } })) {
            Button("Keep my draft", role: .cancel) { replacingConflictID = nil }
            Button("Replace conflicting fields", role: .destructive) {
                if let id = replacingConflictID {
                    Task { await workspace.replaceConflictingFieldsAfterConfirmation(id) }
                }
                replacingConflictID = nil
            }
        } message: {
            Text("Another client changed a field you edited, or an interrupted save needs review. Moss will read the latest meeting and replace only fields changed in your draft. Your local values win for those fields; unedited fields stay untouched. A further concurrent edit will stop the save again.")
        }
    }

    private var serviceStatus: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(workspace.health?.hex.state == .ready ? "Local engine ready" : "Local engine",
                  systemImage: workspace.health?.hex.state == .ready ? "checkmark.circle" : "waveform")
                .font(.system(size: 13, weight: .medium))
            Text(workspace.connectionError ?? workspace.health?.hex.message ?? "Connecting to the local service…")
                .foregroundStyle(theme.muted).textSelection(.enabled)
            if let health = workspace.health {
                Text(health.hex.model).font(.system(size: 13, design: .monospaced))
                    .foregroundStyle(theme.muted).textSelection(.enabled)
                if health.hex.state != .ready {
                    Button(workspace.isPreparing || health.hex.state == .preparing ? "Preparing model…" : "Prepare Hex model") {
                        Task { await workspace.prepareEngine() }
                    }
                    .disabled(workspace.isPreparing || health.hex.state == .preparing)
                }
            }
            Text("Microphone only · Local transcription").foregroundStyle(theme.muted)
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
    }

    private func meetingDetail(_ meeting: Meeting) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 16) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(meeting.createdAt.isEmpty ? "Recovered draft" : dateLabel(meeting.createdAt))
                        .font(.system(size: 13, design: .monospaced)).foregroundStyle(theme.muted)
                    TextField("Meeting title", text: Binding(
                        get: { workspace.draft(for: meeting).title },
                        set: { workspace.edit(meeting, title: $0) }))
                        .font(.system(size: MossTheme.headingSize, weight: .medium)).textFieldStyle(.plain)
                        .accessibilityLabel("Meeting title")
                        .disabled(workspace.deletingID == meeting.id)
                }
                Spacer()
                if recording.isRecording {
                    Button("Stop recording", systemImage: "stop.fill") { recording.stop() }
                        .tint(theme.danger)
                } else {
                    Button("Record", systemImage: "mic") { confirmRecordingID = meeting.id }
                        .disabled(recording.hasWork || workspace.blocksCapture || workspace.health?.hex.state != .ready)
                }
                Menu {
                    Button("Import transcript…") { importingID = meeting.id }.disabled(recording.hasWork)
                    Menu("Export…") {
                        ForEach(ExportFormat.allCases, id: \.self) { format in
                            Button("Export \(format.label)…") { export(meeting, format: format) }
                        }
                    }
                    Divider()
                    Button("Delete meeting…", role: .destructive) { deletingID = meeting.id }
                        .disabled(recording.hasWork || workspace.savingIDs.contains(meeting.id))
                } label: { Image(systemName: "ellipsis") }
                .menuStyle(.borderlessButton).frame(width: 28, height: 28)
                .accessibilityLabel("Meeting actions").disabled(workspace.isWorking)
            }
            .padding(.horizontal, 20).padding(.vertical, 16)
            Rectangle().fill(theme.border).frame(height: 1)

            HSplitView {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Label("My notes", systemImage: "square.and.pencil")
                            .font(.system(size: 14, weight: .medium))
                        Spacer()
                        saveStatus(meeting)
                    }
                    TextEditor(text: Binding(
                        get: { workspace.draft(for: meeting).notes },
                        set: { workspace.edit(meeting, notes: $0) }))
                        .font(.system(size: MossTheme.bodySize)).scrollContentBackground(.hidden)
                        .padding(8).background(theme.base, in: RoundedRectangle(cornerRadius: 6))
                        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(theme.border))
                        .accessibilityLabel("Meeting notes")
                        .disabled(workspace.deletingID == meeting.id)
                    if let error = workspace.saveErrors[meeting.id] {
                        Text("Not saved. \(error) Your draft is kept when switching meetings.\(workspace.draftPersistenceError == nil ? " A local recovery copy is on disk." : "")")
                            .foregroundStyle(theme.danger).textSelection(.enabled)
                    }
                    if workspace.conflictedIDs.contains(meeting.id) {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Save paused. Your draft conflicts with another client or an interrupted save. Refresh does not replace your edited fields.")
                                .foregroundStyle(theme.muted).textSelection(.enabled)
                            Button("Replace conflicting fields…") { replacingConflictID = meeting.id }
                                .disabled(workspace.savingIDs.contains(meeting.id))
                        }
                    }
                }
                .padding(16).frame(minWidth: 300)

                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        HStack {
                            Label("Highlights", systemImage: "text.quote")
                                .font(.system(size: 14, weight: .medium))
                            Spacer()
                            Menu("Generate") {
                                Button("Extracted highlights (no AI)") {
                                    Task { await workspace.summarize(meeting.id, kind: .extractive) }
                                }
                                Button("AI summary…") { confirmAIID = meeting.id }
                                    .disabled(workspace.health?.ai.configured != true)
                            }
                            .disabled(workspace.isWorking || recording.hasWork)
                        }
                        OpenCodeSummaryControls(workspace: workspace, meetingID: meeting.id, recordingHasWork: recording.hasWork)
                        if let summary = meeting.summary {
                            Label(summary.kind == .ai ? "AI summary" : "Extracted excerpts · Not AI",
                                  systemImage: summary.kind == .ai ? "sparkles" : "text.quote")
                                .font(.system(size: 13)).foregroundStyle(theme.muted)
                            if let source = summary.opencode {
                                Text("OpenCode · Agent \(source.agentID) · \(source.model.providerID)/\(source.model.id)\(source.model.variant.map { " · Variant \($0)" } ?? "")")
                                    .font(.system(size: 13)).foregroundStyle(theme.muted).textSelection(.enabled)
                            }
                            if meeting.summaryIsStale {
                                Label("Out of date. Regenerate after the latest edits.", systemImage: "clock.arrow.circlepath")
                                    .font(.system(size: 13)).foregroundStyle(theme.muted)
                            }
                            Text(markdown(summary.markdown)).textSelection(.enabled).lineSpacing(4)
                        } else {
                            Text("Pull out useful excerpts, or opt in to a configured AI or OpenCode summary.")
                                .foregroundStyle(theme.muted)
                        }
                        Rectangle().fill(theme.border).frame(height: 1)
                        HStack {
                            Label("Transcript", systemImage: "text.alignleft")
                                .font(.system(size: 14, weight: .medium))
                            Spacer()
                            Button("Import…") { importingID = meeting.id }.disabled(workspace.isWorking || recording.hasWork)
                        }
                        AudioImportControls(workspace: workspace, meetingID: meeting.id, recordingHasWork: recording.hasWork)
                        if meeting.segments.isEmpty {
                            Text("No transcript yet. Record your microphone or import an existing transcript.")
                                .foregroundStyle(theme.muted)
                        }
                        ForEach(meeting.segments) { segment in
                            HStack(alignment: .top, spacing: 12) {
                                Text(segment.timestamp).font(.system(size: 13, design: .monospaced))
                                    .foregroundStyle(theme.muted)
                                    .frame(width: 48, alignment: .leading)
                                Text(segment.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }
                    .font(.system(size: MossTheme.bodySize)).padding(16)
                }
                .frame(minWidth: 300)
            }
        }
    }

    private func saveStatus(_ meeting: Meeting) -> some View {
        HStack(spacing: 8) {
            Text(workspace.savingIDs.contains(meeting.id) ? "Saving…"
                 : workspace.conflictedIDs.contains(meeting.id) ? "Conflict · Draft kept"
                 : workspace.saveErrors[meeting.id] != nil ? "Save failed"
                 : workspace.drafts[meeting.id]?.isDirty == true ? "Unsaved" : "Saved")
                .foregroundStyle(theme.muted)
            Button(workspace.saveErrors[meeting.id] != nil ? "Retry save" : "Save") {
                Task { await workspace.save(meeting.id) }
            }
            .disabled(workspace.savingIDs.contains(meeting.id) || workspace.deletingID == meeting.id || workspace.conflictedIDs.contains(meeting.id) || workspace.drafts[meeting.id]?.isDirty != true)
        }
    }

    private var recordingStatus: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label(recording.isRecording ? "Recording microphone · \(recording.elapsedSeconds / 60):\(String(format: "%02d", recording.elapsedSeconds % 60))"
                      : recording.isStarting ? "Requesting microphone access…"
                      : recording.isUploading ? "Transcribing local audio…" : "Microphone stopped",
                      systemImage: recording.isRecording ? "record.circle" : "waveform")
                    .monospacedDigit()
                Spacer()
                if recording.isStarting {
                    Button("Cancel permission request") { recording.stop() }
                }
                if recording.isRecording {
                    Button("Stop", systemImage: "stop.fill") { recording.stop() }
                        .accessibilityLabel("Stop microphone recording")
                }
                Text(recording.meetingTitle).lineLimit(1)
                if let id = recording.meetingID, id != workspace.selectedID {
                    Button("Show meeting") { workspace.selectedID = id }
                }
            }
            if let error = recording.errorMessage { Text(error).foregroundStyle(theme.danger).textSelection(.enabled) }
            if !recording.pending.isEmpty {
                HStack {
                    Text("\(recording.pending.count) pending WAV chunk(s) · Kept in memory, not on disk")
                        .foregroundStyle(theme.muted)
                    Spacer()
                    Button("Retry upload") { recording.retry() }
                        .disabled(recording.isRecording || recording.isUploading)
                    Button("Save WAV files…") { savePendingAudio() }.disabled(recording.isRecording)
                    Button("Discard…", role: .destructive) { confirmDiscardAudio = true }
                        .disabled(recording.isRecording || recording.isUploading)
                }
            }
        }
        .padding(12).background(theme.raised)
        .overlay(alignment: .bottom) { Rectangle().fill(theme.border).frame(height: 1) }
    }

    private var importSheet: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Import a transcript").font(.system(size: MossTheme.headingSize, weight: .medium))
            Text("Paste text from a conversation you have permission to use. It will be appended to this meeting.")
                .foregroundStyle(theme.muted)
            TextEditor(text: $importText).font(.system(size: MossTheme.bodySize))
                .scrollContentBackground(.hidden).padding(8)
                .background(theme.base, in: RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(theme.border))
                .accessibilityLabel("Transcript to import")
            HStack {
                Button("Cancel") { importingID = nil }
                Spacer()
                Button(workspace.isWorking ? "Importing…" : "Import transcript") {
                    guard let id = importingID else { return }
                    Task {
                        if await workspace.importTranscript(id, text: importText) {
                            importText = ""
                            importingID = nil
                        }
                    }
                }
                .disabled(importText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || workspace.isWorking || recording.hasWork)
            }
            if let error = workspace.errorMessage { Text(error).foregroundStyle(theme.danger).textSelection(.enabled) }
        }
        .font(.system(size: MossTheme.controlSize)).foregroundStyle(theme.text)
        .buttonStyle(.bordered).controlSize(.small).tint(theme.accent)
        .padding(24).frame(width: 600, height: 440)
        .background(theme.raised)
        .interactiveDismissDisabled(workspace.isWorking)
    }

    private func export(_ meeting: Meeting, format: ExportFormat = .markdown) {
        Task {
            do {
                let data = try await workspace.export(meeting.id, format: format)
                let panel = NSSavePanel()
                panel.allowedContentTypes = [UTType(filenameExtension: format.fileExtension) ?? .plainText]
                panel.nameFieldStringValue = "Meeting.\(format.fileExtension)"
                if panel.runModal() == .OK, let url = panel.url {
                    try data.write(to: url, options: .withoutOverwriting)
                }
            } catch { workspace.errorMessage = "Export was not written. Choose a new filename if it already exists. \(error.localizedDescription)" }
        }
    }

    private func savePendingAudio() {
        let chunks = recording.pending
        guard !chunks.isEmpty else { return }
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        panel.prompt = "Save WAV files here"
        guard panel.runModal() == .OK, let directory = panel.url else { return }
        do {
            for chunk in chunks {
                let url = directory.appendingPathComponent("moss-\(chunk.startMs)-\(chunk.id.uuidString).wav")
                try chunk.wav.write(to: url, options: .withoutOverwriting)
            }
        } catch { workspace.errorMessage = "Could not save every WAV file. Pending audio is still kept. \(error.localizedDescription)" }
    }

    private func dateLabel(_ text: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = formatter.date(from: text) ?? ISO8601DateFormatter().date(from: text)
        return date?.formatted(date: .abbreviated, time: .shortened) ?? text
    }

    private func markdown(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(text)
    }
}
