import Foundation

public struct MeetingDraft: Codable, Equatable, Sendable {
    public var title: String
    public var notes: String
    private var savedTitle: String
    private var savedNotes: String

    public init(meeting: Meeting) {
        title = meeting.title
        notes = meeting.notes
        savedTitle = meeting.title
        savedNotes = meeting.notes
    }

    public var isDirty: Bool { title != savedTitle || notes != savedNotes }
    public var patch: MeetingPatch {
        MeetingPatch(title: title != savedTitle ? title : nil, notes: notes != savedNotes ? notes : nil,
                     expected: .init(title: title != savedTitle ? savedTitle : nil,
                                     notes: notes != savedNotes ? savedNotes : nil))
    }

    public mutating func rebase(on meeting: Meeting) {
        if title == savedTitle { title = meeting.title; savedTitle = meeting.title }
        if notes == savedNotes { notes = meeting.notes; savedNotes = meeting.notes }
    }

    mutating func replaceConflictingBases(on meeting: Meeting) {
        rebase(on: meeting)
        savedTitle = meeting.title
        savedNotes = meeting.notes
    }

    public mutating func acknowledge(_ snapshot: MeetingDraft, returned meeting: Meeting) {
        if snapshot.title != snapshot.savedTitle {
            if title == snapshot.title { title = meeting.title }
            savedTitle = meeting.title
        }
        if snapshot.notes != snapshot.savedNotes {
            if notes == snapshot.notes { notes = meeting.notes }
            savedNotes = meeting.notes
        }
        rebase(on: meeting)
    }

    func recoveringUncertainSave(_ snapshot: MeetingDraft) -> MeetingDraft {
        var recovered = self
        // A reverted edit must survive a crash even if the in-flight request committed.
        if title == savedTitle, snapshot.title != snapshot.savedTitle { recovered.savedTitle = snapshot.title }
        if notes == savedNotes, snapshot.notes != snapshot.savedNotes { recovered.savedNotes = snapshot.notes }
        return recovered
    }

    var isValidForPersistence: Bool {
        title.utf8.count <= 4_096 && savedTitle.utf8.count <= 4_096
            && notes.utf8.count <= 1_048_576 && savedNotes.utf8.count <= 1_048_576
    }

    func recoveredMeeting(id: String) -> Meeting {
        Meeting(id: id, title: savedTitle, createdAt: "", updatedAt: "", notes: savedNotes,
                revision: 0, segments: [], summary: nil)
    }
}
