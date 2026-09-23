import { chmod, mkdir, mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { spawn, execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const root=path.resolve(import.meta.dirname,'..'), mac=process.platform==='darwin'
if (!mac && process.platform!=='win32') throw new Error('A native Mac or Windows desktop is required')
const target=process.env.CARGO_TARGET_DIR || path.join(root,'src-tauri/target')
const executable=process.env.NOTECHAIN_QA_EXECUTABLE || (mac ? path.join(target,'release/bundle/macos/Notechain.app/Contents/MacOS/Notechain') : path.join(target,'release/Notechain.exe'))
const cli=path.join(path.dirname(executable),mac?'ledger':'ledger.exe')
await mkdir(path.join(root,'.qa'),{recursive:true})
const directory=await mkdtemp(path.join(root,'.qa/runtime-'))
await mkdir(path.join(directory,'Notebook/Category/Nested'),{recursive:true})
await writeFile(path.join(directory,'Notebook/Category/Nested/中文 [1].md'),'# 文件笔记\n\n原始内容。\n')
const image=(await readFile(path.join(root,'extension/icons/ledger-128.png'))).toString('base64')
const externalImages=await mkdtemp(path.join(tmpdir(),'notechain-external-images-'))
const externalFile=path.join(externalImages,'_外部 图片.png')
await writeFile(externalFile,Buffer.from(image,'base64'))
await mkdir(path.join(directory,'External Images'),{recursive:true})
await writeFile(path.join(directory,'External Images/相对 图片.png'),Buffer.from(image,'base64'))
await mkdir(path.join(directory,'Notebook/Examples'),{recursive:true})
const externalSource = [
  '# 本机图片',
  `![absolute](<${externalFile}>)`,
  `![file URL](${pathToFileURL(externalFile).href})`,
  '![relative](<../../External Images/相对 图片.png>)',
  `![[${externalFile}|128]]`,
  `<img src="${pathToFileURL(externalFile).href}" width="128">`,
].join('\n\n')+'\n'
await writeFile(path.join(directory,'Notebook/Examples/本机图片.md'),externalSource)
await writeFile(path.join(directory,'Notebook/Examples/本机图片预览.md'),'[本机图片](本机图片.md)\n')
if (!mac && process.env.CI) assert.notEqual(path.parse(externalFile).root.toLowerCase(),path.parse(directory).root.toLowerCase(),'Windows CI must verify a note and image on different drives')
await mkdir(path.join(directory,'Notebook/Examples/合成报告.assets'),{recursive:true})
await writeFile(path.join(directory,'Notebook/Examples/合成报告.assets/1785287884999.png'),Buffer.from(image,'base64'))
const relocatedImage=String.raw`C:\Archive\合成报告.assets\1785287884999.png`;
await writeFile(path.join(directory,'Notebook/Examples/迁移图片.md'),'# 迁移图片\n\n![1785287884999]('+relocatedImage+')\n\n![文件网址](file:///C:/Archive/合成报告.assets/1785287884999.png)\n');
await writeFile(path.join(directory,'Notebook/Examples/图片预览.md'),'[迁移图片](迁移图片.md)\n');
await mkdir(path.join(directory,'Notebook/assets'),{recursive:true})
await writeFile(path.join(directory,'Notebook/assets/Pasted image 20260922114737.png'),Buffer.from(image,'base64'))
await writeFile(path.join(directory,'Notebook/Examples/图片兼容.md'),'# 图片兼容\n\n![[Pasted image 20260922114737.png]]\n\n![[assets/Pasted image 20260922114737.png|160]]\n\n![Typora](../assets/Pasted image 20260922114737.png)\n\n<img src="../assets/Pasted image 20260922114737.png" width="180">\n\n正文末尾。\n')
for (const [name,body] of Object.entries({'语法.md':'# 语法\n\n测试文字。','来源.md':'# 消息队列\n\n消息队列按先进先出的顺序处理任务。生产者与消费者可以分别扩展。','目标.md':'# 接口重试\n\n重复请求应满足幂等性，避免重复创建订单。','第二份.md':'# 摘要\n\n保留来源。'})) await writeFile(path.join(directory,'Notebook/Examples',name),body+'\n')
const retryFile=path.join(directory,'Notebook/Examples/保存重试.md')
await writeFile(retryFile,'# 保存重试\n\n目标正文。\n')
let child, exited, spawnError
function start() {
  spawnError=undefined
  const env={...process.env,ASSET_LEDGER_DEV_DATA:directory,ASSET_LEDGER_QA:'1',ASSET_LEDGER_QA_BRIDGE_PORT:'0'}
  delete env.ASSET_LEDGER_QA_ROUTE
  child=mac ? spawn('/usr/bin/open',['-n','-W','-a',path.dirname(path.dirname(path.dirname(executable))),'--env',`ASSET_LEDGER_DEV_DATA=${directory}`,'--env','ASSET_LEDGER_QA=1','--env','ASSET_LEDGER_QA_BRIDGE_PORT=0','--args','--qa'],{stdio:'ignore'}) : spawn(executable,['--qa'],{env,stdio:'ignore'})
  child.once('error',error=>{spawnError=error})
  exited=new Promise(resolve=>child.once('exit',resolve))
}
async function command(script,wait=true) {
  const id=randomUUID()
  await writeFile(path.join(directory,'qa-command.next'),JSON.stringify({id,script}))
  await rename(path.join(directory,'qa-command.next'),path.join(directory,'qa-command.json'))
  if (!wait) return
  const deadline=Date.now()+120000
  while(Date.now()<deadline) {
    if(spawnError) throw spawnError
    if(child.exitCode!==null) throw new Error(`Application exited: ${child.exitCode}`)
    try { const report=JSON.parse(await readFile(path.join(directory,'qa-report.json'),'utf8')); if(report.id===id) { if(report.error) throw new Error(report.error+'\n'+report.stack); return report.value } }
    catch(error) {if(error.code!=='ENOENT' && !(error instanceof SyntaxError)) throw error}
    await delay(30)
  }
  throw new Error('Native runtime check timed out')
}
async function quit() {
  await command("await window.__ledgerTest.flush(); await window.__ledgerTest.invoke('finish_quit');",false)
  await Promise.race([exited,delay(10000).then(()=>{throw new Error('Quit timed out')})])
}
start()
try {
  const script=await readFile(path.join(root,'tests/runtime-smoke.js'),'utf8')
  const report=await command(`const fixtureImage=${JSON.stringify(image)}, fixtureDirectory=${JSON.stringify(directory)}, expectedPlatform=${JSON.stringify(mac?'macos':'windows')};\n${script}`)
  const localImages=await command(`const bookId=${JSON.stringify(report.book)};\n`+await readFile(path.join(root,'tests/runtime-local-images.js'),'utf8'))
  report.checks.push(...localImages.checks)
  assert.equal(await readFile(path.join(directory,'Notebook/Examples/本机图片.md'),'utf8'),externalSource,'Reading external images must not rewrite Markdown')
  assert.equal((await readFile(externalFile)).toString('base64'),image,'Reading external images must not change the original image')
  report.checks.push('External image reads preserve the Markdown and original image')
  if (!mac && process.env.CI) report.checks.push('Windows note and external image are on different drives')
  const compatibility=await command(`const fixtureImage=${JSON.stringify(image)}, bookId=${JSON.stringify(report.book)};\n`+await readFile(path.join(root,'tests/runtime-compat.js'),'utf8'))
  report.checks.push(...compatibility.checks)
  const retryScript=await readFile(path.join(root,'tests/runtime-transfer-retry.js'),'utf8')
  await command(`const bookId=${JSON.stringify(report.book)},phase="stage";\n${retryScript}`)
  try {
    await chmod(retryFile,0o444)
    const failed=await command(`const bookId=${JSON.stringify(report.book)},phase="fail";\n${retryScript}`)
    report.checks.push(...failed.checks)
  } finally { await chmod(retryFile,0o644) }
  const retried=await command(`const bookId=${JSON.stringify(report.book)},phase="retry";\n${retryScript}`)
  report.checks.push(...retried.checks)
  const assetTransfer=await command(`const sourceId=${JSON.stringify(report.id)},caseId=${JSON.stringify(report.caseId)};\n`+await readFile(path.join(root,'tests/runtime-asset-transfer.js'),'utf8'))
  report.checks.push(...assetTransfer.checks)
  const run=(args)=>JSON.parse(execFileSync(cli,['graph',...args,'--connection',path.join(directory,'control.json')],{encoding:'utf8',timeout:65000}))
  assert(run(['cases']).some(item=>item.id===report.caseId))
  const graph=run(['get',report.caseId])
  const patch=path.join(directory,'patch 中文 [1].json')
  await writeFile(patch,'\ufeff'+JSON.stringify({revision:graph.revision,requestId:randomUUID(),nodes:[{id:report.id,purpose:'CLI 验证'}]}),'utf16le')
  assert(run(['apply',report.caseId,'--file',patch,'--preview']).preview)
  assert(run(['apply',report.caseId,'--file',patch]).ok)
  assert.equal(run(['get',report.caseId]).nodes.find(node=>node.id===report.id).purpose,'CLI 验证')
  report.checks.push('Real console CLI reads and applies a UTF-16 patch')
  const pdf=await readFile(path.join(directory,'qa-print.pdf')); assert(pdf.subarray(0,5).equals(Buffer.from('%PDF-')))
  await quit()
  await rm(path.join(directory,'qa-ready.json'),{force:true})
  start()
  const reopened=await command('const index=await window.__ledgerTest.invoke("load_index"); const books=await window.__ledgerTest.invoke("notebook",{input:{action:"index"}});return {index,books};')
  assert(reopened.index.state.cases.some(item=>item.id===report.caseId))
  assert(reopened.books.notebooks.some(book=>book.id===report.book))
  report.checks.push('Native relaunch restores the created case and notebook registry')
  await quit()
  await writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2))
  console.log(JSON.stringify({checks:report.checks.length,results:report.checks,directory},null,2))
} finally {
  if(child.exitCode===null && !spawnError) {
    try {await quit()} catch { await command("await window.__ledgerTest.invoke('finish_quit');",false).catch(()=>{}); await Promise.race([exited,delay(3000)]) }
    if(child.exitCode===null) child.kill()
  }
  if(!spawnError) await exited
  await rm(externalImages,{recursive:true,force:true})
}
