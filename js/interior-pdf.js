/**
 * KDP Studio — Chunked KDP Interior PDF Generator & Live Canvas Page Renderer
 *
 * Generates print-ready KDP interior PDFs with subset-embedded OFL fonts,
 * zero crop marks, and chunked requestAnimationFrame yields so Android phones
 * stay responsive and cancellable throughout generation.
 */

import { FONT_CATALOG, PAPER_TYPES } from './config.js';
import { loadPdfEngines, embedPdfFontSuite, yieldToMain } from './pdf-loader.js';
import { paginateBook } from './paginator.js';

const PAGES_PER_CHUNK = 4;

/**
 * Generate a KDP-compliant Interior PDF in non-blocking chunks.
 *
 * @param {object} params
 * @param {object} params.parsedManuscript
 * @param {object} params.bookMeta
 * @param {object} params.layout
 * @param {AbortSignal} [params.signal]
 * @param {(progress: { percent: number, label: string, current?: number, total?: number }) => void} [params.onProgress]
 */
export async function generateInteriorPdf({
  parsedManuscript,
  bookMeta = {},
  layout = {},
  signal,
  onProgress
}) {
  const report = (percent, label, current = 0, total = 0) => {
    if (typeof onProgress === 'function') {
      onProgress({ percent, label, current, total });
    }
  };

  report(4, 'Loading local PDF engine and OFL font metrics...');
  const { PDFLib } = await loadPdfEngines();
  await yieldToMain(signal);

  report(12, 'Running two-pass KDP pagination and TOC numbering...');
  const paginated = await paginateBook({ parsedManuscript, bookMeta, layout });
  await yieldToMain(signal);

  const { interior, pages } = paginated;
  const pdfDoc = await PDFLib.PDFDocument.create();
  pdfDoc.setTitle((bookMeta.title || 'Untitled Book').trim());
  pdfDoc.setAuthor((bookMeta.author || 'Independent Author').trim());
  if (bookMeta.subtitle) pdfDoc.setSubject(bookMeta.subtitle.trim());
  pdfDoc.setCreator('KDP Studio (Offline Browser Print Engine)');
  pdfDoc.setProducer('KDP Studio via pdf-lib');

  report(20, 'Embedding subsetted OFL fonts...');
  const fontSuite = await embedPdfFontSuite(pdfDoc, paginated.fontId, {
    preloadDevanagari: Boolean(parsedManuscript.hasDevanagari)
  });
  await yieldToMain(signal);

  const blackInk = PDFLib.rgb(0, 0, 0);
  const headerInk = PDFLib.rgb(0.22, 0.22, 0.22);
  const ruleInk = PDFLib.rgb(0.28, 0.28, 0.28);
  const leaderInk = PDFLib.rgb(0.45, 0.45, 0.45);

  const totalPages = pages.length;

  for (let i = 0; i < totalPages; i++) {
    const pModel = pages[i];
    const pdfPage = pdfDoc.addPage([interior.pageWidthPt, interior.pageHeightPt]);

    for (const item of pModel.items) {
      if (item.type === 'text' || item.type === 'running-header' || item.type === 'folio') {
        const ink = item.type === 'running-header' ? headerInk : blackInk;
        await fontSuite.drawSegmentedLine(pdfPage, item.text, {
          x: item.xPt,
          y: item.yPt,
          size: item.sizePt,
          style: item.style || 'regular',
          color: ink,
          align: item.align || 'left',
          maxWidth: item.maxWidthPt || 0,
          justify: Boolean(item.justify)
        });
      } else if (item.type === 'rule') {
        pdfPage.drawLine({
          start: { x: item.x1Pt, y: item.y1Pt },
          end: { x: item.x2Pt, y: item.y2Pt },
          thickness: item.thicknessPt || 0.6,
          color: ruleInk
        });
      } else if (item.type === 'leader-dots') {
        const step = 5.5;
        for (let dx = item.x1Pt; dx <= item.x2Pt; dx += step) {
          pdfPage.drawCircle({
            x: dx,
            y: item.yPt,
            size: 0.55,
            color: leaderInk
          });
        }
      } else if (item.type === 'ornament-diamond') {
        const halfSpan = (item.spanPt || 100) / 2;
        const d = 3.2;
        pdfPage.drawLine({
          start: { x: item.cxPt - halfSpan, y: item.cyPt },
          end: { x: item.cxPt - 8, y: item.cyPt },
          thickness: 0.55,
          color: ruleInk
        });
        pdfPage.drawLine({
          start: { x: item.cxPt + 8, y: item.cyPt },
          end: { x: item.cxPt + halfSpan, y: item.cyPt },
          thickness: 0.55,
          color: ruleInk
        });
        // Small geometric diamond (pure vector lines — zero emoji)
        pdfPage.drawLine({
          start: { x: item.cxPt - d, y: item.cyPt },
          end: { x: item.cxPt, y: item.cyPt + d },
          thickness: 0.7,
          color: ruleInk
        });
        pdfPage.drawLine({
          start: { x: item.cxPt, y: item.cyPt + d },
          end: { x: item.cxPt + d, y: item.cyPt },
          thickness: 0.7,
          color: ruleInk
        });
        pdfPage.drawLine({
          start: { x: item.cxPt + d, y: item.cyPt },
          end: { x: item.cxPt, y: item.cyPt - d },
          thickness: 0.7,
          color: ruleInk
        });
        pdfPage.drawLine({
          start: { x: item.cxPt, y: item.cyPt - d },
          end: { x: item.cxPt - d, y: item.cyPt },
          thickness: 0.7,
          color: ruleInk
        });
      }
    }

    if ((i + 1) % PAGES_PER_CHUNK === 0 || i === totalPages - 1) {
      const pct = 22 + Math.round(((i + 1) / totalPages) * 68);
      report(pct, `Typesetting page ${i + 1} of ${totalPages}...`, i + 1, totalPages);
      await yieldToMain(signal);
    }
  }

  report(94, 'Serializing KDP print-ready PDF stream...');
  const pdfBytes = await pdfDoc.save({ useObjectStreams: false });
  await yieldToMain(signal);
  report(100, `Interior PDF ready (${totalPages} pages)`, totalPages, totalPages);

  return {
    pdfBytes,
    paginated,
    pageCount: totalPages,
    interior
  };
}

