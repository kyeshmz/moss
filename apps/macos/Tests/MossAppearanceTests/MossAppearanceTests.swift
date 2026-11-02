import AppKit
import MossKit
import SwiftUI
import Testing
@testable import Moss

@Suite @MainActor
struct MossAppearanceTests {
    @Test func lightPaletteUsesOC2V2Tokens() throws {
        let theme = MossTheme(colorScheme: .light)
        try expectColor(theme.base, 0xFFFFFF)
        try expectColor(theme.deep, 0xFAFAFA)
        try expectColor(theme.raised, 0xFAFAFA)
        try expectColor(theme.text, 0x161616)
        try expectColor(theme.muted, 0x5C5C5C)
        try expectColor(theme.accent, 0x3B5CF6)
        try expectColor(theme.danger, 0xB82D35)
        try expectColor(theme.dangerBackground, 0xFCECEB)
        try expectColor(theme.border, 0x000000, alpha: 0.10)
    }

    @Test func darkPaletteUsesOC2V2Tokens() throws {
        let theme = MossTheme(colorScheme: .dark)
        try expectColor(theme.base, 0x161616)
        try expectColor(theme.deep, 0x080808)
        try expectColor(theme.raised, 0x242424)
        try expectColor(theme.text, 0xFAFAFA)
        try expectColor(theme.muted, 0xAEAEAE)
        try expectColor(theme.accent, 0xA2BCFF)
        try expectColor(theme.danger, 0xF17471)
        try expectColor(theme.dangerBackground, 0x461516)
        try expectColor(theme.border, 0xFFFFFF, alpha: 0.10)
    }

    @Test func workspaceMetricsUseCompactDesktopScale() {
        #expect(MossTheme.sidebarWidth == 276)
        #expect(MossTheme.headingSize == 20)
        #expect(MossTheme.bodySize == 14)
        #expect(MossTheme.controlSize == 13)
    }

    @Test func opencodeConsentSnapshotKeepsTheConfirmedSelectionAndDisclosure() {
        var selection = OpenCodeSummaryOptions(agentID: "moss-summary", model: SummaryModel(id: "chosen-model", providerID: "chosen-provider", variant: "high"))
        let snapshot = OpenCodeSummaryConfirmation(meetingID: "chosen-meeting", options: selection)
        selection = OpenCodeSummaryOptions(agentID: "different-agent", model: SummaryModel(id: "different-model", providerID: "different-provider"))
        #expect(snapshot.meetingID == "chosen-meeting")
        #expect(snapshot.options.agentID == "moss-summary")
        #expect(snapshot.options.model.variant == "high")
        #expect(snapshot.options != selection)
        #expect(snapshot.message.contains("chosen-provider/chosen-model"))
        #expect(snapshot.message.contains("remain in OpenCode session history"))
        #expect(snapshot.message.contains("may be sent to the model's provider (chosen-provider)"))
    }

    private func expectColor(_ color: Color, _ hex: UInt32, alpha: CGFloat = 1) throws {
        let resolved = try #require(NSColor(color).usingColorSpace(.sRGB))
        #expect(abs(resolved.redComponent - CGFloat((hex >> 16) & 0xFF) / 255) < 0.000_001)
        #expect(abs(resolved.greenComponent - CGFloat((hex >> 8) & 0xFF) / 255) < 0.000_001)
        #expect(abs(resolved.blueComponent - CGFloat(hex & 0xFF) / 255) < 0.000_001)
        #expect(abs(resolved.alphaComponent - alpha) < 0.000_001)
    }
}
