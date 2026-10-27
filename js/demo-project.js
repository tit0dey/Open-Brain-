/**
 * KDP Studio — Calibrated 12-Page First-Load Demo Project & KDP Presets
 *
 * On first load (when no saved localStorage project exists), KDP Studio opens
 * with this 12-page monograph and automatically generates both the real
 * Interior PDF and Cover PDF so the entire workflow can be verified in seconds.
 */

import { PRICING_DEFAULTS, COVER_RULES } from './config.js';

export const DEMO_12_PAGE_MANUSCRIPT = `# Chapter 1: The Architecture of a Printed Page

Every enduring paperback begins long before ink touches paper. When a reader opens a well-made trade edition, nothing calls attention to itself: the inside margin opens generously toward the binding, lines sit at a restful measure, and each chapter begins cleanly on a right-hand recto leaf. Good book typography is quiet engineering in service of sustained reading, allowing ideas and stories to breathe without visual strain.

Independent authors once needed expensive desktop publishing suites, commercial font licenses, and fragile spine spreadsheets just to pass print preflight. Yet the underlying geometry of a paperback is remarkably deterministic. Once trim size, paper stock, and final page count are known, every margin, gutter, bleed extension, and wraparound cover dimension follows clear arithmetic that runs effortlessly inside a modern mobile browser.

## Proportions That Protect the Reader

A comfortable line of prose typically spans fifty-five to seventy characters. Set a column too wide and the eye loses its anchor returning to the left margin; set it too narrow and frequent line breaks fracture the natural cadence of sentences. On a standard six-by-nine trade page, an eleven-point literary serif paired with balanced leading creates an inviting rhythm that holds up across hundreds of pages of continuous reading.

- Inside gutters expand progressively with page count so thermal binding glue never swallows words near the fold.
- Running headers orient the reader quietly: book title on left-hand verso pages, chapter title on right-hand recto pages.
- Chapters open on odd-numbered right-hand pages with deliberate sink space and sunken three-line drop caps.
- Keep-with-next protection ensures no chapter or section heading is ever stranded alone at the bottom of a page.

When margins respect the physical curvature of a bound book, even a compact paperback feels calm and authoritative in the hand. Readers rarely measure margins with a ruler, yet they sense immediately when a page was designed with care rather than exported hastily from a word processor.

# Chapter 2: Mastering Bleed, Spine, and Safe Zones

More self-published books are rejected at upload for cover geometry than for any other technical reason. Unlike a flat e-book thumbnail, a paperback cover is a single continuous press sheet wrapping from the back cover, across the bound spine, to the front cover, surrounded on all four outer edges by a one-eighth-inch trim bleed that protects against white paper slivers.

Because mechanical guillotines shift slightly during high-speed trimming, every print facility enforces two distinct boundaries: bleed extends outward by 0.125 inches beyond the trim line, while live text and important framed artwork step inward at least 0.25 inches from every trim edge and spine hinge. Keeping these two tolerances separate eliminates the most common print defects before a single proof copy is ordered.

## Spine Mathematics and the Barcode Reserve

Spine thickness is never guessed or eyeballed. White uncoated stock measures exactly 0.002252 inches per page, while warm cream stock measures 0.0025 inches per page. Below seventy-nine pages, the bound edge is too narrow to accommodate press fold variance around spine lettering, so classic press practice leaves thin spines clean and unlettered.

On the lower-right corner of the back cover, a clear two-inch by one-point-two-inch rectangle waits for the retail ISBN barcode, positioned at least a quarter-inch inside both the bottom trim and the spine fold. Verifying automatically that blurbs, bios, and decorative borders stay clear of that reserve box prevents last-minute rejections at upload time.

# Chapter 3: From Pocket Draft to Published Edition

Writing on an Android phone during a morning train ride or quiet evening walk has become completely natural, yet finishing a print-ready book on that same pocket device remained nearly impossible until browser engines gained native OpenType shaping and binary PDF assembly. Running every production stage locally keeps your manuscript private, offline-capable, and free of cloud lock-in or API keys.

अभ्यास और धैर्य से हर लेखक अपनी पुस्तक को सुंदर मुद्रित रूप दे सकता है। Whether your manuscript carries English essays, technical checklists, or Hindi Devanagari prose, embedding subsetted Open Font License typefaces ensures every glyph renders sharply on commercial press RIP hardware anywhere in the world without missing-font substitutions.

* * *

## A Calm Preflight Ritual Before Going Live

Great bookmakers treat preflight not as bureaucracy, but as craftsmanship. Before downloading your final press files and copying your listing metadata into Amazon KDP Bookshelf, walk through each verification rule methodically. Confirm that your binary PDF streams open cleanly, verify exact MediaBox dimensions in points and inches, inspect embedded font descriptors, and confirm that your final page count is even.

Equally important is sustainable publishing economics. By calculating exact print cost from fixed binding overhead plus per-page paper charges, you can set a list price that clears the sixty-percent royalty threshold comfortably while remaining accessible to readers. Thoughtful titles, seven distinct fifty-character search keywords, and a crisp plain-English description complete the bridge between writer and reader.

Independent presses have always thrived on direct stewardship. When you control the manuscript file, the typographic grid, the wraparound cover geometry, and the archive JSON backup on your own device, updating a second edition takes minutes rather than weeks. Correcting a single date, adding an afterword, or adjusting list price requires only a quick regeneration and a fresh preflight check.

Archive your exported project JSON alongside your generated interior and cover PDFs so every parameter—trim size, leading, font choice, palette, and keyword set—remains reproducible years from now.

# Chapter 4: Ordering and Inspecting Your Proof

Before releasing a paperback to general availability, experienced publishers always review both the digital preflight report and a physical printed proof. Holding the bound book in daylight reveals tactile qualities no screen can fully imitate: the warmth of cream stock, the crispness of eleven-point serif body copy, and the generous breathing room near the glued spine.

Open the proof at the beginning, middle, and final chapter. Confirm that running headers sit comfortably below the top trim edge, page numbers align cleanly at the foot of each leaf, and the back-cover barcode window sits undisturbed in the lower-right safe area. When every detail aligns, approve your edition for global distribution. When every calculation lives openly in front of you, book production stops feeling mysterious—you are ready to publish an edition worthy of your words.`;

