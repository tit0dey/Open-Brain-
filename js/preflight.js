/**
 * KDP Studio — Real Binary PDF Preflight Inspector
 *
 * Parses actual generated Interior and Cover PDF byte arrays with pdf-lib,
 * inspecting MediaBox geometry, embedded font binary streams, page counts,
 * bleed dimensions, and decompressed PDF content-stream operators inside the
 * 2.0" x 1.2" back-cover barcode clear zone.
 */

import { KDP_CONFIG } from './config.js';
import {
  computeInteriorDimensions,
  computeCoverDimensions,
  pointsToInches,
  rectsOverlap
} from './layout-math.js';
import { loadPdfEngines } from './pdf-loader.js';

const TOLERANCE_IN = 0.004; // ~0.28 pt tolerance

function hasValidPdfEnvelope(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 64) return false;
  const head = new TextDecoder('ascii').decode(bytes.subarray(0, 12));
  const tail = new TextDecoder('ascii').decode(
    bytes.subarray(Math.max(0, bytes.byteLength - 64))
  );
  return head.startsWith('%PDF-') && tail.includes('%%EOF');
}

/**
 * Inspect indirect PDF objects for font dictionaries and embedded font streams.
 */
function inspectEmbeddedFonts(pdfDoc, PDFLib) {
  const descriptors = [];
  const unembeddedFonts = [];

  for (const [, obj] of pdfDoc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFLib.PDFDict)) continue;
    const typeObj = obj.get(PDFLib.PDFName.of('Type'));
    const typeStr = typeObj ? typeObj.toString() : '';

    if (typeStr === '/FontDescriptor') {
      const fontName = obj.get(PDFLib.PDFName.of('FontName'))?.toString() || '/UnknownFont';
      const streamRef =
        obj.get(PDFLib.PDFName.of('FontFile')) ||
        obj.get(PDFLib.PDFName.of('FontFile2')) ||
        obj.get(PDFLib.PDFName.of('FontFile3'));
      let streamSize = 0;
      if (streamRef) {
        const streamObj = pdfDoc.context.lookup(streamRef);
        if (streamObj && streamObj.contents) {
          streamSize = streamObj.contents.length;
        }
      }
      descriptors.push({
        name: fontName.replace(/^\//, ''),
        embedded: streamSize > 0,
        streamBytes: streamSize
      });
    } else if (typeStr === '/Font') {
      const subtype = obj.get(PDFLib.PDFName.of('Subtype'))?.toString() || '';
      // Standard unembedded Type1 fonts lack /FontDescriptor and are not /Type0 composite fonts
      if (subtype === '/Type1' || subtype === '/TrueType') {
        const desc = obj.get(PDFLib.PDFName.of('FontDescriptor'));
        if (!desc) {
          const base = obj.get(PDFLib.PDFName.of('BaseFont'))?.toString() || '/Unembedded';
          unembeddedFonts.push(base.replace(/^\//, ''));
        }
      }
    }
  }

  const allEmbedded =
    descriptors.length > 0 &&
    descriptors.every((d) => d.embedded) &&
    unembeddedFonts.length === 0;

  return {
    allEmbedded,
    descriptors,
    unembeddedFonts
  };
}

/**
 * Decompress and parse Cover PDF page content stream to verify no text (BT..ET)
 * or foreground XObject image (cm + Do) enters the 2.0" x 1.2" barcode box.
 */
function inspectCoverBarcodeClearZone(coverDoc, barcodeZonePt, PDFLib) {
  const page = coverDoc.getPage(0);
  const contentsEntry = page.node.Contents();
  if (!contentsEntry) {
    return { clear: true, violations: [], inspectedOperators: 0 };
  }

  const resolved = coverDoc.context.lookup(contentsEntry);
  const streams =
    resolved instanceof PDFLib.PDFArray
      ? Array.from({ length: resolved.size() }, (_, idx) =>
          coverDoc.context.lookup(resolved.get(idx))
        )
      : [resolved];

  let fullStreamText = '';
  for (const s of streams) {
    if (!s) continue;
    const rawBytes =
      typeof PDFLib.decodePDFRawStream === 'function'
        ? PDFLib.decodePDFRawStream(s).decode()
        : s.contents || new Uint8Array();
    fullStreamText += new TextDecoder('latin1').decode(rawBytes) + '\n';
  }

  const violations = [];
  let inspectedOperators = 0;

  // 1. Parse BT ... ET text blocks in content stream
  const btBlocks = fullStreamText.match(/BT[\s\S]*?ET/g) || [];
  for (const block of btBlocks) {
    inspectedOperators++;
    const tfMatch = block.match(/\/[^\s]+\s+([\d.+-]+)\s+Tf/);
    const fontSize = tfMatch ? parseFloat(tfMatch[1]) : 11;

    // Match 6-number text matrix: a b c d tx ty Tm
    const tmRegex =
      /([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+Tm/g;
    let m;
    while ((m = tmRegex.exec(block)) !== null) {
      const a = parseFloat(m[1]);
      const b = parseFloat(m[2]);
      const tx = parseFloat(m[5]);
      const ty = parseFloat(m[6]);
      const isRotated = Math.abs(b) > 0.1 && Math.abs(a) < 0.1;

      // Estimate glyph count from <hex> Tj on following lines
      const afterTm = block.slice(m.index + m[0].length);
      const hexTj = afterTm.match(/<([0-9A-Fa-f]+)>\s*Tj/);
      const glyphCount = hexTj ? Math.max(1, hexTj[1].length / 4) : 4;
      const runLengthPt = glyphCount * fontSize * 0.45;

      const textBoundsPt = isRotated
        ? {
            x: tx - fontSize * 0.5,
            y: ty - runLengthPt,
            width: fontSize * 1.2,
            height: runLengthPt
          }
        : {
            x: tx,
            y: ty - fontSize * 0.25,
            width: runLengthPt,
            height: fontSize * 1.15
          };

      if (rectsOverlap(textBoundsPt, barcodeZonePt, 0.5)) {
        violations.push({
          type: 'text-operator',
          xPt: +tx.toFixed(1),
          yPt: +ty.toFixed(1)
        });
      }
    }
  }

  // 2. Parse XObject image placements (q ... w 0 0 h tx ty cm /Im Do ... Q)
  const doRegex =
    /([\d.+-]+)\s+0\s+0\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+cm\s*\/([^\s]+)\s+Do/g;
  let dm;
  while ((dm = doRegex.exec(fullStreamText)) !== null) {
    inspectedOperators++;
    const imgRect = {
      x: parseFloat(dm[3]),
      y: parseFloat(dm[4]),
      width: parseFloat(dm[1]),
      height: parseFloat(dm[2])
    };
    if (rectsOverlap(imgRect, barcodeZonePt, 0.5)) {
      violations.push({
        type: 'image-xobject',
        name: dm[5],
        xPt: +imgRect.x.toFixed(1),
        yPt: +imgRect.y.toFixed(1)
      });
    }
  }

  return {
    clear: violations.length === 0,
    violations,
    inspectedOperators
  };
}

/**
 * Run all 9 mandatory KDP Preflight inspections on the actual generated PDF bytes.
 *
 * @param {object} params
 * @param {Uint8Array | null} params.interiorPdfBytes
 * @param {Uint8Array | null} params.coverPdfBytes
 * @param {number} params.expectedPageCount
 * @param {object} params.layout
 * @param {object} [params.spineConstants]
 * @param {object} [params.coverPlan]
 */
export async function runPreflightChecks({
  interiorPdfBytes,
  coverPdfBytes,
  expectedPageCount,
  layout = {},
  spineConstants = {},
  coverPlan = null
}) {
  const { PDFLib } = await loadPdfEngines();
  const checks = [];

  let interiorDoc = null;
  let coverDoc = null;
  let interiorOpenError = null;
  let coverOpenError = null;

  // 1. Parse both binary PDFs
  try {
    if (!hasValidPdfEnvelope(interiorPdfBytes)) {
      throw new Error('Interior PDF has not been generated or has an invalid PDF header/EOF');
    }
    interiorDoc = await PDFLib.PDFDocument.load(interiorPdfBytes, {
      throwOnInvalidObject: false
    });
  } catch (err) {
    interiorOpenError = err.message;
  }

  try {
    if (!hasValidPdfEnvelope(coverPdfBytes)) {
      throw new Error('Cover PDF has not been generated or has an invalid PDF header/EOF');
    }
    coverDoc = await PDFLib.PDFDocument.load(coverPdfBytes, {
      throwOnInvalidObject: false
    });
  } catch (err) {
    coverOpenError = err.message;
  }

  const bothOpen = Boolean(interiorDoc && coverDoc);
  checks.push({
    id: 'pdf-opens',
    title: 'PDF files open cleanly',
    passed: bothOpen,
    detail: bothOpen
      ? `Parsed Interior (${(interiorPdfBytes.byteLength / 1024).toFixed(1)} KB) and Cover (${(coverPdfBytes.byteLength / 1024).toFixed(1)} KB) binary streams without errors.`
      : `Failed to parse: ${[interiorOpenError, coverOpenError].filter(Boolean).join('; ')}`
  });

  if (!bothOpen) {
    return {
      allPassed: false,
      passCount: checks.filter((c) => c.passed).length,
      totalCount: checks.length,
      checks
    };
  }

  const actualInteriorPages = interiorDoc.getPageCount();
  const expectedInterior = computeInteriorDimensions({
    trimSize: layout.trimSize || '6x9',
    bleed: Boolean(layout.bleed),
    pageCount: actualInteriorPages
  });

  // 2. Interior page dimensions across every page
  let badSizePage = null;
  for (let i = 0; i < actualInteriorPages; i++) {
    const sz = interiorDoc.getPage(i).getSize();
    const wIn = pointsToInches(sz.width);
    const hIn = pointsToInches(sz.height);
    if (
      Math.abs(wIn - expectedInterior.pageWidthIn) > TOLERANCE_IN ||
      Math.abs(hIn - expectedInterior.pageHeightIn) > TOLERANCE_IN
    ) {
      badSizePage = { page: i + 1, wIn, hIn };
      break;
    }
  }
  const firstPageSz = interiorDoc.getPage(0).getSize();
  const actualWIn = pointsToInches(firstPageSz.width);
  const actualHIn = pointsToInches(firstPageSz.height);

  checks.push({
    id: 'interior-page-size',
    title: 'Correct interior page size',
    passed: badSizePage === null,
    detail:
      badSizePage === null
        ? `All ${actualInteriorPages} pages measure ${actualWIn.toFixed(3)}" x ${actualHIn.toFixed(3)}" (${firstPageSz.width.toFixed(1)} x ${firstPageSz.height.toFixed(1)} pt).`
        : `Page ${badSizePage.page} measures ${badSizePage.wIn.toFixed(3)}" x ${badSizePage.hIn.toFixed(3)}", expected ${expectedInterior.pageWidthIn.toFixed(3)}" x ${expectedInterior.pageHeightIn.toFixed(3)}".`
  });

  // 3. Embedded font binary streams in BOTH Interior and Cover PDFs
  const interiorFonts = inspectEmbeddedFonts(interiorDoc, PDFLib);
  const coverFonts = inspectEmbeddedFonts(coverDoc, PDFLib);
  const fontsOk = interiorFonts.allEmbedded && coverFonts.allEmbedded;
  const uniqueNames = Array.from(
    new Set([...interiorFonts.descriptors, ...coverFonts.descriptors].map((d) => d.name))
  );

  checks.push({
    id: 'font-embedding',
    title: 'Font embedding detected',
    passed: fontsOk,
    detail: fontsOk
      ? `${interiorFonts.descriptors.length} interior + ${coverFonts.descriptors.length} cover font stream(s) embedded (${uniqueNames.join(', ')}).`
      : `Unembedded or missing font streams detected: ${[...interiorFonts.unembeddedFonts, ...coverFonts.unembeddedFonts].join(', ') || 'none embedded'}.`
  });

  // 4. Page count matches current manuscript pagination
  const countMatches =
    expectedPageCount > 0 ? actualInteriorPages === expectedPageCount : actualInteriorPages > 0;
  checks.push({
    id: 'page-count-matches',
    title: 'Page count matches paginated manuscript',
    passed: countMatches,
    detail: countMatches
      ? `Interior PDF contains ${actualInteriorPages} pages, matching current layout pagination.`
      : `Interior PDF has ${actualInteriorPages} pages, but current manuscript paginates to ${expectedPageCount} pages. Regenerate PDFs to sync.`
  });

  // 5. Even page count
  const isEven = actualInteriorPages % 2 === 0;
  checks.push({
    id: 'even-page-count',
    title: 'Even final page count',
    passed: isEven,
    detail: isEven
      ? `${actualInteriorPages} pages is even (divisible by 2 for 2-sided leaf printing).`
      : `${actualInteriorPages} pages is odd; KDP requires an even page count.`
  });

  // 6. KDP minimum 24 pages (and <= 828 max)
  const minPages = KDP_CONFIG.interior.minPageCount;
  const maxPages = KDP_CONFIG.interior.maxPageCount;
  const withinBounds = actualInteriorPages >= minPages && actualInteriorPages <= maxPages;
  checks.push({
    id: 'minimum-24-pages',
    title: `Minimum ${minPages} pages (KDP paperback limit)`,
    passed: withinBounds,
    detail: withinBounds
      ? `${actualInteriorPages} pages is within KDP's ${minPages}–${maxPages} paperback range.`
      : actualInteriorPages < minPages
        ? `Interior PDF has ${actualInteriorPages} pages (KDP minimum is ${minPages} pages for print binding; use "Load 28-Page KDP Sample" in Manuscript to test 24+ page compliance).`
        : `Interior PDF has ${actualInteriorPages} pages, exceeding KDP's ${maxPages}-page limit.`
  });

  // 7. Cover dimensions match computed wraparound spec for actual interior page count
  const expectedCover = computeCoverDimensions({
    trimSize: layout.trimSize || '6x9',
    pageCount: actualInteriorPages,
    paperType: layout.paperType || 'white',
    spineWhitePaperIn: spineConstants.spineWhitePaperIn,
    spineCreamPaperIn: spineConstants.spineCreamPaperIn
  });
  const coverPageCount = coverDoc.getPageCount();
  const coverSize = coverDoc.getPage(0).getSize();
  const coverWIn = pointsToInches(coverSize.width);
  const coverHIn = pointsToInches(coverSize.height);
  const coverDimsMatch =
    coverPageCount === 1 &&
    Math.abs(coverWIn - expectedCover.fullWidthIn) <= TOLERANCE_IN &&
    Math.abs(coverHIn - expectedCover.fullHeightIn) <= TOLERANCE_IN;

  checks.push({
    id: 'cover-dimensions',
    title: 'Cover dimensions match computed wraparound spec',
    passed: coverDimsMatch,
    detail: coverDimsMatch
      ? `Single-page wraparound PDF measures ${coverWIn.toFixed(4)}" x ${coverHIn.toFixed(4)}" (spine ${expectedCover.spineWidthIn.toFixed(4)}" for ${actualInteriorPages} ${expectedCover.paperType} pages).`
      : `Cover PDF is ${coverPageCount} page(s) at ${coverWIn.toFixed(4)}" x ${coverHIn.toFixed(4)}", expected 1 page at ${expectedCover.fullWidthIn.toFixed(4)}" x ${expectedCover.fullHeightIn.toFixed(4)}".`
  });

  // 8. Barcode clear zone (real content-stream operator inspection + plan cross-check)
  const streamCheck = inspectCoverBarcodeClearZone(
    coverDoc,
    expectedCover.barcodeZonePt,
    PDFLib
  );
  const planOverlaps = coverPlan?.barcodeOverlaps?.length || 0;
  const barcodeClear = streamCheck.clear && planOverlaps === 0;

  checks.push({
    id: 'barcode-zone-clear',
    title: 'Back-cover barcode zone (2.0" x 1.2") is clear',
    passed: barcodeClear,
    detail: barcodeClear
      ? `Inspected ${streamCheck.inspectedOperators} PDF content-stream drawing blocks; zero text or art inside [${expectedCover.barcodeZoneIn.x.toFixed(3)}", ${expectedCover.barcodeZoneIn.y.toFixed(3)}"] to [${expectedCover.barcodeZoneIn.right.toFixed(3)}", ${expectedCover.barcodeZoneIn.top.toFixed(3)}"].`
      : `Detected ${streamCheck.violations.length + planOverlaps} element(s) overlapping the 2.0" x 1.2" back-cover barcode reserve box.`
  });

  // 9. Bleed present when enabled
  const trim = expectedInterior.trim;
  const expectedBleedW = layout.bleed ? +(trim.widthIn + 0.125).toFixed(4) : trim.widthIn;
  const expectedBleedH = layout.bleed ? +(trim.heightIn + 0.25).toFixed(4) : trim.heightIn;
  const bleedMatches =
    Math.abs(actualWIn - expectedBleedW) <= TOLERANCE_IN &&
    Math.abs(actualHIn - expectedBleedH) <= TOLERANCE_IN;

  checks.push({
    id: 'bleed-verification',
    title: 'Bleed specification verified',
    passed: bleedMatches,
    detail: layout.bleed
      ? bleedMatches
        ? `Bleed enabled: Interior MediaBox includes +0.125" outside & +0.250" vertical bleed (${actualWIn.toFixed(3)}" x ${actualHIn.toFixed(3)}").`
        : `Bleed enabled, but PDF MediaBox is ${actualWIn.toFixed(3)}" x ${actualHIn.toFixed(3)}" instead of ${expectedBleedW}" x ${expectedBleedH}".`
      : bleedMatches
        ? `Bleed disabled: Interior MediaBox matches exact ${trim.widthIn.toFixed(2)}" x ${trim.heightIn.toFixed(2)}" trim; Cover includes mandatory 0.125" wrap bleed.`
        : `Bleed disabled, but Interior PDF MediaBox (${actualWIn.toFixed(3)}" x ${actualHIn.toFixed(3)}") does not match trim.`
  });

  const passCount = checks.filter((c) => c.passed).length;
  return {
    allPassed: passCount === checks.length,
    passCount,
    totalCount: checks.length,
    actualInteriorPages,
    interiorFileBytes: interiorPdfBytes.byteLength,
    coverFileBytes: coverPdfBytes.byteLength,
    checks
  };
}
