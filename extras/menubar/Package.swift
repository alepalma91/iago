// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "IagoBar",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "IagoBar",
            path: "Sources/TheReviewerBar",
            linkerSettings: [
                .linkedLibrary("sqlite3")
            ]
        )
    ]
)