export function createDemoProject() {
  return {
    version: 1,
    updatedAt: '2026-10-27T00:00:00.000Z',
    bookMeta: {
      title: 'The Quiet Press',
      subtitle: 'A Field Manual for Pocket-First Paperback Production',
      author: 'Aarav Sen',
      copyrightYear: '2026',
      isbn: ''
    },
    manuscriptText: DEMO_12_PAGE_MANUSCRIPT,
    layout: {
      trimSize: '6x9',
      paperType: 'cream',
      bleed: false,
      fontId: 'eb-garamond',
      fontSizePt: 11,
      leading: 1.42,
      chapterStyle: 'classic',
      dropCaps: true,
      folioPosition: 'bottom-center'
    },
    cover: {
      templateId: 'meridian',
      paletteId: 'midnight',
      fontId: 'eb-garamond',
      customBgHex: '',
      customTextHex: '',
      customAccentHex: '',
      frontImageDataUrl: null,
      frontImageName: '',
      frontImageMode: 'framed',
      enableSpineText: true,
      backHeadline: 'CRAFT PRINT-READY PAPERBACKS FROM ANYWHERE',
      backBlurb:
        'Great books deserve calm, exact typography. The Quiet Press distills every print rule required to turn a raw manuscript into a press-ready paperback interior and wraparound cover without desktop software or cloud accounts.\n\nInside, you will learn how inside gutters scale with page count, why chapters open on right-hand recto leaves, how spine thickness shifts between white and cream stock, and how to pass preflight on the first upload.',
      authorBio:
        'Aarav Sen is an independent book designer and typographer focused on accessible, offline-first publishing tools for writers worldwide.',
      backFontSizePt: 10.5
    },
    spineConstants: {
      spineWhitePaperIn: COVER_RULES.spineWhitePaperIn,
      spineCreamPaperIn: COVER_RULES.spineCreamPaperIn
    },
    listing: {
      hookPatternId: 'quiet-mastery',
      description: [
        'The Quiet Press: A Field Manual for Pocket-First Paperback Production',
        '',
        'Great books deserve calm, exact typography. Written for independent authors, essayists, and small-press creators, The Quiet Press walks step by step through the geometry and craft of Amazon KDP paperback production.',
        '',
        'Inside this field manual, you will discover:',
        '- Exact KDP trim, bleed, and progressive gutter rules for every page count tier',
        '- Recto chapter openers, running headers, drop caps, and automatic tables of contents',
        '- Wraparound cover math for white and cream paper stocks at 300 DPI',
        '- Back-cover barcode clearance rules and preflight verification checks',
        '- Practical list-price and 60% royalty calculations to price your book with confidence',
        '',
        'Clear, compact, and grounded in traditional bookmaking standards, this handbook belongs beside every writer preparing a manuscript for print.'
      ].join('\n'),
      keywords: [
        'self publishing paperback layout guide',
        'amazon kdp print book formatting',
        'book typography and interior design',
        'independent author publishing checklist',
        'paperback cover spine width calculator',
        'print on demand book production manual',
        'writing and publishing reference handbook'
      ],
      categories: [
        'Books > Reference > Writing, Research & Publishing Guides > Publishing & Books',
        'Books > Arts & Photography > Graphic Design > Typography'
      ],
      listPriceUsd: 12.99,
      fixedCostUsd: PRICING_DEFAULTS.fixedCostUsd,
      perPageCostUsd: PRICING_DEFAULTS.perPageCostUsd,
      royaltyRate: PRICING_DEFAULTS.royaltyRate
    }
  };
}

