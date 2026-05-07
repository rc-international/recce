import type { Finding } from "../types";

/**
 * Selector-health meta-check (C13).
 *
 * Tracks hit counts for (pageType, selector) pairs. If a required selector
 * matches zero elements across the first 20 observed pages of its type, the
 * flush step emits a `check-selector-dead` finding at `warn` severity.
 *
 * This protects downstream checks (e.g. hero-image, CTA-button) from silently
 * becoming no-ops after upstream CSS refactors.
 *
 * Usage:
 *   recordSelectorHit('merchant', '.hero-img', await page.locator('.hero-img').count());
 *
 * At the end of the run, call flushSelectorHealth() and pass each returned
 * Finding through recordFinding(). The module intentionally does NOT call
 * recordFinding directly so consumers can decorate with `url` (usually the
 * run's baseURL since the check is run-wide).
 */

const SAMPLE_CAP = 20;

type Bucket = {
	pageType: string;
	selector: string;
	observed: number; // number of pages checked (up to SAMPLE_CAP)
	totalMatched: number; // sum of matched-element counts across observed pages
};

const buckets: Map<string, Bucket> = new Map();

function key(pageType: string, selector: string): string {
	return `${pageType}::${selector}`;
}

export function recordSelectorHit(
	pageType: string,
	selector: string,
	matched: number,
): void {
	const k = key(pageType, selector);
	let b = buckets.get(k);
	if (!b) {
		b = { pageType, selector, observed: 0, totalMatched: 0 };
		buckets.set(k, b);
	}
	if (b.observed >= SAMPLE_CAP) return;
	b.observed += 1;
	b.totalMatched += Math.max(0, matched);
}

/**
 * Returns findings for every bucket whose total matched count is zero after
 * at least one observation. Callers decorate the finding with the baseURL.
 */
export function flushSelectorHealth(
	baseURL: string,
	project: Finding["project"] = "chromium",
): Finding[] {
	const out: Finding[] = [];
	for (const b of buckets.values()) {
		if (b.observed === 0) continue;
		if (b.totalMatched === 0) {
			out.push({
				url: baseURL,
				check: "check-selector-dead",
				severity: "warn",
				message: `selector "${b.selector}" matched 0 elements across ${b.observed} ${b.pageType} pages`,
				element: { tag: "selector", selector: b.selector },
				expected: ">0 matches",
				actual: "0",
				project,
			});
		}
	}
	return out;
}

/**
 * Test-only reset. Not exported from any public entry point in production.
 */
export function _resetSelectorHealth(): void {
	buckets.clear();
}
