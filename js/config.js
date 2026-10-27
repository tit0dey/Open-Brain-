/**
 * KDP Studio — Editable Amazon KDP Specification Constants
 *
 * Every geometric, typographic, cover, listing, and royalty rule used across
 * the application lives in this single configuration module so constants stay
 * transparent, auditable, and easy to adjust.
 */

export const POINTS_PER_INCH = 72;
export const COVER_PRINT_DPI = 300;

export const TRIM_SIZES = {
  '6x9': {
    id: '6x9',
    label: '6" x 9"',
    name: 'US Trade',
    widthIn: 6.0,
    heightIn: 9.0,
    description: 'Standard US trade paperback for non-fiction, memoir, and novels'
  },
  '5.5x8.5': {
    id: '5.5x8.5',
    label: '5.5" x 8.5"',
    name: 'Digest',
    widthIn: 5.5,
    heightIn: 8.5,
    description: 'Compact digest format for essays, guides, and literary fiction'
  },
  '5.25x8': {
    id: '5.25x8',
    label: '5.25" x 8"',
    name: 'Compact Novel',
    widthIn: 5.25,
    heightIn: 8.0,
    description: 'Classic portable trim favored for genre and literary fiction'
  },
  '8.5x11': {
    id: '8.5x11',
    label: '8.5" x 11"',
    name: 'Letter Workbook',
    widthIn: 8.5,
    heightIn: 11.0,
    description: 'Full letter format for technical manuals, textbooks, and workbooks'
  }
};

export const PAPER_TYPES = {
  white: {
    id: 'white',
    label: 'Black Ink / White Paper',
    spinePerPageIn: 0.002252,
    previewHex: '#FFFFFF',
    previewInkHex: '#181A1F'
  },
  cream: {
    id: 'cream',
    label: 'Black Ink / Cream Paper',
    spinePerPageIn: 0.0025,
    previewHex: '#F8F2E4',
    previewInkHex: '#1D1A16'
  }
};

export const INTERIOR_RULES = {
  // Bleed adds 0.125" on top, bottom, and outside edge ONLY (never on gutter/inside edge)
  bleedIn: 0.125,

  // KDP legal minimum margins measured from final PDF page edge
  minMarginNoBleedIn: 0.25,
  minOutsideMarginWithBleedIn: 0.375,
  minVerticalMarginWithBleedIn: 0.375,

  // KDP paperback page count bounds (black ink)
  minPageCount: 24,
  maxPageCount: 828,

  // KDP inside (gutter) minimum margin table by final even page count
  gutterTiers: [
    { minPages: 24, maxPages: 150, gutterIn: 0.375 },
    { minPages: 151, maxPages: 300, gutterIn: 0.5 },
    { minPages: 301, maxPages: 500, gutterIn: 0.625 },
    { minPages: 501, maxPages: 700, gutterIn: 0.75 },
    { minPages: 701, maxPages: 828, gutterIn: 0.875 }
  ],

  // Comfortable typographic breathing room added inside safe boundaries
  defaultBodyOutsideTrimMarginIn: 0.6,
  defaultBodyTopTrimMarginIn: 0.72,
  defaultBodyBottomTrimMarginIn: 0.72,
  defaultExtraGutterIn: 0.125,

  // Running header / folio placement offsets inside trim (always clamped >= legal minimum)
  runningHeaderTrimOffsetIn: 0.38,
  folioTrimOffsetIn: 0.38,

  // Keep at least 2 body lines beneath any chapter or section heading
  minLinesAfterHeading: 2
};

export const COVER_RULES = {
  bleedIn: 0.125,
  safeMarginFromTrimIn: 0.25,

  // Editable spine thickness multipliers (inches per page)
  spineWhitePaperIn: 0.002252,
  spineCreamPaperIn: 0.0025,

  // KDP spine text eligibility rules
  minSpineTextPages: 79,
  spineSafeVarianceEachSideIn: 0.0625, // 1/16" fold variance on each side of spine text
  minSpineFontPt: 5.5, // Minimum legible print point size inside playable spine width
  maxSpineFontPt: 18,

  // Mandatory KDP barcode clear zone at bottom-right of back cover
  barcodeWidthIn: 2.0,
  barcodeHeightIn: 1.2,
  barcodeMinMarginFromTrimIn: 0.25
};

export const PRICING_DEFAULTS = {
  fixedCostUsd: 0.85,
  perPageCostUsd: 0.012,
  royaltyRate: 0.60,
  defaultListPriceUsd: 14.99,
  maxListPriceUsd: 250.0
};

export const LISTING_RULES = {
  maxTitlePlusSubtitleChars: 200,
  maxTitleChars: 120,
  maxSubtitleChars: 120,
  maxDescriptionChars: 4000,
  keywordCount: 7,
  maxKeywordChars: 50,
  maxCategories: 3
};

export const FONT_CATALOG = {
  'eb-garamond': {
    id: 'eb-garamond',
    label: 'EB Garamond (Literary Serif)',
    category: 'serif',
    cssFamily: '"EB Garamond", Georgia, serif',
    files: {
      regular: './fonts/eb-garamond-400.woff',
      italic: './fonts/eb-garamond-400i.woff',
      bold: './fonts/eb-garamond-700.woff'
    }
  },
  inter: {
    id: 'inter',
    label: 'Inter (Modern Sans)',
    category: 'sans',
    cssFamily: '"Inter", system-ui, sans-serif',
    files: {
      regular: './fonts/inter-400.woff',
      italic: './fonts/inter-400i.woff',
      bold: './fonts/inter-700.woff'
    }
  },
  'noto-devanagari': {
    id: 'noto-devanagari',
    label: 'Noto Sans Devanagari (Hindi + Latin)',
    category: 'devanagari',
    cssFamily: '"Noto Sans Devanagari", "Inter", system-ui, sans-serif',
    files: {
      regular: './fonts/noto-sans-devanagari-400.woff',
      italic: './fonts/noto-sans-devanagari-400.woff',
      bold: './fonts/noto-sans-devanagari-700.woff'
    }
  }
};

export const KDP_CONFIG = {
  pointsPerInch: POINTS_PER_INCH,
  coverPrintDpi: COVER_PRINT_DPI,
  trimSizes: TRIM_SIZES,
  paperTypes: PAPER_TYPES,
  interior: INTERIOR_RULES,
  cover: COVER_RULES,
  pricing: PRICING_DEFAULTS,
  listing: LISTING_RULES,
  fonts: FONT_CATALOG
};
