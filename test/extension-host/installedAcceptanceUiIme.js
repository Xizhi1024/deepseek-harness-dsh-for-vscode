async (page) => {
  const f = page.locator('#frame').contentFrame();
  const composer = f.getByRole('textbox', { name: '发消息或创建任务, / 调用指令, @ 文件或对话', exact: true });
  await composer.click(); await composer.pressSequentially('draft ');
  const before = await composer.innerText();
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 });
    const composing = await composer.innerText();
    await cdp.send('Input.insertText', { text: '中文' });
    await composer.pressSequentially(' tail');
    const after = await composer.innerText();
    if (!composing.includes('中文') || after !== `${before}中文 tail` || !await composer.evaluate(el => document.activeElement === el)) throw new Error('IME composition or focus changed');
    return { before, composing, after, focusPreserved: true, method: 'Chromium Input.imeSetComposition + Input.insertText' };
  } finally { await cdp.detach(); }
}
