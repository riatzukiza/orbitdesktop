// SPDX-License-Identifier: GPL-3.0-or-later
// Browser fixtures only; no provider calls, live workspace writes or dispatch.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';
const root = path.dirname(new URL(import.meta.url).pathname);
let budgets = { ok: true, data: { budgets: [{ scopeId: 'bot', status: 'ok', dailyMicrousd: 500000,
  monthlyMicrousd: 5000000, dailyRemainingMicrousd: 250000, monthlyRemainingMicrousd: 3850000,
  usage: { dailyChargedMicrousd: 100000, monthlyChargedMicrousd: 1000000, heldMicrousd: 150000,
    dailyCarriedMicrousd: 50000, monthlyCarriedMicrousd: 20000, unresolvedCount: 2 },
  routes: [{ upstreamModel: 'google/gemma-4-31b-it', billing: 'free' }] }] } };
let sampleCount = 96;
let projectFailures = 1;
let searchResult = [];
const snapshot = () => ({ hosts: {stealth:{ok:false,error:"fixture unavailable"}}, links: {}, openplanner: {ok:false}, observed_at: new Date().toISOString(),
  evaluation:{ok:true,data:{configured:true,sourceSha256:'a'.repeat(64),sampleCount,observedAt:'fixture',scope:'Single window; fixture only',decision:'Not a live adoption claim',summary:[{model:'e4b',condition:'clean',samples:24,completed:22,timeouts:2,httpErrors:0,firstUsableP50Ms:7000,firstUsableP95Ms:13000,grounding:43,instruction:32,toolCorrectness:44,qualityMaximumPerDimension:44}] }},
  proxx: {ok:true, data: {configured:true,label:'Fixture ledger',observed_at:new Date().toISOString(),budgets,
    usage:{ok:true,data:{entries:[{providerId:'requesty',model:'gemma4:31b',upstreamModel:'google/gemma-4-31b-it',
      status:200,costUsd:0,ttftMs:100,tps:38},{status:200}]}}}} });
