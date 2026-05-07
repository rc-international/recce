# Feature Plan: Recce Full Frontend Tester for valors.io

Created: 2026-04-23 (revised)
Author: architect-agent (rev. 2, incorporating plan-reviewer + validate-agent + adversarial + oracle review)

## Overview

Expand Recce from a 10-page random sanity sampler into a full frontend tester
that crawls the entire `/articles` tree and a representative slice of `/sites`
(merchant) pages, producing per-URL, per-element failure reports delivered via
Discord and a JSON artifact. The tester is split into a fast "pulse" suite that
runs every scheduled cron on chromium only and a deep "audit" suite that runs
weekly across all three browser projects, so the daily Discord signal stays
actionable while deep regressions are still caught within a week.

The split was reversed versus the first draft: chromium-only pulse keeps the
daily signal fast and reliable; all three projects (chromium, Mobile Chrome,
webkit) run in the weekly audit so browser-specific bugs are still caught
without inflating the daily runtime.

Key architectural shifts from the first draft:

- JSONL write-through from every worker, consolidated at teardown, is **mandatory
  from Phase 1** — not a deferred mitigation. Chromium OOM mid-run must not lose
  findings.
- Findings files are run-scoped (`<mode>-<ISOts>.json`) with a symlink
  (`findings-latest.json`) so pulse + audit can run concurrently without
  clobbering each other.
- 404 detection for SPAs uses DOM signals (title, `<h1>`, body text length), not
  a path-substring heuristic.
- Pulse = chromium only; Audit = chromium + Mobile Chrome + webkit.
- `page.route()` fixtures replace any staging-environment dependency for
  seeded-bug validation.

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
- [ ] Operational concerns — PID locks, baseline storage, origin pre-flight,
      webhook failure escalation — covered explicitly (Section G)

---

## Section A — Architecture

### A1. Crawl strategy

Bounded BFS with a shared work queue.

**Seeding (ordered fallback chain):**

1. `robots.txt` — parse any `Sitemap:` directives first (authoritative).
2. Sitemap index — if a `<sitemapindex>` root is found, recurse into each
   child sitemap.
3. Gzipped sitemaps — support `sitemap.xml.gz` (inflate before parsing).
4. Direct `/sitemap.xml` — final fallback.
5. `seedUrls` list — used when all of the above fail or return empty.

**Sitemap validation gate (enforced in Phase 2, not deferred):**

- HTTP status must be 2xx.
- `Content-Type` response header must contain `xml` (case-insensitive). This
  guards against SPA catch-all routes returning HTML 200 for `/sitemap.xml`.
- Parsed document root must be `<urlset>` or `<sitemapindex>`.
- If any check fails, emit one `sitemap-parse-failed` finding (severity `warn`)
  and fall back to the next seed source in the chain. Do not abort the run.

**Discovery rule:** only enqueue URLs whose pathname starts with `/articles/`
or `/sites/`. Everything else is a candidate for the *link-validation* check
but not for *re-crawl*.

**Normalisation:** single canonical function exported from
`tests/utils/checks/images.ts` (see B1+B4 contract). Strips trailing slash,
lowercases host, drops tracking params (`utm_*`, `gclid`, `fbclid`). For image
URLs, strips query strings only from known image-CDN hosts (configurable via
`RECCE_IMAGE_CDN_HOSTS`).

**Depth and page caps:**

- `MAX_DEPTH` env default = **7** (covers
  `/articles/en/Mexico/CDMX/Ciudad-de-Mexico/coffee_shop/best-coffee-shops-mexico-city`
  without hitting the cap).
- `MAX_PAGES` env defaults: pulse = 50, audit = 2000.

**Coverage rotation when sitemap > MAX_PAGES (audit only):**

- Shuffle URLs with a deterministic seed derived from the UTC date stamp so
  one day's crawl is reproducible but the next day's is different.
- Record sampled URL hash-buckets in `test-results/baselines/coverage.json`.
- Round-robin across weekly audits so full coverage cycles over
  `ceil(sitemap_count / MAX_PAGES)` runs.

**Concurrency & politeness:**

- Hard cap 2 concurrent `page.goto` against prod (mirrors existing suite).
- Minimum 750 ms between `page.goto` per worker.
- Local override via `CRAWL_CONCURRENCY`.

**Rate-limit handling:**

- On 429: exponential backoff (2s → 4s → 8s, cap 30s) with 0–250 ms random
  jitter added to each delay. Requeue the URL once.
- Parse `Retry-After` header explicitly on 429 and 503; use it if present
  instead of the backoff formula.
- Second 429 on the same URL → skip, record `rate_limited` finding (not a
  failure, but surfaced in the Discord summary).
- If per-run 429 count exceeds `RECCE_MAX_RATE_LIMITED` (default 10), abort
  early and post a "crawl incomplete — origin rate-limited" banner instead of
  producing a misleading green run.

**Link validation transport:**

- `page.request.fetch(href, { method: 'HEAD', maxRedirects: 0 })` first.
- Fall back to `GET` on 405.
- Maintain `checkedLinks: Map<string, status>` so each URL is validated at
  most once per run.

**Redirect-chain detection (manual hop-follow):**

- With `maxRedirects: 0`, implement a loop: fetch → if 3xx, record
  `(url, Location)` in the chain → follow `Location` up to
  `MAX_REDIRECT_HOPS=5`.
- Detect cycles via set membership.
- Flag chains ≥ 3 as `redirect_chain_too_long` finding.

**Crawler extensibility point (added in Phase 2, consumed in Phase 5a):**

- `pageHooks: ((page: Page) => Promise<void>)[]` on the crawler config.
- Hooks attach `page.on(...)` listeners before navigation (needed for runtime
  error listeners, etc.).

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
    attr?: Record<string, string>;
  };
  expected?: string;
  actual?: string;
  project: 'chromium' | 'Mobile Chrome' | 'webkit';
};

