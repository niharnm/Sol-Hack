import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bs58 from 'bs58';
import { createProviderRegistry, loadProviderRegistry, ProviderRegistryError } from '../src/provider-registry.js';

const dir = mkdtempSync(join(tmpdir(), 'motto-providers-'));
after(() => rmSync(dir, { recursive: true, force: true }));

function publicKeyHex() {
  return generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
}

function fixture() {
  return {
    version: 1,
    providers: [{
      id: 'paper-shop',
      name: 'Paper Shop',
      payout_address: bs58.encode(randomBytes(32)),
      quote_public_key: publicKeyHex(),
      fulfillment_url: 'https://merchant.example/motto',
      attestors: [{ id: 'delivery-service', public_key: publicKeyHex() }],
      offers: [{
        id: 'research-pack',
        summary: 'Buy a signed research pack',
        network: 'devnet',
        max_hold_usd: '5.00',
        fulfillment_timeout_seconds: 90,
        attestor_ids: ['delivery-service'],
      }],
    }],
  };
}

function code(error) {
  assert.ok(error instanceof ProviderRegistryError);
  return error.code;
}

test('loads an immutable operator-approved registry and exposes public provider terms', () => {
  const input = fixture();
  const path = join(dir, 'providers.json');
  writeFileSync(path, JSON.stringify(input));
  const registry = loadProviderRegistry(path);
  const provider = registry.getProvider('paper-shop');
  assert.equal(provider.payout_address, input.providers[0].payout_address);
  assert.equal(registry.getOffer('paper-shop', 'research-pack').max_hold_usd, '5.00');
  assert.equal(registry.getAttestor('paper-shop', 'delivery-service').public_key, input.providers[0].attestors[0].public_key);
  assert.ok(Object.isFrozen(provider));
  assert.deepEqual(Object.keys(registry.publicProviders()[0]).sort(), ['attestors', 'id', 'name', 'offers', 'payout_address', 'quote_public_key']);
  assert.equal(registry.publicProviders()[0].fulfillment_url, undefined);
});

test('requires unique provider, offer and attestor identities', () => {
  const duplicateProvider = fixture();
  duplicateProvider.providers.push(structuredClone(duplicateProvider.providers[0]));
  assert.throws(() => createProviderRegistry(duplicateProvider), error => code(error) === 'duplicate_provider_id');

  const duplicateOffer = fixture();
  duplicateOffer.providers[0].offers.push(structuredClone(duplicateOffer.providers[0].offers[0]));
  assert.throws(() => createProviderRegistry(duplicateOffer), error => code(error) === 'duplicate_paper-shop_offer_id');

  const duplicateAttestor = fixture();
  duplicateAttestor.providers[0].attestors.push(structuredClone(duplicateAttestor.providers[0].attestors[0]));
  assert.throws(() => createProviderRegistry(duplicateAttestor), error => code(error) === 'duplicate_paper-shop_attestor_id');
});

test('requires distinct quote and attestation keys', () => {
  const config = fixture();
  config.providers[0].attestors[0].public_key = config.providers[0].quote_public_key;
  assert.throws(() => createProviderRegistry(config), error => code(error) === 'signer_roles_not_distinct');

  const reusedAcrossProviders = fixture();
  const second = structuredClone(reusedAcrossProviders.providers[0]);
  second.id = 'second-shop';
  second.payout_address = bs58.encode(randomBytes(32));
  second.quote_public_key = second.attestors[0].public_key;
  second.attestors[0].public_key = publicKeyHex();
  reusedAcrossProviders.providers.push(second);
  assert.throws(() => createProviderRegistry(reusedAcrossProviders), error => code(error) === 'signer_roles_not_distinct');
});

test('validates payout addresses, keys, offer ceilings, deadlines and attestor references', () => {
  const cases = [
    ['invalid_payout_address', config => { config.providers[0].payout_address = 'not-solana'; }],
    ['invalid_quote_public_key', config => { config.providers[0].quote_public_key = 'abcd'; }],
    ['invalid_max_hold_usd', config => { config.providers[0].offers[0].max_hold_usd = '1.0000001'; }],
    ['invalid_max_hold_usd', config => { config.providers[0].offers[0].max_hold_usd = 1; }],
    ['invalid_max_hold_usd', config => { config.providers[0].offers[0].max_hold_usd = '0.00'; }],
    ['invalid_fulfillment_timeout', config => { config.providers[0].offers[0].fulfillment_timeout_seconds = 0; }],
    ['invalid_fulfillment_timeout', config => { config.providers[0].offers[0].fulfillment_timeout_seconds = 181; }],
    ['unknown_attestor', config => { config.providers[0].offers[0].attestor_ids = ['missing']; }],
  ];
  for (const [expected, mutate] of cases) {
    const config = fixture();
    mutate(config);
    assert.throws(() => createProviderRegistry(config), error => code(error) === expected, expected);
  }
});

test('allows loopback HTTP only when allowLocal is explicit', () => {
  const config = fixture();
  config.providers[0].fulfillment_url = 'http://127.0.0.1:9000/callback';
  assert.throws(() => createProviderRegistry(config), error => code(error) === 'invalid_fulfillment_url');
  assert.equal(createProviderRegistry(config, { allowLocal: true }).getProvider('paper-shop').fulfillment_url, 'http://127.0.0.1:9000/callback');

  for (const url of ['http://merchant.example/motto', 'https://10.0.0.2/motto', 'https://service.internal/motto', 'https://user:pass@merchant.example/motto']) {
    const invalid = fixture();
    invalid.providers[0].fulfillment_url = url;
    assert.throws(() => createProviderRegistry(invalid, { allowLocal: true }), error => code(error) === 'invalid_fulfillment_url', url);
  }
});

test('rejects malformed JSON and unknown registry fields', () => {
  const path = join(dir, 'bad.json');
  writeFileSync(path, '{bad');
  assert.throws(() => loadProviderRegistry(path), error => code(error) === 'invalid_registry_json');
  const config = fixture();
  config.providers[0].secret = 'must not be accepted';
  assert.throws(() => createProviderRegistry(config), error => code(error) === 'invalid_provider_0');
});
