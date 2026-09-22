import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))]
const roots = new Set(['.cargo', '.github', 'assets', 'extension', 'public', 'scripts', 'skills', 'src', 'src-tauri', 'tests'])
const rootFiles = new Set(['.gitignore', 'README.md', 'package.json', 'package-lock.json', 'index.html', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json', 'vite.config.ts'])
const forbidden = /(?:^|\/)(?:node_modules|target|dist|bin|gen|data|userdata|attachments|backups|releases|output|\.fan|\.qa|\.toolchains|\.mac-test|\.windows-test)(?:\/|$)|\.(?:sqlite\w*|db(?:-\w+)?|log|tmp|exe|dmg|zip|pdb|pem|key)$|(?:^|\/)\.env(?:\.|$)/i
const errors = []
let total = 0
for (const file of files) {
  if ((!file.includes('/') && !rootFiles.has(file)) || (file.includes('/') && !roots.has(file.split('/')[0]))) errors.push(`${file}: outside publication allowlist`)
  // src/bin contains CLI source, not compiled executables.
  if (forbidden.test(file.replace('src-tauri/src/bin/', 'src-tauri/src/'))) errors.push(`${file}: data or generated file`)
  const info = lstatSync(path.join(root, file))
  if (!info.isFile()) { errors.push(`${file}: links and special files are not publishable`); continue }
  total += info.size
  if (info.size > 4 * 1024 * 1024) errors.push(`${file}: unexpectedly large source file`)
  if (/\.(?:png|ico|icns|woff2)$/.test(file)) continue
  const text = readFileSync(path.join(root, file), 'utf8')
  if (file === 'scripts/release-audit.mjs') continue
  if (/\/Users\/[^/\s]+\/|[A-Z]:\\Users\\[^\\\s]+\\/i.test(text)) errors.push(`${file}: personal absolute path`)
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}/.test(text)) errors.push(`${file}: possible credential`)
  if (/createDemoState|demoTargets|demoAssets|console\.meridian\.test|demo_secret_value_do_not_use/.test(text)) errors.push(`${file}: old bundled demo data`)
}
if (errors.length) { console.error(errors.join('\n')); process.exit(1) }
console.log(JSON.stringify({ files: files.length, bytes: total, dataFiles: 0, personalPaths: 0, credentialMatches: 0 }))
