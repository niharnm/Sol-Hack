'use strict';
const $ = id => document.getElementById(id);
const holds = new Map(), eventLog = [];
const visible = () => [...holds.values()].filter(h=>h.item==='research').sort((a,b)=>(b.startedAt??0)-(a.startedAt??0));
let terms, selectedId, inspected = 'receipt', live = false, ready = false, followNewest = true;
const queue = [], verification = new Map();
let deliveryKey = '', previousSelection, submitting = false;
const statusNames = {checking:'Funds authorized',fetching:'Provider in progress',validating:'Validating result',settling:'Settling payment',kept:'Delivered',refunded:'Funds returned',settle_failed:'Payment unconfirmed',interrupted:'Interrupted'};
const serviceNames = {research:'Research source pack'};
const serviceName = item => serviceNames[item] ?? human(item);
let reviewedRequest;
function animate(el) { el.classList.remove('appear'); void el.offsetWidth; el.classList.add('appear'); }
function renderProgress(h) {
  const state=h?.status, attention=['settle_failed','interrupted'].includes(state);
  const step=!h?-1:state==='checking'?0:state==='fetching'?1:state==='validating'?2:3;
  const evidenceFailed=['check_failed','inconclusive','not_delivered'].includes(h?.outcome);
  document.querySelectorAll('[data-step]').forEach(el=>{
    const n=Number(el.dataset.step);
    // Payment completion does not turn an unsuccessful evidence check into a success.
    const failed=(n===2&&evidenceFailed)||(n===step&&attention);
    const complete=!failed&&(n<step || (n===step&&settled(h)))&&(state!=='interrupted'||n===0);
    el.classList.toggle('done',complete);el.classList.toggle('active',n===step&&!complete&&!failed);el.classList.toggle('failed',failed);
    if(n===step&&pending(h))el.setAttribute('aria-current','step');else el.removeAttribute('aria-current');
  });
  text('process-label',statusNames[state]??(h?human(state):'Ready for a request'));
  text('progress-count',!h?'Awaiting purchase':settled(h)?'Payment complete':attention?'Needs attention':'In progress');
  $('delivery-panel').classList.toggle('loading',Boolean(pending(h)));
}
const pending = h => h && ['checking','fetching','validating','settling'].includes(h.status);
const settled = h => h && ['kept','refunded'].includes(h.status);
const rank = h => h?.status === 'checking' ? 0 : pending(h) ? 1 : 2;
const human = s => String(s ?? '').replaceAll('_',' ');
const usd = v => v == null ? '—' : '$' + Number(v).toFixed(2);
const short = s => s ? String(s).slice(0,8) + '…' + String(s).slice(-6) : '—';
const time = t => t ? new Date(t).toLocaleTimeString([], {hour12:false}) : '—';
const get = async path => { const r = await fetch(path); if (!r.ok) throw new Error(`${path}: ${r.status}`); return r.json(); };
function text(id, value) { $(id).textContent = value; }
function current() { return holds.get(selectedId); }
function addEvent(h, source) {
  eventLog.unshift({id:h.id,status:h.status,at:Date.now(),source,detail:h.detail || h.reading?.reason || h.item});
  if (eventLog.length > 200) eventLog.pop();
}
function ingest(h, source) {
  if (!h || typeof h.id !== 'string') return;
  const previous = holds.get(h.id);
  if (previous && rank(h) < rank(previous)) return;
  holds.set(h.id, {...previous,...h});
  if (!previous || previous.status !== h.status) addEvent(h,source);
  const sorted = [...holds.values()].sort((a,b)=>(b.startedAt??0)-(a.startedAt??0));
  for (const old of sorted.slice(500)) holds.delete(old.id);
  if (followNewest || !holds.has(selectedId)) { const next=visible()[0]?.id; selectedId=next; }
}
function node(name,state) { const el=document.querySelector(`[data-node="${name}"]`); el.classList.remove('observed','working','error'); if (state) el.classList.add(state); }
function renderRuns() {
  text('run-count',String(visible().length));
  const list=visible();
  const frag=document.createDocumentFragment();
  for (const h of list) {
    const b=document.createElement('button'); b.className='run'+(selectedId===h.id?' selected':'')+(['settle_failed','interrupted'].includes(h.status)?' failed':'');
    b.setAttribute('aria-pressed',String(selectedId===h.id));
    const title=document.createElement('div'); title.className='run-title'; title.textContent=h.item==='research'?(h.query??h.reading?.query??serviceName(h.item)):serviceName(h.item); title.append(document.createElement('i'));
    const meta=document.createElement('div'); meta.className='run-meta'; const id=document.createElement('span'),status=document.createElement('span');id.textContent=h.id;status.textContent=statusNames[h.status]??human(h.status);meta.append(id,status);b.append(title,meta);
    b.onclick=()=>{selectedId=h.id;followNewest=h.id===list[0]?.id;render();};frag.append(b);
  }
  $('runs').replaceChildren(frag);
  if(!list.length) {const p=document.createElement('p');p.className='muted pad';p.textContent='Your purchases will appear here.';$('runs').append(p);}
}
function renderEvents() {
  const h=current();
  const entries=h?.steps?.length ? [...h.steps].reverse().map(step=>({...step,source:'recorded',detail:''})) : eventLog.filter(e=>e.id===selectedId);
  const frag=document.createDocumentFragment();
  for (const e of entries.slice(0,30)) {
    const row=document.createElement('div');row.className='event';const ts=document.createElement('time');ts.textContent=time(e.at);
    const content=document.createElement('div'),title=document.createElement('b'),desc=document.createElement('small');title.textContent=statusNames[e.status]??human(e.status);desc.textContent=e.detail?human(e.detail):'Receipt '+selectedId;content.append(title,desc);row.append(ts,content);frag.append(row);
  }
  $('events').replaceChildren(frag);
  if(!entries.length) {const p=document.createElement('p');p.className='muted';p.textContent='Your purchase activity will appear here.';$('events').append(p);}
}
function fields(entries) {
  const frag=document.createDocumentFragment();
  for(const [label,value] of entries) {const f=document.createElement('div');f.className='field';const l=document.createElement('label'),v=document.createElement('div');l.textContent=label;v.textContent=value == null ? 'Not recorded' : typeof value==='object'?JSON.stringify(value,null,2):String(value);f.append(l,v);frag.append(f);}
  $('detail-fields').replaceChildren(frag);
}
function inspect() {
  const h=current(), r=h?.reading;
  document.querySelectorAll('[data-node]').forEach(n=>n.classList.toggle('inspected',n.dataset.node===inspected));
  text('inspector-type',inspected.toUpperCase());
  const data={
    agent:['Buyer agent','The desk sees the payer address. Agent identity, task, and tool calls are not included in this API stream.',[['Payer',h?.payer],['Agent trace','Observe the buyer terminal']]],
    terms:['Terms & budget','Published service terms. This does not prove that the selected buyer fetched them.',[['Service',h?.item],['Check',terms?.items?.[h?.item]?.check],['Maximum authorization',terms?.items?.[h?.item]?.hold_usd],['Check fee',terms?.items?.[h?.item]?.check_fee_usd],['Covers',terms?.items?.[h?.item]?.covers]]],
    authorize:['Payment authorization','The desk creates a hold record after Pay.sh accepts the paid request.',[['Hold',h?.id],['Payer',h?.payer],['Authorized ceiling',h?.hold_usd],['Check fee',h?.check_fee_usd],['Opened',h?.startedAt?new Date(h.startedAt).toISOString():null]]],
    evidence:['Evidence check','Acceptance checks and provider evidence for the purchased result.',[['Contract',r?.condition??terms?.items?.[h?.item]?.check],['Provider',r?.provider??h?.provider],['Checks',r?.checks],['Evidence',r?.evidence??r?.raw??h?.raw],['Timestamp',r?.ts?new Date(r.ts).toISOString():null]]],
    decision:['Settlement decision','Motto uses the validation result to decide the charged and returned amounts.',[['Outcome',h?.outcome],['Reason',r?.reason??h?.detail],['Validation','Deterministic structural checks'],['Model cost','Not measured by this API']]],
    settle:['Solana settlement','Pay.sh reports the settlement result. This console does not independently query chain finality.',[['Payment scheme','x402 upto'],['Record network',h?.network??'Not recorded on this older hold'],['Status',h?.status],['Settlement error',h?.settleError??'None reported']]],
    receipt:['Signed receipt','Inspect the exact deliverable and evidence returned by Motto and verify its Ed25519 signature locally.',[['Hold',h?.id],['Service',h?.item],['Outcome',h?.outcome],['Check fee',h?.check_fee_usd],['Reason',r?.reason??h?.detail]]]
  }[inspected];
  text('inspector-title',data[0]);text('inspector-desc',data[1]);fields(data[2]);
  const signed=Boolean(r?.signature && r?.devicePublicKey);
  $('verify').disabled=!signed;
  $('download-receipt').disabled=!h?.reading;
  $('signature-state').classList.toggle('verified',verification.get(h?.id)?.startsWith('Verified')??false);
  text('signature-state',verification.get(h?.id)??(signed?'Signature present · not yet verified':'No signed delivery available.'));
  text('transaction',h?.settlementTx??'No settlement signature reported');
  const mainnet=['mainnet','mainnet-beta'].includes(h?.network), devnet=h?.network==='devnet';
  const valid=typeof h?.settlementTx==='string'&&/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(h.settlementTx);
  $('explorer').hidden=!((mainnet||devnet)&&valid);
  if((mainnet||devnet)&&valid)$('explorer').href='https://explorer.solana.com/tx/'+h.settlementTx+(devnet?'?cluster=devnet':'');
  text('chain-note',h?.network==='localnet'?'Test USDC settlement · separate from mainnet.':!h?.network?'This older record has no network field. Explorer linking is unavailable.':'Signature reported by Pay.sh; chain finality is not independently checked here.');
  text('raw-json',JSON.stringify(holds.get(selectedId)??{},null,2));$('raw-link').href=h?'/v1/holds/'+encodeURIComponent(h.id):'/v1/holds';
}
function renderDelivery(h) {
  const r=h?.reading, pack=r?.deliverable;
  text('purchase-kind',h?serviceName(h.item).toUpperCase():'YOUR PURCHASE');
  text('purchase-query',h?(pack?.query??h.query??serviceName(h.item)):'A clear outcome. A visible money trail.');
  text('delivery-count',pack ? `${pack.citations?.length??0} RECORDS` : pending(h)?'IN PROGRESS':r?'EVIDENCE RECORDED':'AWAITING PURCHASE');
  const reason=r?.reason??r?.detail??h?.detail;
  text('purchase-contract',reason??(h?terms?.items?.[h.item]?.check??'Waiting for the service to report evidence.':'Select a service above. Motto will show what was checked and why funds moved.'));
  const nextKey=JSON.stringify([selectedId,h?.status,pack,reason]);
  if(nextKey===deliveryKey)return;deliveryKey=nextKey;
  const frag=document.createDocumentFragment();
  for(const c of pack?.citations??[]) {
    const card=document.createElement('article');card.className='citation appear';
    const label=document.createElement('span');label.className='eyebrow';label.textContent=c.publisher??'CROSSREF RECORD';
    const a=document.createElement('a');a.textContent=c.title;
    try {const u=new URL(c.url);if(u.protocol==='https:'&&u.hostname==='doi.org'){a.href=u.href;a.target='_blank';a.rel='noopener';}}catch{}
    const doi=document.createElement('code');doi.textContent=c.doi;card.append(label,a,doi);frag.append(card);
  }
  $('citations').replaceChildren(frag);
  if(!pack?.citations?.length){
    const p=document.createElement('p');p.className='empty-evidence';
    p.textContent=!h?'Your outcome and supporting evidence will appear here.':pending(h)?'The desk is working. This page updates automatically.':r?'Evidence recorded. Open the receipt to inspect the check and verify its signature.':'No evidence was recorded. Inspect the receipt before trying again.';
    $('citations').append(p);
  }
}

