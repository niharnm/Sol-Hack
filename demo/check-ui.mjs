// Isolated browser contract checks. Fixtures never authorize wallets or payments.
// PLAYWRIGHT_MODULE=/path/to/playwright node demo/check-ui.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const publicDir = fileURLToPath(new URL('../motto/public/',import.meta.url));
const screenshots = process.env.UI_SCREENSHOT_DIR || join(tmpdir(),'motto-ui-check');
await mkdir(screenshots,{recursive:true});
const { privateKey,publicKey } = generateKeyPairSync('ed25519');
const signingKey = publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex');
const catalog = {network:'devnet',signing_public_key:signingKey,services:{research:{pricing:{unit_usd:'0.07',max_units:20}}},console:{local_pay:false}};
let records = [], writes = 0, requireKey = false, historyUnavailable = false;
const fixtureKey = 'fixture-access-key';
function signedReading(purchase, passed) {
  const reading = {purchase_id:purchase.id,quote_id:purchase.quote_id,service:'research',outcome:passed?'delivered':'inconclusive',units_delivered:passed?purchase.input.count:0,checks:{passed},deliverable:{citations:passed?[{title:'Fixture source',doi:'10.1234/fixture',year:2025,publisher:'Fixture publisher'}]:[]},charge_usd:passed?purchase.ceiling_usd:'0.00'};
  return {...reading,signature:sign(null,Buffer.from(JSON.stringify(reading)),privateKey).toString('hex'),devicePublicKey:signingKey};
}
function makePurchase(status, acceptedQuote, extra = {}) {
  return {id:'fixture-purchase',quote_id:acceptedQuote?.id || 'fixture-quote',service:'research',input:acceptedQuote?.input || {query:'Fixture topic',count:4},max_spend_usd:acceptedQuote?.max_spend_usd || '5.00',ceiling_usd:acceptedQuote?.ceiling_usd || '0.28',charged_usd:null,returned_usd:null,created_at:new Date().toISOString(),updated_at:new Date().toISOString(),network:'devnet',status,...extra};
}
const server = createServer(async(req,res) => {
  try {
    const path = new URL(req.url,'http://localhost').pathname;
    const json = (value,status = 200) => {res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    if (path === '/v1/services') return json(catalog);
    if (path.startsWith('/v1/') && requireKey && req.headers.authorization !== `Bearer ${fixtureKey}`) return json({error:'Workspace API key required.'},401);
    if (path === '/v1/purchases') return json(historyUnavailable ? {error:'Fixture history unavailable.'} : {purchases:records},historyUnavailable ? 503 : 200);
    if (req.method !== 'GET') {writes++;return json({error:'Read-only purchase tracker.'},405);}
    const file = resolve(publicDir,path === '/' ? 'index.html' : '.'+path);
    if (!file.startsWith(publicDir)) return json({},404);
    try {const data = await readFile(file);res.writeHead(200,{'Content-Type':file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':file.endsWith('.woff2')?'font/woff2':'text/html'});res.end(data);}
    catch (error) {if (error.code !== 'ENOENT') throw error;return json({},404);}
  } catch (error) {res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {})});
  const page = await browser.newPage({viewport:{width:1280,height:900}}), errors = [];
  page.on('pageerror',error => errors.push(error.message));
  const text = selector => page.locator(selector).innerText();
  const load = async list => {records = list;await page.goto(base);await page.waitForFunction(() => document.body.dataset.connection === 'live');};
  const poll = async () => {await page.evaluate(async() => {while(syncing) await new Promise(resolve => setTimeout(resolve,10));await sync();});};
  await load([]);
  assert.equal(await page.locator('#request-form, #quote-panel, #purchase-submit').count(),0);
  assert.equal(await page.locator('.beta').count(),0);
  assert.equal(await text('#record-charged'),'Not recorded');
  assert.equal(await page.locator('#verify').isDisabled(),true);
  await page.screenshot({path:join(screenshots,'desktop-empty.png'),fullPage:true});
  console.log('PASS tracker has no manual checkout, beta badge, or fabricated payment amounts');

  let purchase = makePurchase('fetching');await load([purchase]);
  assert.equal(await page.locator('[data-step="fetching"]').getAttribute('aria-current'),'step');
  assert.equal(await page.locator('#delivery-panel').getAttribute('aria-busy'),'true');
  assert.match(await text('#progress-detail'),/provider is preparing/);
  assert.equal(await page.locator('.step.active').evaluate(element => getComputedStyle(element,'::after').animationName),'working-ring');
  historyUnavailable = true;await poll();
  assert.equal(await page.locator('body').getAttribute('data-connection'),'offline');assert.match(await text('#progress-detail'),/disconnected/);
  assert.equal(await page.locator('.step.active').evaluate(element => getComputedStyle(element,'::after').animationPlayState),'paused');
  historyUnavailable = false;await poll();
  await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await page.locator('.step.active').evaluate(element => getComputedStyle(element,'::after').animationName),'none');await page.emulateMedia({reducedMotion:'no-preference'});
  await page.evaluate(() => {window.moneyAnimations = 0;document.querySelector('.money-card').addEventListener('animationstart',event => {if(event.animationName === 'money-highlight') window.moneyAnimations++;});});
  purchase = {...purchase,status:'refunded',charged_usd:'0.00',returned_usd:'0.28',updated_at:new Date().toISOString()};purchase.reading = signedReading(purchase,false);records = [purchase];await poll();
  assert.equal(await text('#record-budget'),'5.00 USDC');assert.equal(await text('#record-ceiling'),'0.28 USDC');assert.equal(await text('#record-returned'),'0.28 USDC');assert.equal(await page.locator('[data-step="validating"]').evaluate(element => element.classList.contains('failed')),true);assert.equal(await page.locator('[data-step="settling"]').evaluate(element => element.classList.contains('done')),true);
  assert.equal(await page.locator('.step.active').count(),0);assert.equal(await page.locator('#delivery-panel').getAttribute('aria-busy'),'false');
  await page.waitForFunction(() => window.moneyAnimations === 1);await poll();assert.equal(await page.evaluate(() => window.moneyAnimations),1);
  await page.click('#verify');await page.waitForFunction(() => document.getElementById('signature-state').textContent.startsWith('Verified'));
  const download = page.waitForEvent('download');await page.click('#download-receipt');assert.match((await download).suggestedFilename(),/fixture-purchase/);
  console.log('PASS reported-state motion, offline pause, reduced motion, exact refund highlight once, failed acceptance and signed receipt');

  const originalReading = purchase.reading;
  purchase = {...purchase,reading:{...originalReading,units_delivered:42}};await load([purchase]);await page.click('#verify');
  await page.waitForFunction(() => document.getElementById('signature-state').textContent.startsWith('Not verified'));
  assert.match(await text('#signature-state'),/signature is invalid/);purchase = {...purchase,reading:originalReading};
  console.log('PASS modified receipt payload fails signature verification');

  purchase = {...purchase,status:'settle_failed',charged_usd:null,returned_usd:null,updated_at:new Date().toISOString()};await load([purchase]);
  assert.equal(await text('#record-charged'),'Unconfirmed');assert.equal(await text('#record-returned'),'Unconfirmed');
  assert.equal(await page.locator('[data-step="settling"]').evaluate(element => element.classList.contains('failed')),true);
  purchase = makePurchase('paid',{id:'fixture-paid-quote',input:{query:'Fixture topic',count:1},max_spend_usd:'5.00',ceiling_usd:'0.07'},{charged_usd:'0.07',returned_usd:'0.00'});purchase.reading = signedReading(purchase,true);await load([purchase]);
  assert.equal(await page.locator('.citation a').getAttribute('href'),'https://doi.org/10.1234%2Ffixture');
  for (const width of [390,320]) {await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),false);}
  await page.screenshot({path:join(screenshots,'mobile-paid.png'),fullPage:true});
  console.log('PASS unconfirmed settlement, delivered citations, and mobile widths 390px/320px');

  requireKey = true;catalog.console.local_pay = false;await page.goto(base);await page.waitForFunction(() => document.body.dataset.connection === 'denied');assert.match(await text('#progress-detail'),/requires access/);
  await page.click('#access-open');await page.fill('#api-key',fixtureKey);await page.locator('#access-form').evaluate(form => form.requestSubmit());await page.waitForFunction(() => document.body.dataset.connection === 'live');
  assert.equal(await page.locator('#api-key').inputValue(),'');assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length),0);
  await page.reload();await page.waitForFunction(() => document.body.dataset.connection === 'denied');assert.deepEqual(errors,[]);
  assert.equal(writes,0);
  console.log('PASS read-only tracker, API access denial, memory-only key and reload clearing');
  console.log(`All browser contract checks passed. Screenshots: ${screenshots}`);
} finally {await browser?.close();await new Promise(resolve => server.close(resolve));}
