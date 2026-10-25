// Version and executable-path locks outlive every client and release only at process exit.
import AppKit
import Foundation
import Darwin
import CryptoKit

struct SharedHelperOptions: Sendable {
    let runtimeKey: String
    let directory: String
    let startupTimeout: Double
    var socketPath: String { "\(directory)/\(runtimeKey).sock" }
    var readyPath: String { "\(directory)/\(runtimeKey).ready" }
    var versionLockPath: String { "\(directory)/\(runtimeKey).lock" }
    var launchLockPath: String { "\(directory)/\(runtimeKey).launch.lock" }

    init(arguments: [String]) throws {
        guard let mode = arguments.first, ["--ensure-shared", "--serve"].contains(mode) else {
            throw RequestParameters.invalid("Expected shared helper launch mode")
        }
        var fields: [String: String] = [:]
        var index = 1
        while index < arguments.count {
            let key = arguments[index]
            guard index + 1 < arguments.count, ["--runtime-key", "--runtime-directory", "--startup-timeout-ms"].contains(key), fields[key] == nil else {
                throw RequestParameters.invalid("Invalid shared helper option \(key)")
            }
            fields[key] = arguments[index + 1]
            index += 2
        }
        guard let key = fields["--runtime-key"], key.utf8.count == 64,
              key.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
              let directory = fields["--runtime-directory"], directory.hasPrefix("/"),
              let text = fields["--startup-timeout-ms"], let timeout = Double(text), timeout.isFinite,
              timeout > 0, timeout <= Double(Int32.max) else {
            throw RequestParameters.invalid("Shared helper requires SHA-256 runtime key, absolute runtime directory and positive startup timeout")
        }
        runtimeKey = key
        self.directory = directory
        startupTimeout = timeout / 1000
        guard socketPath.utf8.count < MemoryLayout.size(ofValue: sockaddr_un().sun_path) else {
            throw RequestParameters.invalid("Shared helper Unix socket path is too long")
        }
    }

    func prepareDirectory() throws {
        if mkdir(directory, 0o700) != 0 && errno != EEXIST { throw SharedSocket.failure("Creating runtime directory") }
        var info = stat()
        guard lstat(directory, &info) == 0, info.st_mode & S_IFMT == S_IFDIR,
              info.st_uid == getuid(), info.st_mode & 0o777 == 0o700 else {
            throw NativeFailure(code: "NATIVE_RUNTIME_DIRECTORY", message: "Shared helper directory must be a real 0700 directory owned by the current user")
        }
    }

    func executableLockPath() throws -> String {
        guard let executable = NativePlatform.executablePath(getpid()) else {
            throw NativeFailure(code: "NATIVE_IO", message: "Cannot identify helper executable")
        }
        let path = URL(fileURLWithPath: executable).resolvingSymlinksInPath().path
        let digest = SHA256.hash(data: Data(path.utf8)).map { String(format: "%02x", $0) }.joined()
        return "\(directory)/path-\(digest).lock"
    }

    func ready(pid: Int32, instanceID: String) -> JSONValue {
        .object(["type": .string("ready"), "protocol": .number(1), "runtimeKey": .string(runtimeKey),
                 "pid": .number(Double(pid)), "instanceId": .string(instanceID)])
    }

    func existingReady(application: NSRunningApplication? = nil) throws -> Data {
        let until = DispatchTime.now().uptimeNanoseconds + UInt64(startupTimeout * 1_000_000_000)
        repeat {
            if let data = try? Data(contentsOf: URL(fileURLWithPath: readyPath)),
               let ready = try? JSONDecoder().decode(JSONValue.self, from: data),
               ready["type"] == .string("ready"), ready["runtimeKey"] == .string(runtimeKey),
               let number = ready["pid"].number, let pid = Int32(exactly: number), pid > 0,
               kill(pid, 0) == 0, SharedSocket.isOwnedSocket(socketPath) {
                var line = data
                if line.last != 10 { line.append(10) }
                return line
            }
            if application?.isTerminated == true {
                throw NativeFailure(code: "NATIVE_STARTUP", message: "Computer Use exited before becoming ready; restart DSH and check the helper application signature")
            }
            usleep(10_000)
        } while DispatchTime.now().uptimeNanoseconds < until
        throw NativeFailure(code: "NATIVE_STARTUP_TIMEOUT", message: "Existing shared helper did not become ready")
    }
}