type Run = {
  schemaVersion: 1;       // increment on breaking changes; additive fields are non-breaking
  startedAt: string;
  finishedAt: string;
  mode: 'pulse' | 'audit';
  baseURL: string;
  pagesCrawled: number;
  rateLimited: number;
  findingCounts: { error: number; warn: number; info: number };
};
```

**Schema versioning policy:**

- Bump `schemaVersion` only on breaking changes (removing a field, changing
  a field's type, renaming).
- Additive changes (new optional fields) keep the version.
- A changelog block at the top of `tests/utils/types.ts` records every bump
  with a date and migration note.
- Phase 1 ships a `zod` schema validator unit test asserting that emitted
  findings parse cleanly and that a known-invalid finding rejects.

**Write-through (mandatory, Phase 1):**

- Every `findings.push(...)` call also runs
  `fs.appendFileSync('test-results/findings.jsonl', JSON.stringify(f) + '\n')`.
- `globalTeardown` reads the JSONL, parses each line, groups by URL and check,
  and writes the consolidated run-scoped `findings/<mode>-<ISOts>.json` plus
  updates the `findings-latest.json` symlink.
- **Sentinel:** if the consolidated file is absent at `onEnd` time, the
  Discord reporter must escalate via
  `wilco-notify --level error --title "Recce report lost" "<details>"` instead
  of reporting green. Green-when-lost is the worst possible failure mode.

**Concurrency:**

- JSONL append is atomic for small writes; multiple workers writing at once
  are safe because each line is self-contained.
- Run-scoped filenames (`<mode>-<ISOts>.json`) avoid pulse-vs-audit
  overwrites even if both run simultaneously.

### A3. Test file structure

Multiple files, each owning a concern:

```text
tests/
  daily-sanity.spec.ts           (keep — migrated to new crawler primitive in Phase 2)
  directory-carticles.spec.ts    (keep — smoke of known canonical URLs)
  crawl-articles.spec.ts         (NEW — /articles BFS with per-page checks)
  crawl-merchants.spec.ts        (NEW — sample N merchant pages, hero + form)
  link-hygiene.spec.ts           (NEW — validate every discovered href)
  seo-meta.spec.ts               (NEW — title/meta/canonical/OG + charset/viewport/BCP-47)
  runtime-errors.spec.ts         (NEW — console + pageerror + requestfailed)
  accessibility.spec.ts          (NEW — axe-core pass on sampled pages)
  consent-trackers.spec.ts       (NEW — GDPR pre-consent tracker detection, C14)
  hreflang.spec.ts               (NEW — bidirectional hreflang + language-content, C15)
  security-headers.spec.ts       (NEW — CSP/HSTS/XCTO one-shot, C16)
  canonical-duplicates.spec.ts   (NEW — audit only, C11 + C17)
  redirect-chains.spec.ts        (NEW — audit only, C9)
  custom-error-pages.spec.ts     (NEW — C10)
  sitemap.spec.ts                (NEW — C1 integrity + coverage rotation)
  perf-signals.spec.ts           (NEW — LCP preload + page weight, C18 + C12)
  fixtures/
    seeded-bugs.ts               (NEW — page.route() harness for check validation)
  utils/
    crawler.ts                   (BFS + queue + politeness + pageHooks)
    findings.ts                  (shared sink, JSONL write-through)
    types.ts                     (Finding, Run, schemaVersion + changelog)
    trackers.ts                  (GDPR tracker hostname blocklist)
    checks/
      images.ts                  (broken, duplicate, hero, CLS dims, oversized)
      links.ts                   (href validation, mailto/tel, protocol-relative)
      buttons.ts                 (visible + enabled, reCAPTCHA exemption)
      content.ts                 (lorem, {{var}}, undefined/NaN/[object Object])
      seo.ts                     (locale-aware thresholds)
      runtime-errors.ts          (console/pageerror/requestfailed)
      security.ts                (noopener + mixed content)
      security-headers.ts        (CSP/HSTS/XCTO/XFO/RP/PP)
      trackers.ts                (pre-consent detection + cookie inventory)
      hreflang.ts                (reciprocity + stopword density)
      a11y.ts                    (scoped axe-core with dedup)
      responsive.ts              (horizontal scroll + tap-target)
      selector-health.ts         (C13 meta-check)
      perf.ts                    (LCP, preload, page weight)
      canonical.ts               (duplicates, orphans, noindex leak)
    lead-api.ts                  (existing)
    discord-reporter.ts          (existing — enhanced, JSONL-aware)
```

### A4. Pulse vs. audit split

Two entry points, controlled by env:

| Mode | Trigger | Projects | Scope | Target runtime |
|------|---------|----------|-------|----------------|
| **Pulse** | `RECCE_MODE=pulse` (default — cron 08:30 UTC) | chromium only | 15 pages (10 random + 5 seeded), fast checks | ≤ 5 min |
| **Audit** | `RECCE_MODE=audit` (weekly cron 03:00 UTC) | chromium + Mobile Chrome + webkit | Up to 2000 pages, all checks | ≤ 45 min |

**Runtime budget proof (pulse):**

```text
pulse pages            = 15
avg page.goto (ms)     = 3500   (navigation + waitForLoadState)
avg per-page checks ms = 2500   (DOM scan + HEAD sampling, cached across URLs)
per-page total (ms)    = 6000
crawl serial (workers=1, but some fetches cached)
  = 15 × 6000 = 90_000 ms = 1.5 min

crawler overhead       = ~30 s   (sitemap fetch, seeding, teardown, reporter)
total                  = ~2 min  (well under 5-min budget)
```

Even with 3× safety margin for first-run network variance, pulse stays under
5 min on chromium-only.

**Audit budget proof (chromium only, Mobile Chrome and webkit run in parallel
via Playwright projects, so wall time ≈ max, not sum):**

```text
audit pages            = 2000
avg page.goto (ms)     = 4500
avg per-page checks ms = 5000   (axe adds cost, but scoped+deduped)
per-page total (ms)    = 9500
worker count           = 2 (politeness cap)
effective throughput   = ~10_500 ms per 2 pages → 5250 ms/page
serial wall time       = 2000 × 5250 = 10_500_000 ms = 175 min

Note: this exceeds 45 min on a single project. Mitigation:
  - Coverage rotation (A1) caps any single audit run at MAX_PAGES
  - MAX_PAGES for audit may be tuned down to ~500 if 175 min is too long
  - Mobile Chrome + webkit reuse chromium's findings for shared checks
    (SEO meta, content, link hygiene) and only re-run rendering-specific checks
    (responsive, layout).
