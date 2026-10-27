/**
 * KDP Studio — Pure Layout, Cover, Barcode, and Royalty Mathematics
 *
 * Implements Amazon KDP print-production specifications with zero DOM
 * dependencies so the exact same module powers browser layout, canvas
 * previews, PDF generation, preflight inspection, and automated unit tests.
 */

import { KDP_CONFIG, POINTS_PER_INCH, COVER_PRINT_DPI } from './config.js';

/**
 * Round floating-point values cleanly to avoid IEEE-754 drift (e.g. 0.37500000000000006).
 * @param {number} value
 * @param {number} [decimals=6]
 * @returns {number}
 */
export function roundTo(value, decimals = 6) {
  const factor = 10 ** decimals;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

export function inchesToPoints(inches, ptsPerInch = POINTS_PER_INCH) {
  return roundTo(inches * ptsPerInch, 4);
}

export function pointsToInches(points, ptsPerInch = POINTS_PER_INCH) {
  return roundTo(points / ptsPerInch, 6);
}

export function inchesToPixels(inches, dpi = COVER_PRINT_DPI) {
  return Math.round(inches * dpi);
}

/**
 * KDP requires final interior page counts to be even; pads odd counts by 1 blank page.
 * @param {number} pageCount
 * @returns {number}
 */
export function padToEvenPageCount(pageCount) {
  const n = Math.max(0, Math.ceil(Number(pageCount) || 0));
  if (n === 0) return 2;
  return n % 2 === 0 ? n : n + 1;
}

/**
 * Resolve a trim size preset ID or custom { widthIn, heightIn } descriptor.
 * @param {string | { widthIn: number, heightIn: number, id?: string, label?: string }} trim
 * @param {object} [config=KDP_CONFIG]
 */
export function resolveTrimSize(trim, config = KDP_CONFIG) {
  if (typeof trim === 'string') {
    const found = config.trimSizes[trim];
    if (!found) {
      throw new Error(`Unknown trim size "${trim}"`);
    }
    return { ...found };
  }
  if (trim && typeof trim === 'object' && Number(trim.widthIn) > 0 && Number(trim.heightIn) > 0) {
    return {
      id: trim.id || `${trim.widthIn}x${trim.heightIn}`,
      label: trim.label || `${trim.widthIn}" x ${trim.heightIn}"`,
      widthIn: Number(trim.widthIn),
      heightIn: Number(trim.heightIn)
    };
  }
  return { ...config.trimSizes['6x9'] };
}

/**
 * Compute KDP minimum inside (gutter) margin in inches by final page count:
 *   24-150  -> 0.375"
 *   151-300 -> 0.5"
 *   301-500 -> 0.625"
 *   501-700 -> 0.75"
 *   701-828 -> 0.875"
 *
 * Counts below 24 use the smallest tier (0.375") and flag belowMinPages in status;
 * counts above 828 clamp to the largest tier (0.875") and flag aboveMaxPages.
 *
 * @param {number} pageCount
 * @param {object} [interiorRules=KDP_CONFIG.interior]
 * @returns {number}
 */
export function getGutterInches(pageCount, interiorRules = KDP_CONFIG.interior) {
  const count = Math.max(1, Math.ceil(Number(pageCount) || 0));
  const tiers = interiorRules.gutterTiers;
  if (count < tiers[0].minPages) {
    return tiers[0].gutterIn;
  }
  for (const tier of tiers) {
    if (count >= tier.minPages && count <= tier.maxPages) {
      return tier.gutterIn;
    }
  }
  return tiers[tiers.length - 1].gutterIn;
}

/**
 * Compute full KDP interior page dimensions, legal minimum margins, effective
 * book margins, and mirrored recto/verso text-block frames.
 *
 * With bleed: +0.125" on top, bottom, and outside edge ONLY (width + 0.125", height + 0.25");
 *             minimum outside/top/bottom margin from page edge is 0.375".
 * Without bleed: exact trim width x height; minimum outside/top/bottom margin is 0.25".
 *
 * @param {object} options
 * @param {string | object} [options.trimSize='6x9']
 * @param {boolean} [options.bleed=false]
 * @param {number} [options.pageCount=120]
 * @param {boolean} [options.useMinimumMarginsOnly=false]
 * @param {object} [config=KDP_CONFIG]
 */
export function computeInteriorDimensions(options = {}, config = KDP_CONFIG) {
  const rules = config.interior;
  const pts = config.pointsPerInch;
  const trim = resolveTrimSize(options.trimSize || '6x9', config);
  const bleed = Boolean(options.bleed);
  const bleedIn = bleed ? rules.bleedIn : 0;
  const evenPageCount = padToEvenPageCount(options.pageCount ?? 24);

  // Bleed applies to top, bottom, and outside edge ONLY — never the gutter edge
  const pageWidthIn = roundTo(trim.widthIn + bleedIn, 6);
  const pageHeightIn = roundTo(trim.heightIn + bleedIn * 2, 6);

  // Legal KDP minimum margins measured from the PDF page edge
  const minGutterIn = getGutterInches(evenPageCount, rules);
  const minOutsideIn = bleed ? rules.minOutsideMarginWithBleedIn : rules.minMarginNoBleedIn;
  const minTopIn = bleed ? rules.minVerticalMarginWithBleedIn : rules.minMarginNoBleedIn;
  const minBottomIn = bleed ? rules.minVerticalMarginWithBleedIn : rules.minMarginNoBleedIn;

  // Comfortable typographic margins (measured from final PDF edge, strictly >= KDP minimums)
  const useMinOnly = Boolean(options.useMinimumMarginsOnly);
  const gutterIn = useMinOnly
    ? minGutterIn
    : roundTo(Math.max(minGutterIn, minGutterIn + (rules.defaultExtraGutterIn || 0)), 6);
  const outsideIn = useMinOnly
    ? minOutsideIn
    : roundTo(Math.max(minOutsideIn, rules.defaultBodyOutsideTrimMarginIn + bleedIn), 6);
  const topIn = useMinOnly
    ? minTopIn
    : roundTo(Math.max(minTopIn, rules.defaultBodyTopTrimMarginIn + bleedIn), 6);
  const bottomIn = useMinOnly
    ? minBottomIn
    : roundTo(Math.max(minBottomIn, rules.defaultBodyBottomTrimMarginIn + bleedIn), 6);

  // Running header & folio baselines (kept safely inside KDP minimum edge margin)
  const headerFromTopEdgeIn = roundTo(
    Math.max(minTopIn + 0.08, (rules.runningHeaderTrimOffsetIn || 0.38) + bleedIn),
    6
  );
  const folioFromBottomEdgeIn = roundTo(
    Math.max(minBottomIn + 0.06, (rules.folioTrimOffsetIn || 0.38) + bleedIn),
    6
  );

  const textWidthIn = roundTo(pageWidthIn - gutterIn - outsideIn, 6);
  const textHeightIn = roundTo(pageHeightIn - topIn - bottomIn, 6);

  return {
    trim,
    bleed,
    bleedIn,
    pageCount: evenPageCount,
    belowMinPageCount: evenPageCount < rules.minPageCount,
    aboveMaxPageCount: evenPageCount > rules.maxPageCount,
    pageWidthIn,
    pageHeightIn,
    pageWidthPt: inchesToPoints(pageWidthIn, pts),
    pageHeightPt: inchesToPoints(pageHeightIn, pts),
    minMarginsIn: {
      gutter: minGutterIn,
      outside: minOutsideIn,
      top: minTopIn,
      bottom: minBottomIn
    },
    marginsIn: {
      gutter: gutterIn,
      outside: outsideIn,
      top: topIn,
      bottom: bottomIn
    },
    headerFromTopEdgeIn,
    folioFromBottomEdgeIn,
    textWidthIn,
    textHeightIn,
    textWidthPt: inchesToPoints(textWidthIn, pts),
    textHeightPt: inchesToPoints(textHeightIn, pts)
  };
}

/**
 * Return exact PDF-coordinate (origin bottom-left) frame for a 1-based page number.
 * Odd pages (1, 3, 5...) are right-hand recto pages (gutter on LEFT, outside on RIGHT).
 * Even pages (2, 4, 6...) are left-hand verso pages (outside on LEFT, gutter on RIGHT).
 *
 * @param {ReturnType<typeof computeInteriorDimensions>} interior
 * @param {number} pageNumber 1-based page number
 * @param {number} [ptsPerInch=POINTS_PER_INCH]
 */
export function getInteriorPageFrame(interior, pageNumber, ptsPerInch = POINTS_PER_INCH) {
  const isRecto = pageNumber % 2 === 1;
  const leftMarginIn = isRecto ? interior.marginsIn.gutter : interior.marginsIn.outside;
  const rightMarginIn = isRecto ? interior.marginsIn.outside : interior.marginsIn.gutter;

  const xLeftIn = leftMarginIn;
  const xRightIn = roundTo(interior.pageWidthIn - rightMarginIn, 6);
  const yBottomIn = interior.marginsIn.bottom;
  const yTopIn = roundTo(interior.pageHeightIn - interior.marginsIn.top, 6);

  // Trim rectangle inside the bleed page (useful for canvas guides)
  const trimLeftIn = isRecto ? 0 : interior.bleedIn;
  const trimBottomIn = interior.bleedIn;

  return {
    pageNumber,
    isRecto,
    isVerso: !isRecto,
    leftMarginIn,
    rightMarginIn,
    xLeftIn,
    xRightIn,
    yBottomIn,
    yTopIn,
    xLeftPt: inchesToPoints(xLeftIn, ptsPerInch),
    xRightPt: inchesToPoints(xRightIn, ptsPerInch),
    yBottomPt: inchesToPoints(yBottomIn, ptsPerInch),
    yTopPt: inchesToPoints(yTopIn, ptsPerInch),
    headerYPt: inchesToPoints(interior.pageHeightIn - interior.headerFromTopEdgeIn, ptsPerInch),
    folioYPt: inchesToPoints(interior.folioFromBottomEdgeIn, ptsPerInch),
    trimBoxIn: {
      x: trimLeftIn,
      y: trimBottomIn,
      width: interior.trim.widthIn,
      height: interior.trim.heightIn
    }
  };
}

/**
 * Compute KDP spine thickness in inches:
 *   Black ink white paper = pages * 0.002252"
 *   Black ink cream paper = pages * 0.0025"
 *
 * @param {object} options
 * @param {number} options.pageCount
 * @param {'white' | 'cream'} [options.paperType='white']
 * @param {number} [options.spineWhitePaperIn]
 * @param {number} [options.spineCreamPaperIn]
 * @param {object} [config=KDP_CONFIG]
 */
export function computeSpineWidth(options = {}, config = KDP_CONFIG) {
  const coverRules = config.cover;
  const pages = Math.max(0, Number(options.pageCount) || 0);
  const paperType = options.paperType === 'cream' ? 'cream' : 'white';
  const perPageIn =
    paperType === 'cream'
      ? Number(options.spineCreamPaperIn ?? coverRules.spineCreamPaperIn)
      : Number(options.spineWhitePaperIn ?? coverRules.spineWhitePaperIn);

  const spineWidthIn = roundTo(pages * perPageIn, 6);
  return {
    paperType,
    perPageIn,
    pageCount: pages,
    spineWidthIn,
    spineWidthPt: inchesToPoints(spineWidthIn, config.pointsPerInch),
    spineWidthPx: inchesToPixels(spineWidthIn, config.coverPrintDpi)
  };
}

/**
 * Determine whether spine text is permitted by KDP:
 *   1. Page count must be >= 79 pages
 *   2. Playable spine width (spineWidth - 2 * 0.0625" variance) must fit readable text
 *
 * @param {object} options
 * @param {number} options.pageCount
 * @param {number} options.spineWidthIn
 * @param {number} [options.requestedFontPt]
 * @param {object} [config=KDP_CONFIG]
 */
export function checkSpineTextEligibility(options = {}, config = KDP_CONFIG) {
  const coverRules = config.cover;
  const pts = config.pointsPerInch;
  const pageCount = Number(options.pageCount) || 0;
  const spineWidthIn = Number(options.spineWidthIn) || 0;

  const varianceTotalIn = coverRules.spineSafeVarianceEachSideIn * 2;
  const playableSpineIn = roundTo(Math.max(0, spineWidthIn - varianceTotalIn), 6);
  const maxFontPt = roundTo(
    Math.min(coverRules.maxSpineFontPt, playableSpineIn * pts * 0.92),
    2
  );

  const hasEnoughPages = pageCount >= coverRules.minSpineTextPages;
  const isWideEnough = maxFontPt >= coverRules.minSpineFontPt;
  const requestedPt = options.requestedFontPt ? Number(options.requestedFontPt) : null;
  const requestedFits = requestedPt === null ? true : requestedPt <= maxFontPt + 1e-6;

  const allowed = hasEnoughPages && isWideEnough && requestedFits;
  let reason = 'Spine text eligible';
  if (!hasEnoughPages) {
    reason = `Spine text requires at least ${coverRules.minSpineTextPages} pages (current: ${pageCount})`;
  } else if (!isWideEnough) {
    reason = `Spine (${spineWidthIn.toFixed(3)}") is too narrow after 0.0625" fold variance margins`;
  } else if (!requestedFits) {
    reason = `Requested spine font (${requestedPt}pt) exceeds safe spine height (${maxFontPt.toFixed(1)}pt max)`;
  }

  return {
    allowed,
    hasEnoughPages,
    isWideEnough,
    playableSpineIn,
    maxFontPt,
    recommendedFontPt: allowed ? roundTo(Math.min(11, Math.max(coverRules.minSpineFontPt, maxFontPt * 0.82)), 1) : 0,
    reason
  };
}

/**
 * Compute exact single-page wraparound KDP cover specification:
 *   Full cover width  = 0.125 + trimWidth + spineWidth + trimWidth + 0.125
 *   Full cover height = trimHeight + 0.25
 *
 * Includes Back Cover (left), Spine (center), Front Cover (right), 0.25" safe
 * zones inside trim edges, and the clear 2.0" x 1.2" barcode rectangle at the
 * bottom-right of the back cover (>= 0.25" from trim edge and spine fold).
 *
 * All PDF coordinates use bottom-left origin (0, 0).
 *
 * @param {object} options
 * @param {string | object} [options.trimSize='6x9']
 * @param {number} [options.pageCount=120]
 * @param {'white' | 'cream'} [options.paperType='white']
 * @param {number} [options.spineWhitePaperIn]
 * @param {number} [options.spineCreamPaperIn]
 * @param {number} [options.dpi=300]
 * @param {object} [config=KDP_CONFIG]
 */
export function computeCoverDimensions(options = {}, config = KDP_CONFIG) {
  const coverRules = config.cover;
  const pts = config.pointsPerInch;
  const dpi = Number(options.dpi || config.coverPrintDpi);
  const trim = resolveTrimSize(options.trimSize || '6x9', config);
  const bleedIn = coverRules.bleedIn;
  const safeIn = coverRules.safeMarginFromTrimIn;

  const spine = computeSpineWidth(
    {
      pageCount: options.pageCount,
      paperType: options.paperType,
      spineWhitePaperIn: options.spineWhitePaperIn,
      spineCreamPaperIn: options.spineCreamPaperIn
    },
    config
  );
  const spineWidthIn = spine.spineWidthIn;

  // Exact KDP wraparound formulas
  const fullWidthIn = roundTo(bleedIn + trim.widthIn + spineWidthIn + trim.widthIn + bleedIn, 6);
  const fullHeightIn = roundTo(trim.heightIn + bleedIn * 2, 6);

  // Horizontal panel boundaries (from left edge of full cover PDF)
  const backTrimLeftIn = bleedIn;
  const backTrimRightIn = roundTo(bleedIn + trim.widthIn, 6);
  const spineLeftIn = backTrimRightIn;
  const spineRightIn = roundTo(spineLeftIn + spineWidthIn, 6);
  const frontTrimLeftIn = spineRightIn;
  const frontTrimRightIn = roundTo(frontTrimLeftIn + trim.widthIn, 6);

  // Vertical trim boundaries (from bottom edge of full cover PDF)
  const trimBottomIn = bleedIn;
  const trimTopIn = roundTo(bleedIn + trim.heightIn, 6);

  // Safe live-art & text zones (at least 0.25" inside trim edges and spine hinges)
  const backSafeIn = {
    x: roundTo(backTrimLeftIn + safeIn, 6),
    y: roundTo(trimBottomIn + safeIn, 6),
    width: roundTo(trim.widthIn - safeIn * 2, 6),
    height: roundTo(trim.heightIn - safeIn * 2, 6)
  };

  const frontSafeIn = {
    x: roundTo(frontTrimLeftIn + safeIn, 6),
    y: roundTo(trimBottomIn + safeIn, 6),
    width: roundTo(trim.widthIn - safeIn * 2, 6),
    height: roundTo(trim.heightIn - safeIn * 2, 6)
  };

  // Clear 2" x 1.2" barcode rectangle at bottom-right of back cover, >= 0.25" from trim/hinge
  const barcodeMarginIn = Math.max(safeIn, coverRules.barcodeMinMarginFromTrimIn);
  const barcodeRightIn = roundTo(backTrimRightIn - barcodeMarginIn, 6);
  const barcodeLeftIn = roundTo(barcodeRightIn - coverRules.barcodeWidthIn, 6);
  const barcodeBottomIn = roundTo(trimBottomIn + barcodeMarginIn, 6);
  const barcodeZoneIn = {
    x: barcodeLeftIn,
    y: barcodeBottomIn,
    width: coverRules.barcodeWidthIn,
    height: coverRules.barcodeHeightIn,
    right: barcodeRightIn,
    top: roundTo(barcodeBottomIn + coverRules.barcodeHeightIn, 6)
  };

  const toPtRect = (r) => ({
    x: inchesToPoints(r.x, pts),
    y: inchesToPoints(r.y, pts),
    width: inchesToPoints(r.width, pts),
    height: inchesToPoints(r.height, pts),
    right: inchesToPoints(r.x + r.width, pts),
    top: inchesToPoints(r.y + r.height, pts)
  });

  const spineEligibility = checkSpineTextEligibility(
    { pageCount: spine.pageCount, spineWidthIn },
    config
  );

  return {
    trim,
    paperType: spine.paperType,
    pageCount: spine.pageCount,
    bleedIn,
    safeMarginIn: safeIn,
    spineWidthIn,
    spineWidthPt: spine.spineWidthPt,
    spineWidthPx: inchesToPixels(spineWidthIn, dpi),
    fullWidthIn,
    fullHeightIn,
    fullWidthPt: inchesToPoints(fullWidthIn, pts),
    fullHeightPt: inchesToPoints(fullHeightIn, pts),
    fullWidthPx: inchesToPixels(fullWidthIn, dpi),
    fullHeightPx: inchesToPixels(fullHeightIn, dpi),
    dpi,
    panelsIn: {
      back: { x: backTrimLeftIn, y: trimBottomIn, width: trim.widthIn, height: trim.heightIn },
      spine: { x: spineLeftIn, y: trimBottomIn, width: spineWidthIn, height: trim.heightIn },
      front: { x: frontTrimLeftIn, y: trimBottomIn, width: trim.widthIn, height: trim.heightIn }
    },
    safeZonesIn: {
      back: backSafeIn,
      front: frontSafeIn
    },
    barcodeZoneIn,
    barcodeZonePt: toPtRect(barcodeZoneIn),
    panelsPt: {
      back: toPtRect({ x: backTrimLeftIn, y: trimBottomIn, width: trim.widthIn, height: trim.heightIn }),
      spine: toPtRect({ x: spineLeftIn, y: trimBottomIn, width: spineWidthIn, height: trim.heightIn }),
      front: toPtRect({ x: frontTrimLeftIn, y: trimBottomIn, width: trim.widthIn, height: trim.heightIn })
    },
    safeZonesPt: {
      back: toPtRect(backSafeIn),
      front: toPtRect(frontSafeIn)
    },
    spineEligibility
  };
}

/**
 * Test whether two axis-aligned rectangles { x, y, width, height } overlap strictly.
 * @param {{ x: number, y: number, width: number, height: number }} a
 * @param {{ x: number, y: number, width: number, height: number }} b
 * @param {number} [epsilon=0.01]
 * @returns {boolean}
 */
export function rectsOverlap(a, b, epsilon = 0.01) {
  if (!a || !b) return false;
  const aLeft = a.x + epsilon;
  const aRight = a.x + a.width - epsilon;
  const aBottom = a.y + epsilon;
  const aTop = a.y + a.height - epsilon;

  const bLeft = b.x;
  const bRight = b.x + b.width;
  const bBottom = b.y;
  const bTop = b.y + b.height;

  if (aRight <= bLeft || aLeft >= bRight) return false;
  if (aTop <= bBottom || aBottom >= bTop) return false;
  return true;
}

/**
 * Compute Amazon KDP print cost, minimum allowed list price, 60% royalty, and net profit.
 * Default black-ink 6x9 formula: 0.85 fixed + 0.012 * pageCount, 60% royalty rate.
 *
 * @param {object} options
 * @param {number} options.pageCount
 * @param {number} [options.listPriceUsd]
 * @param {number} [options.fixedCostUsd]
 * @param {number} [options.perPageCostUsd]
 * @param {number} [options.royaltyRate]
 * @param {object} [config=KDP_CONFIG]
 */
export function computePricing(options = {}, config = KDP_CONFIG) {
  const defaults = config.pricing;
  const pageCount = Math.max(0, Math.ceil(Number(options.pageCount) || 0));
  const fixedCostUsd = Number(options.fixedCostUsd ?? defaults.fixedCostUsd);
  const perPageCostUsd = Number(options.perPageCostUsd ?? defaults.perPageCostUsd);
  const royaltyRate = Number(options.royaltyRate ?? defaults.royaltyRate);
  const listPriceUsd = Number(options.listPriceUsd ?? defaults.defaultListPriceUsd);

  if (royaltyRate <= 0 || royaltyRate > 1) {
    throw new Error('Royalty rate must be between 0 (exclusive) and 1 (inclusive)');
  }

  const printingCostRaw = fixedCostUsd + pageCount * perPageCostUsd;
  const printingCostUsd = roundTo(printingCostRaw, 4);

  // Minimum list price where (listPrice * royaltyRate) - printingCost >= 0, rounded up to cent
  const minListPriceRaw = printingCostRaw / royaltyRate;
  const minListPriceUsd = Math.ceil(minListPriceRaw * 100 - 1e-9) / 100;

  const grossRoyaltyUsd = roundTo(listPriceUsd * royaltyRate, 4);
  const perCopyProfitUsd = roundTo(grossRoyaltyUsd - printingCostRaw, 2);
  const isBelowMinPrice = listPriceUsd + 1e-9 < minListPriceUsd;

  return {
    pageCount,
    fixedCostUsd: roundTo(fixedCostUsd, 4),
    perPageCostUsd: roundTo(perPageCostUsd, 4),
    royaltyRate: roundTo(royaltyRate, 4),
    listPriceUsd: roundTo(listPriceUsd, 2),
    printingCostUsd: roundTo(printingCostUsd, 2),
    printingCostExactUsd: printingCostUsd,
    minListPriceUsd: roundTo(minListPriceUsd, 2),
    grossRoyaltyUsd: roundTo(grossRoyaltyUsd, 2),
    perCopyProfitUsd,
    isBelowMinPrice,
    maxListPriceUsd: defaults.maxListPriceUsd,
    isAboveMaxPrice: listPriceUsd > defaults.maxListPriceUsd
  };
}
