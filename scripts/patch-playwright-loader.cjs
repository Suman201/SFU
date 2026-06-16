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

for (const file of replacements) {
  if (!fs.existsSync(file)) {
    continue;
  }
  let source = fs.readFileSync(file, 'utf8');
  if (source.includes(before)) {
    source = source.replaceAll(before, after);
  }
  if (!source.includes('function conditionIncludes(conditions, value)')) {
    source = `${source}\n${helper}`;
  }
  fs.writeFileSync(file, source);
}
