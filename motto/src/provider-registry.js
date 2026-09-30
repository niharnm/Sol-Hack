import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import bs58 from 'bs58';
import { toBaseUnits } from './settlement.js';

const NETWORKS = new Set(['localnet', 'devnet', 'mainnet', 'mainnet-beta']);
const ID = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const ED25519_KEY = /^[0-9a-f]{64}$/i;

export class ProviderRegistryError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'ProviderRegistryError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProviderRegistryError(code, message);
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`invalid_${name}`, `${name} must be an object`);
  return value;
}

function exactKeys(value, allowed, name) {
  const extra = Object.keys(value).filter(key => !allowed.includes(key));
  if (extra.length) fail(`invalid_${name}`, `${name} has unknown field "${extra[0]}"`);
}

function text(value, name, max) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(`invalid_${name}`, `${name} must be 1 to ${max} printable characters without surrounding whitespace`);
  }
  return value;
}

function id(value, name) {
  if (typeof value !== 'string' || !ID.test(value)) fail(`invalid_${name}`, `${name} must match ${ID}`);
  return value;
}

function publicKey(value, name) {
  if (typeof value !== 'string' || !ED25519_KEY.test(value)) fail(`invalid_${name}`, `${name} must be a 32-byte Ed25519 public key in hex`);
  return value.toLowerCase();
}

function payoutAddress(value) {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) fail('invalid_payout_address', 'payout_address must be a Solana address');
  let decoded;
  try {
    decoded = bs58.decode(value);
  } catch {
    fail('invalid_payout_address', 'payout_address must be a Solana address');
  }
  if (decoded.length !== 32) fail('invalid_payout_address', 'payout_address must decode to 32 bytes');
  return value;
}

function loopback(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1';
}

function privateIpv4(host) {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

function fulfillmentUrl(value, allowLocal) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('invalid_fulfillment_url', 'fulfillment_url must be an absolute URL');
  }
  const isLoopback = loopback(url.hostname);
  if (url.protocol !== 'https:' && !(allowLocal && isLoopback && url.protocol === 'http:')) {
    fail('invalid_fulfillment_url', 'fulfillment_url must use HTTPS; loopback HTTP requires allowLocal');
  }
  if (isLoopback && !allowLocal) fail('invalid_fulfillment_url', 'loopback fulfillment_url requires allowLocal');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.username || url.password || url.search || url.hash || host.endsWith('.local') || host.endsWith('.internal')) {
    fail('invalid_fulfillment_url', 'fulfillment_url must not contain credentials, query, fragment, or a private hostname');
  }
  if (isIP(host) === 4 && privateIpv4(host) && !isLoopback) fail('invalid_fulfillment_url', 'fulfillment_url must not use a private IPv4 address');
  if (isIP(host) === 6 && !isLoopback) fail('invalid_fulfillment_url', 'literal IPv6 fulfillment_url is not allowed');
  return url.toString().replace(/\/$/, '');
}

function usd(value, name, { positive = false } = {}) {
  let amount;
  try {
    amount = toBaseUnits(value);
  } catch {
    fail(`invalid_${name}`, `${name} must be a non-negative USD string with at most six decimals`);
  }
  if (positive && amount === 0n) fail(`invalid_${name}`, `${name} must be greater than zero`);
  return String(value);
}

