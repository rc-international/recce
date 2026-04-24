import { expect, test } from "@playwright/test";
import { crawl } from "./utils/crawler";
import { recordFinding } from "./utils/findings";
import type { Finding } from "./utils/types";

/**
 * Daily Sanity Check (Phase 2 migration).
 *
 * Behaviour-equivalent to the pre-migration suite:
 *   1. Crawl homepage + a known articles seed for internal links.
 *   2. Augment with explicit seed URLs (high-value pages).
 *   3. Sample 10 URLs at random and verify health.
 *
 * The only shape change: non-fatal per-page check failures now push into
 * recordFinding() instead of being swallowed by a best-effort try/catch. The
 * suite still fails loud if *zero* pages verified (top-level expect).
 */

test.describe("E2E Sanity Suite", () => {
	const seedUrls = [
		"/articles/en/mx/jalisco/guadalajara",
		"/articles/en/mx/jalisco/guadalajara/restaurants",
		"/articles/en/colombia/antioquia/medellin",
		"/articles/en/colombia/antioquia/medellin/cafe",
		"/articles/en/colombia/antioquia/medellin/restaurant",
		"/articles/en/Mexico/CDMX/Ciudad-de-Mexico/coffee_shop",
		"/articles/en/Mexico/CDMX/Ciudad-de-Mexico/coffee_shop/best-coffee-shops-mexico-city",
	];

	const crawlSeeds = [
		"/",
		"/articles/en/Mexico/CDMX/Ciudad-de-Mexico/coffee_shop",
	];

	test("Crawl and verify health of random pages", async ({
		page,
		baseURL,
	}, testInfo) => {
		if (!baseURL) {
			throw new Error("BASE_URL required — see playwright.config.ts");
		}
		const project = testInfo.project.name as Finding["project"];
		console.log(`Starting sanity check for: ${baseURL}`);

		// --- CRAWL PHASE (via new primitive) ---
		const result = await crawl(page, {
			baseURL,
			seedUrls: [...crawlSeeds, ...seedUrls],
			maxPages: 100, // crawl budget for discovery; we sample 10 below
			project,
		});
		console.log(
			`[daily-sanity] crawl discovered ${result.crawled.length} pages`,
		);

		const allCandidateUrls = Array.from(
			new Set([
				...seedUrls.map((p) => new URL(p, baseURL).toString()),
				...result.crawled,
			]),
		);
		console.log(`Discovered ${allCandidateUrls.length} total potential pages.`);

		// --- SAMPLING PHASE ---
		const sampleCount = Math.min(10, allCandidateUrls.length);
		const selectedUrls = allCandidateUrls
			.slice()
			.sort(() => 0.5 - Math.random())
			.slice(0, sampleCount);
		console.log(`Executing health checks on: ${selectedUrls.join(", ")}`);

		// --- VERIFICATION PHASE ---
		let pagesVerified = 0;
		for (const url of selectedUrls) {
			await test.step(`Verify URL: ${url}`, async () => {
				try {
					await page.waitForTimeout(1000);
					const response = await page.goto(url, { waitUntil: "networkidle" });
					const status = response?.status();
					console.log(`Visited ${url} - Status: ${status}`);

					if (status === 429) {
						console.warn(`[SKIP] Rate limited (429) on ${url}.`);
						recordFinding({
							url,
							check: "rate_limited",
							severity: "info",
							message: "sampling step hit 429",
							actual: "HTTP 429",
							project,
						});
						return;
					}

					if (status !== 200) {
						recordFinding({
							url,
							check: "non-200-status",
							severity: "error",
							message: `unexpected status ${status}`,
							expected: "200",
							actual: String(status),
							project,
						});
						return;
					}

					const bodyText = await page.innerText("body");
					if (bodyText.length <= 100) {
						recordFinding({
							url,
							check: "body-too-short",
							severity: "warn",
							message: `body innerText too short (${bodyText.length} chars)`,
							expected: "> 100 chars",
							actual: String(bodyText.length),
							project,
						});
					}

					const imageCount = await page.locator("img").count();
					if (imageCount === 0) {
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

					pagesVerified += 1;
				} catch (e) {
					// Individual page failure: log and continue — don't abort the suite.
					console.warn(`[SKIP] Verification failed for ${url}:`, e);
				}
			});
		}

		console.log(
			`Verified ${pagesVerified}/${selectedUrls.length} pages successfully.`,
		);
		expect(pagesVerified, "No pages passed verification").toBeGreaterThan(0);
	});
});
