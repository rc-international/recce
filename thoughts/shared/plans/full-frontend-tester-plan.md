# Feature Plan: Recce Full Frontend Tester for valors.io

Created: 2026-04-23
Author: architect-agent

## Overview

Expand Recce from a 10-page random sanity sampler into a full frontend tester that
crawls the entire `/articles` tree and a representative slice of `/sites`
(merchant) pages, producing per-URL, per-element failure reports delivered via
Discord and a JSON artifact. The tester is split into a fast "pulse" suite that
runs every scheduled cron and a deep "audit" suite that runs nightly, so the
daily Discord signal stays actionable while deep regressions are still caught
within 24 hours.

## Requirements (from user)

- [ ] Bounded BFS crawl of every page in `/articles/en/...` tree
- [ ] Detect broken / missing inline article-body images (not just "count > 0")
- [ ] Detect broken or wrong-destination links (internal; external warn-only)
- [ ] Detect merchant pages missing required hero/content images
- [ ] Detect duplicate images on the same page (same `src` repeated)
- [ ] Verify every visible button on every page is enabled / clickable
- [ ] Senior-engineer additions beyond the above
- [ ] Report specific failing URLs + offending elements to Discord
- [ ] Respect existing 429 rate-limit behaviour and Discord reporter
- [ ] Keep `run-daily.sh` cron-budget friendly

---

## Section A — Architecture

### A1. Crawl strategy

**Bounded BFS with a shared work queue.**

- Seeds
  - Start with the existing `seedUrls` list in `daily-sanity.spec.ts`.
  - **Add `/sitemap.xml` parsing as the primary seed source** — more reliable
    than DOM-link crawling and surfaces orphans not linked from any index page.
  - Seed merchant pages from any `/sites/...` links found either in the sitemap
    or on article pages.
- Discovery rule: only enqueue URLs whose pathname starts with `/articles/` or
  `/sites/`. Everything else is a candidate for the *link-validation* check but
  not for *re-crawl*.
- Visited set: `Set<string>` keyed on the normalized pathname (strip trailing
  slash, lowercase query keys, drop tracking params `utm_*`, `gclid`, `fbclid`).
- Depth cap: `MAX_DEPTH` env (default 6 — covers `/articles/en/<country>/<region>/<city>/<category>/<slug>`).
- Total-page cap: `MAX_PAGES` env (default 50 for pulse, 2000 for audit).
- Concurrency: **hard cap at 2 concurrent page-loads against prod** (same
  politeness as the existing suite, which serialises with `workers: 1`). For
  local runs allow `CRAWL_CONCURRENCY` override.
- Request pacing: minimum 750 ms between `page.goto` for the same worker
  (matches the existing `waitForTimeout(1000)`).
- 429 handling: on a `429`, exponential back-off (2s → 4s → 8s, cap 30s), then
  requeue the URL once. Second 429 => skip and record as `rate_limited`
  (NOT counted as a failure, but surfaced in the Discord summary so the team
  knows the crawl was incomplete).
- Transport for **link validation** (is a `href` alive?): use
  `page.request.fetch(href, { method: 'HEAD', maxRedirects: 0 })` first, fall
  back to `GET` on `405 Method Not Allowed` (CDNs and many CMSes do not
  implement HEAD). Keep a separate `checkedLinks: Map<string, status>` so each
  external URL is validated at most once per run.
- Redirect policy: follow up to 2 hops; chains of 3+ hops are a flag
  (`redirect_chain_too_long`).

### A2. Findings data model

Every defect is pushed into a single shared sink so the Discord reporter and
the JSON artifact can consume one format.

