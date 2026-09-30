// Browser regression checks using an isolated HTTP fixture. No wallets or payments.
// PLAYWRIGHT_MODULE=/path/to/playwright node demo/check-ui.mjs
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import {generateKeyPairSync, sign} from 'node:crypto';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const publicDir=fileURLToPath(new URL('../motto/public/',import.meta.url));
const screenshots=process.env.UI_SCREENSHOT_DIR||join(tmpdir(),'motto-ui-check');
await mkdir(screenshots,{recursive:true});
const {privateKey,publicKey}=generateKeyPairSync('ed25519');
const devicePublicKey=publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex');
const terms={network:'devnet',console_purchase:false,devicePublicKey,items:{
 charger:{hold_usd:'3.00',check_fee_usd:'0.05',covers:'one charging session, up to 4 hours',check:'Is the device already drawing AC power?',rules:{already_handled:'Already on power: $0.05 charged, $2.95 returned.',delivered:'Power arrived: $3.00 charged.',check_failed:'Check failed: $3.00 returned.'}},
 research:{hold_usd:'1.00',check_fee_usd:'0.00',covers:'three citation records',check:'Deliver three distinct citation records.',rules:{delivered:'Three records: $1.00 charged.',inconclusive:'Incomplete result: $1.00 returned.'}},
 verify:{hold_usd:'0.10',check_fee_usd:'0.10',check:'Is the stated condition already true?',rules:{delivered:'Definitive result: $0.10 charged.',inconclusive:'Inconclusive: $0.10 returned.'}}
}};
let records=[], purchaseCount=0;const streams=new Set();
const makeHold=(status,extra={})=>({id:'fixture-charger',item:'charger',status,hold_usd:'3.00',check_fee_usd:'0.05',network:'devnet',startedAt:Date.now(),...extra});
const server=createServer(async(req,res)=>{
 const path=new URL(req.url,'http://localhost').pathname;
 const json=(data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
 if(path==='/v1/terms')return json(terms);
 if(path==='/v1/holds')return json({holds:records});
 if(path.startsWith('/v1/holds/'))return json(records.find(h=>h.id===decodeURIComponent(path.split('/').at(-1)))??{});
 if(path==='/v1/events'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': connected\n\n');streams.add(res);req.on('close',()=>streams.delete(res));return;}
 if(path==='/v1/console/purchase'){
  purchaseCount++;let raw='';for await(const chunk of req)raw+=chunk;
  assert.equal(req.headers['x-motto-console'],'1');const body=JSON.parse(raw);
  const hold=makeHold('refunded',{id:'fixture-research',item:'research',query:body.query,hold_usd:'1.00',charged_usd:'0.00',returned_usd:'1.00',outcome:'inconclusive'});records=[hold];return json({hold_id:hold.id});
 }
 const file=resolve(publicDir,path==='/'?'index.html':'.'+path);
 if(!file.startsWith(publicDir))return json({},404);
 try{const data=await readFile(file);res.writeHead(200,{'Content-Type':file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':file.endsWith('.woff2')?'font/woff2':'text/html'});res.end(data);}catch{json({},404);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
let browser;
try{
 browser=await chromium.launch({headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000}}), errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 const text=selector=>page.locator(selector).innerText();
 const load=async list=>{records=list;await page.goto(base);await page.locator('#request-service:not([disabled])').waitFor();};
 await load([]);
 assert.equal(await page.locator('#request-submit').isDisabled(),true);
 assert.equal(await text('#ceiling'),'—');
 await page.screenshot({path:join(screenshots,'desktop-empty.png'),fullPage:true});
 await page.selectOption('#request-service','charger');assert.match(await text('#request-budget'),/3\.00/);
 await page.click('#request-submit');assert.match(await text('#review-budget'),/3\.00/);
 assert.match(await text('#purchase-command'),/buy-service\.mjs 'charger' '\{\}' .* '3\.00'/);
 assert.equal(await page.locator('#confirm-purchase').isVisible(),false);
 await page.getByLabel('Close purchase review',{exact:true}).click();
 await page.selectOption('#request-service','research');await page.fill('#request-query',"battery's $(echo nope)");await page.click('#request-submit');
 assert.ok((await text('#purchase-command')).includes("battery'\\''s $(echo nope)"));
 await page.getByLabel('Close purchase review',{exact:true}).click();
 console.log('PASS empty workspace, dynamic service price, remote review, safe shell quoting');
 await load([makeHold('waiting_for_power')]);
 assert.equal(await text('#charged'),'—');assert.equal(await text('#returned'),'—');
 assert.equal(await page.locator('[data-step="1"]').getAttribute('aria-current'),'step');
 const payload={holdId:'fixture-charger',item:'charger',outcome:'already_handled',reason:'Already powered. The check fee is charged and the rest returned.',ts:Date.now()};
 const reading={...payload,signature:sign(null,Buffer.from(JSON.stringify(payload)),privateKey).toString('hex'),devicePublicKey};
 const settled=makeHold('refunded',{outcome:'already_handled',charged_usd:'0.05',returned_usd:'2.95',reading});
 records=[settled];for(const stream of streams)stream.write(`data: ${JSON.stringify(settled)}\n\n`);
 await page.waitForFunction(()=>document.querySelector('#returned').textContent==='$2.95');
 await page.click('#open-receipt');await page.click('#verify');
 await page.waitForFunction(()=>document.querySelector('#signature-state').textContent.startsWith('Verified'));
 await page.getByLabel('Close receipt',{exact:true}).click();
 const downloaded=page.waitForEvent('download');await page.click('#download-receipt');assert.match((await downloaded).suggestedFilename(),/fixture-charger/);
 await page.locator('h1').click();await page.evaluate(()=>scrollTo(0,0));
 await page.screenshot({path:join(screenshots,'desktop-returned.png'),fullPage:true});
 console.log('PASS live hold-to-return transition, exact ledger amounts, signature verification and receipt download');
 await load([makeHold('settle_failed',{outcome:'delivered',charged_usd:null,returned_usd:null})]);
 assert.equal(await text('#charged'),'—');assert.equal(await text('#returned'),'—');assert.match(await text('#progress-count'),/Needs attention/);
 assert.equal(await page.locator('#run-status').getAttribute('data-state'),'attention');
 await load([makeHold('refunded',{outcome:'check_failed',charged_usd:'0.00',returned_usd:'3.00'})]);
 assert.match(await page.locator('[data-step="2"]').getAttribute('class'),/failed/);
 assert.match(await page.locator('[data-step="3"]').getAttribute('class'),/done/);
 console.log('PASS unconfirmed settlement and failed evidence stay distinct from successful payment');
 const citation={title:'Fixture source title',doi:'10.1234/fixture',url:'https://doi.org/10.1234/fixture',publisher:'Fixture publisher'};
 await load([makeHold('kept',{id:'fixture-delivered',item:'research',hold_usd:'1.00',charged_usd:'1.00',returned_usd:'0.00',outcome:'delivered',reading:{deliverable:{query:'Fixture topic',citations:[citation]},reason:'Structural checks passed.'}})]);
 assert.equal(await page.locator('.citation a').getAttribute('href'),citation.url);
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 const money=await page.locator('.money-card').boundingBox(), journey=await page.locator('.journey').boundingBox();assert.ok(money.y<journey.y);
 await page.screenshot({path:join(screenshots,'mobile-delivered.png'),fullPage:true});
 await page.setViewportSize({width:320,height:740});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 console.log('PASS delivered evidence and mobile layout at 390px and 320px');
 terms.console_purchase=true;await load([]);await page.selectOption('#request-service','research');await page.fill('#request-query','Battery recycling');await page.click('#request-submit');
 assert.equal(purchaseCount,0);assert.equal(await page.locator('#command-section').isVisible(),false);
 await page.click('#confirm-purchase');await page.waitForFunction(()=>document.querySelector('#returned').textContent==='$1.00');assert.equal(purchaseCount,1);
 assert.equal(await page.locator('#request-submit').isDisabled(),false);
 assert.deepEqual(errors,[]);
 console.log('PASS local purchase requires review, submits once, and renders returned funds');
 const run=promisify(execFile),buyer=fileURLToPath(new URL('../motto/scripts/buy-service.mjs',import.meta.url));
 const rejected=async(args,pattern)=>{try{await run(process.execPath,[buyer,...args]);assert.fail('Buyer should reject before payment');}catch(error){assert.match(error.stderr??'',pattern);}};
 await rejected(['charger','{}',base,'1.00'],/price changed/);
 await rejected(['unknown','{}',base,'3.00'],/Unknown service/);
 await rejected(['charger','[]',base,'3.00'],/JSON object/);
 terms.network='mainnet';await rejected(['charger','{}',base,'3.00'],/only supports Solana Devnet/);
 console.log('PASS buyer rejects changed prices, unknown services, malformed bodies and mainnet before payment');
 console.log(`All browser checks passed. Screenshots: ${screenshots}`);
}finally{
 await browser?.close();for(const stream of streams)stream.end();await new Promise(resolve=>server.close(resolve));
}
