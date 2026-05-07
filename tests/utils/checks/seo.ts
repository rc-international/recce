import type { APIRequestContext, Page } from "@playwright/test";
import { imageSize } from "image-size";
import { recordFinding } from "../findings";
import type { Finding } from "../types";
import { headOrGet } from "./net";

/**
 * C2 — SEO meta-integrity (Phase 5b).
 *
 * Per page the check extracts (in a SINGLE page.evaluate round-trip) the
 * following DOM signals:
 *
 *   - <title>
 *   - <html lang>
 *   - <meta charset> + <meta name="viewport"> + <meta name="description">
 *   - <h1> count + text
 *   - <link rel="canonical">
 *   - <meta property="og:*"> tuples
 *   - <script type="application/ld+json"> blocks
 *   - <link rel="alternate" hreflang=...>
 *
 * Validations:
 *
 *   - Title presence + locale-aware length bounds. Only English pages use the
 *     30–65 tight bound; non-English pages warn above 80 chars only. Tuning
 *     env vars:
 *       RECCE_TITLE_MIN_LEN       (default 30, English only)
 *       RECCE_TITLE_MAX_LEN       (default 65, English only)
 *       RECCE_TITLE_NON_EN_MAX    (default 80)
 *       RECCE_TITLE_NON_EN_MIN    (default unset — no min for non-English)
 *   - meta description present + length 50..160 (warn).
 *   - Exactly one non-empty <h1> (missing/multiple/empty all flagged).
 *   - <link rel="canonical"> present + absolute.
 *   - Open Graph minimum set (og:title / og:description / og:image / og:url)
 *     plus og:url == canonical and og:image reachable + ≥ 1200x630.
 *   - <meta charset> + <meta name="viewport"> present.
 *   - <html lang> matches BCP-47 `^[a-z]{2}(-[A-Z]{2})?$`.
 *   - Each JSON-LD block parses as JSON. Full @type semantic validation is
 *     deferred — see TODO below.
 *   - hreflang attributes match BCP-47 (or x-default) and hrefs are absolute.
 *     Full bidirectional reciprocity lives in Phase 9 (C15).
 *
 * Error handling:
 *   - Every catch logs at `console.debug` (see /home/gordon/wilco/rules/
 *     error-handling.md). The shared `checkedLinks` cache is used so the same
 *     og:image URL is HEADed at most once per run — consistent with Phase 3
 *     B1/B2.
 *
 * TODO Phase 10: validate LocalBusiness/Place/Article @type semantics per URL
 * pattern (e.g. merchant pages must have LocalBusiness or Place). Needs a
 * calibration pass once we see what schemas valors.io actually emits.
 */

// -----------------------------------------------------------------------------
// BCP-47
// -----------------------------------------------------------------------------

const BCP47_RE = /^[a-z]{2}(-[A-Z]{2})?$/;

/**
 * Strict BCP-47 validator for the subset the plan calls out:
 *   - `^[a-z]{2}(-[A-Z]{2})?$`
 * i.e. lowercase 2-letter language + optional uppercase 2-letter country.
 *
 * Accepts: `en`, `es`, `pt-BR`, `en-US`.
 * Rejects: `english`, `EN`, `xx-xxx`, `en-us`, `` (empty).
 */
export function isValidBcp47(lang: string): boolean {
	if (typeof lang !== "string") return false;
	return BCP47_RE.test(lang);
}

// -----------------------------------------------------------------------------
// DOM snapshot
// -----------------------------------------------------------------------------

type OgTag = { property: string; content: string };
type HreflangTag = { hreflang: string; href: string };

type SeoSnapshot = {
	title: string | null;
	htmlLang: string | null;
	metaCharset: string | null;
	metaViewport: string | null;
	metaDescription: string | null;
	h1s: string[];
	canonical: string | null;
	og: OgTag[];
	jsonLdBlocks: string[];
	hreflangs: HreflangTag[];
};

