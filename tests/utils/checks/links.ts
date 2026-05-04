import type { APIRequestContext, Page } from "@playwright/test";
import { recordFinding } from "../findings";
import type { Finding } from "../types";
import { headOrGet } from "./net";

/**
 * B2 — broken-link + wrong-destination + DOM-based soft-404 check.
 *
 * Harvests every `<a[href]>` on the current page, classifies each href,
 * and emits findings for:
 *   - unreachable internal/external URLs
 *   - "wrong destination" heuristics (unterpolated templates, dev/staging
 *     hostnames, literal undefined/null/[object Object])
 *   - malformed mailto/tel
 *   - protocol-relative hrefs (warn)
 *   - SPA-safe soft-404 (title/h1/body signals after page.goto)
 *
 * Shares a `checkedLinks: Map<string, number>` with B1 so the same URL is
 * never HEAD'd twice in one run.
 */

const WRONG_DEST_SUBSTRINGS = ["{{", "${", "%7B%7B", "<%"];
const LITERAL_BAD = ["undefined", "null", "[object object]"];
const LEAKED_HOSTS =
	/(?:^|\.)(?:localhost|127\.0\.0\.1)(?::|$|\/)|(?:^|\.)(?:staging|dev)\./i;
const SOFT_404_RE =
	/not found|404|error|p[aá]gina no encontrada|p[aá]gina n[aã]o encontrada/i;
const EXTERNAL_HEAD_CAP_PER_PAGE = 50;
const MAILTO_RE = /^mailto:[^@\s]+@[^\s@]+\.[^\s@]+$/i;
const TEL_RE = /^tel:\+?[\d\s().-]{3,}$/i;

type LinkClass =
	| "internal"
	| "external"
	| "mailto"
	| "tel"
	| "protocol-relative"
	| "other"
	| "empty";

function classify(href: string, baseOrigin: string): LinkClass {
	if (!href) return "empty";
	const h = href.trim();
	if (!h) return "empty";
	if (h.startsWith("//")) return "protocol-relative";
	if (h.toLowerCase().startsWith("mailto:")) return "mailto";
	if (h.toLowerCase().startsWith("tel:")) return "tel";
	try {
		const u = new URL(h, baseOrigin);
		if (u.origin === new URL(baseOrigin).origin) return "internal";
		if (u.protocol === "http:" || u.protocol === "https:") return "external";
		return "other";
	} catch (e) {
		console.debug(`[recce-links] classify(${h}) failed:`, e);
		return "other";
	}
}

type Soft404Context = {
	/**
	 * URLs already crawled by the caller — no need to re-navigate these; their
	 * DOM-signal check is redundant.
	 */
	visited?: Set<string>;
	/**
	 * URLs we've already soft-404-checked (globally, not just HEAD).
	 */
	soft404Checked: Set<string>;
};

/**
 * Navigate to `target` and evaluate title/h1/body for soft-404 signals.
 * Returns a finding if any signal matches, else null.
 */
async function detectSoft404(
	page: Page,
	target: string,
	project: Finding["project"],
	sourceUrl: string,
): Promise<Finding | null> {
	try {
		const resp = await page.goto(target, {
			waitUntil: "domcontentloaded",
			timeout: 15000,
		});
		if (!resp) return null;
		const status = resp.status();
		// Non-2xx is already a broken-link signal — don't double-report.
		if (status < 200 || status >= 300) return null;
		const info = (await page.evaluate(() => {
			const title = document.title || "";
			const h1 = document.querySelector("h1")?.textContent || "";
			const body = (document.body?.innerText || "").trim();
			return { title, h1, bodyLen: body.length };
		})) as { title: string; h1: string; bodyLen: number };

		const titleHit = SOFT_404_RE.test(info.title);
		const h1Hit = SOFT_404_RE.test(info.h1);
		const shortBody = info.bodyLen < 100;

		if (!titleHit && !h1Hit && !shortBody) return null;

		const reasons: string[] = [];
		if (titleHit) reasons.push(`title="${info.title}"`);
		if (h1Hit) reasons.push(`h1="${info.h1}"`);
		if (shortBody) reasons.push(`bodyLen=${info.bodyLen}`);

		return {
			url: sourceUrl,
			check: "soft-404",
			severity: "error",
			message: `soft-404 on ${target}: ${reasons.join(", ")}`,
			element: { tag: "a", attr: { href: target } },
			expected: "not found/404 absent, body>=100 chars",
			actual: reasons.join("; "),
			project,
		};
	} catch (e) {
		console.debug(`[recce-links] soft-404 navigation ${target} threw:`, e);
		return null;
	}
}

/**
 * Run B2 for a single page. Collects hrefs, classifies, HEAD-validates with
 * dedup across `checkedLinks`, and samples soft-404 on unique internal hrefs.
 */
