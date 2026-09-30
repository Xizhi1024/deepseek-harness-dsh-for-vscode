async (page) => {
  const frame = page.locator('#frame').contentFrame();
  const search = frame.getByRole('textbox', { name: '搜索会话名称', exact: true });
  const button = frame.getByRole('button', { name: '搜索会话', exact: true });
  const results = [];
  for (const width of [320, 480, 800]) {
    await page.setViewportSize({ width, height: 800 });
    const handle = await search.elementHandle();
    for (let cycle = 0; cycle < 20; cycle++) {
      await button.click();
      await search.fill('');
      await search.pressSequentially('alpha');
      await frame.getByRole('treeitem').filter({ hasText: 'UI search alpha' }).waitFor();
      if (await frame.getByRole('treeitem').filter({ hasText: 'UI search beta' }).count()) throw new Error(`Unfiltered beta at ${width}/${cycle}`);
      if (!await search.evaluate(el => document.activeElement === el && el.selectionStart === 5)) throw new Error(`Search caret/focus lost at ${width}/${cycle}`);
      if (!await handle.evaluate(el => el.isConnected)) throw new Error(`Search node replaced at ${width}/${cycle}`);
      await search.press('Escape');
      if (await search.inputValue() !== '') throw new Error('Escape did not clear search');
      await search.press('Escape');
    }
    await button.click(); await search.fill('alpha');
    await page.screenshot({ path: `search-${width}.png` });
    results.push({ width, cycles: 20, searchNodePreserved: true, focusAndCaretPreserved: true, filtering: true });
    await search.press('Escape'); await search.press('Escape');
  }
  return results;
}
