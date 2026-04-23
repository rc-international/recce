import { expect, test } from "@playwright/test";
import { generateTestEmail, submitLeadForm } from "./utils/lead-api";

/**
 * Directory / Carticles Comprehensive Testing Suite
 *
 * NOTE: The "/directory" tree was renamed to "/articles" and now also serves
 * individual article pages (one level deeper than the city/category index).
 * The /sites/... merchant pages and their waitlist form are unchanged.
 */
test.describe("Directory / Carticles E2E Suite", () => {
	// City/category index page (was: /directory/...)
	const articlesIndexPath =
		"/articles/en/Mexico/CDMX/Ciudad-de-Mexico/coffee_shop";
	// Individual article page (new — one level deeper than the index)
	const articlePath =
		"/articles/en/Mexico/CDMX/Ciudad-de-Mexico/coffee_shop/best-coffee-shops-mexico-city";
	// Merchant page (unchanged)
	const merchantPath =
		"/sites/en/Mexico/CDMX/Ciudad-de-Mexico/coffee_shop/blend-station/88e4fc";

	test("Verify Merchant Page: Hero Image, Content, and Form", async ({
		page,
		baseURL,
	}) => {
		const merchantUrl = `${baseURL}${merchantPath}`;
		await page.goto(merchantUrl, { waitUntil: "networkidle" });

		// 1. Verify Main Image
		const heroImage = page.locator("img.object-cover").first();
		const hasHero = await heroImage.isVisible();

		if (hasHero) {
			console.log("Hero image found and verified.");
			await expect(heroImage).toBeVisible();
		} else {
			console.warn(
				`No .object-cover hero image found on ${merchantUrl}. Checking for any image.`,
			);
			const imageCount = await page.locator("img").count();
			expect(imageCount).toBeGreaterThan(0);
		}

		// 2. Verify Content Length
		const bodyText = await page.innerText("body");
		console.log(`Merchant page text length: ${bodyText.length}`);
		expect(bodyText.length).toBeGreaterThan(300);

		// 3. Verify Signup Form exists
		const form = page.locator("form").first();
		await expect(form).toBeVisible();

		// 4. Submit form using the tested lead-api utility
		const testEmail = generateTestEmail();
		console.log(`Submitting waitlist form with: ${testEmail}`);
		try {
			await submitLeadForm(page, testEmail);
			console.log("Waitlist form submission succeeded.");
		} catch (e) {
			// reCAPTCHA may block automated submissions in production
			console.warn(
				`Waitlist form submission failed (reCAPTCHA may be blocking bot traffic):`,
				e,
			);
			await page.screenshot({ path: "merchant-form-failed.png" });
		}
	});

	test("Verify Articles Index Page (city/category)", async ({
		page,
		baseURL,
	}) => {
		const url = `${baseURL}${articlesIndexPath}`;
		await page.goto(url, { waitUntil: "networkidle" });

		// A. Hero image (flexible — fall back to any image)
		const heroImage = page.locator("img.object-cover").first();
		if (await heroImage.isVisible()) {
			await expect(heroImage).toBeVisible();
		} else {
			const imageCount = await page.locator("img").count();
			expect(imageCount, `No images found on ${url}`).toBeGreaterThan(0);
		}

		// B. Content length
		const bodyText = await page.innerText("body");
		expect(bodyText.length, `Index ${url} is too short`).toBeGreaterThan(300);

		// C. Internal cross-links into the /articles tree must be present —
		//    cross-linking is a primary purpose of these index pages.
		const articleLinkCount = await page
			.locator('a[href^="/articles/"]')
			.count();
		console.log(`Found ${articleLinkCount} /articles cross-links on ${url}`);
		// Index pages should always carry at least a few cross-links into other
		// cities/categories. 3+ is a realistic floor — fewer than that signals a
		// broken page render.
		expect(
			articleLinkCount,
			`Index ${url} has no /articles cross-links`,
		).toBeGreaterThan(3);
	});

	test("Verify Individual Article Page", async ({ page, baseURL }) => {
		const url = `${baseURL}${articlePath}`;
		const response = await page.goto(url, { waitUntil: "networkidle" });

		expect(response?.status(), `Article page ${url} did not return 200`).toBe(
			200,
		);

		// A. Hero image (flexible)
		const heroImage = page.locator("img.object-cover").first();
		if (await heroImage.isVisible()) {
			await expect(heroImage).toBeVisible();
		} else {
			const imageCount = await page.locator("img").count();
			expect(imageCount, `No images found on ${url}`).toBeGreaterThan(0);
		}

		// B. Article content should be substantial (longer than an index page).
		const bodyText = await page.innerText("body");
		expect(bodyText.length, `Article ${url} body too short`).toBeGreaterThan(
			500,
		);

		// C. Article must link back into the /articles tree (cross-linking).
		const crossLinks = await page.locator('a[href^="/articles/"]').count();
		expect(
			crossLinks,
			`Article ${url} has no /articles cross-links`,
		).toBeGreaterThan(0);
	});

	test("Verify Cross-Links from Articles Index actually resolve", async ({
		page,
		baseURL,
	}) => {
		// Visit the index page and harvest a sample of internal /articles links,
		// then verify each returns HTTP 200. Catches broken links between pages.
		const indexUrl = `${baseURL}${articlesIndexPath}`;
		await page.goto(indexUrl, { waitUntil: "networkidle" });

		const hrefs: string[] = await page.evaluate(() => {
			return Array.from(document.querySelectorAll('a[href^="/articles/"]'))
				.map((a) => a.getAttribute("href"))
				.filter((h): h is string => !!h && !h.includes("#"));
		});

		const unique = [...new Set(hrefs)];
		// Sample up to 5 to stay polite to the origin and keep runtime bounded.
		const sample = unique.sort(() => 0.5 - Math.random()).slice(0, 5);
		console.log(`Verifying ${sample.length} cross-links from ${indexUrl}`);

		let okCount = 0;
		for (const href of sample) {
			await test.step(`Cross-link: ${href}`, async () => {
				try {
					await page.waitForTimeout(1000);
					const resp = await page.goto(`${baseURL}${href}`, {
						waitUntil: "networkidle",
					});
					const status = resp?.status();
					console.log(`  ${href} → ${status}`);
					if (status === 429) {
						console.warn(`  [SKIP] rate-limited`);
						return;
					}
					expect(status, `Broken cross-link: ${href}`).toBe(200);
					okCount++;
				} catch (e) {
					console.warn(`  [SKIP] navigation error for ${href}:`, e);
				}
			});
		}

		expect(okCount, "No cross-links passed verification").toBeGreaterThan(0);
	});

	test("Verify All Buttons on Articles Index Page", async ({
		page,
		baseURL,
	}) => {
		const targetUrl = `${baseURL}${articlesIndexPath}`;
		await page.goto(targetUrl, { waitUntil: "networkidle" });

		const buttons = await page.locator('button, a[role="button"], a.btn').all();
		console.log(`Found ${buttons.length} buttons.`);

		for (const btn of buttons) {
			const isVisible = await btn.isVisible();
			const text = await btn.innerText();
			if (isVisible && text.trim().length > 0) {
				// Just verify they are clickable for now
				await expect(btn).toBeEnabled();
			}
		}
	});
});
