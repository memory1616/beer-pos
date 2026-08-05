#!/usr/bin/env node
/**
 * scripts/bump-version.js
 *
 * Đồng bộ version giữa package.json và public/version.json.
 *
 * Cách dùng:
 *   node scripts/bump-version.js          # auto: lấy version từ package.json
 *   node scripts/bump-version.js 2.2.0    # set version mới
 *
 * Build suffix tự động = YYYYMMDD[a-z] (giống semantic của public/version.json).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const pkgPath = path.join(ROOT, 'package.json');
const verPath = path.join(ROOT, 'public', 'version.json');

function nextBuildSuffix(date = new Date()) {
  const ymd = date.toISOString().slice(0, 10).replace(/-/g, '');
  const letter = String.fromCharCode('a'.charCodeAt(0) + (date.getDate() % 26));
  return `${ymd}${letter}`;
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const ver = JSON.parse(fs.readFileSync(verPath, 'utf8'));

  const newVersion = process.argv[2] || pkg.version;
  const today = new Date().toISOString().slice(0, 10);
  const build = nextBuildSuffix();

  if (newVersion === ver.version && ver.build === build) {
    console.log(`Already at ${newVersion} build ${build}`);
    return;
  }

  pkg.version = newVersion;
  ver.version = newVersion;
  ver.build = build;
  ver.date = today;
  ver.changelog = ver.changelog || [];
  ver.changelog.unshift(`bump version ${newVersion} build ${build}`);

  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  fs.writeFileSync(verPath, JSON.stringify(ver, null, 2) + '\n');

  console.log(`Bumped to ${newVersion} (build ${build}, ${today})`);
  console.log(`  - ${path.relative(ROOT, pkgPath)}`);
  console.log(`  - ${path.relative(ROOT, verPath)}`);
}

main();
