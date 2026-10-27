/**
 * KDP Studio — Mobile-First Application Controller
 *
 * Coordinates the 6-step KDP production workflow, live canvas proofs,
 * cancellable chunked PDF generation, binary PDF preflight inspection,
 * localStorage persistence, .json export/import, and theme switching.
 */

import { FONT_CATALOG, LISTING_RULES } from './config.js';
import {
  computeInteriorDimensions,
  computeCoverDimensions,
  computePricing
} from './layout-math.js';
import { parseManuscript, estimatePageCount } from './manuscript.js';
import { paginateBook } from './paginator.js';
import {
  generateInteriorPdf,
  renderInteriorPageToCanvas
} from './interior-pdf.js';
import {
  buildCoverLayoutPlan,
  generateCoverPdf,
  renderCoverPlanToCanvas,
  formatCoverSpecsText
} from './cover-pdf.js';
import { runPreflightChecks } from './preflight.js';
import {
  HOOK_PATTERNS,
  KDP_CATEGORIES,
  validateKeywords,
  generateBookDescription,
  formatDescriptionAsKdpHtml,
  suggestKeywordsFromProject,
  buildPlainEnglishMetadataBlock
} from './listing.js';
import {
  createDemoProject,
  createFull28PageSampleText
} from './demo-project.js';
import {
  loadProjectFromStorage,
  saveProjectToStorage,
  slugifyFilename,
  serializeProjectJson,
  parseImportedProjectJson,
  loadSavedTheme,
  saveTheme
} from './storage.js';
import { ICONS } from './icons.js';

const $ = (id) => document.getElementById(id);

const state = {
  step: 0,
  theme: 'light',
  project: null,
  parsedManuscript: null,
  paginatedBook: null,
  previewPageIndex: 0,
  coverPlan: null,
  coverImageElement: null,
  interiorPdfBytes: null,
  interiorGeneratedAt: null,
  interiorDirty: true,
  coverPdfBytes: null,
  coverGeneratedAt: null,
  coverDirty: true,
  preflightReport: null,
  activeAbortController: null
};

let saveTimer = null;
let paginateTimer = null;
let toastTimer = null;
let confirmResolver = null;

/* ==========================================================================
   Utilities: Toast, Clipboard, Download, Accessible Confirm, Task Runner
   ========================================================================== */

function showToast(message) {
  const el = $('toast');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 2600);
}

async function copyTextToClipboard(text, label = 'Copied to clipboard') {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    showToast(label);
  } catch {
    showToast('Could not access clipboard on this device');
  }
}

function downloadBlob(bytesOrText, filename, mimeType) {
  const blob =
    bytesOrText instanceof Blob
      ? bytesOrText
      : new Blob([bytesOrText], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function askConfirmation({ title, body, confirmLabel = 'Confirm' }) {
  return new Promise((resolve) => {
    confirmResolver = resolve;
    $('confirm-modal-title').textContent = title;
    $('confirm-modal-body').textContent = body;
    $('btn-confirm-accept').textContent = confirmLabel;
    $('confirm-modal').hidden = false;
    $('btn-confirm-cancel').focus();
  });
}

function closeConfirmModal(accepted) {
  $('confirm-modal').hidden = true;
  if (confirmResolver) {
    const r = confirmResolver;
    confirmResolver = null;
    r(Boolean(accepted));
  }
}

async function runCancellableTask(taskFn) {
  if (state.activeAbortController) {
    state.activeAbortController.abort();
  }
  const controller = new AbortController();
  state.activeAbortController = controller;

  const dock = $('progress-dock');
  const labelEl = $('progress-label');
  const fillEl = $('progress-fill');
  dock.hidden = false;
  fillEl.style.width = '4%';
  labelEl.textContent = 'Starting...';

  const onProgress = ({ percent = 0, label = '' }) => {
    fillEl.style.width = `${Math.max(2, Math.min(100, percent))}%`;
    if (label) labelEl.textContent = label;
  };

  try {
    const res = await taskFn(controller.signal, onProgress);
    return res;
  } catch (err) {
    if (err?.name === 'AbortError') {
      showToast('Generation cancelled');
      return null;
    }
    console.error(err);
    showToast(`Error: ${err?.message || 'Task failed'}`);
    return null;
  } finally {
    if (state.activeAbortController === controller) {
      state.activeAbortController = null;
      dock.hidden = true;
    }
  }
}

/* ==========================================================================
   Persistence & Theme
   ========================================================================== */

function applyTheme(theme) {
  state.theme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', state.theme);
  const btn = $('btn-theme-toggle');
  if (btn) {
    btn.innerHTML = state.theme === 'dark' ? ICONS.sun : ICONS.moon;
  }
  saveTheme(state.theme);
}

function scheduleAutoSave() {
  const statusEl = $('save-status');
  if (statusEl) statusEl.textContent = 'Saving locally...';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const res = saveProjectToStorage(state.project);
    if (statusEl) {
      statusEl.textContent = res.saved
        ? res.omittedImage
          ? 'Saved locally (large cover image kept in session)'
          : 'Offline-first · Saved locally'
        : 'Local storage full — export .json backup';
    }
  }, 260);
}

/* ==========================================================================
   Static Select & Icon Hydration
   ========================================================================== */

function hydrateStaticIconsAndOptions() {
  $('brand-icon').innerHTML = ICONS.book;
  $('btn-export-json').innerHTML = ICONS.download;
  $('icon-import-json').innerHTML = ICONS.upload;
  $('btn-reset-demo').innerHTML = ICONS.refresh;
  $('icon-upload-ms').innerHTML = ICONS.upload;
  $('icon-upload-cover').innerHTML = ICONS.upload;
  $('btn-prev-page').innerHTML = ICONS.chevronLeft;
  $('btn-next-page').innerHTML = ICONS.chevronRight;
  $('btn-download-interior').innerHTML = `${ICONS.download}<span>Download Interior PDF</span>`;
  $('btn-regen-interior').innerHTML = `${ICONS.refresh}<span>Regenerate PDF</span>`;
  $('btn-download-cover').innerHTML = `${ICONS.download}<span>Download Cover PDF</span>`;
  $('btn-regen-cover').innerHTML = `${ICONS.refresh}<span>Regenerate Cover</span>`;
  $('btn-copy-cover-specs').innerHTML = `${ICONS.copy}<span>Copy Specs</span>`;
  $('btn-copy-metadata').innerHTML = `${ICONS.copy}<span>Copy Metadata Block</span>`;
  $('btn-rerun-preflight').innerHTML = `${ICONS.preflight}<span>Inspect PDFs Now</span>`;

  // Populate Hook Patterns
  const hookSelect = $('listing-hook-picker');
  hookSelect.innerHTML = HOOK_PATTERNS.map(
    (h) => `<option value="${h.id}">${h.label} — ${h.pattern}</option>`
  ).join('');

  // Populate Category selects
  const catOptionsHtml =
    `<option value="">— None —</option>` +
    KDP_CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join('');
  for (const id of ['listing-cat-1', 'listing-cat-2', 'listing-cat-3']) {
    $(id).innerHTML = catOptionsHtml;
  }

  // Build 7 Keyword Slot Inputs
  const kwContainer = $('keyword-slots-container');
  kwContainer.innerHTML = Array.from({ length: LISTING_RULES.keywordCount }, (_, idx) => {
    const num = idx + 1;
    return `
      <div class="field keyword-slot" id="kw-slot-wrap-${idx}">
        <div class="field-label-row">
          <label for="kw-input-${idx}">Keyword Slot ${num}</label>
          <span class="char-counter" id="kw-counter-${idx}">0 / 50</span>
        </div>
        <input type="text" id="kw-input-${idx}" data-kw-index="${idx}" maxlength="60" placeholder="Search phrase ${num} (up to 50 chars)" />
      </div>
    `;
  }).join('');
}

