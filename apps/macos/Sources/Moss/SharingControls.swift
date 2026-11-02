import AppKit
import MossKit
import SwiftUI
import UniformTypeIdentifiers

struct SourcePicker: View {
    let label: String
    @Binding var source: ContentSource
    var body: some View {
        Picker(label, selection: $source) {
            ForEach(ContentSource.allCases, id: \.self) { Text($0.label).tag($0) }
        }
    }
}

struct AgentWorkControls: View {
    @Bindable var workspace: Workspace
    let meetingID: String
    let recordingHasWork: Bool
    @State private var source: ContentSource = .meeting
    @State private var instruction = ""
    @State private var confirmation: AgentWorkConfirmation?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Ask agent").font(.system(size: 14, weight: .medium))
            Text("Uses the OpenCode agent and model selected above. Results are kept separately; notes, transcript, and summary are not replaced.")
                .foregroundStyle(.secondary)
            SourcePicker(label: "Agent source", source: $source)
            TextField("Custom instruction", text: $instruction, axis: .vertical)
                .textFieldStyle(.roundedBorder).lineLimit(2...6).accessibilityLabel("Agent instruction")
            Button("Review agent request…") {
                Task { confirmation = await workspace.prepareAgentWork(meetingID, source: source, instruction: instruction) }
            }
            .disabled(workspace.isWorking || recordingHasWork || workspace.isLoadingOpenCodeCatalog || workspace.opencodeSelection == nil || instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            if let meeting = workspace.meetings.first(where: { $0.id == meetingID }), let history = meeting.agentWork, !history.isEmpty {
                Text("Agent results · \(history.count) · Up to 50 per meeting").fontWeight(.medium)
                ForEach(history.reversed()) { result in
                    DisclosureGroup("\(result.source.label) · \(result.agentID) · Revision \(result.sourceRevision)") {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("\(result.createdAt) · \(result.model.providerID)/\(result.model.id)\(result.model.variant.map { " · \($0)" } ?? "")")
                                .foregroundStyle(.secondary).textSelection(.enabled)
                            Text(result.instruction).fontWeight(.medium).textSelection(.enabled)
                            Text(result.markdown).textSelection(.enabled)
                            Button("Download result Markdown…") { download(result) }
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(.top, 8)
                    }
                }
            }
        }
        .font(.system(size: 13))
        .sheet(item: $confirmation) { snapshot in
            ContentConfirmationSheet(title: "Ask the selected agent?", disclosure: snapshot.disclosure,
                                     details: "Source: \(snapshot.options.source.label)\nInstruction: \(snapshot.options.instruction)\nRequest: \(snapshot.options.requestID)",
                                     content: snapshot.snapshot.content, workspace: workspace,
                                     action: "I agree. Send request", retry: "Retry same confirmed request",
                                     cancel: { confirmation = nil }) {
                if await workspace.runAgentWork(snapshot) { confirmation = nil }
            }
        }
    }

    private func download(_ result: AgentWork) {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [UTType(filenameExtension: "md") ?? .plainText]
        panel.nameFieldStringValue = "Agent-\(result.id).md"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do { try result.writeMarkdown(to: url) }
        catch { workspace.errorMessage = "The result was not written. Choose a new filename; existing files are never overwritten. \(error.localizedDescription)" }
    }
}

struct ContentConfirmationSheet: View {
    let title: String
    let disclosure: String
    let details: String
    let content: String
    @Bindable var workspace: Workspace
    let action: String
    let retry: String
    let cancel: () -> Void
    let submit: () async -> Void
    @State private var attempted = false
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let theme = MossTheme(colorScheme: colorScheme)
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.system(size: MossTheme.headingSize, weight: .medium))
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text(disclosure)
                    Text(details).font(.system(size: 13, design: .monospaced))
                    Divider()
                    Text("Selected saved content").fontWeight(.medium)
                    Text(content.isEmpty ? "(The selected source is empty.)" : content)
                }.frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
            }
            if let error = workspace.errorMessage { Text(error).foregroundStyle(theme.danger).textSelection(.enabled) }
            HStack {
                Button("Cancel", action: cancel).disabled(workspace.isWorking)
                Spacer()
                if workspace.isWorking { ProgressView().controlSize(.small) }
                Button(workspace.isWorking ? "Submitting…" : attempted ? retry : action) {
                    attempted = true
                    workspace.errorMessage = nil
                    Task { await submit() }
                }.disabled(workspace.isWorking || workspace.hasRecordingWork)
            }
        }
        .padding(24).frame(width: 660, height: 580)
        .font(.system(size: 13)).foregroundStyle(theme.text).background(theme.raised)
        .interactiveDismissDisabled(workspace.isWorking)
    }
}

