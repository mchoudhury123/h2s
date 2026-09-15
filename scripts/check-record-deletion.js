'use strict';
// Browser checks with an in-memory API stub; never connects to a CRM database.
const assert = require('node:assert/strict');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setContent('<div id="content"></div><div id="modal-root"></div>');
    for (const file of ['core.js', 'ui.js', 'views-records.js']) {
      await page.addScriptTag({ path: path.join(__dirname, '../public/js', file) });
    }
    const result = await page.evaluate(async () => {
      const check = (value, message) => { if (!value) throw new Error(message); };
      let calls = [], navigations = 0, refreshes = 0, finishDelete;
      App.can = permission => permission === 'edit';
      Router.go = () => { navigations++; };
      Router.handle = () => { refreshes++; };
      window.toast = () => {};
      api.get = async () => [{ id: 123, name: 'Test Person', code: 'TEST-123', registration: 'TEST CAR', status: 'active', active: 1, compliance: 'green' }];
      api.del = async url => { calls.push(url); };
      const content = document.getElementById('content');
      const cases = [
        ['children', {}, 'children'], ['staffList', {type:'driver'}, 'staff'],
        ['staffList', {type:'pa'}, 'staff'], ['contracts', {}, 'contracts'],
        ['schools', {}, 'schools'], ['councils', {}, 'councils'], ['vehicles', {}, 'vehicles'],
      ];
      for (const [view, params, resource] of cases) {
        content.replaceChildren(await App.views[view]({params, query:{}}));
        const button = content.querySelector('tbody tr td:last-child button');
        check(button?.textContent === 'Delete', view + ': rightmost Delete button');
        button.click();
        check(navigations === 0, 'Delete must not navigate the row');
        const input = document.querySelector('.modal input');
        const confirm = document.querySelector('.modal-foot .danger');
        check(confirm.disabled, 'Initially disabled');
        for (const value of ['delete', 'Delete', ' DELETE', 'DELETE ', 'DELET', '']) {
          input.value = value; input.dispatchEvent(new Event('input')); confirm.click();
          check(confirm.disabled && calls.length === 0, 'Reject incorrect confirmation: ' + value);
        }
        document.querySelector('.modal-foot .btn:not(.danger)').click();
        check(!document.querySelector('.modal') && !calls.length, 'Cancel must not delete');
        button.click();
        const exact = document.querySelector('.modal input');
        exact.value = 'DELETE'; exact.dispatchEvent(new Event('input'));
        document.querySelector('.modal-foot .danger').click();
        await new Promise(resolve => setTimeout(resolve, 0));
        check(calls.length === 1 && calls[0] === '/api/' + resource + '/123', 'Delete correct record only');
        check(!document.querySelector('.modal'), 'Close after success');
        calls = [];
      }
      check(refreshes === cases.length, 'Refresh after successful deletion');
      App.state.lookups = { stale: true };
      api.del = url => { calls.push(url); return new Promise(resolve => { finishDelete = resolve; }); };
      content.querySelector('tbody tr td:last-child button').click();
      let input = document.querySelector('.modal input');
      input.value = 'DELETE'; input.dispatchEvent(new Event('input'));
      let confirm = document.querySelector('.modal-foot .danger');
      confirm.click(); confirm.click();
      check(calls.length === 1 && confirm.disabled && input.disabled, 'Prevent duplicate pending requests');
      finishDelete(); await new Promise(resolve => setTimeout(resolve, 0));
      check(App.state.lookups === null, 'Invalidate deleted lookup records');
      api.del = async () => { throw new Error('Cannot delete: record is still assigned to a contract.'); };
      content.querySelector('tbody tr td:last-child button').click();
      input = document.querySelector('.modal input');
      input.value = 'DELETE'; input.dispatchEvent(new Event('input'));
      confirm = document.querySelector('.modal-foot .danger'); confirm.click();
      await new Promise(resolve => setTimeout(resolve, 0));
      check(document.querySelector('[role="alert"]').textContent.includes('still assigned'), 'Show server dependency error');
      check(!confirm.disabled, 'Allow retry after failure');
      UI.closeAll();
      App.can = () => false;
      content.replaceChildren(await App.views.children({query:{}}));
      check(!content.querySelector('button.danger'), 'Hide delete without edit access');
      return '7 overview lists: exact confirmation, cancel, correct endpoint, no row navigation, refresh, duplicate prevention, dependency error and access checks passed.';
    });
    assert.deepEqual(errors, []);
    console.log(result);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
