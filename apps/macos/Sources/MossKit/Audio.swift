import Foundation

public struct AudioChunk: Equatable, Sendable, Identifiable {
    public let id: UUID
    public let startMs: Int
    public let pcm: Data
    public var wav: Data { WAV.encode(pcm: pcm) }

    public init(id: UUID = UUID(), startMs: Int, pcm: Data) {
        self.id = id
        self.startMs = startMs
        self.pcm = pcm
    }
}

public enum WAV {
    public static let sampleRate = 16_000

    public static func encode(pcm: Data) -> Data {
        var data = Data()
        func text(_ value: String) { data.append(contentsOf: value.utf8) }
        func number<T: FixedWidthInteger>(_ value: T) {
            var little = value.littleEndian
            withUnsafeBytes(of: &little) { data.append(contentsOf: $0) }
        }
        text("RIFF"); number(UInt32(36 + pcm.count)); text("WAVEfmt ")
        number(UInt32(16)); number(UInt16(1)); number(UInt16(1))
        number(UInt32(sampleRate)); number(UInt32(sampleRate * 2))
        number(UInt16(2)); number(UInt16(16)); text("data"); number(UInt32(pcm.count))
        data.append(pcm)
        return data
    }
}

// The audio tap and the main actor share this bounded ledger. Every access holds the lock.
public final class PendingAudio: @unchecked Sendable {
    public static let chunkBytes = WAV.sampleRate * 2 * 20
    public static let maximumChunks = 6
    private let lock = NSLock()
    private var chunks: [AudioChunk] = []
    private var tail = Data()
    private var nextStartMs: Int
    private var accepting = true

    public init(startMs: Int = 0) { nextStartMs = startMs }

    public var pending: [AudioChunk] { lock.withLock { chunks } }
    public var isAccepting: Bool { lock.withLock { accepting } }

    @discardableResult public func append(_ pcm: Data) -> Bool {
        lock.withLock {
            guard accepting else { return false }
            var offset = 0
            while offset < pcm.count {
                let count = min(Self.chunkBytes - tail.count, pcm.count - offset)
                tail.append(pcm.subdata(in: offset..<(offset + count)))
                offset += count
                if tail.count == Self.chunkBytes {
                    sealTail()
                    if chunks.count == Self.maximumChunks {
                        accepting = false
                        return false
                    }
                }
            }
            return true
        }
    }

    public func finish() {
        lock.withLock {
            accepting = false
            if !tail.isEmpty { sealTail() }
        }
    }

    public func acknowledge(_ id: UUID) {
        lock.withLock { chunks.removeAll { $0.id == id } }
    }

    private func sealTail() {
        chunks.append(AudioChunk(startMs: nextStartMs, pcm: tail))
        nextStartMs += tail.count * 1_000 / (WAV.sampleRate * 2)
        tail = Data()
    }
}
