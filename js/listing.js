/**
 * KDP Studio — Amazon KDP Listing Builder, Keyword Validator & Metadata Sheet
 *
 * Implements:
 * - Hook-pattern picker for Amazon-style titles & subtitles
 * - 4000-character description generator preserving paragraph breaks & bullet lines
 * - Strict 7-slot keyword validator (<= 50 chars each, empty & duplicate detection)
 * - BISAC / KDP category presets
 * - Plain-English copyable metadata block for fast KDP Bookshelf entry
 */

import { LISTING_RULES } from './config.js';
import { computeCoverDimensions, computePricing } from './layout-math.js';
import { sanitizePrintText } from './pdf-loader.js';

export const HOOK_PATTERNS = [
  {
    id: 'outcome-without-pain',
    label: 'Outcome Without Friction',
    pattern: 'A Practical Guide to [Desired Result] Without [Common Frustration]',
    buildSubtitle: (title) =>
      `A Practical Field Guide to Mastering ${title || 'Your Craft'} Without Guesswork or Expensive Tools`
  },
  {
    id: 'step-blueprint',
    label: 'Structured Blueprint',
    pattern: 'The Complete Step-by-Step System for [Target Reader]',
    buildSubtitle: () =>
      'The Step-by-Step Print Production Blueprint for Independent Authors and Small Presses'
  },
  {
    id: 'quiet-mastery',
    label: 'Authoritative Monograph',
    pattern: 'Principles, Proportions, and Field Notes on [Core Subject]',
    buildSubtitle: () =>
      'Principles, Page Proportions, and Practical Field Notes for Modern Bookmakers'
  },
  {
    id: 'compact-handbook',
    label: 'Pocket Handbook',
    pattern: 'Essential Rules, Checklists, and Real-World Numbers for [Topic]',
    buildSubtitle: () =>
      'Essential Typography Rules, Trim Calculations, and Preflight Checklists for Print Books'
  },
  {
    id: 'literary-fiction',
    label: 'Literary / Narrative',
    pattern: 'A Novel of [Setting, Tension, and Quiet Transformation]',
    buildSubtitle: () => 'A Novel of Memory, Craft, and Unfinished Letters'
  }
];

export const KDP_CATEGORIES = [
  'Books > Reference > Writing, Research & Publishing Guides > Publishing & Books',
  'Books > Arts & Photography > Graphic Design > Typography',
  'Books > Business & Money > Small Business & Entrepreneurship',
  'Books > Self-Help > Creativity',
  'Books > Literature & Fiction > Literary',
  'Books > Literature & Fiction > World Literature > Indian',
  'Books > Computers & Technology > Digital Audio, Video & Photography',
  'Books > Education & Teaching > Studying & Workbooks'
];

/**
 * Validate the 7 Amazon KDP search keyword slots (each <= 50 chars, non-empty, unique).
 * @param {string[]} rawSlots
 */
export function validateKeywords(rawSlots = []) {
  const slots = Array.from({ length: LISTING_RULES.keywordCount }, (_, idx) =>
    sanitizePrintText(rawSlots[idx] || '').trim()
  );

  const normalizedMap = new Map();
  slots.forEach((val, idx) => {
    const norm = val.toLowerCase().replace(/\s+/g, ' ');
    if (!norm) return;
    if (!normalizedMap.has(norm)) normalizedMap.set(norm, []);
    normalizedMap.get(norm).push(idx);
  });

  const slotStatuses = slots.map((value, index) => {
    const length = value.length;
    const norm = value.toLowerCase().replace(/\s+/g, ' ');
    const isEmpty = length === 0;
    const isTooLong = length > LISTING_RULES.maxKeywordChars;
    const duplicateIndices = norm ? normalizedMap.get(norm) || [] : [];
    const isDuplicate = duplicateIndices.length > 1;

    return {
      index,
      value,
      length,
      remaining: LISTING_RULES.maxKeywordChars - length,
      isEmpty,
      isTooLong,
      isDuplicate,
      duplicateWith: duplicateIndices.filter((i) => i !== index).map((i) => i + 1)
    };
  });

  const emptyCount = slotStatuses.filter((s) => s.isEmpty).length;
  const duplicateCount = slotStatuses.filter((s) => s.isDuplicate).length;
  const overLengthCount = slotStatuses.filter((s) => s.isTooLong).length;

  const warnings = [];
  if (emptyCount > 0) {
    warnings.push(
      `${emptyCount} keyword slot${emptyCount === 1 ? ' is' : 's are'} empty — fill all 7 slots to maximize Amazon search indexing.`
    );
  }
  if (duplicateCount > 0) {
    warnings.push(
      `Duplicate keyword phrase detected across ${duplicateCount} slots — replace duplicates with distinct reader search phrases.`
    );
  }
  if (overLengthCount > 0) {
    warnings.push(
      `${overLengthCount} keyword slot${overLengthCount === 1 ? ' exceeds' : 's exceed'} the 50-character KDP limit.`
    );
  }

  return {
    slots: slotStatuses,
    isValid: emptyCount === 0 && duplicateCount === 0 && overLengthCount === 0,
    emptyCount,
    duplicateCount,
    overLengthCount,
    warnings
  };
}