final class SharedHelperLock {
    private let descriptor: Int32
    init?(path: String) throws {
        let fd = open(path, O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw SharedSocket.failure("Opening helper lock") }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_uid == getuid(), info.st_mode & 0o777 == 0o600 else {
            close(fd)
            throw NativeFailure(code: "NATIVE_RUNTIME_DIRECTORY", message: "Helper lock must be a regular 0600 file owned by the current user")
        }
        if flock(fd, LOCK_EX | LOCK_NB) != 0 {
            let error = errno
            close(fd)
            if error == EWOULDBLOCK { return nil }
            throw NativeFailure(code: "NATIVE_IO", message: "Locking shared helper failed (errno \(error))")
        }
        descriptor = fd
    }
    deinit { close(descriptor) }
}

final class SharedSocket: @unchecked Sendable {
    let descriptor: Int32
    private let lock = NSLock()
    private var stopped = false
    private var nonblocking = false
    init(descriptor: Int32) {
        self.descriptor = descriptor
        var enabled: Int32 = 1
        _ = setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &enabled, socklen_t(MemoryLayout<Int32>.size))
        _ = fcntl(descriptor, F_SETFD, FD_CLOEXEC)
    }
    deinit { if !stopped { close(descriptor) } }
    func stopReading() { lock.withLock { if !stopped { _ = Darwin.shutdown(descriptor, SHUT_RD) } } }
    func shutdown() {
        lock.withLock {
            guard !stopped else { return }
            stopped = true
            _ = Darwin.shutdown(descriptor, SHUT_RDWR)
            // macOS can reject shutdown after peer EOF; close must not wait for retained callbacks.
            close(descriptor)
        }
    }
    func read(into bytes: UnsafeMutableRawBufferPointer) throws -> Int {
        let retained: Int32? = try lock.withLock {
            guard !stopped else { return nil }
            let retained = fcntl(descriptor, F_DUPFD_CLOEXEC, 0)
            guard retained >= 0 else { throw Self.failure("Retaining helper socket read") }
            return retained
        }
        guard let retained else { return 0 }
        defer { close(retained) }
        while true {
            let count = Darwin.read(retained, bytes.baseAddress, bytes.count)
            if count < 0 && errno == EINTR { continue }
            if count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) {
                var item = pollfd(fd: retained, events: Int16(POLLIN), revents: 0)
                let ready = poll(&item, 1, -1)
                if ready < 0 && errno == EINTR { continue }
                guard ready > 0 else { throw Self.failure("Waiting for helper socket input") }
                continue
            }
            guard count >= 0 else { throw Self.failure("Reading helper socket") }
            return count
        }
    }
    func write(_ data: Data, timeout: Double) throws {
        let started = DispatchTime.now().uptimeNanoseconds
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let (count, error): (Int, Int32) = try lock.withLock {
                    guard !stopped else { throw NativeFailure(code: "NATIVE_IO", message: "Helper socket is closed") }
                    if !nonblocking {
                        let flags = fcntl(descriptor, F_GETFL, 0)
                        guard flags >= 0, fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) == 0 else {
                            throw Self.failure("Configuring nonblocking helper socket")
                        }
                        nonblocking = true
                    }
                    // O_NONBLOCK also bounds large AF_UNIX sends that ignore MSG_DONTWAIT on macOS.
                    let count = Darwin.send(descriptor, bytes.baseAddress!.advanced(by: offset), bytes.count - offset, MSG_DONTWAIT)
                    return (count, errno)
                }
                if count > 0 { offset += count; continue }
                if count < 0 && error == EINTR { continue }
                guard count < 0, error == EAGAIN || error == EWOULDBLOCK else {
                    throw NativeFailure(code: "NATIVE_IO", message: "Writing helper socket failed (errno \(error))")
                }
                let remaining = timeout - Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000_000
                guard remaining > 0 else { throw NativeFailure(code: "NATIVE_IO", message: "Helper socket write timed out") }
                var item = pollfd(fd: descriptor, events: Int16(POLLOUT), revents: 0)
                let ready = poll(&item, 1, Int32(min(remaining * 1000, Double(Int32.max)).rounded(.up)))
                if ready < 0 && errno == EINTR { continue }
                guard ready > 0 else { throw NativeFailure(code: "NATIVE_IO", message: "Helper socket write timed out") }
            }
        }
    }
    func readHello(timeout: Double) throws -> Data {
        let started = DispatchTime.now().uptimeNanoseconds
        var data = Data()
        while data.count < 16_384 {
            let remaining = timeout - Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000_000
            guard remaining > 0 else { throw NativeFailure(code: "NATIVE_STARTUP_TIMEOUT", message: "Shared helper hello timed out") }
            var item = pollfd(fd: descriptor, events: Int16(POLLIN), revents: 0)
            let result = poll(&item, 1, Int32(min(remaining * 1000, Double(Int32.max)).rounded(.up)))
            if result < 0 && errno == EINTR { continue }
            guard result > 0 else { throw NativeFailure(code: "NATIVE_STARTUP_TIMEOUT", message: "Shared helper hello timed out") }
            var byte: UInt8 = 0
            let count = Darwin.read(descriptor, &byte, 1)
            if count < 0 && errno == EINTR { continue }
            guard count == 1 else { throw Self.failure("Reading shared helper hello") }
            if byte == 10 { return data }
            data.append(byte)
        }
        throw NativeFailure(code: "NATIVE_REQUEST_LIMIT", message: "Shared helper hello exceeded 16384 bytes")
    }
    static func isOwnedSocket(_ path: String) -> Bool {
        var info = stat()
        return lstat(path, &info) == 0 && info.st_mode & S_IFMT == S_IFSOCK && info.st_uid == getuid() && info.st_mode & 0o777 == 0o600
    }
    static func failure(_ action: String) -> NativeFailure {
        NativeFailure(code: "NATIVE_IO", message: "\(action) failed (errno \(errno))")
    }
    static func listen(path: String) throws -> SharedSocket {
        var previous = stat()
        if lstat(path, &previous) == 0 {
            guard isOwnedSocket(path) else { throw NativeFailure(code: "NATIVE_RUNTIME_DIRECTORY", message: "Refusing to replace a non-owned Unix socket") }
            guard unlink(path) == 0 else { throw failure("Removing stale helper socket") }
        } else if errno != ENOENT { throw failure("Inspecting helper socket") }
        let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw failure("Creating helper socket") }
        let channel = SharedSocket(descriptor: descriptor)
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let bytes = Array(path.utf8) + [0]
        withUnsafeMutableBytes(of: &address.sun_path) { target in target.copyBytes(from: bytes) }
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard bound == 0, chmod(path, 0o600) == 0, Darwin.listen(descriptor, 64) == 0 else { throw failure("Listening on helper socket") }
        return channel
    }
}