```

Acceptance: Phase 8's first real-world audit run must come in under 45 min
for chromium; if not, `MAX_PAGES` drops to 500 and coverage rotation carries
the rest across subsequent weeks.

**Confidence: HIGH** — this mirrors patterns already in the repo; only new
work is the queue primitive and the findings sink.

### A5. 429 handling alignment

Keep the exact pattern already in `daily-sanity.spec.ts` (`status === 429` →
log and return). Extended behaviour (backoff with jitter, `Retry-After`
parsing, requeue once, escalation on `>N` 429s) is documented in A1.

---

## Section B — Implementation of the user's 5 checks

### B1. Broken / missing inline article-body images

Scope: images inside the article body, not chrome (header/footer logos,
sponsor pixels).

- **Selector:** `article img, main img, [data-article-body] img`. Fall back to
  `img:not(header img):not(footer img):not(nav img)` if no semantic container.
- **Checks per image:**
  1. `naturalWidth > 0 && naturalHeight > 0` **AND** `img.complete === true`
     after scroll-into-view and a 1-second settle. Both conditions guard
     against stale cached values where `naturalWidth` lies.
  2. `currentSrc` responds 2xx when HEADed (dedup via `checkedLinks`).
  3. If `loading="lazy"` or `data-src` pattern, scroll the element into view
     before measuring (`scrollIntoViewIfNeeded`).
  4. **New CLS prevention:** image has `width` and `height` attributes or an
     inline style with explicit dimensions. Missing = `warn`
     `image-missing-dimensions`.
  5. **New oversized check:** if `naturalWidth / renderedWidth > 2` AND
     `renderedWidth > 0`, image is oversized (bandwidth waste) → `warn`
     `image-oversized`.
- **Exemptions:**
  - 1×1 tracking pixels: skip if `naturalWidth ≤ 2 && naturalHeight ≤ 2`.
  - `src=""` with pending `data-src` outside viewport after full-page scroll
    → `warn`, not `error` (genuine lazy load).
  - `role="presentation"` or empty alt + 0 bytes → skip (decorative
    placeholders).
- **Finding shape on failure:** `check: 'broken-image',
  element: { tag: 'img', attr: { src, alt, loading } }, actual: 'naturalWidth=0'
  | 'HTTP 404' | 'img.complete=false'`.

### B2. Broken links / wrong destination

- Harvest every `<a[href]>` on every crawled page.
- Classify:
  - Internal (same origin): HEAD, expect 2xx (record redirects).
  - External: HEAD with 5s timeout; on network error emit `warn`.
  - `mailto:`, `tel:`, `sms:`: validate format only (`mailto:` must have `@`,
    `tel:` must be digits + `+ - ( )` only).
  - Protocol-relative `//example.com/...`: flag `warn` (should be absolute
    HTTPS on an HTTPS site).
- **"Wrong destination" heuristics:**
  - Href contains uninterpolated template literal: `{{`, `${`, `%7B%7B`, `<%`.
  - Href is literal `undefined`, `null`, `[object Object]`.
  - Href points to `localhost`, `127.0.0.1`, `staging.`, `dev.` (leaked
    non-prod URL).
- **Primary 404-detection signal (SPA-safe, replaces path-substring
  heuristic):**
  - After HEAD returns 2xx for an internal link, issue GET.
  - Load the URL via Playwright `page.goto`.
  - Check ALL of:
    - `document.title` does not match
      `/not found|404|error|página no encontrada|página não encontrada/i`
    - `<h1>` text does not match the same regex
    - Body text length > 100 characters
  - Any check failing → emit `soft-404` finding (`error` severity).
  - Sample rate: every unique internal href once per run (cached).
- **Dedup:** each unique href validated once per run, cached in `checkedLinks`.
- **Finding output:** includes `href`, `status`, `Location` header value on
  redirect.

### B3. Merchant pages missing required images

Merchant URL pattern: `/sites/en/<...>/<merchant>/<id>`.

- **Required:**
  - Hero: `img.object-cover` first-in-DOM, visible, `naturalWidth ≥ 400`
    (hero must not be a thumbnail).
  - At least one body image beyond the hero.
- **Soft (warn):** hero `alt` non-empty and NOT equal to the merchant's id
  slug.
- **Reuse** B1 broken-image check for each merchant image.
- **Sample size:** pulse = 5 merchants, audit = up to 200 (or all linked from
  any crawled article).
- **No staging dependency:** validation tests use `page.route()` fixtures in
  `tests/fixtures/seeded-bugs.ts` to intercept requests to known URLs and
  return deliberately-broken responses. Each check has a unit-like test
  asserting exactly one finding of the expected shape.

### B4. Duplicate images on the same page

- Collect all `img.currentSrc` after lazy-load settle.
- Normalise via the canonical URL-normalisation function shared with B1 (see
  B1+B4 contract below).
- Count occurrences. Emit one finding per `src` appearing ≥ 2 times, listing
  all selectors/positions.
- **Allowlist (configurable):** `RECCE_DUPLICATE_EXEMPT_PATTERNS`
  (comma-separated, defaults: `/logo,/favicon,/apple-touch-icon,/brand`).
  Match on the path component after the last `/`, not substring match.
- **Intentional-pattern downgrade:** images appearing ≥ 10 positions treated
  as "looks intentional", severity drops to `warn`.

**B1 + B4 URL-normalisation contract (single source of truth in
`tests/utils/checks/images.ts`):**

```text
normaliseImageUrl(url: string): string
  Purpose: produce a stable key for dedup and caching.
  Inputs: any absolute or protocol-relative URL.
  Behaviour:
    - Lowercase host.
    - Strip trailing slash from path.
    - If host matches RECCE_IMAGE_CDN_HOSTS (comma-separated, default list):
        drop query string entirely.
    - Else: preserve query string (arbitrary query params may be semantic).
    - Drop fragment.
  Used by: B1 (HEAD dedup via checkedLinks) and B4 (duplicate-image counter).
```

### B5. Every button is clickable / enabled

- **Selector:** `button, [role="button"], a.btn, input[type="submit"],
  input[type="button"]`.
- **Per visible element, assert:**
  - `isEnabled()` true
  - `isVisible()` true
  - Accessible name present (innerText trimmed, `aria-label`, or `title`)
  - `pointer-events !== 'none'` (computed style check)
- **Do NOT click** — avoids triggering form submits (specifically the
  waitlist form). `isEnabled` + computed style is the proxy.
- **Exemptions:**
  - `button[type="submit"]` inside a form with `aria-busy="true"` or inside a
    hidden `<dialog>` behind `<body aria-hidden="true">` → skip.
  - **reCAPTCHA-managed:** buttons inside `form[data-recaptcha]`, or buttons
    that transition from enabled to disabled within 500 ms of page load, are
    classified `recaptcha-managed` with `info` severity and a descriptive
    note. Detection: on page load, record initial enabled state; wait 500 ms;
    re-check.
- **Finding shape:** best-effort CSS selector via `locator.evaluate` (tag +
  classes + position).

**Confidence: HIGH** for B1, B3, B4, B5; **MODERATE** for B2 "wrong
destination" — heuristics catch common bugs but not semantic intent.

---

## Section C — Senior-engineer additions (ranked by ROI)

### C1. Sitemap integrity (HIGH ROI)

- `/robots.txt` and `/sitemap.xml` return 200 and parse (with content-type
  gate from A1).
- Every `<loc>` resolves 2xx (sampled in pulse, fully crawled in audit with
  coverage rotation from A1).
- `lastmod` dates not in the future.
- URL count does not drop by > 20% vs baseline (stored in
  `test-results/baselines/sitemap-count.json`).
- `robots.txt` allows `Googlebot` for `/articles/` and `/sites/`.

### C2. SEO meta-integrity (HIGH ROI)

Per page:

- `<title>` present, length between `RECCE_TITLE_MIN_LEN` (default 30) and
  `RECCE_TITLE_MAX_LEN` (default 65). **Locale-aware:** the 30–65 bound
  applies only when `<html lang>` starts with `en`. Non-English pages use the
  env-var bounds only; if unset, title length is warn-only above 80 (most
  languages can be verbose).