function render() {
  const h=current();
  if(submitting && pending(h))text('request-feedback',statusNames[h.status]??human(h.status));
  renderRuns();renderEvents();renderDelivery(h);renderProgress(h);
  if(previousSelection!==selectedId){animate($('delivery-panel'));previousSelection=selectedId;}
  text('run-id',h?.id??'NO PURCHASE SELECTED');text('run-title',h?serviceName(h.item):'Your next purchase starts here.');
  $('open-receipt').disabled=!h;
  $('run-status').dataset.state=!h?'ready':settled(h)?'settled':pending(h)?'pending':'attention';
  text('run-status',(statusNames[h?.status]??human(h?.status??'ready')).toUpperCase());$('graph').classList.toggle('running',Boolean(pending(h)));
  node('authorize',h?'observed':null);node('evidence',pending(h)?'working':h?.reading?'observed':null);node('decision',h?.outcome?'observed':null);node('settle',settled(h)?'observed':['settle_failed','interrupted'].includes(h?.status)?'error':null);node('receipt',h?.reading?.signature?'observed':null);
  text('authorize-label',h?usd(h.hold_usd)+' ceiling accepted':'Awaiting paid request');
  text('evidence-label',h?.status==='fetching'?'Fetching Crossref records':h?.status==='validating'?'Checking citation contract':pending(h)?'Running virtual service':h?.reading?'Provider result returned':'Provider response / contract');
  text('decision-label',human(h?.outcome??'Waiting for evidence'));
  text('settle-label',settled(h)?usd(h.charged_usd)+' charged':h?.status==='settle_failed'?'Not confirmed':'No confirmed result');
  text('receipt-label',h?.reading?.signature?'Ed25519 signature present':'Awaiting signature');
  text('ceiling',usd(h?.hold_usd));text('charged',settled(h)?usd(h.charged_usd):'—');text('returned',settled(h)?usd(h.returned_usd):'—');
  text('money-status',!h?'No funds authorized':settled(h)?'Settlement reported by Pay.sh':h.status==='settle_failed'?'Settlement unconfirmed · inspect receipt':h.status==='interrupted'?'Purchase interrupted · inspect receipt':'Authorization recorded · settlement pending');
  text('ledger-note',settled(h)?(h.reading?.reason??h.detail??'Settlement reported. Inspect your receipt for the evidence and payment details.'):h?'The ceiling is not a final charge. Settled and returned amounts appear when confirmed by the desk.':'Authorize a maximum. Motto checks the evidence and settles according to the service terms.');inspect();
}
async function verifyReading() {
  const h=current();if(!h?.reading?.signature)return;
  const id=h.id;verification.set(id,'Verifying…');inspect();
  try {
    const {signature,devicePublicKey,...payload}=h.reading;
    const bytes=hex=>{if(!/^(?:[a-fA-F0-9]{2})+$/.test(hex))throw new Error('Invalid hex');return Uint8Array.from(hex.match(/../g),b=>parseInt(b,16));};
    if(payload.holdId!==id)throw new Error('Hold mismatch');
    const key=await crypto.subtle.importKey('raw',bytes(devicePublicKey),{name:'Ed25519'},false,['verify']);
    const valid=await crypto.subtle.verify('Ed25519',key,bytes(signature),new TextEncoder().encode(JSON.stringify(payload)));
    if(!valid)throw new Error('Signature invalid');
    verification.set(id,devicePublicKey===terms?.devicePublicKey?'Verified · matches current desk key':'Signature valid · differs from current desk key');
  } catch(e) {verification.set(id,'Not verified: '+e.message+'. Use node demo/verify-proof.mjs if Ed25519 is unsupported.');}
  if(selectedId===id)inspect();
}
function connection(ok) {live=ok;text('connection',ok?'● stream live':'● reconnecting');$('connection').classList.toggle('online',ok);text('footer-status',ok?'Live desk event stream':'Disconnected · showing last received records');}
async function sync() {
  const results=await Promise.allSettled([get('/v1/terms'),get('/v1/holds')]);
  if(results[0].status==='fulfilled'){
    terms=results[0].value;
    populateServices();text('network',terms.network==='localnet'?'SOLANA · LOCALNET':terms.network==='devnet'?'SOLANA · DEVNET':'SOLANA / '+terms.network.toUpperCase());text('device-key','Signer '+short(terms.devicePublicKey));

  }
  if(results[1].status==='fulfilled')for(const h of results[1].value.holds??[])ingest(h,'snapshot');
  ready=true;for(const h of queue.splice(0))ingest(h,'live');render();
  if(results.some(r=>r.status==='rejected')){text('request-feedback','Some desk data could not be loaded. Reconnecting automatically…');setTimeout(sync,5000);}
}
document.querySelectorAll('[data-node]').forEach(n=>n.onclick=()=>{inspected=n.dataset.node;inspect();});

