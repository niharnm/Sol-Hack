'use strict';
const $ = id => document.getElementById(id);
const holds = new Map(), eventLog = [];
let includeDevice = false;
const digital = h => ['research','verify'].includes(h.item);
const visible = () => [...holds.values()].filter(h=>includeDevice || digital(h)).sort((a,b)=>(b.startedAt??0)-(a.startedAt??0));
let terms, selectedId, inspected = 'receipt', live = false, ready = false, followNewest = true;
const queue = [], verification = new Map();
let deliveryKey = '', previousSelection, submitting = false;
const statusNames = {checking:'Payment authorized',fetching:'Finding sources',validating:'Checking result',settling:'Issuing payment & receipt',kept:'Delivered',refunded:'Refunded',settle_failed:'Payment unconfirmed',interrupted:'Interrupted'};
function animate(el) { el.classList.remove('appear'); void el.offsetWidth; el.classList.add('appear'); }
function renderProgress(h) {
  const state=h?.status;
  const step=!h?-1:state==='checking'?0:state==='fetching'?1:state==='settling'?3:pending(h)?2:3;
  document.querySelectorAll('[data-step]').forEach(el=>{
    const n=Number(el.dataset.step),complete=n<step || (n===step&&settled(h));
    el.classList.toggle('done',complete);el.classList.toggle('active',n===step&&!complete);el.classList.toggle('failed',n===step&&['settle_failed','interrupted'].includes(state));
  });
  text('process-label',statusNames[state]??(h?human(state):'Ready for a request'));
  text('progress-count',`${!h?0:settled(h)?4:Math.max(0,step)} / 4 complete`);
  $('delivery-panel').classList.toggle('loading',Boolean(pending(h)));
}
const pending = h => h && ['checking','waiting_for_power','waiting_for_delivery','judging','fetching','validating','settling'].includes(h.status);
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
    const title=document.createElement('div'); title.className='run-title'; title.textContent=h.item==='research'?(h.query??h.reading?.query??'Research sources'):human(h.item); title.append(document.createElement('i'));
    const meta=document.createElement('div'); meta.className='run-meta'; const id=document.createElement('span'),status=document.createElement('span');id.textContent=h.id;status.textContent=h.item==='research'&&h.status==='kept'?'delivered':(statusNames[h.status]??human(h.status));meta.append(id,status);b.append(title,meta);
    b.onclick=()=>{selectedId=h.id;followNewest=h.id===list[0]?.id;render();};frag.append(b);
  }
  $('runs').replaceChildren(frag);
  if(!list.length) {const p=document.createElement('p');p.className='muted pad';p.textContent='No digital purchases yet. Select New purchase to request a research pack.';$('runs').append(p);}
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
    decision:['Settlement decision','The desk’s reported outcome. A verified need is not necessarily proof that a service was provisioned.',[['Outcome',h?.outcome],['Reason',r?.reason??h?.detail],['Verifier model',r?.model??'Deterministic checks; no model recorded'],['Model cost','Not measured by this API']]],
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
  text('purchase-query',pack?.query??h?.query??'Three DOI-backed sources for a technical brief.');
  text('delivery-count',pack ? `${pack.citations.length} / 3 SOURCES` : pending(h)?'IN PROGRESS':'AWAITING PURCHASE');
  text('purchase-contract',r?.checks ? `${r.checks.received_count} of 3 sources · unique DOI IDs · titles checked` : '3 sources · unique DOI IDs · titles required');
  const nextKey=JSON.stringify([selectedId,Boolean(pending(h)),pack]);
  if(nextKey===deliveryKey)return;deliveryKey=nextKey;
  const frag=document.createDocumentFragment();
  for(const c of pack?.citations??[]) {
    const card=document.createElement('article');card.className='citation appear';card.style.setProperty('--order',String(frag.childNodes.length));
    const label=document.createElement('span');label.className='eyebrow';label.textContent=c.publisher??'CROSSREF RECORD';
    const a=document.createElement('a');a.textContent=c.title;
    try {const u=new URL(c.url);if(u.protocol==='https:'&&u.hostname==='doi.org'){a.href=u.href;a.target='_blank';a.rel='noopener';}}catch{}
    const doi=document.createElement('code');doi.textContent=c.doi;card.append(label,a,doi);frag.append(card);
  }
  $('citations').replaceChildren(frag);
  if(!pack?.citations?.length){const p=document.createElement('p');p.className='muted pad';p.textContent=pending(h)?'Working on your request…':'Your sources will appear here.';$('citations').append(p);}
}

