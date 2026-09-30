import { formatUsd, toBaseUnits } from './settlement.js';

const MAX_RESPONSE_BYTES = 1_048_576;
const LIMITATIONS = 'Crossref metadata is public. Payment covers retrieval and deterministic record checks. These checks do not establish semantic relevance, paper quality, DOI resolution or full-text access.';

function requestError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function positiveAmount(value, label) {
  if (typeof value !== 'string' || value.length > 32 || !/^\d+(?:\.\d{1,6})?$/.test(value)) {
    throw requestError(`${label} must be a positive decimal string with at most 6 decimal places`);
  }
  const amount = toBaseUnits(value);
  if (amount === 0n) throw requestError(`${label} must be greater than zero`);
  return amount;
}

function serviceConfig({ unitPriceUsd = process.env.RESEARCH_UNIT_USD ?? '0.05', maxCount = 20, maxSpendUsd = process.env.RESEARCH_MAX_SPEND_USD ?? '1000' } = {}) {
  const unit = positiveAmount(unitPriceUsd, 'unit price');
  const cap = positiveAmount(maxSpendUsd, 'server spending limit');
  if (!Number.isInteger(maxCount) || maxCount < 1 || maxCount > 20) throw requestError('maxCount must be an integer between 1 and 20');
  return { unit, cap, maxCount };
}

export function digitalService(config = {}) {
  const { unit, cap, maxCount } = serviceConfig(config);
  return {
    service: 'research',
    name: 'Research citation pack',
    description: 'Retrieve DOI-backed citation records from Crossref with requested title terms and publication years.',
    pricing: { currency: 'USDC', unit: 'accepted citation record', unit_usd: formatUsd(unit), max_units: maxCount, max_spend_usd: formatUsd(cap) },
    input: { query: '3 to 200 characters', count: `integer from 1 to ${maxCount}`, required_terms: 'optional, up to 5 literal title substrings, each 1 to 100 characters; all must match without case sensitivity', from_year: 'optional integer from 1000 to 9999', to_year: 'optional integer from 1000 to 9999' },
    acceptance: 'All requested records must have distinct canonical DOI identifiers, nonempty titles of at most 500 characters, and satisfy every supplied title term and publication-year constraint. Incomplete or failed delivery charges zero.',
    limitations: LIMITATIONS,
  };
}

export function createResearchQuote(body, config = {}) {
  const { unit, cap, maxCount } = serviceConfig(config);
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.service !== 'research') throw requestError('service must be research');
  if (Object.keys(body).some(key => !['service', 'input', 'max_spend_usd'].includes(key))) throw requestError('unknown quote field');
  const input = body.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw requestError('input must be an object');
  if (Object.keys(input).some(key => !['query', 'count', 'required_terms', 'from_year', 'to_year'].includes(key))) throw requestError('unknown research input field');
  if (typeof input.query !== 'string' || input.query.trim().length < 3 || input.query.length > 200 || /[\u0000-\u001f\u007f]/.test(input.query)) throw requestError('query must be between 3 and 200 characters without control characters');
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > maxCount) throw requestError(`count must be an integer between 1 and ${maxCount}`);
  const terms = input.required_terms === undefined ? [] : input.required_terms;
  if (!Array.isArray(terms) || terms.length > 5 || terms.some(term => typeof term !== 'string' || !term.trim() || term.length > 100 || /[\u0000-\u001f\u007f]/.test(term))) throw requestError('required_terms must contain up to 5 nonempty strings of at most 100 characters');
  const requiredTerms = [...new Set(terms.map(term => term.trim().toLowerCase()))];
  for (const key of ['from_year', 'to_year']) {
    if (input[key] !== undefined && (!Number.isInteger(input[key]) || input[key] < 1000 || input[key] > 9999)) throw requestError(`${key} must be an integer between 1000 and 9999`);
  }
  if (input.from_year !== undefined && input.to_year !== undefined && input.from_year > input.to_year) throw requestError('from_year must not exceed to_year');
  const limit = positiveAmount(body.max_spend_usd, 'max_spend_usd');
  if (limit > cap) throw requestError(`max_spend_usd exceeds server limit of ${formatUsd(cap)}`);
  const ceiling = unit * BigInt(input.count);
  if (ceiling > limit) throw requestError(`quoted price ${formatUsd(ceiling)} exceeds max_spend_usd ${formatUsd(limit)}`, 422);
  const normalized = { query: input.query.trim(), count: input.count, required_terms: requiredTerms };
  for (const key of ['from_year', 'to_year']) if (input[key] !== undefined) normalized[key] = input[key];
  return {
    service: 'research',
    input: normalized,
    max_spend_usd: formatUsd(limit),
    ceiling_usd: formatUsd(ceiling),
    unit_price_usd: formatUsd(unit),
    acceptance: { count: input.count, required_terms: requiredTerms, from_year: input.from_year ?? null, to_year: input.to_year ?? null, description: digitalService(config).acceptance },
  };
}

