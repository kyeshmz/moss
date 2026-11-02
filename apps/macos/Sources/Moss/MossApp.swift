import AppKit
import MossKit
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    var workspace: Workspace?
    var recording: RecordingSession?

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard workspace?.hasUnsavedChanges == true || recording?.hasWork == true || workspace?.isWorking == true || workspace?.chosenAudioFile != nil else { return .terminateNow }
        let alert = NSAlert()
        alert.messageText = "Quit with unsaved work?"
        alert.informativeText = workspace?.draftPersistenceError == nil
            ? "Unsaved title and notes have a local recovery copy. Pending microphone audio is only in memory and will be lost. Selected import files remain unchanged on disk, but their selection and active job status are not restored. Agent or Drive submissions may already exist in OpenCode. Cancel to save notes, finish jobs, retry uploads, or save pending WAV files."
            : "Draft recovery has failed. Unsaved title, notes, and pending microphone audio may be lost. Selected import files remain unchanged on disk. Active job status is not restored. Cancel to save notes, repair draft recovery, finish jobs, retry uploads, or save pending WAV files."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: "Quit anyway")
        guard alert.runModal() == .alertSecondButtonReturn else { return .terminateCancel }
        recording?.stop()
        workspace?.cancelAudioImport()
        return .terminateNow
    }
}

@main
struct MossApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var workspace: Workspace
    @State private var recording: RecordingSession

    init() {
        let workspace = Workspace()
        _workspace = State(initialValue: workspace)
        _recording = State(initialValue: RecordingSession(workspace: workspace))
    }

    var body: some Scene {
        Window("Moss", id: "workspace") {
            WorkspaceView(workspace: workspace, recording: recording)
                .frame(minWidth: 960, minHeight: 660)
                .onAppear {
                    appDelegate.workspace = workspace
                    appDelegate.recording = recording
                }
        }
        .defaultSize(width: 1_180, height: 800)
        .windowToolbarStyle(.unifiedCompact)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("New Meeting") { Task { await workspace.createMeeting() } }
                    .keyboardShortcut("n")
                    .disabled(workspace.isWorking || recording.hasWork)
            }
            CommandGroup(after: .saveItem) {
                Button("Save Notes") {
                    if let id = workspace.selectedID { Task { await workspace.save(id) } }
                }
                .keyboardShortcut("s")
            }
        }
    }
}
