// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "NiumaBooster",
    platforms: [.macOS(.v13)],
    targets: [
        // 纯 Foundation：节假日、计薪、设置、文案。可单测。
        .target(name: "NiumaCore"),
        // AppKit + SwiftUI 菜单栏应用
        .executableTarget(name: "NiumaBooster", dependencies: ["NiumaCore"]),
        .testTarget(name: "NiumaCoreTests", dependencies: ["NiumaCore"]),
    ]
)
