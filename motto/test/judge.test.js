// Verify: request validation and how a verdict maps to an outcome (model mocked).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.MOCK_POWER = 'ac';
process.env.MOCK_BATTERY = 'ac';
process.env.MOCK_FREE_GB = '50';
process.env.MOCK_DISPLAY = 'internal';
const { checkCondition, verifyRequestError } = await import('../src/judge.js');

test('a condition is required and bounded', () => {
  assert.match(verifyRequestError({}), /condition is required/);
  assert.match(verifyRequestError({ condition: '   ' }), /condition is required/);
  assert.match(verifyRequestError({ condition: 'x'.repeat(501) }), /longer than 500/);
  assert.equal(verifyRequestError({ condition: 'The laptop is plugged in' }), undefined);
});

test('evidence URLs must be public https, at most 3', () => {
  const bad = ['http://example.com', 'https://localhost/x', 'https://127.0.0.1/', 'https://192.168.1.1/', 'https://10.0.0.2/', 'https://[::1]/', 'https://printer.local/', 'not a url'];
  for (const url of bad) assert.match(verifyRequestError({ condition: 'c', evidence_urls: [url] }), /not a public https URL/, url);
  assert.match(verifyRequestError({ condition: 'c', evidence_urls: 'https://example.com' }), /list of at most 3/);
  assert.match(verifyRequestError({ condition: 'c', evidence_urls: Array(4).fill('https://example.com') }), /list of at most 3/);
  assert.equal(verifyRequestError({ condition: 'c', evidence_urls: ['https://example.com/order/1'] }), undefined);
});

test('true, false and unknown map to handled, delivered and inconclusive, signed with the evidence', async () => {
  for (const [verdict, outcome] of [['true', 'already_handled'], ['false', 'delivered'], ['unknown', 'inconclusive']]) {
    process.env.MOCK_JUDGE = verdict;
    const statuses = [];
    const r = await checkCondition({ holdId: 'h1', condition: 'The laptop has 20 GB free', onUpdate: u => statuses.push(u.status) });
    assert.equal(r.outcome, outcome, verdict);
    assert.equal(r.item, 'verify');
    assert.equal(r.condition, 'The laptop has 20 GB free');
    assert.equal(r.evidence.device.disk, 'mock:50GB');
    assert.match(r.signature, /^[0-9a-f]{128}$/);
    assert.deepEqual(statuses, ['judging']);
  }
});

test('a verdict outside true, false, unknown fails the check', async () => {
  process.env.MOCK_JUDGE = 'maybe';
  await assert.rejects(checkCondition({ holdId: 'h2', condition: 'c' }), /verdict "maybe"/);
  delete process.env.MOCK_JUDGE;
});
