const qa=window.__ledgerTest,checks=[],delay=ms=>new Promise(r=>setTimeout(r,ms));
const assert=(ok,label)=>{if(!ok)throw new Error(label);checks.push(label)};
const wait=async(fn,label)=>{for(let i=0;i<160;i++){if(fn())return;await delay(40)}throw new Error(label)};
const open=async name=>{qa.navigate('/notebooks/'+bookId+'?file='+encodeURIComponent('Examples/'+name));await wait(()=>document.querySelector('[data-file-path="Examples/'+name+'"] .tiptap')?.editor,'Editor missing');await delay(100);return document.querySelector('[data-file-path="Examples/'+name+'"] .tiptap').editor};
if(phase==='stage'){
  const editor=await open('来源.md');let selected;editor.state.doc.descendants((node,pos)=>{if(node.isText&&node.text.startsWith('消息队列按'))selected={from:pos,to:pos+node.nodeSize}});
  editor.commands.focus();await delay(30);editor.commands.setTextSelection(selected);await delay(40);document.querySelector('[aria-label=加入中转站]').click();
  await open('保存重试.md');
}else{
  const editor=document.querySelector('[data-file-path="Examples/保存重试.md"] .tiptap').editor;
  editor.commands.focus('end');await delay(60);document.querySelector('[aria-label=打开中转]').click();await delay(50);document.querySelector('.transfer-clip').click();
  if(phase==='fail'){
    await wait(()=>document.querySelector('.transfer-toast')?.textContent.includes('保存失败'),'Save failure was not reported');
    assert(document.querySelectorAll('.transfer-clip:not(.is-leaving)').length===1,'Failed save keeps the source clip');
    assert(editor.view.dom.querySelectorAll('a[data-notebook-target]').length===1,'Failed save retains one editable insertion');
  }else{
    await wait(()=>!document.querySelector('.transfer-clip'),'Retry did not consume saved clip');await qa.flush();
    assert(editor.view.dom.querySelectorAll('a[data-notebook-target]').length===1,'Retry saves the existing insertion without duplicating the link');
    assert(!document.querySelector('.notebook-image-notice[role=alert]'),'Successful retry clears the save error');
  }
}
return {checks};
