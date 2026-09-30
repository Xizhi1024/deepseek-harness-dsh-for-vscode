async (page) => {
  const f = page.locator('#frame').contentFrame();
  const composer = f.getByRole('textbox', { name: '发消息或创建任务, / 调用指令, @ 文件或对话', exact: true });
  let sequence = 0;
  const rpc = (method, params = {}) => page.evaluate(({ method, params, requestId }) => new Promise((resolve, reject) => {
    const ack = window.__vscodeEvents.findLast(x => x.type === 'hello-ack');
    const timeout = setTimeout(() => { clearInterval(interval); reject(new Error(`No browser result for ${method}`)); }, 5000);
    const interval = setInterval(() => {
      const result = window.__vscodeEvents.find(x => x.type === 'result' && x.requestId === requestId);
      if (result) { clearTimeout(timeout); clearInterval(interval); resolve(result); }
    }, 10);
    window.postMessage({ channel: ack.channel, version: ack.version, surfaceId: ack.surfaceId, surfaceEpoch: ack.surfaceEpoch,
      type: 'request', method, params, requestId }, location.origin);
  }), { method, params, requestId: `ui-insert-${Date.now()}-${++sequence}` });
  const target = (await rpc('target.get')).value;
  const originalDraft = await composer.innerText();
  const staleTicket = await rpc('insertion.capture', { expected: target });
  if (!staleTicket.ok) throw new Error(JSON.stringify(staleTicket));
  await composer.click(); await composer.press('End'); await composer.pressSequentially(' user edit');
  const editedDraft = await composer.innerText();
  const conflict = await rpc('insertion.commit', { ticketId: staleTicket.value.ticketId, text: ' BAD' });
  if (conflict.ok || conflict.error.code !== 'CONFLICT' || await composer.innerText() !== editedDraft) throw new Error('Revision conflict modified draft');
  const ticket = await rpc('insertion.capture', { expected: target });
  const inserted = await rpc('insertion.commit', { ticketId: ticket.value.ticketId, text: ' ATTACHMENT' });
  const afterInsert = await composer.innerText();
  const replay = await rpc('insertion.commit', { ticketId: ticket.value.ticketId, text: ' ATTACHMENT' });
  if (!inserted.ok || !replay.ok || await composer.innerText() !== afterInsert || !afterInsert.includes('ATTACHMENT')) throw new Error('Insertion/replay failed');
  const beforeSwitch = await rpc('insertion.capture', { expected: target });
  const expandSidebar = f.getByRole('button', { name: '打开侧边栏', exact: true });
  if (await expandSidebar.isVisible()) await expandSidebar.click();
  await f.getByRole('treeitem').filter({ hasText: 'UI search beta' }).click();
  const beta = (await rpc('target.get')).value;
  if (beta.sessionId === target.sessionId || beta.selectionGeneration <= target.selectionGeneration) throw new Error('Manual switch unobserved');
  const stale = await rpc('insertion.commit', { ticketId: beforeSwitch.value.ticketId, text: ' BAD TARGET' });
  if (stale.ok || stale.error.code !== 'STALE_TARGET') throw new Error('Stale target allowed insertion');
  const navigated = await rpc('session.navigate', { sessionId: target.sessionId });
  if (!navigated.ok || navigated.value.sessionId !== target.sessionId || navigated.value.selectionGeneration <= beta.selectionGeneration) throw new Error('Public navigation failed');
  if (await composer.innerText() !== afterInsert) throw new Error('Draft was lost across session switch');
  return { originalDraft, editedDraft, afterInsert, conflict: conflict.error.code, replayIdempotent: true,
    manualSwitchObserved: true, staleTarget: stale.error.code, navigationObserved: true, draftPreserved: true,
    generations: [target.selectionGeneration, beta.selectionGeneration, navigated.value.selectionGeneration] };
}
