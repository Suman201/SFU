const fs = require('node:fs');
const path = require('node:path');

const replacements = [
  path.join(__dirname, '..', 'node_modules', 'playwright', 'lib', 'transform', 'esmLoader.js'),
  path.join(__dirname, '..', 'node_modules', 'playwright', 'lib', 'common', 'index.js')
];

const before = 'context.conditions?.includes("import")';
const after = 'conditionIncludes(context.conditions, "import")';
const helper = `function conditionIncludes(conditions, value) {
  if (!conditions) return false;
  if (typeof conditions.includes === "function") return conditions.includes(value);
  if (typeof conditions.has === "function") return conditions.has(value);
  return Array.from(conditions).includes(value);
}
`;

let matchedFiles = 0;
let patchableFiles = 0;

for (const file of replacements) {
  if (!fs.existsSync(file)) {
    continue;
  }
  matchedFiles += 1;
  let source = fs.readFileSync(file, 'utf8');
  const hadBefore = source.includes(before);
  const alreadyPatched = source.includes(after) && source.includes('function conditionIncludes(conditions, value)');
  if (hadBefore || alreadyPatched) {
    patchableFiles += 1;
  }
  if (source.includes(before)) {
    source = source.replaceAll(before, after);
  }
  if (!source.includes('function conditionIncludes(conditions, value)')) {
    source = `${source}\n${helper}`;
  }
  fs.writeFileSync(file, source);
}

if (matchedFiles === 0) {
  throw new Error('Playwright patch targets were not found. Verify the installed Playwright layout before running browser tests.');
}

if (patchableFiles === 0) {
  throw new Error('Playwright patch targets were found, but none matched the expected loader shape. Update scripts/patch-playwright-loader.cjs for the installed Playwright version.');
}