export async function checkLinks(
	page: Page,
	options: {
		url: string;
		project: Finding["project"];
		checkedLinks: Map<string, number>;
		requestContext?: APIRequestContext;
		soft404Context?: Soft404Context;
	},
): Promise<void> {
	const { url, project, checkedLinks } = options;
	const ctx = options.requestContext ?? page.context().request;
	const soft404Ctx = options.soft404Context ?? {
		visited: new Set<string>(),
		soft404Checked: new Set<string>(),
	};

	let hrefs: string[] = [];
	try {
		hrefs = (await page.evaluate(() => {
			return Array.from(document.querySelectorAll("a[href]"))
				.map((a) => a.getAttribute("href"))
				.filter((h): h is string => !!h && h.length > 0);
		})) as string[];
	} catch (e) {
		console.debug(`[recce-links] harvest hrefs failed for ${url}:`, e);
		return;
	}

	const uniqueHrefs = Array.from(new Set(hrefs));

	const baseOrigin = (() => {
		try {
			return new URL(url).origin;
		} catch (e) {
			console.debug(`[recce-links] parse base url ${url} failed:`, e);
			return url;
		}
	})();

	let externalHeadCount = 0;
	const internalForSoft404: string[] = [];

	for (const href of uniqueHrefs) {
		const hl = href.toLowerCase();

		// Wrong-destination substring checks.
		let wrongDest = "";
		for (const s of WRONG_DEST_SUBSTRINGS) {
			if (hl.includes(s.toLowerCase())) {
				wrongDest = `contains ${s}`;
				break;
			}
		}
		if (!wrongDest) {
			for (const lit of LITERAL_BAD) {
				if (hl === lit || hl.endsWith(`/${lit}`)) {
					wrongDest = `literal ${lit}`;
					break;
				}
			}
		}
		if (!wrongDest && LEAKED_HOSTS.test(href)) {
			wrongDest = `leaked non-prod host`;
		}
		if (wrongDest) {
			recordFinding({
				url,
				check: "wrong-destination",
				severity: "error",
				message: `href ${wrongDest}: ${href}`,
				element: { tag: "a", attr: { href } },
				expected: "production URL, interpolated",
				actual: href,
				project,
			});
			continue;
		}

		const kind = classify(href, baseOrigin);

		if (kind === "empty" || kind === "other") continue;

		if (kind === "protocol-relative") {
			recordFinding({
				url,
				check: "protocol-relative-link",
				severity: "warn",
				message: `protocol-relative href: ${href}`,
				element: { tag: "a", attr: { href } },
				expected: "absolute https URL",
				actual: href,
				project,
			});
			continue;
		}

		if (kind === "mailto") {
			if (!MAILTO_RE.test(href)) {
				recordFinding({
					url,
					check: "mailto-malformed",
					severity: "warn",
					message: `mailto: missing or invalid email: ${href}`,
					element: { tag: "a", attr: { href } },
					expected: "mailto:<addr>@<host>",
					actual: href,
					project,
				});
			}
			continue;
		}

		if (kind === "tel") {
			if (!TEL_RE.test(href)) {
				recordFinding({
					url,
					check: "tel-malformed",
					severity: "warn",
					message: `tel: invalid format: ${href}`,
					element: { tag: "a", attr: { href } },
					expected: "tel: digits + + - ( )",
					actual: href,
					project,
				});
			}
			continue;
		}

		// internal / external — HEAD validate (with per-page external cap).
		let absolute = href;
		try {
			absolute = new URL(href, url).toString();
		} catch (e) {
			console.debug(`[recce-links] absolutise(${href}) failed:`, e);
			continue;
		}

		if (kind === "external") {
			if (externalHeadCount >= EXTERNAL_HEAD_CAP_PER_PAGE) continue;
			externalHeadCount += 1;
			const status = await headOrGet(
				ctx,
				absolute,
				absolute,
				checkedLinks,
				5000,
			);
			if (status === 0) {
				recordFinding({
					url,
					check: "external-link-unreachable",
					severity: "warn",
					message: `external link unreachable: ${absolute}`,
					element: { tag: "a", attr: { href } },
					actual: "network error",
					project,
				});
			} else if (status >= 400) {
				recordFinding({
					url,
					check: "broken-link",
					severity: "warn",
					message: `external link HTTP ${status}: ${absolute}`,
					element: { tag: "a", attr: { href } },
					actual: `HTTP ${status}`,
					project,
				});
			}
			continue;
		}

		// internal
		const status = await headOrGet(ctx, absolute, absolute, checkedLinks, 5000);
		if (status === 0) {
			// Unreachable (network error, DNS fail, connect timeout). Treat as
			// error for internal links — the origin should always resolve its
			// own URLs. Mirror the external branch's `-unreachable` check name
			// for consistency, and do NOT feed unreachable URLs into the
			// soft-404 sweep (no 2xx body to classify).
			recordFinding({
				url,
				check: "internal-link-unreachable",
				severity: "error",
				message: `internal link unreachable: ${absolute}`,
				element: { tag: "a", attr: { href } },
				actual: "network error",
				project,
			});
			continue;
		}
		if (status >= 400) {
			recordFinding({
				url,
				check: "broken-link",
				severity: "error",
				message: `internal link HTTP ${status}: ${absolute}`,
				element: { tag: "a", attr: { href } },
				actual: `HTTP ${status}`,
				project,
			});
			continue;
		}

		// Candidate for soft-404 DOM scan.
		if (
			!soft404Ctx.visited?.has(absolute) &&
			!soft404Ctx.soft404Checked.has(absolute)
		) {
			internalForSoft404.push(absolute);
		}
	}

	// Soft-404 sweep — navigates the Playwright page away from `url`. Because
	// this is destructive to the current page state, we only do it AFTER all
	// in-DOM checks on the current page are complete. The caller's crawl loop
	// will re-goto its next URL anyway.
	for (const target of internalForSoft404) {
		if (soft404Ctx.soft404Checked.has(target)) continue;
		soft404Ctx.soft404Checked.add(target);
		const finding = await detectSoft404(page, target, project, url);
		if (finding) recordFinding(finding);
	}
}
