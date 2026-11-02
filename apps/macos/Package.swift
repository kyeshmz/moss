// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Moss",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "Moss", targets: ["Moss"]),
        .library(name: "MossKit", targets: ["MossKit"])
    ],
    targets: [
        .target(name: "MossKit"),
        .executableTarget(name: "Moss", dependencies: ["MossKit"]),
        .testTarget(name: "MossKitTests", dependencies: ["MossKit"]),
        .testTarget(name: "MossAppearanceTests", dependencies: ["Moss"])
    ]
)
