'use strict';
const $ = id => document.getElementById(id);
const purchases = new Map();
const verification = new Map();
const statuses = {fetching:'Finding sources',validating:'Checking requirements',settling:'Settling payment',paid:'Paid',refunded:'Refunded',settle_failed:'Settlement unconfirmed',interrupted:'Interrupted'};
let catalog, quote, selectedId, apiKey = '', purchasing = false, quoting = false, syncing = false, syncTimer, commandKey, accessVersion = 0;
const finalStatuses = new Set(['paid','refunded','settle_failed','interrupted']);
const money = value => value == null ? 'Not recorded' : `${Number(value).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:6})} USDC`;
const short = value => value ? `${value.slice(0,8)}…${value.slice(-6)}` : 'Not recorded';
const current = () => purchases.get(selectedId);
function text(id, value) { $(id).textContent = value; }
function feedback(id, message = '', error = false) { text(id,message); $(id).classList.toggle('error',error); }
async function request(path, {method = 'GET', body, authenticated = true} = {}) {
  const headers = {Accept:'application/json'};
  if (authenticated && apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(path,{method,headers,body:body === undefined ? undefined : JSON.stringify(body),signal:AbortSignal.timeout(method === 'POST' ? 120000 : 15000)});
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error('Access denied. Connect with your server API key through API access.');
    throw new Error(typeof data?.error === 'string' ? data.error : typeof data?.message === 'string' ? data.message : `Request failed (${response.status}).`);
  }
  if (!data) throw new Error('Server returned an unreadable response.');
  return data;
}
function getInput() {
  const input = {query:$('query').value.trim(),count:Number($('count').value)};
  const requiredTerms = $('required-terms').value.split(',').map(term => term.trim()).filter(Boolean);
  if (requiredTerms.length) input.required_terms = requiredTerms;
  if ($('from-year').value) input.from_year = Number($('from-year').value);
  if ($('to-year').value) input.to_year = Number($('to-year').value);
  return input;
}
function clearQuote() {
  quote = undefined;
  commandKey = undefined;
  $('quote-panel').hidden = true;
  feedback('purchase-feedback');
}
function acceptanceDescription(acceptance) {
  if (typeof acceptance === 'string') return acceptance;
  return acceptance?.description || 'See the signed receipt for the result of each acceptance check.';
}
function expired() { return !quote || !Number.isFinite(Date.parse(quote.expires_at)) || Date.parse(quote.expires_at) <= Date.now(); }
function shellQuote(value) { return "'" + value.replaceAll("'","'\\''") + "'"; }
function paymentCommand() {
  if (!quote || !/^[a-zA-Z0-9_-]{1,128}$/.test(quote.id)) throw new Error('Server returned an invalid quote identifier.');
  const url = new URL(`/v1/purchases/${quote.id}`,location.origin);
  if (!['http:','https:'].includes(url.protocol)) throw new Error('Payment requires an HTTP or HTTPS server.');
  const network = catalog.network === 'localnet' ? '--sandbox' : '--mainnet';
  const auth = apiKey ? ' \\\n  -H "Authorization: Bearer ${MOTTO_API_KEY:?Set MOTTO_API_KEY to your server API key}"' : '';
  return `pay ${network} curl -X POST ${shellQuote(url.href)} \\\n  -H ${shellQuote('Idempotency-Key: ' + commandKey)}${auth}`;
}
function renderQuote() {
  if (!quote) return;
  $('quote-panel').hidden = false;
  text('quote-query',`${quote.input.count} sources about ${quote.input.query}`);
  text('quote-budget',money(quote.max_spend_usd));
  text('quote-ceiling',money(quote.ceiling_usd));
  text('quote-unit',money(quote.unit_price_usd));
  const terms = quote.input.required_terms?.length ? quote.input.required_terms.join(', ') : 'None';
  const from = quote.input.from_year ?? 'Any';
  const to = quote.input.to_year ?? 'Any';
  text('quote-scope',`Required title terms: ${terms}. Publication range: ${from} through ${to}.`);
  text('quote-acceptance',acceptanceDescription(quote.acceptance));
  const remaining = Math.max(0,Math.ceil((Date.parse(quote.expires_at) - Date.now()) / 1000));
  text('quote-expiry',expired() ? 'Expired. Request a new quote.' : `Expires in ${Math.floor(remaining/60)}m ${remaining%60}s`);
  const local = catalog?.console?.local_pay === true;
  $('local-payment').hidden = !local;
  $('external-payment').hidden = local;
  $('purchase-submit').disabled = purchasing || expired();
  text('purchase-submit',purchasing ? 'Authorizing purchase…' : 'Authorize this purchase ↗');
  $('copy-command').disabled = expired();
  if (!local) {
    try { text('purchase-command',paymentCommand()); }
    catch (error) { text('purchase-command',error.message); $('copy-command').disabled = true; }
    text('command-auth-note',apiKey ? 'Set MOTTO_API_KEY in your terminal before running. The command uses your existing Pay.sh spending permissions. Keep this idempotency key when retrying.' : 'The command uses your existing Pay.sh spending permissions. Keep this idempotency key when retrying.');
  }
}
function ingest(purchase) {
  if (!purchase || typeof purchase.id !== 'string') return;
  const previous = purchases.get(purchase.id);
  if (previous && Date.parse(previous.updated_at) > Date.parse(purchase.updated_at)) return;
  if (previous?.reading?.signature !== purchase.reading?.signature) verification.delete(purchase.id);
  purchases.set(purchase.id,purchase);
}
function renderHistory() {
  const list = [...purchases.values()].sort((a,b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  text('purchase-count',String(list.length));
  const fragment = document.createDocumentFragment();
  for (const purchase of list) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'purchase-row' + (purchase.id === selectedId ? ' selected' : '') + (['settle_failed','interrupted'].includes(purchase.status) ? ' failed' : '');
    button.setAttribute('aria-pressed',String(purchase.id === selectedId));
    const title = document.createElement('strong'); title.textContent = purchase.input?.query || 'Research purchase';
    const meta = document.createElement('span'), status = document.createElement('span'), count = document.createElement('span');
    status.textContent = statuses[purchase.status] || purchase.status;
    count.textContent = `${purchase.input?.count ?? '?'} sources`;
    meta.append(status,count);button.append(title,meta);
    button.addEventListener('click',() => { selectedId = purchase.id; render(); });
    fragment.append(button);
  }
  if (!list.length) { const empty = document.createElement('p');empty.className = 'empty';empty.textContent = 'Your purchases appear here after payment authorization.';fragment.append(empty); }
  $('purchases').replaceChildren(fragment);
}
function renderProgress(purchase) {
  const status = purchase?.status;
  const rank = ['fetching','validating','settling'].indexOf(status);
  document.querySelectorAll('[data-step]').forEach((step,index) => {
    step.classList.toggle('done',status === 'paid' || (status === 'refunded' && index < 3) || (rank >= 0 && index < rank));
    step.classList.toggle('active',rank === index);
    step.classList.toggle('failed',['settle_failed','interrupted'].includes(status) && index === 2);
  });
  text('purchase-status',statuses[status] || (status ? status : 'Awaiting purchase'));
  $('purchase-status').classList.toggle('success',['paid','refunded'].includes(status));
  $('purchase-status').classList.toggle('failed',['settle_failed','interrupted'].includes(status));
}
function renderSources(purchase) {
  const reading = purchase?.reading;
  text('result-query',purchase ? `${purchase.input?.count ?? '?'} requested sources · ${purchase.input?.query ?? 'Research request'}` : 'Select a purchase to inspect its sources and payment.');
  text('result-reason',purchase?.reason || reading?.reason || '');
  const fragment = document.createDocumentFragment();
  for (const [index,citation] of (reading?.deliverable?.citations ?? []).entries()) {
    const article = document.createElement('article');article.className = 'citation';
    const number = document.createElement('span');number.className = 'citation-number';number.textContent = String(index + 1).padStart(2,'0');
    const content = document.createElement('div');
    const title = document.createElement('a');title.textContent = citation.title || 'Untitled source';
    if (typeof citation.doi === 'string' && /^10\.\d{4,9}\/\S+$/i.test(citation.doi)) {title.href = 'https://doi.org/' + encodeURIComponent(citation.doi);title.target = '_blank';title.rel = 'noopener';}
    const meta = document.createElement('p');meta.className = 'citation-meta';meta.textContent = [citation.publisher,citation.year,citation.doi].filter(value => value != null && value !== '').join(' · ');
    content.append(title,meta);article.append(number,content);fragment.append(article);
  }
  if (!fragment.childNodes.length) {
    const empty = document.createElement('p');empty.className = 'quiet';
    empty.textContent = !purchase ? 'Delivered sources will appear here.' : finalStatuses.has(purchase.status) ? 'No source records were delivered.' : 'Waiting for the provider result.';
    fragment.append(empty);
  }
  $('citations').replaceChildren(fragment);
  text('result-limitations',reading?.limitations || (purchase ? 'Acceptance checks establish source count, DOI format, title requirements and publication dates. They do not establish scientific quality or full-text access.' : ''));
}
function receiptFields(entries) {
  const fragment = document.createDocumentFragment();
  for (const [label,value] of entries) {
    const row = document.createElement('div'),term = document.createElement('dt'),description = document.createElement('dd');
    term.textContent = label;description.textContent = value == null ? 'Not recorded' : typeof value === 'object' ? JSON.stringify(value,null,2) : String(value);
    row.append(term,description);fragment.append(row);
  }
  $('receipt-fields').replaceChildren(fragment);
}
function renderReceipt(purchase) {
  const reading = purchase?.reading;
  receiptFields([['Purchase',purchase?.id],['Quote',purchase?.quote_id],['Status',purchase ? statuses[purchase.status] || purchase.status : null],['Delivery outcome',reading?.outcome],['Accepted sources',reading?.units_delivered],['Checks',reading?.checks],['Created',purchase?.created_at]]);
  const result = verification.get(purchase?.id);
  text('signature-state',result?.message || (reading?.signature ? 'Signature present. Verification pending.' : 'No signed receipt selected.'));
  $('signature-state').classList.toggle('verified',result?.valid === true);
  $('signature-state').classList.toggle('error',result?.valid === false);
  $('verify').disabled = !reading?.signature || !catalog?.signing_public_key || result?.checking === true;
  $('download-receipt').disabled = !reading;
  $('raw').disabled = !purchase;
  text('transaction',purchase?.settlement_tx || 'No transaction reported.');
  const validTx = typeof purchase?.settlement_tx === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(purchase.settlement_tx);
  const mainnet = ['mainnet','mainnet-beta'].includes(purchase?.network);
  $('explorer').hidden = !(validTx && mainnet);
  if (validTx && mainnet) $('explorer').href = 'https://explorer.solana.com/tx/' + purchase.settlement_tx;
  text('chain-note',purchase?.network === 'localnet' ? 'Test USDC on localnet. This record is not a real-money payment.' : 'The server reports settlement. This workspace does not independently confirm chain finality.');
}
function render() {
  renderHistory();
  const purchase = current();
  renderProgress(purchase);renderSources(purchase);renderReceipt(purchase);
  text('record-budget',money(purchase?.max_spend_usd));text('record-ceiling',money(purchase?.ceiling_usd));
  const uncertain = purchase && ['settle_failed','interrupted'].includes(purchase.status);
  text('record-charged',uncertain ? 'Unconfirmed' : money(purchase?.charged_usd));
  text('record-returned',uncertain ? 'Unconfirmed' : money(purchase?.returned_usd));
  text('payment-note',uncertain ? 'Settlement is unconfirmed. Do not assume a charge or refund succeeded.' : purchase && !finalStatuses.has(purchase.status) ? 'Authorization is in progress. Final charges and returns are not yet confirmed.' : purchase ? 'Amounts are the settlement result reported by the server.' : 'Payment amounts appear after settlement.');
}
function hexBytes(value, length) {
  if (typeof value !== 'string' || value.length !== length * 2 || !/^[0-9a-f]+$/i.test(value)) throw new Error('Invalid receipt key or signature encoding.');
  return Uint8Array.from(value.match(/.{2}/g),pair => parseInt(pair,16));
}
async function verifyReceipt() {
  const purchase = current(), reading = purchase?.reading;
  if (!reading || !catalog) return;
  const id = purchase.id;
  const serverKey = catalog.signing_public_key;
  verification.set(id,{checking:true,message:'Checking receipt signature…'});renderReceipt(current());
  try {
    if (!globalThis.crypto?.subtle) throw new Error('Browser verification requires a secure context (HTTPS or localhost).');
    if (reading.purchase_id !== purchase.id || reading.quote_id !== purchase.quote_id || reading.service !== purchase.service) throw new Error('Receipt does not match the selected purchase.');
    if (reading.devicePublicKey !== catalog.signing_public_key) throw new Error('Receipt signer differs from the server’s published key.');
    const {signature,devicePublicKey,...payload} = reading;
    const key = await crypto.subtle.importKey('raw',hexBytes(devicePublicKey,32),{name:'Ed25519'},false,['verify']);
    const valid = await crypto.subtle.verify('Ed25519',key,hexBytes(signature,64),new TextEncoder().encode(JSON.stringify(payload)));
    if (!valid) throw new Error('Receipt signature is invalid.');
    if (purchases.get(id)?.reading !== reading || catalog?.signing_public_key !== serverKey) return;
    verification.set(id,{valid:true,message:'Verified. Delivered data matches the published signing key.'});
  } catch (error) { if (purchases.get(id)?.reading === reading && catalog?.signing_public_key === serverKey) verification.set(id,{valid:false,message:`Not verified: ${error.message}`}); }
  renderReceipt(current());
}
async function sync() {
  if (syncing) return;
  syncing = true;
  const version = accessVersion;
  try {
    if (!catalog) {
      const services = await request('/v1/services',{authenticated:false});
      if (version !== accessVersion) return;
      catalog = services;
      const research = catalog.services?.research;
      const unit = research?.pricing?.unit_usd ?? research?.pricing?.unit_price_usd;
      const maxUnits = research?.pricing?.max_units ?? research?.pricing?.max_count;
      if (typeof unit !== 'string' || !/^[0-9]+(?:\.[0-9]{1,6})?$/.test(unit) || Number(unit) <= 0 || !Number.isInteger(maxUnits) || maxUnits < 1 || maxUnits > 20) throw new Error('Research pricing is unavailable.');
      text('network',catalog.network === 'localnet' ? 'Localnet · test USDC' : `${catalog.network} · USDC`);
      text('unit-price',`${money(unit)} per requested source`);
      text('pricing-note',`${money(unit)} per requested source. Up to ${maxUnits} sources.`);
      text('signing-key',`Signer ${short(catalog.signing_public_key)}`);
      $('count').max = maxUnits;
      $('quote-submit').disabled = false;
      renderQuote();
    }
    const response = await request('/v1/purchases');
    if (version !== accessVersion) return;
    if (!Array.isArray(response.purchases)) throw new Error('Server returned an invalid purchase history.');
    response.purchases.forEach(ingest);
    const quotedPurchase = quote && response.purchases.find(purchase => purchase.quote_id === quote.id);
    if (quotedPurchase && !purchasing) {
      selectedId = quotedPurchase.id;
      clearQuote();
      feedback('request-feedback','Payment request received. Inspect its delivery and settlement below.');
    }
    if (!selectedId) selectedId = [...purchases.values()].sort((a,b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0]?.id;
    text('connection','Connected · polling purchases');$('connection').classList.add('online');
    text('footer-status','Connected to Motto');render();
  } catch (error) {
    if (version !== accessVersion) return;
    text('connection',error.message);$('connection').classList.remove('online');text('footer-status','Purchase history unavailable');
    if (!catalog?.services?.research?.pricing) {catalog = undefined;$('quote-submit').disabled = true;}
  } finally {syncing = false;clearTimeout(syncTimer);syncTimer = setTimeout(sync,version === accessVersion ? 3000 : 0);}
}
$('request-form').addEventListener('input',() => {clearQuote();feedback('request-feedback');});
$('request-form').addEventListener('submit',async event => {
  event.preventDefault();
  if (quoting || !catalog) return;
  const input = getInput();
  if (input.from_year && input.to_year && input.from_year > input.to_year) {feedback('request-feedback','The publication range must start before it ends.',true);return;}
  const maxSpend = $('max-spend').value.trim();
  if (!/^[0-9]+(?:\.[0-9]{1,6})?$/.test(maxSpend) || Number(maxSpend) <= 0) {feedback('request-feedback','Enter a positive spending limit with up to six decimal places.',true);return;}
  quoting = true;clearQuote();$('quote-submit').disabled = true;feedback('request-feedback','Requesting a binding quote…');
  const version = accessVersion;
  const fingerprint = JSON.stringify({input,maxSpend});
  try {
    const result = await request('/v1/quotes',{method:'POST',body:{service:'research',input,max_spend_usd:maxSpend}});
    if (version !== accessVersion) return;
    if (JSON.stringify({input:getInput(),maxSpend:$('max-spend').value.trim()}) !== fingerprint) {feedback('request-feedback','Request changed. Review a new quote.');return;}
    quote = result.quote || result;
    if (!quote.id || !quote.input || !quote.expires_at) {clearQuote();throw new Error('Server returned an incomplete quote.');}
    commandKey = crypto.randomUUID();renderQuote();feedback('request-feedback','Quote ready. Review the price and requirements below.');
    $('quote-panel').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',block:'nearest'});
  } catch (error) {if (version === accessVersion) feedback('request-feedback',error.message,true);}
  finally {quoting = false;$('quote-submit').disabled = !catalog;}
});
$('purchase-submit').addEventListener('click',async () => {
  if (!quote || expired() || purchasing || !catalog?.console?.local_pay) return;
  purchasing = true;renderQuote();feedback('purchase-feedback','Waiting for Pay.sh authorization and delivery.');
  const quoteId = quote.id;
  const version = accessVersion;
  try {
    const response = await request('/v1/console/purchases',{method:'POST',body:{quote_id:quoteId}});
    if (version !== accessVersion) return;
    const purchase = response.purchase || response;
    if (!purchase.id) throw new Error('Server did not return a purchase record. Refresh history before retrying.');
    ingest(purchase);selectedId = purchase.id;render();
    if (quote?.id === quoteId) {clearQuote();feedback('request-feedback','Purchase submitted. Inspect the result and settlement below.');}
    await sync();
  } catch (error) {if (version === accessVersion) {feedback('purchase-feedback',/purchase history/i.test(error.message) ? error.message : `${error.message} Check purchase history before retrying.`,true);await sync();}}
  finally {purchasing = false;renderQuote();}
});
$('copy-command').addEventListener('click',async () => {
  if (expired()) return;
  try {await navigator.clipboard.writeText(paymentCommand());feedback('purchase-feedback','Command copied. Run it from your agent’s Pay.sh wallet.');}
  catch (error) {feedback('purchase-feedback',`Could not copy: ${error.message} Select the command to copy it manually.`,true);}
});
$('access-open').addEventListener('click',() => { $('api-key').value = ''; $('access-dialog').showModal(); });
$('access-form').addEventListener('submit',event => {
  event.preventDefault();accessVersion++;apiKey = $('api-key').value.trim();$('api-key').value = '';purchases.clear();verification.clear();selectedId = undefined;clearQuote();catalog = undefined;render();$('access-dialog').close();clearTimeout(syncTimer);sync();
});
$('verify').addEventListener('click',verifyReceipt);
$('download-receipt').addEventListener('click',() => {
  const purchase = current();if (!purchase?.reading) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(purchase.reading,null,2)],{type:'application/json'}));
  const link = document.createElement('a');link.href = url;link.download = `motto-receipt-${purchase.id.replace(/[^a-zA-Z0-9_-]/g,'')}.json`;link.click();setTimeout(() => URL.revokeObjectURL(url),1000);
});
$('raw').addEventListener('click',() => {text('raw-json',JSON.stringify(current(),null,2));$('raw-dialog').showModal();});
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click',() => button.closest('dialog').close());
setInterval(renderQuote,1000);
render();sync();
