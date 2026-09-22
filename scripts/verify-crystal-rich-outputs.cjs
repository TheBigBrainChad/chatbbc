// Source-level Crystal rich-output contract check.
// This does not launch ChatGPT and does not prove signed-in provider behavior.
// Run: node scripts/verify-crystal-rich-outputs.cjs
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const background = read('extension/background.js');
assert.match(background, /generated-assets\/original\/chunk/);
assert.match(background, /generated-assets\/original\/finish/);
assert.doesNotMatch(background, /generatedAssetDownloads[^\n]*sig=/);
assert.match(background, /processGeneratedAssetOriginals/);

const surfaces = read('src/main/mcp/surfaces.ts');
assert.match(surfaces, /generated_assets/);

for (const locale of ['src/renderer/locales/es.json', 'src/renderer/locales/zh-CN.json', 'src/renderer/locales/zh-TW.json']) {
  const catalog = JSON.parse(read(locale));
  for (const key of ['Download original', 'Download all originals', 'Saved to browser Downloads', 'Download outcome unconfirmed']) {
    assert.equal(typeof catalog[key], 'string', `${locale} missing ${key}`);
  }
}

const content = read('extension/content.js');
assert.match(content, /clf-generated-asset-source/);
assert.match(content, /native_image/);

console.log('crystal rich-output source contracts ok');
console.log('signed-in ChatGPT download, choice, and save acceptance: not run');
