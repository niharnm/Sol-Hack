import {
  closeSync,
  constants,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';

const STORE_VERSION = 1;
const ADMIN_SCOPES = ['records:read', 'events:read'];
const DEFAULT_PAIRING_TTL_MS = 5 * 60_000;
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60_000;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sameDigest(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && a.length === 32 && timingSafeEqual(a, b);
}

function secret() {
  return randomBytes(32).toString('base64url');
}

function assertSecret(value, code = 'invalid_admin_token') {
  if (typeof value !== 'string' || value.trim() !== value || value.length < 16 || value.length > 512) fail(code);
  return value;
}

function assertSafePath(path, type) {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) fail(`unsafe_${type}_symlink`);
  if (type === 'directory' && !entry.isDirectory()) fail('unsafe_auth_directory');
  if (type === 'file' && !entry.isFile()) fail('unsafe_auth_file');
  if (typeof process.getuid === 'function' && statSync(path).uid !== process.getuid()) fail(`unsafe_${type}_owner`);
  if (type === 'file' && (entry.mode & 0o077) !== 0) fail('unsafe_auth_file_permissions');
}

function ensureSecretDirectory(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const directory = join(dataDir, 'secrets');
  if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  assertSafePath(directory, 'directory');
  chmodSync(directory, 0o700);
  return directory;
}

