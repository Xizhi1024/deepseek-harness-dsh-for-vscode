'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const selfFile = path.resolve(__filename);
const allowCommentMarkers = ['// allow-secret-scan', '/* allow-secret-scan */'];

const EXCLUDED_DIRS = new Set(['.git', '.slim', 'node_modules', '.vscode-test']);
const TEXT_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsonc',
  '.md',
  '.mjs',
  '.mmd',
  '.ps1',
  '.sh',
  '.svg',
  '.toml',
  '.ts',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);
const TEXT_BASENAMES = new Set(['.editorconfig', '.gitignore', '.npmrc', '.nvmrc', '.vscodeignore', 'LICENSE']);

// Each pattern matches one hardcoded-secret shape. Example and test-fixture
// lines can be released with an explicit `// allow-secret-scan` comment; the
// scanner skips any line carrying that marker.
const PATTERNS = [
  {
    type: 'DSH_VSCODE_BRIDGE_TOKEN hardcoded literal',
    re: /\bDSH_VSCODE_BRIDGE_TOKEN["']?\s*[:=]\s*(['"`])([^'"`\n$]*)\1/,
  },
  {
    type: 'DSH_VSCODE_OPEN_TOKEN hardcoded literal',
    re: /\bDSH_VSCODE_OPEN_TOKEN["']?\s*[:=]\s*(['"`])([^'"`\n$]*)\1/,
  },
  {
    type: 'Authorization: Bearer hardcoded credential',
    re: /\bAuthorization["']?\s*:\s*["']?\s*Bearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  },
  {
    type: 'OpenAI-style API key (sk-...)',
    re: /\bsk-[A-Za-z0-9]{20,}/,
  },
  {
    type: 'AWS access key (AKIA...)',
    re: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    type: 'Private key block',
    re: /\bBEGIN(?: [A-Z0-9]+)* PRIVATE KEY\b/,
  },
  {
    type: 'Password literal',
    re: /\bpassword\s*[:=]\s*['"][^'"]+['"]/i,
  },
];

function isScannable(filePath) {
  const basename = path.basename(filePath);
  if (TEXT_BASENAMES.has(basename)) return true;
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function collectFiles(directory) {
  const result = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) visit(absolute);
      } else if (entry.isFile() && absolute !== selfFile && isScannable(absolute)) {
        result.push(absolute);
      }
    }
  };
  visit(directory);
  return result;
}

function hasAllowComment(line) {
  return allowCommentMarkers.some((marker) => line.includes(marker));
}

function scanLine(file, lineNumber, line) {
  if (hasAllowComment(line)) return [];
  const hits = [];
  for (const { type, re } of PATTERNS) {
    if (re.test(line)) hits.push(type);
  }
  return hits;
}

const files = collectFiles(root);
const hits = [];
let scannedLines = 0;

for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split(/\r?\n/);
  scannedLines += lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    for (const type of scanLine(file, index + 1, lines[index])) {
      hits.push(`${path.relative(root, file)}:${index + 1}: ${type}`);
    }
  }
}

if (hits.length > 0) {
  process.stderr.write(`Secret scan failed with ${hits.length} hit(s):\n`);
  for (const hit of hits) process.stderr.write(`${hit}\n`);
  process.exit(1);
}

console.log(`Secret scan passed for ${files.length} files (${scannedLines} lines).`);