/**
 * Generate a clean, structured <= 4000-character Amazon KDP book description
 * preserving paragraph breaks and concise bullet lines (zero emoji).
 */
export function generateBookDescription({
  title = '',
  subtitle = '',
  author = '',
  chapters = [],
  trimLabel = '6" x 9"',
  audienceHook = ''
}) {
  const cleanTitle = sanitizePrintText(title).trim() || 'This Essential Guide';
  const cleanSub = sanitizePrintText(subtitle).trim();
  const cleanAuthor = sanitizePrintText(author).trim() || 'the author';

  const opener = cleanSub
    ? `${cleanTitle}: ${cleanSub}`
    : `${cleanTitle} — A Thoughtfully Crafted Edition by ${cleanAuthor}`;

  const intro =
    sanitizePrintText(audienceHook).trim() ||
    `Designed for readers who value clarity, precision, and enduring craft, ${cleanTitle} delivers a direct, distraction-free path from initial idea to finished work.`;

  const chapterBullets = chapters
    .slice(0, 6)
    .map((ch) => `- ${sanitizePrintText(ch.title).trim()}`);

  const defaultBullets = [
    '- Clear, field-tested principles explained in plain, memorable language',
    '- Step-by-step frameworks you can apply immediately without specialized software',
    '- Exact checklists and reference tables designed for everyday use'
  ];

  const bulletsBlock = (chapterBullets.length >= 2 ? chapterBullets : defaultBullets).join('\n');

  const closing = [
    `Inside this ${trimLabel} print edition, every chapter is structured so you can read cover to cover or open directly to the exact section you need.`,
    `Whether you are starting from a blank page or refining your final proof, ${cleanTitle} gives you a calm, dependable companion built to stay on your desk.`
  ].join('\n\n');

  const assembled = [
    opener,
    '',
    intro,
    '',
    'Inside this book, you will explore:',
    bulletsBlock,
    '',
    closing
  ].join('\n');

  return assembled.slice(0, LISTING_RULES.maxDescriptionChars);
}

/**
 * Convert plain-text description (with paragraphs and "- " bullets) into
 * KDP-supported HTML subset (<p>, <b>, <ul>, <li>) for optional KDP paste.
 */
export function formatDescriptionAsKdpHtml(plainDescription) {
  const clean = sanitizePrintText(plainDescription || '').trim();
  if (!clean) return '';

  const escapeHtml = (s) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const lines = clean.split('\n');
  const htmlParts = [];
  let paraBuf = [];
  let listBuf = [];

  const flushPara = (bold = false) => {
    if (!paraBuf.length) return;
    const body = escapeHtml(paraBuf.join(' '));
    htmlParts.push(bold ? `<p><b>${body}</b></p>` : `<p>${body}</p>`);
    paraBuf = [];
  };

  const flushList = () => {
    if (!listBuf.length) return;
    const items = listBuf.map((item) => `  <li>${escapeHtml(item)}</li>`).join('\n');
    htmlParts.push(`<ul>\n${items}\n</ul>`);
    listBuf = [];
  };

  let isFirstParagraph = true;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) {
      flushPara(isFirstParagraph && htmlParts.length === 0);
      if (htmlParts.length > 0) isFirstParagraph = false;
      flushList();
      continue;
    }
    if (/^[-*]\s+/.test(trimmed)) {
      flushPara(isFirstParagraph && htmlParts.length === 0);
      isFirstParagraph = false;
      listBuf.push(trimmed.replace(/^[-*]\s+/, '').trim());
    } else {
      flushList();
      paraBuf.push(trimmed);
    }
  }
  flushPara(isFirstParagraph && htmlParts.length === 0);
  flushList();

  return htmlParts.join('\n').slice(0, LISTING_RULES.maxDescriptionChars);
}

/**
 * Suggest 7 distinct <= 50-char search keyword phrases from manuscript vocabulary & title.
 */
