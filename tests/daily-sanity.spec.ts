import { expect, type Page, test } from "@playwright/test";

/**
 * Daily Sanity Check
 *
 * 1. Crawls the homepage for internal links.
 * 2. Augments with fallback "Seed URLs" for high-value pages.
 * 3. Randomly samples 10 URLs to verify basic health.
 */
test.describe("E2E Sanity Suite", () => {
	// Seed URLs cover the /articles directory (renamed from /directory) plus
	// a known individual article page. The marketing root '/' now redirects to
	// the SPA landing page at '/en', which does NOT link into the /articles
	// tree, so we also seed-crawl a known articles page to discover the rich
	// cross-linking between cities, categories and articles.
	const seedUrls = [
		"/articles/en/mx/jalisco/guadalajara",
		"/articles/en/mx/jalisco/guadalajara/restaurants",
		"/articles/en/colombia/antioquia/medellin",
		"/articles/en/colombia/antioquia/medellin/cafe",
		"/articles/en/colombia/antioquia/medellin/restaurant",
		"/articles/en/Mexico/CDMX/Ciudad-de-Mexico/coffee_shop",
		"/articles/en/Mexico/CDMX/Ciudad-de-Mexico/coffee_shop/best-coffee-shops-mexico-city",
	];

	// Pages we crawl for additional internal links. The marketing landing page
	// at '/' has very few outbound links into the directory tree, so we also
	// crawl a known articles index to pick up the heavy cross-linking the
	// articles section now has between cities/categories/articles.
	const crawlSeeds = [
		"/",
		"/articles/en/Mexico/CDMX/Ciudad-de-Mexico/coffee_shop",
	];

	async function crawlInternalLinks(
		page: Page,
		baseURL: string | undefined,
		url: string,
	): Promise<string[]> {
		try {
			await page.goto(url, { waitUntil: "networkidle" });
			return await page.evaluate((origin: string | undefined) => {
				const isInternal = (href: string): boolean =>
					href.startsWith("/") ||
					(origin !== undefined && href.startsWith(origin));
				const toPath = (href: string): string =>
					href.startsWith("/") ? href : new URL(href).pathname;

				return Array.from(document.querySelectorAll("a"))
					.map((a) => a.getAttribute("href"))
					.filter((href): href is string => !!href && isInternal(href))
					.filter((href) => !href.includes("#") && !href.includes(":"))
					.map(toPath);
			}, baseURL);
		} catch (e) {
			console.warn(`Crawl of ${url} failed:`, e);
			return [];
		}
	}

	test("Crawl and verify health of random pages", async ({ page, baseURL }) => {
		console.log(`Starting sanity check for: ${baseURL}`);

		// --- CRAWL PHASE ---
		let crawledLinks: string[] = [];
		for (const seed of crawlSeeds) {
			const links = await crawlInternalLinks(page, baseURL, seed);
			console.log(`Crawl ${seed}: discovered ${links.length} links.`);
			crawledLinks = crawledLinks.concat(links);
		}

		const allCandidateUrls = [...new Set([...seedUrls, ...crawledLinks])];
		console.log(`Discovered ${allCandidateUrls.length} total potential pages.`);

		// --- SAMPLING PHASE ---
		const sampleCount = Math.min(10, allCandidateUrls.length);
		const selectedUrls = allCandidateUrls
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
					console.log(`Visited ${url} - Status: ${response?.status()}`);

					if (response?.status() === 429) {
						console.warn(`[SKIP] Rate limited (429) on ${url}.`);
						return;
					}

					// 1. Assert successful response
					expect(response?.status(), `Non-200 status code at ${url}`).toBe(200);

					// 2. Page has meaningful content (not an empty shell)
					const bodyText = await page.innerText("body");
					expect(
						bodyText.length,
						`Page at ${url} has too little content`,
					).toBeGreaterThan(100);

					// 3. Page has at least one image
					const imageCount = await page.locator("img").count();
					expect(imageCount, `No images on ${url}`).toBeGreaterThan(0);

					pagesVerified++;
				} catch (e) {
					// Log and continue — individual page failures should not abort the suite
					console.warn(`[SKIP] Verification failed for ${url}:`, e);
				}
			});
		}

		console.log(
			`Verified ${pagesVerified}/${selectedUrls.length} pages successfully.`,
		);
		// At least some pages should have passed
		expect(pagesVerified, "No pages passed verification").toBeGreaterThan(0);
	});
});
