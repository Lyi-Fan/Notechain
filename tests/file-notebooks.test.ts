import test from 'node:test'
import assert from 'node:assert/strict'
import { parseNotebookHref, transferHref, fileReadingKey, isMarkdownLink, noteFileUrl, resolveFilePath, relativeFileLink, saveNoteFile, flushNoteFiles, unsavedFiles } from '../src/file-notebooks'
import { configureNative } from '../src/native-storage'

test('reading keys stay short for long Chinese paths and distinguish notebook identities', () => {
  const key = fileReadingKey('book', '很长的分类/'.repeat(100) + '笔记.md')
  assert(key.startsWith('asset-ledger-'))
  assert(key.length < 150)
  assert.equal(key, fileReadingKey('book', '很长的分类/'.repeat(100) + '笔记.md'))
  assert.notEqual(fileReadingKey('a:b', 'c'), fileReadingKey('a', 'b:c'))
})

test('relative Markdown and image paths retain nested directories, unicode and anchors', () => {
  assert.deepEqual(resolveFilePath('分类/笔记.md', '../图片/图一.png'), {path: '图片/图一.png', hash: ''})
  assert.deepEqual(resolveFilePath('A/B.md', '../C.md#heading'), {path: 'C.md', hash: '#heading'})
  assert.deepEqual(resolveFilePath('A/B.md', '#heading'), {path: 'A/B.md', hash: '#heading'})
  assert.deepEqual(resolveFilePath('A/B.md', '/Root.md'), {path: 'Root.md', hash: ''})
  assert.equal(new URL(noteFileUrl('book', 'A/a#b.md'), 'https://notebook.local').searchParams.get('file'), 'A/a#b.md')
  assert.equal(relativeFileLink('A/B.md', 'C/图.md'), '../C/%E5%9B%BE.md')
})
test('file saves serialize revisions and a reopened file can clear an earlier failure', async () => {
  Object.defineProperty(globalThis, 'window', {value: {dispatchEvent() {}}, configurable: true})
  let fail = false
  const calls: Record<string, unknown>[] = []
  configureNative(async <T>(_command: string, args?: Record<string, unknown>) => {
    const input = args?.input as Record<string, unknown>
    calls.push(input)
    if (fail) throw new Error('Read-only file')
    return {path:input.path,revision:String(calls.length),conflict:false} as T
  }, {state:null,kv:{}})
  const session = {id:'book',path:'Note.md',revision:'0',draft:'second',dirty:true,queue:Promise.resolve()}
  await Promise.all([saveNoteFile(session,'first'),saveNoteFile(session,'second')])
  await flushNoteFiles()
  assert.equal(calls[0].revision,'0'); assert.equal(calls[1].revision,'1')
  assert.equal(session.dirty,false)
  fail = true
  session.draft='retry';session.dirty=true
  await assert.rejects(saveNoteFile(session,'retry'))
  assert.equal(unsavedFiles().length,1)
  await assert.rejects(flushNoteFiles())
  fail=false
  await saveNoteFile({...session,queue:Promise.resolve()},'retry')
  await flushNoteFiles()
  assert.equal(unsavedFiles().length,0)
})
test('relative links cannot escape the root or smuggle URL schemes', () => {
  for (const target of ['../../outside.md', 'https://example.com/a.md', 'file:///private/a.md', '//server/a.md', 'javascript:alert(1)', '..\\escape.md']) assert.throws(() => resolveFilePath('A.md', target))
  assert(isMarkdownLink('文件.markdown#标题'))
  assert(!isMarkdownLink('https://example.com/file.md'))
  assert(!isMarkdownLink('javascript:test.md'))
})

test('tray file links retain their original notebook instead of becoming relative Markdown paths', () => {
  const origin = noteFileUrl('book-a', '目录/来源.md')
  const href = transferHref('../参考.md#说明', origin)
  assert.deepEqual(parseNotebookHref(href), { id:'book-a', path:'参考.md', href:noteFileUrl('book-a','参考.md')+'#'+encodeURIComponent('说明') })
  assert(!isMarkdownLink(href))
  assert.equal(transferHref(href, noteFileUrl('book-b','目标.md')), href)
  assert.equal(parseNotebookHref('/notebooks/b?file=..%2Foutside.md'), null)
})