- `<meta name="description">`: 50–160 chars.
- Exactly one `<h1>`, non-empty, not duplicated verbatim across siblings.
- `<link rel="canonical">` present, absolute, self-referential or intentional
  canonical target.
- **Open Graph minimum** — all must be present and resolve:
  - `og:title`, `og:description`, `og:image`, `og:url`.
  - `og:url === canonical` (exact match).
  - `og:image` resolves 2xx via HEAD.
  - `og:image` dimensions ≥ 1200×630. Check via HEAD `Content-Length` as a
    coarse sanity, then fetch image and read dims from response body (via
    `image-size` package). Skip dim check gracefully if library call fails;
    log a debug line so we know.
- **New meta checks:**
  - `<meta charset>` present.
  - `<meta name="viewport">` present.
  - `<html lang>` matches BCP-47: regex `^[a-z]{2}(-[A-Z]{2})?$`.
- **JSON-LD schema blocks** parse as valid JSON. Merchant pages expect
  `@type: LocalBusiness` or `Place`; articles expect `@type: Article`.
- **`hreflang`** tags (if present) all resolve 2xx (full bidirectional check
  lives in C15).

**Acceptance for locale-awareness:** run against a known-good ES page (e.g.
the existing Spanish article URLs if available; else a fixture) and assert
zero false positives from the title length rule.

### C3. JS runtime errors + failed fetches (HIGH ROI)

Attached via the crawler's `pageHooks` extensibility point (Phase 2):

- `page.on('console', m => m.type() === 'error' && record(...))`.
- `page.on('pageerror', err => record(...))`.
- `page.on('requestfailed', req => /* same-origin only */)`.

Any recorded entry becomes a finding with the URL as the page-under-test.
External tracker failures are warn-only.

### C4. Content-quality leaks (HIGH ROI, low cost)

Regex rendered body text for:

- `\bLorem ipsum\b`
- `\{\{[\w.]+\}\}` (unresolved Handlebars)
- `\$\{[\w.]+\}` (unresolved template literal)
- `\bundefined\b`, `\bNaN\b`, `\bnull\b` outside `<code>` / `<pre>`
- `\[object Object\]`
- Empty-heading detection: `<h1>`/`<h2>`/`<h3>` with zero non-whitespace text.

### C5. Mobile responsiveness — no horizontal scroll (MEDIUM ROI)

On Mobile Chrome only (audit mode per Overview):

- `document.documentElement.scrollWidth ≤ window.innerWidth + 1` (1px
  tolerance).
- Every `button` and `a.btn` bounding box ≥ 44×44 CSS px (WCAG tap-target).

### C6. Accessibility via axe-core sampled (MEDIUM ROI)

- Sample 10 pages per run (not every page — expensive).
- **Scope:** axe config uses `include: ['main', 'article', '[data-article-body]']`
  and `exclude: ['iframe', '[data-widget]', '[data-third-party]']` to keep
  third-party widget noise out.
- **Dedup violations** by `(check_id, selector_signature, page_path_prefix)`
  — one widget on many pages must not produce N copies of the same finding.
- Report `serious` + `critical` only. Enable the `best-practice` tag to
  include `landmark-one-main`, `region`, `heading-order`.
- **Severity:** all a11y findings default `warn` until dedup stability is
  proven. `color-contrast` specifically stays `warn` until baseline drift is
  measured (noisy).

### C7. `target="_blank"` without `rel="noopener"` (LOW COST)

Every `a[target="_blank"]` must have `rel` containing `noopener` (ideally
`noreferrer`).

### C8. Mixed content on HTTPS (HIGH SECURITY ROI)

Flag `img[src^="http:"]`, `script[src^="http:"]`, `link[href^="http:"]` in
stylesheets, `iframe[src^="http:"]`.

### C9. Redirect-chain detection (MEDIUM ROI)

Audit-only. Uses the manual hop-follow loop documented in A1. Flags chains
≥ 3 as `redirect_chain_too_long`.

### C10. Custom 404 / 500 page smoke (LOW COST)

Explicitly hit `/articles/en/this-definitely-does-not-exist-<timestamp>` and
assert 404 response AND rendered page still has site chrome (nav, footer,
link-back-home).

### C11. Canonical-URL duplication detection (MEDIUM ROI, audit mode)

`Map<canonical, Set<url>>`. Two different URLs claiming the same canonical,
neither of which IS the canonical, → `canonical-duplicates` finding.

### C12. Performance signals (LOW priority, deferred to Phase 10)

- Page weight: sum of response bodies > 5 MB → warn.
- More than 3 render-blocking scripts → warn.
- LCP element present and on-screen (extended into C18).

### C13. Selector-health meta-check (NEW, prevents silent no-ops)

If any required selector (e.g. `.object-cover` for merchant hero) matches
zero elements across the first 20 pages of a given type, emit `warn` severity
`check-selector-dead` finding. Protects against silent failure after
upstream CSS refactors.

### C14. Pre-consent tracker detection + cookie inventory (NEW, GDPR-critical)

**Scope:** the site serves LATAM traffic but EU visitors still arrive. Any
tracker firing before consent is a compliance risk.

**Implementation:**

- Fresh browser context (no cookies).
- Visit page; record all network requests via `page.on('request', ...)`.
- Maintain blocklist of tracker hostnames in `tests/utils/trackers.ts`:
  Google Analytics, Facebook Pixel, Hotjar, Mixpanel, Microsoft Clarity,
  LinkedIn Insight, TikTok pixel, Pinterest tag. Match against request
  hostname (exact + subdomain).
- Any request to a blocklisted hostname BEFORE user interaction with a
  consent banner → `error` severity `pre-consent-tracker`.
- Also: dump all cookies set on first paint via `context.cookies()` into
  findings (`info` severity, forms inventory).

**Cadence:** pulse samples 3 pages; audit runs on all crawled pages.

**False positives:** some sites inline their own analytics on the same
origin — exclude same-origin from the tracker check, only count
known-third-party hostnames.

### C15. hreflang bidirectional + language-content stopword (NEW)

**Bidirectional hreflang:**

- Parse `<link rel="alternate" hreflang="...">` tags.
- For each alternate, fetch the alternate URL and assert it contains a
  reciprocal `hreflang` back to the original. Non-reciprocal =
  `hreflang-not-reciprocal` finding.

**Language-content mismatch:**

- On a URL with `/es/` or `/pt/` segment, tokenise body text, count English
  stopwords (`the`, `and`, `for`, `with`, `of`, `to`, `in`, `on`, `at`, `by`)
  at word-boundary matches.
- If English stopword density > 5% of total word count on a non-EN page →
  `language-content-mismatch` finding.
- False-positive guard: skip if body word count < 100 (short pages noisy).

### C16. Security headers one-shot (NEW, LOW cost)

On the homepage + one merchant page + one article page per run (3 requests
total):

