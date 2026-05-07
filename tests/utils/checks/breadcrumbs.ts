import type { Page } from "@playwright/test";
import { recordFinding } from "../findings";
import type { Finding } from "../types";

/**
 * Breadcrumb integrity check (C20).
 *
 * Validates that pages under `/articles/<lang>/<country>[/<city>[/...]]`
 * emit a `BreadcrumbList` JSON-LD block whose shape matches the URL depth:
 *
 *   - depth 3  (e.g. /articles/es/mexico)
 *       → exactly 1 ListItem (the country itself, no `item` URL)
 *
 *   - depth ≥ 4 (e.g. /articles/es/Mexico/ciudad-de-mexico)
 *       → ≥ 2 ListItems
 *       → every non-final ListItem has an absolute http(s) `item` URL
 *       → the FIRST ListItem's `item` resolves to the country page
 *         (`/articles/<lang>/<country>` — case-insensitive match on country)
 *       → every ListItem has a non-empty `name`
 *
 * On non-country leaf pages (depth ≥ 4) we additionally verify that the
 * visible breadcrumb anchor pointing to the country page is rendered, since
 * the JSON-LD block alone could pass validation while the user-visible
 * breadcrumb regresses (e.g. CSS hides it, or the React component drops the
 * link).
 *
 * Pages that aren't under `/articles/` are skipped — `/sites/`, `/`, etc.
 * have their own structures.
 */

type ListItem = {
	"@type"?: string;
	position?: number;
	name?: string;
	item?: string;
};

type BreadcrumbList = {
	"@context"?: string;
	"@type"?: string;
	itemListElement?: ListItem[];
};

function findBreadcrumbList(blocks: string[]): BreadcrumbList | null {
	for (const raw of blocks) {
		const body = raw.trim();
		if (!body) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch {
			continue;
		}
		// Accept top-level BreadcrumbList or @graph-wrapped variant.
		const candidates: unknown[] = [];
		if (Array.isArray(parsed)) candidates.push(...parsed);
		else candidates.push(parsed);
		for (const c of candidates) {
			if (c && typeof c === "object") {
				const obj = c as { "@type"?: string; "@graph"?: unknown[] };
				if (obj["@type"] === "BreadcrumbList") return obj as BreadcrumbList;
				if (Array.isArray(obj["@graph"])) {
					for (const g of obj["@graph"]) {
						if (
							g &&
							typeof g === "object" &&
							(g as { "@type"?: string })["@type"] === "BreadcrumbList"
						) {
							return g as BreadcrumbList;
						}
					}
				}
			}
		}
	}
	return null;
}

function isAbsoluteHttp(url: string | undefined): boolean {
	if (!url) return false;
	try {
		const u = new URL(url);
		return u.protocol === "http:" || u.protocol === "https:";
	} catch {
		return false;
	}
}

function pathSegments(pathname: string): string[] {
	return pathname.split("/").filter(Boolean);
}