/* ==========================================================================
   Sync Form Inputs <- Project State
   ========================================================================== */

function populateControlsFromProject() {
  const p = state.project;
  $('meta-title').value = p.bookMeta.title || '';
  $('meta-subtitle').value = p.bookMeta.subtitle || '';
  $('meta-author').value = p.bookMeta.author || '';
  $('meta-isbn').value = p.bookMeta.isbn || '';
  $('manuscript-textarea').value = p.manuscriptText || '';

  $('layout-trim').value = p.layout.trimSize || '6x9';
  $('layout-paper').value = p.layout.paperType || 'cream';
  $('layout-font').value = p.layout.fontId || 'eb-garamond';
  $('layout-chapter-style').value = p.layout.chapterStyle || 'classic';
  $('layout-fontsize').value = String(p.layout.fontSizePt || 11);
  $('layout-leading').value = String(p.layout.leading || 1.42);
  $('layout-folio').value = p.layout.folioPosition || 'bottom-center';
  $('layout-bleed').checked = Boolean(p.layout.bleed);
  $('layout-dropcaps').checked = Boolean(p.layout.dropCaps);

  $('cover-template').value = p.cover.templateId || 'meridian';
  $('cover-palette').value = p.cover.paletteId || 'midnight';
  $('cover-font').value = p.cover.fontId || 'eb-garamond';
  $('cover-img-mode').value = p.cover.frontImageMode || 'framed';
  $('cover-back-headline').value = p.cover.backHeadline || '';
  $('cover-back-blurb').value = p.cover.backBlurb || '';
  $('cover-author-bio').value = p.cover.authorBio || '';
  $('btn-remove-cover-img').hidden = !p.cover.frontImageDataUrl;
  $('lbl-cover-img-text').textContent = p.cover.frontImageDataUrl
    ? 'Replace Front Image'
    : 'Upload Front Cover Image';

  $('const-spine-white').value = p.spineConstants.spineWhitePaperIn;
  $('const-spine-cream').value = p.spineConstants.spineCreamPaperIn;

  $('listing-title').value = p.bookMeta.title || '';
  $('listing-subtitle').value = p.bookMeta.subtitle || '';
  $('listing-hook-picker').value = p.listing.hookPatternId || HOOK_PATTERNS[0].id;
  $('listing-description').value = p.listing.description || '';

  for (let i = 0; i < 3; i++) {
    const sel = $(`listing-cat-${i + 1}`);
    const val = p.listing.categories[i] || '';
    if (val && !Array.from(sel.options).some((o) => o.value === val)) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = val;
      sel.appendChild(opt);
    }
    sel.value = val;
  }

  for (let i = 0; i < LISTING_RULES.keywordCount; i++) {
    $(`kw-input-${i}`).value = p.listing.keywords[i] || '';
  }

  $('price-list-input').value = p.listing.listPriceUsd;
  $('price-fixed-input').value = p.listing.fixedCostUsd;
  $('price-perpage-input').value = p.listing.perPageCostUsd;
  $('price-royalty-input').value = Math.round((p.listing.royaltyRate || 0.6) * 100);
}

/* ==========================================================================
   Reactive Computations & Renderers per Step
   ========================================================================== */

function getEffectivePageCount() {
  if (state.paginatedBook) return state.paginatedBook.pageCount;
  if (state.parsedManuscript) {
    return estimatePageCount(state.parsedManuscript, state.project.layout);
  }
  return 12;
}