export function suggestKeywordsFromProject({ title = '', subtitle = '', chapters = [] }) {
  const stopWords = new Set([
    'the', 'and', 'for', 'with', 'from', 'that', 'this', 'your', 'into', 'without',
    'chapter', 'book', 'guide', 'how', 'what', 'when', 'where', 'over', 'under'
  ]);
  const source = [title, subtitle, ...chapters.map((c) => c.title)]
    .join(' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ');

  const words = Array.from(
    new Set(
      source
        .split(/\s+/)
        .filter((w) => w.length >= 4 && !stopWords.has(w))
    )
  );

  const candidates = [
    words.slice(0, 3).join(' ') || 'independent book publishing guide',
    words.slice(1, 4).join(' ') || 'self publishing paperback layout',
    `${words[0] || 'print'} handbook for beginners`,
    `${words[1] || 'book'} typography and page design`,
    'amazon kdp print book production',
    'step by step publishing workflow',
    'author reference checklist workbook'
  ];

  const unique = [];
  const seen = new Set();
  for (const c of candidates) {
    const trimmed = c.replace(/\s+/g, ' ').trim().slice(0, 50);
    const key = trimmed.toLowerCase();
    if (trimmed && !seen.has(key)) {
      seen.add(key);
      unique.push(trimmed);
    }
  }
  while (unique.length < 7) {
    unique.push(`independent publishing topic ${unique.length + 1}`);
  }
  return unique.slice(0, 7);
}

/**
 * Build the plain-English KDP Metadata Block ready to copy into clipboard / notes.
 */
export function buildPlainEnglishMetadataBlock({
  bookMeta = {},
  layout = {},
  listing = {},
  pageCount = 12,
  spineConstants = {}
}) {
  const coverSpec = computeCoverDimensions({
    trimSize: layout.trimSize || '6x9',
    pageCount,
    paperType: layout.paperType || 'white',
    spineWhitePaperIn: spineConstants.spineWhitePaperIn,
    spineCreamPaperIn: spineConstants.spineCreamPaperIn
  });

  const pricing = computePricing({
    pageCount,
    listPriceUsd: listing.listPriceUsd,
    fixedCostUsd: listing.fixedCostUsd,
    perPageCostUsd: listing.perPageCostUsd,
    royaltyRate: listing.royaltyRate
  });

  const kwValidation = validateKeywords(listing.keywords || []);
  const categories = (listing.categories || []).filter(Boolean);

  return [
    '============================================================',
    'AMAZON KDP PAPERBACK METADATA & PRODUCTION SHEET',
    '============================================================',
    '',
    '1. BOOK DETAILS',
    `Title:              ${bookMeta.title || 'Untitled Book'}`,
    `Subtitle:           ${bookMeta.subtitle || '(None)'}`,
    `Author / Imprint:   ${bookMeta.author || 'Independent Author'}`,
    `Title + Subtitle:   ${((bookMeta.title || '').length + (bookMeta.subtitle || '').length)} / ${LISTING_RULES.maxTitlePlusSubtitleChars} characters`,
    '',
    '2. PRINT SPECIFICATIONS',
    `Trim Size:          ${coverSpec.trim.label} (${coverSpec.trim.name})`,
    `Ink & Paper:        Black ink on ${layout.paperType === 'cream' ? 'Cream' : 'White'} paper`,
    `Interior Bleed:     ${layout.bleed ? 'Bleed (PDF includes +0.125" outside, +0.25" height)' : 'No Bleed (exact trim dimensions)'}`,
    `Final Page Count:   ${pageCount} pages (even)`,
    `Spine Width:        ${coverSpec.spineWidthIn.toFixed(4)}" (${coverSpec.spineWidthPx} px @ 300 DPI)`,
    `Full Wrap Cover:    ${coverSpec.fullWidthIn.toFixed(4)}" x ${coverSpec.fullHeightIn.toFixed(4)}" (${coverSpec.fullWidthPx} x ${coverSpec.fullHeightPx} px @ 300 DPI)`,
    '',
    '3. CATEGORIES (Up to 3 on KDP)',
    ...(categories.length
      ? categories.map((cat, idx) => `Category ${idx + 1}:         ${cat}`)
      : ['Category 1:         (Not selected)']),
    '',
    '4. AMAZON SEARCH KEYWORDS (7 Slots, max 50 chars each)',
    ...kwValidation.slots.map(
      (s) => `Keyword ${s.index + 1} (${String(s.length).padStart(2, '0')}/50):  ${s.value || '(Empty)'}`
    ),
    '',
    '5. PRICING & ROYALTY SUMMARY (USD)',
    `List Price:         $${pricing.listPriceUsd.toFixed(2)}`,
    `KDP Print Cost:     $${pricing.printingCostUsd.toFixed(2)} ($${pricing.fixedCostUsd.toFixed(2)} fixed + $${pricing.perPageCostUsd.toFixed(3)} x ${pageCount} pages)`,
    `Minimum List Price: $${pricing.minListPriceUsd.toFixed(2)}`,
    `Royalty Rate:       ${Math.round(pricing.royaltyRate * 100)}% ($${pricing.grossRoyaltyUsd.toFixed(2)} gross share)`,
    `Estimated Profit:   $${pricing.perCopyProfitUsd.toFixed(2)} per copy sold`,
    '',
    '6. BOOK DESCRIPTION (' + (listing.description || '').length + ' / 4000 characters)',
    '------------------------------------------------------------',
    (listing.description || '').trim() || '(No description entered)',
    '============================================================'
  ].join('\n');
}
