import Foundation

@main
struct AtollMain {
    static func main() async {
        // Bound the helper even when an older Atoll does not finish its WebSocket close handshake.
        DispatchQueue.global().asyncAfter(deadline: .now() + 12) { exit(2) }
        do {
            let data = FileHandle.standardInput.readDataToEndOfFile()
            guard let requests = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { exit(2) }
            let task = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:9020")!)
            task.resume()
            var results: [[String: Any]] = []
            for (index, request) in requests.enumerated() {
                let id = "ledger-\(index)"
                var message = request
                message["jsonrpc"] = "2.0"
                message["id"] = id
                let encoded = try JSONSerialization.data(withJSONObject: message)
                try await task.send(.string(String(decoding: encoded, as: UTF8.self)))
                while true {
                    let response = try await task.receive()
                    let bytes: Data
                    switch response {
                    case .string(let text): bytes = Data(text.utf8)
                    case .data(let data): bytes = data
                    @unknown default: continue
                    }
                    guard let value = try JSONSerialization.jsonObject(with: bytes) as? [String: Any], value["id"] as? String == id else { continue }
                    results.append(value)
                    if value["error"] != nil {
                        FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: results))
                        task.cancel(with: .goingAway, reason: nil)
                        exit(1)
                    }
                    break
                }
            }
            FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: results))
            task.cancel(with: .normalClosure, reason: nil)
            exit(0)
        } catch {
            FileHandle.standardError.write(Data("Atoll connection failed\n".utf8))
            exit(2)
        }
    }
}