function refreshManuscriptStatsUI() {
  const parsed = parseManuscript(
    state.project.manuscriptText,
    state.project.bookMeta.title || 'Chapter 1'
  );
  state.parsedManuscript = parsed;

  const pageCount = state.paginatedBook
    ? state.paginatedBook.pageCount
    : estimatePageCount(parsed, state.project.layout);

  $('stat-words').textContent = parsed.totalWords.toLocaleString();
  $('stat-chapters').textContent = String(parsed.chapterCount);
  $('stat-est-pages').textContent = String(pageCount);
  $('script-badge').textContent = parsed.hasDevanagari
    ? 'Latin + Hindi Devanagari Detected'
    : 'Latin Typography';

  const listEl = $('chapter-list');
  listEl.innerHTML = parsed.chapters
    .map(
      (ch) => `
      <li class="chapter-item">
        <span class="chapter-item-title">${escapeHtml(ch.index + '. ' + ch.title)}</span>
        <span class="chapter-item-meta">${ch.wordCount.toLocaleString()} words</span>
      </li>
    `
    )
    .join('');
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function refreshPaginationAndPreview() {
  if (!state.parsedManuscript) {
    refreshManuscriptStatsUI();
  }
  const paginated = await paginateBook({
    parsedManuscript: state.parsedManuscript,
    bookMeta: state.project.bookMeta,
    layout: state.project.layout
  });
  state.paginatedBook = paginated;
  if (state.previewPageIndex >= paginated.pageCount) {
    state.previewPageIndex = Math.max(0, paginated.pageCount - 1);
  }

  $('stat-est-pages').textContent = String(paginated.pageCount);
  renderInteriorSpecTable();
  populatePreviewJumpSelect();
  drawActiveInteriorCanvas();
  renderInteriorPdfTab();
  await refreshCoverPlanAndPreview();
  refreshListingUI();
}

function schedulePaginationRefresh() {
  clearTimeout(paginateTimer);
  paginateTimer = setTimeout(() => {
    refreshPaginationAndPreview().catch((err) => console.error(err));
  }, 180);
}

function renderInteriorSpecTable() {
  const pageCount = getEffectivePageCount();
  const interior = computeInteriorDimensions({
    trimSize: state.project.layout.trimSize,
    bleed: state.project.layout.bleed,
    pageCount
  });
  const rows = [
    ['Trim Size', `${interior.trim.label} (${interior.trim.name})`],
    [
      'PDF MediaBox Size',
      `${interior.pageWidthIn.toFixed(3)}" x ${interior.pageHeightIn.toFixed(3)}" (${interior.pageWidthPt.toFixed(1)} x ${interior.pageHeightPt.toFixed(1)} pt)`
    ],
    ['KDP Minimum Gutter', `${interior.minMarginsIn.gutter.toFixed(3)}" (Applied: ${interior.marginsIn.gutter.toFixed(3)}")`],
    ['Minimum Outside Margin', `${interior.minMarginsIn.outside.toFixed(3)}" (Applied: ${interior.marginsIn.outside.toFixed(3)}")`],
    ['Paginated Page Count', `${pageCount} pages (Even${pageCount < 24 ? ', < 24 KDP min' : ''})`]
  ];
  $('interior-spec-tbody').innerHTML = rows
    .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`)
    .join('');
}

function populatePreviewJumpSelect() {
  const book = state.paginatedBook;
  if (!book) return;
  const sel = $('preview-jump-select');
  const options = [];
  book.pages.forEach((p, idx) => {
    if (p.kind === 'title') options.push([idx, `Page ${p.pageNumber} — Title Page (Recto)`]);
    else if (p.kind === 'copyright') options.push([idx, `Page ${p.pageNumber} — Copyright Page (Verso)`]);
    else if (p.kind === 'toc') options.push([idx, `Page ${p.pageNumber} — Table of Contents`]);
    else if (p.kind === 'chapter-open') {
      options.push([idx, `Page ${p.pageNumber} — ${p.chapterTitle} (Recto)`]);
    }
  });
  sel.innerHTML = options
    .map(([idx, label]) => `<option value="${idx}">${escapeHtml(label)}</option>`)
    .join('');
  // Match closest jump anchor <= current page
  let chosen = 0;
  for (const [idx] of options) {
    if (idx <= state.previewPageIndex) chosen = idx;
  }
  sel.value = String(chosen);
}

function drawActiveInteriorCanvas() {
  const book = state.paginatedBook;
  if (!book) return;
  const well = $('interior-preview-well');
  const maxCssWidth = Math.max(240, Math.min((well?.clientWidth || 340) - 24, 420));
  const canvas = $('interior-preview-canvas');

  renderInteriorPageToCanvas(canvas, book, state.previewPageIndex, {
    maxCssWidth,
    showGuides: $('preview-guides-toggle').checked
  });

  const p = book.pages[state.previewPageIndex];
  const sideLabel = p.isRecto ? 'Recto (Right)' : 'Verso (Left)';
  $('preview-page-label').textContent = `Page ${p.pageNumber} of ${book.pageCount} · ${sideLabel}`;
  $('btn-prev-page').disabled = state.previewPageIndex <= 0;
  $('btn-next-page').disabled = state.previewPageIndex >= book.pageCount - 1;
}

function renderInteriorPdfTab() {
  const book = state.paginatedBook;
  const pageCount = getEffectivePageCount();
  const interior = computeInteriorDimensions({
    trimSize: state.project.layout.trimSize,
    bleed: state.project.layout.bleed,
    pageCount
  });
  const fontEntry = FONT_CATALOG[state.project.layout.fontId] || FONT_CATALOG['eb-garamond'];

  const banner = $('interior-ready-banner');
  if (state.interiorPdfBytes && !state.interiorDirty) {
    banner.className = 'banner banner-pass';
    banner.innerHTML = `${ICONS.check}<div><strong>Interior PDF is generated and up to date.</strong> ${(
      state.interiorPdfBytes.byteLength / 1024
    ).toFixed(1)} KB print-ready file ready for download.</div>`;
  } else if (state.interiorPdfBytes && state.interiorDirty) {
    banner.className = 'banner banner-warn';
    banner.innerHTML = `${ICONS.alert}<div><strong>Manuscript or layout changed since last build.</strong> Tap "Regenerate PDF" to update your downloadable Interior PDF.</div>`;
  } else {
    banner.className = 'banner banner-warn';
    banner.innerHTML = `${ICONS.alert}<div><strong>Interior PDF not built yet.</strong> Tap "Generate Interior PDF" below to assemble your print file.</div>`;
  }

  $('btn-download-interior').disabled = !state.interiorPdfBytes;

  const summaryRows = [
    ['Final Even Page Count', `${pageCount} pages`],
    ['Page Size (Inches)', `${interior.pageWidthIn.toFixed(3)}" x ${interior.pageHeightIn.toFixed(3)}"`],
    ['Page Size (PDF Points)', `${interior.pageWidthPt.toFixed(2)} x ${interior.pageHeightPt.toFixed(2)} pt`],
    ['Embedded OFL Font', `${fontEntry.label}${state.parsedManuscript?.hasDevanagari && fontEntry.id !== 'noto-devanagari' ? ' + Noto Sans Devanagari' : ''}`],
    ['Chapter Openings', 'Strict Right-Hand (Recto / Odd) Pages'],
    ['Running Headers', 'Book Title (Even) / Chapter Title (Odd)'],
    [
      'Generated File Size',
      state.interiorPdfBytes
        ? `${(state.interiorPdfBytes.byteLength / 1024).toFixed(1)} KB`
        : 'Pending generation'
    ]
  ];
  $('interior-pdf-summary').innerHTML = summaryRows
    .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`)
    .join('');

  const tocList = $('toc-preview-list');
  if (book?.tocEntries?.length) {
    tocList.innerHTML = book.tocEntries
      .map(
        (e) => `
        <li class="chapter-item">
          <span class="chapter-item-title">${escapeHtml(e.title)}</span>
          <span class="chapter-item-meta">Page ${e.pageNumber}</span>
        </li>
      `
      )
      .join('');
  }
}

/* ==========================================================================
   Cover Tab Rendering & Image Normalization
   ========================================================================== */

async function loadCoverImageElement(dataUrl) {
  if (!dataUrl) {
    state.coverImageElement = null;
    return;
  }
  await new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      state.coverImageElement = img;
      resolve();
    };
    img.onerror = () => {
      state.coverImageElement = null;
      resolve();
    };
    img.src = dataUrl;
  });
}

async function normalizeUploadedImageFile(file) {
  const bitmapUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Could not decode selected image'));
      el.src = bitmapUrl;
    });
    const maxEdge = 1800;
    const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    const outMime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    return c.toDataURL(outMime, 0.88);
  } finally {
    URL.revokeObjectURL(bitmapUrl);
  }
}