export async function checkBreadcrumbs(
	page: Page,
	opts: { url: string; project: Finding["project"] },
): Promise<void> {
	const { url, project } = opts;

	let parsedUrl: URL;
	try {
		parsedUrl = new URL(url);
	} catch (e) {
		console.debug(`[recce-breadcrumbs] bad url ${url}:`, e);
		return;
	}
	const segs = pathSegments(parsedUrl.pathname);
	if (segs[0] !== "articles") return;
	// Need at least /articles/<lang>/<country> (3 segs) to reason about
	// breadcrumb shape.
	if (segs.length < 3) return;

	const [, lang, country] = segs;
	const isCountryPage = segs.length === 3;

	// Pull JSON-LD blocks + the visible country-link anchor in one round-trip.
	const snap = await page.evaluate(() => {
		const blocks = Array.from(
			document.querySelectorAll('script[type="application/ld+json"]'),
		).map((s) => s.textContent || "");
		const anchors = Array.from(document.querySelectorAll("a[href]")).map(
			(a) => ({
				href: a.getAttribute("href") || "",
				text: (a.textContent || "").trim(),
			}),
		);
		return { blocks, anchors };
	});

	const bc = findBreadcrumbList(snap.blocks);
	if (!bc) {
		recordFinding({
			url,
			check: "breadcrumb-missing",
			severity: "error",
			message: "no BreadcrumbList JSON-LD block on /articles/ page",
			expected: 'application/ld+json with "@type":"BreadcrumbList"',
			actual: "(absent)",
			project,
		});
		return;
	}

	const items = Array.isArray(bc.itemListElement) ? bc.itemListElement : [];
	if (items.length === 0) {
		recordFinding({
			url,
			check: "breadcrumb-empty",
			severity: "error",
			message: "BreadcrumbList has zero itemListElement entries",
			expected: ">= 1 ListItem",
			actual: "0",
			project,
		});
		return;
	}

	// Country pages should have exactly one ListItem (the country itself).
	if (isCountryPage && items.length !== 1) {
		recordFinding({
			url,
			check: "breadcrumb-country-shape",
			severity: "warn",
			message: `country page expected exactly 1 BreadcrumbList item, got ${items.length}`,
			expected: "1 item",
			actual: String(items.length),
			project,
		});
	}

	// Every item must have a non-empty name.
	for (const [i, it] of items.entries()) {
		const name = (it.name || "").trim();
		if (!name) {
			recordFinding({
				url,
				check: "breadcrumb-name-empty",
				severity: "warn",
				message: `BreadcrumbList item position=${it.position ?? i + 1} has empty name`,
				expected: "non-empty name",
				actual: "(empty)",
				project,
			});
		}
	}

	// Non-final items must carry an absolute http(s) `item` URL so the
	// breadcrumb is navigable. The final item is the current page, where
	// `item` is conventionally omitted.
	for (let i = 0; i < items.length - 1; i++) {
		const it = items[i];
		if (!isAbsoluteHttp(it?.item)) {
			recordFinding({
				url,
				check: "breadcrumb-item-not-absolute",
				severity: "error",
				message: `BreadcrumbList item position=${it?.position ?? i + 1} has missing or non-absolute "item" URL`,
				expected: "absolute http(s):// URL",
				actual: it?.item || "(missing)",
				project,
			});
		}
	}

	// Leaf pages: first crumb must point at /articles/<lang>/<country>
	// (case-insensitive — production preserves country capitalization in URLs
	// like /articles/es/Mexico, but the entry country page uses lowercase
	// like /articles/es/mexico). Both are valid; we just want the breadcrumb
	// to land on the right country.
	if (!isCountryPage && items.length >= 2) {
		const first = items[0];
		if (isAbsoluteHttp(first?.item)) {
			let firstUrl: URL | null = null;
			try {
				firstUrl = new URL(first?.item ?? "");
			} catch {
				firstUrl = null;
			}
			const firstSegs = firstUrl ? pathSegments(firstUrl.pathname) : [];
			const firstLang = firstSegs[1];
			const firstCountry = firstSegs[2];
			const sameOrigin = firstUrl?.origin === parsedUrl.origin;
			const matchesLang = firstLang === lang;
			const matchesCountry =
				(firstCountry || "").toLowerCase() === (country || "").toLowerCase();
			// First crumb must point at the COUNTRY page itself, not a deeper
			// city under the same country (which would still satisfy lang +
			// country segment checks but is not the correct breadcrumb root).
			const isCountryDepth = firstSegs.length === 3;
			if (
				!sameOrigin ||
				!matchesLang ||
				!matchesCountry ||
				!isCountryDepth
			) {
				recordFinding({
					url,
					check: "breadcrumb-country-link-wrong",
					severity: "error",
					message: `first breadcrumb item should link to /articles/${lang}/${country}, got "${first?.item ?? "(missing)"}"`,
					expected: `same-origin /articles/${lang}/${country.toLowerCase()}`,
					actual: first?.item || "(missing)",
					project,
				});
			}
		}

		// Visible breadcrumb anchor: the country link should be rendered as
		// an <a> on the page, not just present in JSON-LD. Match by pathname
		// case-insensitively to allow /articles/es/Mexico vs /articles/es/mexico.
		const expectedPathLower = `/articles/${lang}/${country}`.toLowerCase();
		const hasVisibleCountryAnchor = snap.anchors.some((a) => {
			let href = a.href;
			try {
				href = new URL(a.href, parsedUrl.origin).pathname;
			} catch {
				/* href may be a fragment / mailto / etc — skip */
				return false;
			}
			return href.toLowerCase() === expectedPathLower;
		});
		if (!hasVisibleCountryAnchor) {
			recordFinding({
				url,
				check: "breadcrumb-country-anchor-missing",
				severity: "warn",
				message: `no visible <a href> pointing back to /articles/${lang}/${country}`,
				expected: `visible anchor to /articles/${lang}/${country.toLowerCase()}`,
				actual: "(no matching anchor)",
				project,
			});
		}
	}
}