function writeExclusive(path, value) {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(path, flags, 0o600);
  try {
    writeFileSync(fd, value, { encoding: 'utf8' });
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
}

function parseStore(path) {
  assertSafePath(path, 'file');
  let store;
  try {
    store = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail('invalid_admin_auth_store');
  }
  if (
    store?.version !== STORE_VERSION
    || !Array.isArray(store.credentials)
    || !Array.isArray(store.pairings)
    || !Array.isArray(store.sessions)
  ) fail('invalid_admin_auth_store');
  return store;
}

function prune(store, now) {
  store.pairings = store.pairings.filter(entry => entry.expires_at_ms > now && !entry.consumed_at_ms);
  store.sessions = store.sessions.filter(entry => entry.expires_at_ms > now && !entry.revoked_at_ms);
  return store;
}

function saveStore(path, store) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeExclusive(temporary, `${JSON.stringify(store, null, 2)}\n`);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function withLock(paths, update) {
  let lock;
  try {
    lock = openSync(paths.lockFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') fail('admin_auth_store_busy');
    throw error;
  }
  try {
    const store = parseStore(paths.authFile);
    const result = update(store);
    saveStore(paths.authFile, store);
    return result;
  } finally {
    closeSync(lock);
    rmSync(paths.lockFile, { force: true });
  }
}

function readTokenFile(path) {
  assertSafePath(path, 'file');
  return assertSecret(readFileSync(path, 'utf8').trim());
}

export function adminAuthPaths(dataDir = 'data') {
  const directory = join(dataDir, 'secrets');
  return {
    directory,
    authFile: join(directory, 'admin-auth.json'),
    tokenFile: join(directory, 'admin-token'),
    lockFile: join(directory, 'admin-auth.lock'),
  };
}

export function createAdminAuth({ dataDir = 'data', env = process.env, now = Date.now } = {}) {
  const paths = adminAuthPaths(dataDir);
  ensureSecretDirectory(dataDir);

  if (env.MOTTO_ADMIN_TOKEN && env.MOTTO_ADMIN_TOKEN_FILE) fail('conflicting_admin_token_sources');
  const configuredToken = env.MOTTO_ADMIN_TOKEN_FILE
    ? readTokenFile(env.MOTTO_ADMIN_TOKEN_FILE)
    : env.MOTTO_ADMIN_TOKEN ? assertSecret(env.MOTTO_ADMIN_TOKEN) : undefined;

  let generated = false;
  if (!existsSync(paths.authFile)) {
    let initialToken = configuredToken;
    if (!initialToken && existsSync(paths.tokenFile)) initialToken = readTokenFile(paths.tokenFile);
    if (!initialToken) {
      initialToken = secret();
      try {
        writeExclusive(paths.tokenFile, `${initialToken}\n`);
        generated = true;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        initialToken = readTokenFile(paths.tokenFile);
      }
    }
    const createdAt = now();
    const store = {
      version: STORE_VERSION,
      credentials: [{ id: `adm_${randomUUID()}`, digest: digest(initialToken), scopes: ADMIN_SCOPES, created_at_ms: createdAt }],
      pairings: [],
      sessions: [],
    };
    try {
      writeExclusive(paths.authFile, `${JSON.stringify(store, null, 2)}\n`);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      generated = false;
    }
  }
  parseStore(paths.authFile);

  function read() {
    return prune(parseStore(paths.authFile), now());
  }

  function verifyBearer(token) {
    if (typeof token !== 'string') return false;
    if (configuredToken && sameDigest(digest(token), digest(configuredToken))) return true;
    const candidate = digest(token);
    return read().credentials.some(entry => !entry.revoked_at_ms && sameDigest(candidate, entry.digest));
  }

  function createPairing({ ttlMs = DEFAULT_PAIRING_TTL_MS } = {}) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 30 * 60_000) fail('invalid_pairing_ttl');
    const code = secret();
    const createdAt = now();
    const pairing = withLock(paths, store => {
      prune(store, createdAt);
      const entry = {
        id: `pair_${randomUUID()}`,
        digest: digest(code),
        scopes: ADMIN_SCOPES,
        created_at_ms: createdAt,
        expires_at_ms: createdAt + ttlMs,
      };
      store.pairings.push(entry);
      return entry;
    });
    return { code, id: pairing.id, expires_at_ms: pairing.expires_at_ms };
  }

  function consumePairing(code, { sessionTtlMs = DEFAULT_SESSION_TTL_MS } = {}) {
    assertSecret(code, 'invalid_pairing_code');
    if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 60_000 || sessionTtlMs > 24 * 60 * 60_000) fail('invalid_session_ttl');
    const sessionToken = secret();
    const usedAt = now();
    const session = withLock(paths, store => {
      prune(store, usedAt);
      const pairing = store.pairings.find(entry => sameDigest(digest(code), entry.digest));
      if (!pairing || pairing.expires_at_ms <= usedAt || pairing.consumed_at_ms) fail('invalid_or_expired_pairing_code');
      pairing.consumed_at_ms = usedAt;
      const entry = {
        id: `ses_${randomUUID()}`,
        digest: digest(sessionToken),
        scopes: pairing.scopes,
        created_at_ms: usedAt,
        expires_at_ms: usedAt + sessionTtlMs,
      };
      store.sessions.push(entry);
      return entry;
    });
    return { token: sessionToken, id: session.id, expires_at_ms: session.expires_at_ms, scopes: session.scopes };
  }

  function verifySession(token) {
    if (typeof token !== 'string') return undefined;
    const candidate = digest(token);
    const entry = read().sessions.find(session => sameDigest(candidate, session.digest));
    return entry ? { id: entry.id, expires_at_ms: entry.expires_at_ms, scopes: entry.scopes } : undefined;
  }

  function revokeSession(token) {
    if (typeof token !== 'string') return false;
    const revokedAt = now();
    return withLock(paths, store => {
      const entry = store.sessions.find(session => sameDigest(digest(token), session.digest) && !session.revoked_at_ms);
      if (!entry) return false;
      entry.revoked_at_ms = revokedAt;
      return true;
    });
  }

  return {
    paths,
    generated,
    verifyBearer,
    createPairing,
    consumePairing,
    verifySession,
    revokeSession,
    status() {
      const store = read();
      return {
        initialized: true,
        credential_count: store.credentials.filter(entry => !entry.revoked_at_ms).length,
        active_pairings: store.pairings.length,
        active_sessions: store.sessions.length,
        token_file: existsSync(paths.tokenFile) ? paths.tokenFile : null,
      };
    },
  };
}

export function sessionTokenFromCookie(header = '') {
  const cookies = Object.fromEntries(
    String(header).split(';').map(part => part.trim().split(/=(.*)/s).slice(0, 2)).filter(([name, value]) => name && value),
  );
  return cookies['__Host-motto_admin'] ?? cookies.motto_admin_session;
}
