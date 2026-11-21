# APRABot (aprabot.com) — SEO Audit

Scope: `index.html`, `about.html`, `careers.html`, `resources.html`, `security.html`, `blog-snop.html`, plus `css/styles.css` and the page-local `<script>` blocks. Static GitHub Pages site on a custom apex domain (`CNAME` → `aprabot.com`), 6 public marketing pages, no build step, no CMS.

Two additional live, indexed-by-URL pages exist outside the 6 in scope — see §8, they're a real finding, not noise.

Status legend: **Pass** / **Warning** / **Fail**.

---

## 1. Crawlability and indexing

| Item | Status | Evidence | Why it matters | Fix |
|---|---|---|---|---|
| `robots.txt` | Fail | 404 at repo root (confirmed: no `robots.txt` file exists) | Not fatal — Google crawls without one — but it's the canonical place to point crawlers at the sitemap, and its absence is one more reason discovery has been slow. | Add `robots.txt` with an `Allow: /` and `Sitemap:` line (done in Part 2). |
| `sitemap.xml` | Fail | 404 at repo root | With no sitemap and no nav-level cross-linking from the homepage, Google has to find `about.html`/`resources.html`/`security.html` purely by crawling footer links from pages it already indexed — exactly the slow, unreliable path your GSC report shows actually happened. | Add `sitemap.xml` listing all 6 URLs, submit it in GSC (done in Part 2; submission to GSC is on you — see action plan). |
| Meta robots tags | Pass | No `<meta name="robots">` found on any page (checked via grep) | Absence = default `index, follow`, which is what you want for all 6 pages. Nothing to fix. | None. |
| Canonical tags | Fail | No `<link rel="canonical">` on any of the 6 pages | Without canonicals, Google has to guess the preferred URL for any duplicate (see next row). Cheap insurance even where duplication risk looks low today. | Add a self-referencing absolute canonical to every page (done in Part 2). |
| Duplicate URL: `/` vs `/index.html` | Warning | GitHub Pages serves `index.html` at both `https://aprabot.com/` and `https://aprabot.com/index.html`; internal links use `href="index.html"` everywhere (e.g. `index.html:26`, `about.html:115,118`, and 17 more instances across the other 4 pages) | Two crawlable, linkable paths to the same content is classic duplicate-content surface area. GSC currently shows `/` indexed — good — but every internal link is actively pointing at the non-canonical `index.html` form, which is the wrong thing to be reinforcing. | Canonical tag on `index.html` pins `https://aprabot.com/` as preferred (done). Additionally, rewrite internal `href="index.html"` / `href="index.html#x"` to `/` / `/#x` site-wide so internal link equity reinforces the canonical form instead of fighting it (done in Part 2, item 7). |
| Trailing-slash duplication | Pass | GitHub Pages' default behavior for a custom domain without a `_config.yml` doesn't generate parallel trailing/non-trailing variants for the `.html` pages here (only the root `/` vs `/index.html` pair above is relevant) | N/A | None beyond the canonical fix above. |
| Orphan pages (no internal links at all) | Fail | `architecture.html` and `cost-analysis.html` are tracked in git (`git ls-files` confirms both are committed, i.e. live on aprabot.com right now) and are **not linked from any of the 6 public pages** (`grep -l` across all 6 returns nothing) | These are reachable by anyone with the URL or who finds them via GitHub itself, yet invisible to your own navigation. See §8 — this is really a confidentiality finding wearing an SEO hat, since these pages contain internal AWS architecture/cost details. | Not a Part-2 fix — this needs a product decision from you (remove, noindex, or relocate). Flagged with high priority in the action plan. |
| Broken internal links | Fail | Footer "About" link is `href="#"` on `careers.html:109`, `resources.html:263`, `security.html:378`, `blog-snop.html:292`. Footer "Careers" link is `href="#"` on `resources.html:264`, `security.html:379`, `blog-snop.html:293`. Footer "Security"/"Blog"/"Documentation" links are `href="#"` on `resources.html:270-272` | `about.html` currently has exactly **one** working internal inbound link site-wide (from `index.html`'s footer) — every other page's footer silently points its "About" link at `#` instead. That's a real contributor to weak discovery/authority for `about.html`, independent of the sitemap issue. | Point each `#` at its real target (`about.html`, `careers.html`, `security.html`, `blog-snop.html`, `resources.html` respectively) — pure `href` value fixes, no visible text or layout change (done in Part 2, item 10). |
| 404 handling | Fail | No `404.html` at repo root | GitHub Pages serves its own generic 404 for any unmatched path. A branded 404 with a link back to `/` recovers otherwise-lost visitors and slightly helps crawl efficiency (bots that hit a dead link get a page with navigation instead of a dead end). | Not fixed in Part 2 (new page = new content, out of scope for "fixes to existing pages"). Recommended next step, listed in the action plan. |
| CNAME / HTTPS | Pass (verify one setting) | `CNAME` file contains `aprabot.com` (apex, no `www`) | Correct for a GitHub Pages custom domain. | Can't verify "Enforce HTTPS" from the repo alone — confirm it's checked under repo Settings → Pages. If `www.aprabot.com` resolves at your DNS registrar, GitHub Pages will not auto-redirect it to the apex; worth a manual check so you don't have a second unmanaged duplicate host. |

---

## 2. On-page, per page

| Page | Title (len) | Meta description | H1 count / text | Heading outline | Word count | Title/H1/content agreement |
|---|---|---|---|---|---|---|
| `index.html` | "APRABot — AI-Native Demand Forecasting" (39) | **Missing** | **2** — visible: "Forecast Better Stock Smarter Grow Faster" (`index.html:85`); hidden: "Welcome back, there." (`index.html:469`, inside `#dashboard`, `display:none` at `index.html:428`) | h1 → h2 "A Multi-Agent Engine…" → h2 "One Continuous Loop…" → h2 "A living digital twin…" → h2 "Built for Businesses…" → h2 "Stop guessing demand…" — flat, no skipped levels, but no h2/h3 nesting at all (every section head is an h2, cards/steps use h3/h4-weight styling on non-heading tags) | ~380 (hero + cards + flow + CTA copy) | Good — title, H1, and content all converge on "AI-native demand forecasting" | 
| `about.html` | "About — APRABot" (16) | **Missing** | 1 — "We built the forecast we always wished we had." | h1 → h2 "Our mission…" → h2 "From a prediction to a platform" → h2 "The principles we build by" → h2 "Built by practitioners, not theorists" → h2 "Want to work on hard problems…" (CTA) | 592 | Title is generic/interchangeable with any company's About page; doesn't signal "demand forecasting." H1 and body content are strong and specific — the title is the weak link (rewritten in Part 2). |
| `careers.html` | "Careers — APRABot" (18) | **Missing** | 1 — "We're building something great — join us." | h1 only, no h2/h3 (single-screen stub) | 139 | Agrees, but see Thin Content below. |
| `resources.html` | "Resources — APRABot" (20) | **Missing** | 1 — "The models behind the forecast" | h1 → h2 "What is XGBoost?" → h3 "Why XGBoost excels…" → h2 "What is LightGBM?" → h3 "Why LightGBM excels…" → h2 "XGBoost vs LightGBM at a glance" → h2 "How APRABot uses them together" — clean, no skipped levels | 790 | Title says nothing about the actual subject (XGBoost/LightGBM ensemble forecasting) — rewritten in Part 2 to match. |
| `security.html` | "Security & Data Privacy — APRABot" (34) | **Missing** | 1 — "Your data is your most valuable asset. We treat it that way." | h1 → h2 ×5 ("Built secure…", "Your data belongs to you", "How Amplify connects…", "Meeting the standards…", "Enterprise-grade reliability") → h3 ×12 inside pillar/detail cards — clean, no skipped levels | 1,066 | Title, H1, and content all agree well — best-optimized title on the site already. |
| `blog-snop.html` | "How Better S&OP Planning Improves Profit — APRABot Blog" (57) | **Missing** | 1 — "How Better S&OP Planning Directly Improves Profit" | h1 → h2 ×4 → h3 ×5 (the "five ways" subsections) — clean | 1,260 | Strong agreement; already your best title/content match alongside security.html. |

Every page fails the same single item (no meta description) — fixed uniformly in Part 2 with unique, content-derived descriptions (see the end-of-task summary for the exact text landed on each page).

---

## 3. Content quality

**Thin content:**
- `careers.html` — **Fail**, 139 words. It's a deliberate "coming soon" placeholder, which is a legitimate product choice, but it's also one of only 3 pages Google has indexed so far (per your GSC data) — i.e. Google is currently spending some of its indexing attention on your thinnest page. Not urgent to fix the content itself (that's a product decision, not an SEO bug), but worth knowing.
- All other pages clear 300 words comfortably (about: 592, resources: 790, security: 1,066, blog-snop: 1,260).

**Duplicated text across pages:** None found at the paragraph level. The repeated elements are all intentional/structural: the footer tagline ("AI-native demand forecasting that aligns supply chain, finance, and sales on one trusted number") and the footer "Product" column (Demand Sensing / Forecasting / Scenario Planning / S&OP) appear verbatim on all 6 pages — this is normal footer boilerplate, not a duplicate-content risk.

**Keyword coverage** against your target terms:
| Term | Coverage |
|---|---|
| "demand forecasting software" | Not used verbatim anywhere. Close variants ("demand forecasting," "forecasting engine/platform") appear throughout `index.html`, `about.html`, `resources.html`. |
| "AI demand forecasting" / "AI-native demand forecasting" | Strong — in the `index.html` title, hero eyebrow, and footer tagline on every page. |
| "demand sensing" | Good — a named product pillar on `index.html` ("Demand Sensing" card) and footer nav, but never explained in prose anywhere (no page defines what demand sensing *is* the way `resources.html` explains XGBoost/LightGBM). |
| "S&OP planning" | Strong — entire `blog-snop.html` post is built around it. |
| "inventory optimization" | Present as a product pillar on `index.html` and referenced in `blog-snop.html`'s profit-impact section, but — like demand sensing — never has its own explainer page. |

This is a real content gap, not a technical one: you have strong long-form content for *one* of your five product pillars (forecasting methodology, via resources.html) and *one* go-to-market concept (S&OP, via the blog), and nothing equivalent for demand sensing, scenario planning, or inventory optimization. See §9 for blog topics that would close this.

**Unverifiable claims to confirm before Google — or a prospect — leans on them:**
- "98.2%" forecast accuracy — `index.html:107`, `about.html:149`
- "SOC 2 Type II" — `index.html:92,339`, `security.html:134,290`, footer of every page ("Privacy · Terms · SOC 2 Type II")
- "99.99% uptime" — `index.html:93`, `security.html:155,328`
- "37% average inventory reduction," "6× faster planning cycles," "$2.4B annual demand orchestrated" — `about.html:150-152`
- "ISO 27001... In progress," "CCPA... Compliant," "GDPR... Compliant" — `security.html:296-313` (compliance claims carry real legal exposure if inaccurate — this is the highest-stakes item in this whole list to get right)
- "Annual penetration testing by independent third party" — `security.html:339`

I have not changed any of this copy. Flagging per your request — please confirm each is currently accurate before relying on this page for enterprise sales conversations, since an incorrect compliance claim is a trust (and potentially legal) liability, not just an SEO one.

---

## 4. Internal linking

**Link map** (page → pages it links to, internal only, de-duplicated):

- `index.html` → about, careers, resources, security, blog-snop *(all via footer only — index.html's top nav has no Resources/Security/Blog links at all, unlike every other page)*
- `about.html` → index, careers, resources, security, blog-snop
- `careers.html` → index, resources, security, blog-snop *(About is broken → `#`)*
- `resources.html` → index, resources (self) *(About, Careers, Security, Blog, Documentation are all broken → `#`)*
- `security.html` → index, resources, blog-snop *(About, Careers are broken → `#`)*
- `blog-snop.html` → index, resources *(About, Careers, Security are broken → `#`)*

**Inbound count per page** (real links only, before Part-2 fixes):
| Page | Real inbound internal links | From |
|---|---|---|
| `about.html` | 1 | index.html footer |
| `careers.html` | 2 | index.html footer, about.html footer + CTA |
| `resources.html` | 5 | index, about, careers, security, blog-snop (all working) |
| `security.html` | 3 | index, about, careers |
| `blog-snop.html` | 4 | index, about, careers, security |

`resources.html` is clearly your best-linked page internally — consistent with it already being discoverable in principle. `about.html` is the weakest, which lines up with its generic title and its "unknown to Google" status in GSC.

**Anchor text quality:** Mostly good and descriptive ("View open roles," "The models behind the forecast" linked as "Documentation," "Book a demo"). One generic pattern worth noting: `resources.html`'s "On this page" sidebar links (`resources.html:230-233`) and `blog-snop.html`'s "In this article" sidebar links (`blog-snop.html:255-258`) are all `href="#" onclick="return false"` — decorative table-of-contents entries that go nowhere. Not an SEO problem (nofollow-equivalent dead links aren't penalized), but it's a slightly confusing UX pattern (looks clickable, isn't) worth a product note.

**Blog → product links:** `blog-snop.html` already links to `resources.html` from its sidebar ("Related reading," `blog-snop.html:262`), but has **no contextual link from the body prose** to the homepage's platform section, despite the post's "How APRABot powers the modern S&OP cycle" section being a natural fit. Added one in Part 2 (item 8).

---

## 5. Technical performance

No external tools used, per your instructions — this is a static read of the CSS/JS/HTML.

| Item | Status | Evidence | Estimated impact |
|---|---|---|---|
| Render-blocking CSS | Warning | `css/styles.css` is 85KB / 1,373 lines, unminified, loaded via a single blocking `<link>` in `<head>` on every page | A single 85KB unminified stylesheet is a meaningful chunk of blocking CSS for a text-heavy marketing site. Minification alone (no code change, just whitespace/comment removal) would likely cut this 30-40%. Not done here — it's a build-tooling change, not a content fix, and risks subtle breakage without a proper build step to verify against. Recommended next step. |
| Render-blocking Google Fonts | Pass | `rel="preconnect"` to both font hosts is already present (`index.html:12-13` and identically on all 5 other pages), and the stylesheet URL already includes `&display=swap` (`index.html:14`) | This is already done correctly — no FOIT (flash of invisible text), and the preconnects shave connection setup time off the font request. Nothing to fix. |
| Images | Pass (trivially) | Zero `<img>` tags anywhere across all 6 pages — every visual (logo, icons, hero chart, "brain" diagram) is inline SVG | No image-weight, lazy-loading, or format concerns exist today because there are no raster images in the content. The one new asset this audit adds (`images/og-image.png`, ~100KB) is never rendered on-page — it's only fetched by social-media crawlers, so it doesn't affect page load or Core Web Vitals at all. |
| JS loading strategy | Pass | All page-local scripts (`js/theme.js`, `js/apy.js`, and on `index.html` also `js/data.js`, `js/main.js`, `js/auth.js`) are placed immediately before `</body>`, after all visible content | This is already the correct pattern for avoiding JS-blocked rendering — no `defer`/`async` needed since the scripts are already positioned to run after the DOM they need is parsed. |
| Total JS weight on `index.html` | Warning | `js/main.js` (92KB) + `js/data.js` (21KB) + `js/apy.js` (28KB) + `js/auth.js` (12KB) + `js/theme.js` (3KB) ≈ 156KB, all loaded on the public homepage | Worth checking how much of `main.js`/`data.js` is actually dashboard logic (forecast charts, SKU tables) that only matters *after* login, versus homepage-only code. If it's mostly post-login logic, lazy-loading it only when the dashboard is actually shown (rather than on every anonymous homepage visit) would meaningfully cut homepage JS weight — this is a real optimization opportunity but a structural one, out of scope for this pass. |
| Inline `<head>` theme script | Warning | `<script>document.documentElement.dataset.theme=...</script>` runs *before* `<meta charset="UTF-8">` in `<head>` on all 6 pages (e.g. `index.html:4-5`) | Minor and almost certainly harmless in practice (GitHub Pages serves the correct charset via the HTTP `Content-Type` header, and the inline script is a handful of bytes, well inside the first-1024-byte window browsers use for encoding sniffing), but it's not spec-ideal placement. Left as-is — reordering `<head>` elements wasn't in your fix list and the risk/benefit doesn't justify an unrequested change. |
| CLS risk | Pass | No web fonts without `font-display: swap` (addressed above), no images without explicit dimensions (because there are no images), no obviously late-injected above-the-fold content | Nothing actionable found. |
| LCP candidate | Pass | On `index.html` the likely LCP element is the hero `<h1>` or the forecast `.panel` SVG — both are inline, no network round-trip required beyond the already-optimized font/CSS | Nothing actionable found. |

---

## 6. Mobile and accessibility

| Item | Status | Evidence | Fix |
|---|---|---|---|
| Viewport meta | Pass | `<meta name="viewport" content="width=device-width, initial-scale=1.0">` present on all 6 pages | None needed. |
| `lang` attribute | Pass | `<html lang="en">` on all 6 pages | None needed. |
| Mobile nav / tap targets | Pass | `index.html` has a dedicated mobile sidebar (`#mob-sidebar`) with full-width link rows; buttons use the shared `.btn` class with visible padding | None needed. |
| Link text ("click here" etc.) | Pass | No generic "click here"/"read more" link text found anywhere — all links use descriptive text ("Book a demo," "View open roles," "The models behind the forecast") | None needed. |
| Form labels | Pass | Every `<input>` in the login/signup modals (`index.html:354-422`) and the careers notify-me form (`careers.html:77`) has an associated `<label for="...">` or, for the careers form, a clear `placeholder` plus visible button text | None needed. |
| Alt text | Pass (trivially) | No `<img>` tags exist (see §5) | None needed now; if/when real photography or screenshots are added (e.g. a team photo on `about.html`, or product screenshots), alt text becomes mandatory then. |
| Color contrast | **Fail (one color), Pass (rest)** | Computed WCAG contrast ratios from `css/styles.css`'s `:root` palette against the `--ink` background (`#0A0E15`): `--text` (#EAF0F6) = **16.8:1** ✓, `--muted` (#8694A6) = **6.3:1** ✓ (passes AA), `--signal` (#C8F24E) = **15.0:1** ✓ — but `--muted-2` (#5C6878) = **3.4:1**, which fails WCAG AA's 4.5:1 threshold for normal text. It's used as a text color (not just borders) at small sizes in `.trust` (`css/styles.css:105`, the "SOC 2 Type II · 99.99% uptime · Deploys in <6 weeks" line in the hero, 13px) and `.cs-note` (`careers.html:38`, 11.5px) among others. | Not fixed in Part 2 — raising `--muted-2`'s lightness would be a visible color/copy-adjacent change across every page using it, outside the "no visible changes" constraint. Recommended fix: lighten `--muted-2` to something around `#6E7A8C` or lighter (re-check contrast after any change) — flagged for your review, not applied. |
| Tap target sizing | Pass (can't fully verify) | `.btn` padding and the mobile sidebar's `.mob-sb-link` both appear to exceed the 44×44px recommendation based on their CSS padding values | Visual/device testing would confirm definitively; nothing in the CSS suggests an undersized target. |

---

## 7. Structured data and social

| Item | Status | Evidence | Fix |
|---|---|---|---|
| JSON-LD (any type) | Fail | Zero `<script type="application/ld+json">` blocks anywhere (grep confirms) | Add `Organization` + `WebSite` to `index.html`, `BlogPosting` to `blog-snop.html` (done in Part 2, per your spec). `SoftwareApplication`, `BreadcrumbList`, and `FAQPage` are reasonable future additions — not added now since they weren't in your Part 2 list and some (like FAQPage) need content that doesn't exist yet on these pages. |
| Open Graph tags | Fail | None found | Add `og:title`, `og:description`, `og:url`, `og:site_name`, `og:type`, `og:image` to all 6 pages (done in Part 2). |
| Twitter Card | Fail | None found | Add `twitter:card="summary_large_image"` to all 6 pages (done in Part 2). |
| Social preview image | Fail | No image existed anywhere in the repo at a usable social-card aspect ratio (only small favicons and a 180×180 `apple-touch-icon.png`) | Generated `images/og-image.png` (1200×630), matching the site's actual CSS color tokens (`--ink`, `--signal`, `--mint`, `--text`) and hero copy ("Forecast Better. Stock Smarter. Grow Faster.") — not a generic stock-style graphic. |
| Favicon | Pass | `favicon.svg`, `favicon-32.png`, `favicon-16.png`, `apple-touch-icon.png` all present and correctly linked on all 6 pages | None needed. |
| Web app manifest | Warning | No `site.webmanifest`/`manifest.json` | Mostly a PWA/"add to home screen" nicety, not an SEO factor — not in your Part 2 list, not added. Low priority. |

---

## 8. Security and trust

| Item | Status | Evidence | Why it matters | Fix |
|---|---|---|---|---|
| **Orphaned internal pages exposing infrastructure details** | **Fail — highest priority finding in this audit** | `architecture.html` ("APRABot — AWS Architecture") and `cost-analysis.html` ("APRABot — AWS Infrastructure Cost Analysis") are committed to the repo and therefore **live on `https://aprabot.com/architecture.html` and `/cost-analysis.html` right now**, reachable by anyone with the URL. Neither is linked from any of the 6 public pages, but "not linked" is not the same as "not public" — a static site has no access control, and these specific filenames are exactly the kind a search engine, a competitor, or an automated scanner could stumble onto or guess. | This is a confidentiality exposure wearing an SEO hat (it showed up during the orphan-page check in §1) — internal AWS architecture and cost figures sitting on your public production domain. | **Not fixed here — this needs your decision**, not a silent SEO edit: either remove these two files from the repo (git history still has them, so a full purge would need `git filter-repo` or similar if that matters to you), move the content somewhere access-controlled, or at minimum confirm this exposure is acceptable. Flagged at the top of the action plan below. |
| Mixed content | Pass | Every external resource reference (fonts, the one external link to `developers.google.com` on `security.html:265`) uses `https://` | None needed. |
| `target="_blank"` without `rel="noopener"` | Pass | Only one `target="_blank"` link exists site-wide (`security.html:265`), and it already has `rel="noopener"` | None needed — already done correctly. |
| Privacy policy / Terms pages | Fail | Every page's footer displays the literal text "Privacy · Terms · SOC 2 Type II" (e.g. `index.html:339`) as **plain, unlinked text** — there is no privacy policy or terms page anywhere in the repo | `security.html` makes specific, legally-loaded claims (GDPR compliance, CCPA compliance, "right to erasure honoured within 30 days," SSO/SAML, sub-processor lists) with no actual privacy policy to back them up or make those rights exercisable. This is a real trust-signal and likely compliance gap, not just a missing page. | Not fixed here — drafting an actual privacy policy and terms of service is a legal-content task I won't fabricate. Flagged as a high-priority action item for you; happy to implement the HTML/linking once you have the text. |
| Contact page | Pass (exists, informally) | No dedicated `/contact` page, but `mailto:` and `tel:` links are present on every page (CTA bands, footers) and are functionally equivalent for a small team | Low priority — a dedicated contact page with a form could improve lead capture, but isn't an SEO gap per se. |

---

## 9. Content strategy

**10 blog post ideas**, targeting the product-pillar gap identified in §3 (you have strong content for forecasting methodology and S&OP, nothing for demand sensing, scenario planning, or inventory optimization):

| # | Target keyword | Search intent | Suggested title |
|---|---|---|---|
| 1 | demand sensing | Informational / top-of-funnel | "What Is Demand Sensing? How Real-Time Signals Beat Monthly Forecasts" |
| 2 | inventory optimization software | Commercial investigation | "Inventory Optimization Software: What to Look For Before You Buy" |
| 3 | demand forecasting accuracy | Informational | "How to Measure Demand Forecasting Accuracy (WAPE, MAPE, and Bias Explained)" |
| 4 | scenario planning supply chain | Informational / mid-funnel | "Scenario Planning for Supply Chains: Running What-Ifs Before They Happen" |
| 5 | AI demand forecasting vs traditional forecasting | Commercial investigation | "AI Demand Forecasting vs. Traditional Statistical Models: What Actually Changes" |
| 6 | demand forecasting software for CPG | Commercial / industry-specific | "Demand Forecasting for CPG Brands: The 5 Signals Generic Tools Miss" |
| 7 | safety stock optimization | Informational | "Safety Stock Optimization: Why More Buffer Isn't the Same as Less Risk" |
| 8 | forecast bias | Informational, practitioner-level | "Forecast Bias Is Costing You More Than Forecast Error — Here's How to Find It" |
| 9 | demand planning software ROI | Bottom-of-funnel, buyer-stage | "Calculating the ROI of Demand Planning Software: A Practical Framework" |
| 10 | weather demand forecasting | Informational, differentiator-led | "Does Weather Actually Move Your Demand? How to Find Out (and What to Do About It)" |

**Recommended URL structure going forward:** move off the flat `blog-snop.html` pattern (where the slug encodes the topic abbreviation, not a clean path) and adopt `/blog/` as a real directory:
- `/blog/` — index/listing page
- `/blog/what-is-demand-sensing.html` (or extensionless `/blog/what-is-demand-sensing` if you add a GitHub Pages-compatible routing step — plain `.html` is the lower-risk default for a static site with no build process)
- Migrate `blog-snop.html` → `/blog/sop-planning-profit.html` (or similar) with a 301-equivalent: since GitHub Pages doesn't support server-side redirects, use an HTML meta-refresh + canonical pointing to the new URL on the old path, or simply keep the old URL live and canonical to itself if migrating isn't worth the churn for one post. Not done in Part 2 — flagged as a decision for when you're ready to scale the blog past one post.

---

## Prioritized action plan

**High impact / low effort — fixed in Part 2:**
1. Add `robots.txt` + `sitemap.xml`, submit sitemap in GSC *(file creation done here; GSC submission is a manual step for you — see below)*
2. Add canonical tags to all 6 pages
3. Add unique meta descriptions to all 6 pages
4. Fix the hidden duplicate `<h1>` on `index.html` → `<h2>`
5. Rewrite the two generic titles (`about.html`, `resources.html`)
6. Add Organization + WebSite JSON-LD to `index.html`, BlogPosting to `blog-snop.html`
7. Add Open Graph + Twitter Card tags to all 6 pages, with a new on-brand `images/og-image.png`
8. Rewrite internal nav/footer `index.html` links to `/` (fixes the duplicate-URL internal-linking issue)
9. Fix the ~10 broken `href="#"` footer links (About/Careers/Security/Blog/Documentation) across 4 pages
10. Add one contextual link from `blog-snop.html`'s body to the homepage platform section

**High impact / needs your input — not touched:**
11. **Confirm or remediate the public exposure of `architecture.html` and `cost-analysis.html`** (§8) — this is the one item in this audit I'd act on first, ahead of everything else, since it's a confidentiality question rather than an SEO one
12. Verify every unverifiable claim in §3 (98.2% accuracy, SOC 2 Type II, 99.99% uptime, ISO 27001 "in progress," the specific inventory/CPG numbers on `about.html`) is currently accurate
13. Write and link an actual Privacy Policy and Terms of Service (the footer currently promises both as plain unlinked text)
14. Double-check GitHub Pages "Enforce HTTPS" is enabled and that `www.aprabot.com` doesn't resolve to an unmanaged duplicate host

**Medium impact / low-medium effort — good next pass, not done here:**
15. Create a branded `404.html`
16. Lighten `--muted-2` (currently 3.4:1 contrast, fails WCAG AA at the small sizes it's used) and re-verify contrast
17. Write the 1-2 missing product-pillar explainer pages (demand sensing, inventory optimization) suggested in §9, closing the keyword-coverage gap in §3
18. Minify `css/styles.css` (85KB unminified) as part of a proper build step

**Lower impact / higher effort — roadmap items:**
19. Migrate the blog to a real `/blog/` directory structure as post volume grows (§9)
20. Audit how much of `main.js`/`data.js`'s 113KB combined weight on the public homepage is actually post-login dashboard logic that could be lazy-loaded instead
21. Add a web app manifest (`site.webmanifest`) — low priority, not an SEO factor
