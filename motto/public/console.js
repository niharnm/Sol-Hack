'use strict';
const $ = id => document.getElementById(id);
const holds = new Map(), eventLog = [];
const visible = () => [...holds.values()].sort((a,b)=>(b.startedAt??0)-(a.startedAt??0));
let terms, selectedId, inspected = 'receipt', live = false, ready = false, followNewest = true;
const queue = [], verification = new Map();
let deliveryKey = '', previousSelection;
const statusNames = {checking:'Funds authorized',fetching:'Provider in progress',validating:'Validating result',settling:'Settling payment',kept:'Settled',refunded:'Funds returned',settle_failed:'Payment unconfirmed',interrupted:'Interrupted'};
const serviceName = item => human(item).replace(/\b\w/g,c=>c.toUpperCase());
let privateRecords=false;
let motionRecord, eventRenderKey = "", eventRecordId;
const stateSeenAt = new Map();
function animate(el, name='appear') { el.classList.remove(name); void el.offsetWidth; el.classList.add(name); }
function renderProgress(h) {
  const state=h?.status, attention=['settle_failed','interrupted'].includes(state);
  const step=!h?-1:state==='checking'?0:state==='fetching'?1:state==='validating'?2:3;
  const evidenceFailed=['check_failed','inconclusive','not_delivered'].includes(h?.outcome);
  document.querySelectorAll('[data-step]').forEach(el=>{
    const n=Number(el.dataset.step);
    // Payment completion does not turn an unsuccessful evidence check into a success.
    const failed=(n===2&&evidenceFailed)||(n===step&&attention);
    const complete=!failed&&(n<step || (n===step&&settled(h)))&&(state!=='interrupted'||n===0);
    const samePurchase=motionRecord?.id===h?.id;
    if(!samePurchase)el.classList.remove('step-arrived','step-alert');
    if(samePurchase&&complete&&!el.classList.contains('done'))animate(el,'step-arrived');
    if(samePurchase&&failed&&!el.classList.contains('failed'))animate(el,'step-alert');
    el.classList.toggle('done',complete);el.classList.toggle('active',n===step&&!complete&&!failed);el.classList.toggle('failed',failed);
    if(n===step&&pending(h))el.setAttribute('aria-current','step');else el.removeAttribute('aria-current');
  });
  text('process-label',statusNames[state]??(h?human(state):'Ready for a request'));
  text('progress-count',!h?'Awaiting purchase':settled(h)?'Payment complete':attention?'Needs attention':'In progress');
  $('delivery-panel').classList.toggle('loading',Boolean(pending(h)));
  $('delivery-panel').setAttribute('aria-busy',String(Boolean(pending(h))));
  renderProgressContext();
}

