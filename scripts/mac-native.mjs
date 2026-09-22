import { mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
mkdirSync(new URL('../src-tauri/bin/', import.meta.url), { recursive: true })
const target = `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos14.0`
const result = spawnSync('xcrun', ['swiftc', '-O', '-target', target, 'src-tauri/native/PdfMain.swift', '-o', 'src-tauri/bin/ledger-pdf', '-framework', 'AppKit', '-framework', 'WebKit'], { cwd: root, stdio: 'inherit' })
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
const atoll = spawnSync('xcrun', ['swiftc', '-parse-as-library', '-O', '-target', target, 'src-tauri/native/AtollMain.swift', '-o', 'src-tauri/bin/ledger-atoll'], { cwd: root, stdio: 'inherit' })
if (atoll.error) throw atoll.error
process.exit(atoll.status ?? 1)