- HEAD request, inspect response headers.
- **Assert present:** `Content-Security-Policy`, `Strict-Transport-Security`
  (with `max-age ≥ 15768000` ≈ 6 months), `X-Content-Type-Options: nosniff`,
  `X-Frame-Options` (`DENY` or `SAMEORIGIN`), `Referrer-Policy`,
  `Permissions-Policy`.
- **Missing or weak** = `warn`.

### C17. Orphan pages + duplicate titles/H1s + noindex leaks (NEW, audit only)

After full crawl:

- **Orphans:** `sitemap_urls \ crawled_urls` (in sitemap, not reachable via
  internal links) AND `crawled_urls \ sitemap_urls` (reachable but not in
  sitemap). Emit one `orphan-page` finding per URL.
- **Duplicate titles:** group crawled pages by exact `<title>`; any group
  with ≥ 5 members → `duplicate-title` finding listing all URLs.
- **Duplicate H1s:** same approach with `<h1>` text, same threshold.
- **noindex leak:** any page returning 2xx AND having
  `<meta name="robots" content="noindex">` → `noindex-on-indexable` finding.

### C18. LCP element detection + preload hint (NEW)

On each crawled page:

- Use `PerformanceObserver` for `largest-contentful-paint`.
- Record LCP element tag + src.
- If LCP is an `<img>` AND no `<link rel="preload" as="image"
  href="<lcp-src>">` exists in `<head>` → `warn` `lcp-image-not-preloaded`.

Highest-impact perf fix per 2025 Web Almanac (76% of pages have image LCP,
only 2.1% preload).

### Explicitly DEFERRED

- External link *dead* detection as an `error` — always `warn`, audit-only.
- Full Lighthouse audit — separate tool, separate cadence.
- Form validation deep-dive (negative paths).
- Visual regression — out of scope for this plan.

**Confidence: HIGH** on C1–C4, C7, C8, C10, C13, C14 (cheap, well-known
patterns). **MODERATE** on C5, C6, C9, C11, C15, C16, C17, C18 (require
calibration).

---

## Section D — Reporting

### D1. JSON artifact (run-scoped)

Written to `test-results/findings/<mode>-<ISOts>.json`, with a symlink
`test-results/findings-latest.json` pointing at the most recent run.

```json
{
  "run": {
    "schemaVersion": 1,
    "startedAt": "2026-04-23T08:30:00Z",
    "finishedAt": "2026-04-23T08:32:14Z",
    "mode": "pulse",
    "baseURL": "https://valors.io",
    "pagesCrawled": 127,
    "rateLimited": 2,
    "findingCounts": { "error": 4, "warn": 11, "info": 0 }
  },
  "byUrl": {
    "/articles/en/mx/jalisco/guadalajara/restaurants": [
      { "check": "broken-image", "severity": "error",
        "element": { "tag": "img", "attr": { "src": "https://cdn/...jpg" } },
        "actual": "HTTP 404" }
    ]
  },
  "byCheck": {
    "broken-image": [ /* ... */ ],
    "link-404": [ /* ... */ ]
  }
}
```

**PID-locked run scripts:** both `run-daily.sh` and `run-audit.sh` acquire a
PID lock (`/tmp/recce-<mode>.pid`) using `kill -0 <pid>` liveness check. If a
live PID is found, exit cleanly with status 0 and log
`"another recce-<mode> run is active (pid=<pid>), skipping"`. Stale lock files
(PID not running) are removed atomically.

### D2. Discord reporter enhancements

1. Reporter reads `findings-latest.json` at `onEnd`.
2. **Sentinel:** if the symlink target is missing OR the file is empty,
   escalate via
   `wilco-notify --level error --title "Recce report lost" "<details>"`. Do
   NOT post a green embed.
3. Top block: run summary (pages crawled, errors, warns, rate-limited count).
4. Failures block: top 10 URLs by error count, one line each:
   `:x: /articles/.../guadalajara/restaurants — 3 errors
   (broken-image x2, button-disabled x1)`.
5. More than 10 failing URLs → append `... and N more — see findings.json`
   and attempt upload.
6. **Pre-upload size check:** if the consolidated JSON is > 7.5 MB, skip
   the Discord attachment and instead upload the artifact elsewhere (see
   Section G for S3/gist destination, TBD during Phase 4). Include the URL in
   the embed.
7. Colour codes:
   - Green: 0 errors, 0 warns.
   - Yellow: 0 errors, ≥ 1 warn.
   - Red: ≥ 1 error.
8. One embed per severity class so red errors aren't visually drowned by
   warns.

**Webhook failure handling (non-silent):**

- On any delivery failure (HTTP non-2xx, timeout, or rate-limit after retry):
  - Keep the timestamped JSON on disk (already done via run-scoped names).
  - Escalate via
    `wilco-notify --level error --title "Recce Discord delivery failed"
    "<path to on-disk artifact>"`.

### D3. Per-check drill-down

When `RECCE_VERBOSE=1`, a second Discord message per failing check type:
`broken-image (7 total)` → short table of `url | src | status`. Off by
default.

**Confidence: HIGH** — Discord webhook file-upload is a standard pattern.

---

## Section E — Risks & tradeoffs

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Full crawl overwhelms origin → 429 storm | Medium | High | Hard concurrency cap 2, 750 ms min delay, jittered backoff, `Retry-After` parsing, abort on `>N` 429s, off-peak audit (03:00 UTC) |
| Discord report too large (2000+ findings) | High in audit | Medium | Top-10 URLs embed; full JSON attached; per-check drill-down opt-in; 7.5 MB threshold triggers external upload (Section G) |
| External link flakiness triggers false failures | High | Medium | External links always `warn`, audit-only |
| 3 browser projects × full crawl wall time | High | High | Pulse = chromium only; audit = all 3 projects with shared findings for non-rendering checks |
| Flaky lazy-image detection | Medium | Medium | scroll-into-view + `img.complete && naturalWidth` dual check, 5 s cap, retry once |
| Findings sink race conditions | Low (workers = 1) | High if re-parallelized | JSONL append-only write-through (Phase 1), consolidated in `globalTeardown` |
| Chromium OOM mid-run | Low | High (findings lost) | JSONL write-through from day 1 — each finding is durable before test completes |
| Pulse + audit concurrent writes | Low | High | Run-scoped filenames (`<mode>-<ISOts>.json`) + PID locks per mode |
| SPA catch-all route hides 404s | Medium | High (broken links invisible) | DOM-based 404 detection (B2): title + h1 + body-length triple check |
| axe-core noise from third-party widgets | High | Medium (red-flag fatigue) | Scope include-list + exclude selectors; dedup by (check, selector, path-prefix); default `warn` severity |
| Discord webhook down → silent failure | Low | High (missed regression) | `wilco-notify --level error` + on-disk archive preserved |
| First-run baseline missing | Guaranteed first run | Low | Bootstrap-and-emit-info: first run creates baseline, emits `baseline-bootstrapped` (info) |
| Sitemap returns HTML 200 (SPA catch-all) | Medium | High (no crawl seeds) | Content-Type validation in Phase 2; fall through seed chain |
| `MAX_PAGES` coverage gap on large sitemap | Medium (audit) | Medium | Coverage rotation with deterministic date-seeded shuffle |
| Axe-core adds 2–5 s per page → audit blows budget | Medium | Medium | Sample 10 pages only, never full crawl |
| Canonical dedup false positives on paginated lists | Medium | Low | Audit-only (needs full crawl); threshold tuning expected |
| Retries mask real outage | Low | High | `retries: 0` for crawl suites; rely on per-check internal retry |
| Local baselines drift out of sync with CI | Medium | Low | Baselines uploaded to GH Actions artifacts (90-day retention) + gitignored local copy |
| LCP / PerformanceObserver unsupported in webkit | Low | Low | `typeof PerformanceObserver === 'undefined'` guard; skip gracefully |

