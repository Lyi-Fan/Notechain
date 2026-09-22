const qa=window.__ledgerTest,checks=[],delay=ms=>new Promise(r=>setTimeout(r,ms));
const assert=(ok,label)=>{if(!ok)throw new Error(label);checks.push(label)};
const wait=async(fn,label)=>{for(let i=0;i<200;i++){if(fn())return;await delay(30)}throw new Error(label)};
const open=async id=>{qa.navigate('/cases/'+caseId+'/assets/'+id);await wait(()=>document.querySelector('[data-asset-id="'+id+'"] .tiptap')?.editor,'Asset editor missing');await delay(100);return document.querySelector('[data-asset-id="'+id+'"] .tiptap').editor};
const source=qa.ledger.getState().assets.find(asset=>asset.id===sourceId);
const targets=['First destination','Second destination'].map(title=>qa.ledger.addAsset({...source,title,customTitle:title,value:'',noteMarkdown:'目标笔记正文。'}));
await delay(100);await qa.flush();let editor=await open(sourceId),range;
editor.state.doc.descendants((node,pos)=>{if(!range&&node.type.name==='paragraph'&&node.textContent.trim())range={from:pos+1,to:pos+1+node.content.size}});
editor.commands.focus();await delay(30);editor.commands.setTextSelection(range);await wait(()=>document.querySelector('[aria-label=加入中转站]'),'Source selection toolbar missing');document.querySelector('[aria-label=加入中转站]').click();
let originalHref;
for(const [index,id]of targets.entries()){
  editor=await open(id);editor.commands.focus('end');await delay(60);document.querySelector('[aria-label=打开中转]').click();await delay(50);document.querySelector('.transfer-clip').click();
  await wait(()=>editor.view.dom.querySelector('a[data-notebook-target]'),'Asset reference missing');await delay(650);await qa.flush();
  const link=editor.view.dom.querySelector('a[data-notebook-target]'),href=link.getAttribute('data-notebook-target');
  if(!originalHref)originalHref=href;
  assert(href===originalHref&&href.includes('/assets/'+sourceId),'Asset transfer '+(index+1)+' keeps the original source');
  link.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:460,clientY:260}));
  await wait(()=>document.querySelector('[data-kind=asset]')?.textContent.includes('中文编辑验收')||document.querySelector('[data-kind=asset]')?.textContent.includes('中文笔记'),'Asset preview missing');
  assert(true,'Asset transfer '+(index+1)+' renders the source preview');
  if(index===0){
    editor.commands.focus();await delay(30);let selection;editor.state.doc.descendants((node,pos)=>{if(node.marks.some(mark=>mark.type.name==='link'&&mark.attrs.href===href))selection={from:pos,to:pos+node.nodeSize}});
    editor.commands.setTextSelection(selection);await wait(()=>document.querySelector('[aria-label=加入中转站]'),'Reference selection toolbar missing');document.querySelector('[aria-label=加入中转站]').click();
  }
}
return {checks};
