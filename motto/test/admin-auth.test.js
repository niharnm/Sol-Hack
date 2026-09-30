import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdminAuth, sessionTokenFromCookie } from '../src/admin-auth.js';

const directories = [];
function scratch() {
  const directory = mkdtempSync(join(tmpdir(), 'motto-auth-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('first run creates a private admin token without storing it in the auth record', () => {
  const dataDir = scratch();
  const auth = createAdminAuth({ dataDir });
  assert.equal(auth.generated, true);
  const token = readFileSync(auth.paths.tokenFile, 'utf8').trim();
  const store = readFileSync(auth.paths.authFile, 'utf8');
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(store.includes(token), false);
  assert.equal(statSync(auth.paths.directory).mode & 0o777, 0o700);
  assert.equal(statSync(auth.paths.tokenFile).mode & 0o777, 0o600);
  assert.equal(statSync(auth.paths.authFile).mode & 0o777, 0o600);
  assert.equal(auth.verifyBearer(token), true);
});

test('initialization is idempotent and keeps the original token', () => {
  const dataDir = scratch();
  const first = createAdminAuth({ dataDir });
  const token = readFileSync(first.paths.tokenFile, 'utf8');
  const second = createAdminAuth({ dataDir });
  assert.equal(second.generated, false);
  assert.equal(readFileSync(second.paths.tokenFile, 'utf8'), token);
});

test('pairing codes are single-use and sessions can be revoked', () => {
  const dataDir = scratch();
  let currentTime = 1_000_000;
  const auth = createAdminAuth({ dataDir, now: () => currentTime });
  const pairing = auth.createPairing({ ttlMs: 10_000 });
  const session = auth.consumePairing(pairing.code, { sessionTtlMs: 60_000 });
  assert.deepEqual(auth.verifySession(session.token)?.scopes, ['records:read', 'events:read']);
  assert.throws(() => auth.consumePairing(pairing.code), { code: 'invalid_or_expired_pairing_code' });
  assert.equal(auth.revokeSession(session.token), true);
  assert.equal(auth.verifySession(session.token), undefined);

  const expiring = auth.createPairing({ ttlMs: 1_000 });
  currentTime += 1_001;
  assert.throws(() => auth.consumePairing(expiring.code), { code: 'invalid_or_expired_pairing_code' });
});

test('environment tokens remain accepted without being written to disk', () => {
  const dataDir = scratch();
  const token = 'environment-admin-token-1234567890';
  const auth = createAdminAuth({ dataDir, env: { MOTTO_ADMIN_TOKEN: token } });
  assert.equal(auth.verifyBearer(token), true);
  assert.equal(auth.status().token_file, null);
  assert.equal(readFileSync(auth.paths.authFile, 'utf8').includes(token), false);
});

test('session cookies accept local and secure names', () => {
  assert.equal(sessionTokenFromCookie('a=1; motto_admin_session=local-token'), 'local-token');
  assert.equal(sessionTokenFromCookie('a=1; __Host-motto_admin=secure-token'), 'secure-token');
});
