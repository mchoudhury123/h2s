'use strict';
process.env.H2S_DB_DRIVER = 'sqlite';
process.env.H2S_DB = ':memory:';
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer-core');
const db = require('../server/db');
const routes = require('../server/routes');

async function main() {
  await db.migrate();
  const org = await db.driver.insertReturningId('INSERT INTO organisations (name) VALUES (?)', ['Attachment test']);
  const staff = await db.insert('staff', { type: 'driver', first_name: 'Test', last_name: 'Driver' }, ['type', 'first_name', 'last_name'], null, org);
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<body><div id="test-host"></div><div id="modal-root"></div><div id="toasts"></div></body>');
    for (const file of ['core.js', 'ui.js']) await page.addScriptTag({ path: require('node:path').join(__dirname, '../public/js', file) });
    await page.exposeFunction('testApi', async (method, url, payload) => {
      const parsed = new URL(url, 'http://test');
      const res = { writeHead(status) { this.status = status; }, end(value) { this.body = JSON.parse(value); } };
      await routes.handle({ req: { method }, res, path: parsed.pathname, query: Object.fromEntries(parsed.searchParams),
        body: payload?.fields || {}, files: (payload?.files || []).map(file => ({ ...file, data: Buffer.from(file.data) })),
        user: { organisation_id: org, name: 'Browser tester' } });
      if (res.status >= 400) throw new Error(res.body.error);
      return res.body;
    });
    await page.evaluate(() => {
      App.state.docTypes = { staff: ['DBS', 'Driver Badge'] };
      window.toast = (message, type) => { if (type === 'err') throw new Error(message); };
      api.get = url => window.testApi('GET', url);
      api.put = (url, fields) => window.testApi('PUT', url, { fields });
      api.request = async (method, url, fd) => {
        const fields = {}, files = [];
        for (const [field, value] of fd.entries()) {
          if (value instanceof File) files.push({ field, filename: value.name, mime: value.type, data: Array.from(new Uint8Array(await value.arrayBuffer())) });
          else fields[field] = value;
        }
        return window.testApi(method, url, { fields, files });
      };
      api.form = (url, fd) => api.request('POST', url, fd);
    });
    for (const type of ['DBS', 'Driver Badge']) {
      const firstText = type === 'DBS' ? 'DBS Certificate\nReference: 00123456789\nIssue date: 01/09/2026' : 'Driver Licence No: LN/00007306\nIssue date: 01/09/2026';
      await page.evaluate(async ({ type, staff, firstText }) => {
        UI.documentEditor('staff', staff, null, () => {});
        const select = document.querySelector('.modal [name=doc_type]');
        select.value = type; select.dispatchEvent(new Event('change', { bubbles: true }));
        const transfer = new DataTransfer();
        transfer.items.add(new File([firstText], 'front.txt', { type: 'text/plain' }));
        transfer.items.add(new File(['Expiry date: 01/09/2028'], 'back.txt', { type: 'text/plain' }));
        document.querySelector('.modal .document-drop-zone').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, cancelable: true }));
        await [...document.querySelectorAll('.modal button')].find(button => button.textContent === 'Auto input').onclick();
        if (document.querySelector('.modal [name=expiry_date]').value !== '2028-09-01') throw new Error('Second file expiry not read');
        await [...document.querySelectorAll('.modal button')].find(button => button.textContent === 'Save document').onclick();
      }, { type, staff, firstText });
      const documents = await page.evaluate(staff => api.get('/api/documents?entity_type=staff&entity_id=' + staff), staff);
      const document = documents.find(document => document.doc_type === type);
      assert.equal(document.has_second_file, 1);
      assert.equal(document.second_file_name, 'back.txt');
      assert.equal(document.expiry_date, '2028-09-01');
      await page.evaluate(async ({ document: record, staff }) => {
        UI.documentEditor('staff', staff, record, () => {});
        const modal = document.querySelector('.modal');
        modal.querySelector('[name=notes]').value += '\nChecked both sides.';
        await [...modal.querySelectorAll('button')].find(button => button.textContent === 'Save document').onclick();
      }, { document, staff });
      const stored = await db.get('SELECT * FROM documents WHERE organisation_id = ? AND id = ?', [org, document.id]);
      assert.equal(Buffer.from(stored.file_data, 'base64').toString(), firstText);
      assert.equal(Buffer.from(stored.second_file_data, 'base64').toString(), 'Expiry date: 01/09/2028');
      const download = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
      await routes.handle({ req: { method: 'GET' }, res: download, path: '/api/documents/' + document.id + '/file',
        query: { part: '2' }, user: { organisation_id: org, name: 'Tester' } });
      assert.equal(download.status, 200);
      assert.equal(download.body.toString(), 'Expiry date: 01/09/2028');
      const denied = { writeHead(status) { this.status = status; }, end() {} };
      await routes.handle({ req: { method: 'GET' }, res: denied, path: '/api/documents/' + document.id + '/file',
        query: { part: '2' }, user: { organisation_id: org + 1, name: 'Other firm' } });
      assert.equal(denied.status, 404);
      await page.evaluate(({ document, staff }) => {
        const host = window.document.getElementById('test-host');
        host.replaceChildren(UI.documentsPanel('staff', staff, [document], () => {}));
      }, { document, staff });
      assert.equal(await page.$$eval('#test-host a[href*="/file"]', links => links.length), 2);
      await page.evaluate(async ({ document, staff }) => {
        UI.documentEditor('staff', staff, document, () => {});
        const checkbox = window.document.querySelector('.modal input[type=checkbox]');
        checkbox.checked = true; checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        await [...window.document.querySelectorAll('.modal button')].find(button => button.textContent === 'Save document').onclick();
      }, { document, staff });
      const single = await db.get('SELECT * FROM documents WHERE organisation_id = ? AND id = ?', [org, document.id]);
      assert.equal(single.second_file_data, null);
      assert.equal(single.file_data, stored.file_data);
      const oneFile = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
      await routes.handle({ req: { method: 'POST' }, res: oneFile, path: '/api/documents',
        body: { entity_type: 'staff', entity_id: staff, doc_type: type },
        files: [{ field: 'file', filename: 'one.txt', mime: 'text/plain', data: Buffer.from(firstText) }],
        user: { organisation_id: org, name: 'Tester' } });
      assert.equal(oneFile.status, 201);
      assert.equal(oneFile.body.has_second_file, 0);
      const tooMany = { writeHead(status) { this.status = status; }, end() {} };
      await routes.handle({ req: { method: 'POST' }, res: tooMany, path: '/api/documents',
        body: { entity_type: 'staff', entity_id: staff, doc_type: type },
        files: Array.from({ length: 3 }, () => ({ field: 'file', filename: 'page.txt', mime: 'text/plain', data: Buffer.from(firstText) })),
        user: { organisation_id: org, name: 'Tester' } });
      assert.equal(tooMany.status, 400);
    }
    await page.addScriptTag({ path: require('node:path').join(__dirname, '../public/js/views-records.js') });
    await db.setSetting(org, 'required_docs_driver', JSON.stringify(['First Aid']));
    await page.evaluate(async staffId => {
      App.state.docTypes.staff = ['Driving Licence', 'First Aid', 'GDPR'];
      document.getElementById('test-host').replaceChildren(await App.views.staffDetail({ params: { id: staffId } }));
      [...document.querySelectorAll('#test-host .tabs button')].find(button => button.textContent.startsWith('Compliance')).click();
    }, staff);
    for (const type of ['First Aid', 'GDPR']) {
      await page.evaluate(type => {
        const row = [...document.querySelectorAll('tr')].find(row => row.textContent.includes(type) && [...row.querySelectorAll('button')].some(button => button.textContent === 'Add'));
        if (!row) throw new Error('Missing compliance row: ' + type);
        [...row.querySelectorAll('button')].find(button => button.textContent === 'Add').click();
      }, type);
      assert.equal(await page.$eval('#modal-root select[name="doc_type"]', input => input.value), type);
      assert.equal(await page.$eval('#modal-root input[name="issue_date"]', input => input.required), type === 'GDPR');
      await page.evaluate(() => [...document.querySelectorAll('#modal-root button')].find(button => button.textContent === 'Cancel').click());
    }
    assert.deepEqual(errors, []);
    console.log('DBS and Driver Badge attachment checks passed: two files, combined Auto input, both file links, safe metadata editing and optional second-file removal.');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db.close());
