import MossKit
import SwiftUI

struct OpenCodeSummaryConfirmation: Equatable {
    let meetingID: String
    let options: OpenCodeSummaryOptions

    var message: String {
        let model = options.model
        let variant = model.variant.map { " · Variant \($0)" } ?? ""
        return "Agent \(options.agentID) · Model \(model.providerID)/\(model.id)\(variant)\n\nMeeting notes and transcript remain in OpenCode session history and may be sent to the model's provider (\(model.providerID)). Continue only with participant permission."
    }
}

struct OpenCodeSummaryControls: View {
    @Bindable var workspace: Workspace
    let meetingID: String
    let recordingHasWork: Bool
    @Environment(\.colorScheme) private var colorScheme
    @State private var confirmation: OpenCodeSummaryConfirmation?

    private var theme: MossTheme { MossTheme(colorScheme: colorScheme) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("OpenCode agent").font(.system(size: 13, weight: .medium))
                Spacer()
                Button(workspace.isLoadingOpenCodeCatalog ? "Refreshing…" : "Refresh models", systemImage: "arrow.clockwise") {
                    Task { await workspace.refreshOpenCodeCatalog() }
                }
                .disabled(workspace.isWorking || workspace.isLoadingOpenCodeCatalog)
            }
            if let error = workspace.opencodeCatalogError {
                Text("Could not load OpenCode agents and models. \(error) Use Refresh models to retry.")
                    .foregroundStyle(theme.danger).textSelection(.enabled)
            } else if workspace.isLoadingOpenCodeCatalog {
                Text("Loading server agents and models…").foregroundStyle(theme.muted)
            } else if let catalog = workspace.opencodeCatalog {
                Text(catalog.message).foregroundStyle(theme.muted).textSelection(.enabled)
                if let selection = workspace.opencodeSelection {
                    Picker("Agent", selection: Binding(get: { selection.agentID }, set: { workspace.selectOpenCodeAgent($0) })) {
                        ForEach(catalog.agents) { agent in
                            Text("\(agent.name) · \(agent.id)").tag(agent.id)
                        }
                    }
                    if let description = catalog.agents.first(where: { $0.id == selection.agentID })?.description {
                        Text(description).foregroundStyle(theme.muted).textSelection(.enabled)
                    }
                    Picker("Model", selection: Binding(
                        get: { SummaryModel(id: selection.model.id, providerID: selection.model.providerID) },
                        set: { workspace.selectOpenCodeModel($0) })) {
                        ForEach(catalog.models, id: \.summaryModel) { model in
                            Text("\(model.name) · \(model.providerID)/\(model.id)").tag(model.summaryModel)
                        }
                    }
                    if let model = catalog.models.first(where: { $0.id == selection.model.id && $0.providerID == selection.model.providerID }) {
                        Picker("Variant", selection: Binding(get: { selection.model.variant }, set: { workspace.selectOpenCodeVariant($0) })) {
                            Text("Server default").tag(String?.none)
                            ForEach(model.variants, id: \.self) { variant in
                                Text(variant).tag(Optional(variant))
                            }
                        }
                    }
                    Button(workspace.isWorking ? "Working…" : "Summarize with OpenCode…") {
                        confirmation = OpenCodeSummaryConfirmation(meetingID: meetingID, options: selection)
                    }
                    .disabled(recordingHasWork)
                } else if catalog.available {
                    Text("No selectable agents or chat models were returned. Configure them in OpenCode, then refresh.")
                        .foregroundStyle(theme.muted).textSelection(.enabled)
                }
            } else {
                Text("Refresh to discover agents and models from the OpenCode server.").foregroundStyle(theme.muted)
            }
            Divider()
            AgentWorkControls(workspace: workspace, meetingID: meetingID, recordingHasWork: recordingHasWork)
            Divider()
            DriveControls(workspace: workspace, meetingID: meetingID, recordingHasWork: recordingHasWork)
        }
        .font(.system(size: 13))
        .disabled(workspace.isWorking || workspace.isLoadingOpenCodeCatalog)
        .alert("Summarize with OpenCode?", isPresented: Binding(get: { confirmation != nil }, set: { if !$0 { confirmation = nil } }), presenting: confirmation) { snapshot in
            Button("Cancel", role: .cancel) { confirmation = nil }
            Button("I agree. Generate summary") {
                Task { await workspace.summarize(snapshot.meetingID, kind: .opencode, options: snapshot.options) }
                confirmation = nil
            }
        } message: { snapshot in
            Text(snapshot.message)
        }
    }
}