async function refreshCoverPlanAndPreview() {
  const pageCount = getEffectivePageCount();
  const plan = await buildCoverLayoutPlan({
    cover: state.project.cover,
    bookMeta: state.project.bookMeta,
    trimSize: state.project.layout.trimSize,
    pageCount,
    paperType: state.project.layout.paperType,
    spineConstants: state.project.spineConstants
  });
  state.coverPlan = plan;

  const { spec } = plan;

  // Barcode overlap warning
  const barcodeBanner = $('cover-barcode-warning');
  if (plan.barcodeOverlaps.length > 0) {
    barcodeBanner.hidden = false;
    barcodeBanner.innerHTML = `${ICONS.alert}<div><strong>Barcode Zone Overlap Detected:</strong> ${plan.barcodeOverlaps.length} element(s) enter the mandatory 2.0" x 1.2" back-cover barcode clear box. Shorten back-cover copy before printing.</div>`;
  } else {
    barcodeBanner.hidden = true;
  }

  // Spine eligibility notice
  const spineNotice = $('cover-spine-notice');
  if (spec.spineEligibility.allowed) {
    spineNotice.className = 'banner banner-pass';
    spineNotice.innerHTML = `${ICONS.check}<div><strong>Spine Text Active:</strong> ${spec.pageCount} pages yields a ${spec.spineWidthIn.toFixed(4)}" (${spec.spineWidthPx} px) spine, meeting KDP's 79-page and fold-variance rules.</div>`;
  } else {
    spineNotice.className = 'banner banner-warn';
    spineNotice.innerHTML = `${ICONS.alert}<div><strong>Spine Left Clean (KDP Compliant):</strong> ${escapeHtml(spec.spineEligibility.reason)}. Spine width is ${spec.spineWidthIn.toFixed(4)}" (${spec.spineWidthPx} px @ 300 DPI).</div>`;
  }

  // Specs table in inches AND pixels @ 300 DPI
  const specRows = [
    ['Interior Page Count', `${spec.pageCount} pages (${spec.paperType === 'cream' ? 'Cream' : 'White'})`],
    ['Computed Spine Width', `${spec.spineWidthIn.toFixed(4)}" (${spec.spineWidthPx} px @ 300 DPI)`],
    ['Full Cover Width', `${spec.fullWidthIn.toFixed(4)}" (${spec.fullWidthPx} px @ 300 DPI)`],
    ['Full Cover Height', `${spec.fullHeightIn.toFixed(4)}" (${spec.fullHeightPx} px @ 300 DPI)`],
    ['PDF Single-Page Size', `${spec.fullWidthPt.toFixed(2)} x ${spec.fullHeightPt.toFixed(2)} pt`],
    ['Trim Safe Margin', `>= ${spec.safeMarginIn.toFixed(2)}" inside all trim edges`],
    ['Barcode Clear Zone', `2.0" x 1.2" (600 x 360 px) at back bottom-right`],
    [
      'Cover PDF File',
      state.coverPdfBytes
        ? `${(state.coverPdfBytes.byteLength / 1024).toFixed(1)} KB${state.coverDirty ? ' (needs rebuild)' : ' (ready)'}`
        : 'Pending generation'
    ]
  ];
  $('cover-spec-tbody').innerHTML = specRows
    .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`)
    .join('');

  $('btn-download-cover').disabled = !state.coverPdfBytes;
  drawActiveCoverCanvas();
}

function drawActiveCoverCanvas() {
  if (!state.coverPlan) return;
  const well = $('cover-preview-well');
  const maxCssWidth = Math.max(260, Math.min((well?.clientWidth || 560) - 20, 760));
  renderCoverPlanToCanvas($('cover-preview-canvas'), state.coverPlan, {
    maxCssWidth,
    showGuides: $('cover-guides-toggle').checked,
    loadedImageElement: state.coverImageElement
  });
}

/* ==========================================================================
   Listing & Pricing Tab Rendering
   ========================================================================== */

function refreshListingUI() {
  const { bookMeta, listing, layout, spineConstants } = state.project;
  const pageCount = getEffectivePageCount();

  const tLen = (bookMeta.title || '').length;
  const sLen = (bookMeta.subtitle || '').length;
  const comboLen = tLen + sLen;

  $('counter-listing-title').textContent = `${tLen} / ${LISTING_RULES.maxTitleChars}`;
  $('counter-listing-subtitle').textContent = `${sLen} / ${LISTING_RULES.maxSubtitleChars}`;
  const comboEl = $('counter-title-combo');
  comboEl.textContent = `${comboLen} / ${LISTING_RULES.maxTitlePlusSubtitleChars} combined`;
  comboEl.classList.toggle('is-warn', comboLen > LISTING_RULES.maxTitlePlusSubtitleChars);

  const dLen = (listing.description || '').length;
  const descCounter = $('counter-description');
  descCounter.textContent = `${dLen} / ${LISTING_RULES.maxDescriptionChars}`;
  descCounter.classList.toggle('is-warn', dLen > LISTING_RULES.maxDescriptionChars);

  // 7 Keywords validation
  const kwRes = validateKeywords(listing.keywords);
  kwRes.slots.forEach((slot) => {
    const wrap = $(`kw-slot-wrap-${slot.index}`);
    const counter = $(`kw-counter-${slot.index}`);
    const hasIssue = slot.isEmpty || slot.isTooLong || slot.isDuplicate;
    wrap.classList.toggle('has-issue', hasIssue);
    let label = `${slot.length} / 50`;
    if (slot.isDuplicate) label += ` (Duplicate of #${slot.duplicateWith.join(', #')})`;
    else if (slot.isEmpty) label += ' (Empty)';
    counter.textContent = label;
    counter.classList.toggle('is-warn', hasIssue);
  });

  const kwBanner = $('keyword-warning-banner');
  if (kwRes.warnings.length > 0) {
    kwBanner.hidden = false;
    kwBanner.innerHTML = `${ICONS.alert}<div>${kwRes.warnings.map(escapeHtml).join('<br/>')}</div>`;
  } else {
    kwBanner.hidden = true;
  }

  // Pricing Calculator
  const pricing = computePricing({
    pageCount,
    listPriceUsd: listing.listPriceUsd,
    fixedCostUsd: listing.fixedCostUsd,
    perPageCostUsd: listing.perPageCostUsd,
    royaltyRate: listing.royaltyRate
  });

  $('price-out-pages').textContent = `${pageCount} pages`;
  $('price-out-printcost').textContent = `$${pricing.printingCostUsd.toFixed(2)}`;
  $('price-out-minprice').textContent = `$${pricing.minListPriceUsd.toFixed(2)}`;
  $('price-out-gross').textContent = `$${pricing.grossRoyaltyUsd.toFixed(2)} (${Math.round(pricing.royaltyRate * 100)}%)`;
  $('price-out-profit').textContent = `${pricing.perCopyProfitUsd < 0 ? '-' : ''}$${Math.abs(pricing.perCopyProfitUsd).toFixed(2)}`;

  const priceWarn = $('pricing-warning-banner');
  if (pricing.isBelowMinPrice) {
    priceWarn.hidden = false;
    priceWarn.innerHTML = `${ICONS.alert}<div>List price ($${pricing.listPriceUsd.toFixed(2)}) is below the minimum allowed KDP list price ($${pricing.minListPriceUsd.toFixed(2)}) required to cover printing cost at ${Math.round(pricing.royaltyRate * 100)}% royalty.</div>`;
  } else {
    priceWarn.hidden = true;
  }

  // Plain-English Metadata Sheet
  $('metadata-block-preview').textContent = buildPlainEnglishMetadataBlock({
    bookMeta,
    layout,
    listing,
    pageCount,
    spineConstants
  });
}

/* ==========================================================================
   Preflight Tab Rendering & Binary PDF Generation Pipelines
   ========================================================================== */

