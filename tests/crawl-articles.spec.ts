import { expect, test } from "@playwright/test";
import { crawl } from "./utils/crawler";
import { recordFinding } from "./utils/findings";
import type { Finding } from "./utils/types";

/**
 * /articles BFS pulse crawl.
 *
 * Phase 2 scope:
 *   - Drive the new crawler primitive end-to-end.
 *   - Apply only two lightweight per-page checks: "body length > 100" and
 *     "at least one image". Failures are pushed through recordFinding()
 *     rather than raised via expect(), so the spec never aborts mid-crawl.
 *
 * Pulse mode caps pages at 25 (overriding the default 50) to keep wall-time
 * well inside the 5-minute budget.
 */

test.describe("Articles BFS crawl", () => {
	const crawlSeeds = [
		"/",
		"/articles/en/Mexico/CDMX/Ciudad-de-Mexico/coffee_shop",
	];

	test("crawl and verify articles pages", async ({
		page,
		baseURL,
	}, testInfo) => {
		if (!baseURL) {
			throw new Error("BASE_URL required — see playwright.config.ts");
		}
		const project = testInfo.project.name as Finding["project"];

		const result = await crawl(page, {
			baseURL,
			seedUrls: crawlSeeds,
			maxPages: 25,
			project,
			perPageChecks: [
				async (p, url) => {
					try {
						const bodyText = await p.evaluate(() => {
							return (document.body?.innerText ?? "").trim();
						});
						if ((bodyText as string).length <= 100) {
							recordFinding({
								url,
								check: "body-too-short",
								severity: "warn",
								message: `body innerText too short (${(bodyText as string).length} chars)`,
								expected: "> 100 chars",
								actual: String((bodyText as string).length),
								project,
							});
						}
					} catch (e) {
						console.debug(`[crawl-articles] body check ${url} failed:`, e);
					}

					try {
						const imageCount = await p.evaluate(
							() => document.querySelectorAll("img").length,
						);
						if ((imageCount as number) === 0) {
							recordFinding({
								url,
								check: "no-images",
								severity: "warn",
								message: "page has zero <img> elements",
								expected: ">= 1",
								actual: "0",
								project,
							});
						}
					} catch (e) {
						console.debug(`[crawl-articles] img check ${url} failed:`, e);
					}
				},
			],
		});

		console.log(
			`[crawl-articles] crawled=${result.crawled.length} discovered=${result.discoveredLinks.size} rateLimited=${result.rateLimited}`,
		);
		expect(
			result.crawled.length,
			"crawler produced zero pages — seed list or sitemap broken",
		).toBeGreaterThan(0);
	});
});
