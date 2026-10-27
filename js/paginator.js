/**
 * KDP Studio — Two-Pass Book Typesetter & Pagination Engine
 *
 * Implements:
 * - Recto (right-hand / odd-page) chapter starts with automatic blank verso alignment
 * - Auto-generated Table of Contents populated with real post-pagination page numbers
 * - Two-pass gutter fixed-point convergence (so crossing 150/300/500/700 pages updates margins)
 * - Keep-with-next heading protection (never leaves a chapter or section heading at page bottom)
 * - 3 chapter opener styles (classic, modern, ornate) and orthographic 3-line drop caps
 * - Running headers (book title on even pages, chapter title on odd pages)
 * - Configurable page numbers (bottom-center or outer-corners)
 * - Guaranteed even final page count padded with blank pages when needed
 */

import {
  computeInteriorDimensions,
  getInteriorPageFrame,
  padToEvenPageCount
} from './layout-math.js';
import { loadFontMetricsSuite } from './pdf-loader.js';

const graphemeSegmenter =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

/**
 * Split opening grapheme cluster (preserving Hindi/Devanagari conjunct + matra syllables)
 * for 3-line sunken drop caps.
 */
export function extractDropCapCluster(text) {
  const trimmed = (text || '').trimStart();
  if (!trimmed) return { dropCap: '', rest: '' };

  if (graphemeSegmenter) {
    const segments = Array.from(graphemeSegmenter.segment(trimmed), (s) => s.segment);
    if (!segments.length) return { dropCap: '', rest: '' };
    const openQuote = /^["'“‘«]$/.test(segments[0]);
    if (openQuote && segments.length >= 2) {
      const cluster = segments[0] + segments[1];
      return { dropCap: cluster, rest: segments.slice(2).join('') };
    }
    return { dropCap: segments[0], rest: segments.slice(1).join('') };
  }

  const firstCp = trimmed.codePointAt(0);
  const step = firstCp > 0xffff ? 2 : 1;
  return { dropCap: trimmed.slice(0, step), rest: trimmed.slice(step) };
}

/**
 * Wrap a paragraph into positioned lines using OpenType advance-width measurement.
 */
export function wrapTextToLines(text, metrics, sizePt, style, getLineSpec) {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return [];

  const rawWords = normalized.split(' ');
  const lines = [];
  let lineIndex = 0;
  let currentSpec = getLineSpec(lineIndex);
  let currentLine = '';

  const breakOversizedWord = (word, maxWidth) => {
    const parts = [];
    const chars = graphemeSegmenter
      ? Array.from(graphemeSegmenter.segment(word), (s) => s.segment)
      : Array.from(word);
    let chunk = '';
    for (const ch of chars) {
      const candidate = chunk + ch;
      if (chunk && metrics.measureText(candidate, sizePt, style) > maxWidth) {
        parts.push(chunk);
        chunk = ch;
      } else {
        chunk = candidate;
      }
    }
    if (chunk) parts.push(chunk);
    return parts;
  };

  let i = 0;
  while (i < rawWords.length) {
    const word = rawWords[i];
    const candidate = currentLine ? `${currentLine} ${word}` : word;
    const width = metrics.measureText(candidate, sizePt, style);

    if (width <= currentSpec.maxWidthPt || (!currentLine && width <= currentSpec.maxWidthPt * 1.02)) {
      currentLine = candidate;
      i++;
    } else if (!currentLine) {
      // Single word wider than column: split cleanly by grapheme
      const chunks = breakOversizedWord(word, currentSpec.maxWidthPt);
      for (let c = 0; c < chunks.length - 1; c++) {
        lines.push({
          text: chunks[c],
          offsetXPt: currentSpec.offsetXPt,
          maxWidthPt: currentSpec.maxWidthPt,
          isLastInParagraph: false
        });
        lineIndex++;
        currentSpec = getLineSpec(lineIndex);
      }
      currentLine = chunks[chunks.length - 1] || '';
      i++;
    } else {
      lines.push({
        text: currentLine,
        offsetXPt: currentSpec.offsetXPt,
        maxWidthPt: currentSpec.maxWidthPt,
        isLastInParagraph: false
      });
      lineIndex++;
      currentSpec = getLineSpec(lineIndex);
      currentLine = '';
    }
  }

  if (currentLine) {
    lines.push({
      text: currentLine,
      offsetXPt: currentSpec.offsetXPt,
      maxWidthPt: currentSpec.maxWidthPt,
      isLastInParagraph: true
    });
  } else if (lines.length > 0) {
    lines[lines.length - 1].isLastInParagraph = true;
  }

  return lines;
}

function truncateToWidth(text, metrics, sizePt, style, maxWidthPt) {
  if (!text) return '';
  if (metrics.measureText(text, sizePt, style) <= maxWidthPt) return text;
  const ellipsis = '...';
  let trimmed = text;
  while (trimmed.length > 1 && metrics.measureText(trimmed + ellipsis, sizePt, style) > maxWidthPt) {
    trimmed = trimmed.slice(0, -1).trimEnd();
  }
  return trimmed + ellipsis;
}

/**
 * Single pagination pass for a fixed interior geometry.
 */
function runSinglePaginationPass({
  parsedManuscript,
  bookMeta,
  layout,
  interior,
  metrics
}) {
  const fontSizePt = Number(layout.fontSizePt) || 11;
  const leading = Number(layout.leading) || 1.42;
  const lineHeightPt = +(fontSizePt * leading).toFixed(3);
  const chapterStyle = layout.chapterStyle || 'classic';
  const dropCaps = Boolean(layout.dropCaps);
  const folioPosition = layout.folioPosition || 'bottom-center';

  const bookTitle = (bookMeta.title || 'Untitled Book').trim();
  const bookSubtitle = (bookMeta.subtitle || '').trim();
  const authorName = (bookMeta.author || 'Independent Author').trim();
  const copyrightYear = (bookMeta.copyrightYear || new Date().getFullYear()).toString();
  const isbn = (bookMeta.isbn || '').trim();

  const pages = [];

  const createPage = (kind, options = {}) => {
    const pageNumber = pages.length + 1;
    const frame = getInteriorPageFrame(interior, pageNumber);
    const pageObj = {
      pageNumber,
      kind, // 'title' | 'copyright' | 'toc' | 'blank' | 'chapter-open' | 'chapter-body'
      isRecto: frame.isRecto,
      isVerso: frame.isVerso,
      chapterTitle: options.chapterTitle || '',
      showRunningHeader: Boolean(options.showRunningHeader),
      showFolio: Boolean(options.showFolio),
      frame,
      items: []
    };
    pages.push(pageObj);
    return pageObj;
  };

  // --- PAGE 1 (Recto): Title Page ---
  {
    const p1 = createPage('title', { showRunningHeader: false, showFolio: false });
    const f = p1.frame;
    const titleSize = Math.min(26, Math.round(fontSizePt * 2.15));
    const subSize = Math.round(fontSizePt * 1.15);
    const authorSize = Math.round(fontSizePt * 1.08);

    const titleLines = wrapTextToLines(bookTitle, metrics, titleSize, 'bold', () => ({
      offsetXPt: 0,
      maxWidthPt: interior.textWidthPt * 0.88
    }));
    let cursorY = f.yTopPt - interior.textHeightPt * 0.24;
    for (const tl of titleLines) {
      p1.items.push({
        type: 'text',
        text: tl.text,
        xPt: f.xLeftPt,
        yPt: cursorY,
        maxWidthPt: interior.textWidthPt,
        sizePt: titleSize,
        style: 'bold',
        align: 'center'
      });
      cursorY -= titleSize * 1.28;
    }

    // Subtle ornament rule
    cursorY -= 8;
    p1.items.push({
      type: 'rule',
      x1Pt: f.xLeftPt + interior.textWidthPt * 0.36,
      y1Pt: cursorY,
      x2Pt: f.xLeftPt + interior.textWidthPt * 0.64,
      y2Pt: cursorY,
      thicknessPt: 0.75
    });
    cursorY -= 22;

    if (bookSubtitle) {
      const subLines = wrapTextToLines(bookSubtitle, metrics, subSize, 'italic', () => ({
        offsetXPt: 0,
        maxWidthPt: interior.textWidthPt * 0.84
      }));
      for (const sl of subLines) {
        p1.items.push({
          type: 'text',
          text: sl.text,
          xPt: f.xLeftPt,
          yPt: cursorY,
          maxWidthPt: interior.textWidthPt,
          sizePt: subSize,
          style: 'italic',
          align: 'center'
        });
        cursorY -= subSize * 1.38;
      }
    }

    p1.items.push({
      type: 'text',
      text: authorName.toUpperCase(),
      xPt: f.xLeftPt,
      yPt: f.yBottomPt + interior.textHeightPt * 0.14,
      maxWidthPt: interior.textWidthPt,
      sizePt: authorSize,
      style: 'regular',
      align: 'center'
    });
  }

  // --- PAGE 2 (Verso): Copyright / Imprint Page ---
  {
    const p2 = createPage('copyright', { showRunningHeader: false, showFolio: false });
    const f = p2.frame;
    const copySize = Math.max(8.5, +(fontSizePt * 0.84).toFixed(1));
    const copyLead = copySize * 1.48;
    const copyLines = [
      bookSubtitle ? `${bookTitle}: ${bookSubtitle}` : bookTitle,
      `Copyright (c) ${copyrightYear} by ${authorName}.`,
      'All rights reserved.',
      '',
      'No part of this publication may be reproduced, stored in a retrieval system,',
      'or transmitted in any form or by any means without prior written permission',
      'of the author, except for brief quotations in critical reviews.',
      ...(isbn ? ['', `ISBN: ${isbn}`] : []),
      '',
      'Typeset and prepared for print with KDP Studio.'
    ];

    let cursorY = f.yBottomPt + Math.min(interior.textHeightPt * 0.42, copyLines.length * copyLead + 18);
    for (const raw of copyLines) {
      if (!raw) {
        cursorY -= copyLead * 0.55;
        continue;
      }
      const wrapped = wrapTextToLines(raw, metrics, copySize, 'regular', () => ({
        offsetXPt: 0,
        maxWidthPt: interior.textWidthPt * 0.92
      }));
      for (const wl of wrapped) {
        p2.items.push({
          type: 'text',
          text: wl.text,
          xPt: f.xLeftPt,
          yPt: cursorY,
          maxWidthPt: interior.textWidthPt,
          sizePt: copySize,
          style: 'regular',
          align: 'left'
        });
        cursorY -= copyLead;
      }
    }
  }

  // --- Reserve Table of Contents Pages (starting on Recto Page 3) ---
  const chapters = parsedManuscript.chapters;
  const tocTitleHeightPt = fontSizePt * 4.5;
  const tocRowHeightPt = fontSizePt * 1.95;
  const firstTocCapacity = Math.max(
    4,
    Math.floor((interior.textHeightPt - tocTitleHeightPt) / tocRowHeightPt)
  );
  const nextTocCapacity = Math.max(6, Math.floor((interior.textHeightPt - 24) / tocRowHeightPt));

  let tocPageCount = 1;
  if (chapters.length > firstTocCapacity) {
    tocPageCount += Math.ceil((chapters.length - firstTocCapacity) / nextTocCapacity);
  }

  const tocPages = [];
  for (let t = 0; t < tocPageCount; t++) {
    tocPages.push(
      createPage('toc', {
        chapterTitle: 'Contents',
        showRunningHeader: t > 0,
        showFolio: false
      })
    );
  }

  // Ensure Chapter 1 opens on a right-hand (recto / odd) page
  if ((pages.length + 1) % 2 === 0) {
    createPage('blank', { showRunningHeader: false, showFolio: false });
  }

  // --- Paginate All Chapters ---
  const tocEntries = [];
  const paraIndentPt = +(fontSizePt * 1.3).toFixed(2);

  for (let cIdx = 0; cIdx < chapters.length; cIdx++) {
    const ch = chapters[cIdx];

    // Enforce recto (odd) start page for every chapter
    if ((pages.length + 1) % 2 === 0) {
      createPage('blank', { showRunningHeader: false, showFolio: false });
    }

    let page = createPage('chapter-open', {
      chapterTitle: ch.title,
      showRunningHeader: false,
      showFolio: true
    });
    const chapterStartPage = page.pageNumber;
    tocEntries.push({
      index: ch.index,
      label: ch.label,
      title: ch.title,
      pageNumber: chapterStartPage
    });

    const titleFontPt = Math.min(22, +(fontSizePt * 1.68).toFixed(1));
    const labelFontPt = Math.max(8.5, +(fontSizePt * 0.82).toFixed(1));
    const headingAlign = chapterStyle === 'modern' ? 'left' : 'center';

    const titleLines = wrapTextToLines(ch.title, metrics, titleFontPt, 'bold', () => ({
      offsetXPt: 0,
      maxWidthPt: interior.textWidthPt * 0.92
    }));

    const headingStackPt =
      labelFontPt * 1.8 + titleLines.length * (titleFontPt * 1.26) + 28;
    const minBodyKeepPt = lineHeightPt * 2.4;
    const desiredSinkPt = Math.min(interior.textHeightPt * 0.16, 78);
    // Compress sink if needed so a chapter heading NEVER strands without >= 2 body lines
    const maxSafeSinkPt = Math.max(
      12,
      interior.textHeightPt - headingStackPt - minBodyKeepPt
    );
    const sinkPt = Math.min(desiredSinkPt, maxSafeSinkPt);

    let cursorY = page.frame.yTopPt - sinkPt;

    // Render Chapter Opener according to chosen chapterStyle ('classic' | 'modern' | 'ornate')
    if (chapterStyle === 'ornate') {
      const cx = page.frame.xLeftPt + interior.textWidthPt / 2;
      page.items.push({
        type: 'ornament-diamond',
        cxPt: cx,
        cyPt: cursorY + 4,
        spanPt: Math.min(130, interior.textWidthPt * 0.42)
      });
      cursorY -= 18;
    }

    page.items.push({
      type: 'text',
      text: ch.label.toUpperCase(),
      xPt: page.frame.xLeftPt,
      yPt: cursorY,
      maxWidthPt: interior.textWidthPt,
      sizePt: labelFontPt,
      style: chapterStyle === 'modern' ? 'bold' : 'regular',
      align: headingAlign
    });
    cursorY -= labelFontPt * 1.9;

    for (const tl of titleLines) {
      page.items.push({
        type: 'text',
        text: tl.text,
        xPt: page.frame.xLeftPt,
        yPt: cursorY,
        maxWidthPt: interior.textWidthPt,
        sizePt: titleFontPt,
        style: 'bold',
        align: headingAlign
      });
      cursorY -= titleFontPt * 1.26;
    }

    if (chapterStyle === 'modern') {
      cursorY -= 2;
      page.items.push({
        type: 'rule',
        x1Pt: page.frame.xLeftPt,
        y1Pt: cursorY,
        x2Pt: page.frame.xLeftPt + 42,
        y2Pt: cursorY,
        thicknessPt: 1.4
      });
      cursorY -= 20;
    } else if (chapterStyle === 'ornate') {
      cursorY -= 4;
      const w = Math.min(120, interior.textWidthPt * 0.36);
      const x1 = page.frame.xLeftPt + (interior.textWidthPt - w) / 2;
      page.items.push({
        type: 'rule',
        x1Pt: x1,
        y1Pt: cursorY,
        x2Pt: x1 + w,
        y2Pt: cursorY,
        thicknessPt: 0.7
      });
      page.items.push({
        type: 'rule',
        x1Pt: x1 + 12,
        y1Pt: cursorY - 3,
        x2Pt: x1 + w - 12,
        y2Pt: cursorY - 3,
        thicknessPt: 0.5
      });
      cursorY -= 22;
    } else {
      // classic
      cursorY -= 4;
      const w = Math.min(72, interior.textWidthPt * 0.22);
      const x1 = page.frame.xLeftPt + (interior.textWidthPt - w) / 2;
      page.items.push({
        type: 'rule',
        x1Pt: x1,
        y1Pt: cursorY,
        x2Pt: x1 + w,
        y2Pt: cursorY,
        thicknessPt: 0.65
      });
      cursorY -= 20;
    }

    const advanceToNewBodyPage = () => {
      page = createPage('chapter-body', {
        chapterTitle: ch.title,
        showRunningHeader: true,
        showFolio: true
      });
      cursorY = page.frame.yTopPt - fontSizePt * 0.85;
    };

    let isFirstParaAfterHeading = true;
    let usedChapterDropCap = false;

    for (let bIdx = 0; bIdx < ch.blocks.length; bIdx++) {
      const block = ch.blocks[bIdx];

      if (block.type === 'scenebreak') {
        if (cursorY - lineHeightPt * 2 < page.frame.yBottomPt) {
          advanceToNewBodyPage();
        } else {
          cursorY -= lineHeightPt * 0.6;
          page.items.push({
            type: 'text',
            text: '*   *   *',
            xPt: page.frame.xLeftPt,
            yPt: cursorY,
            maxWidthPt: interior.textWidthPt,
            sizePt: fontSizePt,
            style: 'regular',
            align: 'center'
          });
          cursorY -= lineHeightPt * 1.4;
        }
        isFirstParaAfterHeading = true;
        continue;
      }

      if (block.type === 'subheading') {
        const subSize = +(fontSizePt * 1.18).toFixed(1);
        const subLead = +(subSize * 1.32).toFixed(2);
        const subLines = wrapTextToLines(block.text, metrics, subSize, 'bold', () => ({
          offsetXPt: 0,
          maxWidthPt: interior.textWidthPt
        }));
        const totalSubHeight =
          lineHeightPt * 0.75 + subLines.length * subLead + lineHeightPt * 0.35;
        // Keep-with-next: NEVER leave a heading as the last line of a page (require >= 2 body lines below)
        const requiredSpace = totalSubHeight + lineHeightPt * 2.1;
        if (cursorY - requiredSpace < page.frame.yBottomPt) {
          advanceToNewBodyPage();
        } else {
          cursorY -= lineHeightPt * 0.75;
        }
        for (const sl of subLines) {
          page.items.push({
            type: 'text',
            text: sl.text,
            xPt: page.frame.xLeftPt,
            yPt: cursorY,
            maxWidthPt: interior.textWidthPt,
            sizePt: subSize,
            style: 'bold',
            align: 'left'
          });
          cursorY -= subLead;
        }
        cursorY -= lineHeightPt * 0.3;
        isFirstParaAfterHeading = true;
        continue;
      }

      if (block.type === 'bullet') {
        const indent = +(fontSizePt * 1.35).toFixed(2);
        const lines = wrapTextToLines(block.text, metrics, fontSizePt, 'regular', () => ({
          offsetXPt: indent,
          maxWidthPt: interior.textWidthPt - indent
        }));
        for (let lIdx = 0; lIdx < lines.length; lIdx++) {
          if (cursorY - fontSizePt * 0.25 < page.frame.yBottomPt) {
            advanceToNewBodyPage();
          }
          if (lIdx === 0) {
            page.items.push({
              type: 'text',
              text: '-',
              xPt: page.frame.xLeftPt + fontSizePt * 0.35,
              yPt: cursorY,
              maxWidthPt: indent,
              sizePt: fontSizePt,
              style: 'bold',
              align: 'left'
            });
          }
          page.items.push({
            type: 'text',
            text: lines[lIdx].text,
            xPt: page.frame.xLeftPt + lines[lIdx].offsetXPt,
            yPt: cursorY,
            maxWidthPt: lines[lIdx].maxWidthPt,
            sizePt: fontSizePt,
            style: 'regular',
            align: 'left',
            justify: !lines[lIdx].isLastInParagraph
          });
          cursorY -= lineHeightPt;
        }
        cursorY -= lineHeightPt * 0.15;
        isFirstParaAfterHeading = false;
        continue;
      }

      // Standard body paragraph (with optional 3-line sunken drop cap on chapter opening)
      const applyDropCap =
        dropCaps && !usedChapterDropCap && isFirstParaAfterHeading && block.text.length >= 2;

      if (applyDropCap) {
        usedChapterDropCap = true;
        const { dropCap, rest } = extractDropCapCluster(block.text);
        const dropSizePt = +(lineHeightPt * 2.55).toFixed(2);
        const dropWidthPt = +(metrics.measureText(dropCap, dropSizePt, 'bold') + fontSizePt * 0.42).toFixed(2);

        // Ensure all 3 drop-cap lines fit together on the current page
        if (cursorY - lineHeightPt * 3 < page.frame.yBottomPt) {
          advanceToNewBodyPage();
        }

        const dropBaselineYPt = cursorY - lineHeightPt * 1.92;
        page.items.push({
          type: 'text',
          text: dropCap,
          xPt: page.frame.xLeftPt,
          yPt: dropBaselineYPt,
          maxWidthPt: dropWidthPt,
          sizePt: dropSizePt,
          style: 'bold',
          align: 'left',
          isDropCap: true
        });

        const lines = wrapTextToLines(rest.trimStart(), metrics, fontSizePt, 'regular', (li) =>
          li < 3
            ? { offsetXPt: dropWidthPt, maxWidthPt: interior.textWidthPt - dropWidthPt }
            : { offsetXPt: 0, maxWidthPt: interior.textWidthPt }
        );

        const lineCount = Math.max(3, lines.length);
        for (let lIdx = 0; lIdx < lineCount; lIdx++) {
          if (cursorY - fontSizePt * 0.25 < page.frame.yBottomPt) {
            advanceToNewBodyPage();
          }
          if (lIdx < lines.length) {
            const ln = lines[lIdx];
            page.items.push({
              type: 'text',
              text: ln.text,
              xPt: page.frame.xLeftPt + ln.offsetXPt,
              yPt: cursorY,
              maxWidthPt: ln.maxWidthPt,
              sizePt: fontSizePt,
              style: 'regular',
              align: 'left',
              justify: !ln.isLastInParagraph
            });
          }
          cursorY -= lineHeightPt;
        }
        isFirstParaAfterHeading = false;
        continue;
      }

      // Regular paragraph: flush-left right after a heading, indented thereafter
      const firstIndent = isFirstParaAfterHeading ? 0 : paraIndentPt;
      const lines = wrapTextToLines(block.text, metrics, fontSizePt, 'regular', (li) =>
        li === 0
          ? { offsetXPt: firstIndent, maxWidthPt: interior.textWidthPt - firstIndent }
          : { offsetXPt: 0, maxWidthPt: interior.textWidthPt }
      );

      // Basic orphan guard: if >= 2 lines and only 1 line fits on current page, move cleanly
      const remainingLinesOnPage = Math.floor((cursorY - page.frame.yBottomPt) / lineHeightPt) + 1;
      if (lines.length >= 2 && remainingLinesOnPage === 1 && page.kind !== 'chapter-open') {
        advanceToNewBodyPage();
      }

      for (let lIdx = 0; lIdx < lines.length; lIdx++) {
        if (cursorY - fontSizePt * 0.2 < page.frame.yBottomPt) {
          advanceToNewBodyPage();
        }
        const ln = lines[lIdx];
        page.items.push({
          type: 'text',
          text: ln.text,
          xPt: page.frame.xLeftPt + ln.offsetXPt,
          yPt: cursorY,
          maxWidthPt: ln.maxWidthPt,
          sizePt: fontSizePt,
          style: 'regular',
          align: 'left',
          justify: !ln.isLastInParagraph
        });
        cursorY -= lineHeightPt;
      }
      isFirstParaAfterHeading = false;
    }
  }

  // --- Pad Final Page Count to Even ---
  if (pages.length % 2 !== 0) {
    createPage('blank', { showRunningHeader: false, showFolio: false });
  }

  // --- Populate Auto-Generated Table of Contents With Real Page Numbers ---
  let entryCursor = 0;
  for (let t = 0; t < tocPages.length; t++) {
    const tp = tocPages[t];
    const f = tp.frame;
    let cursorY = f.yTopPt - 18;

    if (t === 0) {
      const tocHeadingPt = Math.min(19, +(fontSizePt * 1.55).toFixed(1));
      tp.items.push({
        type: 'text',
        text: 'CONTENTS',
        xPt: f.xLeftPt,
        yPt: cursorY,
        maxWidthPt: interior.textWidthPt,
        sizePt: tocHeadingPt,
        style: 'bold',
        align: chapterStyle === 'modern' ? 'left' : 'center'
      });
      cursorY -= tocHeadingPt * 1.4;
      tp.items.push({
        type: 'rule',
        x1Pt: f.xLeftPt,
        y1Pt: cursorY,
        x2Pt: f.xRightPt,
        y2Pt: cursorY,
        thicknessPt: 0.5
      });
      cursorY -= tocRowHeightPt * 1.05;
    } else {
      cursorY -= 12;
    }

    const cap = t === 0 ? firstTocCapacity : nextTocCapacity;
    const slice = tocEntries.slice(entryCursor, entryCursor + cap);
    entryCursor += slice.length;

    const rowFontPt = +(fontSizePt * 0.96).toFixed(1);
    for (const entry of slice) {
      const pageNumStr = String(entry.pageNumber);
      const numWidth = metrics.measureText(pageNumStr, rowFontPt, 'regular') + 14;
      const titleDisplay = truncateToWidth(
        entry.title,
        metrics,
        rowFontPt,
        'regular',
        interior.textWidthPt - numWidth - 24
      );
      const titleWidth = metrics.measureText(titleDisplay, rowFontPt, 'regular');

      tp.items.push({
        type: 'text',
        text: titleDisplay,
        xPt: f.xLeftPt,
        yPt: cursorY,
        maxWidthPt: interior.textWidthPt - numWidth,
        sizePt: rowFontPt,
        style: 'regular',
        align: 'left'
      });

      // Subtle dotted leader line between title and real page number
      const leaderStartX = f.xLeftPt + titleWidth + 8;
      const leaderEndX = f.xRightPt - numWidth + 6;
      if (leaderEndX - leaderStartX > 16) {
        tp.items.push({
          type: 'leader-dots',
          x1Pt: leaderStartX,
          x2Pt: leaderEndX,
          yPt: cursorY + 2
        });
      }

      tp.items.push({
        type: 'text',
        text: pageNumStr,
        xPt: f.xLeftPt,
        yPt: cursorY,
        maxWidthPt: interior.textWidthPt,
        sizePt: rowFontPt,
        style: 'regular',
        align: 'right'
      });

      cursorY -= tocRowHeightPt;
    }
  }

  // --- Attach Running Headers & Page Numbers (Folios) ---
  const headerFontPt = Math.max(7.5, +(fontSizePt * 0.78).toFixed(1));
  const folioFontPt = Math.max(8, +(fontSizePt * 0.84).toFixed(1));

  for (const p of pages) {
    if (p.showRunningHeader) {
      // Book title on even (verso) pages; chapter title on odd (recto) pages
      const rawHeader = p.isVerso ? bookTitle : p.chapterTitle || bookTitle;
      const headerText = truncateToWidth(
        rawHeader.toUpperCase(),
        metrics,
        headerFontPt,
        'regular',
        interior.textWidthPt * 0.88
      );
      p.items.push({
        type: 'running-header',
        text: headerText,
        xPt: p.frame.xLeftPt,
        yPt: p.frame.headerYPt,
        maxWidthPt: interior.textWidthPt,
        sizePt: headerFontPt,
        style: 'regular',
        align: 'center'
      });
    }

    if (p.showFolio) {
      const folioAlign =
        folioPosition === 'outer-corners'
          ? p.isVerso
            ? 'left'
            : 'right'
          : 'center';
      p.items.push({
        type: 'folio',
        text: String(p.pageNumber),
        xPt: p.frame.xLeftPt,
        yPt: p.frame.folioYPt,
        maxWidthPt: interior.textWidthPt,
        sizePt: folioFontPt,
        style: 'regular',
        align: folioAlign
      });
    }
  }

  return {
    interior,
    pages,
    pageCount: pages.length,
    tocEntries,
    fontId: layout.fontId || 'eb-garamond',
    fontSizePt,
    leading,
    lineHeightPt,
    paperType: layout.paperType || 'white'
  };
}

/**
 * Full two-pass KDP pagination with automatic gutter-tier fixed-point convergence.
 */
export async function paginateBook({ parsedManuscript, bookMeta = {}, layout = {} }) {
  const fontId = layout.fontId || 'eb-garamond';
  const metrics = await loadFontMetricsSuite(fontId);

  let estimatedPages = 48;
  let result = null;
  let lastGutter = -1;

  for (let pass = 0; pass < 3; pass++) {
    const interior = computeInteriorDimensions({
      trimSize: layout.trimSize || '6x9',
      bleed: Boolean(layout.bleed),
      pageCount: estimatedPages
    });

    if (result && interior.marginsIn.gutter === lastGutter) {
      break;
    }

    lastGutter = interior.marginsIn.gutter;
    result = runSinglePaginationPass({
      parsedManuscript,
      bookMeta,
      layout,
      interior,
      metrics
    });
    estimatedPages = Math.max(estimatedPages, padToEvenPageCount(result.pageCount));
  }

  // Ensure interior metadata reflects final converged even page count
  const finalInterior = computeInteriorDimensions({
    trimSize: layout.trimSize || '6x9',
    bleed: Boolean(layout.bleed),
    pageCount: result.pageCount
  });

  if (finalInterior.marginsIn.gutter !== result.interior.marginsIn.gutter) {
    result = runSinglePaginationPass({
      parsedManuscript,
      bookMeta,
      layout,
      interior: finalInterior,
      metrics
    });
  } else {
    result.interior = finalInterior;
  }

  return result;
}
