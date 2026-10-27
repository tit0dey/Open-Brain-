/**
 * KDP Studio — Wraparound Single-Page KDP Cover Engine (PDF + Live Canvas)
 *
 * Implements:
 * - Exact KDP wraparound dimensions: (0.125 + trimW + spineW + trimW + 0.125) x (trimH + 0.25)
 * - 3 built-in typographic templates: Meridian Classic, Horizon Band, Swiss Monograph
 * - Optional front-cover image upload (framed safe-zone art or full-bleed front panel)
 * - 0.25" safe-zone enforcement on all text and framed artwork
 * - Spine text guard (only rendered when pageCount >= 79 AND spine is wide enough)
 * - Clear 2.0" x 1.2" barcode reserve rectangle at bottom-right of back cover (>= 0.25" from trim)
 *   with live bounding-box overlap detection
 */

import { FONT_CATALOG } from './config.js';
import { computeCoverDimensions, rectsOverlap } from './layout-math.js';
import {
  loadPdfEngines,
  loadFontMetricsSuite,
  embedPdfFontSuite,
  yieldToMain
} from './pdf-loader.js';
import { wrapTextToLines } from './paginator.js';

export const COVER_TEMPLATES = {
  meridian: {
    id: 'meridian',
    label: 'Meridian Editorial',
    description: 'Literary framed composition with classic centered hierarchy'
  },
  horizon: {
    id: 'horizon',
    label: 'Horizon Band',
    description: 'High-contrast architectural band for modern non-fiction'
  },
  monograph: {
    id: 'monograph',
    label: 'Swiss Monograph',
    description: 'Asymmetric Swiss grid with bold flush-left display type'
  }
};

export const COVER_PALETTES = {
  midnight: {
    id: 'midnight',
    label: 'Midnight Slate & Gold',
    bgHex: '#151B26',
    secondaryHex: '#1F293A',
    textHex: '#F6F2EA',
    mutedHex: '#C5C0B4',
    accentHex: '#D49546'
  },
  ivory: {
    id: 'ivory',
    label: 'Archival Ivory & Ink',
    bgHex: '#F3ECE0',
    secondaryHex: '#E5DAC7',
    textHex: '#191C22',
    mutedHex: '#4A4E58',
    accentHex: '#9E472A'
  },
  forest: {
    id: 'forest',
    label: 'Deep Pine & Brass',
    bgHex: '#162822',
    secondaryHex: '#203830',
    textHex: '#F4F1E8',
    mutedHex: '#BFC8C2',
    accentHex: '#CFA054'
  },
  terracotta: {
    id: 'terracotta',
    label: 'Oxide & Warm Cream',
    bgHex: '#5C261E',
    secondaryHex: '#733228',
    textHex: '#FAF3EB',
    mutedHex: '#E2CFC2',
    accentHex: '#E5B168'
  }
};

export function hexToRgbUnit(hex) {
  const clean = String(hex || '#151B26').replace('#', '').trim();
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean.padEnd(6, '0').slice(0, 6);
  const num = parseInt(full, 16) || 0;
  return {
    r: ((num >> 16) & 255) / 255,
    g: ((num >> 8) & 255) / 255,
    b: (num & 255) / 255
  };
}