```ts
type Severity = 'error' | 'warn' | 'info';
type Finding = {
  url: string;            // page where the problem was seen
  check: string;          // e.g. 'broken-image', 'duplicate-image', 'button-disabled'
  severity: Severity;     // error fails the suite; warn is reported only
  message: string;        // human summary
  element?: {
    tag: string;          // 'img', 'a', 'button'
    selector?: string;    // best-effort CSS selector
    attr?: Record<string, string>;  // { src: '...', href: '...', alt: '' }
  };
  expected?: string;
  actual?: string;
  project: 'chromium' | 'Mobile Chrome' | 'webkit';
};
```

A findings collector singleton (`tests/utils/findings.ts`) accumulates in memory
and flushes to `test-results/findings.json` in an `afterAll` hook. The Discord
reporter reads the file at `onEnd` time (or subscribes via an event emitter
when findings are recorded).

### A3. Test file structure

Multiple files, each owning a concern:

```
tests/
  daily-sanity.spec.ts          (keep — fast 10-page pulse)
  directory-carticles.spec.ts   (keep — smoke of known canonical URLs)
  crawl-articles.spec.ts        (NEW — full /articles BFS with per-page checks)
  crawl-merchants.spec.ts       (NEW — sample N merchant pages, hero + form)
  link-hygiene.spec.ts          (NEW — validate every discovered href)
  accessibility.spec.ts         (NEW — axe-core pass on sampled pages)
  seo-meta.spec.ts              (NEW — title/meta/canonical/OG on sampled pages)
  utils/
    crawler.ts                  (BFS + queue + politeness)
    findings.ts                 (shared sink)
    checks/
      images.ts                 (broken, duplicate, missing hero)
      links.ts                  (href validation, rel=noopener, mailto/tel)
      buttons.ts                (visible+enabled verification)
      content.ts                (lorem ipsum, {{var}}, undefined/NaN leaks)
      seo.ts
      a11y.ts
    lead-api.ts                 (existing)
    discord-reporter.ts         (existing — enhance to read findings.json)
```

Why multiple files: Playwright's test IDs become the Discord line items. One
test per concern means "Link hygiene on /articles tree" shows up as a distinct
red/green signal instead of one monolithic "everything" test hiding the actual
failing check.

### A4. Pulse vs. audit split

Two entry points, controlled by env:

| Mode | Trigger | Scope | Target runtime |
|------|---------|-------|----------------|
| **Pulse** | `RECCE_MODE=pulse` (default — cron 08:30 UTC) | 10 random + 5 seeded = 15 pages, all checks | ≤ 5 min |
| **Audit** | `RECCE_MODE=audit` (new cron 03:00 UTC weekly, or manual) | full `/articles` tree, sampled merchants | ≤ 45 min |

`run-daily.sh` stays as-is (pulse). Add `run-audit.sh` that sets
`RECCE_MODE=audit` and `MAX_PAGES=2000` and posts to a separate Discord thread
so the high-volume findings don't drown the daily pulse channel.

Every `*.spec.ts` file checks `RECCE_MODE` and either `test.skip()`s or uses a
smaller sample size in pulse mode. Avoid writing two copies of each test — one
parametric test file driven by mode is cleaner.

### A5. 429 handling alignment

Keep the exact pattern already in `daily-sanity.spec.ts` (`status === 429 => log
and return`). Add one escalation: if the per-run 429 count exceeds
`RECCE_MAX_RATE_LIMITED` (default 10), the suite aborts early and posts a
"crawl incomplete — origin rate-limited" banner to Discord rather than producing
a misleading green run.

**Confidence: HIGH** — this mirrors patterns already in the repo; only new work
is the queue primitive and the findings sink.

---

## Section B — Implementation of the user's 5 checks

### B1. Broken / missing inline article-body images

Scope: images inside the article body, not chrome (header/footer logos,
sponsor pixels).

- Selector: `article img, main img, [data-article-body] img`. Fall back to
  `img:not(header img):not(footer img):not(nav img)` if no semantic container.
