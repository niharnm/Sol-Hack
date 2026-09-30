import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const directory = mkdtempSync(join(tmpdir(), 'motto-cli-'));
const dataDir = join(directory, 'data');

after(() => rmSync(directory, { recursive: true, force: true }));

function run(args) {
  return execFileSync(process.execPath, ['scripts/motto.mjs', ...args], {
    cwd: root,
    env: { ...process.env, CI: '1' },
    encoding: 'utf8',
  });
}

test('setup creates credentials once and never prints the token', () => {
  const first = JSON.parse(run(['setup', '--data-dir', dataDir, '--json']));
  const token = readFileSync(first.token_file, 'utf8').trim();
  assert.equal(first.generated, true);
  assert.equal(first.opened, false);
  assert.equal(JSON.stringify(first).includes(token), false);
  assert.equal(statSync(first.token_file).mode & 0o777, 0o600);

  const second = JSON.parse(run(['setup', '--data-dir', dataDir, '--json']));
  assert.equal(second.generated, false);
  assert.equal(readFileSync(first.token_file, 'utf8').trim(), token);
});

test('pair emits a fragment URL and headless mode does not open a browser', () => {
  const result = JSON.parse(run(['pair', '--data-dir', dataDir, '--url', 'https://motto.example', '--open', '--json']));
  const url = new URL(result.pairing_url);
  assert.equal(url.origin, 'https://motto.example');
  assert.match(url.hash, /^#pair=[A-Za-z0-9_-]{43}$/);
  assert.equal(result.opened, false);
  assert.equal(result.pairing_url.includes(readFileSync(result.token_file, 'utf8').trim()), false);
});

test('package exposes the same CLI entry point', () => {
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.bin.motto, 'scripts/motto.mjs');
});
