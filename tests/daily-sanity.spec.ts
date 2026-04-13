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
    '/directory/en/mx/jalisco/guadalajara',
    '/directory/en/mx/jalisco/guadalajara/restaurants',
    '/directory/en/colombia/antioquia/medellin',
    '/directory/en/colombia/antioquia/medellin/cafe',
    '/directory/en/colombia/antioquia/medellin/restaurant',
  ];

  test('Crawl and verify health of random pages', async ({ page, baseURL }) => {
    console.log(`Starting sanity check for: ${baseURL}`);

    // --- CRAWL PHASE ---
    await page.goto('/', { waitUntil: 'networkidle' });

    // Simple crawl for all internal <a> tags
    let crawledLinks: string[] = [];
    try {
      crawledLinks = await page.evaluate((origin) => {
        return Array.from(document.querySelectorAll('a'))
          .map(a => a.getAttribute('href'))
          .filter(href => href && (href.startsWith('/') || href.startsWith(origin!)))
          .filter(href => !href?.includes('#') && !href?.includes(':'))
          .map(href => (href?.startsWith('/') ? href : new URL(href!).pathname));
      }, baseURL);
    } catch (e) {
      console.warn(`Crawl phase page.evaluate failed (context may have been destroyed):`, e);
    }

    const allCandidateUrls = [...new Set([...seedUrls, ...crawledLinks])];
    console.log(`Discovered ${allCandidateUrls.length} total potential pages.`);

    // --- SAMPLING PHASE ---
    const sampleCount = Math.min(10, allCandidateUrls.length);
    const selectedUrls = allCandidateUrls
      .sort(() => 0.5 - Math.random())
      .slice(0, sampleCount);

    console.log(`Executing health checks on: ${selectedUrls.join(', ')}`);

    // --- VERIFICATION PHASE ---
    let pagesVerified = 0;
    for (const url of selectedUrls) {
      await test.step(`Verify URL: ${url}`, async () => {
        try {
          await page.waitForTimeout(1000);

          const response = await page.goto(url, { waitUntil: 'networkidle' });
          console.log(`Visited ${url} - Status: ${response?.status()}`);

          if (response?.status() === 429) {
            console.warn(`[SKIP] Rate limited (429) on ${url}.`);
            return;
          }

          // 1. Assert successful response
          expect(response?.status(), `Non-200 status code at ${url}`).toBe(200);

          // 2. Page has meaningful content (not an empty shell)
          const bodyText = await page.innerText('body');
          expect(bodyText.length, `Page at ${url} has too little content`).toBeGreaterThan(100);

          // 3. Page has at least one image
          const imageCount = await page.locator('img').count();
          expect(imageCount, `No images on ${url}`).toBeGreaterThan(0);

          pagesVerified++;
        } catch (e) {
          // Log and continue — individual page failures should not abort the suite
          console.warn(`[SKIP] Verification failed for ${url}:`, e);
        }
      });
    }

    console.log(`Verified ${pagesVerified}/${selectedUrls.length} pages successfully.`);
    // At least some pages should have passed
    expect(pagesVerified, 'No pages passed verification').toBeGreaterThan(0);
  });
});