function renderPreflightUI() {
  const report = state.preflightReport;
  const banner = $('preflight-summary-banner');
  const listEl = $('preflight-list');

  if (!report) {
    banner.className = 'banner banner-warn';
    banner.innerHTML = `${ICONS.alert}<div>Generate both Interior and Cover PDFs, then tap "Inspect PDFs Now" to run binary preflight checks.</div>`;
    listEl.innerHTML = '';
    return;
  }

  const staleNotice =
    state.interiorDirty || state.coverDirty
      ? ' Note: Settings were edited since last PDF build — tap "Regenerate Both & Check" to inspect updated files.'
      : '';

  if (report.allPassed && !state.interiorDirty && !state.coverDirty) {
    banner.className = 'banner banner-pass';
    banner.innerHTML = `${ICONS.check}<div><strong>All ${report.passCount} of ${report.totalCount} KDP Preflight Rules Passed.</strong> Both generated PDFs passed binary MediaBox, embedded font stream, page-parity, and barcode-zone inspection.</div>`;
  } else {
    const onlyMin24Failed =
      report.totalCount - report.passCount === 1 &&
      report.checks.find((c) => c.id === 'minimum-24-pages')?.passed === false;
    banner.className = onlyMin24Failed ? 'banner banner-warn' : 'banner banner-fail';
    banner.innerHTML = `${ICONS.alert}<div><strong>${report.passCount} of ${report.totalCount} Preflight Checks Passed.</strong>${
      onlyMin24Failed
        ? ' Your 12-page demo passes every technical PDF check; KDP paperback binding requires at least 24 pages (use "Load 24-Page Sample" in Step 1 to verify 9/9 compliance).'
        : ''
    }${escapeHtml(staleNotice)}</div>`;
  }

  listEl.innerHTML = report.checks
    .map(
      (c) => `
      <li class="preflight-item">
        <span class="preflight-badge ${c.passed ? 'is-pass' : 'is-fail'}">${c.passed ? 'PASS' : 'FAIL'}</span>
        <div class="preflight-body">
          <p class="preflight-title">${escapeHtml(c.title)}</p>
          <p class="preflight-detail">${escapeHtml(c.detail)}</p>
        </div>
      </li>
    `
    )
    .join('');
}

async function buildInteriorAction() {
  return runCancellableTask(async (signal, onProgress) => {
    const res = await generateInteriorPdf({
      parsedManuscript: state.parsedManuscript,
      bookMeta: state.project.bookMeta,
      layout: state.project.layout,
      signal,
      onProgress
    });
    state.interiorPdfBytes = res.pdfBytes;
    state.paginatedBook = res.paginated;
    state.interiorDirty = false;
    state.interiorGeneratedAt = new Date();
    renderInteriorPdfTab();
    await refreshCoverPlanAndPreview();
    if (state.coverPdfBytes) {
      state.preflightReport = await runPreflightChecks({
        interiorPdfBytes: state.interiorPdfBytes,
        coverPdfBytes: state.coverPdfBytes,
        expectedPageCount: state.paginatedBook.pageCount,
        layout: state.project.layout,
        spineConstants: state.project.spineConstants,
        coverPlan: state.coverPlan
      });
      renderPreflightUI();
    }
    updateBottomBar();
    return res;
  });
}

async function buildCoverAction() {
  return runCancellableTask(async (signal, onProgress) => {
    const pageCount = getEffectivePageCount();
    const res = await generateCoverPdf({
      cover: state.project.cover,
      bookMeta: state.project.bookMeta,
      trimSize: state.project.layout.trimSize,
      pageCount,
      paperType: state.project.layout.paperType,
      spineConstants: state.project.spineConstants,
      signal,
      onProgress
    });
    state.coverPdfBytes = res.pdfBytes;
    state.coverPlan = res.plan;
    state.coverDirty = false;
    state.coverGeneratedAt = new Date();
    await refreshCoverPlanAndPreview();
    if (state.interiorPdfBytes) {
      state.preflightReport = await runPreflightChecks({
        interiorPdfBytes: state.interiorPdfBytes,
        coverPdfBytes: state.coverPdfBytes,
        expectedPageCount: pageCount,
        layout: state.project.layout,
        spineConstants: state.project.spineConstants,
        coverPlan: state.coverPlan
      });
      renderPreflightUI();
    }
    updateBottomBar();
    return res;
  });
}

async function buildBothPdfsAndInspectAction() {
  return runCancellableTask(async (signal, onProgress) => {
    const intRes = await generateInteriorPdf({
      parsedManuscript: state.parsedManuscript,
      bookMeta: state.project.bookMeta,
      layout: state.project.layout,
      signal,
      onProgress: (p) =>
        onProgress({
          percent: Math.round(p.percent * 0.65),
          label: `Interior: ${p.label}`
        })
    });
    state.interiorPdfBytes = intRes.pdfBytes;
    state.paginatedBook = intRes.paginated;
    state.interiorDirty = false;

    const covRes = await generateCoverPdf({
      cover: state.project.cover,
      bookMeta: state.project.bookMeta,
      trimSize: state.project.layout.trimSize,
      pageCount: intRes.pageCount,
      paperType: state.project.layout.paperType,
      spineConstants: state.project.spineConstants,
      signal,
      onProgress: (p) =>
        onProgress({
          percent: 65 + Math.round(p.percent * 0.27),
          label: `Cover: ${p.label}`
        })
    });
    state.coverPdfBytes = covRes.pdfBytes;
    state.coverPlan = covRes.plan;
    state.coverDirty = false;

    onProgress({ percent: 95, label: 'Inspecting binary PDF streams in Preflight...' });
    state.preflightReport = await runPreflightChecks({
      interiorPdfBytes: state.interiorPdfBytes,
      coverPdfBytes: state.coverPdfBytes,
      expectedPageCount: intRes.pageCount,
      layout: state.project.layout,
      spineConstants: state.project.spineConstants,
      coverPlan: state.coverPlan
    });

    onProgress({ percent: 100, label: 'Interior & Cover PDFs verified' });
    renderInteriorSpecTable();
    populatePreviewJumpSelect();
    drawActiveInteriorCanvas();
    renderInteriorPdfTab();
    await refreshCoverPlanAndPreview();
    refreshListingUI();
    renderPreflightUI();
    updateBottomBar();
    return true;
  });
}

/* ==========================================================================
   Step Wizard Navigation & Sticky Bottom Primary Action Bar
   ========================================================================== */