/**
 * Render a single paginated interior page onto an HTML5 <canvas> for live mobile preview.
 */
export function renderInteriorPageToCanvas(canvas, paginatedBook, pageIndex = 0, options = {}) {
  if (!canvas || !paginatedBook || !paginatedBook.pages.length) return;

  const clampedIdx = Math.max(0, Math.min(paginatedBook.pages.length - 1, pageIndex));
  const pageModel = paginatedBook.pages[clampedIdx];
  const { interior } = paginatedBook;

  const containerWidth = Math.max(240, Math.min(options.maxCssWidth || 380, 520));
  const aspect = interior.pageHeightPt / interior.pageWidthPt;
  const cssWidth = containerWidth;
  const cssHeight = Math.round(cssWidth * aspect);
  const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2.5) : 1;

  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;

  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.scale(dpr, dpr);

  const scale = cssWidth / interior.pageWidthPt;
  const toX = (pt) => pt * scale;
  const toY = (pdfYPt) => (interior.pageHeightPt - pdfYPt) * scale;

  const paperSpec = PAPER_TYPES[paginatedBook.paperType] || PAPER_TYPES.white;
  ctx.fillStyle = paperSpec.previewHex;
  ctx.fillRect(0, 0, cssWidth, cssHeight);

  // Subtle gutter binding gradient to show recto vs verso orientation intuitively
  const gradWidth = 18;
  const gutterX = pageModel.isRecto ? 0 : cssWidth - gradWidth;
  const grad = ctx.createLinearGradient(
    pageModel.isRecto ? 0 : cssWidth,
    0,
    pageModel.isRecto ? gradWidth : cssWidth - gradWidth,
    0
  );
  grad.addColorStop(0, 'rgba(15, 20, 30, 0.10)');
  grad.addColorStop(1, 'rgba(15, 20, 30, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(gutterX, 0, gradWidth, cssHeight);

  // Optional KDP Bleed + Margin Safe-Zone Guides
  if (options.showGuides !== false) {
    if (interior.bleed) {
      const tb = pageModel.frame.trimBoxIn;
      const tx = tb.x * 72 * scale;
      const ty = (interior.pageHeightIn - tb.y - tb.height) * 72 * scale;
      const tw = tb.width * 72 * scale;
      const th = tb.height * 72 * scale;
      ctx.save();
      ctx.strokeStyle = 'rgba(217, 78, 52, 0.65)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(tx, ty, tw, th);
      ctx.restore();
    }

    const f = pageModel.frame;
    const mx = toX(f.xLeftPt);
    const my = toY(f.yTopPt);
    const mw = (f.xRightPt - f.xLeftPt) * scale;
    const mh = (f.yTopPt - f.yBottomPt) * scale;
    ctx.save();
    ctx.strokeStyle = 'rgba(59, 118, 214, 0.35)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(mx, my, mw, mh);
    ctx.restore();
  }

  const fontEntry = FONT_CATALOG[paginatedBook.fontId] || FONT_CATALOG['eb-garamond'];
  const cssFamily = fontEntry.cssFamily;
  const inkColor = paperSpec.previewInkHex;

  for (const item of pageModel.items) {
    if (item.type === 'text' || item.type === 'running-header' || item.type === 'folio') {
      const pxSize = item.sizePt * scale;
      const weight = item.style === 'bold' ? '700' : '400';
      const fStyle = item.style === 'italic' ? 'italic' : 'normal';
      ctx.font = `${fStyle} ${weight} ${pxSize.toFixed(2)}px ${cssFamily}`;
      ctx.fillStyle = item.type === 'running-header' ? 'rgba(40,42,48,0.68)' : inkColor;
      ctx.textBaseline = 'alphabetic';

      const y = toY(item.yPt);
      const x = toX(item.xPt);
      const maxW = (item.maxWidthPt || 0) * scale;

      if (item.justify && maxW > 0 && item.text.includes(' ')) {
        const words = item.text.trim().split(/\s+/);
        let wordsW = 0;
        for (const w of words) wordsW += ctx.measureText(w).width;
        const gap = words.length > 1 ? (maxW - wordsW) / (words.length - 1) : 0;
        const naturalSpace = ctx.measureText(' ').width;
        if (words.length > 1 && gap >= naturalSpace * 0.6 && gap <= naturalSpace * 3.0) {
          let cx = x;
          for (const w of words) {
            ctx.fillText(w, cx, y);
            cx += ctx.measureText(w).width + gap;
          }
          continue;
        }
      }

      const measured = ctx.measureText(item.text).width;
      let drawX = x;
      if (item.align === 'center' && maxW > 0) {
        drawX = x + (maxW - measured) / 2;
      } else if (item.align === 'right' && maxW > 0) {
        drawX = x + (maxW - measured);
      }
      ctx.fillText(item.text, drawX, y);
    } else if (item.type === 'rule') {
      ctx.save();
      ctx.strokeStyle = 'rgba(45, 45, 50, 0.72)';
      ctx.lineWidth = Math.max(0.75, (item.thicknessPt || 0.6) * scale);
      ctx.beginPath();
      ctx.moveTo(toX(item.x1Pt), toY(item.y1Pt));
      ctx.lineTo(toX(item.x2Pt), toY(item.y2Pt));
      ctx.stroke();
      ctx.restore();
    } else if (item.type === 'leader-dots') {
      ctx.save();
      ctx.fillStyle = 'rgba(80, 82, 90, 0.55)';
      for (let dx = item.x1Pt; dx <= item.x2Pt; dx += 5.5) {
        ctx.beginPath();
        ctx.arc(toX(dx), toY(item.yPt), Math.max(0.7, 0.65 * scale), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    } else if (item.type === 'ornament-diamond') {
      const halfSpan = (item.spanPt || 100) / 2;
      const d = 3.2;
      ctx.save();
      ctx.strokeStyle = 'rgba(45, 45, 50, 0.72)';
      ctx.lineWidth = Math.max(0.8, 0.65 * scale);
      ctx.beginPath();
      ctx.moveTo(toX(item.cxPt - halfSpan), toY(item.cyPt));
      ctx.lineTo(toX(item.cxPt - 8), toY(item.cyPt));
      ctx.moveTo(toX(item.cxPt + 8), toY(item.cyPt));
      ctx.lineTo(toX(item.cxPt + halfSpan), toY(item.cyPt));
      ctx.moveTo(toX(item.cxPt - d), toY(item.cyPt));
      ctx.lineTo(toX(item.cxPt), toY(item.cyPt + d));
      ctx.lineTo(toX(item.cxPt + d), toY(item.cyPt));
      ctx.lineTo(toX(item.cxPt), toY(item.cyPt - d));
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }
  }

  if (pageModel.kind === 'blank') {
    ctx.save();
    ctx.fillStyle = 'rgba(90, 96, 110, 0.42)';
    ctx.font = `500 11px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('Intentional Blank Verso Page (Recto Alignment)', cssWidth / 2, cssHeight / 2);
    ctx.restore();
  }

  ctx.restore();
}