async function snapshotSeo(page: Page): Promise<SeoSnapshot> {
	return (await page.evaluate(() => {
		const title = document.querySelector("title")?.textContent ?? null;

		const htmlLang = document.documentElement.getAttribute("lang") ?? null;

		// <meta charset="..."> OR <meta http-equiv="Content-Type" ...> — either
		// form is acceptable per HTML5 spec, but the check treats the modern
		// `<meta charset>` as authoritative.
		let metaCharset: string | null = null;
		const charsetEl = document.querySelector("meta[charset]");
		if (charsetEl) metaCharset = charsetEl.getAttribute("charset") || "";

		let metaViewport: string | null = null;
		const viewportEl = document.querySelector('meta[name="viewport"]');
		if (viewportEl) metaViewport = viewportEl.getAttribute("content") || "";

		let metaDescription: string | null = null;
		const descEl = document.querySelector('meta[name="description"]');
		if (descEl) metaDescription = descEl.getAttribute("content") || "";

		const h1s: string[] = Array.from(document.querySelectorAll("h1")).map(
			(h) => h.textContent || "",
		);

		const canonicalEl = document.querySelector('link[rel="canonical"]');
		const canonical = canonicalEl
			? canonicalEl.getAttribute("href") || ""
			: null;

		const og: { property: string; content: string }[] = Array.from(
			document.querySelectorAll('meta[property^="og:"]'),
		).map((m) => ({
			property: m.getAttribute("property") || "",
			content: m.getAttribute("content") || "",
		}));

		const jsonLdBlocks: string[] = Array.from(
			document.querySelectorAll('script[type="application/ld+json"]'),
		).map((s) => s.textContent || "");

		const hreflangs: { hreflang: string; href: string }[] = Array.from(
			document.querySelectorAll('link[rel="alternate"][hreflang]'),
		).map((l) => ({
			hreflang: l.getAttribute("hreflang") || "",
			href: l.getAttribute("href") || "",
		}));

		return {
			title,
			htmlLang,
			metaCharset,
			metaViewport,
			metaDescription,
			h1s,
			canonical,
			og,
			jsonLdBlocks,
			hreflangs,
		};
	})) as SeoSnapshot;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function normaliseTrailingSlash(u: string): string {
	try {
		const parsed = new URL(u);
		if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
			parsed.pathname = parsed.pathname.replace(/\/+$/, "");
		}
		return parsed.toString();
	} catch {
		// If it isn't absolute, fall back to plain trailing-slash strip.
		return u.length > 1 && u.endsWith("/") ? u.replace(/\/+$/, "") : u;
	}
}

function titleBounds(lang: string | null): {
	min: number | null;
	max: number;
	strict: boolean;
} {
	// strict=true means out-of-range emits a warning; strict=false means we
	// only warn when ABOVE the max (no min).
	// Match BCP-47 English ("en", "en-US", "en_GB") but NOT strings that merely
	// start with "en" like "entity" or "english". Accept separator `-` or `_`,
	// or end-of-string.
	const english = typeof lang === "string" && /^en(?:$|[-_])/i.test(lang);
	if (english) {
		const min = Number(process.env.RECCE_TITLE_MIN_LEN ?? "30");
		const max = Number(process.env.RECCE_TITLE_MAX_LEN ?? "65");
		return {
			min: Number.isFinite(min) ? min : 30,
			max: Number.isFinite(max) ? max : 65,
			strict: true,
		};
	}
	const envMax = Number(process.env.RECCE_TITLE_NON_EN_MAX ?? "80");
	const envMinRaw = process.env.RECCE_TITLE_NON_EN_MIN;
	const envMin = envMinRaw !== undefined ? Number(envMinRaw) : NaN;
	return {
		min: Number.isFinite(envMin) ? envMin : null,
		max: Number.isFinite(envMax) ? envMax : 80,
		strict: false,
	};
}

/**
 * Fetch just enough bytes of an og:image to measure its dimensions.
 *
 * Sends `Range: bytes=0-131071` so the server can stream only the header +
 * dimension markers (JPEG SOF, PNG IHDR, WebP VP8X, etc. all within the
 * first ~128 KB in practice). If the server ignores the Range header we
 * still get correct dims — `image-size` only needs the header bytes. Returns
 * null on any failure so the caller can skip the finding.
 */
async function fetchOgImageDims(
	ctx: APIRequestContext,
	absoluteImageUrl: string,
): Promise<{ w: number; h: number } | null> {
	try {
		const res = await ctx.fetch(absoluteImageUrl, {
			timeout: 8000,
			headers: { Range: "bytes=0-131071" },
		});
		// 206 Partial Content OR 200 OK (server ignored Range) are both fine.
		if (!res.ok() && res.status() !== 206) return null;
		const buf = await res.body();
		const dims = imageSize(new Uint8Array(buf));
		const w = dims.width ?? 0;
		const h = dims.height ?? 0;
		if (w === 0 || h === 0) return null;
		return { w, h };
	} catch (e) {
		console.debug(
			`[recce-seo] og:image dim fetch ${absoluteImageUrl} failed:`,
			e,
		);
		return null;
	}
}

