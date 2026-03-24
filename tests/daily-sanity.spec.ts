import { test, expect } from '@playwright/test';

/**
 * Daily Sanity Check
 * 
 * 1. Crawls the homepage for internal links.
 * 2. Augments with fallback "Seed URLs" for high-value pages.
 * 3. Randomly samples 10 URLs to verify basic health.
 */
test.describe('E2E Sanity Suite', () => {

  const seedUrls = [
    '/directory/en/colombia/antioquia/medellin',
    '/directory/en/colombia/antioquia/medellin/cafe',
    '/directory/en/colombia/antioquia/medellin/restaurant',
  ];

  test('Crawl and verify health of random pages', async ({ page, baseURL }) => {
    console.log(`Starting sanity check for: ${baseURL}`);

    // --- CRAWL PHASE ---
    await page.goto('/');
    
    // Simple crawl for all internal <a> tags
    const crawledLinks = await page.evaluate((origin) => {
      return Array.from(document.querySelectorAll('a'))
        .map(a => a.getAttribute('href'))
        .filter(href => href && (href.startsWith('/') || href.startsWith(origin)))
        .filter(href => !href?.includes('#') && !href?.includes(':'))
        .map(href => (href?.startsWith('/') ? href : new URL(href!).pathname));
    }, baseURL);

    const allCandidateUrls = [...new Set([...seedUrls, ...crawledLinks])];
    console.log(`Discovered ${allCandidateUrls.length} total potential pages.`);

    // --- SAMPLING PHASE ---
    const sampleCount = Math.min(10, allCandidateUrls.length);
    const selectedUrls = allCandidateUrls
      .sort(() => 0.5 - Math.random())
      .slice(0, sampleCount);

    console.log(`Executing health checks on: ${selectedUrls.join(', ')}`);

    // --- VERIFICATION PHASE ---
    for (const url of selectedUrls) {
      await test.step(`Verify URL: ${url}`, async () => {
        // Delay to prevent overwhelming servers and triggering rate limits
        await page.waitForTimeout(1000); 

        const response = await page.goto(url);
        
        // Log basic metrics (optional, Playwright traces will capture more detail)
        console.log(`Visited ${url} - Status: ${response?.status()}`);

        if (response?.status() === 429) {
          console.warn(`[SKIP] Rate limited (429) on ${url}.`);
          return;
        }

        // 1. Assert successful response
        expect(response?.status(), `Non-200 status code at ${url}`).toBe(200);

        // 2. Basic structural integrity check
        // We expect any valid page to at least have a header and footer visible
        await expect(page.locator('header').first()).toBeVisible();
        await expect(page.locator('footer').first()).toBeVisible();
      });
    }
  });
});
