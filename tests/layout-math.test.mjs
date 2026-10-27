import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getGutterInches,
  padToEvenPageCount,
  computeInteriorDimensions,
  getInteriorPageFrame,
  computeSpineWidth,
  checkSpineTextEligibility,
  computeCoverDimensions,
  rectsOverlap,
  computePricing,
  inchesToPoints,
  inchesToPixels
} from '../js/layout-math.js';

test('Gutter table matches exact KDP boundaries across all 5 tiers', () => {
  // Below minimum (e.g., 12-page demo) defaults safely to lowest tier 0.375"
  assert.equal(getGutterInches(12), 0.375);

  // Tier 1: 24-150 -> 0.375"
  assert.equal(getGutterInches(24), 0.375);
  assert.equal(getGutterInches(100), 0.375);
  assert.equal(getGutterInches(150), 0.375);

  // Tier 2: 151-300 -> 0.5"
  assert.equal(getGutterInches(151), 0.5);
  assert.equal(getGutterInches(240), 0.5);
  assert.equal(getGutterInches(300), 0.5);

  // Tier 3: 301-500 -> 0.625"
  assert.equal(getGutterInches(301), 0.625);
  assert.equal(getGutterInches(420), 0.625);
  assert.equal(getGutterInches(500), 0.625);

  // Tier 4: 501-700 -> 0.75"
  assert.equal(getGutterInches(501), 0.75);
  assert.equal(getGutterInches(650), 0.75);
  assert.equal(getGutterInches(700), 0.75);

  // Tier 5: 701-828 -> 0.875"
  assert.equal(getGutterInches(701), 0.875);
  assert.equal(getGutterInches(828), 0.875);
  assert.equal(getGutterInches(900), 0.875);
});

test('padToEvenPageCount always produces an even positive integer', () => {
  assert.equal(padToEvenPageCount(0), 2);
  assert.equal(padToEvenPageCount(1), 2);
  assert.equal(padToEvenPageCount(11), 12);
  assert.equal(padToEvenPageCount(12), 12);
  assert.equal(padToEvenPageCount(23), 24);
  assert.equal(padToEvenPageCount(24), 24);
});

test('Interior dimensions support all 4 trim sizes with and without bleed', () => {
  const trims = [
    ['6x9', 6, 9],
    ['5.5x8.5', 5.5, 8.5],
    ['5.25x8', 5.25, 8],
    ['8.5x11', 8.5, 11]
  ];

  for (const [id, w, h] of trims) {
    const noBleed = computeInteriorDimensions({
      trimSize: id,
      bleed: false,
      pageCount: 160,
      useMinimumMarginsOnly: true
    });
    assert.equal(noBleed.pageWidthIn, w);
    assert.equal(noBleed.pageHeightIn, h);
    assert.equal(noBleed.minMarginsIn.outside, 0.25);
    assert.equal(noBleed.minMarginsIn.top, 0.25);
    assert.equal(noBleed.minMarginsIn.bottom, 0.25);
    assert.equal(noBleed.minMarginsIn.gutter, 0.5);

    // Bleed adds 0.125" on top, bottom, and outside edge ONLY
    const withBleed = computeInteriorDimensions({
      trimSize: id,
      bleed: true,
      pageCount: 160,
      useMinimumMarginsOnly: true
    });
    assert.equal(withBleed.pageWidthIn, w + 0.125);
    assert.equal(withBleed.pageHeightIn, h + 0.25);
    assert.equal(withBleed.minMarginsIn.outside, 0.375);
    assert.equal(withBleed.minMarginsIn.top, 0.375);
    assert.equal(withBleed.minMarginsIn.bottom, 0.375);
    assert.equal(withBleed.minMarginsIn.gutter, 0.5);
  }
});

test('Recto (odd) and Verso (even) page frames mirror gutter and outside margins', () => {
  const interior = computeInteriorDimensions({
    trimSize: '6x9',
    bleed: true,
    pageCount: 200
  });
  const oddFrame = getInteriorPageFrame(interior, 1);
  const evenFrame = getInteriorPageFrame(interior, 2);

  assert.equal(oddFrame.isRecto, true);
  assert.equal(evenFrame.isVerso, true);

  // Odd page: gutter on left, outside margin on right
  assert.equal(oddFrame.leftMarginIn, interior.marginsIn.gutter);
  assert.equal(oddFrame.rightMarginIn, interior.marginsIn.outside);

  // Even page: outside margin on left, gutter on right
  assert.equal(evenFrame.leftMarginIn, interior.marginsIn.outside);
  assert.equal(evenFrame.rightMarginIn, interior.marginsIn.gutter);

  // Text block width must be identical on odd and even pages
  const oddWidth = +(oddFrame.xRightIn - oddFrame.xLeftIn).toFixed(6);
  const evenWidth = +(evenFrame.xRightIn - evenFrame.xLeftIn).toFixed(6);
  assert.equal(oddWidth, interior.textWidthIn);
  assert.equal(evenWidth, interior.textWidthIn);
});

test('Spine width uses exact white (0.002252") and cream (0.0025") constants and supports overrides', () => {
  const white200 = computeSpineWidth({ pageCount: 200, paperType: 'white' });
  assert.equal(white200.spineWidthIn, 0.4504);

  const cream200 = computeSpineWidth({ pageCount: 200, paperType: 'cream' });
  assert.equal(cream200.spineWidthIn, 0.5);

  const custom = computeSpineWidth({
    pageCount: 100,
    paperType: 'white',
    spineWhitePaperIn: 0.0023
  });
  assert.equal(custom.spineWidthIn, 0.23);
});