---

## Section F — Phased rollout

Each phase is a shippable PR. Stop at any phase and you still have value.

### Phase 1 — Findings infrastructure (FOUNDATION)

**Files created:**

- `tests/utils/findings.ts` — shared sink with JSONL write-through
- `tests/utils/types.ts` — `Finding`, `Severity`, `Run`, `schemaVersion`
  changelog block
- `tests/unit/findings.test.ts` — zod schema validator + write-through
  assertion

**Files modified:**

- `tests/utils/discord-reporter.ts` — JSONL-aware; reads
  `findings-latest.json`; wilco-notify escalation on missing file and on
  webhook delivery failure

**Acceptance:**

- [ ] **Existing suite still passes unchanged** (no migration yet)
- [ ] `findings/<mode>-<ISOts>.json` written; `findings-latest.json` symlink
      updated
- [ ] `findings.jsonl` exists during the run; every `findings.push()` appends
      a line atomically
- [ ] zod schema rejects a known-bad finding shape
- [ ] Simulated 2-worker test: both workers append to JSONL, teardown
      consolidates to single JSON with both findings present
- [ ] `wilco-notify` fires when `findings-latest.json` is absent at
      `onEnd`
- [ ] `wilco-notify` fires when Discord webhook returns non-2xx

**Effort:** Small. **Confidence: HIGH.**

### Phase 2 — Crawler primitive + /articles tree BFS

**Files created:**

- `tests/utils/crawler.ts` — BFS queue, politeness, 429 handling w/ jitter
  and `Retry-After`, sitemap discovery chain (robots.txt → sitemap index →
  gz → direct), content-type gate, `pageHooks` extensibility point,
  `MAX_DEPTH=7`
- `tests/utils/checks/selector-health.ts` — C13 meta-check
- `tests/crawl-articles.spec.ts` — new spec; pulse = 25 pages max, only
  "has body, has image" checks (no new checks yet)

**Files modified:**

- `tests/daily-sanity.spec.ts` — **migrated to new crawler primitive**
  (same 10-page sample, same checks, ≤ 5 min runtime)

**Acceptance:**

- [ ] Migrated suite runs against identical coverage with identical checks
      (Phase 1's "unchanged" guarantee is **superseded** from this point —
      no going back)
- [ ] Crawler respects `MAX_PAGES`, `MAX_DEPTH=7`, concurrency = 2
- [ ] Reaches `/articles/en/Mexico/CDMX/Ciudad-de-Mexico/coffee_shop/
      best-coffee-shops-mexico-city` without hitting depth cap
- [ ] 429 triggers jittered backoff; second 429 → `rate_limited` finding
- [ ] `Retry-After` header honoured on 429 + 503
- [ ] Sitemap discovery chain: robots.txt parsed first, falls back through
      index → gz → direct
- [ ] Non-XML content-type on `/sitemap.xml` emits `sitemap-parse-failed`
      and seeds from `seedUrls` fallback
- [ ] `pageHooks` config field works (verified via a test hook that records
      page URLs)
- [ ] Pulse still completes ≤ 5 min on chromium

**Effort:** Medium. **Confidence: HIGH.**

### Phase 3 — User's 5 explicit checks

**Files created:**

- `tests/fixtures/seeded-bugs.ts` — `page.route()` harness with known URLs
  returning deliberately-broken responses (404 image, broken link,
  missing hero)
- `tests/utils/checks/images.ts` — B1 + B4 + CLS dims + oversized + shared
  `normaliseImageUrl`
- `tests/utils/checks/links.ts` — B2 incl. SPA-safe DOM 404 detection
- `tests/utils/checks/buttons.ts` — B5 incl. reCAPTCHA exemption
- `tests/crawl-merchants.spec.ts` — B3
- `tests/unit/checks-seeded.test.ts` — per-check unit tests against
  `seeded-bugs.ts` asserting exactly one finding of the expected shape

**Files modified:**

- `tests/crawl-articles.spec.ts` — invoke image/link/button checks per page

**Acceptance:**

- [ ] Seeded broken image produces exactly one `broken-image` finding with
      correct src
- [ ] Seeded soft-404 (title = "Not Found") produces exactly one `soft-404`
      finding
- [ ] Duplicate-image check honours `RECCE_DUPLICATE_EXEMPT_PATTERNS`
- [ ] reCAPTCHA-managed button is `info` severity, not `error`
- [ ] Merchant hero enforces `naturalWidth ≥ 400`
- [ ] Normalised URL contract verified by unit test across B1 and B4
      call sites

**Effort:** Medium. **Confidence: HIGH.**

### Phase 4 — Reporting polish + ops hardening

**Files created:**

- `run-audit.sh` — sets `RECCE_MODE=audit`, `MAX_PAGES=2000`, requires
  `BASE_URL` and `RECCE_AUDIT_DISCORD_WEBHOOK`, acquires
  `/tmp/recce-audit.pid`, runs pre-flight origin health check (curls
  `${BASE_URL}/healthz` or homepage; aborts cleanly on non-2xx)
- `.github/workflows/daily-sanity.yml` — (or update existing) — upload
  `test-results/findings/**` unconditionally, 30-day retention

**Files modified:**

- `run-daily.sh` — **remove hardcoded webhook URL at line 8**; require
  `BASE_URL` and `RECCE_DISCORD_WEBHOOK` env vars (hard exit if missing);
  acquire `/tmp/recce-pulse.pid`
- `tests/utils/discord-reporter.ts` — per-URL grouping, attachment upload,
  7.5 MB threshold for external upload, non-silent webhook failure
  (wilco-notify on delivery fail)

**Acceptance:**

- [ ] Both run scripts fail fast if `BASE_URL` or webhook env vars unset
- [ ] PID lock prevents concurrent same-mode runs; stale locks cleaned up
- [ ] Pre-flight origin health aborts audit cleanly if origin unreachable
- [ ] Run < 10 failing URLs shows inline in Discord
- [ ] Run > 10 failing URLs attaches JSON
- [ ] JSON > 7.5 MB uploads externally and embeds URL
- [ ] Webhook delivery failure triggers wilco-notify error
- [ ] CI uploads `test-results/findings/**` unconditionally with 30-day
      retention