@MainActor enum SharedHelperLauncher {
    static func ensure(_ options: SharedHelperOptions, publishReady: Bool = true) async throws {
        try options.prepareDirectory()
        let deadline = DispatchTime.now().uptimeNanoseconds + UInt64(options.startupTimeout * 1_000_000_000)
        var launchLock: SharedHelperLock?
        repeat {
            launchLock = try SharedHelperLock(path: options.launchLockPath)
            if launchLock != nil { break }
            usleep(10_000)
        } while DispatchTime.now().uptimeNanoseconds < deadline
        guard let launchLock else { throw NativeFailure(code: "NATIVE_STARTUP_TIMEOUT", message: "Computer Use application launch is still in progress") }
        defer { withExtendedLifetime(launchLock) {} }
        if let lock = try SharedHelperLock(path: options.versionLockPath) {
            withExtendedLifetime(lock) {}
        } else {
            let ready = try options.existingReady()
            if publishReady { try FileHandle.standardOutput.write(contentsOf: ready) }
            return
        }
        let bundle = Bundle.main
        guard bundle.bundleURL.pathExtension == "app", bundle.bundleIdentifier != nil,
              let executable = bundle.executableURL,
              executable.resolvingSymlinksInPath().path == NativePlatform.executablePath(getpid()) else {
            throw NativeFailure(code: "NATIVE_APPLICATION_REQUIRED",
                                message: "Computer Use requires its signed application bundle; set helperPath to DSH Computer Use.app/Contents/MacOS/dsh-cua-native")
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.addsToRecentItems = false
        configuration.createsNewApplicationInstance = true
        configuration.allowsRunningApplicationSubstitution = false
        configuration.arguments = ["--serve", "--runtime-key", options.runtimeKey,
                                   "--runtime-directory", options.directory,
                                   "--startup-timeout-ms", String(options.startupTimeout * 1000)]
        // LaunchServices gives the application its own TCC identity; direct spawning inherits the terminal's.
        let application: NSRunningApplication
        do { application = try await NSWorkspace.shared.openApplication(at: bundle.bundleURL, configuration: configuration) }
        catch {
            throw NativeFailure(code: "NATIVE_STARTUP", message: "macOS could not launch Computer Use at \(bundle.bundleURL.path): \(error.localizedDescription)")
        }
        let ready = try options.existingReady(application: application)
        if publishReady { try FileHandle.standardOutput.write(contentsOf: ready) }
    }
}