// -----------------------------------------------------------------------------
// Main check
// -----------------------------------------------------------------------------

/**
 * Per-run cache of measured og:image dimensions, keyed by absolute URL.
 * Without this, a run that visits N pages which all reference the same
 * shared og:image (very common — the site header/default social image) does
 * N full-body GETs to measure dims. The HEAD/GET status cache in
 * `checkedLinks` already dedupes the reachability probe; this second cache
 * dedupes the second (dims) request.
 *
 * Module-level so it survives across checkSeo calls within the same process.
 * Reset by tests via `__resetSeoDimCache()`.
 */
const ogImageDimCache = new Map<string, { w: number; h: number } | null>();

/** Test-only reset. Exposed for unit tests that want a clean cache. */
export function __resetSeoDimCache(): void {
	ogImageDimCache.clear();
}

export async function checkSeo(
	page: Page,
	options: {
		url: string;
		project: Finding["project"];
		requestContext?: APIRequestContext;
		/**
		 * Shared HEAD/GET status cache (same Map passed to checkImages /
		 * checkLinks). Ensures we never HEAD the same og:image twice per run.
		 */
		checkedLinks?: Map<string, number>;
	},
): Promise<void> {
	const { url, project } = options;
	const ctx = options.requestContext ?? page.context().request;
	const checkedLinks = options.checkedLinks ?? new Map<string, number>();

	let snap: SeoSnapshot;
	try {
		snap = await snapshotSeo(page);
	} catch (e) {
		console.debug(`[recce-seo] snapshotSeo ${url} failed:`, e);
		return;
	}

	// ---- Title ---------------------------------------------------------------
	const trimmedTitle = (snap.title ?? "").trim();
	if (!trimmedTitle) {
		recordFinding({
			url,
			check: "seo-title-missing",
			severity: "error",
			message: "missing or empty <title>",
			expected: "non-empty <title>",
			actual: snap.title === null ? "(no <title>)" : "(whitespace only)",
			project,
		});
	} else {
		const bounds = titleBounds(snap.htmlLang);
		const len = trimmedTitle.length;
		const over = len > bounds.max;
		const under = bounds.min != null && len < bounds.min;
		if (over || under) {
			const range =
				bounds.min != null
					? `${bounds.min}..${bounds.max}`
					: `<= ${bounds.max}`;
			recordFinding({
				url,
				check: "seo-title-length",
				severity: "warn",
				message: `title length ${len} outside ${range} (lang=${snap.htmlLang ?? "(unset)"})`,
				expected: range,
				actual: String(len),
				project,
			});
		}
	}

	// ---- Meta description ----------------------------------------------------
	if (snap.metaDescription == null) {
		recordFinding({
			url,
			check: "seo-description-missing",
			severity: "warn",
			message: `missing <meta name="description">`,
			expected: '<meta name="description" content="...">',
			actual: "(absent)",
			project,
		});
	} else {
		const desc = snap.metaDescription.trim();
		if (desc.length < 50 || desc.length > 160) {
			recordFinding({
				url,
				check: "seo-description-length",
				severity: "warn",
				message: `description length ${desc.length} outside 50..160`,
				expected: "50..160",
				actual: String(desc.length),
				project,
			});
		}
	}

	// ---- H1 ------------------------------------------------------------------
	if (snap.h1s.length === 0) {
		recordFinding({
			url,
			check: "seo-h1-missing",
			severity: "error",
			message: "page has no <h1>",
			expected: "exactly one <h1>",
			actual: "0",
			project,
		});
	} else {
		if (snap.h1s.length > 1) {
			recordFinding({
				url,
				check: "seo-h1-multiple",
				severity: "warn",
				message: `page has ${snap.h1s.length} <h1> elements`,
				expected: "exactly one <h1>",
				actual: String(snap.h1s.length),
				project,
			});
		}
		const empties = snap.h1s.filter((t) => t.trim() === "").length;
		if (empties > 0) {
			recordFinding({
				url,
				check: "seo-h1-empty",
				severity: "error",
				message: `page has ${empties} empty (whitespace-only) <h1>`,
				expected: "non-empty <h1>",
				actual: "(whitespace only)",
				project,
			});
		}
	}

	// ---- Canonical -----------------------------------------------------------
	let canonicalNormalised: string | null = null;
	if (snap.canonical === null) {
		recordFinding({
			url,
			check: "seo-canonical-missing",
			severity: "error",
			message: `missing <link rel="canonical">`,
			expected: '<link rel="canonical" href="https://...">',
			actual: "(absent)",
			project,
		});
	} else {
		const href = snap.canonical.trim();
		// Validate by parsing, not prefix-matching: `startsWith("http")` lets
		// malformed values like "http:invalid" or "https:/oops.com" through,
		// and a parse failure should surface as a finding rather than a
		// silent console.debug.
		let parsed: URL | null = null;
		try {
			parsed = new URL(href);
		} catch {
			parsed = null;
		}
		const absolute =
			parsed != null &&
			(parsed.protocol === "http:" || parsed.protocol === "https:");
		if (!absolute) {
			recordFinding({
				url,
				check: "seo-canonical-invalid",
				severity: "warn",
				message: `canonical is not a valid absolute http(s):// URL: "${href}"`,
				expected: "absolute http(s):// URL",
				actual: href || "(empty)",
				project,
			});
		} else {
			// `absolute` is true ⇒ `parsed` was constructed; type narrowing
			// across the boolean intermediate doesn't survive into this
			// branch, so re-assert.
			const validParsed = parsed as URL;
			try {
				canonicalNormalised = normaliseTrailingSlash(validParsed.href);
			} catch (e) {
				console.debug(`[recce-seo] canonical parse ${href} failed:`, e);
			}
		}
	}

	// ---- Open Graph ----------------------------------------------------------
	const ogIndex = new Map<string, string>();
	for (const tag of snap.og) {
		if (tag.property) ogIndex.set(tag.property.toLowerCase(), tag.content);
	}
	const REQUIRED_OG = ["og:title", "og:description", "og:image", "og:url"];
	let ogImageUrl: string | null = null;
	for (const prop of REQUIRED_OG) {
		const v = ogIndex.get(prop);
		if (v == null || v.trim() === "") {
			recordFinding({
				url,
				check: "seo-og-missing",
				severity: "error",
				message: `missing ${prop}`,
				expected: `<meta property="${prop}" content="...">`,
				actual: prop,
				project,
			});
		} else if (prop === "og:image") {
			ogImageUrl = v.trim();
		}
	}

	const ogUrlValue = ogIndex.get("og:url");
	if (ogUrlValue && canonicalNormalised) {
		const ogUrlNormalised = normaliseTrailingSlash(ogUrlValue.trim());
		if (ogUrlNormalised !== canonicalNormalised) {
			recordFinding({
				url,
				check: "seo-og-url-mismatch",
				severity: "warn",
				message: `og:url !== canonical`,
				expected: canonicalNormalised,
				actual: ogUrlNormalised,
				project,
			});
		}
	}

	// og:image HEAD + dimensions (shared checkedLinks cache).
	if (ogImageUrl) {
		let absoluteImageUrl: string;
		try {
			absoluteImageUrl = new URL(ogImageUrl, url).toString();
		} catch (e) {
			console.debug(`[recce-seo] og:image URL parse ${ogImageUrl} failed:`, e);
			absoluteImageUrl = ogImageUrl;
		}

		// Use the shared headOrGet so cache semantics match checkLinks/checkImages:
		// without this, HEAD-only here would cache 405/403/501 against
		// `absoluteImageUrl` and downstream checks that re-read the cache would
		// skip their own fallback, causing spurious broken-link findings.
		const status = await headOrGet(
			ctx,
			absoluteImageUrl,
			absoluteImageUrl,
			checkedLinks,
			5000,
		);
		if (!(status >= 200 && status < 300)) {
			recordFinding({
				url,
				check: "seo-og-image-unreachable",
				severity: "error",
				message: `og:image unreachable (HTTP ${status})`,
				expected: "2xx",
				actual: String(status),
				project,
			});
		} else {
			// Dims are the expensive part — a full-body GET. Dedupe across
			// pages: the same og:image URL appears on hundreds of pages in
			// practice (shared social-share asset). First hit fetches, all
			// subsequent hits reuse the measured dims.
			let dims = ogImageDimCache.get(absoluteImageUrl);
			if (dims === undefined) {
				dims = await fetchOgImageDims(ctx, absoluteImageUrl);
				ogImageDimCache.set(absoluteImageUrl, dims);
			}
			if (dims == null) {
				// 2xx response but the body did not parse as an image: HTML
				// fallback page, corrupt asset, or unsupported format. Don't
				// silently pass — flag as a separate check so the report
				// surfaces unusable og:image payloads.
				recordFinding({
					url,
					check: "seo-og-image-unparseable",
					severity: "error",
					message: `og:image returned 2xx but dimensions could not be read`,
					expected: "parseable image >= 1200x630",
					actual: absoluteImageUrl,
					project,
				});
			} else if (dims.w < 1200 || dims.h < 630) {
				recordFinding({
					url,
					check: "seo-og-image-small",
					severity: "warn",
					message: `og:image ${dims.w}x${dims.h} (< 1200x630)`,
					expected: ">= 1200x630",
					actual: `${dims.w}x${dims.h}`,
					project,
				});
			}
		}
	}

	// ---- meta charset / viewport --------------------------------------------
	if (snap.metaCharset == null) {
		recordFinding({
			url,
			check: "seo-meta-charset-missing",
			severity: "error",
			message: `missing <meta charset>`,
			expected: '<meta charset="utf-8">',
			actual: "(absent)",
			project,
		});
	}
	if (snap.metaViewport == null) {
		recordFinding({
			url,
			check: "seo-meta-viewport-missing",
			severity: "error",
			message: `missing <meta name="viewport">`,
			expected: '<meta name="viewport" content="width=device-width, ...">',
			actual: "(absent)",
			project,
		});
	}

	// ---- html lang (BCP-47) --------------------------------------------------
	if (snap.htmlLang == null) {
		recordFinding({
			url,
			check: "seo-html-lang-missing",
			severity: "error",
			message: `<html> missing lang attribute`,
			expected: 'lang="en" or similar BCP-47',
			actual: "(absent)",
			project,
		});
	} else if (!isValidBcp47(snap.htmlLang)) {
		recordFinding({
			url,
			check: "seo-html-lang-invalid",
			severity: "warn",
			message: `<html lang="${snap.htmlLang}"> not BCP-47`,
			expected: "^[a-z]{2}(-[A-Z]{2})?$",
			actual: snap.htmlLang,
			project,
		});
	}

	// ---- JSON-LD lightweight parse ------------------------------------------
	// TODO Phase 10: validate LocalBusiness/Place/Article @type semantics per
	// URL pattern. For now we just parse the JSON; full schema validation
	// needs a calibration pass against real valors.io schema output.
	for (const raw of snap.jsonLdBlocks) {
		const body = raw.trim();
		if (!body) continue;
		try {
			JSON.parse(body);
		} catch (e) {
			recordFinding({
				url,
				check: "seo-jsonld-parse-error",
				severity: "warn",
				message: `JSON-LD block failed to parse: ${(e as Error).message}`,
				expected: "valid JSON",
				actual: `${body.slice(0, 80)}${body.length > 80 ? "…" : ""}`,
				project,
			});
		}
	}

	// ---- hreflang resolve (subset of C15) ------------------------------------
	// Only format validation here. Phase 9 adds fetch + reciprocity.
	for (const h of snap.hreflangs) {
		const tag = (h.hreflang || "").trim();
		const href = (h.href || "").trim();
		const validTag = tag === "x-default" || isValidBcp47(tag);
		// Parse hreflang href the same way as canonical. Prefix-match passes
		// malformed absolute-looking values; URL parsing rejects them.
		let absolute = false;
		try {
			const parsed = new URL(href);
			absolute = parsed.protocol === "http:" || parsed.protocol === "https:";
		} catch {
			absolute = false;
		}
		if (!validTag || !absolute) {
			recordFinding({
				url,
				check: "seo-hreflang-invalid",
				severity: "warn",
				message: `hreflang="${tag}" href="${href}" invalid (${!validTag ? "bad tag" : ""}${!validTag && !absolute ? "; " : ""}${!absolute ? "not absolute" : ""})`,
				expected: "BCP-47 or x-default, absolute http(s)://",
				actual: `hreflang=${tag || "(empty)"} href=${href || "(empty)"}`,
				project,
			});
		}
	}
}
