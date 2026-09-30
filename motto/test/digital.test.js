import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResearchQuote, digitalService, executeResearchQuote } from '../src/digital.js';

const request = (input = {}, maxSpend = '10.00') => ({ service: 'research', input: { query: 'battery recycling', count: 3, ...input }, max_spend_usd: maxSpend });
const records = count => Array.from({ length: count }, (_, index) => ({ DOI: `10.1234/paper-${index}`, title: [`Battery recycling study ${index}`], publisher: 'Example publisher', published: { 'date-parts': [[2023, 1, 1]] }, author: [{ given: 'Test', family: 'Author' }] }));
const provider = items => async () => Response.json({ status: 'ok', message: { items } });

test('catalog and quotes use exact variable-scope prices and normalize USDC', () => {
  assert.equal(digitalService({ unitPriceUsd: '0.000007' }).pricing.unit_usd, '0.000007');
  assert.equal(digitalService().pricing.max_units, 20);
  const quote = createResearchQuote(request({ count: 17, query: '  battery recycling  ', required_terms: [' Battery ', 'BATTERY', 'recycling'] }, '0001.000000'), { unitPriceUsd: '0.000007' });
  assert.equal(quote.ceiling_usd, '0.000119');
  assert.equal(quote.max_spend_usd, '1.00');
  assert.equal(quote.unit_price_usd, '0.000007');
  assert.equal(quote.input.query, 'battery recycling');
  assert.deepEqual(quote.input.required_terms, ['battery', 'recycling']);
  assert.equal(quote.acceptance.count, 17);
});

test('price equal to limit is accepted and above limit fails before purchase', () => {
  assert.equal(createResearchQuote(request({}, '0.15')).ceiling_usd, '0.15');
  assert.throws(() => createResearchQuote(request({}, '0.149999')), error => error.status === 422);
  assert.throws(() => createResearchQuote(request({}, '1000.000001')), error => error.status === 400);
  assert.throws(() => createResearchQuote(request({}, '2'), { maxSpendUsd: '1' }), /server limit/);
});

test('money requires positive decimal strings with USDC precision', () => {
  for (const value of [undefined, null, 1, 0.5, '', '0', '0.000000', '-1', '+1', '1e2', ' 1', '1.', '0.0000001', '1'.repeat(33)]) {
    assert.throws(() => createResearchQuote({ ...request(), max_spend_usd: value }), error => error.status === 400);
  }
  for (const unitPriceUsd of [0.05, '0', '-1', '1e3']) assert.throws(() => createResearchQuote(request(), { unitPriceUsd }));
  assert.equal(createResearchQuote(request({ count: 1 }, '0.000001'), { unitPriceUsd: '0.000001' }).ceiling_usd, '0.000001');
});

test('quote schema rejects unknown services, fields, invalid counts and constraints', () => {
  for (const body of [null, [], { ...request(), service: 'charger' }, { ...request(), accepted: true }, { ...request(), input: null }]) assert.throws(() => createResearchQuote(body));
  for (const count of [0, -1, 1.5, '3', 21, null]) assert.throws(() => createResearchQuote(request({ count })));
  for (const query of ['', 'ab', ' '.repeat(3), 'a'.repeat(201), 'abc\n']) assert.throws(() => createResearchQuote(request({ query })));
  for (const required_terms of [null, 'battery', [''], [' '], [1], Array(6).fill('battery'), ['x'.repeat(101)], ['a\0']]) assert.throws(() => createResearchQuote(request({ required_terms })));
  for (const input of [{ surprise: true }, { from_year: '2020' }, { from_year: 999 }, { to_year: 10000 }, { to_year: null }, { from_year: 2024, to_year: 2023 }]) assert.throws(() => createResearchQuote(request(input)));
  for (const maxCount of [0, 21, 1.5]) assert.throws(() => digitalService({ maxCount }));
  assert.throws(() => createResearchQuote(request({ count: 4 }), { maxCount: 3 }));
});

test('complete delivery charges the quoted ceiling and returns usable metadata', async () => {
  const updates = [];
  const result = await executeResearchQuote(createResearchQuote(request({ count: 4 })), { fetcher: provider(records(5)), onUpdate: update => updates.push(update.status) });
  assert.deepEqual(updates, ['fetching', 'validating']);
  assert.equal(result.outcome, 'delivered');
  assert.equal(result.charge_usd, '0.20');
  assert.equal(result.units_delivered, 4);
  assert.equal(result.checks.passed, true);
  assert.equal(result.deliverable.citations.length, 4);
  assert.deepEqual(result.deliverable.citations[0], { title: 'Battery recycling study 0', doi: '10.1234/paper-0', url: 'https://doi.org/10.1234%2Fpaper-0', publisher: 'Example publisher', year: 2023, authors: ['Test Author'] });
  assert.match(result.limitations, /do not establish semantic relevance/);
});

