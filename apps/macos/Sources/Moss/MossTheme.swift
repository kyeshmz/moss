import SwiftUI

struct MossTheme {
    let colorScheme: ColorScheme

    static let sidebarWidth: CGFloat = 276
    static let headingSize: CGFloat = 20
    static let bodySize: CGFloat = 14
    static let controlSize: CGFloat = 13

    var base: Color { color(light: 0xFFFFFF, dark: 0x161616) }
    var deep: Color { color(light: 0xFAFAFA, dark: 0x080808) }
    var raised: Color { color(light: 0xFAFAFA, dark: 0x242424) }
    var text: Color { color(light: 0x161616, dark: 0xFAFAFA) }
    var muted: Color { color(light: 0x5C5C5C, dark: 0xAEAEAE) }
    var border: Color { (colorScheme == .dark ? Color.white : Color.black).opacity(0.10) }
    var accent: Color { color(light: 0x3B5CF6, dark: 0xA2BCFF) }
    var danger: Color { color(light: 0xB82D35, dark: 0xF17471) }
    var dangerBackground: Color { color(light: 0xFCECEB, dark: 0x461516) }

    private func color(light: UInt32, dark: UInt32) -> Color {
        let hex = colorScheme == .dark ? dark : light
        return Color(.sRGB, red: Double((hex >> 16) & 0xFF) / 255,
                     green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255, opacity: 1)
    }
}