function unique(values, name) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) fail(`duplicate_${name}`, `${name} "${value}" is duplicated`);
    seen.add(value);
  }
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function validateConfig(input, { allowLocal = false } = {}) {
  const config = object(input, 'registry');
  exactKeys(config, ['version', 'providers'], 'registry');
  if (config.version !== 1) fail('unsupported_registry_version', 'registry version must be 1');
  if (!Array.isArray(config.providers) || config.providers.length === 0) fail('invalid_providers', 'providers must be a non-empty array');
  const providerIds = config.providers.map((rawProvider, providerIndex) => id(object(rawProvider, `provider_${providerIndex}`).id, 'provider_id'));
  unique(providerIds, 'provider_id');

  const quoteKeys = new Set();
  const attestorKeys = new Set();
  const providers = config.providers.map((rawProvider, providerIndex) => {
    const provider = object(rawProvider, `provider_${providerIndex}`);
    exactKeys(provider, ['id', 'name', 'payout_address', 'quote_public_key', 'fulfillment_url', 'attestors', 'offers'], `provider_${providerIndex}`);
    const providerId = providerIds[providerIndex];
    const quoteKey = publicKey(provider.quote_public_key, 'quote_public_key');
    if (quoteKeys.has(quoteKey)) fail('duplicate_quote_public_key', `quote key is reused by provider "${providerId}"`);
    quoteKeys.add(quoteKey);

    if (!Array.isArray(provider.attestors) || provider.attestors.length === 0) fail('invalid_attestors', `${providerId}.attestors must be a non-empty array`);
    const attestors = provider.attestors.map((rawAttestor, attestorIndex) => {
      const attestor = object(rawAttestor, `${providerId}_attestor_${attestorIndex}`);
      exactKeys(attestor, ['id', 'public_key'], `${providerId}_attestor_${attestorIndex}`);
      const key = publicKey(attestor.public_key, 'attestor_public_key');
      attestorKeys.add(key);
      return { id: id(attestor.id, 'attestor_id'), public_key: key };
    });
    unique(attestors.map(attestor => attestor.id), `${providerId}_attestor_id`);

    if (!Array.isArray(provider.offers) || provider.offers.length === 0) fail('invalid_offers', `${providerId}.offers must be a non-empty array`);
    const offers = provider.offers.map((rawOffer, offerIndex) => {
      const offer = object(rawOffer, `${providerId}_offer_${offerIndex}`);
      exactKeys(offer, ['id', 'summary', 'network', 'max_hold_usd', 'fulfillment_timeout_seconds', 'attestor_ids'], `${providerId}_offer_${offerIndex}`);
      if (!NETWORKS.has(offer.network)) fail('invalid_network', `${providerId}.${offer.id ?? offerIndex}.network is unsupported`);
      if (!Number.isInteger(offer.fulfillment_timeout_seconds) || offer.fulfillment_timeout_seconds < 1 || offer.fulfillment_timeout_seconds > 180) {
        fail('invalid_fulfillment_timeout', 'fulfillment_timeout_seconds must be an integer from 1 to 180');
      }
      if (!Array.isArray(offer.attestor_ids) || offer.attestor_ids.length === 0) fail('invalid_attestor_ids', 'attestor_ids must be a non-empty array');
      const attestorIds = offer.attestor_ids.map(value => id(value, 'attestor_id'));
      unique(attestorIds, `${providerId}_${offer.id ?? offerIndex}_attestor_id`);
      for (const attestorId of attestorIds) {
        if (!attestors.some(attestor => attestor.id === attestorId)) fail('unknown_attestor', `${providerId}.${offer.id ?? offerIndex} references unknown attestor "${attestorId}"`);
      }
      return {
        id: id(offer.id, 'offer_id'),
        summary: text(offer.summary, 'offer_summary', 63),
        network: offer.network,
        max_hold_usd: usd(offer.max_hold_usd, 'max_hold_usd', { positive: true }),
        fulfillment_timeout_seconds: offer.fulfillment_timeout_seconds,
        attestor_ids: attestorIds,
      };
    });
    unique(offers.map(offer => offer.id), `${providerId}_offer_id`);

    return {
      id: providerId,
      name: text(provider.name, 'provider_name', 120),
      payout_address: payoutAddress(provider.payout_address),
      quote_public_key: quoteKey,
      fulfillment_url: fulfillmentUrl(provider.fulfillment_url, allowLocal),
      attestors,
      offers,
    };
  });
  for (const key of quoteKeys) if (attestorKeys.has(key)) fail('signer_roles_not_distinct', 'quote and attestation keys must be distinct');
  return freeze({ version: 1, providers });
}

export class ProviderRegistry {
  constructor(config, options) {
    this.config = validateConfig(config, options);
  }

  getProvider(providerId) {
    const provider = this.config.providers.find(candidate => candidate.id === providerId);
    if (!provider) fail('provider_not_found', `provider "${providerId}" is not registered`);
    return provider;
  }

  getOffer(providerId, offerId) {
    const provider = this.getProvider(providerId);
    const offer = provider.offers.find(candidate => candidate.id === offerId);
    if (!offer) fail('offer_not_found', `offer "${offerId}" is not registered for provider "${providerId}"`);
    return offer;
  }

  getAttestor(providerId, attestorId) {
    const provider = this.getProvider(providerId);
    const attestor = provider.attestors.find(candidate => candidate.id === attestorId);
    if (!attestor) fail('attestor_not_found', `attestor "${attestorId}" is not registered for provider "${providerId}"`);
    return attestor;
  }

  publicProviders() {
    return this.config.providers.map(provider => ({
      id: provider.id,
      name: provider.name,
      payout_address: provider.payout_address,
      quote_public_key: provider.quote_public_key,
      attestors: provider.attestors,
      offers: provider.offers,
    }));
  }
}

export function createProviderRegistry(config, options) {
  return new ProviderRegistry(config, options);
}

export function loadProviderRegistry(path, options) {
  let config;
  try {
    config = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) fail('invalid_registry_json', `invalid provider registry JSON: ${error.message}`);
    throw error;
  }
  return createProviderRegistry(config, options);
}
