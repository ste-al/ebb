// Sanity checks for the extension folder: every file the manifest, the HTML pages and the
// scripts refer to exists, every script parses, and the versions agree.
// Usage: npm run check

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const problems = [];
const fail = (msg) => problems.push(msg);
const exists = (rel, from = EXT) => fs.existsSync(path.join(from, rel));

const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) fail(`manifest version ${manifest.version} differs from package.json ${pkg.version}`);
if (manifest.manifest_version !== 3) fail('manifest_version must be 3');

const referenced = [
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
  manifest.side_panel?.default_path,
  manifest.background?.service_worker,
  ...(manifest.content_scripts || []).flatMap((c) => [...(c.js || []), ...(c.css || [])]),
].filter(Boolean);
for (const rel of referenced) if (!exists(rel)) fail(`manifest refers to missing file ${rel}`);

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
const files = walk(EXT);

for (const file of files.filter((f) => f.endsWith('.js'))) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    fail(`${path.relative(ROOT, file)} does not parse:\n${err.stderr}`);
  }
  const source = fs.readFileSync(file, 'utf8');
  for (const [, spec] of source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) {
    if (spec.startsWith('.') && !fs.existsSync(path.resolve(path.dirname(file), spec))) fail(`${path.relative(ROOT, file)} imports missing ${spec}`);
  }
  for (const [, rel] of source.matchAll(/(?:getURL|files:\s*\[)\s*\(?\s*['"]\/?([\w./-]+\.(?:html|js))['"]/g)) {
    if (!exists(rel)) fail(`${path.relative(ROOT, file)} refers to missing ${rel}`);
  }
}

for (const file of files.filter((f) => f.endsWith('.html'))) {
  const source = fs.readFileSync(file, 'utf8');
  for (const [, ref] of source.matchAll(/(?:src|href)="([^"#:]+)"/g)) {
    if (!fs.existsSync(path.resolve(path.dirname(file), ref))) fail(`${path.relative(ROOT, file)} refers to missing ${ref}`);
  }
  if (/<script(?![^>]*\bsrc=)[^>]*>/.test(source)) fail(`${path.relative(ROOT, file)} has an inline script, which extension pages block`);
}

if (problems.length) {
  console.error(problems.map((p) => `✗ ${p}`).join('\n'));
  process.exit(1);
}
console.log(`✓ ${files.length} files checked: references resolve, scripts parse, versions agree (${manifest.version}).`);