test('requests use fixed HTTPS provider, no redirects, bounded rows, timeout and publication filters', async () => {
  const quote = createResearchQuote(request({ count: 20, from_year: 2020, to_year: 2024 }));
  const result = await executeResearchQuote(quote, { fetcher: async (url, options) => {
    assert.equal(url.origin, 'https://api.crossref.org');
    assert.equal(url.pathname, '/works');
    assert.equal(url.searchParams.get('rows'), '100');
    assert.equal(url.searchParams.get('filter'), 'from-pub-date:2020-01-01,until-pub-date:2024-12-31');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ status: 'ok', message: { items: records(20) } });
  } });
  assert.equal(result.outcome, 'delivered');
});

test('DOIs are canonicalized before duplicates are counted', async () => {
  const items = records(3);
  items[0].DOI = ' DOI:10.1234/PAPER-0 ';
  const duplicates = [{ ...items[0], DOI: 'https://doi.org/10.1234%2Fpaper-0' }, { ...items[0], DOI: 'https://dx.doi.org/10.1234/PAPER-0' }];
  const result = await executeResearchQuote(createResearchQuote(request()), { fetcher: provider([items[0], ...duplicates, ...items.slice(1)]) });
  assert.equal(result.outcome, 'delivered');
  assert.deepEqual(result.deliverable.citations.map(citation => citation.doi), ['10.1234/paper-0', '10.1234/paper-1', '10.1234/paper-2']);
});

test('all literal title constraints and inclusive years are enforced locally', async () => {
  const items = records(6);
  items[0].title = ['Battery study'];
  items[1].published = { 'date-parts': [[2019]] };
  items[2].published = { 'date-parts': [[2025]] };
  items[3].published = {};
  items[4].title = ['BATTERY RECYCLING METHODS'];
  items[4].published = { 'date-parts': [[2020]] };
  items[5].published = { 'date-parts': [[2024]] };
  const quote = createResearchQuote(request({ count: 2, required_terms: ['Battery', 'recycling'], from_year: 2020, to_year: 2024 }));
  const result = await executeResearchQuote(quote, { fetcher: provider(items) });
  assert.equal(result.outcome, 'delivered');
  assert.deepEqual(result.deliverable.citations.map(citation => citation.year), [2020, 2024]);
  const literalQuote = createResearchQuote(request({ count: 1, required_terms: ['battery.*'] }));
  assert.equal((await executeResearchQuote(literalQuote, { fetcher: provider(items) })).charge_usd, '0.00');
});

test('malformed and incomplete records cannot earn a charge', async () => {
  const valid = records(1)[0];
  const invalid = [null, 1, [], { ...valid, DOI: 'invalid' }, { ...valid, DOI: '10.1234/a b' }, { ...valid, DOI: 'https://doi.org/%ZZ' }, { ...valid, title: 'Incorrect type' }, { ...valid, title: [''] }, { ...valid, title: ['x'.repeat(501)] }, { ...valid, title: ['bad\0title'] }];
  const result = await executeResearchQuote(createResearchQuote(request()), { fetcher: provider([...invalid, valid, valid]) });
  assert.equal(result.outcome, 'inconclusive');
  assert.equal(result.checks.received_count, 1);
  assert.equal(result.units_delivered, 0);
  assert.equal(result.charge_usd, '0.00');
});

test('provider failures and malformed envelopes charge zero', async () => {
  for (const fetcher of [async () => { throw new Error('provider timeout'); }, async () => new Response('', { status: 503 }), async () => new Response('{bad JSON'), async () => Response.json({ message: { items: records(3) } }), async () => Response.json({ status: 'ok', message: { items: 'wrong' } }), provider(records(101))]) {
    const result = await executeResearchQuote(createResearchQuote(request()), { fetcher });
    assert.equal(result.outcome, 'inconclusive');
    assert.equal(result.checks.passed, false);
    assert.equal(result.charge_usd, '0.00');
    assert.equal(result.units_delivered, 0);
    assert.equal(typeof result.provider_error, 'string');
  }
});

test('declared and streamed oversized responses are stopped without a charge', async () => {
  for (const response of [new Response('{}', { headers: { 'content-length': '1048577' } }), new Response('x'.repeat(1_048_577))]) {
    const result = await executeResearchQuote(createResearchQuote(request()), { fetcher: async () => response });
    assert.equal(result.charge_usd, '0.00');
    assert.match(result.provider_error, /byte limit/);
  }
});