struct DriveControls: View {
    @Bindable var workspace: Workspace
    let meetingID: String
    let recordingHasWork: Bool
    @State private var server = ""
    @State private var newServer = ""
    @State private var endpoint = ""
    @State private var source: ContentSource = .meeting
    @State private var folderID = ""
    @State private var connectConfirmation: DriveConnectionOptions?
    @State private var exportConfirmation: DriveExportConfirmation?
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Google Drive MCP").font(.system(size: 14, weight: .medium))
                Spacer()
                Button(workspace.isLoadingDriveCatalog ? "Refreshing…" : "Refresh Drive servers") {
                    Task { await workspace.refreshDriveCatalog() }
                }.disabled(workspace.isWorking || workspace.isLoadingDriveCatalog)
            }
            Text("Explicitly identify your Google Drive server. Names are not proof of its capabilities. In OpenCode, open /mcps to authenticate, then refresh here. Moss does not supply an OAuth URL.")
                .foregroundStyle(.secondary).textSelection(.enabled)
            Text("Choose moss-drive or another Drive-capable agent in Agent above. moss-summary, moss-reviewer, and moss-editor are text-only. Existing Drive MCP servers need codemode:false in OpenCode. Only the selected server's native MCP actions can ask for approval; execute and Code Mode are denied.")
                .foregroundStyle(.secondary).textSelection(.enabled)
            if let catalog = workspace.driveCatalog {
                Text(catalog.message).foregroundStyle(.secondary).textSelection(.enabled)
                Picker("Drive server", selection: $server) {
                    Text("Choose a configured server").tag("")
                    ForEach(catalog.servers, id: \.name) { item in
                        Text("\(item.title ?? item.name) · \(item.name) · \(item.status.rawValue)").tag(item.name)
                    }
                }.disabled(workspace.isWorking)
                Button("Connect selected server…") {
                    do { connectConfirmation = try DriveConnectionOptions(server: server) }
                    catch { workspace.errorMessage = error.localizedDescription }
                }.disabled(workspace.isWorking || recordingHasWork || workspace.isLoadingDriveCatalog || !catalog.servers.contains(where: { $0.name == server }))
            }
            DisclosureGroup("Add a supplied HTTPS MCP endpoint…") {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Only add an endpoint you trust. This adds/connects the MCP server for the current OpenCode location with OAuth enabled. Runtime addition is not guaranteed to persist. Permanent setup may be needed in OpenCode after restart. Existing server configuration will not be overwritten.")
                    TextField("New MCP server name", text: $newServer).accessibilityLabel("New Drive server name")
                    TextField("Supplied HTTPS MCP endpoint", text: $endpoint).accessibilityLabel("Drive MCP endpoint")
                    Button("Review server addition…") {
                        do { connectConfirmation = try DriveConnectionOptions(server: newServer, url: endpoint) }
                        catch { workspace.errorMessage = error.localizedDescription }
                    }.disabled(workspace.isWorking || recordingHasWork || newServer.isEmpty || endpoint.isEmpty)
                }.textFieldStyle(.roundedBorder).padding(.top, 8)
            }
            if let error = workspace.driveCatalogError {
                Text("Drive request failed. \(error)").foregroundStyle(MossTheme(colorScheme: colorScheme).danger).textSelection(.enabled)
            }
            SourcePicker(label: "Drive export source", source: $source)
            TextField("Optional destination folder ID", text: $folderID)
                .textFieldStyle(.roundedBorder).accessibilityLabel("Drive folder ID")
            Button("Review Drive export handoff…") {
                let folder = folderID.trimmingCharacters(in: .whitespacesAndNewlines)
                Task { exportConfirmation = await workspace.prepareDriveExport(meetingID, server: server, source: source, folderID: folder.isEmpty ? nil : folder) }
            }
            .disabled(workspace.isWorking || recordingHasWork || workspace.isLoadingDriveCatalog || workspace.isLoadingOpenCodeCatalog || workspace.opencodeSelection == nil || workspace.selectedAgentIsTextOnlyForDrive || workspace.driveCatalog?.servers.contains(where: { $0.name == server && $0.status == .connected }) != true)
            if let handoff = workspace.driveHandoffs[meetingID] {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Submitted to OpenCode · Not confirmed uploaded").fontWeight(.medium)
                    Text("Session ID: \(handoff.sessionID)").font(.system(size: 13, design: .monospaced))
                    Text(handoff.message)
                    Text("Open this session in OpenCode. Approve the selected Drive tools and verify the resulting file. Do not resubmit merely because approval is pending.")
                }.textSelection(.enabled)
            }
        }
        .font(.system(size: 13))
        .alert("Connect Google Drive MCP?", isPresented: Binding(get: { connectConfirmation != nil }, set: { if !$0 { connectConfirmation = nil } }), presenting: connectConfirmation) { options in
            Button("Cancel", role: .cancel) { connectConfirmation = nil }
            Button(options.url == nil ? "I agree. Connect" : "I agree. Add/connect server") {
                Task { await workspace.connectDrive(options) }
                connectConfirmation = nil
            }
        } message: { options in
            Text("Server: \(options.server)\n\(options.url.map { "Endpoint: \($0)\nThis adds/connects the server for the current OpenCode location with OAuth enabled. Runtime addition may need permanent setup in OpenCode after restart. " } ?? "This connects an existing OpenCode MCP server. ")Only continue if you trust this server. Authenticate through OpenCode /mcps, then refresh here. No Drive write is approved by connecting.")
        }
        .sheet(item: $exportConfirmation) { snapshot in
            ContentConfirmationSheet(title: "Submit a Drive export handoff?", disclosure: snapshot.disclosure,
                                     details: "Source: \(snapshot.options.source.label)\nServer: \(snapshot.options.server)\nFolder: \(snapshot.options.folderID ?? "Server default")\nIf submission fails, check OpenCode before retrying; a separate session may already exist.",
                                     content: snapshot.snapshot.content, workspace: workspace,
                                     action: "I agree. Submit handoff", retry: "Resubmit after checking OpenCode",
                                     cancel: { exportConfirmation = nil }) {
                if await workspace.exportDrive(snapshot) { exportConfirmation = nil }
            }
        }
    }
}

