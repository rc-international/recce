import { expect, type Page, test } from "@playwright/test";
import { checkSeo } from "./utils/checks/seo";
import { crawl } from "./utils/crawler";
import type { Finding } from "./utils/types";

/**
 * SEO meta BFS (C2 — Phase 5b).
 *
 * Samples articles + merchants URLs via the shared crawl() primitive and
 * runs checkSeo on every reached page. The shared `checkedLinks` cache is
 * plumbed through so og:image HEAD/GET requests are deduplicated across
 * pages that share the same social preview.
 *
 * Pulse mode caps pages at 15 to stay comfortably under the 5-minute
 * budget; audit mode defers to the crawler default cap.
 */

test.describe("SEO meta BFS crawl (C2)", () => {
	const crawlSeeds = [
		"/",
		"/articles/en/Mexico/CDMX/Ciudad-de-Mexico/coffee_shop",
		"/sites/en/Mexico/CDMX/Ciudad-de-Mexico/coffee_shop/blend-station/88e4fc",
	];

	test("crawl and verify SEO meta per page", async ({
		page,
		baseURL,
	}, testInfo) => {
		if (!baseURL) {
			throw new Error("BASE_URL required — see playwright.config.ts");
		}
		const project = testInfo.project.name as Finding["project"];
		const mode = (process.env.RECCE_MODE as "pulse" | "audit") || "pulse";
		const maxPages = mode === "audit" ? 2000 : 15;

		// Shared caches across the crawl. og:image URLs often repeat across
		// the same article tree so HEAD dedup matters.
		const checkedLinks = new Map<string, number>();

		const result = await crawl(page, {
			baseURL,
			seedUrls: crawlSeeds,
			maxPages,
			project,
			perPageChecks: [
				async (pl, url) => {
					const p = pl as Page;
					try {
						await checkSeo(p, {
							url,
							project,
							requestContext: p.context().request,
							checkedLinks,
						});
					} catch (e) {
						console.debug(`[seo-meta] checkSeo ${url} failed:`, e);
					}
				},
			],
		});

		console.log(
			`[seo-meta] crawled=${result.crawled.length} rateLimited=${result.rateLimited}`,
		);
		expect(
			result.crawled.length,
			"crawler produced zero pages — seed list or sitemap broken",
		).toBeGreaterThan(0);
	});
});