- Checks per image:
  1. `naturalWidth > 0 && naturalHeight > 0` after scroll-into-view and a
     1-second settle (handles lazy `loading="lazy"`).
  2. `currentSrc` responds `2xx` when HEADed (dedup via `checkedLinks`).
  3. If `loading="lazy"` or `data-src` pattern, scroll the element into view
     before measuring (Playwright's `scrollIntoViewIfNeeded`).
- Exemptions:
  - 1x1 tracking pixels: skip if both `naturalWidth <= 2` AND `naturalHeight <= 2`.
  - `src=""` with `data-src` still pending *and* outside viewport after full-page
    scroll → warn, not error (genuine lazy load).
  - `role="presentation"` or empty alt + 0 bytes → skip (decorative placeholders).
- Finding shape on failure:
  `check: 'broken-image', element: { tag: 'img', attr: { src, alt, loading } }, actual: 'naturalWidth=0' or 'HTTP 404'`.

### B2. Broken links / wrong destination

- Harvest every `<a[href]>` on every crawled page.
- Classify:
  - Internal (same origin): HEAD, expect `2xx` (also record redirects).
  - External: HEAD with 5s timeout; on network error emit `warn` not `error`.
  - `mailto:`, `tel:`, `sms:`: validate format only (`mailto:` must have `@`,
    `tel:` must be digits + `+ - ( )` only).
  - Protocol-relative `//example.com/...`: flag as `warn` (should be absolute
    `https://` on an HTTPS site).
- "Wrong destination" = soft check. We cannot know the *intended* destination,
  but we can flag likely bugs:
  - Href contains a template literal that wasn't interpolated:
    `{{`, `${`, `%7B%7B`, `<%`.
  - Href is the literal string `undefined`, `null`, or `[object Object]`.
  - Href points to `localhost`, `127.0.0.1`, `staging.`, `dev.` — leaked
    non-prod URL.
  - Internal link returns `200` but lands on a path containing `404`, `not-found`,
    `error` (some SPAs return 200 for their error page).
- Dedup: each unique href is validated once per run, cached in
  `checkedLinks`.
- Output finding on failure: includes `href`, `status`, `location` header
  value if redirected.

### B3. Merchant pages missing required images

Merchant URL pattern is well-defined: `/sites/en/<...>/<merchant>/<id>`.

- Required:
  - **Hero**: `img.object-cover` first-in-DOM, visible, `naturalWidth >= 400`
    (hero shouldn't be a thumbnail).
  - **At least one body image** beyond the hero (content richness check).
- Soft-check (warn):
  - `alt` on hero should be non-empty and NOT equal to the merchant's id slug
    (common bug: alt = slug-with-hyphens).
- Re-use the B1 broken-image check for each merchant image.
- Sample size: pulse = 5 merchants, audit = up to 200 (or all linked from any
  crawled article page).

### B4. Duplicate images on the same page

- Collect all `img.currentSrc` (after lazy-load settle) on the page, normalise
  by stripping query string (CDN cache-busters can make two identical images
  look unique).
- Count occurrences. Emit one finding per `src` appearing `>= 2` times, listing
  all selectors/positions.
- Exemptions:
  - The site logo legitimately appears in header + footer + schema image →
    allowlist URLs matching `/logo`, `/favicon`, `/apple-touch-icon`.
  - Pattern images used as CSS-like backgrounds on repeating cards (if seen
    on >= 10 positions, treat as "looks intentional, downgrade to warn").

### B5. Every button is clickable / enabled

- Selector: `button, [role="button"], a.btn, input[type="submit"], input[type="button"]`.
- For each visible one:
  - `isEnabled()` true
  - `isVisible()` true
  - Has accessible name (innerText trimmed, `aria-label`, or `title`)
  - `pointer-events !== 'none'` (computed style check)
- Don't actually click (clicks may trigger navigations / form submits that
  aren't idempotent — specifically the waitlist form). Use `isEnabled` +
  computed style as the proxy.
- Exempt `button[type="submit"]` inside a form that has `aria-busy="true"` or
  is inside a `<dialog>` hidden behind `<body aria-hidden="true">`.
- Finding includes the best-effort CSS selector (Playwright's
  `locator.evaluate` can extract the element's tag + classes + position).

**Confidence: HIGH** for B1, B3, B4, B5; **MODERATE** for B2 "wrong destination"
— the heuristics above catch common bugs but will never catch semantically
incorrect links (e.g. "Contact" linking to the About page). That's acceptable.

---

## Section C — Senior-engineer additions (ranked by ROI)

Not everything; just the highest-signal additions for a travel/directory
lead-gen site.

### C1. Sitemap integrity (HIGH ROI)

Why: For a directory site, the sitemap *is* the product surface. If a merchant
was onboarded but their URL isn't in the sitemap, Google will never index
it → zero leads. And if the sitemap lists 404s, crawl budget is wasted.

Checks:

- `/sitemap.xml` and `/robots.txt` return 200 and parse.
- Every `<loc>` in the sitemap resolves `2xx` (sampled in pulse, fully crawled
  in audit).
- `lastmod` dates are not in the future.
- Sitemap URL count should not drop by >20% vs. last run (regression signal).
  Store the count in `test-results/sitemap-baseline.json`.
- `robots.txt` allows `Googlebot` for `/articles/` and `/sites/` (production
  must not accidentally ship `Disallow: /`).

### C2. SEO meta-integrity on every crawled page (HIGH ROI)

Directory sites live and die by SEO. Checks per page:

- `<title>` present, length 30–65 chars, not `undefined` / blank.
- `<meta name="description">` present, length 50–160.
- Exactly one `<h1>`, non-empty, not duplicated verbatim across siblings in the
  city/category.
- `<link rel="canonical">` present, self-referential to the same URL (or a
  deliberate canonical target), absolute URL, no trailing slash inconsistency.
- Open Graph minimum: `og:title`, `og:description`, `og:image`, `og:url`.
  Especially `og:image` must resolve 2xx — broken OG images degrade share CTR.
- JSON-LD schema blocks parse as valid JSON. For `/sites/...` (merchant) pages,
  expect `@type: LocalBusiness` or `Place`; for articles, `@type: Article`.
- `<html lang="...">` is set and matches the URL locale (`/articles/en/...`
  should be `lang="en"`).
- `hreflang` tags (if present) all resolve 2xx.

### C3. JS runtime errors + failed fetches (HIGH ROI)

On every page visit, attach:

- `page.on('console', ...)` — record any `error`-level message.
- `page.on('pageerror', ...)` — record uncaught exceptions.
- `page.on('requestfailed', ...)` — record any `failed` request whose URL is
  the same origin (external tracker failures are warn-only).

Any recorded entry becomes a finding with the URL as the page-under-test.
Catches: 500-throwing API calls, CSP violations, React hydration errors that
degrade interactivity without visually breaking the page.

### C4. Content-quality leaks (HIGH ROI, low cost)

Regex the rendered body text for:

- `\bLorem ipsum\b` (authoring leak)
- `\{\{[\w.]+\}\}` (unresolved Handlebars)
- `\$\{[\w.]+\}` (unresolved template literal)
- `\bundefined\b`, `\bNaN\b`, `\bnull\b` appearing outside of `<code>`, `<pre>`
- `\[object Object\]` (JS toString leak)
- Empty-heading detection: `<h1>`, `<h2>`, `<h3>` with zero non-whitespace text.

Why: these are the cheapest checks on the list and they catch obviously-broken
renders that users silently bounce on.

### C5. Mobile responsiveness — no horizontal scroll (MEDIUM ROI)

The suite already runs `Mobile Chrome`. Add on every crawled page:

- `document.documentElement.scrollWidth <= window.innerWidth + 1` (1px tolerance).
- Every `button` and `a.btn` has a bounding box of ≥ 44×44 CSS px (WCAG tap-target).

High value because travel-site traffic is mobile-heavy and horizontal scroll
is an immediate bounce trigger.

### C6. Accessibility via axe-core sampled (MEDIUM ROI)

Use `@axe-core/playwright`. Run on 10 sampled pages per run (not every page —
expensive). Report `serious` and `critical` violations only. Specifically watch
for:

- `image-alt` (missing alt on content images)
- `link-name` (empty link text — common from icon-only links)
- `color-contrast` (hero overlays often fail)
- `document-title` (covered by C2)

### C7. target=\"_blank\" without rel=\"noopener\" (LOW COST, HIGH SECURITY ROI)

Trivial to check, prevents reverse-tabnabbing. Every `a[target=_blank]` must
have `rel` containing `noopener` (and ideally `noreferrer`).

### C8. Mixed content on HTTPS (HIGH SECURITY ROI)

On an HTTPS page, flag any `img[src^="http:"]`, `script[src^="http:"]`,
`link[href^="http:"]` in stylesheets, `iframe[src^="http:"]`. Browsers block
these and log a console error — partial overlap with C3 but worth an
explicit check because users on strict browsers silently see broken images.

### C9. Redirect-chain detection (MEDIUM ROI)

Already mentioned in A1. A redirect chain of 3+ is almost always a bug
(trailing-slash loop, locale redirect on top of canonical rewrite). Flag
chains > 2. Very common after a routing refactor — which is exactly what
happened to `/directory → /articles`.

### C10. Custom 404 / 500 page smoke (LOW COST)

Explicitly hit `/articles/en/this-definitely-does-not-exist-<timestamp>` and
assert the response is 404 AND the rendered page still has the site chrome
(nav, footer, a link back home). Catches the "error page itself is broken"
class of bug.

### C11. Canonical-URL duplication detection (MEDIUM ROI, audit mode)

During the full crawl, build a `Map<canonical, Set<url>>`. If two different
URLs claim the same canonical but neither is *that* canonical URL, something
is misconfigured. Common source: `/articles/en/Mexico/...` vs
`/articles/en/mx/...` both pointing at one, but the other is not redirected.

### C12. Performance signals — lightweight (LOW priority, skip in pulse)

Not a full Lighthouse pass. Just:

- Page weight: sum of all response bodies > 5 MB → warn.
- More than 3 render-blocking scripts → warn.
- LCP element present and not an off-screen image.

Full Lighthouse is a separate future feature — out of scope for this plan.

### Explicitly DEFERRED

- **External link validation as an error condition.** Always warn-only;
  external sites change outside our control. Track trend over time instead.
- **Color contrast outside of axe.** Too noisy to implement from scratch; axe
  already covers it.
- **Full Lighthouse audit.** Separate tool, separate cadence.
- **Form validation deep-dive.** The existing `lead-api.ts` covers the happy
  path; negative-path form testing (empty email, malformed email, rapid
  double-submit) is a separate "forms" plan.

**Confidence: HIGH** on C1–C4, C7, C8, C10 (cheap, proven patterns).
**Confidence: MODERATE** on C5, C6, C9, C11 (require calibration — expect to
  tune thresholds after first audit run reveals baseline).

---

## Section D — Reporting

### D1. JSON artifact

Write `test-results/findings.json` with the shape:

```json
{
  "run": {
    "startedAt": "...",
    "finishedAt": "...",
    "mode": "pulse | audit",
    "baseURL": "https://valors.io",
    "pagesCrawled": 127,
    "rateLimited": 2,
    "findings": { "error": 4, "warn": 11, "info": 0 }
  },
  "byUrl": {
    "/articles/en/mx/jalisco/guadalajara/restaurants": [
      { "check": "broken-image", "severity": "error",
        "element": { "tag": "img", "attr": { "src": "https://cdn/...jpg" } },
        "actual": "HTTP 404" },
      { "check": "duplicate-image", "severity": "warn", ... }
    ]
  },
  "byCheck": {
    "broken-image": [ ... ],
    "link-404": [ ... ]
  }
}
```

The double index (`byUrl` and `byCheck`) makes both triage flows fast:
"what's broken on *this page*" vs. "which pages have broken images".

### D2. Discord reporter enhancements

Current reporter shows test names + truncated error messages. Enhancement:

1. When `findings.json` exists at `onEnd`, load it and build a richer embed.
2. Top block: run summary (pages crawled, errors, warns, rate-limited count).
3. Failures block: show the top 10 URLs by error count, each as one line:
   `:x: /articles/.../guadalajara/restaurants — 3 errors (broken-image x2, button-disabled x1)`.
4. If more than 10 failing URLs, append `... and N more — see findings.json`
   and upload the JSON as a Discord attachment (webhook supports file uploads
   via multipart).
5. Distinct color codes:
   - Green: 0 errors, 0 warns.
   - Yellow: 0 errors, ≥1 warn.
   - Red: ≥1 error.
6. One embed per severity class so red-flag errors aren't visually drowned by
   warns.

### D3. Per-check drill-down

When `RECCE_VERBOSE=1`, a second Discord message per failing check type:
`broken-image (7 total)` → short table of `url | src | status`. Off by default
to keep the channel quiet.

**Confidence: HIGH** — Discord webhook file-upload is a well-known pattern and
the JSON shape is straightforward.

---

## Section E — Risks & tradeoffs

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Full crawl overwhelms origin → 429 storm | Medium | High (crawl incomplete, potential prod impact) | Hard concurrency cap 2, 750ms min delay, backoff, abort on `> N` 429s, run audit in off-peak (03:00 UTC) |
| Discord report too large (2000+ findings) | High in audit mode | Medium (unreadable) | Top-10 URLs in embed; full detail as attached JSON; per-check drill-down opt-in |
| External link flakiness fails suite | High | Medium (false alarms) | External links always `warn`, never `error` |
| 3 browser projects × full crawl = 6h+ wall time | High | High | Audit crawl runs on **chromium only**; pulse runs on all 3 (small sample). Mobile is only used for the responsive check sampled subset |
| Flaky lazy-image detection (network-idle ≠ image-loaded) | Medium | Medium (false `broken-image` reports) | Scroll-into-view + `waitForFunction(img => img.complete && img.naturalWidth)` with 5s cap; retry once before recording |
| Findings sink race conditions with `fullyParallel: true` | Low (workers: 1) | High if re-parallelized | Use append-only JSONL during run, consolidate to JSON in `globalTeardown` |
| Axe-core adds 2–5s per page → budget blows | Medium | Medium | Sample 10 pages only for axe, never full crawl |
| Canonical deduplication detection is mode-sensitive | Medium | Low | Only run in audit (needs full crawl to be meaningful) |
| Baseline drift (sitemap count, etc.) | Medium | Low | Store baseline files in `test-results/baselines/`; warn on > 20% deviation, don't fail |
| Retries on a real outage mask the signal | Low | High | `retries: process.env.CI ? 2 : 0` already; for crawl suite set `retries: 0` so flakiness is visible, rely on per-check internal retry |

---

## Section F — Phased rollout

Each phase is a shippable PR. Stop at any phase and you still have value.

### Phase 1 — Findings infrastructure (FOUNDATION)

**Files created:**

- `tests/utils/findings.ts` — shared sink, JSON writer
- `tests/utils/types.ts` — `Finding`, `Severity` types
- Update `tests/utils/discord-reporter.ts` — read `findings.json` and emit
  richer embed; add attachment support

**Tests:**

- Unit-like test that asserts a fake finding ends up in `findings.json`
- Verify Discord reporter still works when `findings.json` is absent

**Acceptance:**

- [ ] Existing suite still passes unchanged
- [ ] `findings.json` is written to `test-results/`
- [ ] Discord embed shows per-URL grouping when findings exist

**Effort:** Small. **Confidence: HIGH.**

### Phase 2 — Crawler primitive + /articles tree BFS

**Files created:**

- `tests/utils/crawler.ts` — BFS queue, politeness, 429 handling, sitemap parse

**Files modified:**

- `tests/daily-sanity.spec.ts` — switch to new crawler primitive (still
  samples 10 in pulse mode, but discovery is uniform)

**Tests:**

- `tests/crawl-articles.spec.ts` — new test; in pulse mode crawls 25 pages
  max and runs only existing "has body, has image" checks. No new checks yet.

**Acceptance:**

- [ ] Crawler respects `MAX_PAGES`, `MAX_DEPTH`, concurrency = 2
- [ ] 429s trigger backoff, second 429 records `rate_limited` finding
- [ ] Sitemap URLs seed the crawl when available
- [ ] Pulse run still completes in ≤ 5 min

**Effort:** Medium. **Confidence: HIGH.**

### Phase 3 — User's 5 explicit checks

**Files created:**

- `tests/utils/checks/images.ts` — broken, duplicate, hero-missing
- `tests/utils/checks/links.ts` — href validation + mailto/tel format
- `tests/utils/checks/buttons.ts` — visible + enabled

**Files modified:**

- `tests/crawl-articles.spec.ts` — invoke all three check modules per page
- `tests/crawl-merchants.spec.ts` (new) — invoke merchant-specific checks

**Acceptance:**

- [ ] Injecting a known-broken image in staging produces exactly one
      `broken-image` finding with the correct src
- [ ] Duplicate-image check ignores whitelisted logos/favicons
- [ ] Button check does not actually click (no side-effects)
- [ ] Merchant hero check enforces `naturalWidth >= 400`

**Effort:** Medium. **Confidence: HIGH.**

### Phase 4 — Reporting polish

**Files modified:**

- `tests/utils/discord-reporter.ts` — per-URL grouping, attachment upload
- `run-daily.sh` — no change
- New `run-audit.sh` with `RECCE_MODE=audit`

**Acceptance:**

- [ ] Runs with < 10 failing URLs show inline in Discord
- [ ] Runs with > 10 failing URLs attach `findings.json`
- [ ] Color codes differentiate error vs. warn-only
- [ ] Rate-limit count surfaced prominently

**Effort:** Small. **Confidence: HIGH.**

### Phase 5 — High-ROI senior-engineer checks

**Files created:**

- `tests/utils/checks/seo.ts` (C2)
- `tests/utils/checks/content.ts` (C4 — lorem, handlebars, undefined)
- `tests/utils/checks/runtime-errors.ts` (C3 — console + pageerror + requestfailed)
- `tests/utils/checks/security.ts` (C7 noopener + C8 mixed content)
- `tests/seo-meta.spec.ts`, `tests/runtime-errors.spec.ts`

**Acceptance:**

- [ ] Every crawled page emits 0 SEO findings on a green run
- [ ] Console-error listener catches a seeded test error
- [ ] Mixed-content check flags a test `http://...` image injection

**Effort:** Medium. **Confidence: HIGH** (all patterns are well-known).

### Phase 6 — Sitemap + robots integrity

**Files created:**

- `tests/sitemap.spec.ts` (C1)
- `test-results/baselines/sitemap-count.json` (written, not committed)

**Acceptance:**

- [ ] Sitemap parse + URL-count baseline works
- [ ] >20% drop produces a `sitemap-regression` finding

**Effort:** Small. **Confidence: HIGH.**

### Phase 7 — Accessibility + mobile responsive

**Files created:**

- `tests/accessibility.spec.ts` (C6 — axe-core, sampled 10 pages)
- `tests/utils/checks/responsive.ts` (C5 — no horizontal scroll, tap-target)

**Dependencies:** `@axe-core/playwright`.

**Acceptance:**

- [ ] Axe runs on 10 sampled pages, reports `serious`+`critical` only
- [ ] Responsive check runs only on `Mobile Chrome` project
- [ ] Pulse runtime still ≤ 5 min

**Effort:** Medium. **Confidence: MODERATE** (axe thresholds will need
calibration — expect 1–2 iterations to set the right severity floor).

### Phase 8 — Audit-mode enrichments

**Files created:**

- `tests/canonical-duplicates.spec.ts` (C11)
- `tests/redirect-chains.spec.ts` (C9)
- `tests/custom-error-pages.spec.ts` (C10)

**Changes:**

- Cron: `run-audit.sh` scheduled weekly at 03:00 UTC, posts to
  `#recce-audit` Discord channel (different webhook env var).

**Acceptance:**

- [ ] Weekly audit produces < 200 findings on a clean site
- [ ] Canonical-duplicate detection finds a deliberately-seeded dup in staging

**Effort:** Medium. **Confidence: MODERATE** (canonical analysis depends on
full-crawl completeness; thresholds may need tuning).

---

## Success criteria

1. A deliberately broken image pushed to staging is surfaced in the next
   pulse run with the exact URL and `src` in the Discord message.
2. A deliberately 404-linking article in staging is surfaced within the same
   run.
3. Daily pulse runtime stays under 5 minutes across chromium / Mobile Chrome /
   webkit projects combined.
4. Weekly audit completes within 45 minutes on chromium only, covering the
   full `/articles` tree + 200 merchant pages.
5. `findings.json` is a stable artifact consumable by downstream tooling
   (dashboards, learning extractors).
6. When origin rate-limits us, the run explicitly reports "crawl incomplete"
   rather than falsely reporting green.

---

## Open questions

- [ ] Should external-link *dead* detection be a pulse check or audit-only?
      Current proposal: audit-only, as external flakiness pollutes the daily
      signal.
- [ ] Which Discord channel / webhook for audit-mode vs. pulse-mode output?
      Proposal: separate env var `RECCE_AUDIT_DISCORD_WEBHOOK`.
- [ ] Is there a staging environment we can deliberately break to validate
      each check's false-negative rate? If not, add a
      `tests/fixtures/seeded-bugs/` route in the app for this purpose.
- [ ] Sitemap baseline storage: commit to repo, or stash in
      `/tmp/recce-baselines/`? Committing gives historical trend, but churns
      diff noise. Recommend: keep in `test-results/` (gitignored) and
      optionally sync to S3 / a gist for history.
- [ ] Should the pulse suite gate merges on other repos? Out of scope for
      this plan, but worth flagging for follow-up.

---

## Confidence Assessment

| Phase | Confidence | Notes |
|-------|-----------|-------|
| Phase 1 — Findings infra | HIGH | Straightforward, patterns exist |
| Phase 2 — Crawler + BFS | HIGH | Mirrors existing rate-limit handling |
| Phase 3 — User's 5 checks | HIGH | All checks have well-known DOM/network patterns |
| Phase 4 — Reporting polish | HIGH | Discord webhook attachments are standard |
| Phase 5 — SEO / content / runtime | HIGH | Proven check library |
| Phase 6 — Sitemap integrity | HIGH | Simple XML parse + baseline |
| Phase 7 — a11y + responsive | MODERATE | Axe thresholds need calibration |
| Phase 8 — Audit enrichments | MODERATE | Canonical / redirect thresholds need tuning |

**Overall plan confidence: MODERATE** (minimum across phases). The plan is
ready to execute through Phase 6 with high confidence. Phases 7–8 may need
threshold tuning in their first post-deploy week — acceptable because they
default to `warn` severity until calibrated.

No section ended up LOW after analysis, so no spike/prototype is required
before starting. Phase 7 is the most likely place for a follow-up tuning PR.
