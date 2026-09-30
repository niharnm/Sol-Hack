import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const TOKEN = /^[\x21-\x7e]{24,512}$/;

export class ProviderClientError extends Error {
  constructor(status, code, message = code) {
    super(message);
    this.name = 'ProviderClientError';
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) {
  throw new ProviderClientError(status, code, message);
}

function loopback(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1';
}

function privateIpv4(address) {
  const [a, b] = address.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19 || b === 51))
    || (a === 203 && b === 0) || a >= 224;
}

function privateIp(address, family) {
  if (family === 4 || isIP(address) === 4) return privateIpv4(address);
  const value = address.toLowerCase();
  if (value === '::' || value === '::1' || value.startsWith('2001:db8:') || value.startsWith('fc') || value.startsWith('fd') || /^fe[89ab]/.test(value) || value.startsWith('ff')) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  return mapped ? privateIpv4(mapped[1]) : false;
}

async function readBounded(response, limit = MAX_RESPONSE_BYTES) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > limit) fail(502, 'provider_response_too_large');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      fail(502, 'provider_response_too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

function responseObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(502, 'invalid_provider_response');
  const keys = Object.keys(value);
  if (!keys.includes('artifact') || !keys.includes('signed_attestation') || keys.some(key => !['artifact', 'signed_attestation'].includes(key))) {
    fail(502, 'invalid_provider_response');
  }
  return value;
}

function defaultTokenFor(providerId) {
  const key = `MOTTO_PROVIDER_TOKEN_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  return process.env[key];
}

export class ProviderClient {
  constructor({ registry, allowLocal = false, fetcher = fetch, resolver = lookup, tokenFor = defaultTokenFor, responseLimit = MAX_RESPONSE_BYTES } = {}) {
    if (!registry || typeof fetcher !== 'function' || typeof resolver !== 'function' || typeof tokenFor !== 'function') fail(500, 'invalid_provider_client');
    if (!Number.isInteger(responseLimit) || responseLimit < 1024 || responseLimit > MAX_RESPONSE_BYTES) fail(500, 'invalid_provider_response_limit');
    this.registry = registry;
    this.allowLocal = allowLocal;
    this.fetcher = fetcher;
    this.resolver = resolver;
    this.tokenFor = tokenFor;
    this.responseLimit = responseLimit;
  }

  async assertAddressAllowed(url) {
    if (loopback(url.hostname)) {
      if (!this.allowLocal) fail(502, 'provider_address_blocked');
      return;
    }
    let addresses;
    try {
      addresses = await this.resolver(url.hostname, { all: true, verbatim: true });
    } catch {
      fail(502, 'provider_dns_failed');
    }
    if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some(entry => privateIp(entry.address, entry.family))) {
      fail(502, 'provider_address_blocked');
    }
  }

  async fulfill(order) {
    const provider = this.registry.getProvider(order.provider_id);
    const url = new URL(provider.fulfillment_url);
    await this.assertAddressAllowed(url);
    const token = this.tokenFor(provider.id);
    if (typeof token !== 'string' || !TOKEN.test(token)) fail(503, 'provider_auth_not_configured');
    const payload = {
      version: 1,
      order: {
        id: order.id,
        hold_id: order.hold_id,
        network: order.network,
        payout_address: order.payout_address,
        request_sha256: order.request_sha256,
        fulfillment_deadline_ms: order.fulfillment_deadline_ms,
      },
      signed_quote: order.signed_quote,
      request: order.request,
    };
    let response;
    try {
      response = await this.fetcher(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'idempotency-key': order.id,
        },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: AbortSignal.timeout(Math.max(1, order.fulfillment_deadline_ms - Date.now())),
      });
    } catch (error) {
      fail(502, 'provider_unavailable', String(error?.message ?? error));
    }
    if (!response.ok) fail(502, 'provider_rejected', `provider returned HTTP ${response.status}`);
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) fail(502, 'invalid_provider_content_type');
    const raw = await readBounded(response, this.responseLimit);
    try {
      return responseObject(JSON.parse(raw));
    } catch (error) {
      if (error instanceof ProviderClientError) throw error;
      fail(502, 'invalid_provider_response');
    }
  }
}

export const providerClientInternals = { privateIp, readBounded, responseObject };