// Status explanations and elapsed time report observations, never estimated completion.
function renderProgressContext(){
  const h=current();
  if(privateRecords&&!h){text('progress-detail','Purchase activity is private on this connection.');text('progress-age','');return;}
  const explanations={
    checking:'Payment authorization received. Waiting for the service check.',
    fetching:'The provider is preparing your result. Evidence has not arrived yet.',
    validating:'Motto is checking the result against the acceptance rules.',
    settling:'The check has finished. Waiting for the payment result from Pay.sh.',
    kept:'Settlement reported. Inspect the outcome and receipt for what was verified.',
    refunded:'Return of funds reported. The money card shows the final split.',
    settle_failed:'Payment is unconfirmed. Inspect this receipt before trying again.',
    interrupted:'This purchase was interrupted. Inspect the receipt before trying again.'
  };
  const disconnected=h&&pending(h)&&!live;
  text('progress-detail',privateRecords&&pending(h)?'Use Recover / refresh result to check this purchase again without paying.':disconnected?'Live updates disconnected. Showing the last known state; reconnecting…':explanations[h?.status]??'Purchases from your agent appear here. Each step updates when Motto reports it.');
  const latest=h?.steps?.at(-1), since=latest&&latest.status===h?.status?latest.at:stateSeenAt.get(h?.id);
  const seconds=Math.max(0,Math.floor((Date.now()-Number(since))/1000));
  text('progress-age',pending(h)&&Number.isFinite(seconds)?`${seconds}s since ${latest?'step changed':'status received'}`:'');
}
function renderMotion(h){
  const same=motionRecord?.id===h?.id;
  if(!same){
    $('run-status').classList.remove('status-arrived');
    document.querySelector('.money-card').classList.remove('money-arrived');
    document.querySelector('.receipt-card').classList.remove('receipt-arrived');
    document.querySelector('.journey').classList.remove('attention-arrived');
    for(const id of ['charged','returned'])$(id).classList.remove('amount-arrived');
  }
  if(same&&h){
    if(motionRecord.status!==h.status){
      animate($('run-status'),'status-arrived');
      animate($('process-label'),'appear');
      if(['settle_failed','interrupted'].includes(h.status))animate(document.querySelector('.journey'),'attention-arrived');
    }
    const split=JSON.stringify([h.charged_usd,h.returned_usd]);
    if(settled(h)&&split!==motionRecord.split){
      // Keep exact amounts visible throughout the highlight; do not count invented money.
      animate(document.querySelector('.money-card'),'money-arrived');
      for(const id of ['charged','returned'])animate($(id),'amount-arrived');
    }
    if(h.reading&&!motionRecord.evidence)animate(document.querySelector('.receipt-card'),'receipt-arrived');
  }
  motionRecord=h?{id:h.id,status:h.status,split:JSON.stringify([h.charged_usd,h.returned_usd]),evidence:Boolean(h.reading)}:undefined;
}
const pending = h => h && ['checking','fetching','validating','settling'].includes(h.status);
const settled = h => h && ['kept','refunded'].includes(h.status);
const rank = h => h?.status === 'checking' ? 0 : pending(h) ? 1 : 2;
const human = s => String(s ?? '').replaceAll('_',' ');
const usd = v => v == null ? '—' : '$' + Number(v).toFixed(2);
const short = s => s ? String(s).slice(0,8) + '…' + String(s).slice(-6) : '—';
const time = t => t ? new Date(t).toLocaleTimeString([], {hour12:false}) : '—';
const get = async path => { const r = await fetch(path); if (!r.ok) throw Object.assign(new Error(`${path}: ${r.status}`),{status:r.status}); return r.json(); };
function text(id, value) { const el=$(id);if(el.textContent!==String(value))el.textContent=value; }
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
  if (!previous || previous.status !== h.status) {addEvent(h,source);stateSeenAt.set(h.id,Date.now());}
  const sorted = [...holds.values()].sort((a,b)=>(b.startedAt??0)-(a.startedAt??0));
  for (const old of sorted.slice(500)) {holds.delete(old.id);stateSeenAt.delete(old.id);}
  if (followNewest || !holds.has(selectedId)) { const next=visible()[0]?.id; selectedId=next; }
}
function node(name,state) { const el=document.querySelector(`[data-node="${name}"]`); el.classList.remove('observed','working','error'); if (state) el.classList.add(state); }
function renderRuns() {
  text('run-count',String(visible().length));
  const list=visible();
  const frag=document.createDocumentFragment();
  for (const h of list) {
    const b=document.createElement('button'); b.className='run'+(selectedId===h.id?' selected':'')+(['settle_failed','interrupted'].includes(h.status)?' failed':'');
    b.classList.toggle('running',Boolean(pending(h)));
    b.setAttribute('aria-pressed',String(selectedId===h.id));
    const title=document.createElement('div'); title.className='run-title'; title.textContent=h.title??h.query??h.reading?.query??serviceName(h.item); title.append(document.createElement('i'));
    const meta=document.createElement('div'); meta.className='run-meta'; const id=document.createElement('span'),status=document.createElement('span');id.textContent=h.id;status.textContent=statusNames[h.status]??human(h.status);meta.append(id,status);b.append(title,meta);
    b.onclick=()=>{selectedId=h.id;followNewest=h.id===list[0]?.id;render();};frag.append(b);
  }
  $('runs').replaceChildren(frag);
  if(!list.length) {const p=document.createElement('p');p.className='muted pad';p.textContent=privateRecords?'Purchase history is private on this connection.':'Your purchases will appear here.';$('runs').append(p);}
}
function renderEvents() {
  const h=current();
  const entries=h?.steps?.length ? [...h.steps].reverse().map(step=>({...step,source:'recorded',detail:''})) : eventLog.filter(e=>e.id===selectedId);
  const key=JSON.stringify([h?.id,entries.slice(0,30)]);
  if(key===eventRenderKey)return;
  const newEvent=eventRecordId===h?.id&&Boolean(eventRenderKey);
  eventRenderKey=key;eventRecordId=h?.id;
  const frag=document.createDocumentFragment();
  for (const e of entries.slice(0,30)) {
    const row=document.createElement('div');row.className='event'+(newEvent&&!frag.childNodes.length?' event-arrived':'');const ts=document.createElement('time');ts.textContent=time(e.at);
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
  const signed=Boolean(r?.signature && r?.devicePublicKey), verifying=verification.get(h?.id)==='Verifying…';
  $('verify').disabled=!signed||verifying;
  $('verify').setAttribute('aria-busy',String(verifying));
  $('download-receipt').disabled=!h;
  $('signature-state').classList.toggle('verified',verification.get(h?.id)?.startsWith('Verified')??false);
  text('signature-state',verification.get(h?.id)??(signed?'Signature present · not yet verified':'No signed delivery available.'));
  text('transaction',h?.settlementTx??'No settlement signature reported');
  const mainnet=['mainnet','mainnet-beta'].includes(h?.network), devnet=h?.network==='devnet';
  const valid=typeof h?.settlementTx==='string'&&/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(h.settlementTx);
  $('explorer').hidden=!((mainnet||devnet)&&valid);
  if((mainnet||devnet)&&valid)$('explorer').href='https://explorer.solana.com/tx/'+h.settlementTx+(devnet?'?cluster=devnet':'');
  text('chain-note',h?.network==='localnet'?'Test USDC settlement · separate from mainnet.':!h?.network?'This older record has no network field. Explorer linking is unavailable.':'Signature reported by Pay.sh; chain finality is not independently checked here.');
  text('raw-json',JSON.stringify(holds.get(selectedId)??{},null,2));$('raw-link').hidden=privateRecords;$('raw-link').href=h?'/v1/holds/'+encodeURIComponent(h.id):'/v1/holds';
}
function renderDelivery(h) {
  const r=h?.reading;
  text('purchase-kind',h?serviceName(h.item).toUpperCase():'YOUR PURCHASE');
  text('purchase-query',h?(h.title??h.query??h.reading?.query??serviceName(h.item)):'A clear outcome. A visible money trail.');
  text('delivery-count',pending(h)?'IN PROGRESS':r?'EVIDENCE RECORDED':'AWAITING PURCHASE');
  text('purchase-contract',r?.reason??r?.detail??h?.detail??(h?'Waiting for the seller to report an outcome.':'Select a purchase to see its outcome and payment details.'));
  const nextKey=JSON.stringify([h?.id,h?.status,r]);
  if(nextKey===deliveryKey)return;deliveryKey=nextKey;
  const p=document.createElement('p');p.className='empty-evidence';
  p.textContent=!h?'Your purchases and supporting evidence will appear here.':pending(h)?'Your purchase is in progress. Updates appear automatically.':r?'Open the receipt to inspect the recorded evidence and verify its signature.':'No evidence was recorded. Inspect the receipt before trying again.';
  $('citations').replaceChildren(p);
  if(r?.deliverable){
    p.textContent='Delivered result';
    for(const c of r.deliverable.citations??[]){
      const row=document.createElement('article');row.className='result-record';
      const title=document.createElement('h4');title.textContent=c.title;
      const detail=document.createElement('p');detail.textContent=[c.doi,c.publisher].filter(Boolean).join(' · ');row.append(title,detail);
      try{const url=new URL(c.url);if(url.protocol==='https:'&&url.hostname==='doi.org'){const a=document.createElement('a');a.href=url.href;a.target='_blank';a.rel='noopener';a.textContent='Open DOI ↗';row.append(a);}}catch{}
      $('citations').append(row);
    }
    if(!r.deliverable.citations){const pre=document.createElement('pre');pre.textContent=JSON.stringify(r.deliverable,null,2);$('citations').append(pre);}
  }
  if(r?.checks){const check=document.createElement('p');check.textContent='Acceptance checks: '+Object.entries(r.checks).map(([k,v])=>human(k)+': '+v).join(' · ');$('citations').append(check);}
  const limits=document.createElement('p');limits.className='verification-limits';limits.textContent=r?.limitations??'Verification is limited to the recorded acceptance checks. A valid signature proves the desk signed this evidence; it does not independently prove its truth or chain finality.';$('citations').append(limits);
}

function render() {
  const h=current();
  text('record-network',h?'SOLANA · '+(h.network??'Network not recorded').toUpperCase():'');
  text('check-fee',usd(h?.check_fee_usd));
  text('failure-action',['settle_failed','interrupted'].includes(h?.status)?'Do not pay again yet. Recover this purchase with your saved key, download the receipt, and ask the desk operator to reconcile its settlement.':h?.status==='refunded'?'Inspect the acceptance checks below. Confirm the returned amount before deciding whether to make a new purchase.':'');
  renderRuns();renderEvents();renderDelivery(h);renderProgress(h);
  if(previousSelection!==selectedId){animate($('delivery-panel'));previousSelection=selectedId;}
  text('run-id',h?.id??'NO PURCHASE SELECTED');text('run-title',h?(h.title??h.query??h.reading?.query??serviceName(h.item)):'Your purchases, in one place.');
  $('open-receipt').disabled=!h;
  $('run-status').dataset.state=!h?'ready':settled(h)?'settled':pending(h)?'pending':'attention';
  text('run-status',(statusNames[h?.status]??human(h?.status??'ready')).toUpperCase());$('graph').classList.toggle('running',Boolean(pending(h)));
  node('authorize',h?'observed':null);node('evidence',pending(h)?'working':h?.reading?'observed':null);node('decision',h?.outcome?'observed':null);node('settle',settled(h)?'observed':['settle_failed','interrupted'].includes(h?.status)?'error':null);node('receipt',h?.reading?.signature?'observed':null);
  text('authorize-label',h?usd(h.hold_usd)+' ceiling accepted':'Awaiting paid request');
  text('evidence-label',h?.status==='fetching'?'Waiting for the seller':h?.status==='validating'?'Checking acceptance rules':pending(h)?'Purchase in progress':h?.reading?'Provider result returned':'Provider response / contract');
  text('decision-label',human(h?.outcome??'Waiting for evidence'));
  text('settle-label',settled(h)?usd(h.charged_usd)+' charged':h?.status==='settle_failed'?'Not confirmed':'No confirmed result');
  text('receipt-label',h?.reading?.signature?'Ed25519 signature present':'Awaiting signature');
  text('ceiling',usd(h?.hold_usd));text('charged',settled(h)?usd(h.charged_usd):'—');text('returned',settled(h)?usd(h.returned_usd):'—');
  text('money-status',!h?'No funds authorized':settled(h)?'Settlement reported by Pay.sh':h.status==='settle_failed'?'Settlement unconfirmed · inspect receipt':h.status==='interrupted'?'Purchase interrupted · inspect receipt':'Authorization recorded · settlement pending');
  text('ledger-note',settled(h)?(h.reading?.reason??h.detail??'Settlement reported. Inspect your receipt for the evidence and payment details.'):h?'The ceiling is not a final charge. Settled and returned amounts appear when confirmed by the desk.':'Authorize a maximum. Motto checks the evidence and settles according to the service terms.');inspect();renderMotion(h);
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
  } catch(e) {verification.set(id,'Not verified: '+e.message+'. This browser may not support signature verification.');}
  if(selectedId===id)inspect();
}
function connection(ok) {if(privateRecords){live=false;document.body.dataset.stream='offline';text('connection','● private activity');$('connection').classList.remove('online');text('footer-status','Purchase activity is private on this connection');renderProgressContext();return;}live=ok;document.body.dataset.stream=ok?'live':'offline';renderProgressContext();text('connection',ok?'● stream live':'● reconnecting');$('connection').classList.toggle('online',ok);text('footer-status',ok?'Purchases update live':'Disconnected · showing last received records');}
async function sync() {
  const results=await Promise.allSettled([get('/v1/terms'),get('/v1/holds')]);
  if(results[0].status==='fulfilled'){
    terms=results[0].value;
    renderOffers();
    text('network',terms.network==='localnet'?'SOLANA · LOCALNET':terms.network==='devnet'?'SOLANA · DEVNET':'SOLANA / '+terms.network.toUpperCase());text('device-key','Signer '+short(terms.devicePublicKey));

  }
  if(results[1].status==='fulfilled')for(const h of results[1].value.holds??[])ingest(h,'snapshot');
  if(results[1].status==='rejected'&&[401,403].includes(results[1].reason.status)){privateRecords=true;events.close();connection(false);}
  ready=true;for(const h of queue.splice(0))ingest(h,'live');render();
  if(results.some(r=>r.status==='rejected'&&![401,403].includes(r.reason.status))){text('footer-status','Unable to load purchase updates. Reconnecting…');setTimeout(sync,5000);}
}
document.querySelectorAll('[data-node]').forEach(n=>n.onclick=()=>{inspected=n.dataset.node;inspect();});