**Effort:** Small. **Confidence: HIGH.**

### Phase 5a — Runtime / content / security checks

**Files created:**

- `tests/utils/checks/runtime-errors.ts` — C3 (console, pageerror,
  requestfailed)
- `tests/utils/checks/content.ts` — C4 (lorem, handlebars, undefined, NaN,
  [object Object], empty headings)
- `tests/utils/checks/security.ts` — C7 (noopener) + C8 (mixed content)
- `tests/runtime-errors.spec.ts`

**Acceptance:**

- [ ] `pageHooks` from Phase 2 consumed: runtime listeners attached before
      navigation
- [ ] Seeded test error via `page.evaluate(() => { throw new Error('x') })`
      produces `pageerror` finding
- [ ] Mixed-content check flags a seeded `http://...` image

**Effort:** Medium. **Confidence: HIGH.**

### Phase 5b — SEO meta (locale-aware)

**Files created:**

- `tests/utils/checks/seo.ts` — C2 incl. locale-aware title bounds,
  og:url === canonical, og:image HEAD + dims, charset/viewport/BCP-47
- `tests/seo-meta.spec.ts`

**Acceptance:**

- [ ] Known-good ES page produces zero SEO findings (zero false positives
      on title length)
- [ ] Missing `<meta charset>` flagged
- [ ] BCP-47 regex matches `en`, `es`, `pt-BR`, `en-US`; rejects
      `english`, `EN`, `xx-xxx`
- [ ] `og:image` < 1200×630 flagged
- [ ] `og:url !== canonical` flagged

**Effort:** Medium. **Confidence: MODERATE** (locale tuning may need one
calibration pass).

### Phase 6 — Sitemap + robots + baselines

**Files created:**

- `tests/sitemap.spec.ts` — C1 integrity
- `tests/utils/coverage-rotation.ts` — deterministic date-seeded shuffle
- `tests/utils/checks/canonical.ts` — orphan detection (C17 partial)
- `test-results/baselines/` — bootstrap directory; gitignored locally,
  uploaded as GH Actions artifact with 90-day retention

**Acceptance:**

- [ ] Sitemap URL count baseline created on first run;
      `baseline-bootstrapped` info finding emitted
- [ ] > 20% drop vs baseline → `sitemap-regression` finding
- [ ] Coverage rotation: two consecutive audit runs on the same day
      produce the same sampled set; next day produces a different set
- [ ] `robots.txt` allows `Googlebot` for `/articles/` and `/sites/`
- [ ] Orphan detection (audit): pages in sitemap but not crawled surface
      as `orphan-page`

**Effort:** Small-Medium. **Confidence: HIGH.**

### Phase 7 — a11y (scoped + deduped) + responsive + image dims

**Files created:**

- `tests/utils/checks/a11y.ts` — scoped axe config, dedup by
  (check, selector, path-prefix), `best-practice` tag enabled
- `tests/utils/checks/responsive.ts` — no horizontal scroll + tap-target
- `tests/accessibility.spec.ts`

**Dependencies:** `@axe-core/playwright`, `image-size`.

**Acceptance:**

- [ ] Axe runs on 10 sampled pages, reports `serious` + `critical` only
- [ ] Dedup proven: a third-party widget appearing on 10 sampled pages
      produces ≤ 1 finding (not 10)
- [ ] Responsive checks run only on Mobile Chrome project
- [ ] Tap-target check flags < 44×44 px buttons
- [ ] Image dimensions check from B1 runs unchanged; `image-oversized`
      flags > 2× oversampling

**Effort:** Medium. **Confidence: MODERATE** — dedup stability and axe
thresholds will need a calibration pass.

### Phase 8 — Audit-mode enrichments

**Files created:**

- `tests/canonical-duplicates.spec.ts` — C11 + C17 duplicate title/h1 +
  noindex leak
- `tests/redirect-chains.spec.ts` — C9 manual hop-follow
- `tests/custom-error-pages.spec.ts` — C10
- `tests/utils/checks/canonical.ts` (enhanced) — duplicate title/h1
  grouping, noindex leak detection

**Acceptance:**

- [ ] Weekly audit produces < 200 findings on a clean site
- [ ] Redirect chain ≥ 3 hops flagged
- [ ] Chains with cycles (A → B → A) detected and flagged
- [ ] Seeded canonical duplicate detected
- [ ] Seeded `noindex` on an indexable page flagged

**Effort:** Medium. **Confidence: MODERATE** — thresholds need real-world
tuning.

### Phase 9 — GDPR / security / i18n pack (NEW)

**Files created:**

- `tests/utils/trackers.ts` — tracker hostname blocklist
- `tests/utils/checks/trackers.ts` — C14 pre-consent detection
- `tests/utils/checks/hreflang.ts` — C15 bidirectional + stopword density
- `tests/utils/checks/security-headers.ts` — C16 one-shot
- `tests/consent-trackers.spec.ts`
- `tests/hreflang.spec.ts`
- `tests/security-headers.spec.ts`

**Acceptance:**

- [ ] Fresh-context visit to homepage records any GA/Pixel/etc. hits before
      consent as `pre-consent-tracker` error
- [ ] Non-reciprocal hreflang on a test page flagged
- [ ] Spanish URL with > 5% English stopword density flagged
- [ ] Missing `Content-Security-Policy` on homepage flagged
- [ ] HSTS `max-age < 15768000` flagged

**Effort:** Medium. **Confidence: MODERATE** — tracker blocklist will need
review pass; stopword density threshold may need tuning per language.

### Phase 10 — Perf signals (NEW)

**Files created:**

- `tests/utils/checks/perf.ts` — C18 LCP preload + C12 page weight +
  render-blocking script count
- `tests/perf-signals.spec.ts`

**Acceptance:**

- [ ] Page with image LCP and no preload hint → `lcp-image-not-preloaded`
- [ ] Page with > 5 MB total response body → page-weight warn
- [ ] Page with > 3 render-blocking scripts → warn
- [ ] Graceful skip on webkit if `PerformanceObserver` unavailable

**Effort:** Small-Medium. **Confidence: MODERATE** — LCP detection
depends on browser timing; expect flakiness on slow-network runs.

---

## Section G — Operations (NEW)

### G1. Discord channels and webhooks

| Mode | Env var | Channel |
|------|---------|---------|
| Pulse | `RECCE_DISCORD_WEBHOOK` | `#recce-daily` |
| Audit | `RECCE_AUDIT_DISCORD_WEBHOOK` | `#recce-audit` |

Both run scripts exit with a clear error if the relevant env var is unset.
There are **no hardcoded webhook URLs** in the repo; `run-daily.sh`'s line 8
hardcoded URL is removed in Phase 4.