function dataUrlToBytes(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const header = dataUrl.slice(0, comma);
  const base64 = dataUrl.slice(comma + 1);
  const mime = (header.match(/data:([^;]+)/) || [])[1] || 'image/png';
  if (typeof atob === 'function') {
    const bin = atob(base64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return { mime, bytes: arr };
  }
  return { mime, bytes: new Uint8Array(Buffer.from(base64, 'base64')) };
}

/**
 * Format exact cover specifications in inches and 300 DPI pixels for copying.
 */
export function formatCoverSpecsText(spec) {
  return [
    'KDP STUDIO — FULL WRAPAROUND COVER SPECIFICATIONS',
    `Trim Size:          ${spec.trim.widthIn.toFixed(2)}" x ${spec.trim.heightIn.toFixed(2)}"`,
    `Interior Pages:     ${spec.pageCount} pages (${spec.paperType === 'cream' ? 'Cream' : 'White'} paper)`,
    `Bleed (all sides):  ${spec.bleedIn.toFixed(3)}"`,
    `Safe Margin:        ${spec.safeMarginIn.toFixed(3)}" inside trim edges`,
    `Spine Width:        ${spec.spineWidthIn.toFixed(4)}" (${spec.spineWidthPx} px @ ${spec.dpi} DPI)`,
    `Full Cover Size:    ${spec.fullWidthIn.toFixed(4)}" x ${spec.fullHeightIn.toFixed(4)}"`,
    `Full Cover Pixels:  ${spec.fullWidthPx} x ${spec.fullHeightPx} px @ ${spec.dpi} DPI`,
    `PDF MediaBox:       ${spec.fullWidthPt.toFixed(2)} x ${spec.fullHeightPt.toFixed(2)} pt`,
    `Spine Text Status:  ${spec.spineEligibility.allowed ? 'Enabled' : `Disabled (${spec.spineEligibility.reason})`}`,
    `Barcode Clear Box:  ${spec.barcodeZoneIn.width.toFixed(1)}" x ${spec.barcodeZoneIn.height.toFixed(1)}" at back bottom-right (>= ${spec.safeMarginIn.toFixed(2)}" from trim)`
  ].join('\n');
}

/**
 * Build deterministic vector + text layout plan for single-page wraparound cover.
 * Used identically by live <canvas> preview, PDF generation, and overlap checks.
 */
export async function buildCoverLayoutPlan({
  cover = {},
  bookMeta = {},
  trimSize = '6x9',
  pageCount = 12,
  paperType = 'white',
  spineConstants = {}
}) {
  const fontId = cover.fontId || 'eb-garamond';
  const metrics = await loadFontMetricsSuite(fontId);

  const spec = computeCoverDimensions({
    trimSize,
    pageCount,
    paperType,
    spineWhitePaperIn: spineConstants.spineWhitePaperIn,
    spineCreamPaperIn: spineConstants.spineCreamPaperIn
  });

  const paletteBase = COVER_PALETTES[cover.paletteId] || COVER_PALETTES.midnight;
  const colors = {
    bgHex: cover.customBgHex || paletteBase.bgHex,
    secondaryHex: paletteBase.secondaryHex,
    textHex: cover.customTextHex || paletteBase.textHex,
    mutedHex: paletteBase.mutedHex,
    accentHex: cover.customAccentHex || paletteBase.accentHex
  };

  const templateId = COVER_TEMPLATES[cover.templateId] ? cover.templateId : 'meridian';
  const title = (bookMeta.title || 'Untitled Book').trim();
  const subtitle = (bookMeta.subtitle || '').trim();
  const author = (bookMeta.author || 'Independent Author').trim();
  const backHeadline = (cover.backHeadline || '').trim();
  const backBlurb = (cover.backBlurb || '').trim();
  const authorBio = (cover.authorBio || '').trim();

  const shapes = [];
  const textItems = [];
  let imagePlacement = null;
  let spineItem = null;

  // Full-cover bleed background
  shapes.push({
    kind: 'rect',
    isBackground: true,
    xPt: 0,
    yPt: 0,
    widthPt: spec.fullWidthPt,
    heightPt: spec.fullHeightPt,
    fillHex: colors.bgHex
  });

  // Subtle spine panel tint
  if (spec.spineWidthPt > 2) {
    shapes.push({
      kind: 'rect',
      isBackground: true,
      xPt: spec.panelsPt.spine.x,
      yPt: 0,
      widthPt: spec.panelsPt.spine.width,
      heightPt: spec.fullHeightPt,
      fillHex: colors.secondaryHex
    });
  }

  const frontSafe = spec.safeZonesPt.front;
  const backSafe = spec.safeZonesPt.back;
  const barcodePt = spec.barcodeZonePt;
  const hasFrontImage = Boolean(cover.frontImageDataUrl);
  const imageMode = cover.frontImageMode === 'bleed' ? 'bleed' : 'framed';

  // --- FRONT COVER COMPOSITION ---
  if (hasFrontImage && imageMode === 'bleed') {
    // Full-bleed front cover panel (from spine right edge to right bleed edge)
    imagePlacement = {
      mode: 'bleed',
      xPt: spec.panelsPt.front.x,
      yPt: 0,
      widthPt: spec.fullWidthPt - spec.panelsPt.front.x,
      heightPt: spec.fullHeightPt
    };
    // Safe-zone contrast plate behind title
    shapes.push({
      kind: 'rect',
      xPt: frontSafe.x,
      yPt: frontSafe.y + 18,
      widthPt: frontSafe.width,
      heightPt: frontSafe.height * 0.42,
      fillHex: colors.bgHex,
      opacity: 0.9
    });
  }

  if (templateId === 'meridian') {
    // Classic editorial inset frame strictly inside 0.25" safe zone
    const pad = 8;
    shapes.push({
      kind: 'stroke-rect',
      xPt: frontSafe.x + pad,
      yPt: frontSafe.y + pad,
      widthPt: frontSafe.width - pad * 2,
      heightPt: frontSafe.height - pad * 2,
      strokeHex: colors.accentHex,
      lineWidthPt: 1.1
    });
    shapes.push({
      kind: 'stroke-rect',
      xPt: frontSafe.x + pad + 4,
      yPt: frontSafe.y + pad + 4,
      widthPt: frontSafe.width - (pad + 4) * 2,
      heightPt: frontSafe.height - (pad + 4) * 2,
      strokeHex: colors.accentHex,
      lineWidthPt: 0.45
    });

    const innerX = frontSafe.x + 26;
    const innerW = frontSafe.width - 52;

    // Author at top
    const authorSize = 11.5;
    textItems.push({
      panel: 'front',
      text: author.toUpperCase(),
      xPt: innerX,
      yPt: frontSafe.top - 42,
      maxWidthPt: innerW,
      sizePt: authorSize,
      style: 'regular',
      align: 'center',
      colorHex: colors.mutedHex
    });

    if (hasFrontImage && imageMode === 'framed') {
      const imgH = frontSafe.height * 0.34;
      imagePlacement = {
        mode: 'framed',
        xPt: innerX + 12,
        yPt: frontSafe.top - 64 - imgH,
        widthPt: innerW - 24,
        heightPt: imgH
      };
    }

    const titleStartTop =
      hasFrontImage && imageMode === 'framed'
        ? frontSafe.y + frontSafe.height * 0.43
        : hasFrontImage && imageMode === 'bleed'
          ? frontSafe.y + frontSafe.height * 0.38
          : frontSafe.top - frontSafe.height * 0.28;

    const titleSize = Math.min(30, Math.max(20, Math.round(frontSafe.width / 13.2)));
    const titleLines = wrapTextToLines(title, metrics, titleSize, 'bold', () => ({
      offsetXPt: 0,
      maxWidthPt: innerW
    })).slice(0, 4);

    let cy = titleStartTop;
    for (const tl of titleLines) {
      textItems.push({
        panel: 'front',
        text: tl.text,
        xPt: innerX,
        yPt: cy,
        maxWidthPt: innerW,
        sizePt: titleSize,
        style: 'bold',
        align: 'center',
        colorHex: colors.textHex
      });
      cy -= titleSize * 1.2;
    }

    cy -= 4;
    shapes.push({
      kind: 'line',
      x1Pt: innerX + innerW * 0.32,
      y1Pt: cy,
      x2Pt: innerX + innerW * 0.68,
      y2Pt: cy,
      strokeHex: colors.accentHex,
      lineWidthPt: 1.2
    });
    cy -= 20;

    if (subtitle) {
      const subSize = 12.5;
      const subLines = wrapTextToLines(subtitle, metrics, subSize, 'italic', () => ({
        offsetXPt: 0,
        maxWidthPt: innerW * 0.92
      })).slice(0, 3);
      for (const sl of subLines) {
        if (cy < frontSafe.y + 24) break;
        textItems.push({
          panel: 'front',
          text: sl.text,
          xPt: innerX,
          yPt: cy,
          maxWidthPt: innerW,
          sizePt: subSize,
          style: 'italic',
          align: 'center',
          colorHex: colors.mutedHex
        });
        cy -= subSize * 1.35;
      }
    }
  } else if (templateId === 'horizon') {
    // Architectural color band across middle/lower third
    if (!(hasFrontImage && imageMode === 'bleed')) {
      shapes.push({
        kind: 'rect',
        isBackground: true,
        xPt: spec.panelsPt.front.x,
        yPt: frontSafe.y + frontSafe.height * 0.24,
        widthPt: spec.fullWidthPt - spec.panelsPt.front.x,
        heightPt: frontSafe.height * 0.34,
        fillHex: colors.secondaryHex
      });
      shapes.push({
        kind: 'rect',
        xPt: frontSafe.x,
        yPt: frontSafe.y + frontSafe.height * 0.58,
        widthPt: frontSafe.width,
        heightPt: 3,
        fillHex: colors.accentHex
      });
    }

    const innerX = frontSafe.x + 16;
    const innerW = frontSafe.width - 32;

    if (hasFrontImage && imageMode === 'framed') {
      const imgH = frontSafe.height * 0.3;
      imagePlacement = {
        mode: 'framed',
        xPt: innerX,
        yPt: frontSafe.top - 16 - imgH,
        widthPt: innerW,
        heightPt: imgH
      };
    }

    const titleSize = Math.min(28, Math.max(19, Math.round(frontSafe.width / 13.8)));
    const titleLines = wrapTextToLines(title.toUpperCase(), metrics, titleSize, 'bold', () => ({
      offsetXPt: 0,
      maxWidthPt: innerW
    })).slice(0, 4);

    let cy =
      hasFrontImage && imageMode === 'bleed'
        ? frontSafe.y + frontSafe.height * 0.38
        : frontSafe.y + frontSafe.height * 0.52;

    for (const tl of titleLines) {
      textItems.push({
        panel: 'front',
        text: tl.text,
        xPt: innerX,
        yPt: cy,
        maxWidthPt: innerW,
        sizePt: titleSize,
        style: 'bold',
        align: 'center',
        colorHex: colors.textHex
      });
      cy -= titleSize * 1.18;
    }

    if (subtitle) {
      cy -= 6;
      const subSize = 12;
      const subLines = wrapTextToLines(subtitle, metrics, subSize, 'regular', () => ({
        offsetXPt: 0,
        maxWidthPt: innerW
      })).slice(0, 3);
      for (const sl of subLines) {
        if (cy < frontSafe.y + 44) break;
        textItems.push({
          panel: 'front',
          text: sl.text,
          xPt: innerX,
          yPt: cy,
          maxWidthPt: innerW,
          sizePt: subSize,
          style: 'regular',
          align: 'center',
          colorHex: colors.accentHex
        });
        cy -= subSize * 1.32;
      }
    }

    textItems.push({
      panel: 'front',
      text: author,
      xPt: innerX,
      yPt: frontSafe.y + 20,
      maxWidthPt: innerW,
      sizePt: 13,
      style: 'bold',
      align: 'center',
      colorHex: colors.textHex
    });
  } else {
    // 'monograph': Swiss asymmetric grid with vertical accent bar
    const barX = frontSafe.x + 10;
    shapes.push({
      kind: 'rect',
      xPt: barX,
      yPt: frontSafe.y + 14,
      widthPt: 4,
      heightPt: frontSafe.height - 28,
      fillHex: colors.accentHex
    });

    const innerX = barX + 20;
    const innerW = frontSafe.right - innerX - 10;

    let cy =
      hasFrontImage && imageMode === 'bleed'
        ? frontSafe.y + frontSafe.height * 0.4
        : frontSafe.top - 38;

    const titleSize = Math.min(29, Math.max(19, Math.round(innerW / 12.5)));
    const titleLines = wrapTextToLines(title, metrics, titleSize, 'bold', () => ({
      offsetXPt: 0,
      maxWidthPt: innerW
    })).slice(0, 4);

    for (const tl of titleLines) {
      textItems.push({
        panel: 'front',
        text: tl.text,
        xPt: innerX,
        yPt: cy,
        maxWidthPt: innerW,
        sizePt: titleSize,
        style: 'bold',
        align: 'left',
        colorHex: colors.textHex
      });
      cy -= titleSize * 1.18;
    }

    if (subtitle) {
      cy -= 8;
      const subSize = 12;
      const subLines = wrapTextToLines(subtitle, metrics, subSize, 'regular', () => ({
        offsetXPt: 0,
        maxWidthPt: innerW
      })).slice(0, 3);
      for (const sl of subLines) {
        textItems.push({
          panel: 'front',
          text: sl.text,
          xPt: innerX,
          yPt: cy,
          maxWidthPt: innerW,
          sizePt: subSize,
          style: 'regular',
          align: 'left',
          colorHex: colors.mutedHex
        });
        cy -= subSize * 1.35;
      }
    }

    if (hasFrontImage && imageMode === 'framed') {
      const availTop = cy - 16;
      const availBottom = frontSafe.y + 52;
      if (availTop - availBottom >= 80) {
        imagePlacement = {
          mode: 'framed',
          xPt: innerX,
          yPt: availBottom,
          widthPt: innerW,
          heightPt: availTop - availBottom
        };
      }
    }

    textItems.push({
      panel: 'front',
      text: author.toUpperCase(),
      xPt: innerX,
      yPt: frontSafe.y + 18,
      maxWidthPt: innerW,
      sizePt: 11.5,
      style: 'bold',
      align: 'left',
      colorHex: colors.accentHex
    });
  }

  // --- SPINE TEXT (Strictly when pageCount >= 79 AND spine is wide enough) ---
  if (spec.spineEligibility.allowed && cover.enableSpineText !== false) {
    const spineFontPt = spec.spineEligibility.recommendedFontPt;
    const spineLabel = `${title}   —   ${author}`;
    const maxLenPt = spec.panelsPt.spine.height - spec.safeMarginIn * 72 * 2 - 24;
    let displaySpine = spineLabel;
    while (
      displaySpine.length > 4 &&
      metrics.measureText(displaySpine, spineFontPt, 'bold') > maxLenPt
    ) {
      displaySpine = displaySpine.slice(0, -2).trimEnd();
    }
    const textLenPt = metrics.measureText(displaySpine, spineFontPt, 'bold');
    const spineCenterXPt = spec.panelsPt.spine.x + spec.panelsPt.spine.width / 2;
    const startTopYPt =
      spec.panelsPt.spine.y + (spec.panelsPt.spine.height + textLenPt) / 2;

    spineItem = {
      text: displaySpine,
      sizePt: spineFontPt,
      style: 'bold',
      colorHex: colors.textHex,
      // Rotated -90deg (top-to-bottom standard US book spine orientation)
      xPt: spineCenterXPt - spineFontPt * 0.34,
      yPt: startTopYPt,
      centerXPt: spineCenterXPt,
      centerYPt: spec.panelsPt.spine.y + spec.panelsPt.spine.height / 2
    };
  }

  // --- BACK COVER BLURB & AUTHOR BIO (Keeping Clear of 2" x 1.2" Barcode Zone) ---
  const backInnerX = backSafe.x + 12;
  const backInnerW = backSafe.width - 24;
  let backCursorY = backSafe.top - 32;

  // Floor above barcode zone (unless user deliberately disables auto-guard)
  const safeBarcodeCeilingPt =
    cover.allowBarcodeOverlap === true ? backSafe.y + 10 : barcodePt.top + 18;

  if (backHeadline) {
    const headSize = 13.5;
    const headLines = wrapTextToLines(backHeadline, metrics, headSize, 'bold', () => ({
      offsetXPt: 0,
      maxWidthPt: backInnerW
    })).slice(0, 3);
    for (const hl of headLines) {
      textItems.push({
        panel: 'back',
        text: hl.text,
        xPt: backInnerX,
        yPt: backCursorY,
        maxWidthPt: backInnerW,
        sizePt: headSize,
        style: 'bold',
        align: 'left',
        colorHex: colors.accentHex
      });
      backCursorY -= headSize * 1.34;
    }
    backCursorY -= 8;
  }

  let blurbTruncatedForBarcode = false;
  if (backBlurb) {
    const bodySize = Number(cover.backFontSizePt) || 10.5;
    const bodyLead = bodySize * 1.44;
    const paragraphs = backBlurb
      .split(/\n\s*\n|\n/)
      .map((p) => p.trim())
      .filter(Boolean);

    for (const para of paragraphs) {
      const pLines = wrapTextToLines(para, metrics, bodySize, 'regular', () => ({
        offsetXPt: 0,
        maxWidthPt: backInnerW
      }));
      for (const pl of pLines) {
        if (backCursorY - bodySize * 0.3 < safeBarcodeCeilingPt) {
          blurbTruncatedForBarcode = true;
          break;
        }
        textItems.push({
          panel: 'back',
          text: pl.text,
          xPt: backInnerX,
          yPt: backCursorY,
          maxWidthPt: backInnerW,
          sizePt: bodySize,
          style: 'regular',
          align: 'left',
          colorHex: colors.textHex
        });
        backCursorY -= bodyLead;
      }
      if (blurbTruncatedForBarcode) break;
      backCursorY -= bodyLead * 0.45;
    }
  }

  if (authorBio && !blurbTruncatedForBarcode && backCursorY - 40 >= safeBarcodeCeilingPt) {
    backCursorY -= 6;
    shapes.push({
      kind: 'line',
      x1Pt: backInnerX,
      y1Pt: backCursorY + 6,
      x2Pt: backInnerX + 54,
      y2Pt: backCursorY + 6,
      strokeHex: colors.accentHex,
      lineWidthPt: 0.9
    });
    backCursorY -= 10;

    const bioSize = 9.5;
    const bioLead = bioSize * 1.38;
    const bioLines = wrapTextToLines(authorBio, metrics, bioSize, 'italic', () => ({
      offsetXPt: 0,
      maxWidthPt: backInnerW
    }));
    for (const bl of bioLines) {
      if (backCursorY - bioSize * 0.3 < safeBarcodeCeilingPt) {
        blurbTruncatedForBarcode = true;
        break;
      }
      textItems.push({
        panel: 'back',
        text: bl.text,
        xPt: backInnerX,
        yPt: backCursorY,
        maxWidthPt: backInnerW,
        sizePt: bioSize,
        style: 'italic',
        align: 'left',
        colorHex: colors.mutedHex
      });
      backCursorY -= bioLead;
    }
  }

  // Compute exact bounding boxes for all foreground elements & check barcode overlap
  const barcodeOverlaps = [];
  for (const item of textItems) {
    const w = Math.min(item.maxWidthPt, metrics.measureText(item.text, item.sizePt, item.style));
    let actualX = item.xPt;
    if (item.align === 'center') actualX = item.xPt + (item.maxWidthPt - w) / 2;
    else if (item.align === 'right') actualX = item.xPt + (item.maxWidthPt - w);

    const boundsPt = {
      x: actualX,
      y: item.yPt - item.sizePt * 0.25,
      width: w,
      height: item.sizePt * 1.15
    };
    item.boundsPt = boundsPt;
    if (rectsOverlap(boundsPt, barcodePt, 0.5)) {
      barcodeOverlaps.push({ kind: 'text', text: item.text, boundsPt });
    }
  }

  for (const sh of shapes) {
    if (sh.isBackground) continue;
    let boundsPt = null;
    if (sh.kind === 'rect' || sh.kind === 'stroke-rect') {
      boundsPt = { x: sh.xPt, y: sh.yPt, width: sh.widthPt, height: sh.heightPt };
    } else if (sh.kind === 'line') {
      boundsPt = {
        x: Math.min(sh.x1Pt, sh.x2Pt),
        y: Math.min(sh.y1Pt, sh.y2Pt) - 1,
        width: Math.max(2, Math.abs(sh.x2Pt - sh.x1Pt)),
        height: Math.max(2, Math.abs(sh.y2Pt - sh.y1Pt) + 2)
      };
    }
    if (boundsPt && rectsOverlap(boundsPt, barcodePt, 0.5)) {
      barcodeOverlaps.push({ kind: sh.kind, boundsPt });
    }
  }

  if (imagePlacement && rectsOverlap(imagePlacement, barcodePt, 0.5)) {
    barcodeOverlaps.push({ kind: 'image', boundsPt: imagePlacement });
  }

  return {
    spec,
    fontId,
    templateId,
    colors,
    shapes,
    textItems,
    spineItem,
    imagePlacement,
    frontImageDataUrl: cover.frontImageDataUrl || null,
    barcodeOverlaps,
    blurbTruncatedForBarcode
  };
}

/**
 * Generate a single-page print-ready wraparound KDP Cover PDF.
 */
export async function generateCoverPdf({
  cover = {},
  bookMeta = {},
  trimSize = '6x9',
  pageCount = 12,
  paperType = 'white',
  spineConstants = {},
  signal,
  onProgress
}) {
  const report = (percent, label) => {
    if (typeof onProgress === 'function') onProgress({ percent, label });
  };

  report(10, 'Computing KDP full-wrap cover and spine geometry...');
  const { PDFLib } = await loadPdfEngines();
  await yieldToMain(signal);

  const plan = await buildCoverLayoutPlan({
    cover,
    bookMeta,
    trimSize,
    pageCount,
    paperType,
    spineConstants
  });
  await yieldToMain(signal);

  const { spec } = plan;
  const pdfDoc = await PDFLib.PDFDocument.create();
  pdfDoc.setTitle(`${(bookMeta.title || 'Untitled Book').trim()} — Full Cover`);
  pdfDoc.setAuthor((bookMeta.author || 'Independent Author').trim());
  pdfDoc.setCreator('KDP Studio (Offline Cover Engine)');
  pdfDoc.setProducer('KDP Studio via pdf-lib');

  report(35, 'Embedding subsetted cover fonts...');
  const fontSuite = await embedPdfFontSuite(pdfDoc, plan.fontId);
  await yieldToMain(signal);

  const page = pdfDoc.addPage([spec.fullWidthPt, spec.fullHeightPt]);
  const toPdfColor = (hex) => {
    const c = hexToRgbUnit(hex);
    return PDFLib.rgb(c.r, c.g, c.b);
  };

  // 1. Background rectangles
  for (const sh of plan.shapes.filter((s) => s.isBackground)) {
    page.drawRectangle({
      x: sh.xPt,
      y: sh.yPt,
      width: sh.widthPt,
      height: sh.heightPt,
      color: toPdfColor(sh.fillHex)
    });
  }

  // 2. Optional Front-Cover Image (embedded before foreground overlays/text)
  if (plan.imagePlacement && plan.frontImageDataUrl) {
    report(55, 'Embedding front-cover artwork...');
    const { mime, bytes } = dataUrlToBytes(plan.frontImageDataUrl);
    const embeddedImg = mime.includes('png')
      ? await pdfDoc.embedPng(bytes)
      : await pdfDoc.embedJpg(bytes);

    // Aspect-fill inside target placement box (clamped inside front panel)
    const box = plan.imagePlacement;
    const imgDims = embeddedImg.scale(1);
    const scale = Math.min(box.widthPt / imgDims.width, box.heightPt / imgDims.height);
    const drawW = box.mode === 'bleed' ? box.widthPt : imgDims.width * scale;
    const drawH = box.mode === 'bleed' ? box.heightPt : imgDims.height * scale;
    const drawX = box.xPt + (box.widthPt - drawW) / 2;
    const drawY = box.yPt + (box.heightPt - drawH) / 2;

    page.drawImage(embeddedImg, {
      x: drawX,
      y: drawY,
      width: drawW,
      height: drawH
    });
    await yieldToMain(signal);
  }

  // 3. Foreground decorative shapes (frames, accent bars, rules)
  report(70, 'Drawing typographic template layers...');
  for (const sh of plan.shapes.filter((s) => !s.isBackground)) {
    if (sh.kind === 'rect') {
      page.drawRectangle({
        x: sh.xPt,
        y: sh.yPt,
        width: sh.widthPt,
        height: sh.heightPt,
        color: toPdfColor(sh.fillHex),
        opacity: sh.opacity ?? 1
      });
    } else if (sh.kind === 'stroke-rect') {
      page.drawRectangle({
        x: sh.xPt,
        y: sh.yPt,
        width: sh.widthPt,
        height: sh.heightPt,
        borderColor: toPdfColor(sh.strokeHex),
        borderWidth: sh.lineWidthPt || 1
      });
    } else if (sh.kind === 'line') {
      page.drawLine({
        start: { x: sh.x1Pt, y: sh.y1Pt },
        end: { x: sh.x2Pt, y: sh.y2Pt },
        thickness: sh.lineWidthPt || 1,
        color: toPdfColor(sh.strokeHex)
      });
    }
  }

  // 4. Front & Back Cover Typography
  for (const item of plan.textItems) {
    await fontSuite.drawSegmentedLine(page, item.text, {
      x: item.xPt,
      y: item.yPt,
      size: item.sizePt,
      style: item.style,
      color: toPdfColor(item.colorHex),
      align: item.align,
      maxWidth: item.maxWidthPt
    });
  }

  // 5. Spine Text (only when eligible)
  if (plan.spineItem) {
    await fontSuite.drawSegmentedLine(page, plan.spineItem.text, {
      x: plan.spineItem.xPt,
      y: plan.spineItem.yPt,
      size: plan.spineItem.sizePt,
      style: 'bold',
      color: toPdfColor(plan.spineItem.colorHex),
      rotate: PDFLib.degrees(-90)
    });
  }

  await yieldToMain(signal);
  report(92, 'Saving KDP single-page cover PDF...');
  const pdfBytes = await pdfDoc.save({ useObjectStreams: false });
  report(100, 'Cover PDF ready');

  return {
    pdfBytes,
    plan,
    spec
  };
}

/**
 * Render the wraparound cover plan onto an HTML5 <canvas> with optional KDP
 * bleed, spine hinge, 0.25" safe-zone, and 2"x1.2" barcode reserve guides.
 */
export function renderCoverPlanToCanvas(canvas, plan, options = {}) {
  if (!canvas || !plan) return;
  const { spec, colors } = plan;

  const cssWidth = Math.max(280, Math.min(options.maxCssWidth || 640, 820));
  const aspect = spec.fullHeightPt / spec.fullWidthPt;
  const cssHeight = Math.round(cssWidth * aspect);
  const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2.5) : 1;

  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;

  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.scale(dpr, dpr);

  const scale = cssWidth / spec.fullWidthPt;
  const toX = (pt) => pt * scale;
  const toY = (pdfYPt) => (spec.fullHeightPt - pdfYPt) * scale;

  // Background shapes
  for (const sh of plan.shapes.filter((s) => s.isBackground)) {
    ctx.fillStyle = sh.fillHex;
    ctx.fillRect(toX(sh.xPt), toY(sh.yPt + sh.heightPt), sh.widthPt * scale, sh.heightPt * scale);
  }

  // Optional cached HTMLImageElement for uploaded front artwork
  if (plan.imagePlacement && options.loadedImageElement) {
    const box = plan.imagePlacement;
    const img = options.loadedImageElement;
    const s = Math.min(box.widthPt / img.naturalWidth, box.heightPt / img.naturalHeight);
    const dw = box.mode === 'bleed' ? box.widthPt : img.naturalWidth * s;
    const dh = box.mode === 'bleed' ? box.heightPt : img.naturalHeight * s;
    const dx = box.xPt + (box.widthPt - dw) / 2;
    const dy = box.yPt + (box.heightPt - dh) / 2;
    ctx.drawImage(img, toX(dx), toY(dy + dh), dw * scale, dh * scale);
  }

  // Foreground shapes
  for (const sh of plan.shapes.filter((s) => !s.isBackground)) {
    ctx.save();
    if (sh.opacity !== undefined) ctx.globalAlpha = sh.opacity;
    if (sh.kind === 'rect') {
      ctx.fillStyle = sh.fillHex;
      ctx.fillRect(
        toX(sh.xPt),
        toY(sh.yPt + sh.heightPt),
        sh.widthPt * scale,
        sh.heightPt * scale
      );
    } else if (sh.kind === 'stroke-rect') {
      ctx.strokeStyle = sh.strokeHex;
      ctx.lineWidth = Math.max(0.8, (sh.lineWidthPt || 1) * scale);
      ctx.strokeRect(
        toX(sh.xPt),
        toY(sh.yPt + sh.heightPt),
        sh.widthPt * scale,
        sh.heightPt * scale
      );
    } else if (sh.kind === 'line') {
      ctx.strokeStyle = sh.strokeHex;
      ctx.lineWidth = Math.max(0.8, (sh.lineWidthPt || 1) * scale);
      ctx.beginPath();
      ctx.moveTo(toX(sh.x1Pt), toY(sh.y1Pt));
      ctx.lineTo(toX(sh.x2Pt), toY(sh.y2Pt));
      ctx.stroke();
    }
    ctx.restore();
  }

  // Text items
  const fontEntry = FONT_CATALOG[plan.fontId] || FONT_CATALOG['eb-garamond'];
  const cssFamily = fontEntry.cssFamily;

  for (const item of plan.textItems) {
    const px = item.sizePt * scale;
    const weight = item.style === 'bold' ? '700' : '400';
    const fStyle = item.style === 'italic' ? 'italic' : 'normal';
    ctx.font = `${fStyle} ${weight} ${px.toFixed(2)}px ${cssFamily}`;
    ctx.fillStyle = item.colorHex;
    ctx.textBaseline = 'alphabetic';

    const maxW = item.maxWidthPt * scale;
    const measured = ctx.measureText(item.text).width;
    let drawX = toX(item.xPt);
    if (item.align === 'center') drawX += (maxW - measured) / 2;
    else if (item.align === 'right') drawX += maxW - measured;
    ctx.fillText(item.text, drawX, toY(item.yPt));
  }

  // Spine text
  if (plan.spineItem) {
    ctx.save();
    const px = plan.spineItem.sizePt * scale;
    ctx.font = `700 ${px.toFixed(2)}px ${cssFamily}`;
    ctx.fillStyle = plan.spineItem.colorHex;
    ctx.translate(toX(plan.spineItem.centerXPt), toY(plan.spineItem.centerYPt));
    ctx.rotate(Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(plan.spineItem.text, 0, 0);
    ctx.restore();
  }

  // Guides: Trim Box, Spine Fold Lines, 0.25" Safe Zones, and 2"x1.2" Barcode Reserve Box
  const bz = spec.barcodeZonePt;
  const bx = toX(bz.x);
  const by = toY(bz.y + bz.height);
  const bw = bz.width * scale;
  const bh = bz.height * scale;

  if (options.showGuides !== false) {
    ctx.save();
    // Trim boundary inside 0.125" bleed
    const bleedPx = spec.bleedIn * 72 * scale;
    ctx.strokeStyle = 'rgba(232, 92, 65, 0.72)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(
      bleedPx,
      bleedPx,
      cssWidth - bleedPx * 2,
      cssHeight - bleedPx * 2
    );

    // Spine fold lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.42)';
    ctx.beginPath();
    ctx.moveTo(toX(spec.panelsPt.spine.x), 0);
    ctx.lineTo(toX(spec.panelsPt.spine.x), cssHeight);
    ctx.moveTo(toX(spec.panelsPt.spine.right), 0);
    ctx.lineTo(toX(spec.panelsPt.spine.right), cssHeight);
    ctx.stroke();

    // Front & Back 0.25" safe zones
    ctx.strokeStyle = 'rgba(92, 168, 255, 0.45)';
    ctx.setLineDash([2, 3]);
    for (const sz of [spec.safeZonesPt.back, spec.safeZonesPt.front]) {
      ctx.strokeRect(toX(sz.x), toY(sz.y + sz.height), sz.width * scale, sz.height * scale);
    }

    // Barcode clear zone preview badge (preview-only guide; left clear in actual print PDF)
    const hasOverlap = plan.barcodeOverlaps.length > 0;
    ctx.setLineDash([]);
    ctx.fillStyle = hasOverlap ? 'rgba(220, 53, 69, 0.24)' : 'rgba(255, 255, 255, 0.90)';
    ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = hasOverlap ? '#DC3545' : '#334155';
    ctx.lineWidth = hasOverlap ? 1.8 : 1;
    ctx.strokeRect(bx, by, bw, bh);

    ctx.fillStyle = hasOverlap ? '#9B1C28' : '#1E293B';
    ctx.font = `600 ${Math.max(8, 7.5 * scale).toFixed(1)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('KDP BARCODE CLEAR ZONE', bx + bw / 2, by + bh / 2 - 5);
    ctx.font = `400 ${Math.max(7, 6.5 * scale).toFixed(1)}px system-ui, sans-serif`;
    ctx.fillText('2.0" x 1.2" (empty in PDF)', bx + bw / 2, by + bh / 2 + 6);
    ctx.restore();
  }

  ctx.restore();
  return colors;
}
