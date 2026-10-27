# KDP Studio

**KDP Studio** is a complete, offline-first Amazon KDP paperback production tool engineered to run entirely inside a mobile browser on an Android phone.

It requires **no backend, no API keys, no paid services, no telemetry, no build step, and zero runtime network calls**. Plain HTML, CSS, and standard ES modules power the entire workflow—from raw `.txt`/`.md` manuscript to subset-font-embedded print Interior PDF, wraparound single-page Cover PDF, Amazon listing metadata, and binary PDF preflight verification.

---

## Key Capabilities

1. **Manuscript Auto-Splitter (Step 1)**
   - Paste text or upload `.txt` / `.md` manuscripts.
   - Splits chapters automatically on lines starting with `# ` or `Chapter N`.
   - Live Unicode-aware word count, chapter breakdown, script detection (Latin + Hindi Devanagari), and estimated even page count.
   - Ships with a calibrated **12-page first-load demo project** (plus a one-tap **24-page KDP print-minimum sample**) that builds real Interior and Cover PDFs automatically on first open.

2. **KDP Interior Layout & Live Canvas Proof (Step 2)**
   - Trim sizes: `6" x 9"`, `5.5" x 8.5"`, `5.25" x 8"`, and `8.5" x 11"`.
   - Bleed support (`+0.125"` top, bottom, and outside edge only; `>= 0.375"` outside margin with bleed, `>= 0.25"` without bleed).
   - Automatic KDP progressive gutter tiers by final page count (`24-150 -> 0.375"`, `151-300 -> 0.5"`, `301-500 -> 0.625"`, `501-700 -> 0.75"`, `701-828 -> 0.875"`).
   - Locally bundled SIL Open Font License (OFL 1.1) fonts: **EB Garamond**, **Inter**, and **Noto Sans Devanagari** for optional Hindi text.
   - Right-hand (recto / odd) chapter starts, mirrored running headers (book title on even pages, chapter title on odd pages), bottom-center or outer-corner folios, 3 chapter opener styles, 3-line orthographic drop caps, keep-with-next heading protection, auto-numbered Table of Contents after two-pass pagination, and even page padding.
   - Live HiDPI `<canvas>` page proof with toggleable bleed and margin guides.

3. **Chunked Interior PDF Engine (Step 3)**
   - Generates print-quality PDFs via locally vendored `pdf-lib` and `@pdf-lib/fontkit` with subset-embedded OFL fonts and zero crop marks.
   - Processes pages in non-blocking chunks with `requestAnimationFrame` yields, live progress bar, and instant cancellation so mid-range Android phones never freeze.

4. **Full-Wrap Single-Page Cover PDF (Step 4)**
   - Exact wraparound geometry:
     - `Full Width = 0.125 + trimWidth + spineWidth + trimWidth + 0.125`
     - `Full Height = trimHeight + 0.25`
     - `Spine Width = pages * 0.002252"` (white paper) or `pages * 0.0025"` (cream paper), both editable in UI and `js/config.js`.
   - Enforces `0.25"` safe zones inside trim edges, enables spine text strictly when `pageCount >= 79` and playable spine width permits, and reserves a clear `2.0" x 1.2"` barcode window at the bottom-right of the back cover (`>= 0.25"` inside trim) with live overlap warnings.
   - Includes 3 typographic templates (**Meridian Editorial**, **Horizon Band**, **Swiss Monograph**), 4 archival color palettes, optional front-cover image upload, and 300 DPI inch/pixel readouts with **Copy Specs**.

5. **Amazon Listing & 60% Royalty Calculator (Step 5)**
   - Title and subtitle builder with combined 200-character counter and subtitle hook-pattern picker.
   - 4000-character description generator preserving paragraph breaks and `- ` bullet lines (plus one-tap KDP HTML export).
   - 7 search keyword slots (`<= 50` chars each) with live counters and empty/duplicate warnings.
   - Editable print-cost and 60% royalty calculator table (`$0.85` fixed + `$0.012/page` default) showing minimum list price and per-copy profit, plus a plain-English metadata sheet to copy.

6. **Real Binary PDF Preflight Inspector (Step 6)**
   - Reloads and parses the generated `Uint8Array` PDF binaries with `pdf-lib` to verify PDF structural integrity, exact `MediaBox` dimensions, embedded `/FontFile*` streams, page-count sync, even parity, 24-page KDP print minimum, cover wraparound specs, bleed compliance, and decompressed PDF content-stream clearance inside the `2.0" x 1.2"` barcode zone.

---

## File Structure

