'use strict';
// A small PDF writer, enough for a printable invoice: A4 pages, Helvetica and
// Helvetica-Bold from the standard fourteen fonts, text, lines and filled
// boxes. Nothing is embedded, so every viewer renders it the same way and the
// file stays a few kilobytes. Coordinates are given from the top-left corner
// in points, which is how a layout is normally thought about.

const A4 = { width: 595.28, height: 841.89 };

// Glyph widths for WinAnsi characters 32 to 126, in thousandths of the font
// size, from the Adobe font metrics. The pound sign is added separately.
const WIDTHS = {
  H: [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584],
  HB: [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584],
};
const FONT_NAMES = { H: 'Helvetica', HB: 'Helvetica-Bold' };

/** Characters outside WinAnsi become a question mark rather than breaking the file. */
function winAnsi(str) {
  let out = '';
  for (const ch of String(str)) {
    const code = ch.codePointAt(0);
    if (code === 0x2013 || code === 0x2014) out += '-';        // en and em dashes
    else if (code === 0x2018 || code === 0x2019) out += "'";
    else if (code === 0x201C || code === 0x201D) out += '"';
    else if (code <= 0xFF) out += ch;
    else out += '?';
  }
  return out;
}
function escapePdf(str) {
  return str.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/\r?\n/g, ' ');
}

class Pdf {
  constructor() { this.pages = []; this.current = null; }

  /** Starts a new A4 page and makes it the target for drawing. */
  addPage() { this.current = { ops: [] }; this.pages.push(this.current); return this; }

  /** Width of a string in points, for right-aligning and wrapping. */
  width(str, font = 'H', size = 10) {
    const table = WIDTHS[font] || WIDTHS.H;
    let w = 0;
    for (const ch of winAnsi(str)) {
      const code = ch.charCodeAt(0);
      w += code >= 32 && code <= 126 ? table[code - 32] : (code === 0xA3 ? 556 : 556);
    }
    return w * size / 1000;
  }

  /** Draws text with its baseline `y` points from the top of the page. */
  text(x, y, str, { font = 'H', size = 10, align = 'left', color = [0, 0, 0] } = {}) {
    const s = winAnsi(str);
    let left = x;
    if (align === 'right') left = x - this.width(s, font, size);
    else if (align === 'center') left = x - this.width(s, font, size) / 2;
    const [r, g, b] = color;
    this.current.ops.push(
      `BT ${r} ${g} ${b} rg /${font} ${size} Tf ${left.toFixed(2)} ${(A4.height - y).toFixed(2)} Td (${escapePdf(s)}) Tj ET`);
    return this;
  }

  /** Lays a paragraph out within a width, returning the y just below it. */
  paragraph(x, y, str, width, { font = 'H', size = 10, leading = null, align = 'left', color } = {}) {
    const lh = leading || size * 1.35;
    for (const rawLine of String(str).split(/\r?\n/)) {
      const words = rawLine.split(/\s+/).filter(Boolean);
      if (!words.length) { y += lh; continue; }
      let line = '';
      for (const w of words) {
        const trial = line ? line + ' ' + w : w;
        if (this.width(trial, font, size) > width && line) {
          this.text(x, y, line, { font, size, align, color });
          y += lh;
          line = w;
        } else line = trial;
      }
      this.text(x, y, line, { font, size, align, color });
      y += lh;
    }
    return y;
  }

  line(x1, y1, x2, y2, { width = 0.75, color = [0, 0, 0] } = {}) {
    const [r, g, b] = color;
    this.current.ops.push(
      `${r} ${g} ${b} RG ${width} w ${x1.toFixed(2)} ${(A4.height - y1).toFixed(2)} m ${x2.toFixed(2)} ${(A4.height - y2).toFixed(2)} l S`);
    return this;
  }

  /** A box with its top-left corner at (x, y). */
  rect(x, y, w, hgt, { fill = null, stroke = null, width = 0.75 } = {}) {
    const ops = [];
    if (fill) ops.push(`${fill[0]} ${fill[1]} ${fill[2]} rg`);
    if (stroke) ops.push(`${stroke[0]} ${stroke[1]} ${stroke[2]} RG ${width} w`);
    ops.push(`${x.toFixed(2)} ${(A4.height - y - hgt).toFixed(2)} ${w.toFixed(2)} ${hgt.toFixed(2)} re`);
    ops.push(fill && stroke ? 'B' : fill ? 'f' : 'S');
    this.current.ops.push(ops.join(' '));
    return this;
  }

  /** The finished file. */
  render() {
    const objects = [];                                   // 1-based object bodies
    const add = body => { objects.push(body); return objects.length; };
    const fontH = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const fontHB = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const pagesId = objects.length + 1 + this.pages.length * 2;   // reserved after the page objects
    const pageIds = [];
    for (const page of this.pages) {
      const content = page.ops.join('\n');
      const contentId = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
      const pageId = add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] ` +
        `/Resources << /Font << /H ${fontH} 0 R /HB ${fontHB} 0 R >> >> /Contents ${contentId} 0 R >>`);
      pageIds.push(pageId);
    }
    const pages = add(`<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
    if (pages !== pagesId) throw new Error('PDF object numbering went wrong');
    const catalog = add(`<< /Type /Catalog /Pages ${pages} 0 R >>`);

    const parts = ['%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'];
    const offsets = [];
    let length = Buffer.byteLength(parts[0], 'latin1');
    objects.forEach((body, i) => {
      offsets.push(length);
      const chunk = `${i + 1} 0 obj\n${body}\nendobj\n`;
      parts.push(chunk);
      length += Buffer.byteLength(chunk, 'latin1');
    });
    const xref = length;
    let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) table += `${String(off).padStart(10, '0')} 00000 n \n`;
    table += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    parts.push(table);
    return Buffer.from(parts.join(''), 'latin1');
  }
}

module.exports = { Pdf, A4, FONT_NAMES };
