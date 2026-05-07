import type { Page } from "@playwright/test";
import { recordFinding } from "../findings";
import type { Finding } from "../types";

/**
 * Country-page integrity check (C21).
 *
 * Activates only on URLs that match `/articles/<lang>/<country>` (depth 3).
 * Country pages are the entry into each locale's article tree and the
 * primary catch for content-pipeline regressions:
 *
 *   - city-list density — country pages aggregate city pages; a regression
 *     in the city aggregator can render the page nearly empty without
 *     affecting any individual city. Minimum count guards against this.
 *
 *   - hreflang locale coverage — every country page is expected to ship in
 *     all three site locales (en, es, pt). The SEO check (C2) validates
 *     hreflang FORMAT but not COVERAGE, so a missing locale could ship
 *     undetected.
 *
 *   - self-canonical — `<link rel="canonical">` on a country page must
 *     resolve to the same path (case-insensitive) as the current URL.
 *
 *   - h1 presence — exactly one non-empty `<h1>`. Lighter-weight than the
 *     SEO check's H1 rule, scoped to country pages.
 *
 * Configurable via env:
 *   RECCE_COUNTRY_MIN_CITIES      (default 3) — minimum city links required.
 *   RECCE_COUNTRY_REQUIRED_LOCALES
 *     (default "en,es,pt") — comma-separated lang prefixes that must
 *     appear in hreflang tags. We match by prefix (e.g. "pt" matches
 *     "pt-BR") so production's `pt-BR` tag satisfies a `pt` requirement.
 */

const MIN_CITIES = Number(process.env.RECCE_COUNTRY_MIN_CITIES ?? "3");
const REQUIRED_LOCALES = (
	process.env.RECCE_COUNTRY_REQUIRED_LOCALES ?? "en,es,pt"
)
	.split(",")
	.map((s) => s.trim().toLowerCase())
	.filter(Boolean);

function pathSegments(pathname: string): string[] {
	return pathname.split("/").filter(Boolean);
}

function normalisePathLower(p: string): string {
	const trimmed = p.replace(/\/+$/, "");
	return trimmed.toLowerCase();
}