### G2. Expected human response

| Colour | Mode | Response SLA |
|--------|------|--------------|
| Red (≥ 1 error) | Pulse | Investigate within 1 business day |
| Red (≥ 1 error) | Audit | Investigate within 1 week |
| Yellow (only warns) | Either | Reviewed during weekly triage |
| Green | Either | No action |

### G3. "Done" definition for findings

- A finding is **closed** when the next clean run on the same URL shows the
  check clear. Findings are ephemeral — they do not require a ticket.
- **Warn-only findings do not block**, but the weekly triage reviews
  warn-level trend lines (e.g. `image-oversized` count over last 8 weeks).
- **Error findings** that persist across > 3 consecutive runs are
  auto-escalated via a second `wilco-notify --level warning` with subject
  `Recce: persistent finding <check> on <url>`.

### G4. Baseline storage

**Contents:**

- `test-results/baselines/sitemap-count.json` — URL count for C1 regression
  detection
- `test-results/baselines/coverage.json` — hash-buckets of URLs sampled
  across rotation cycles (audit)

**Storage:**

- Local: `test-results/baselines/` directory, gitignored.
- CI: uploaded as GitHub Actions artifact with **90-day retention** so
  historical comparisons are possible even when a new runner has no local
  copy.

**First-run behaviour:**

- No baseline present → bootstrap from the current run's values AND emit
  `baseline-bootstrapped` finding with `info` severity. This makes the
  bootstrap event auditable.

### G5. Pre-flight origin health check (audit only)

`run-audit.sh` first runs `curl -sS -o /dev/null -w '%{http_code}'
"${BASE_URL}/healthz" || curl -sS -o /dev/null -w '%{http_code}' "${BASE_URL}"`.
If neither returns 2xx within 10 s, the script aborts with:

```text
recce-audit: origin unreachable, skipping crawl
```

Exit status 0 (not a failure — transient origin outage should not page
on-call). A `wilco-notify --level warning` records the skip.

### G6. PID lock behaviour

Both scripts acquire `/tmp/recce-<mode>.pid`:

- If file exists and PID is live (`kill -0 <pid>` succeeds): exit 0 with log
  line, do not proceed.
- If file exists but PID is not live (stale lock): remove atomically, acquire
  fresh.
- Lock released in an `EXIT` trap so crashes don't leave orphaned locks.

This catches the pulse + audit concurrent-write case (risk table in E).

### G7. Memory constraints for local / VPS runs

Where `systemd-run` is available (most VPS hosts):

```bash
systemd-run --scope -p MemoryMax=2G --user \
  npx playwright test ...
```

Prevents a runaway Playwright process from starving the host. Skipped
gracefully on dev laptops where `systemd-run` is absent. Wrapper lives in
both run scripts as an optional prefix controlled by `RECCE_MEMORY_LIMIT=1`
env flag (default on in `run-audit.sh`, off in `run-daily.sh` because pulse
is small).

### G8. External-upload destination (for > 7.5 MB findings)

**Decision pending Phase 4:** options are (a) a private S3 bucket
(`s3://valors-recce-findings/<date>/<mode>.json`) with presigned URL in the
Discord embed, or (b) a private GitHub Gist. Recommend S3 for retention
control; gist for zero setup. Final choice during Phase 4 implementation.

---

## Success criteria

1. A deliberately broken image pushed via `page.route()` fixture is surfaced
   in a unit-style test run with the exact URL and `src` in the output.
2. A deliberately 404-linking fixture is surfaced as `soft-404` via the DOM
   detection path (not substring).
3. Daily pulse runtime stays ≤ 5 minutes on chromium only.
4. Weekly audit completes ≤ 45 minutes on chromium (coverage rotation
   handles overflow; Mobile Chrome + webkit share findings for non-rendering
   checks).
5. `findings/<mode>-<ISOts>.json` + `findings-latest.json` symlink are stable
   artifacts consumable by downstream tooling.
6. When origin rate-limits the crawl, the run reports "crawl incomplete"
   explicitly instead of falsely reporting green.
7. When the Discord webhook fails, findings survive on disk AND a
   `wilco-notify` error escalates.
8. Pre-consent tracker check (C14) catches at least one real tracker on the
   homepage before consent-banner click (proves GDPR path works).
9. Baseline bootstrap is observable (`baseline-bootstrapped` info finding).
10. Pulse + audit running concurrently produce separate run-scoped files
    (PID locks + run-scoped names prevent clobbering).

---

## Open questions (resolved)

- **External dead-link detection** → audit-only, `warn` severity.
- **Audit Discord channel** → separate `RECCE_AUDIT_DISCORD_WEBHOOK` env
  var, `#recce-audit`.
- **Staging environment** → not required; `page.route()` fixtures in
  `tests/fixtures/seeded-bugs.ts` validate each check.
- **Sitemap baseline storage** → `test-results/baselines/` (gitignored) +
  GitHub Actions artifact upload with 90-day retention.
- **Pulse gating merges on other repos** → out of scope; revisit after
  Phase 7.
- **External-upload destination for > 7.5 MB** → decision deferred to
  Phase 4 (S3 bucket or private gist; recommend S3).

---

## Confidence Assessment

| Phase | Confidence | Notes |
|-------|-----------|-------|
| Phase 1 — Findings infra + JSONL + schema | HIGH | zod + write-through are standard |
| Phase 2 — Crawler + sitemap chain + pageHooks | HIGH | Mirrors existing rate-limit pattern |
| Phase 3 — User's 5 checks + seeded-bug fixture | HIGH | All checks have proven DOM patterns |
| Phase 4 — Reporting + PID lock + CI artifacts | HIGH | Well-known ops patterns |
| Phase 5a — Runtime / content / security | HIGH | Listener pattern proven |
| Phase 5b — SEO locale-aware | MODERATE | Title bounds need ES/PT calibration |
| Phase 6 — Sitemap integrity + coverage rotation | HIGH | Simple XML + deterministic shuffle |
| Phase 7 — a11y + responsive + dims | MODERATE | Axe dedup + thresholds need one calibration pass |
| Phase 8 — Audit enrichments | MODERATE | Canonical / redirect thresholds need tuning |
| Phase 9 — GDPR / security / i18n | MODERATE | Tracker blocklist review; stopword density per-language tuning |
| Phase 10 — Perf signals | MODERATE | LCP timing variance; graceful-skip on webkit |

**Overall plan confidence: MODERATE** (min across phases). Phases 1–6 are
ready to execute with high confidence; 7–10 may need one tuning PR each
after first real-world runs. All calibration-sensitive checks default to
`warn` severity until baselined so they cannot cause false red pulses.

No section is LOW after analysis — no spike/prototype required before
starting. Phase 7 (axe dedup stability) and Phase 9 (tracker blocklist
accuracy) are the two most likely places for follow-up tuning PRs.
