const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const vm = require('node:vm');

async function readingContent() {
  const source = await fs.readFile(require.resolve('../src/ui/reading.js'), 'utf8');
  const context = { window: {} };
  vm.runInNewContext(source, context);
  return context.window.ReadingContent;
}

test('Chinese reading styles include restrained typography polish without changing layout controls', async () => {
  const content = await readingContent();
  const css = content.styles({ fontFamily: 'system', fontSize: 20, lineHeight: 1.9, width: 760, paragraphGap: 1.2, background: 'white', tint: .6 });
  assert.match(css, /text-indent:2em/);
  assert.match(css, /text-align:justify/);
  assert.match(css, /text-justify:inter-ideograph/);
  assert.match(css, /hanging-punctuation:first last/);
  assert.match(css, /font-kerning:normal/);
  assert.match(css, /orphans:3;widows:3/);
  assert.match(css, /p:has\(> img\)/);
});