$('request-service').onchange=updateComposer;
$('open-receipt').onclick=()=>{inspected='receipt';inspect();$('receipt-dialog').showModal();};
$('verify').onclick=verifyReading;$('launch').onclick=()=>{$('request-service').focus();$('request-form').scrollIntoView({block:'center',behavior:'smooth'});};$('raw').onclick=()=>$('raw-dialog').showModal();
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close());
$('copy-agent').onclick=async()=>{try{await navigator.clipboard.writeText($('purchase-command').textContent);text('copy-agent','Copied');}catch{text('copy-agent','Select and copy the command above');}};
$('fullscreen').onclick=()=>{const promise=document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen();promise?.catch(()=>{});};
const events=new EventSource('/v1/events');let opened=false;
events.onopen=()=>{connection(true);if(opened)sync();opened=true;};events.onerror=()=>connection(false);events.onmessage=e=>{try{const h=JSON.parse(e.data);if(!ready)queue.push(h);else{ingest(h,'live');render();}}catch{}};
render();sync();

const shellQuote = value => "'"+String(value).replaceAll("'", "'\\''")+"'";
function populateServices(){
  const selected=$('request-service').value;
  const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='Choose a service';
  const options=Object.keys(terms.items??{}).map(name=>{const option=document.createElement('option');option.value=name;option.textContent=serviceName(name);return option;});
  $('request-service').replaceChildren(placeholder,...options);$('request-service').disabled=false;
  if(terms.items?.[selected])$('request-service').value=selected;
  updateComposer();
}
function updateComposer(){
  const item=$('request-service').value, contract=terms?.items?.[item], input=$('request-query');
  const needsText=item==='research';
  input.disabled=!needsText;input.required=needsText;input.minLength=3;input.maxLength=200;
  text('request-label',item==='research'?'Topic':'Request');
  input.placeholder=item==='research'?'e.g. battery recycling':'Choose the available service';
  if(!needsText)input.value='';
  text('request-budget',contract?usd(contract.hold_usd)+' USDC':'—');
  $('request-submit').disabled=!contract||submitting;
  text('request-feedback',!contract?'Choose an available virtual service. Review its checks and payment rules before authorizing.':'Three citation records. Structural validation only; not a relevance or quality guarantee.');
}
$('request-form').onsubmit=event=>{
  event.preventDefault();if(submitting||!terms)return;
  const item=$('request-service').value,contract=terms.items?.[item];if(!contract)return;
  const query=$('request-query').value.trim();
  if(item!=='research'||query.length<3){text('request-feedback','Enter a research topic of at least three characters.');return;}
  const body={query};
  reviewedRequest={item,body};
  const requestKey=crypto.randomUUID();
  text('review-title',serviceName(item));text('review-description',[contract.covers,contract.check].filter(Boolean).join('. '));text('review-budget',usd(contract.hold_usd)+' USDC');
  $('review-rules').replaceChildren(...Object.values(contract.rules??{}).map(rule=>{const li=document.createElement('li');li.textContent=rule;return li;}));
  const local=item==='research'&&terms.console_purchase;
  $('confirm-purchase').hidden=!local;$('command-section').hidden=local;
  text('confirm-purchase','Authorize '+usd(contract.hold_usd)+' test USDC');
  text('review-note',local?'This uses the hosting laptop’s test buyer wallet. The maximum is a hold, not an immediate final charge.': 'Use your own buyer wallet. This page cannot spend the hosting wallet remotely. '+(terms.network==='mainnet'?'This desk uses real funds.':'This desk uses test USDC.'));
  const origin=shellQuote(location.origin), payload=shellQuote(JSON.stringify(body));
  const command=terms.network==='devnet'
    ? `cd motto && node scripts/buy-service.mjs ${shellQuote(item)} ${payload} ${origin} ${shellQuote(contract.hold_usd)} ${shellQuote(requestKey)}`
    : `npx --yes --package @solana/pay pay ${terms.network==='localnet'?'--sandbox':'--mainnet'} curl -sS -X POST ${shellQuote(location.origin+'/v1/buy/'+item)} -H 'Content-Type: application/json' -H ${shellQuote('Idempotency-Key: '+requestKey)} -d ${payload}`;
  text('purchase-command',command);text('copy-agent','Copy purchase command');$('launch-dialog').showModal();
};
$('confirm-purchase').onclick=async()=>{
  if(submitting||reviewedRequest?.item!=='research'||!terms?.console_purchase)return;
  const request=reviewedRequest;submitting=true;followNewest=true;$('request-submit').disabled=true;$('confirm-purchase').disabled=true;$('launch-dialog').close();
  text('request-submit','Working…');text('request-feedback','Authorizing test USDC. Follow the live purchase below.');
  try{
    const response=await fetch('/v1/console/purchase',{method:'POST',headers:{'Content-Type':'application/json','X-Motto-Console':'1'},body:JSON.stringify(request.body)});
    const result=await response.json();if(!response.ok)throw new Error(result.error??'Purchase failed');
    const hold=await get('/v1/holds/'+encodeURIComponent(result.hold_id));ingest(hold,'live');selectedId=hold.id;render();
    text('request-feedback',settled(hold)?'Purchase settled. Review the outcome and your receipt below.':'Payment needs attention. Inspect the receipt before trying again.');
  }catch(error){text('request-feedback',error.message+' Inspect existing purchases before retrying.');}
  finally{submitting=false;$('request-submit').disabled=false;$('confirm-purchase').disabled=false;text('request-submit','Review purchase ↗');}
};

$('download-receipt').onclick=()=>{
  const h=current();if(!h?.reading)return;
  const url=URL.createObjectURL(new Blob([JSON.stringify(h,null,2)],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download=`motto-receipt-${h.id}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