$('open-receipt').onclick=()=>{inspected='receipt';inspect();$('receipt-dialog').showModal();};
$('verify').onclick=verifyReading;$('raw').onclick=()=>$('raw-dialog').showModal();
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close());
$('fullscreen').onclick=()=>{const promise=document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen();promise?.catch(()=>{});};
const events=new EventSource('/v1/events');let opened=false;
events.onopen=()=>{connection(true);if(opened)sync();opened=true;};events.onerror=()=>connection(false);events.onmessage=e=>{try{const h=JSON.parse(e.data);if(!ready)queue.push(h);else{ingest(h,'live');render();}}catch{}};
render();sync();
setInterval(()=>{if(!document.hidden)renderProgressContext();},1000);

$('download-receipt').onclick=()=>{
  const h=current();if(!h)return;
  const url=URL.createObjectURL(new Blob([JSON.stringify(h,null,2)],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download=`motto-receipt-${h.id}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};

function download(name,value){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
const quote=value=>"'"+String(value).replaceAll("'", "'\"'\"'")+"'";
let ticket;
function renderOffers(){
  text('offer-network','SOLANA · '+terms.network.toUpperCase()+(terms.network==='devnet'||terms.network==='localnet'?' · Test USDC':''));
  $('offers').replaceChildren();
  for(const [name,offer] of Object.entries(terms.items??{})){
    const card=document.createElement('article');card.className='offer-card';
    const title=document.createElement('h3');title.textContent=name==='research'?'Three citation records':serviceName(name);
    const price=document.createElement('p');price.className='offer-price';price.textContent=usd(offer.hold_usd)+' USDC authorization · '+usd(offer.check_fee_usd)+' check fee';
    const description=document.createElement('p');description.textContent=offer.check;
    const rules=document.createElement('ul');for(const rule of Object.values(offer.rules??{})){const li=document.createElement('li');li.textContent=rule;rules.append(li);}
    card.append(title,price,description,rules);
    if(name==='research'){
      const limits=document.createElement('p');limits.textContent='Checks count, unique DOI identifiers and nonempty titles. Does not verify relevance, paper quality, DOI resolution or full-text access. Uses public Crossref metadata.';card.append(limits);
      const form=document.createElement('form'),label=document.createElement('label'),input=document.createElement('input'),button=document.createElement('button');
      label.htmlFor='offer-query';label.textContent='Search query';input.id='offer-query';input.required=true;input.minLength=3;input.maxLength=200;input.placeholder='e.g. battery recycling';button.type='submit';button.className='secondary';button.textContent='Get purchase instructions';form.append(label,input,button);form.onsubmit=e=>{e.preventDefault();prepareInstructions(name,offer,{query:input.value.trim()});};card.append(form);
    }
    $('offers').append(card);
  }
  if(!$('offers').children.length)text('offers','No offers are currently available.');
}
function prepareInstructions(name,offer,body){
  const key=Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
  ticket={desk:location.origin,network:terms.network,item:name,recoveryKey:key,requestKey:crypto.randomUUID()};
  const headers=`-H ${quote('Content-Type: application/json')} -H ${quote('Idempotency-Key: '+ticket.requestKey)} -H ${quote('X-Motto-Recovery-Key: '+key)}`;
  text('terms-command',`npx @solana/pay curl ${quote(location.origin+'/v1/terms')}`);
  const supported=terms.network==='localnet'||['mainnet','mainnet-beta'].includes(terms.network);
  text('instructions-note',supported?'Review the published ceiling and approve it in Pay CLI. Keep the same recovery key if the request times out.':'This desk uses Devnet test USDC. The paid command uses the repository’s Devnet Pay SDK buyer (run from motto/ with a funded local buyer wallet). Pay CLI commands below review terms and recover results without payment.');
  text('purchase-command',supported?`npx @solana/pay ${terms.network==='localnet'?'--sandbox':'--mainnet'} curl -X POST ${quote(location.origin+'/v1/buy/'+name)} ${headers} -d ${quote(JSON.stringify(body))}`:`node scripts/buy-service.mjs ${quote(name)} ${quote(JSON.stringify(body))} ${quote(location.origin)} ${quote(offer.hold_usd)} ${quote(ticket.requestKey)} ${quote(key)}`);
  text('recovery-command',`npx @solana/pay curl -X POST ${quote(location.origin+'/v1/results/recover')} -H ${quote('Authorization: Bearer '+key)}`);
  $('recovery-key').value=key;text('copy-status','');$('instructions-dialog').showModal();
}
$('save-ticket').onclick=()=>{if(ticket)download('motto-private-recovery.json',ticket);};
document.querySelectorAll('[data-copy]').forEach(b=>b.onclick=async()=>{try{await navigator.clipboard.writeText($(b.dataset.copy).textContent);text('copy-status','Copied.');}catch{text('copy-status','Clipboard unavailable. Select and copy the command above.');}});
$('recovery-form').onsubmit=async e=>{
  e.preventDefault();const button=e.target.querySelector('button');button.disabled=true;text('recovery-status','Checking this purchase…');
  try{
    const response=await fetch('/v1/results/recover',{method:'POST',headers:{Authorization:'Bearer '+$('recovery-key').value.trim()},signal:AbortSignal.timeout(15000)});
    const result=await response.json();if(!response.ok)throw new Error(result.error??'Recovery failed.');
    const h={id:result.hold_id,item:result.item,status:result.status,outcome:result.outcome,hold_usd:result.hold_usd,check_fee_usd:result.check_fee_usd,charged_usd:result.charged_usd,returned_usd:result.returned_usd,settleError:result.settle_error,detail:result.reason,reading:result.signed_reading,settlementTx:result.settlement_tx,network:result.network,startedAt:result.started_at,steps:result.steps};
    ingest(h,'recovered');selectedId=h.id;followNewest=false;render();text('recovery-status','Purchase recovered. '+(pending(h)?'Refresh again for the latest result.':'Review the result and receipt below.'));
  }catch(error){text('recovery-status',error.name==='TimeoutError'?'Recovery timed out. Try recovery again; do not submit another payment.':error.message);}
  finally{button.disabled=false;}
};