function render() {
  const h=current();
  if(submitting && pending(h))text('request-feedback',statusNames[h.status]??human(h.status));
  renderRuns();renderEvents();renderDelivery(h);renderProgress(h);
  if(previousSelection!==selectedId){animate($('delivery-panel'));previousSelection=selectedId;}
  text('run-id',h?.id??'AWAITING REQUEST');text('run-title',h?'Your purchase':'Ready when you are.');
  text('run-status',h?.item==='research'&&h.status==='kept'?'DELIVERED':(statusNames[h?.status]??human(h?.status??'idle')).toUpperCase());$('graph').classList.toggle('running',Boolean(pending(h)));
  node('authorize',h?'observed':null);node('evidence',pending(h)?'working':h?.reading?'observed':null);node('decision',h?.outcome?'observed':null);node('settle',settled(h)?'observed':['settle_failed','interrupted'].includes(h?.status)?'error':null);node('receipt',h?.reading?.signature?'observed':null);
  text('authorize-label',h?usd(h.hold_usd)+' ceiling accepted':'Awaiting paid request');
  text('evidence-label',h?.status==='waiting_for_power'?'Waiting for power':h?.status==='waiting_for_delivery'?'Waiting for delivery':h?.status==='judging'?'Model evaluating evidence':h?.status==='fetching'?'Fetching Crossref records':h?.status==='validating'?'Checking citation contract':pending(h)?'Running service':h?.reading?'Evidence returned':'Provider response / contract');
  text('decision-label',human(h?.outcome??'Waiting for evidence'));
  text('settle-label',settled(h)?usd(h.charged_usd)+' charged':h?.status==='settle_failed'?'Not confirmed':'No confirmed result');
  text('receipt-label',h?.reading?.signature?'Ed25519 signature present':'Awaiting signature');
  text('ceiling',usd(h?.hold_usd));text('charged',settled(h)?usd(h.charged_usd):'—');text('returned',settled(h)?usd(h.returned_usd):'—');
  text('ledger-note',settled(h)?'Payment completed. Your signed delivery is ready.':'Amounts appear only after a successful desk settlement.');inspect();
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
    if(!terms.console_purchase)text('request-feedback','Remote console: enter a topic to get its paid API command.');text('network',terms.network==='localnet'?'SOLANA · LOCALNET':terms.network==='devnet'?'SOLANA · DEVNET':'SOLANA / '+terms.network.toUpperCase());text('device-key','Signer '+short(terms.devicePublicKey));
    $('services').replaceChildren(...Object.entries(terms.items??{}).filter(([name])=>['research','verify'].includes(name)).map(([name,it])=>{const e=document.createElement('span');e.className='service';e.textContent=human(name)+'  '+usd(it?.hold_usd)+' hold · '+(Number(it?.check_fee_usd)>0?usd(it.check_fee_usd)+' check':'no check fee');if(it?.covers)e.title=it.covers;return e;}));
    const item=(/\/v1\/rent\/([a-z_]+)/.exec($('purchase-command')?.textContent??'')||[])[1]??'charger',ceiling=terms.items?.[item]?.hold_usd;if(ceiling!=null&&$('dialog-ceiling'))text('dialog-ceiling',usd(ceiling)+' test USDC');
  }
  if(results[1].status==='fulfilled')for(const h of results[1].value.holds??[])ingest(h,'snapshot');
  ready=true;for(const h of queue.splice(0))ingest(h,'live');render();
  if(results.some(r=>r.status==='rejected'))setTimeout(sync,5000);
}
document.querySelectorAll('[data-node]').forEach(n=>n.onclick=()=>{inspected=n.dataset.node;inspect();});

$('include-device').onchange=e=>{includeDevice=e.target.checked;selectedId=visible()[0]?.id;followNewest=true;render();};
$('verify').onclick=verifyReading;$('launch').onclick=()=>{$('request-query').focus();$('request-query').scrollIntoView({block:'center',behavior:'smooth'});};$('raw').onclick=()=>$('raw-dialog').showModal();
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close());
$('copy-agent').onclick=async()=>{try{await navigator.clipboard.writeText($('purchase-command').textContent);text('copy-agent','Copied');}catch{text('copy-agent','Select and copy the command above');}};
$('fullscreen').onclick=()=>{const promise=document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen();promise?.catch(()=>{});};
const events=new EventSource('/v1/events');let opened=false;
events.onopen=()=>{connection(true);if(opened)sync();opened=true;};events.onerror=()=>connection(false);events.onmessage=e=>{try{const h=JSON.parse(e.data);if(!ready)queue.push(h);else{ingest(h,'live');render();}}catch{}};
render();sync();

document.querySelectorAll('[data-topic]').forEach(button=>button.onclick=()=>{ $('request-query').value=button.dataset.topic; $('request-query').focus(); });
$('request-form').onsubmit=async event=>{
  event.preventDefault(); if(submitting || !terms)return;
  const query=$('request-query').value.trim(); if(query.length<3)return;
  if(!terms.console_purchase){
    const body=JSON.stringify({query}).replaceAll("'", "'\\''");
    if(terms.network==='devnet'){
      text('purchase-command',`cd motto && npm run buy:devnet -- '${query.replaceAll("'", "'\\''")}' '${location.origin}'`);
      $('launch-dialog').showModal();return;
    }
    const network=terms.network==='localnet'?'--sandbox':'--mainnet';
    text('purchase-command',`npx --yes --package @solana/pay pay ${network} curl -sS -X POST ${location.origin}/v1/rent/research -H 'Content-Type: application/json' -d '${body}'`);
    $('launch-dialog').showModal();return;
  }
  submitting=true; followNewest=true; $('request-submit').disabled=true;
  text('request-submit','Working…');text('request-feedback','Authorizing test USDC. Your live purchase will appear below.');
  try{
    const response=await fetch('/v1/console/purchase',{method:'POST',headers:{'Content-Type':'application/json','X-Motto-Console':'1'},body:JSON.stringify({query})});
    const result=await response.json();if(!response.ok)throw new Error(result.error??'Purchase failed');
    const hold=await get('/v1/holds/'+encodeURIComponent(result.hold_id));ingest(hold,'live');selectedId=hold.id;render();
    text('request-feedback',hold.status==='kept'?'Sources delivered. Open a source or verify your receipt.':hold.status==='refunded'?'Incomplete delivery. Your authorization was returned.':'Payment needs attention. Inspect the receipt.');
  }catch(error){text('request-feedback',error.message);}
  finally{submitting=false;$('request-submit').disabled=false;text('request-submit','Find 3 sources ↗');}
};

$('download-receipt').onclick=()=>{
  const h=current();if(!h?.reading)return;
  const url=URL.createObjectURL(new Blob([JSON.stringify(h,null,2)],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download=`motto-receipt-${h.id}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
