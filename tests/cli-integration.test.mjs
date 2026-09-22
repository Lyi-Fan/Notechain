import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const executable = process.env.LEDGER_CLI || path.resolve(`src-tauri/target/debug/ledger${process.platform === 'win32' ? '.exe' : ''}`)
function run(args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, stdio: 'pipe' })
    let stdout = '', stderr = ''
    child.stdout.on('data', b => { stdout += b })
    child.stderr.on('data', b => { stderr += b })
    child.once('error', reject)
    child.once('exit', code => resolve({ code, stdout, stderr }))
    child.stdin.end(input)
  })
}

test('native CLI exchanges JSON using literal paths and PowerShell encodings', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "ledger 中文 [test] '$&-"))
  const descriptor = path.join(directory, 'connection.json')
  const requests = []
  const token = 'synthetic-test-capability-1234567890'
  const server = createServer(socket => {
    let data = ''
    socket.on('data', bytes => {
      data += bytes
      if (!data.endsWith('\n')) return
      const request = JSON.parse(data)
      assert.equal(request.token, token)
      delete request.token
      requests.push(request)
      socket.end(JSON.stringify(request.caseId === 'conflict'
        ? { ok: false, error: { status: 409, message: '版本冲突' } }
        : { ok: true, value: { echo: request, title: '中文🙂' } }) + '\n')
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    await writeFile(descriptor, JSON.stringify({ transport: 'tcp', address: `127.0.0.1:${server.address().port}`, token }))
    const connection = ['--connection', descriptor]
    const patch = { revision: 0, requestId: 'test-1', nodes: [{ id: 'manual', purpose: '中文🙂', note: 'literal $() ` " \\ text' }] }
    for (const [name, bytes] of [
      ['utf8', Buffer.from(JSON.stringify(patch))],
      ['bom', Buffer.from('\ufeff' + JSON.stringify(patch))],
      ['utf16le', Buffer.from('\ufeff' + JSON.stringify(patch), 'utf16le')],
      ['utf16be', Buffer.from('\ufeff' + JSON.stringify(patch), 'utf16le').swap16()],
    ]) await t.test(name, async () => {
      const file = path.join(directory, `${name} 中文 [x] '$&.json`)
      await writeFile(file, bytes)
      const result = await run(['graph', 'apply', 'case-1', '--file', file, '--preview', ...connection])
      assert.equal(result.code, 0, result.stderr)
      assert.equal(result.stderr, '')
      assert.match(result.stdout, /^[\x00-\x7f]+$/)
      assert.deepEqual(JSON.parse(result.stdout).echo.patch, patch)
      assert.equal(JSON.parse(result.stdout).echo.preview, true)
    })
    await t.test('stdin and UTF8 output file', async () => {
      const output = path.join(directory, '输出 [1].json')
      const result = await run(['graph', 'apply', 'case-1', '--file', '-', '--output', output, ...connection], '\ufeff' + JSON.stringify(patch))
      assert.equal(result.code, 0, result.stderr)
      assert.equal(result.stdout, '')
      assert.deepEqual(JSON.parse(await readFile(output, 'utf8')).echo.patch, patch)
    })
    await t.test('server errors set exit code and leave stdout empty', async () => {
      const result = await run(['graph', 'get', 'conflict', ...connection])
      assert.equal(result.code, 1)
      assert.equal(result.stdout, '')
      assert.equal(JSON.parse(result.stderr).status, 409)
      assert.equal(JSON.parse(result.stderr).message, '版本冲突')
    })
    await t.test('invalid input never reaches server', async () => {
      const before = requests.length
      for (const args of [['unknown'], ['graph', 'apply', 'case-1'], ['graph', 'cases', '--output'], ['graph', 'get', 'id', '--preview']]) {
        const result = await run([...args, ...connection])
        assert.equal(result.code, 1)
        assert.equal(result.stdout, '')
      }
      assert.equal(requests.length, before)
    })
    await t.test('reject nonlocal descriptors before connecting', async () => {
      await writeFile(descriptor, JSON.stringify({ transport: 'tcp', address: '203.0.113.1:4281', token }))
      const result = await run(['graph', 'cases', ...connection])
      assert.equal(result.code, 1)
      assert.match(result.stderr, /this computer/)
    })
    await t.test('help and version need no app', async () => {
      assert.equal((await run(['--help'])).code, 0)
      assert.match((await run(['--version'])).stdout, /^ledger /)
    })
  } finally {
    await new Promise(resolve => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})
