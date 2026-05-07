import type { Page } from "@playwright/test";
import { recordFinding } from "../findings";
import type { Finding } from "../types";

/**
 * Merchant-page hero check (B3). The page is expected to render an
 * `img.object-cover` element that is visible and at least 400px wide
 * (naturalWidth). When present, the hero `alt` attribute must not match
 * the URL slug.
 *
 * Extracted into a shared helper so the unit test in
 * `tests/unit/checks-seeded.test.ts` exercises the same code path the
 * crawler runs in production. Previously the test inlined a near-copy of
 * this rule, which let the production rule regress (e.g. selector or
 * payload change) without failing the unit test.
 */
export async function checkMerchantHero(
	page: Page,
	opts: { url: string; project: Finding["project"]; slug?: string },
): Promise<void> {
	const { url, project, slug } = opts;
	const hero = await page.evaluate(() => {
		const el = document.querySelector(
			"img.object-cover",
		) as HTMLImageElement | null;
		if (!el) return null;
		const rect = el.getBoundingClientRect();
		return {
			naturalWidth: el.naturalWidth || 0,
			naturalHeight: el.naturalHeight || 0,
			visible:
				rect.width > 0 &&
				rect.height > 0 &&
				window.getComputedStyle(el).visibility !== "hidden" &&
				window.getComputedStyle(el).display !== "none",
			alt: el.getAttribute("alt") || "",
			src: el.getAttribute("src") || "",
		};
	});
	if (!hero) {
		recordFinding({
			url,
			check: "hero-missing",
			severity: "error",
			message: `merchant page has no img.object-cover`,
			element: { tag: "img", selector: "img.object-cover" },
			expected: "img.object-cover present",
			actual: "(not found)",
			project,
		});
		return;
	}
	if (!hero.visible) {
		recordFinding({
			url,
			check: "hero-not-visible",
			severity: "error",
			message: `hero img.object-cover not visible`,
			element: {
				tag: "img",
				selector: "img.object-cover",
				attr: { src: hero.src },
			},
			expected: "visible",
			actual: "hidden",
			project,
		});
	}
	if (hero.naturalWidth < 400) {
		recordFinding({
			url,
			check: "hero-too-small",
			severity: "error",
			message: `hero naturalWidth=${hero.naturalWidth} (<400)`,
			element: {
				tag: "img",
				selector: "img.object-cover",
				attr: { src: hero.src },
			},
			expected: ">= 400",
			actual: String(hero.naturalWidth),
			project,
		});
	}
	if (
		slug &&
		hero.alt &&
		hero.alt.toLowerCase() === slug.toLowerCase()
	) {
		recordFinding({
			url,
			check: "hero-alt-matches-slug",
			severity: "warn",
			message: `hero alt matches url slug "${slug}"`,
			element: {
				tag: "img",
				selector: "img.object-cover",
				attr: { alt: hero.alt },
			},
			project,
		});
	}
}
