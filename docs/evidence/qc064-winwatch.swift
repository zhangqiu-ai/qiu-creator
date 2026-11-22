// Polls CGWindowListCopyWindowInfo(.optionOnScreenOnly) and logs every on-screen window
// owned by Electron / qiu-creator. Usage: winwatch <intervalMs> <outFile>
import CoreGraphics
import Foundation
import Darwin
func exePath(_ pid: Int) -> String {
  var buf = [CChar](repeating: 0, count: 4096)
  let n = proc_pidpath(Int32(pid), &buf, UInt32(buf.count))
  return n > 0 ? String(cString: buf) : ""
}
let interval = Double(CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "100")! / 1000
let out = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "/dev/stdout"
FileManager.default.createFile(atPath: out, contents: nil)
let h = FileHandle(forWritingAtPath: out)!
func log(_ s: String) { h.write((s + "\n").data(using: .utf8)!) }
var samples = 0, hits = 0
var allPids = Set<Int>()
signal(SIGTERM) { _ in exit(0) }
atexit { }
let start = Date()
while true {
  let all = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
  let on = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
  samples += 1
  let isOurs: ([String: Any]) -> Bool = { w in
    // Test runs only: the workspace Electron binary or a build under ~/code; never the
    // installed /Applications/qiu-creator.app the user is working in.
    let o = (w[kCGWindowOwnerName as String] as? String ?? "").lowercased()
    guard o.contains("electron") || o.contains("qiu-creator") else { return false }
    let exe = exePath(w[kCGWindowOwnerPID as String] as? Int ?? 0)
    return exe.contains("/code/qiu-creator")
  }
  for w in all where isOurs(w) { allPids.insert(w[kCGWindowOwnerPID as String] as? Int ?? 0) }
  for w in on where isOurs(w) {
    hits += 1
    let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
    log(String(format: "%.1fs ON_SCREEN owner=%@ pid=%d layer=%d alpha=%@ bounds=%@ exe=%@",
      Date().timeIntervalSince(start), w[kCGWindowOwnerName as String] as? String ?? "?",
      w[kCGWindowOwnerPID as String] as? Int ?? 0, w[kCGWindowLayer as String] as? Int ?? 0,
      "\(w[kCGWindowAlpha as String] ?? "?")", "\(b)", exePath(w[kCGWindowOwnerPID as String] as? Int ?? 0)))
  }
  if samples % 50 == 0 {
    log(String(format: "%.1fs samples=%d onScreenHits=%d electronPidsSeenOffscreen=%d", Date().timeIntervalSince(start), samples, hits, allPids.count))
  }
  Thread.sleep(forTimeInterval: interval)
}
