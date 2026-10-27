/**
 * KDP Studio — Manuscript Parser, Chapter Auto-Splitter, and Live Estimator
 *
 * Splits plain text (.txt) and Markdown (.md) manuscripts into chapters on lines
 * starting with "# " or "Chapter N", parses paragraphs, subheadings, bullets,
 * and scene breaks, and computes live word and page estimates.
 */

import { computeInteriorDimensions, padToEvenPageCount } from './layout-math.js';
import { containsDevanagari, sanitizePrintText } from './pdf-loader.js';

const CHAPTER_NUMBER_RE =
  /^chapter\s+(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b(?:\s*[:.\-—–]\s*(.*))?$/i;

const SCENE_BREAK_RE = /^(?:\*\s*\*\s*\*|\*{3,}|-{3,}|_{3,})$/;

/**
 * Determine if a trimmed line is a chapter boundary ("# ..." or "Chapter N...").
 * @param {string} rawLine
 * @returns {{ title: string, explicitLabel: string | null } | null}
 */
export function matchChapterHeading(rawLine) {
  const trimmed = rawLine.trim();
  if (!trimmed) return null;

  // Rule 1: Markdown H1 ("# Heading")
  if (trimmed.startsWith('# ')) {
    const headingText = trimmed.slice(2).trim();
    if (!headingText) return null;
    const chapMatch = headingText.match(CHAPTER_NUMBER_RE);
    if (chapMatch) {
      const rest = (chapMatch[1] || '').trim();
      const prefix = headingText.split(/[:.\-—–]/)[0].trim();
      return {
        title: rest || headingText,
        explicitLabel: rest ? prefix.toUpperCase() : null
      };
    }
    return { title: headingText, explicitLabel: null };
  }

  // Rule 2: Standalone line starting with "Chapter N" (avoid matching long prose sentences)
  if (trimmed.length <= 110 && !/[;,]$/.test(trimmed)) {
    const m = trimmed.match(CHAPTER_NUMBER_RE);
    if (m) {
      const subtitlePart = (m[1] || '').trim();
      const prefixPart = trimmed.split(/[:.\-—–]/)[0].trim();
      return {
        title: subtitlePart || prefixPart,
        explicitLabel: subtitlePart ? prefixPart.toUpperCase() : null
      };
    }
  }

  return null;
}

/**
 * Count words accurately across Latin, Devanagari, and mixed-script text.
 * @param {string} text
 * @returns {number}
 */
export function countWords(text) {
  if (!text) return 0;
  const cleaned = sanitizePrintText(text)
    .replace(/^#+\s*/gm, '')
    .trim();
  if (!cleaned) return 0;
  const tokens = cleaned.match(/[\p{L}\p{M}\p{N}]+(?:['’\-][\p{L}\p{M}\p{N}]+)*/gu);
  return tokens ? tokens.length : 0;
}

/**
 * Parse internal blocks of a chapter body into structured typographic elements.
 * @param {string[]} lines
 */
function parseChapterBlocks(lines) {
  const blocks = [];
  const nonEmptyCount = lines.filter((l) => l.trim().length > 0).length;
  const blankCount = lines.filter((l) => l.trim().length === 0).length;
  // Plain .txt manuscripts pasted from mobile notes often separate paragraphs with single newlines
  const treatSingleNewlineAsParagraph = nonEmptyCount >= 4 && blankCount === 0;

  let paraBuffer = [];

  const flushParagraph = () => {
    if (!paraBuffer.length) return;
    const text = paraBuffer.join(' ').replace(/\s+/g, ' ').trim();
    paraBuffer = [];
    if (text) {
      blocks.push({ type: 'paragraph', text });
    }
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      flushParagraph();
      continue;
    }

    if (SCENE_BREAK_RE.test(trimmed)) {
      flushParagraph();
      blocks.push({ type: 'scenebreak' });
      continue;
    }

    if (/^#{2,3}\s+/.test(trimmed)) {
      flushParagraph();
      blocks.push({
        type: 'subheading',
        text: trimmed.replace(/^#{2,3}\s+/, '').trim()
      });
      continue;
    }

    if (/^(?:[-*•])\s+/.test(trimmed)) {
      flushParagraph();
      blocks.push({
        type: 'bullet',
        text: trimmed.replace(/^(?:[-*•])\s+/, '').trim()
      });
      continue;
    }

    // Strip basic inline markdown bold/italic markers gently so raw ** doesn't print
    const cleanedInline = trimmed
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1');

    if (treatSingleNewlineAsParagraph) {
      blocks.push({ type: 'paragraph', text: cleanedInline });
    } else {
      paraBuffer.push(cleanedInline);
    }
  }

  flushParagraph();
  return blocks;
}

/**
 * Split raw manuscript text into chapters and compute rich manuscript statistics.
 *
 * @param {string} rawText
 * @param {string} [fallbackTitle='Chapter 1']
 */
export function parseManuscript(rawText, fallbackTitle = 'Chapter 1') {
  const normalized = sanitizePrintText(rawText || '');
  const lines = normalized.split('\n');

  const rawChapters = [];
  let current = null;
  let preChapterLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = matchChapterHeading(line);
    if (heading) {
      if (current) {
        rawChapters.push(current);
      } else if (preChapterLines.some((l) => l.trim().length > 0)) {
        rawChapters.push({
          title: 'Prologue',
          explicitLabel: 'PROLOGUE',
          isFrontPrologue: true,
          lines: preChapterLines
        });
        preChapterLines = [];
      }
      current = {
        title: heading.title,
        explicitLabel: heading.explicitLabel,
        lines: []
      };
    } else if (current) {
      current.lines.push(line);
    } else {
      preChapterLines.push(line);
    }
  }

  if (current) {
    rawChapters.push(current);
  } else if (preChapterLines.some((l) => l.trim().length > 0)) {
    rawChapters.push({
      title: fallbackTitle,
      explicitLabel: 'CHAPTER 1',
      lines: preChapterLines
    });
  }

  const chapters = rawChapters.map((ch, idx) => {
    const bodyText = ch.lines.join('\n');
    const blocks = parseChapterBlocks(ch.lines);
    const words = countWords(bodyText);
    return {
      index: idx + 1,
      label: ch.explicitLabel || `CHAPTER ${idx + 1}`,
      title: ch.title || `Chapter ${idx + 1}`,
      blocks,
      wordCount: words
    };
  });

  const totalWords = countWords(normalized);
  const totalChars = normalized.length;
  const hasDevanagari = containsDevanagari(normalized);

  return {
    chapters,
    totalWords,
    totalChars,
    chapterCount: chapters.length,
    hasDevanagari,
    readingMinutes: Math.max(1, Math.round(totalWords / 225))
  };
}

/**
 * Fast synchronous page-count estimator for instant feedback while typing in
 * the Manuscript tab (before full OpenType pagination runs).
 */
export function estimatePageCount(parsedManuscript, layout = {}) {
  const interior = computeInteriorDimensions({
    trimSize: layout.trimSize || '6x9',
    bleed: Boolean(layout.bleed),
    pageCount: 120
  });
  const fontSizePt = Number(layout.fontSizePt) || 11;
  const leading = Number(layout.leading) || 1.42;
  const lineHeightPt = fontSizePt * leading;

  const linesPerPage = Math.max(12, Math.floor(interior.textHeightPt / lineHeightPt));
  const avgCharsPerLine = Math.max(28, Math.floor(interior.textWidthPt / (fontSizePt * 0.48)));
  const wordsPerPage = Math.max(110, (linesPerPage * avgCharsPerLine) / 5.8);

  // Title + Copyright + TOC (aligned so Chapter 1 starts on recto page 5)
  let currentPage = 4;
  for (const ch of parsedManuscript.chapters) {
    // Chapters always start on a right-hand (odd / recto) page
    if (currentPage % 2 !== 0) {
      currentPage += 1;
    }
    const chapterPages = Math.max(
      1,
      Math.ceil((ch.wordCount + wordsPerPage * 0.35) / wordsPerPage)
    );
    currentPage += chapterPages;
  }

  return padToEvenPageCount(currentPage);
}
