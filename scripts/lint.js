'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function filesUnder(relativeDirectory, extension) {
  const directory = path.join(root, relativeDirectory);
  if (!fs.existsSync(directory)) return [];
  const result = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.name.endsWith(extension)) result.push(absolute);
    }
  };
  visit(directory);
  return result;
}

const javascriptFiles = [
  ...filesUnder('src', '.js'),
  ...filesUnder('test', '.js'),
  ...filesUnder('scripts', '.js'),
];
for (const file of javascriptFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
}

for (const file of [
  'package.json',
  'package.nls.json',
  'package.nls.zh-cn.json',
  'l10n/bundle.l10n.json',
  'l10n/bundle.l10n.zh-cn.json',
  'test/extension-host/fixture/.vscode/settings.json',
]) {
  JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
}

console.log(`Static checks passed for ${javascriptFiles.length} JavaScript files and 6 JSON files.`);
