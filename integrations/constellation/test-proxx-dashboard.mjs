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
const snapshot = () => ({ hosts: {}, links: {}, openplanner: {ok:false}, observed_at: new Date().toISOString(),
  proxx: {ok:true, data: {configured:true,label:'Fixture ledger',observed_at:new Date().toISOString(),budgets,
    usage:{ok:true,data:{entries:[{providerId:'requesty',model:'gemma4:31b',upstreamModel:'google/gemma-4-31b-it',
      status:200,costUsd:0,ttftMs:100,tps:38}]}}}} });
const server = createServer(async (req,res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify(url.pathname === '/api/snapshot' ? snapshot() : url.pathname === '/api/jobs' ? [] : {projects:[],harnesses:[]})); return;
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
  await page.locator('#proxx-budgets').getByText(/Today: \$0.250 remaining of \$0.500/).waitFor();
  assert.match(await page.locator('#proxx-budgets').textContent(),/\$3.850 remaining of \$5.000/);
  assert.match(await page.locator('#proxx-budgets').textContent(),/Carried holds: \$0.050/);
  assert.match(await page.locator('#proxx-routes').textContent(),/google\/gemma-4-31b-it/);
  assert.match(await page.locator('#proxx-routes').textContent(),/\$0.0000/);
  budgets={ok:false,error:'unavailable'};
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await page.locator('#proxx-budgets').getByText(/remaining allowance is unknown/).waitFor();
  assert.doesNotMatch(await page.locator('#proxx-budgets').textContent(),/\$0\.000/);
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.deepEqual(errors,[]);
  console.log('proxx-dashboard-browser-ok: both limits, charges, holds, carry, actual route, zero price, unavailable ledger and mobile layout');
} finally {await browser?.close();await new Promise(r=>server.close(r));}
