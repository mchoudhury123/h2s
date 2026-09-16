'use strict';
const { workerData, parentPort } = require('worker_threads');
const { extractFields } = require('./document-input');

async function read() {
  const { file, types, selectedType } = workerData;
  const buffer = Buffer.from(file.data);
  const warnings = [];
  let text = '', ocr;
  const recognise = async image => {
    if (!ocr) {
      const { createWorker } = require('tesseract.js');
      const english = require('@tesseract.js-data/eng');
      ocr = await createWorker('eng', 1, { langPath: english.langPath, gzip: true, cacheMethod: 'none' });
    }
    const { data } = await ocr.recognize(image);
    if (data.confidence < 80) warnings.push('Some text was difficult to read; check every extracted value against the document.');
    return data.text;
  };
  try {
    if (buffer.subarray(0, 5).toString() === '%PDF-') {
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: true }).promise;
      try {
        if (pdf.numPages > 6) warnings.push('Only the first 6 pages were read; check the remaining pages manually.');
        for (let index = 1; index <= Math.min(pdf.numPages, 6); index++) {
          const page = await pdf.getPage(index);
          const content = await page.getTextContent();
          let pageText = content.items.map(item => item.str + (item.hasEOL ? '\n' : ' ')).join('');
          if (pageText.trim().length < 30) {
            const { createCanvas } = require('@napi-rs/canvas');
            const viewport = page.getViewport({ scale: Math.min(2, 2200 / Math.max(page.getViewport({ scale: 1 }).width, page.getViewport({ scale: 1 }).height)) });
            const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
            await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
            pageText = await recognise(canvas.toBuffer('image/png'));
          }
          text += pageText + '\n';
          page.cleanup();
        }
      } finally { await pdf.destroy(); }
    } else if (/\.(?:png|jpe?g|webp|bmp|tiff?)$/i.test(file.filename) || /^image\/(?:png|jpeg|webp|bmp|tiff)$/.test(file.mime)) {
      const { loadImage, createCanvas } = require('@napi-rs/canvas');
      const image = await loadImage(buffer);
      const scale = Math.min(1, 2500 / Math.max(image.width, image.height));
      const canvas = createCanvas(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      text = await recognise(canvas.toBuffer('image/png'));
    } else if (/\.docx$/i.test(file.filename)) {
      text = (await require('mammoth').extractRawText({ buffer })).value;
    } else if (/\.txt$/i.test(file.filename)) text = buffer.toString('utf8');
    else throw new Error('Auto input supports PDF, JPG, PNG, WebP, TIFF, BMP, DOCX and text files. Convert this file to PDF or enter its details manually.');
    return extractFields(text, types, selectedType, warnings);
  } finally { if (ocr) await ocr.terminate(); }
}

read().then(result => parentPort.postMessage(result)).catch(error => parentPort.postMessage({ error: /password/i.test(error.message) ? 'This PDF is password protected. Upload an unlocked copy.' : error.message }));
