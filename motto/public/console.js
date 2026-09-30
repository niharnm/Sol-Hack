'use strict';
const $ = id => document.getElementById(id);
const purchases = new Map();
const verification = new Map();
const stateSeenAt = new Map();
let connectionState = 'offline', motionRecord, historyRenderKey, deliveryRenderKey;
const statuses = {fetching:'Finding sources',validating:'Checking requirements',settling:'Settling payment',paid:'Paid',refunded:'Refunded',settle_failed:'Settlement unconfirmed',interrupted:'Interrupted'};
let catalog, selectedId, apiKey = '', syncing = false, syncTimer, accessVersion = 0;
const finalStatuses = new Set(['paid','refunded','settle_failed','interrupted']);
const money = value => value == null ? 'Not recorded' : `${Number(value).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:6})} USDC`;
const short = value => value ? `${value.slice(0,8)}…${value.slice(-6)}` : 'Not recorded';
const current = () => purchases.get(selectedId);
function text(id, value) { if ($(id).textContent !== String(value)) $(id).textContent = value; }
function animate(element, name) { element.classList.remove(name); void element.offsetWidth; element.classList.add(name); }
function feedback(id, message = '', error = false) { text(id,message); $(id).classList.toggle('error',error); }
async function request(path, {authenticated = true} = {}) {
  const headers = {Accept:'application/json'};
  if (authenticated && apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetch(path,{headers,signal:AbortSignal.timeout(15000)});
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw Object.assign(new Error('Access denied. Connect with your server API key through API access.'),{status:response.status});
    throw new Error(typeof data?.error === 'string' ? data.error : typeof data?.message === 'string' ? data.message : `Request failed (${response.status}).`);
  }
  if (!data) throw new Error('Server returned an unreadable response.');
  return data;
}
function ingest(purchase) {
  if (!purchase || typeof purchase.id !== 'string') return;
  const previous = purchases.get(purchase.id);
  if (previous && Date.parse(previous.updated_at) > Date.parse(purchase.updated_at)) return;
  if (previous?.reading?.signature !== purchase.reading?.signature) verification.delete(purchase.id);
  if (!previous || previous.status !== purchase.status) stateSeenAt.set(purchase.id,Date.now());
  purchases.set(purchase.id,purchase);
}
function renderHistory() {
  const list = [...purchases.values()].sort((a,b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const key = JSON.stringify([selectedId,connectionState,list.map(purchase => [purchase.id,purchase.status,purchase.input?.query,purchase.input?.count])]);
  if (key === historyRenderKey) return;
  historyRenderKey = key;
  text('purchase-count',String(list.length));
  const fragment = document.createDocumentFragment();
  for (const purchase of list) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'purchase-row' + (purchase.id === selectedId ? ' selected' : '') + (['settle_failed','interrupted'].includes(purchase.status) ? ' failed' : '');
    button.classList.toggle('running',!finalStatuses.has(purchase.status));
    button.setAttribute('aria-pressed',String(purchase.id === selectedId));
    const title = document.createElement('strong'); title.textContent = purchase.title || purchase.input?.query || 'Agent purchase';
    const meta = document.createElement('span'), status = document.createElement('span'), count = document.createElement('span');
    status.textContent = statuses[purchase.status] || purchase.status;
    count.textContent = purchase.input?.count ? `${purchase.input.count} records` : purchase.service || 'Agent purchase';
    meta.append(status,count);button.append(title,meta);
    button.addEventListener('click',() => { selectedId = purchase.id; render(); });
    fragment.append(button);
  }
  if (!list.length) { const empty = document.createElement('p');empty.className = 'empty';empty.textContent = 'Your purchases appear here after payment authorization.';fragment.append(empty); }
  $('purchases').replaceChildren(fragment);
}
function renderProgress(purchase) {
  const status = purchase?.status, reading = purchase?.reading;
  const rank = ['fetching','validating','settling'].indexOf(status);
  const settled = ['paid','refunded'].includes(status);
  const attention = ['settle_failed','interrupted'].includes(status);
  const same = motionRecord?.id === purchase?.id;
  document.querySelectorAll('[data-step]').forEach((step,index) => {
    const failed = (index === 1 && reading?.checks?.passed === false) || (index === 2 && attention);
    const complete = !failed && [Boolean(reading) || rank > 0 || status === 'paid',reading?.checks?.passed === true,settled,settled && Boolean(reading?.signature)][index];
    if (!same) step.classList.remove('step-arrived','step-alert');
    if (same && complete && !step.classList.contains('done')) animate(step,'step-arrived');
    if (same && failed && !step.classList.contains('failed')) animate(step,'step-alert');
    step.classList.toggle('done',complete);step.classList.toggle('active',rank === index && !failed);step.classList.toggle('failed',failed);
    if (rank === index) step.setAttribute('aria-current','step');else step.removeAttribute('aria-current');
  });
  text('purchase-status',statuses[status] || (status ? status : 'Awaiting purchase'));
  $('purchase-status').classList.toggle('success',settled);$('purchase-status').classList.toggle('failed',attention);
  $('purchase-status').dataset.state = attention ? 'attention' : settled ? 'settled' : rank >= 0 ? 'pending' : 'idle';
  $('delivery-panel').classList.toggle('loading',rank >= 0);$('delivery-panel').setAttribute('aria-busy',String(rank >= 0));
  renderProgressContext();
}
function renderProgressContext() {
  const purchase = current();
  const pending = purchase && !finalStatuses.has(purchase.status);
  const descriptions = {fetching:'The provider is preparing your result. Delivery evidence has not arrived yet.',validating:'Motto is checking the result against your quoted requirements.',settling:'The delivery check is complete. Waiting for the payment provider’s settlement result.',paid:'The server reported payment. Inspect the delivered sources and signed receipt.',refunded:'The delivery did not pass all checks. The server reported return of the quoted hold.',settle_failed:'Settlement is unconfirmed. Inspect this purchase before authorizing another payment.',interrupted:'This purchase was interrupted. Inspect its record before trying again.'};
  text('progress-detail',connectionState === 'denied' ? 'Purchase activity requires access. Connect through API access to view current records.' : pending && connectionState !== 'live' ? 'Updates disconnected. Showing the last reported state while retrying the connection.' : descriptions[purchase?.status] || 'Select a purchase to follow its reported state.');
  const since = stateSeenAt.get(purchase?.id);
  text('progress-age',pending && since ? `${Math.max(0,Math.floor((Date.now() - since)/1000))}s since status received` : '');
}
function renderMotion(purchase) {
  const same = motionRecord?.id === purchase?.id;
  const split = JSON.stringify([purchase?.charged_usd,purchase?.returned_usd]);
  const moneyCard = document.querySelector('.money-card'), receipt = document.querySelector('.receipt-card');
  if (!same) {
    $('purchase-status').classList.remove('status-arrived');moneyCard.classList.remove('money-arrived');receipt.classList.remove('receipt-arrived');$('delivery-panel').classList.remove('attention-arrived');
    for (const id of ['record-charged','record-returned']) $(id).classList.remove('amount-arrived');
  } else if (purchase) {
    if (motionRecord.status !== purchase.status) {
      animate($('purchase-status'),'status-arrived');
      if (['settle_failed','interrupted'].includes(purchase.status)) animate($('delivery-panel'),'attention-arrived');
    }
    if (['paid','refunded'].includes(purchase.status) && split !== motionRecord.split) {
      animate(moneyCard,'money-arrived');
      for (const id of ['record-charged','record-returned']) animate($(id),'amount-arrived');
    }
    if (purchase.reading && !motionRecord.evidence) animate(receipt,'receipt-arrived');
  }
  motionRecord = purchase ? {id:purchase.id,status:purchase.status,split,evidence:Boolean(purchase.reading)} : undefined;
}
function renderSources(purchase) {
  const reading = purchase?.reading;
  text('result-query',purchase ? purchase.title || purchase.input?.query || purchase.service || 'Agent purchase' : 'Select a purchase to inspect its delivery and payment.');
  text('result-reason',purchase?.reason || reading?.reason || '');
  text('result-limitations',reading?.limitations || (purchase ? 'Acceptance checks and their limits are recorded in the signed receipt.' : ''));
  const key = JSON.stringify([purchase?.id,reading?.deliverable?.citations,finalStatuses.has(purchase?.status)]);
  if (key === deliveryRenderKey) return;
  deliveryRenderKey = key;
  const fragment = document.createDocumentFragment();
  for (const [index,citation] of (reading?.deliverable?.citations ?? []).entries()) {
    const article = document.createElement('article');article.className = 'citation' + (motionRecord?.id === purchase?.id && !motionRecord?.evidence ? ' appear' : '');article.style.setProperty('--arrival-delay',`${index * 70}ms`);
    const number = document.createElement('span');number.className = 'citation-number';number.textContent = String(index + 1).padStart(2,'0');
    const content = document.createElement('div');
    const title = document.createElement('a');title.textContent = citation.title || 'Untitled source';
    if (typeof citation.doi === 'string' && /^10\.\d{4,9}\/\S+$/i.test(citation.doi)) {title.href = 'https://doi.org/' + encodeURIComponent(citation.doi);title.target = '_blank';title.rel = 'noopener';}
    const meta = document.createElement('p');meta.className = 'citation-meta';meta.textContent = [citation.publisher,citation.year,citation.doi].filter(value => value != null && value !== '').join(' · ');
    content.append(title,meta);article.append(number,content);fragment.append(article);
  }
  if (!fragment.childNodes.length) {
    const empty = document.createElement('p');empty.className = 'quiet';
    empty.textContent = !purchase ? 'Delivery evidence will appear here.' : finalStatuses.has(purchase.status) ? 'No delivery records were reported.' : 'Waiting for the provider result.';
    fragment.append(empty);
  }
  $('citations').replaceChildren(fragment);
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
  const devnet = purchase?.network === 'devnet';
  $('explorer').hidden = !(validTx && (mainnet || devnet));
  if (validTx && (mainnet || devnet)) $('explorer').href = 'https://explorer.solana.com/tx/' + purchase.settlement_tx + (devnet ? '?cluster=devnet' : '');
  text('chain-note',['localnet','devnet'].includes(purchase?.network) ? `Test USDC on ${purchase.network}. This record is not a real-money payment.` : 'The server reports settlement. This workspace does not independently confirm chain finality.');
}
function render() {
  renderHistory();
  const purchase = current();
  renderProgress(purchase);renderSources(purchase);renderReceipt(purchase);
  text('record-budget',money(purchase?.max_spend_usd));text('record-ceiling',money(purchase?.ceiling_usd));
  const uncertain = purchase && ['settle_failed','interrupted'].includes(purchase.status);
  text('record-charged',uncertain ? 'Unconfirmed' : money(purchase?.charged_usd));
  text('record-returned',uncertain ? 'Unconfirmed' : money(purchase?.returned_usd));
  renderMotion(purchase);
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
      text('network',catalog.network === 'localnet' ? 'Localnet · test USDC' : catalog.network === 'devnet' ? 'Devnet · test USDC' : `${catalog.network} · USDC`);
      text('signing-key',`Signer ${short(catalog.signing_public_key)}`);
    }
    const response = await request('/v1/purchases');
    if (version !== accessVersion) return;
    if (!Array.isArray(response.purchases)) throw new Error('Server returned an invalid purchase history.');
    response.purchases.forEach(ingest);
    if (!selectedId) selectedId = [...purchases.values()].sort((a,b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0]?.id;
    connectionState = 'live';document.body.dataset.connection = connectionState;
    text('connection','Connected · polling purchases');$('connection').classList.add('online');
    text('footer-status','Connected to Motto');render();
  } catch (error) {
    if (version !== accessVersion) return;
    connectionState = [401,403].includes(error.status) ? 'denied' : 'offline';document.body.dataset.connection = connectionState;renderProgressContext();
    text('connection',error.message);$('connection').classList.remove('online');text('footer-status','Purchase history unavailable');
  } finally {syncing = false;clearTimeout(syncTimer);syncTimer = setTimeout(sync,version === accessVersion ? 3000 : 0);}
}
$('access-open').addEventListener('click',() => { $('api-key').value = ''; $('access-dialog').showModal(); });
$('access-form').addEventListener('submit',event => {
  event.preventDefault();accessVersion++;apiKey = $('api-key').value.trim();$('api-key').value = '';purchases.clear();verification.clear();stateSeenAt.clear();connectionState = 'offline';document.body.dataset.connection = connectionState;selectedId = undefined;catalog = undefined;render();$('access-dialog').close();clearTimeout(syncTimer);sync();
});
$('verify').addEventListener('click',verifyReceipt);
$('download-receipt').addEventListener('click',() => {
  const purchase = current();if (!purchase?.reading) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(purchase.reading,null,2)],{type:'application/json'}));
  const link = document.createElement('a');link.href = url;link.download = `motto-receipt-${purchase.id.replace(/[^a-zA-Z0-9_-]/g,'')}.json`;link.click();setTimeout(() => URL.revokeObjectURL(url),1000);
});
$('raw').addEventListener('click',() => {text('raw-json',JSON.stringify(current(),null,2));$('raw-dialog').showModal();});
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click',() => button.closest('dialog').close());
setInterval(renderProgressContext,1000);
render();sync();
