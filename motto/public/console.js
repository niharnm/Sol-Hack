'use strict';
const $ = id => document.getElementById(id);
const holds = new Map(), eventLog = [];
let terms, selectedId, inspected = 'receipt', live = false, ready = false, followNewest = true;
const queue = [], verification = new Map();
const pending = h => h && ['checking','waiting_for_power','waiting_for_display','judging'].includes(h.status);
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
  if (followNewest || !holds.has(selectedId)) selectedId = sorted[0]?.id;
}
function node(name,state) { const el=document.querySelector(`[data-node="${name}"]`); el.classList.remove('observed','working','error'); if (state) el.classList.add(state); }
function renderRuns() {
  text('run-count',String(holds.size));
  const list=[...holds.values()].sort((a,b)=>(b.startedAt??0)-(a.startedAt??0));
  const frag=document.createDocumentFragment();
  for (const h of list) {
    const b=document.createElement('button'); b.className='run'+(selectedId===h.id?' selected':'')+(['settle_failed','interrupted'].includes(h.status)?' failed':'');
    b.setAttribute('aria-pressed',String(selectedId===h.id));
    const title=document.createElement('div'); title.className='run-title'; title.textContent=human(h.item); title.append(document.createElement('i'));
    const meta=document.createElement('div'); meta.className='run-meta'; const id=document.createElement('span'),status=document.createElement('span');id.textContent=h.id;status.textContent=human(h.status);meta.append(id,status);b.append(title,meta);
    b.onclick=()=>{selectedId=h.id;followNewest=false;render();};frag.append(b);
  }
  $('runs').replaceChildren(frag);
  if(!list.length) {const p=document.createElement('p');p.className='muted pad';p.textContent='No executions yet. Run an agent or a sandbox request.';$('runs').append(p);}
}
function renderEvents() {
  const entries=eventLog.filter(e=>!selectedId||e.id===selectedId);
  const frag=document.createDocumentFragment();
  for (const e of entries.slice(0,30)) {
    const row=document.createElement('div');row.className='event';const ts=document.createElement('time');ts.textContent=time(e.at);
    const content=document.createElement('div'),title=document.createElement('b'),desc=document.createElement('small');title.textContent=human(e.status);desc.textContent=(e.source==='snapshot'?'Loaded API record · ':'Live desk event · ')+human(e.detail);content.append(title,desc);row.append(ts,content);frag.append(row);
  }
  $('events').replaceChildren(frag);
  if(!entries.length) {const p=document.createElement('p');p.className='muted';p.textContent='Waiting for desk events. No synthetic activity.';$('events').append(p);}
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
    terms:['Terms & budget','Published service terms. This does not prove that the selected buyer fetched them.',[['Service',h?.item],['Check',terms?.items?.[h?.item]?.check],['Maximum authorization',terms?.items?.[h?.item]?.hold_usd],['Check fee',terms?.items?.[h?.item]?.check_fee_usd]]],
    authorize:['Payment authorization','The desk creates a hold record after Pay.sh accepts the paid request.',[['Hold',h?.id],['Payer',h?.payer],['Authorized ceiling',h?.hold_usd],['Opened',h?.startedAt?new Date(h.startedAt).toISOString():null]]],
    evidence:['Evidence check','Machine readings and, when available, condition-verifier evidence from the selected receipt.',[['Condition',r?.condition??terms?.items?.[h?.item]?.check],['Reading',r?.raw??h?.raw],['Evidence',r?.evidence],['Timestamp',r?.ts?new Date(r.ts).toISOString():null]]],
    decision:['Settlement decision','The desk’s reported outcome. A verified need is not necessarily proof that a service was provisioned.',[['Outcome',h?.outcome],['Reason',r?.reason??h?.detail],['Verifier model',r?.model??'Device check; no model recorded'],['Model cost','Not measured by this API']]],
    settle:['Solana settlement','Pay.sh reports the settlement result. This console does not independently query chain finality.',[['Payment scheme','x402 upto'],['Record network',h?.network??'Not recorded on this older hold'],['Status',h?.status],['Settlement error',h?.settleError??'None reported']]],
    receipt:['Signed receipt','Inspect the exact evidence returned by the desk and verify its Ed25519 signature locally.',[['Hold',h?.id],['Service',h?.item],['Outcome',h?.outcome],['Reason',r?.reason??h?.detail]]]
  }[inspected];
  text('inspector-title',data[0]);text('inspector-desc',data[1]);fields(data[2]);
  const signed=Boolean(r?.signature && r?.devicePublicKey);
  $('verify').disabled=!signed;
  text('signature-state',verification.get(h?.id)??(signed?'Signature present · not yet verified':'No signed reading available.'));
  text('transaction',h?.settlementTx??'No settlement signature reported');
  const mainnet=['mainnet','mainnet-beta'].includes(h?.network);
  const valid=typeof h?.settlementTx==='string'&&/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(h.settlementTx);
  $('explorer').hidden=!(mainnet&&valid);
  if(mainnet&&valid)$('explorer').href='https://explorer.solana.com/tx/'+h.settlementTx;
  text('chain-note',h?.network==='localnet'?'Sandbox transaction · test USDC. No mainnet Explorer link.':!h?.network?'This older record has no network field. Explorer linking is unavailable.':'Signature reported by Pay.sh; chain finality is not independently checked here.');
  text('raw-json',JSON.stringify(h??{},null,2));$('raw-link').href=h?'/v1/holds/'+encodeURIComponent(h.id):'/v1/holds';
}
function render() {
  const h=current();renderRuns();renderEvents();
  text('run-id',h?.id??'AWAITING REQUEST');text('run-title',h?human(h.item)+' / '+(h.reading?.condition??'conditional payment'):'Observe the entire payment path.');
  text('run-status',human(h?.status??'idle').toUpperCase());$('graph').classList.toggle('running',Boolean(pending(h)));
  node('authorize',h?'observed':null);node('evidence',pending(h)?'working':h?.reading?'observed':null);node('decision',h?.outcome?'observed':null);node('settle',settled(h)?'observed':['settle_failed','interrupted'].includes(h?.status)?'error':null);node('receipt',h?.reading?.signature?'observed':null);
  text('authorize-label',h?usd(h.hold_usd)+' ceiling accepted':'Awaiting paid request');
  text('evidence-label',h?.status==='waiting_for_power'?'Waiting for power':h?.status==='waiting_for_display'?'Waiting for display':h?.status==='judging'?'Model evaluating evidence':pending(h)?'Reading device':h?.reading?'Reading returned':'Device / condition');
  text('decision-label',human(h?.outcome??'Waiting for evidence'));
  text('settle-label',settled(h)?usd(h.charged_usd)+' charged':h?.status==='settle_failed'?'Settlement failed':'No confirmed result');
  text('receipt-label',h?.reading?.signature?'Ed25519 signature present':'Awaiting signature');
  text('ceiling',usd(h?.hold_usd));text('charged',settled(h)?usd(h.charged_usd):'—');text('returned',settled(h)?usd(h.returned_usd):'—');
  text('ledger-note',settled(h)?'Returned authorization is not a measured savings claim.':'Amounts appear only after a successful desk settlement.');inspect();
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
    terms=results[0].value;text('network',terms.network==='localnet'?'SOLANA / SANDBOX':'SOLANA / '+terms.network.toUpperCase());text('device-key','Device '+short(terms.devicePublicKey));
    $('services').replaceChildren(...Object.keys(terms.items??{}).map(name=>{const e=document.createElement('span');e.className='service';e.textContent=human(name);return e;}));
  }
  if(results[1].status==='fulfilled')for(const h of results[1].value.holds??[])ingest(h,'snapshot');
  ready=true;for(const h of queue.splice(0))ingest(h,'live');render();
  if(results.some(r=>r.status==='rejected'))setTimeout(sync,5000);
}
document.querySelectorAll('[data-node]').forEach(n=>n.onclick=()=>{inspected=n.dataset.node;inspect();});
$('verify').onclick=verifyReading;$('launch').onclick=()=>$('launch-dialog').showModal();$('raw').onclick=()=>$('raw-dialog').showModal();
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close());
$('copy-agent').onclick=async()=>{try{await navigator.clipboard.writeText('node demo/run-agent.mjs');text('copy-agent','Copied');}catch{text('copy-agent','Select and copy the command above');}};
$('fullscreen').onclick=()=>{const promise=document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen();promise?.catch(()=>{});};
const events=new EventSource('/v1/events');let opened=false;
events.onopen=()=>{connection(true);if(opened)sync();opened=true;};events.onerror=()=>connection(false);events.onmessage=e=>{try{const h=JSON.parse(e.data);if(!ready)queue.push(h);else{ingest(h,'live');render();}}catch{}};
render();sync();