/**
 * Extended 28-page sample manuscript (>= 24 KDP print minimum) so users can
 * also test full 9/9 green KDP print-minimum preflight compliance in one tap.
 */
export function createFull28PageSampleText() {
  const sections = [];
  const topics = [
    ['Chapter 1: Foundations of Paperback Proportion', 'The harmony between trim width, trim height, and column measure governs every decision in print design.'],
    ['Chapter 2: Preparing Clean Manuscript Structure', 'Consistent chapter markers, clean paragraph breaks, and intentional scene dividers allow automated typesetting to shine.'],
    ['Chapter 3: Inside Gutters and Binding Geometry', 'Perfect-bound paperbacks clamp pages in thermal adhesive, creating curvature near the spine that demands wider gutters as books grow thicker.'],
    ['Chapter 4: Typefaces, Leading, and Reading Comfort', 'Open Font License serifs such as EB Garamond pair timeless Renaissance proportions with crisp modern hinting for print RIPs.'],
    ['Chapter 5: Bleed Edges and Trimming Tolerances', 'Understanding why bleed applies to top, bottom, and outside edges prevents unexpected white borders or clipped running headers.'],
    ['Chapter 6: Full-Wrap Cover Engineering', 'Combining back panel, bound spine, front panel, and outer bleed into a single precision PDF sheet eliminates upload guesswork.'],
    ['Chapter 7: Barcode Zones and Cover Safe Margins', 'Leaving an unobstructed two-inch by one-point-two-inch barcode window on the lower-right back cover avoids automated rejection.'],
    ['Chapter 8: Multilingual and Devanagari Typesetting', 'Subsetted Unicode fonts allow English and Hindi Devanagari passages to share pages cleanly with authentic conjunct shaping.'],
    ['Chapter 9: Metadata, Keywords, and Sustainable Royalties', 'Thoughtful categories, seven non-overlapping search phrases, and transparent print-cost math connect finished books with readers.'],
    ['Chapter 10: Final Proofing and Print Release', 'Walking methodically through binary PDF preflight checks gives independent authors total confidence before publishing worldwide.']
  ];

  for (const [heading, lead] of topics) {
    sections.push(
      `# ${heading}`,
      '',
      `${lead} Across centuries of print craft, typographers discovered that readers absorb ideas most effortlessly when margins frame the text block with quiet generosity. Rather than crowding fifty lines onto a cramped leaf, classic trade editions let white space carry the eye naturally down each page and across every spread without fatigue.`,
      '',
      'When preparing an edition for print-on-demand presses, precision replaces trial and error. Every measurement in points, inches, and pixels derives from transparent rules that any author can verify before ordering a physical proof copy. Small details—suppressing headers on chapter openers, aligning folios consistently, and keeping headings attached to following lines—separate amateur printouts from bookstore-grade paperbacks.',
      '',
      '## Field Checklist for Independent Presses',
      '',
      '- Verify that every chapter opens on an odd-numbered right-hand recto page.',
      '- Confirm that running headers alternate cleanly between book title and chapter title.',
      '- Ensure the final page count is even and meets the twenty-four-page print threshold.',
      '- Inspect embedded font streams so press hardware renders every character faithfully.',
      '',
      'Taking ten calm minutes to inspect proof geometry saves weeks of revision. Once your interior and wraparound cover pass every preflight rule, your edition is ready for global print distribution.',
      '',
      'Independent publishing thrives when tools respect both the craft of bookmaking and the autonomy of the writer. With deterministic layout arithmetic running directly in your pocket browser, every draft can become a lasting physical book.',
      ''
    );
  }
  return sections.join('\n');
}
