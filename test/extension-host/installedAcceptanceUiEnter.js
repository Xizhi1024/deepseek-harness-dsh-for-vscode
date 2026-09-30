async (page) => {
  const f = page.locator('#frame').contentFrame();
  const notice = f.getByRole('button', { name: '继续', exact: true });
  if (await notice.isVisible()) await notice.click();
  await page.waitForFunction(() => window.__vscodeEvents.some(x => x.target?.state === 'known'));
  const composer = f.getByRole('textbox', { name: '发消息或创建任务, / 调用指令, @ 文件或对话', exact: true });
  await composer.click(); await composer.pressSequentially('line one');
  await composer.press('Control+Enter'); await composer.pressSequentially('line two');
  const multiline = await composer.innerText();
  if (multiline !== 'line one\nline two') throw new Error(`Ctrl+Enter altered draft: ${JSON.stringify(multiline)}`);
  const messagesBefore = await f.getByRole('status').filter({ hasText: '已完成工作' }).count();
  await composer.press('Enter');
  const until = Date.now() + 10000;
  while (await composer.innerText() !== '' && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
  if (await composer.innerText() !== '') throw new Error('Plain Enter did not submit');
  await f.getByText('line one\nline two', { exact: true }).waitFor();
  return { ctrlEnter: 'newline without submit', submittedText: multiline, plainEnter: 'submitted', messagesBefore };
}