function canonicalDoi(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let doi = value.trim().replace(/^doi:\s*/i, '');
  if (/^https?:\/\/(?:dx\.)?doi\.org\//i.test(doi)) {
    try { doi = decodeURIComponent(doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')); }
    catch { return null; }
  }
  return /^10\.\d{4,9}\/[^\s\u0000-\u001f\u007f]+$/i.test(doi) ? doi.toLowerCase() : null;
}

function acceptedCitations(items, input) {
  const seen = new Set();
  const citations = [];
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const doi = canonicalDoi(item.DOI);
    const title = Array.isArray(item.title) && typeof item.title[0] === 'string' ? item.title[0].trim() : '';
    const rawYear = item.published?.['date-parts']?.[0]?.[0];
    const year = Number.isInteger(rawYear) && rawYear >= 1000 && rawYear <= 9999 ? rawYear : null;
    if (!doi || seen.has(doi) || !title || title.length > 500 || /[\u0000-\u001f\u007f]/.test(title)) continue;
    if (!input.required_terms.every(term => title.toLowerCase().includes(term))) continue;
    if ((input.from_year !== undefined && (year === null || year < input.from_year)) || (input.to_year !== undefined && (year === null || year > input.to_year))) continue;
    seen.add(doi);
    const authors = (Array.isArray(item.author) ? item.author : []).slice(0, 20).flatMap(author => {
      if (!author || typeof author !== 'object') return [];
      const name = [author.given, author.family].filter(part => typeof part === 'string').map(part => part.trim()).join(' ').slice(0, 200);
      return name ? [name] : [];
    });
    citations.push({ title, doi, url: `https://doi.org/${encodeURIComponent(doi)}`, publisher: typeof item.publisher === 'string' ? item.publisher.trim().slice(0, 200) || null : null, year, authors });
    if (citations.length === input.count) break;
  }
  return citations;
}

async function readProviderResponse(response) {
  if (!response.ok) throw new Error(`Crossref HTTP ${response.status}`);
  if (!response.body || typeof response.body.getReader !== 'function') throw new Error('Crossref returned no readable response body');
  const declaredBytes = Number(response.headers?.get('content-length'));
  if (declaredBytes > MAX_RESPONSE_BYTES) {
    await response.body.cancel();
    throw new Error('Crossref response exceeded byte limit');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Crossref response exceeded byte limit');
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!data || data.status !== 'ok' || !Array.isArray(data.message?.items) || data.message.items.length > 100) throw new Error('Crossref returned malformed metadata');
  return data.message.items;
}

export async function executeResearchQuote(quote, { fetcher = fetch, onUpdate = () => {} } = {}) {
  const { input } = quote;
  onUpdate({ status: 'fetching', query: input.query, provider: 'Crossref' });
  const url = new URL('https://api.crossref.org/works');
  url.search = new URLSearchParams({ query: input.query, rows: String(Math.min(100, Math.max(20, input.count * 5))), select: 'DOI,title,publisher,published,author' }).toString();
  const filters = [];
  if (input.from_year !== undefined) filters.push(`from-pub-date:${input.from_year}-01-01`);
  if (input.to_year !== undefined) filters.push(`until-pub-date:${input.to_year}-12-31`);
  if (filters.length) url.searchParams.set('filter', filters.join(','));
  let items = [];
  let providerError = null;
  try {
    const response = await fetcher(url, { headers: { Accept: 'application/json', 'User-Agent': 'Motto/1.0' }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    items = await readProviderResponse(response);
  } catch (error) {
    providerError = error instanceof Error ? error.message.slice(0, 200) : 'Crossref request failed';
  }
  onUpdate({ status: 'validating', query: input.query, provider: 'Crossref' });
  const citations = acceptedCitations(items, input);
  const passed = providerError === null && citations.length === input.count;
  return {
    outcome: passed ? 'delivered' : 'inconclusive',
    detail: passed ? 'citation_pack_delivered' : 'citation_pack_incomplete',
    provider: 'Crossref public metadata API',
    ...(providerError === null ? {} : { provider_error: providerError }),
    deliverable: { type: 'citation_pack', query: input.query, citations },
    checks: { required_count: input.count, received_count: citations.length, distinct_dois: citations.length === new Set(citations.map(citation => citation.doi)).size, titles_present: citations.every(citation => Boolean(citation.title)), required_terms: input.required_terms, from_year: input.from_year ?? null, to_year: input.to_year ?? null, passed },
    limitations: LIMITATIONS,
    units_delivered: passed ? citations.length : 0,
    charge_usd: passed ? quote.ceiling_usd : '0.00',
  };
}
