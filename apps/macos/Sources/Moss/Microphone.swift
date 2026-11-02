import AVFoundation
import Foundation
import MossKit
import Observation

// AVAudioConverter is used only while holding this lock, including the final drain.
private final class PCMProcessor: @unchecked Sendable {
    private let lock = NSLock()
    private let converter: AVAudioConverter
    private let outputFormat: AVAudioFormat
    private let ledger: PendingAudio
    private var finished = false

    init(inputFormat: AVAudioFormat, ledger: PendingAudio) throws {
        guard let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000,
                                        channels: 1, interleaved: true),
              let converter = AVAudioConverter(from: inputFormat, to: format) else {
            throw APIError(message: "This microphone cannot be converted to 16 kHz mono PCM.")
        }
        self.outputFormat = format
        self.converter = converter
        self.ledger = ledger
    }

    func consume(_ input: AVAudioPCMBuffer) -> String? {
        lock.withLock {
            guard !finished else { return nil }
            let capacity = AVAudioFrameCount(ceil(Double(input.frameLength) * 16_000 / input.format.sampleRate)) + 64
            guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else {
                return "Could not allocate an audio conversion buffer."
            }
            var supplied = false
            var conversionError: NSError?
            let status = converter.convert(to: output, error: &conversionError) { _, status in
                if supplied { status.pointee = .noDataNow; return nil }
                supplied = true
                status.pointee = .haveData
                return input
            }
            if let conversionError { return conversionError.localizedDescription }
            if status == .error { return "Microphone audio conversion failed." }
            return append(output) ? nil : "Recording stopped because 120 seconds of audio are waiting to upload. Pending audio has been kept."
        }
    }

    func finish() -> String? {
        lock.withLock {
            guard !finished else { return nil }
            finished = true
            var failure: String?
            if ledger.isAccepting,
               let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: 4_096) {
                var error: NSError?
                let status = converter.convert(to: output, error: &error) { _, status in
                    status.pointee = .endOfStream
                    return nil
                }
                _ = append(output)
                if status == .error || error != nil {
                    failure = "The last microphone frames could not be converted. Earlier pending audio is kept. \(error?.localizedDescription ?? "Audio conversion failed.")"
                }
            }
            ledger.finish()
            return failure
        }
    }

    private func append(_ output: AVAudioPCMBuffer) -> Bool {
        guard output.frameLength > 0, let samples = output.int16ChannelData?[0] else { return true }
        return ledger.append(Data(bytes: samples, count: Int(output.frameLength) * 2))
    }
}

@MainActor @Observable
final class RecordingSession {
    private(set) var isRecording = false { didSet { syncWork() } }
    private(set) var isStarting = false { didSet { syncWork() } }
    private(set) var isUploading = false { didSet { syncWork() } }
    private(set) var pending: [AudioChunk] = [] { didSet { syncWork() } }
    private(set) var meetingID: String?
    private(set) var meetingTitle = ""
    private(set) var errorMessage: String?
    private(set) var elapsedSeconds = 0
    @ObservationIgnored private var engine: AVAudioEngine?
    @ObservationIgnored private var processor: PCMProcessor?
    @ObservationIgnored private var ledger: PendingAudio?
    @ObservationIgnored private var timerTask: Task<Void, Never>?
    @ObservationIgnored private var uploadTask: Task<Void, Never>?
    @ObservationIgnored private var permissionRequestID: UUID?
    @ObservationIgnored private var configurationObserver: NSObjectProtocol?
    @ObservationIgnored private let workspace: Workspace

    init(workspace: Workspace) { self.workspace = workspace }

    var hasWork: Bool { isRecording || isStarting || isUploading || !pending.isEmpty }
    private func syncWork() { workspace.setRecordingHasWork(hasWork) }

    func start(_ meeting: Meeting) async {
        guard !hasWork, !workspace.blocksCapture else { return }
        let requestID = UUID()
        permissionRequestID = requestID
        isStarting = true
        errorMessage = nil
        defer {
            if permissionRequestID == requestID {
                permissionRequestID = nil
                isStarting = false
            }
        }
        let permitted = await AVCaptureDevice.requestAccess(for: .audio)
        guard permissionRequestID == requestID else { return }
        guard permitted else {
            errorMessage = "Microphone access was denied. Enable Moss in System Settings > Privacy & Security > Microphone."
            return
        }
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
            errorMessage = "No usable microphone is connected."
            return
        }
        let endMs = meeting.segments.map { $0.startMs + $0.durationMs }.max() ?? 0
        let ledger = PendingAudio(startMs: Int(ceil(endMs)))
        do {
            let processor = try PCMProcessor(inputFormat: inputFormat, ledger: ledger)
            input.installTap(onBus: 0, bufferSize: 4_096, format: inputFormat) { [weak self] buffer, _ in
                if let error = processor.consume(buffer) {
                    Task { @MainActor [weak self] in self?.halt(error) }
                }
            }
            self.ledger = ledger
            self.processor = processor
            self.engine = engine
            configurationObserver = NotificationCenter.default.addObserver(
                forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
            ) { [weak self] _ in
                Task { @MainActor [weak self] in
                    self?.halt("The microphone configuration changed. Recording stopped and pending audio was kept. Retry pending uploads before recording again.")
                }
            }
            meetingID = meeting.id
            meetingTitle = meeting.title
            elapsedSeconds = 0
            engine.prepare()
            try engine.start()
            isRecording = true
            let started = Date()
            timerTask = Task { [weak self] in
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
                    guard let self, self.isRecording else { return }
                    self.elapsedSeconds = Int(Date().timeIntervalSince(started))
                    self.refreshPending()
                    self.pumpUploads()
                }
            }
        } catch {
            halt(error.localizedDescription)
        }
    }

    func stop() {
        closeMicrophone()
        refreshPending()
        pumpUploads()
    }

    func retry() {
        guard !isUploading, !isRecording else { return }
        errorMessage = nil
        pumpUploads()
    }

    func discardPending() {
        guard !isRecording, !isUploading, !isStarting else { return }
        pending = []
        ledger = nil
        meetingID = nil
        errorMessage = nil
    }

    func halt(_ message: String) {
        guard isRecording || engine != nil else { return }
        closeMicrophone()
        errorMessage = message
        refreshPending()
    }

    private func closeMicrophone() {
        permissionRequestID = nil
        isStarting = false
        timerTask?.cancel()
        timerTask = nil
        if let configurationObserver { NotificationCenter.default.removeObserver(configurationObserver) }
        configurationObserver = nil
        engine?.stop()
        engine?.inputNode.removeTap(onBus: 0)
        if let failure = processor?.finish() { errorMessage = failure }
        engine = nil
        processor = nil
        isRecording = false
    }

    private func refreshPending() { pending = ledger?.pending ?? [] }

    private func pumpUploads() {
        guard uploadTask == nil, errorMessage == nil, !pending.isEmpty,
              let meetingID, let ledger else { return }
        isUploading = true
        uploadTask = Task { [weak self] in
            guard let self else { return }
            defer { self.isUploading = false; self.uploadTask = nil }
            while let chunk = ledger.pending.first {
                do {
                    try await self.workspace.uploadAudio(meetingID, chunk: chunk)
                    ledger.acknowledge(chunk.id)
                    self.refreshPending()
                    if self.errorMessage != nil { return }
                } catch {
                    self.closeMicrophone()
                    self.refreshPending()
                    self.errorMessage = "Transcription stopped. \(error.localizedDescription) All pending audio is kept in memory. Retry or save the WAV files before quitting."
                    return
                }
            }
        }
    }
}