test('Spine text eligibility enforces >= 79 pages AND sufficient playable width', () => {
  // 78 pages -> never allowed even on cream paper
  const p78 = checkSpineTextEligibility({ pageCount: 78, spineWidthIn: 78 * 0.0025 });
  assert.equal(p78.allowed, false);
  assert.equal(p78.hasEnoughPages, false);

  // 79 pages white paper -> 0.177908" minus 0.125" variance = 0.0529" (~3.5pt) -> too narrow
  const p79White = checkSpineTextEligibility({ pageCount: 79, spineWidthIn: 79 * 0.002252 });
  assert.equal(p79White.hasEnoughPages, true);
  assert.equal(p79White.isWideEnough, false);
  assert.equal(p79White.allowed, false);

  // 110 pages white paper -> 0.24772" minus 0.125" = 0.12272" (~8.1pt) -> allowed
  const p110White = checkSpineTextEligibility({ pageCount: 110, spineWidthIn: 110 * 0.002252 });
  assert.equal(p110White.allowed, true);
  assert.ok(p110White.recommendedFontPt >= 5.5);
});

test('Full cover dimensions, 300 DPI pixel specs, safe zones, and barcode box are exact', () => {
  // 6x9, 200 pages, cream paper -> spine = 0.5"
  // Full width = 0.125 + 6 + 0.5 + 6 + 0.125 = 12.75" (3825 px @ 300 DPI, 918 pt)
  // Full height = 9 + 0.25 = 9.25" (2775 px @ 300 DPI, 666 pt)
  const cover = computeCoverDimensions({
    trimSize: '6x9',
    pageCount: 200,
    paperType: 'cream'
  });

  assert.equal(cover.spineWidthIn, 0.5);
  assert.equal(cover.fullWidthIn, 12.75);
  assert.equal(cover.fullHeightIn, 9.25);
  assert.equal(cover.fullWidthPx, 3825);
  assert.equal(cover.fullHeightPx, 2775);
  assert.equal(cover.fullWidthPt, inchesToPoints(12.75));
  assert.equal(cover.fullHeightPt, inchesToPoints(9.25));
  assert.equal(inchesToPixels(cover.spineWidthIn, 300), 150);

  // Safe zones sit 0.25" inside trim edges
  assert.equal(cover.safeZonesIn.back.x, 0.375);
  assert.equal(cover.safeZonesIn.back.y, 0.375);
  assert.equal(cover.safeZonesIn.back.width, 5.5);
  assert.equal(cover.safeZonesIn.back.height, 8.5);

  assert.equal(cover.safeZonesIn.front.x, 6.875);
  assert.equal(cover.safeZonesIn.front.width, 5.5);

  // Barcode: 2.0" x 1.2" at bottom-right of back cover, 0.25" from back right hinge (6.125") & bottom trim (0.125")
  assert.equal(cover.barcodeZoneIn.width, 2.0);
  assert.equal(cover.barcodeZoneIn.height, 1.2);
  assert.equal(cover.barcodeZoneIn.right, 5.875);
  assert.equal(cover.barcodeZoneIn.x, 3.875);
  assert.equal(cover.barcodeZoneIn.y, 0.375);
  assert.equal(cover.barcodeZoneIn.top, 1.575);

  // Overlap detection
  assert.equal(rectsOverlap({ x: 0.5, y: 2.0, width: 5.0, height: 4.0 }, cover.barcodeZoneIn), false);
  assert.equal(rectsOverlap({ x: 4.0, y: 1.0, width: 1.5, height: 1.0 }, cover.barcodeZoneIn), true);
});

test('Pricing calculator computes printing cost, min list price, 60% royalty, and per-copy profit', () => {
  // 200 pages @ default 0.85 + 0.012/page = 0.85 + 2.40 = $3.25
  // Min list price @ 60% royalty = ceil(3.25 / 0.60) = $5.42
  // At $14.99 list: 60% = $8.994 ($8.99), per-copy profit = 8.994 - 3.25 = $5.74
  const p = computePricing({
    pageCount: 200,
    listPriceUsd: 14.99
  });
  assert.equal(p.printingCostUsd, 3.25);
  assert.equal(p.minListPriceUsd, 5.42);
  assert.equal(p.grossRoyaltyUsd, 8.99);
  assert.equal(p.perCopyProfitUsd, 5.74);
  assert.equal(p.isBelowMinPrice, false);

  // Below minimum price check
  const tooLow = computePricing({
    pageCount: 200,
    listPriceUsd: 5.00
  });
  assert.equal(tooLow.isBelowMinPrice, true);
  assert.ok(tooLow.perCopyProfitUsd < 0);

  // Editable constants support
  const custom = computePricing({
    pageCount: 100,
    listPriceUsd: 10.00,
    fixedCostUsd: 1.00,
    perPageCostUsd: 0.015,
    royaltyRate: 0.50
  });
  assert.equal(custom.printingCostUsd, 2.5);
  assert.equal(custom.minListPriceUsd, 5.0);
  assert.equal(custom.grossRoyaltyUsd, 5.0);
  assert.equal(custom.perCopyProfitUsd, 2.5);
});
