import { expect, type Page, test } from "@playwright/test";
import { checkButtons } from "./utils/checks/buttons";
import { checkImages } from "./utils/checks/images";
import { checkLinks } from "./utils/checks/links";
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
 * Phase 3 adds B1/B2/B4/B5 via the shared check helpers and a shared
 * `checkedLinks` cache so HEAD-dedup spans images + links. Pulse mode caps
 * pages at 25 to stay inside the 5-minute budget.
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

		// Shared caches across B1/B2 for this crawl run.
		const checkedLinks = new Map<string, number>();
		const soft404Context = {
			visited: new Set<string>(),
			soft404Checked: new Set<string>(),
		};

		const result = await crawl(page, {
			baseURL,
			seedUrls: crawlSeeds,
			maxPages: 25,
			project,
			perPageChecks: [
				async (pl, url) => {
					const p = pl as Page;
					soft404Context.visited.add(url);

					// Keep the lightweight phase-2 smoke checks.
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

					// Phase-3 checks. Each helper has its own try/catch internally,
					// but wrap one more layer so a single failure can't abort the
					// crawl.
					try {
						await checkImages(p, { url, project, checkedLinks });
					} catch (e) {
						console.debug(`[crawl-articles] checkImages ${url} failed:`, e);
					}

					try {
						await checkButtons(p, { url, project });
					} catch (e) {
						console.debug(`[crawl-articles] checkButtons ${url} failed:`, e);
					}

					try {
						await checkLinks(p, {
							url,
							project,
							checkedLinks,
							soft404Context,
						});
					} catch (e) {
						console.debug(`[crawl-articles] checkLinks ${url} failed:`, e);
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
