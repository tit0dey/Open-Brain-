/**
 * KDP Studio — Local PDF Engine & OFL Font Suite Loader
 *
 * Works identically in browser (offline PWA / GitHub Pages) and Node.js
 * (headless tests) with zero external network calls. Includes script-aware
 * Latin + Devanagari text run segmentation and non-blocking frame yields.
 */

import { FONT_CATALOG } from './config.js';

const IS_BROWSER = typeof window !== 'undefined' && typeof document !== 'undefined';

let enginePromise = null;
const fontBytesCache = new Map();
const fontkitInstanceCache = new Map();

/**
 * Minimal generator runtime shim required by @pdf-lib/fontkit@1.1.1's compiled
 * Indic/Devanagari OpenType state machine (which references regeneratorRuntime).
 */
export function ensureFontkitRuntimeShim() {
  if (typeof globalThis.regeneratorRuntime !== 'undefined') return;
  globalThis.regeneratorRuntime = {
    mark: (fn) => fn,
    wrap: (innerFn) => {
      const ctx = {
        prev: 0,
        next: 0,
        done: false,
        stop() {
          this.done = true;
        }
      };
      return {
        next() {
          ctx.prev = ctx.next;
          const value = innerFn(ctx);
          return { value, done: ctx.done };
        },
        [Symbol.iterator]() {
          return this;
        }
      };
    }
  };
}

function loadClassicScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-kdp-vendor="${src}"]`);
    if (existing && existing.dataset.loaded === 'true') {
      resolve();
      return;
    }
    const script = existing || document.createElement('script');
    script.src = src;
    script.async = true;
    script.dataset.kdpVendor = src;
    script.addEventListener(
      'load',
      () => {
        script.dataset.loaded = 'true';
        resolve();
      },
      { once: true }
    );
    script.addEventListener(
      'error',
      () => reject(new Error(`Failed to load local vendor script: ${src}`)),
      { once: true }
    );
    if (!existing) {
      document.head.appendChild(script);
    }
  });
}

/**
 * Lazily load vendored pdf-lib and @pdf-lib/fontkit from ./vendor/.
 * @returns {Promise<{ PDFLib: any, fontkit: any }>}
 */
export async function loadPdfEngines() {
  if (enginePromise) return enginePromise;

  enginePromise = (async () => {
    ensureFontkitRuntimeShim();
    if (IS_BROWSER) {
      const pdfLibUrl = new URL('../vendor/pdf-lib.min.js', import.meta.url).href;
      const fontkitUrl = new URL('../vendor/fontkit.umd.min.js', import.meta.url).href;
      if (!window.PDFLib) await loadClassicScript(pdfLibUrl);
      if (!window.fontkit) await loadClassicScript(fontkitUrl);
      return { PDFLib: window.PDFLib, fontkit: window.fontkit };
    }

    if (typeof globalThis.self === 'undefined') {
      globalThis.self = globalThis;
    }
    await import('../vendor/pdf-lib.min.js');
    await import('../vendor/fontkit.umd.min.js');
    return {
      PDFLib: globalThis.PDFLib,
      fontkit: globalThis.fontkit
    };
  })();

  return enginePromise;
}

/**
 * Load raw font bytes (.woff) from local ./fonts/ folder and cache in memory.
 * @param {string} relPathFromRoot e.g. './fonts/eb-garamond-400.woff'
 * @returns {Promise<Uint8Array>}
 */
export async function loadFontBytes(relPathFromRoot) {
  if (fontBytesCache.has(relPathFromRoot)) {
    return fontBytesCache.get(relPathFromRoot);
  }
  const cleanRel = relPathFromRoot.replace(/^\.\//, '');
  const resolvedUrl = new URL(`../${cleanRel}`, import.meta.url);

  let bytes;
  if (IS_BROWSER) {
    const res = await fetch(resolvedUrl.href);
    if (!res.ok) {
      throw new Error(`Could not load bundled font: ${cleanRel} (${res.status})`);
    }
    bytes = new Uint8Array(await res.arrayBuffer());
  } else {
    const fs = await import('node:fs/promises');
    const buf = await fs.readFile(resolvedUrl);
    bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  fontBytesCache.set(relPathFromRoot, bytes);
  return bytes;
}

async function getFontkitFont(relPath) {
  if (fontkitInstanceCache.has(relPath)) {
    return fontkitInstanceCache.get(relPath);
  }
  const { fontkit } = await loadPdfEngines();
  const bytes = await loadFontBytes(relPath);
  const fk = fontkit.create(bytes);
  fontkitInstanceCache.set(relPath, fk);
  return fk;
}

/**
 * Detect whether a Unicode code point belongs to Devanagari or Indian Rupee sign.
 * @param {number} cp
 */
export function isDevanagariCodePoint(cp) {
  return (
    (cp >= 0x0900 && cp <= 0x097f) || // Devanagari block (includes । and ॥)
    (cp >= 0xa8e0 && cp <= 0xa8ff) || // Devanagari Extended
    cp === 0x20b9 || // Indian Rupee sign ₹
    cp === 0x200c || // ZWNJ (used in Devanagari conjunct control)
    cp === 0x200d    // ZWJ (used in Devanagari eyelash/half-forms)
  );
}

/**
 * Detect whether any Devanagari code point exists in a string.
 * @param {string} text
 */
export function containsDevanagari(text) {
  if (!text) return false;
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i);
    if (cp > 0xffff) i++;
    if (isDevanagariCodePoint(cp)) return true;
  }
  return false;
}

/**
 * Normalize control characters and replace unsupported exotic symbols/pictographs
 * so PDF font encoders never throw on unmapped glyphs.
 * @param {string} text
 */
export function sanitizePrintText(text) {
  if (!text) return '';
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '    ')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '');
}

/**
 * Split a single-line string into contiguous script runs ('primary' | 'deva' | 'latin')
 * and filter any code points absent from the target font face.
 */
export function segmentTextRuns(text, primaryFontId, fkSuite, style = 'regular') {
  const clean = sanitizePrintText(text).replace(/\n/g, ' ');
  if (!clean) return [];

  const primaryIsDeva = primaryFontId === 'noto-devanagari';
  const runs = [];
  let currentBucket = null;
  let currentText = '';

  const pickFace = (bucket) => {
    if (bucket === 'deva') {
      return style === 'bold' ? fkSuite.devaBold : fkSuite.devaRegular;
    }
    if (bucket === 'latin') {
      if (style === 'bold') return fkSuite.latinBold;
      if (style === 'italic') return fkSuite.latinItalic;
      return fkSuite.latinRegular;
    }
    if (style === 'bold') return fkSuite.bold;
    if (style === 'italic') return fkSuite.italic;
    return fkSuite.regular;
  };

  for (const ch of clean) {
    const cp = ch.codePointAt(0);
    let bucket = 'primary';

    if (primaryIsDeva) {
      if (cp === 0x20 || isDevanagariCodePoint(cp)) {
        bucket = currentBucket === 'latin' && cp === 0x20 ? 'latin' : 'primary';
      } else if (fkSuite.regular.hasGlyphForCodePoint(cp)) {
        bucket = 'primary';
      } else {
        bucket = 'latin';
      }
    } else if (isDevanagariCodePoint(cp)) {
      bucket = 'deva';
    } else if (cp === 0x20 && currentBucket === 'deva') {
      bucket = 'deva';
    }

    let face = pickFace(bucket);
    let outChar = ch;
    if (!face.hasGlyphForCodePoint(cp)) {
      // Try Latin fallback, then ASCII replacement
      if (fkSuite.latinRegular.hasGlyphForCodePoint(cp)) {
        bucket = 'latin';
        face = pickFace('latin');
      } else if (fkSuite.devaRegular.hasGlyphForCodePoint(cp)) {
        bucket = primaryIsDeva ? 'primary' : 'deva';
        face = pickFace(bucket);
      } else {
        // Replace smart punctuation or skip unmapped symbol
        const asciiFallback = ch
          .normalize('NFKD')
          .replace(/[\u0300-\u036f]/g, '');
        if (asciiFallback && face.hasGlyphForCodePoint(asciiFallback.codePointAt(0))) {
          outChar = asciiFallback[0];
        } else {
          continue;
        }
      }
    }

    if (bucket !== currentBucket && currentText) {
      runs.push({ bucket: currentBucket, text: currentText });
      currentText = '';
    }
    currentBucket = bucket;
    currentText += outChar;
  }

  if (currentText) {
    runs.push({ bucket: currentBucket, text: currentText });
  }
  return runs;
}

/**
 * Load OpenType metrics suite for exact line-wrapping & pagination (works for
 * both canvas preview and PDF generation with identical glyph widths).
 *
 * @param {string} [fontId='eb-garamond']
 */
export async function loadFontMetricsSuite(fontId = 'eb-garamond') {
  const entry = FONT_CATALOG[fontId] || FONT_CATALOG['eb-garamond'];
  const latinEntry = FONT_CATALOG.inter;
  const devaEntry = FONT_CATALOG['noto-devanagari'];

  const [regular, italic, bold, latinRegular, latinItalic, latinBold, devaRegular, devaBold] =
    await Promise.all([
      getFontkitFont(entry.files.regular),
      getFontkitFont(entry.files.italic),
      getFontkitFont(entry.files.bold),
      getFontkitFont(latinEntry.files.regular),
      getFontkitFont(latinEntry.files.italic),
      getFontkitFont(latinEntry.files.bold),
      getFontkitFont(devaEntry.files.regular),
      getFontkitFont(devaEntry.files.bold)
    ]);

  const fkSuite = {
    fontId: entry.id,
    cssFamily: entry.cssFamily,
    regular,
    italic,
    bold,
    latinRegular,
    latinItalic,
    latinBold,
    devaRegular,
    devaBold
  };

  const widthCache = new Map();

  function measureFaceWidth(fkFont, str, sizePt) {
    if (!str) return 0;
    const run = fkFont.layout(str);
    return (run.advanceWidth / fkFont.unitsPerEm) * sizePt;
  }

  function measureText(text, sizePt, style = 'regular') {
    if (!text) return 0;
    const key = `${style}:${sizePt}:${text}`;
    if (widthCache.has(key)) return widthCache.get(key);

    const runs = segmentTextRuns(text, entry.id, fkSuite, style);
    let total = 0;
    for (const r of runs) {
      let face = fkSuite.regular;
      if (r.bucket === 'deva') {
        face = style === 'bold' ? fkSuite.devaBold : fkSuite.devaRegular;
      } else if (r.bucket === 'latin') {
        face =
          style === 'bold'
            ? fkSuite.latinBold
            : style === 'italic'
              ? fkSuite.latinItalic
              : fkSuite.latinRegular;
      } else {
        face =
          style === 'bold'
            ? fkSuite.bold
            : style === 'italic'
              ? fkSuite.italic
              : fkSuite.regular;
      }
      total += measureFaceWidth(face, r.text, sizePt);
    }

    if (widthCache.size < 12000) {
      widthCache.set(key, total);
    }
    return total;
  }

  return {
    ...fkSuite,
    measureText,
    segmentRuns: (text, style = 'regular') => segmentTextRuns(text, entry.id, fkSuite, style)
  };
}

/**
 * Embed the chosen OFL font family (plus script fallbacks only if used) into a PDFDocument.
 */
export async function embedPdfFontSuite(pdfDoc, fontId = 'eb-garamond', options = {}) {
  const { fontkit } = await loadPdfEngines();
  pdfDoc.registerFontkit(fontkit);

  const entry = FONT_CATALOG[fontId] || FONT_CATALOG['eb-garamond'];
  const metrics = await loadFontMetricsSuite(entry.id);

  const [regBytes, itBytes, boldBytes] = await Promise.all([
    loadFontBytes(entry.files.regular),
    loadFontBytes(entry.files.italic),
    loadFontBytes(entry.files.bold)
  ]);

  const regular = await pdfDoc.embedFont(regBytes, { subset: true });
  const italic =
    entry.files.italic === entry.files.regular
      ? regular
      : await pdfDoc.embedFont(itBytes, { subset: true });
  const bold = await pdfDoc.embedFont(boldBytes, { subset: true });

  let devaRegular = null;
  let devaBold = null;
  let latinRegular = null;
  let latinItalic = null;
  let latinBold = null;

  async function ensureDeva() {
    if (!devaRegular) {
      const [dr, db] = await Promise.all([
        loadFontBytes(FONT_CATALOG['noto-devanagari'].files.regular),
        loadFontBytes(FONT_CATALOG['noto-devanagari'].files.bold)
      ]);
      devaRegular = await pdfDoc.embedFont(dr, { subset: true });
      devaBold = await pdfDoc.embedFont(db, { subset: true });
    }
  }

  async function ensureLatin() {
    if (!latinRegular) {
      const [lr, li, lb] = await Promise.all([
        loadFontBytes(FONT_CATALOG.inter.files.regular),
        loadFontBytes(FONT_CATALOG.inter.files.italic),
        loadFontBytes(FONT_CATALOG.inter.files.bold)
      ]);
      latinRegular = await pdfDoc.embedFont(lr, { subset: true });
      latinItalic = await pdfDoc.embedFont(li, { subset: true });
      latinBold = await pdfDoc.embedFont(lb, { subset: true });
    }
  }

  if (options.preloadDevanagari && entry.id !== 'noto-devanagari') {
    await ensureDeva();
  }
  if (entry.id === 'noto-devanagari') {
    await ensureLatin();
  }

  /**
   * Draw segmented text at (x, y) using embedded primary + fallback fonts,
   * supporting left, center, right, and word-spaced full justification.
   */
  async function drawSegmentedLine(page, text, drawOpts) {
    const {
      x,
      y,
      size,
      style = 'regular',
      color,
      align = 'left',
      maxWidth = 0,
      justify = false,
      rotate
    } = drawOpts;

    const runs = metrics.segmentRuns(text, style);
    if (!runs.length) return;

    for (const r of runs) {
      if (r.bucket === 'deva') await ensureDeva();
      if (r.bucket === 'latin') await ensureLatin();
    }

    const pickPdfFont = (bucket) => {
      if (bucket === 'deva') return style === 'bold' ? devaBold : devaRegular;
      if (bucket === 'latin') {
        return style === 'bold' ? latinBold : style === 'italic' ? latinItalic : latinRegular;
      }
      return style === 'bold' ? bold : style === 'italic' ? italic : regular;
    };

    if (rotate) {
      // Single-run or sequential rotated spine text
      const f = pickPdfFont(runs[0].bucket);
      page.drawText(runs.map((r) => r.text).join(''), {
        x,
        y,
        size,
        font: f,
        color,
        rotate
      });
      return;
    }

    // Full justification across word spaces when enabled and single-script or multi-word
    if (justify && maxWidth > 0 && text.includes(' ')) {
      const words = text.trim().split(/\s+/);
      if (words.length > 1) {
        let wordsWidth = 0;
        for (const w of words) {
          wordsWidth += metrics.measureText(w, size, style);
        }
        const naturalGap = metrics.measureText(' ', size, style);
        const extraTotal = maxWidth - wordsWidth;
        const gap = extraTotal / (words.length - 1);
        if (gap >= naturalGap * 0.65 && gap <= naturalGap * 2.8) {
          let cursorX = x;
          for (let i = 0; i < words.length; i++) {
            const wRuns = metrics.segmentRuns(words[i], style);
            for (const wr of wRuns) {
              if (wr.bucket === 'deva') await ensureDeva();
              if (wr.bucket === 'latin') await ensureLatin();
              const pf = pickPdfFont(wr.bucket);
              page.drawText(wr.text, { x: cursorX, y, size, font: pf, color });
              cursorX += pf.widthOfTextAtSize(wr.text, size);
            }
            cursorX += gap;
          }
          return;
        }
      }
    }

    // Measure total natural width across runs
    let totalWidth = 0;
    const resolved = runs.map((r) => {
      const pf = pickPdfFont(r.bucket);
      const w = pf.widthOfTextAtSize(r.text, size);
      totalWidth += w;
      return { text: r.text, font: pf, width: w };
    });

    let startX = x;
    if (align === 'center' && maxWidth > 0) {
      startX = x + (maxWidth - totalWidth) / 2;
    } else if (align === 'right' && maxWidth > 0) {
      startX = x + (maxWidth - totalWidth);
    }

    let cursorX = startX;
    for (const seg of resolved) {
      page.drawText(seg.text, {
        x: cursorX,
        y,
        size,
        font: seg.font,
        color
      });
      cursorX += seg.width;
    }
  }

  return {
    fontId: entry.id,
    metrics,
    regular,
    italic,
    bold,
    drawSegmentedLine
  };
}

/**
 * Yield back to the browser's main UI thread on animation frames so Android
 * devices stay silky-smooth and responsive to Cancel taps during generation.
 *
 * @param {AbortSignal} [signal]
 */
export function yieldToMain(signal) {
  if (signal?.aborted) {
    const err = new Error('Operation cancelled by user');
    err.name = 'AbortError';
    throw err;
  }
  return new Promise((resolve, reject) => {
    const complete = () => {
      if (signal?.aborted) {
        const err = new Error('Operation cancelled by user');
        err.name = 'AbortError';
        reject(err);
      } else {
        resolve();
      }
    };
    if (IS_BROWSER && typeof window.requestAnimationFrame === 'function' && document.visibilityState === 'visible') {
      window.requestAnimationFrame(complete);
    } else {
      setTimeout(complete, 0);
    }
  });
}