function setStep(stepIndex) {
  const clamped = Math.max(0, Math.min(5, Number(stepIndex) || 0));
  state.step = clamped;

  document.querySelectorAll('.step-tab').forEach((btn) => {
    const isSel = Number(btn.dataset.step) === clamped;
    btn.setAttribute('aria-selected', isSel ? 'true' : 'false');
  });

  const panelIds = [
    'panel-manuscript',
    'panel-layout',
    'panel-interior',
    'panel-cover',
    'panel-listing',
    'panel-preflight'
  ];
  panelIds.forEach((id, idx) => {
    $(id).classList.toggle('is-active', idx === clamped);
  });

  if (clamped === 1) drawActiveInteriorCanvas();
  if (clamped === 3) drawActiveCoverCanvas();
  if (clamped === 4) refreshListingUI();
  if (clamped === 5) renderPreflightUI();

  updateBottomBar();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updateBottomBar() {
  const prevBtn = $('btn-step-prev');
  const primaryBtn = $('btn-step-primary');

  prevBtn.disabled = state.step === 0;
  prevBtn.innerHTML = `${ICONS.chevronLeft}<span>Back</span>`;

  switch (state.step) {
    case 0:
      primaryBtn.innerHTML = `<span>Continue to Layout</span>${ICONS.chevronRight}`;
      break;
    case 1:
      primaryBtn.innerHTML = `<span>Generate Interior PDF</span>${ICONS.chevronRight}`;
      break;
    case 2:
      if (!state.interiorPdfBytes || state.interiorDirty) {
        primaryBtn.innerHTML = `${ICONS.pdf}<span>Generate Interior PDF</span>`;
      } else {
        primaryBtn.innerHTML = `<span>Continue to Cover</span>${ICONS.chevronRight}`;
      }
      break;
    case 3:
      if (!state.coverPdfBytes || state.coverDirty) {
        primaryBtn.innerHTML = `${ICONS.cover}<span>Generate Cover PDF</span>`;
      } else {
        primaryBtn.innerHTML = `<span>Continue to Listing</span>${ICONS.chevronRight}`;
      }
      break;
    case 4:
      primaryBtn.innerHTML = `<span>Continue to Preflight</span>${ICONS.chevronRight}`;
      break;
    case 5:
      primaryBtn.innerHTML = `${ICONS.preflight}<span>Verify Both PDFs</span>`;
      break;
  }
}

/* ==========================================================================
   Event Wiring
   ========================================================================== */

function bindEvents() {
  // Step tabs
  document.querySelectorAll('.step-tab').forEach((btn) => {
    btn.addEventListener('click', () => setStep(Number(btn.dataset.step)));
  });

  // Sticky bottom bar
  $('btn-step-prev').addEventListener('click', () => setStep(state.step - 1));
  $('btn-step-primary').addEventListener('click', async () => {
    if (state.step === 0) {
      setStep(1);
    } else if (state.step === 1) {
      setStep(2);
      if (!state.interiorPdfBytes || state.interiorDirty) {
        await buildInteriorAction();
      }
    } else if (state.step === 2) {
      if (!state.interiorPdfBytes || state.interiorDirty) {
        await buildInteriorAction();
      } else {
        setStep(3);
      }
    } else if (state.step === 3) {
      if (!state.coverPdfBytes || state.coverDirty) {
        await buildCoverAction();
      } else {
        setStep(4);
      }
    } else if (state.step === 4) {
      setStep(5);
    } else if (state.step === 5) {
      const done = await buildBothPdfsAndInspectAction();
      if (done) showToast('Preflight verification complete');
    }
  });

  // Cancel active long task
  $('btn-cancel-task').addEventListener('click', () => {
    if (state.activeAbortController) {
      state.activeAbortController.abort();
    }
  });

  // Confirmation modal buttons & Escape key
  $('btn-confirm-cancel').addEventListener('click', () => closeConfirmModal(false));
  $('btn-confirm-accept').addEventListener('click', () => closeConfirmModal(true));
  $('confirm-modal').addEventListener('click', (e) => {
    if (e.target === $('confirm-modal')) closeConfirmModal(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('confirm-modal').hidden) {
      closeConfirmModal(false);
    }
  });

  // Theme toggle
  $('btn-theme-toggle').addEventListener('click', () => {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark');
  });

  // Export Project JSON
  $('btn-export-json').addEventListener('click', () => {
    const slug = slugifyFilename(state.project.bookMeta.title);
    const json = serializeProjectJson(state.project);
    downloadBlob(json, `${slug}-kdp-project.json`, 'application/json');
    showToast('Project exported as .json');
  });

  // Import Project JSON (Destructive -> Confirms)
  $('input-import-json').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const rawText = await file.text();
      const imported = parseImportedProjectJson(rawText);
      const ok = await askConfirmation({
        title: 'Import Project File?',
        body: `Replace your current project with "${imported.bookMeta.title || file.name}"? Unexported changes in the current project will be overwritten.`,
        confirmLabel: 'Import Project'
      });
      if (!ok) return;
      state.project = imported;
      state.previewPageIndex = 0;
      state.interiorDirty = true;
      state.coverDirty = true;
      populateControlsFromProject();
      await loadCoverImageElement(state.project.cover.frontImageDataUrl);
      refreshManuscriptStatsUI();
      scheduleAutoSave();
      await buildBothPdfsAndInspectAction();
      showToast('Project imported and PDFs rebuilt');
    } catch (err) {
      showToast(err.message || 'Could not import JSON');
    }
  });

  // Reset to 12-Page Demo (Destructive -> Confirms)
  $('btn-reset-demo').addEventListener('click', async () => {
    const ok = await askConfirmation({
      title: 'Reset to 12-Page Demo Project?',
      body: 'This will replace your current manuscript, layout, cover, and listing settings with the original 12-page demo project.',
      confirmLabel: 'Reset Demo'
    });
    if (!ok) return;
    state.project = createDemoProject();
    state.previewPageIndex = 0;
    state.interiorDirty = true;
    state.coverDirty = true;
    populateControlsFromProject();
    await loadCoverImageElement(null);
    refreshManuscriptStatsUI();
    scheduleAutoSave();
    await buildBothPdfsAndInspectAction();
    showToast('Reset to 12-page demo project');
  });

  // Book Metadata synchronization (Step 1 <-> Step 5)
  const syncTitleSubtitle = (source) => {
    if (source === 'meta') {
      state.project.bookMeta.title = $('meta-title').value;
      state.project.bookMeta.subtitle = $('meta-subtitle').value;
      $('listing-title').value = state.project.bookMeta.title;
      $('listing-subtitle').value = state.project.bookMeta.subtitle;
    } else {
      state.project.bookMeta.title = $('listing-title').value;
      state.project.bookMeta.subtitle = $('listing-subtitle').value;
      $('meta-title').value = state.project.bookMeta.title;
      $('meta-subtitle').value = state.project.bookMeta.subtitle;
    }
    state.interiorDirty = true;
    state.coverDirty = true;
    scheduleAutoSave();
    schedulePaginationRefresh();
    updateBottomBar();
  };

  $('meta-title').addEventListener('input', () => syncTitleSubtitle('meta'));
  $('meta-subtitle').addEventListener('input', () => syncTitleSubtitle('meta'));
  $('listing-title').addEventListener('input', () => syncTitleSubtitle('listing'));
  $('listing-subtitle').addEventListener('input', () => syncTitleSubtitle('listing'));

  $('meta-author').addEventListener('input', (e) => {
    state.project.bookMeta.author = e.target.value;
    state.interiorDirty = true;
    state.coverDirty = true;
    scheduleAutoSave();
    schedulePaginationRefresh();
  });

  $('meta-isbn').addEventListener('input', (e) => {
    state.project.bookMeta.isbn = e.target.value;
    state.interiorDirty = true;
    scheduleAutoSave();
    schedulePaginationRefresh();
  });

  // Manuscript editor & Upload / Sample / Clear
  $('manuscript-textarea').addEventListener('input', (e) => {
    state.project.manuscriptText = e.target.value;
    state.interiorDirty = true;
    state.coverDirty = true;
    refreshManuscriptStatsUI();
    scheduleAutoSave();
    schedulePaginationRefresh();
    updateBottomBar();
  });

  $('input-manuscript-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const text = await file.text();
    if (state.project.manuscriptText.trim().length > 0) {
      const ok = await askConfirmation({
        title: 'Replace Current Manuscript?',
        body: `Load "${file.name}" into the manuscript editor? This replaces the current manuscript text.`,
        confirmLabel: 'Load File'
      });
      if (!ok) return;
    }
    state.project.manuscriptText = text;
    $('manuscript-textarea').value = text;
    state.previewPageIndex = 0;
    state.interiorDirty = true;
    state.coverDirty = true;
    refreshManuscriptStatsUI();
    scheduleAutoSave();
    await refreshPaginationAndPreview();
    showToast(`Loaded ${file.name}`);
  });

  $('btn-load-24p').addEventListener('click', async () => {
    const ok = await askConfirmation({
      title: 'Load 24-Page Full KDP Sample?',
      body: 'Replace the current manuscript text with a 10-chapter, 24-page sample that satisfies KDP’s 24-page print minimum?',
      confirmLabel: 'Load 24-Page Sample'
    });
    if (!ok) return;
    const sample = createFull28PageSampleText();
    state.project.manuscriptText = sample;
    $('manuscript-textarea').value = sample;
    state.previewPageIndex = 0;
    state.interiorDirty = true;
    state.coverDirty = true;
    refreshManuscriptStatsUI();
    scheduleAutoSave();
    await buildBothPdfsAndInspectAction();
    showToast('24-page KDP sample loaded and PDFs rebuilt');
  });

  $('btn-clear-ms').addEventListener('click', async () => {
    if (!state.project.manuscriptText.trim()) return;
    const ok = await askConfirmation({
      title: 'Clear Entire Manuscript?',
      body: 'This will remove all manuscript text from the editor. Export a .json backup first if you want to keep a copy.',
      confirmLabel: 'Clear Manuscript'
    });
    if (!ok) return;
    state.project.manuscriptText = '';
    $('manuscript-textarea').value = '';
    state.previewPageIndex = 0;
    state.interiorDirty = true;
    state.coverDirty = true;
    refreshManuscriptStatsUI();
    scheduleAutoSave();
    await refreshPaginationAndPreview();
    showToast('Manuscript cleared');
  });

  // Layout controls
  const onLayoutChange = () => {
    const l = state.project.layout;
    l.trimSize = $('layout-trim').value;
    l.paperType = $('layout-paper').value;
    l.fontId = $('layout-font').value;
    l.chapterStyle = $('layout-chapter-style').value;
    l.fontSizePt = Number($('layout-fontsize').value);
    l.leading = Number($('layout-leading').value);
    l.folioPosition = $('layout-folio').value;
    l.bleed = $('layout-bleed').checked;
    l.dropCaps = $('layout-dropcaps').checked;

    state.interiorDirty = true;
    state.coverDirty = true;
    scheduleAutoSave();
    schedulePaginationRefresh();
    updateBottomBar();
  };

  for (const id of [
    'layout-trim',
    'layout-paper',
    'layout-font',
    'layout-chapter-style',
    'layout-fontsize',
    'layout-leading',
    'layout-folio',
    'layout-bleed',
    'layout-dropcaps'
  ]) {
    $(id).addEventListener('change', onLayoutChange);
  }

  $('preview-guides-toggle').addEventListener('change', drawActiveInteriorCanvas);
  $('btn-prev-page').addEventListener('click', () => {
    if (state.previewPageIndex > 0) {
      state.previewPageIndex--;
      populatePreviewJumpSelect();
      drawActiveInteriorCanvas();
    }
  });
  $('btn-next-page').addEventListener('click', () => {
    if (state.paginatedBook && state.previewPageIndex < state.paginatedBook.pageCount - 1) {
      state.previewPageIndex++;
      populatePreviewJumpSelect();
      drawActiveInteriorCanvas();
    }
  });
  $('preview-jump-select').addEventListener('change', (e) => {
    state.previewPageIndex = Number(e.target.value) || 0;
    drawActiveInteriorCanvas();
  });

  // Interior PDF actions
  $('btn-regen-interior').addEventListener('click', async () => {
    const res = await buildInteriorAction();
    if (res) showToast(`Interior PDF generated (${res.pageCount} pages)`);
  });

  $('btn-download-interior').addEventListener('click', () => {
    if (!state.interiorPdfBytes) return;
    const slug = slugifyFilename(state.project.bookMeta.title);
    downloadBlob(state.interiorPdfBytes, `${slug}-interior-kdp.pdf`, 'application/pdf');
  });

  // Cover controls & actions
  const onCoverChange = async () => {
    const c = state.project.cover;
    c.templateId = $('cover-template').value;
    c.paletteId = $('cover-palette').value;
    c.fontId = $('cover-font').value;
    c.frontImageMode = $('cover-img-mode').value;
    c.backHeadline = $('cover-back-headline').value;
    c.backBlurb = $('cover-back-blurb').value;
    c.authorBio = $('cover-author-bio').value;

    const wVal = parseFloat($('const-spine-white').value);
    const cVal = parseFloat($('const-spine-cream').value);
    if (wVal > 0) state.project.spineConstants.spineWhitePaperIn = wVal;
    if (cVal > 0) state.project.spineConstants.spineCreamPaperIn = cVal;

    state.coverDirty = true;
    scheduleAutoSave();
    await refreshCoverPlanAndPreview();
    refreshListingUI();
    updateBottomBar();
  };

  for (const id of [
    'cover-template',
    'cover-palette',
    'cover-font',
    'cover-img-mode',
    'const-spine-white',
    'const-spine-cream'
  ]) {
    $(id).addEventListener('change', onCoverChange);
  }
  for (const id of ['cover-back-headline', 'cover-back-blurb', 'cover-author-bio']) {
    $(id).addEventListener('input', onCoverChange);
  }
  $('cover-guides-toggle').addEventListener('change', drawActiveCoverCanvas);

  $('input-cover-image').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const dataUrl = await normalizeUploadedImageFile(file);
      state.project.cover.frontImageDataUrl = dataUrl;
      state.project.cover.frontImageName = file.name;
      await loadCoverImageElement(dataUrl);
      $('btn-remove-cover-img').hidden = false;
      $('lbl-cover-img-text').textContent = 'Replace Front Image';
      state.coverDirty = true;
      scheduleAutoSave();
      await refreshCoverPlanAndPreview();
      updateBottomBar();
      showToast('Front cover image added');
    } catch (err) {
      showToast(err.message || 'Could not process image');
    }
  });

  $('btn-remove-cover-img').addEventListener('click', async () => {
    const ok = await askConfirmation({
      title: 'Remove Front Cover Artwork?',
      body: 'Remove the uploaded front-cover image and return to pure typographic cover layout?',
      confirmLabel: 'Remove Artwork'
    });
    if (!ok) return;
    state.project.cover.frontImageDataUrl = null;
    state.project.cover.frontImageName = '';
    state.coverImageElement = null;
    $('btn-remove-cover-img').hidden = true;
    $('lbl-cover-img-text').textContent = 'Upload Front Cover Image';
    state.coverDirty = true;
    scheduleAutoSave();
    await refreshCoverPlanAndPreview();
    updateBottomBar();
    showToast('Cover artwork removed');
  });

  $('btn-regen-cover').addEventListener('click', async () => {
    const res = await buildCoverAction();
    if (res) showToast('Wraparound Cover PDF generated');
  });

  $('btn-download-cover').addEventListener('click', () => {
    if (!state.coverPdfBytes) return;
    const slug = slugifyFilename(state.project.bookMeta.title);
    downloadBlob(state.coverPdfBytes, `${slug}-cover-kdp.pdf`, 'application/pdf');
  });

  $('btn-copy-cover-specs').addEventListener('click', () => {
    if (!state.coverPlan) return;
    copyTextToClipboard(formatCoverSpecsText(state.coverPlan.spec), 'Cover specs copied');
  });

  // Listing actions
  $('btn-apply-hook').addEventListener('click', () => {
    const chosenId = $('listing-hook-picker').value;
    state.project.listing.hookPatternId = chosenId;
    const hook = HOOK_PATTERNS.find((h) => h.id === chosenId) || HOOK_PATTERNS[0];
    const generatedSub = hook.buildSubtitle(state.project.bookMeta.title).slice(0, 120);
    state.project.bookMeta.subtitle = generatedSub;
    $('listing-subtitle').value = generatedSub;
    $('meta-subtitle').value = generatedSub;
    state.interiorDirty = true;
    state.coverDirty = true;
    scheduleAutoSave();
    schedulePaginationRefresh();
    showToast('Applied subtitle hook pattern');
  });

  $('btn-generate-desc').addEventListener('click', async () => {
    if (state.project.listing.description.trim().length > 40) {
      const ok = await askConfirmation({
        title: 'Regenerate Book Description?',
        body: 'Replace the current description text with a freshly structured draft built from your title and chapters?',
        confirmLabel: 'Replace Description'
      });
      if (!ok) return;
    }
    const trim = computeInteriorDimensions({
      trimSize: state.project.layout.trimSize
    }).trim;
    const desc = generateBookDescription({
      title: state.project.bookMeta.title,
      subtitle: state.project.bookMeta.subtitle,
      author: state.project.bookMeta.author,
      chapters: state.parsedManuscript?.chapters || [],
      trimLabel: trim.label
    });
    state.project.listing.description = desc;
    $('listing-description').value = desc;
    scheduleAutoSave();
    refreshListingUI();
    showToast('Generated structured KDP description');
  });

  $('listing-description').addEventListener('input', (e) => {
    state.project.listing.description = e.target.value;
    scheduleAutoSave();
    refreshListingUI();
  });

  $('btn-copy-desc-html').addEventListener('click', () => {
    const html = formatDescriptionAsKdpHtml(state.project.listing.description);
    copyTextToClipboard(html, 'Copied KDP-formatted HTML description');
  });

  for (let i = 0; i < 3; i++) {
    $(`listing-cat-${i + 1}`).addEventListener('change', (e) => {
      state.project.listing.categories[i] = e.target.value;
      scheduleAutoSave();
      refreshListingUI();
    });
  }

  document.querySelectorAll('[data-kw-index]').forEach((inp) => {
    inp.addEventListener('input', (e) => {
      const idx = Number(e.target.dataset.kwIndex);
      state.project.listing.keywords[idx] = e.target.value;
      scheduleAutoSave();
      refreshListingUI();
    });
  });

  $('btn-suggest-keywords').addEventListener('click', async () => {
    const hasExisting = state.project.listing.keywords.some((k) => k.trim().length > 0);
    if (hasExisting) {
      const ok = await askConfirmation({
        title: 'Replace 7 Keyword Slots?',
        body: 'Fill all 7 keyword slots with suggested phrases derived from your book title and chapters?',
        confirmLabel: 'Replace Keywords'
      });
      if (!ok) return;
    }
    const suggested = suggestKeywordsFromProject({
      title: state.project.bookMeta.title,
      subtitle: state.project.bookMeta.subtitle,
      chapters: state.parsedManuscript?.chapters || []
    });
    state.project.listing.keywords = suggested;
    suggested.forEach((val, idx) => {
      $(`kw-input-${idx}`).value = val;
    });
    scheduleAutoSave();
    refreshListingUI();
    showToast('Suggested 7 search keywords');
  });

  const onPriceChange = () => {
    const l = state.project.listing;
    const lp = parseFloat($('price-list-input').value);
    const fx = parseFloat($('price-fixed-input').value);
    const pp = parseFloat($('price-perpage-input').value);
    const rr = parseFloat($('price-royalty-input').value);

    if (!Number.isNaN(lp) && lp >= 0) l.listPriceUsd = lp;
    if (!Number.isNaN(fx) && fx >= 0) l.fixedCostUsd = fx;
    if (!Number.isNaN(pp) && pp >= 0) l.perPageCostUsd = pp;
    if (!Number.isNaN(rr) && rr > 0 && rr <= 100) l.royaltyRate = rr / 100;

    scheduleAutoSave();
    refreshListingUI();
  };

  for (const id of [
    'price-list-input',
    'price-fixed-input',
    'price-perpage-input',
    'price-royalty-input'
  ]) {
    $(id).addEventListener('input', onPriceChange);
  }

  $('btn-copy-metadata').addEventListener('click', () => {
    copyTextToClipboard(
      $('metadata-block-preview').textContent,
      'Metadata sheet copied to clipboard'
    );
  });

  // Preflight actions
  $('btn-rerun-preflight').addEventListener('click', async () => {
    if (!state.interiorPdfBytes || !state.coverPdfBytes) {
      await buildBothPdfsAndInspectAction();
      return;
    }
    state.preflightReport = await runPreflightChecks({
      interiorPdfBytes: state.interiorPdfBytes,
      coverPdfBytes: state.coverPdfBytes,
      expectedPageCount: getEffectivePageCount(),
      layout: state.project.layout,
      spineConstants: state.project.spineConstants,
      coverPlan: state.coverPlan
    });
    renderPreflightUI();
    showToast('Binary PDF inspection complete');
  });

  $('btn-regen-both-preflight').addEventListener('click', async () => {
    const ok = await buildBothPdfsAndInspectAction();
    if (ok) showToast('Rebuilt both PDFs and completed Preflight');
  });

  // Responsive redraw for 360px rotation / resize
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.step === 1) drawActiveInteriorCanvas();
      if (state.step === 3) drawActiveCoverCanvas();
    }, 120);
  });
}

/* ==========================================================================
   Offline Service Worker Registration & Boot Sequence
   ========================================================================== */

function registerOfflineServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (!window.location.protocol.startsWith('http')) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // Quietly ignore in restricted preview contexts
    });
  });
}

async function initApp() {
  applyTheme(loadSavedTheme());
  hydrateStaticIconsAndOptions();

  const { project, isFirstLoad } = loadProjectFromStorage();
  state.project = project;
  populateControlsFromProject();
  await loadCoverImageElement(state.project.cover.frontImageDataUrl);

  refreshManuscriptStatsUI();
  renderInteriorSpecTable();
  refreshListingUI();
  updateBottomBar();
  bindEvents();
  registerOfflineServiceWorker();

  if (isFirstLoad) {
    saveProjectToStorage(state.project);
  }

  // Generate real 12-page Interior PDF + Cover PDF + Preflight on load so
  // the entire studio can be verified and downloaded in under a minute.
  await buildBothPdfsAndInspectAction();
}

initApp();
