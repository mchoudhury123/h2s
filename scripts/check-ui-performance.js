'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const puppeteer = require('puppeteer-core');
(async () => {
  const browser = await puppeteer.launch({executablePath: process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headless:true});
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setContent('<div id="root"></div><div id="modal-root"></div><div id="toasts"></div>');
    for (const file of ['core.js','ui.js']) await page.addScriptTag({path:path.join(__dirname,'../public/js',file)});
    const result = await page.evaluate(async () => {
      const check = (condition,message) => { if (!condition) throw new Error(message); };
      const tick = () => new Promise(resolve => setTimeout(resolve,0));
      let requests = [];
      const get = api.get;
      api.get = () => new Promise((resolve,reject) => requests.push({resolve,reject}));
      const a = UI.lookups(), b = UI.lookups();
      check(requests.length === 1,'Concurrent forms share one request');
      requests[0].resolve({schools:[{id:1,name:'Original'}]});
      check((await a).schools[0].id === 1 && (await b).schools[0].id === 1,'Both forms get dropdowns');
      await UI.lookups(); check(requests.length === 1,'Warm form needs no request');
      UI._lookupTime = Date.now()-31000;
      const expired = UI.lookups(); check(requests.length === 2,'Expired dropdowns refresh');
      requests[1].resolve({schools:[]}); await expired;
      UI.invalidateLookups();
      const oldRequest = UI.lookups();
      UI.invalidateLookups(); // A save or session change overtakes an old read.
      const newRequest = UI.lookups();
      requests[3].resolve({schools:[{id:2,name:'Current'}]}); await newRequest;
      requests[2].resolve({schools:[{id:1,name:'Old'}]});
      check((await oldRequest).schools[0].id === 2,'An obsolete request cannot return old dropdowns');
      check(App.state.lookups.schools[0].id === 2,'An obsolete request cannot overwrite cache');
      UI.invalidateLookups();
      const failure = UI.lookups(); requests[4].reject(new Error('Network failure'));
      await failure.catch(() => {});
      const retry = UI.lookups(); check(requests.length === 6,'Failed dropdown request can retry');
      requests[5].resolve({schools:[]}); await retry;
      api.get = get;
      window.fetch = async () => ({status:200,ok:true,headers:{get:()=> 'application/json'},json:async()=>({id:1})});
      await api.post('/api/children',{first_name:'Test'});
      check(App.state.lookups === null,'Saving invalidates cached dropdowns');
      let clicks = 0, finish;
      const button = h('button',{onclick:()=>{clicks++;return new Promise(resolve=>{finish=resolve;});}},'Edit');
      document.getElementById('root').appendChild(button);
      button.click();button.click();
      check(button.disabled && button.getAttribute('aria-busy') === 'true' && clicks === 1,'Immediate busy state prevents double clicks');
      finish(); await tick();
      check(!button.disabled && !button.hasAttribute('aria-busy'),'Button restored after completion');
      const bad = h('button',{onclick:async()=>{throw new Error('Test action failure');}},'Edit');
      document.getElementById('root').appendChild(bad);bad.click();await tick();
      check(!bad.disabled && document.getElementById('toasts').textContent.includes('Test action failure'),'Failed async action is visible and retryable');
      return 'Browser performance checks passed: shared requests, warm cache, expiry, invalidation, stale responses, retries and responsive buttons.';
    });
    await page.evaluate(() => {
      window.dashboardLoads = 0;
      App.views.dashboard = async () => { window.dashboardLoads++; return h('div','Dashboard'); };
      api.get = async url => url === '/api/me'
        ? {user:{id:101,name:'Test user'},organisation:{id:1},settings:{},doc_types:{}}
        : {schools:[]};
    });
    await page.addScriptTag({path:path.join(__dirname,'../public/js/app.js')});
    await page.waitForFunction(() => window.dashboardLoads === 1);
    await page.evaluate(async () => {
      await new Promise(resolve=>setTimeout(resolve,50));
      if (window.dashboardLoads !== 1) throw new Error('Startup loads dashboard twice');
      await UI.lookups();
      App.signedOut();
      if (App.state.lookups !== null || App.state.user !== null) throw new Error('Sign-out must clear cached account data');
    });
    assert.deepEqual(errors,[]);
    console.log(result);
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
