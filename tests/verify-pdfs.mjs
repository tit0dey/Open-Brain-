import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createDemoProject, createFull28PageSampleText } from '../js/demo-project.js';
import { parseManuscript } from '../js/manuscript.js';
import { generateInteriorPdf } from '../js/interior-pdf.js';
import { generateCoverPdf } from '../js/cover-pdf.js';
import { runPreflightChecks } from '../js/preflight.js';
import { loadPdfEngines } from '../js/pdf-loader.js';
import { pointsToInches } from '../js/layout-math.js';

test('Headless 12-page demo project generates valid print-quality Interior & Cover PDFs', async () => {
  const demo = createDemoProject();
  const parsed = parseManuscript(demo.manuscriptText, demo.bookMeta.title);
  assert.equal(parsed.chapterCount, 4);
  assert.equal(parsed.hasDevanagari, true);

  const progressSteps = [];
  const interiorRes = await generateInteriorPdf({
    parsedManuscript: parsed,
    bookMeta: demo.bookMeta,
    layout: demo.layout,
    onProgress: (p) => progressSteps.push(p.percent)
  });

  assert.equal(interiorRes.pageCount, 12, 'Demo project must generate a 12-page interior PDF');
  assert.ok(interiorRes.pdfBytes.byteLength > 15000, 'Interior PDF should embed subsetted fonts');
  assert.ok(progressSteps.length >= 4, 'Chunked progress callbacks must fire');

  // Verify TOC contains exact recto page numbers [5, 7, 9, 11]
  assert.deepEqual(
    interiorRes.paginated.tocEntries.map((e) => e.pageNumber),
    [5, 7, 9, 11]
  );

  // Generate matching wraparound Cover PDF
  const coverRes = await generateCoverPdf({
    cover: demo.cover,
    bookMeta: demo.bookMeta,
    trimSize: demo.layout.trimSize,
    pageCount: interiorRes.pageCount,
    paperType: demo.layout.paperType,
    spineConstants: demo.spineConstants
  });

  assert.ok(coverRes.pdfBytes.byteLength > 8000, 'Cover PDF should embed subsetted fonts');
  // 12 pages < 79 -> spine text must be omitted automatically
  assert.equal(coverRes.plan.spineItem, null);

  // Independently reload both binary PDFs with pdf-lib and verify page count & MediaBox
  const { PDFLib } = await loadPdfEngines();
  const loadedInterior = await PDFLib.PDFDocument.load(interiorRes.pdfBytes);
  assert.equal(loadedInterior.getPageCount(), 12);
  const p0 = loadedInterior.getPage(0).getSize();
  assert.equal(pointsToInches(p0.width), 6.0);
  assert.equal(pointsToInches(p0.height), 9.0);

  const loadedCover = await PDFLib.PDFDocument.load(coverRes.pdfBytes);
  assert.equal(loadedCover.getPageCount(), 1);
  const c0 = loadedCover.getPage(0).getSize();
  // 0.125 + 6 + (12 * 0.0025 = 0.03) + 6 + 0.125 = 12.28" x 9.25"
  assert.ok(Math.abs(pointsToInches(c0.width) - 12.28) < 0.001);
  assert.ok(Math.abs(pointsToInches(c0.height) - 9.25) < 0.001);

  // Run Preflight Inspector on the 12-page demo PDFs
  const preflight = await runPreflightChecks({
    interiorPdfBytes: interiorRes.pdfBytes,
    coverPdfBytes: coverRes.pdfBytes,
    expectedPageCount: interiorRes.pageCount,
    layout: demo.layout,
    spineConstants: demo.spineConstants,
    coverPlan: coverRes.plan
  });

  const byId = Object.fromEntries(preflight.checks.map((c) => [c.id, c]));
  assert.equal(byId['pdf-opens'].passed, true);
  assert.equal(byId['interior-page-size'].passed, true);
  assert.equal(byId['font-embedding'].passed, true);
  assert.equal(byId['page-count-matches'].passed, true);
  assert.equal(byId['even-page-count'].passed, true);
  assert.equal(byId['minimum-24-pages'].passed, false, '12-page demo accurately flags < 24 min');
  assert.equal(byId['cover-dimensions'].passed, true);
  assert.equal(byId['barcode-zone-clear'].passed, true);
  assert.equal(byId['bleed-verification'].passed, true);

  console.log(
    `[Verified 12-page Demo] Interior: ${interiorRes.pageCount} pp (${(
      interiorRes.pdfBytes.byteLength / 1024
    ).toFixed(1)} KB, ${pointsToInches(p0.width)}"x${pointsToInches(p0.height)}"), Cover: 1 pp (${(
      coverRes.pdfBytes.byteLength / 1024
    ).toFixed(1)} KB, ${pointsToInches(c0.width)}"x${pointsToInches(c0.height)}")`
  );
});

