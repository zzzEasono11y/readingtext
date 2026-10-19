const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const root = path.resolve(__dirname, '..');

test('Public source documents its license, bilingual summary and matching Windows version', () => {
  const metadata = require('../package.json');
  const lock = require('../package-lock.json');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.equal(metadata.license, 'MIT');
  assert.ok(metadata.build.files.includes('LICENSE'));
  assert.match(fs.readFileSync(path.join(root, 'LICENSE'), 'utf8'), /Permission is hereby granted, free of charge/);
  assert.equal(lock.version, metadata.version);
  assert.equal(lock.packages[''].version, metadata.version);
  assert.ok(readme.includes('ReadingText is a local EPUB reader for Windows'));
  assert.ok(readme.includes(`ReadingText-${metadata.version}-Windows.exe`));
});

test('Release workflow verifies the app before publishing and preserves existing releases', () => {
  const workflow = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/windows-release.yml'), 'utf8'));
  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert.ok(workflow.on.push.paths.includes('package.json'));
  assert.ok(Object.hasOwn(workflow.on, 'workflow_dispatch'));
  const job = workflow.jobs.release;
  assert.equal(job['runs-on'], 'windows-latest');
  assert.ok(job.steps.filter(step => step.uses).every(step => /@[a-f\d]{40}$/.test(step.uses)));
  const commands = job.steps.filter(step => step.run).map(step => step.run);
  for (const command of ['npm test', 'npm run check', 'npm run build', 'node scripts/smoke-portable.js']) {
    assert.ok(commands.indexOf(command) >= 0 && commands.indexOf(command) < commands.length - 1);
  }
  const publish = commands.at(-1);
  assert.match(publish, /gh release view/);
  assert.match(publish, /already exists/);
  assert.match(publish, /Get-FileHash[\s\S]*SHA256/);
  assert.match(publish, /--target \$env:GITHUB_SHA/);
  assert.doesNotMatch(publish, /--clobber|--force/);
});