```text
.
├── index.html                  # Mobile-first 6-step studio shell & sticky action bar
├── manifest.webmanifest        # PWA manifest for Android "Add to Home Screen"
├── sw.js                       # Offline-first precaching Service Worker
├── styles/
│   └── main.css                # Light/Dark studio theme, 44px touch targets, 360px-safe grid
├── js/
│   ├── config.js               # Single editable config for all KDP trim, margin, spine & pricing constants
│   ├── layout-math.js          # Pure KDP geometry & royalty math (shared by UI, PDFs, and unit tests)
│   ├── pdf-loader.js           # Local vendor/font loader, Devanagari script shaper & frame yields
│   ├── manuscript.js           # # / Chapter N splitter, word counter & fast page estimator
│   ├── paginator.js            # Two-pass typesetter, recto alignment, drop caps & post-pagination TOC
│   ├── interior-pdf.js         # Chunked KDP Interior PDF builder & HiDPI canvas proof renderer
│   ├── cover-pdf.js            # Single-page wraparound KDP Cover PDF builder & canvas spread renderer
│   ├── preflight.js            # Binary PDF stream & dictionary inspector for all 9 KDP checks
│   ├── listing.js              # Hook patterns, 4000-char description, 7 keywords & metadata sheet
│   ├── demo-project.js         # Calibrated 12-page first-load demo & 24-page KDP sample preset
│   ├── storage.js              # localStorage persistence + .json project Export / Import
│   ├── icons.js                # Crisp inline SVG icon library (zero emoji)
│   └── app.js                  # Step-wizard state, accessible confirmation modals & task cancellation
├── vendor/
│   ├── pdf-lib.min.js          # Locally vendored pdf-lib v1.17.1 (MIT)
│   ├── fontkit.umd.min.js      # Locally vendored @pdf-lib/fontkit v1.1.1 (MIT)
│   └── LICENSES.txt            # MIT license texts
├── fonts/
│   ├── eb-garamond-*.woff      # EB Garamond 400, 400i, 700 (SIL OFL 1.1)
│   ├── inter-*.woff            # Inter 400, 400i, 700 (SIL OFL 1.1)
│   ├── noto-sans-devanagari-*  # Noto Sans Devanagari 400, 700 (SIL OFL 1.1)
│   └── OFL-LICENSE.txt         # SIL Open Font License 1.1
├── icons/
│   ├── icon.svg                # Vector app emblem
│   ├── icon-192.png            # Android home-screen icon (192x192)
│   └── icon-512.png            # Android splash/install icon (512x512)
└── tests/
    ├── layout-math.test.mjs    # Unit tests for gutter, margins, bleed, spine, cover & pricing math
    └── verify-pdfs.mjs         # End-to-end headless PDF generation, binary preflight & zero-emoji check
```

---

## Deploying to GitHub Pages (Zero Build Step)

Because every asset uses relative paths (`./`) and standard browser ES modules with vendored libraries already committed under `vendor/` and `fonts/`, **no CI bundler or build pipeline is required**:

1. Push this repository to GitHub (on your default branch, e.g. `main`).
2. Open your repository on GitHub and navigate to **Settings > Pages**.
3. Under **Build and deployment**:
   - **Source**: Select **Deploy from a branch**.
   - **Branch**: Select `main` (or your desired branch) and folder `/ (root)`, then click **Save**.
4. Wait ~30–60 seconds for GitHub Pages to publish your URL (`https://<your-username>.github.io/<repo-name>/`).
5. Open that URL in **Chrome on Android**, tap the browser menu, and select **Add to Home screen / Install app**. The Service Worker (`sw.js`) precaches all code and fonts so KDP Studio launches full-screen and works completely offline—even in airplane mode.

### Running Locally

Serve the root directory with any static file server:

```bash
python3 -m http.server 8080
# Open http://localhost:8080
```

### Running Unit Tests & Headless Binary PDF Verification

With Node.js (v18+):

```bash
npm test
# or directly:
node --test tests/layout-math.test.mjs tests/verify-pdfs.mjs
```

---

## Short Guide: How to Publish Your Paperback on Amazon KDP

1. **Finalize Your Manuscript & Layout in KDP Studio**
   - Paste or upload your `.txt` / `.md` manuscript in **Step 1 (Manuscript)**. Ensure your book reaches at least **24 pages** (KDP's minimum page count for physical paperback binding).
   - In **Step 2 (Layout)**, select your trim size (`6" x 9"` is standard for most non-fiction and trade books), paper color (**Cream** for prose/literary work, **White** for manuals/workbooks), and typeface.
   - Build and download `<your-book>-interior-kdp.pdf` in **Step 3 (Interior)**, then build and download `<your-book>-cover-kdp.pdf` in **Step 4 (Cover)**.
   - Confirm **9 of 9 PASS** in **Step 6 (Preflight)** and export a `.json` archive backup of your project.

2. **Create Your Paperback Title on KDP Bookshelf**
   - Sign in at `kdp.amazon.com`, click **Create**, and choose **Paperback**.
   - Open **Step 5 (Listing)** in KDP Studio and tap **Copy Metadata Block** (or **Copy KDP HTML** for the formatted book description).
   - Paste your **Book Title**, **Subtitle**, **Author Name**, **Description**, up to **3 Categories**, and all **7 Search Keywords** into the **Paperback Details** tab.

3. **Configure Paperback Content & Upload Your PDFs**
   - Under **ISBN**, choose either **Get a free KDP ISBN** (simplest for Amazon distribution) or enter your own purchased imprint ISBN (matching your Copyright page).
   - Under **Print Options**, select the **exact same Ink & Paper, Trim Size, and Bleed setting** you configured in KDP Studio (`No Bleed` or `Bleed (PDF only)`), and choose **Matte** or **Glossy** cover finish.
   - Upload `<your-book>-interior-kdp.pdf` under **Manuscript**.
   - Select **Upload a cover you already have (print-ready PDF)** and upload `<your-book>-cover-kdp.pdf`. Leave the KDP barcode checkbox unchecked unless your cover already embeds a custom price barcode—KDP automatically places the ISBN barcode inside KDP Studio's reserved `2.0" x 1.2"` clear window on the lower-right back cover.

4. **Approve in KDP Print Previewer & Set Pricing**
   - Launch **KDP Print Previewer** and flip through the digital trim/gutter lines to confirm clean margins.
   - Click **Approve**, enter your **List Price** on the **Paperback Rights & Pricing** screen (using KDP Studio's 60% royalty calculator to verify per-copy profit), order an **Author Proof Copy** if desired, and click **Publish Your Paperback Book**. Most titles go live on Amazon within 24–72 hours.