export async function checkCountryPage(
	page: Page,
	opts: { url: string; project: Finding["project"] },
): Promise<void> {
	const { url, project } = opts;

	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch (e) {
		console.debug(`[recce-country] bad url ${url}:`, e);
		return;
	}
	const segs = pathSegments(parsed.pathname);
	if (segs[0] !== "articles") return;
	if (segs.length !== 3) return;

	const [, lang, country] = segs;

	const snap = await page.evaluate(() => {
		const h1Els = Array.from(document.querySelectorAll("h1"));
		const h1Texts = h1Els.map((el) => (el.textContent || "").trim());
		const canonical =
			document
				.querySelector('link[rel="canonical"]')
				?.getAttribute("href") ?? "";
		const hreflangs = Array.from(
			document.querySelectorAll('link[rel="alternate"][hreflang]'),
		).map((el) => ({
			hreflang: (el.getAttribute("hreflang") || "").trim(),
			href: (el.getAttribute("href") || "").trim(),
		}));
		const anchors = Array.from(document.querySelectorAll("a[href]")).map(
			(a) => a.getAttribute("href") || "",
		);
		return { h1Texts, canonical, hreflangs, anchors };
	});

	// ---- City link density --------------------------------------------------
	// Match anchors that point at /articles/<lang>/<country>/<...> (depth ≥ 4),
	// case-insensitive on the country segment because production preserves
	// capitalization (/articles/es/Mexico/ciudad-de-mexico) while the country
	// page itself can be either case.
	const expectedCountryLower = country.toLowerCase();
	const cityHrefs = new Set<string>();
	for (const href of snap.anchors) {
		let resolved: URL;
		try {
			resolved = new URL(href, parsed.origin);
		} catch {
			continue;
		}
		// Only same-origin anchors count toward density. `new URL(absolute, base)`
		// uses the absolute href as-is, so a cross-origin anchor like
		// `https://partner.test/articles/es/Mexico/city` would otherwise pass
		// every segment check below and inflate the count.
		if (resolved.origin !== parsed.origin) continue;
		const path = resolved.pathname;
		const hSegs = pathSegments(path);
		if (
			hSegs.length >= 4 &&
			hSegs[0] === "articles" &&
			hSegs[1] === lang &&
			(hSegs[2] || "").toLowerCase() === expectedCountryLower
		) {
			cityHrefs.add(path.toLowerCase());
		}
	}
	if (cityHrefs.size < MIN_CITIES) {
		recordFinding({
			url,
			check: "country-too-few-cities",
			severity: "error",
			message: `country page lists ${cityHrefs.size} city link(s) (< ${MIN_CITIES}); aggregator may have regressed`,
			expected: `>= ${MIN_CITIES} city links to /articles/${lang}/${country}/<city>`,
			actual: String(cityHrefs.size),
			project,
		});
	}

	// ---- Hreflang locale coverage -------------------------------------------
	// Every country page should ship in all required locales. Match by lang
	// prefix so "pt-BR" satisfies a "pt" requirement.
	const seenLocales = new Set<string>();
	for (const tag of snap.hreflangs) {
		const lower = tag.hreflang.toLowerCase();
		if (lower === "x-default") continue;
		const prefix = lower.split("-")[0];
		if (prefix) seenLocales.add(prefix);
	}
	const missing = REQUIRED_LOCALES.filter((l) => !seenLocales.has(l));
	if (missing.length > 0) {
		recordFinding({
			url,
			check: "country-hreflang-coverage",
			severity: "warn",
			message: `country page missing hreflang locale(s): ${missing.join(", ")}`,
			expected: `hreflang tags for: ${REQUIRED_LOCALES.join(", ")}`,
			actual: `hreflang tags for: ${[...seenLocales].sort().join(", ") || "(none)"}`,
			project,
		});
	}

	// ---- Self-canonical -----------------------------------------------------
	if (snap.canonical) {
		try {
			const canon = new URL(snap.canonical);
			if (canon.origin !== parsed.origin) {
				recordFinding({
					url,
					check: "country-canonical-cross-origin",
					severity: "error",
					message: `canonical points to different origin: ${snap.canonical}`,
					expected: `same-origin canonical (${parsed.origin})`,
					actual: snap.canonical,
					project,
				});
			} else if (
				normalisePathLower(canon.pathname) !==
				normalisePathLower(parsed.pathname)
			) {
				recordFinding({
					url,
					check: "country-canonical-mismatch",
					severity: "warn",
					message: `canonical pathname ${canon.pathname} does not match URL pathname ${parsed.pathname}`,
					expected: `canonical pathname == ${parsed.pathname.toLowerCase()}`,
					actual: canon.pathname,
					project,
				});
			}
		} catch (e) {
			console.debug(`[recce-country] canonical parse ${snap.canonical}:`, e);
		}
	}

	// ---- H1 sanity ----------------------------------------------------------
	const nonEmptyH1s = snap.h1Texts.filter((t) => t.length > 0);
	if (nonEmptyH1s.length === 0) {
		recordFinding({
			url,
			check: "country-h1-missing",
			severity: "error",
			message: "country page has no non-empty <h1>",
			expected: "1 non-empty <h1>",
			actual: snap.h1Texts.length === 0 ? "0 <h1>" : "<h1> empty",
			project,
		});
	} else if (snap.h1Texts.length > 1) {
		recordFinding({
			url,
			check: "country-h1-multiple",
			severity: "warn",
			message: `country page has ${snap.h1Texts.length} <h1> elements (expected 1)`,
			expected: "1",
			actual: String(snap.h1Texts.length),
			project,
		});
	}
}