test('24+ page KDP sample with Bleed ON passes all 9/9 Preflight checks', async () => {
  const demo = createDemoProject();
  const fullText = createFull28PageSampleText();
  const parsed = parseManuscript(fullText, demo.bookMeta.title);
  const bleedLayout = { ...demo.layout, bleed: true, paperType: 'white', fontId: 'inter' };

  const interiorRes = await generateInteriorPdf({
    parsedManuscript: parsed,
    bookMeta: demo.bookMeta,
    layout: bleedLayout
  });

  assert.ok(interiorRes.pageCount >= 24 && interiorRes.pageCount % 2 === 0);
  // With bleed on 6x9: 6.125" x 9.25"
  assert.equal(interiorRes.interior.pageWidthIn, 6.125);
  assert.equal(interiorRes.interior.pageHeightIn, 9.25);

  const coverRes = await generateCoverPdf({
    cover: { ...demo.cover, templateId: 'horizon', fontId: 'inter' },
    bookMeta: demo.bookMeta,
    trimSize: bleedLayout.trimSize,
    pageCount: interiorRes.pageCount,
    paperType: bleedLayout.paperType,
    spineConstants: demo.spineConstants
  });

  const preflight = await runPreflightChecks({
    interiorPdfBytes: interiorRes.pdfBytes,
    coverPdfBytes: coverRes.pdfBytes,
    expectedPageCount: interiorRes.pageCount,
    layout: bleedLayout,
    spineConstants: demo.spineConstants,
    coverPlan: coverRes.plan
  });

  assert.equal(preflight.allPassed, true, JSON.stringify(preflight.checks, null, 2));
  assert.equal(preflight.passCount, 9);
});

test('Preflight content-stream inspector catches barcode overlap when back blurb overflows', async () => {
  const demo = createDemoProject();
  const overflowingCover = {
    ...demo.cover,
    allowBarcodeOverlap: true,
    backBlurb: Array(14)
      .fill(
        'This deliberately unguarded back-cover copy extends all the way down into the lower-right retail ISBN barcode reserve rectangle so preflight stream inspection catches it.'
      )
      .join('\n\n')
  };

  const parsed = parseManuscript(demo.manuscriptText, demo.bookMeta.title);
  const interiorRes = await generateInteriorPdf({
    parsedManuscript: parsed,
    bookMeta: demo.bookMeta,
    layout: demo.layout
  });

  const coverRes = await generateCoverPdf({
    cover: overflowingCover,
    bookMeta: demo.bookMeta,
    trimSize: demo.layout.trimSize,
    pageCount: interiorRes.pageCount,
    paperType: demo.layout.paperType,
    spineConstants: demo.spineConstants
  });

  assert.ok(coverRes.plan.barcodeOverlaps.length > 0);

  const preflight = await runPreflightChecks({
    interiorPdfBytes: interiorRes.pdfBytes,
    coverPdfBytes: coverRes.pdfBytes,
    expectedPageCount: interiorRes.pageCount,
    layout: demo.layout,
    spineConstants: demo.spineConstants
  });

  const barcodeCheck = preflight.checks.find((c) => c.id === 'barcode-zone-clear');
  assert.equal(barcodeCheck.passed, false);
});

test('Zero emoji exist anywhere in UI, source modules, or documentation', async () => {
  const emojiRegex = /\p{Extended_Pictographic}/u;
  const dirsToScan = ['.', 'js', 'styles', 'tests'];
  for (const dir of dirsToScan) {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (!/\.(html|css|js|mjs|json|md|webmanifest)$/.test(ent.name)) continue;
      const filePath = path.join(dir, ent.name);
      const text = await fs.readFile(filePath, 'utf8');
      assert.equal(
        emojiRegex.test(text),
        false,
        `Found forbidden emoji character inside ${filePath}`
      );
    }
  }
});