let snapshotFailure = null;
const server = createServer(async (req,res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    if (url.pathname === '/api/snapshot' && snapshotFailure) {
      res.writeHead(snapshotFailure.status, {'content-type':'text/plain'}).end(snapshotFailure.body); return;
    }
    if (url.pathname === '/api/projects' && projectFailures-- > 0) {res.writeHead(503,{'content-type':'text/plain'}).end('projects temporarily unavailable');return;}
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify(url.pathname === '/api/snapshot' ? snapshot() : url.pathname === '/api/jobs' ? [] : url.pathname === '/api/search' ? searchResult : {projects:['fixture'],harnesses:['codex']})); return;
  }
  const files = {'/':'dashboard.html','/dashboard.js':'dashboard.js','/dashboard.css':'dashboard.css'};
  const file=files[url.pathname]; if(!file){res.writeHead(404).end();return;}
  res.setHeader('content-type', file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html');
  res.end(await readFile(path.join(root,file)));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser;
try {
  browser = await chromium.launch({headless:true,executablePath:process.env.ORBIT_TEST_BROWSER || path.join(os.homedir(),'.cache/ms-playwright/chromium-1234/chrome-linux64/chrome')});
  const page = await browser.newPage({viewport:{width:1100,height:900}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.locator('#dispatch-status').getByText('HTTP 503: projects temporarily unavailable',{exact:true}).waitFor();
  assert.equal(await page.locator('#send').isEnabled(),false);
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await page.waitForFunction(()=>!document.getElementById('send').disabled,null,{timeout:2000});
  searchResult=[{id:'array-search',text:'Array search result'}];
  await page.locator('#query').fill('fixture');
  await page.locator('#search').evaluate(form=>form.requestSubmit());
  await page.locator('#results').getByText('Array search result',{exact:true}).waitFor();
  searchResult={rows:[{id:'object-search',text:'Object search result'}]};
  await page.locator('#search').evaluate(form=>form.requestSubmit());
  await page.locator('#results').getByText('Object search result',{exact:true}).waitFor();
  await page.locator('#proxx-budgets').getByText(/Today: \$0.250 remaining of \$0.500/).waitFor();
  assert.match(await page.locator('#proxx-budgets').textContent(),/\$3.850 remaining of \$5.000/);
  assert.match(await page.locator('#proxx-budgets').textContent(),/Carried holds: \$0.050/);

  const budgetLayout = await page.locator('#proxx-budgets article').evaluate(card => ({
    width:card.getBoundingClientRect().width, childWidth:card.firstElementChild.getBoundingClientRect().width,
    wrap:getComputedStyle(card.querySelector('p')).whiteSpace,
  }));
  assert.ok(budgetLayout.childWidth > budgetLayout.width * .9, 'budget text spans its card');
  assert.equal(budgetLayout.wrap,'normal');
  let releaseSubmit, releaseProjects, submitSeen, projectsSeen;
  const submitGate=new Promise(resolve=>releaseSubmit=resolve), projectsGate=new Promise(resolve=>releaseProjects=resolve);
  const submitted=new Promise(resolve=>submitSeen=resolve), discovering=new Promise(resolve=>projectsSeen=resolve);
  await page.route('**/api/submit',async route=>{submitSeen();await submitGate;await route.fulfill({json:{id:'fixture-worker',state:'accepted'}})});
  await page.route('**/api/projects',async route=>{projectsSeen();await projectsGate;await route.fulfill({json:{projects:['fixture-yoga'],harnesses:['codex']}})});
  await page.locator('#prompt').fill('Synthetic fixture only');
  await page.locator('#confirm').check();
  await page.locator('#send').click(); await submitted;
  await page.locator('#target').evaluate(select=>select.add(new Option('yoga','yoga')));
  await page.locator('#target').selectOption('yoga'); await discovering;
  assert.equal(await page.locator('#confirm').isChecked(),false);
  assert.equal(await page.locator('#project option').count(),0);
  assert.equal(await page.locator('#harness option').count(),0);
  assert.equal(await page.locator('#send').isEnabled(),false);
  releaseSubmit();
  await page.locator('#dispatch-status').getByText('Worker fixture-worker · accepted',{exact:true}).waitFor();
  assert.equal(await page.locator('#send').isEnabled(),false,'old submission cannot enable dispatch during discovery');
  releaseProjects();
  await page.waitForFunction(()=>!document.getElementById('send').disabled);
  assert.equal(await page.locator('#project').inputValue(),'fixture-yoga');
  await page.unroute('**/api/submit'); await page.unroute('**/api/projects');

  assert.match(await page.locator('#proxx-routes').textContent(),/google\/gemma-4-31b-it/);
  assert.match(await page.locator('#proxx-routes').textContent(),/\$0.0000/);
  assert.match(await page.locator('#proxx-routes').textContent(),/Unknown provider/);
  assert.doesNotMatch(await page.locator('#proxx-routes').textContent(),/undefined|Unknown ms/);
  assert.match(await page.locator('#evaluation-results').textContent(),/22\/24/);
  assert.match(await page.locator('#evaluation-results').textContent(),/7.00s/);
  assert.match(await page.locator('#evaluation-evidence').textContent(),/96 samples/);
  assert.match(await page.locator('#evaluation-evidence').textContent(),/tool selection is not execution/);
  sampleCount=null;
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await page.locator('#evaluation-evidence').getByText(/Unknown samples/).waitFor();
  budgets={ok:true,data:{budgets:[{scopeId:'partial',status:'ok',usage:{},routes:[{}]}]}};
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await page.locator('#proxx-budgets').getByRole('heading',{name:'partial',exact:true}).waitFor();
  const partial=await page.locator('#proxx-budgets').textContent();
  assert.doesNotMatch(partial,/undefined|null/);
  assert.match(partial,/Unknown unresolved/);
  assert.match(partial,/Unknown model \[Unknown billing\]/);
  budgets={ok:false,error:'unavailable'};
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await page.locator('#proxx-budgets').getByText(/remaining allowance is unknown/).waitFor();
  assert.doesNotMatch(await page.locator('#proxx-budgets').textContent(),/\$0\.000/);
  snapshotFailure={status:502,body:'upstream gateway unavailable'};
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await page.getByText('HTTP 502: upstream gateway unavailable',{exact:true}).waitFor();
  snapshotFailure={status:401,body:'sign in required'};
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await page.locator('#unlock').waitFor({state:'visible'});
  await page.getByText('Unlock the dashboard to load private fleet data.',{exact:true}).waitFor();
  snapshotFailure={status:200,body:'not JSON'};
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await page.getByText('HTTP 200: invalid JSON response',{exact:true}).waitFor();
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.deepEqual(errors,[]);
  console.log('proxx-dashboard-browser-ok: both limits, charges, holds, carry, actual route, zero price, unavailable ledger and mobile layout');
} finally {await browser?.close();await new Promise(r=>server.close(r));}