struct AudioImportControls: View {
    @Bindable var workspace: Workspace
    let meetingID: String
    let recordingHasWork: Bool
    @State private var pickingFile = false
    @State private var confirmImport = false
    @State private var dropTargeted = false
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let theme = MossTheme(colorScheme: colorScheme)
        VStack(alignment: .leading, spacing: 8) {
            Text("Import audio file").font(.system(size: 14, weight: .medium))
            Text("Drop one local audio file here or choose a file. Choosing does not transcribe. Up to 100 MiB and 2 hours. Common WAV, MP3, M4A, FLAC, OGG and other containers supported by local ffmpeg; corrupt or encrypted media may not work.")
                .foregroundStyle(theme.muted)
            if let status = workspace.health?.audioImport {
                Text(status.message).foregroundStyle(theme.muted).textSelection(.enabled)
            }
            if workspace.health?.hex.state != .ready {
                Text("Prepare the Hex model in the sidebar first. The local engine must be ready before importing audio.")
                    .foregroundStyle(theme.muted)
            }
            Button("Choose audio file…") { pickingFile = true }
                .disabled(workspace.isWorking || recordingHasWork || workspace.chosenAudioFile != nil)
            if let file = workspace.chosenAudioFile {
                Text("Chosen: \(file.filename) · \(ByteCountFormatter.string(fromByteCount: Int64(file.bytes.count), countStyle: .binary))").textSelection(.enabled)
                Text("Target: \(workspace.meetings.first(where: { $0.id == file.meetingID })?.title ?? file.meetingID). The selection is kept in memory until acknowledgement. The original file is never changed.")
                    .foregroundStyle(theme.muted)
                if file.meetingID != meetingID {
                    Button("Show import meeting") { workspace.selectedID = file.meetingID }
                }
                HStack {
                    if workspace.isWorking {
                        ProgressView().controlSize(.small)
                        Text(workspace.isImportingAudioFile ? "Uploading and transcribing…" : "Another action is running…")
                    }
                    Button(workspace.audioImportError == nil ? "Review transcription consent…" : "Retry transcription…") { confirmImport = true }
                        .disabled(workspace.isWorking || recordingHasWork || !workspace.canImportAudioFile)
                    if workspace.isImportingAudioFile {
                        Button("Cancel import") { workspace.cancelAudioImport() }
                    } else {
                        Button("Remove selection") { workspace.removeChosenAudioFile() }.disabled(workspace.isWorking)
                    }
                }
            }
            if let error = workspace.audioImportError { Text(error).foregroundStyle(theme.danger).textSelection(.enabled) }
        }
        .font(.system(size: 13)).padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(dropTargeted ? theme.raised : theme.base, in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(dropTargeted ? theme.accent : theme.border))
        .dropDestination(for: URL.self) { urls, _ in
            guard urls.count == 1, let url = urls.first, !workspace.isWorking, !recordingHasWork, workspace.chosenAudioFile == nil else {
                workspace.errorMessage = "Drop one file at a time after completing current jobs and pending microphone uploads. Existing selections are kept."
                return false
            }
            Task { await workspace.chooseAudioFile(meetingID, url: url) }
            return true
        } isTargeted: { dropTargeted = $0 }
        .fileImporter(isPresented: $pickingFile, allowedContentTypes: [.audio, .movie, .data], allowsMultipleSelection: false) { result in
            switch result {
            case .success(let urls): if let url = urls.first { Task { await workspace.chooseAudioFile(meetingID, url: url) } }
            case .failure(let error): workspace.errorMessage = error.localizedDescription
            }
        }
        .alert("Transcribe this audio file?", isPresented: $confirmImport) {
            Button("Cancel", role: .cancel) { }
            Button("I have consent. Transcribe") { Task { await workspace.importChosenAudioFile(consent: true) } }
        } message: {
            Text("File: \(workspace.chosenAudioFile?.filename ?? "")\nParticipant permission is required. Audio is sent to the local service for ffmpeg conversion and Hex transcription, with a 30-minute deadline. Transcription is appended atomically; notes and summaries are kept. Cancellation and failures retain your chosen file for retry. Identical retry content is deduplicated by the service.")
        }
    }
}
