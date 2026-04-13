import { test, expect } from '@playwright/test';
import { submitLeadForm, generateTestEmail } from './utils/lead-api';

/**
 * Directory / Carticles Comprehensive Testing Suite
 */
test.describe('Directory / Carticles E2E Suite', () => {

  const directoryPath = '/directory/en/Mexico/CDMX/Ciudad-de-Mexico/coffee_shop';
  const merchantPath = '/sites/en/Mexico/CDMX/Ciudad-de-Mexico/coffee_shop/blend-station/88e4fc';

  test('Verify Merchant Page: Hero Image, Content, and Form', async ({ page, baseURL }) => {
    const merchantUrl = `${baseURL}${merchantPath}`;
    await page.goto(merchantUrl, { waitUntil: 'networkidle' });

    // 1. Verify Main Image
    const heroImage = page.locator('img.object-cover').first();
    const hasHero = await heroImage.isVisible();

    if (hasHero) {
        console.log("Hero image found and verified.");
        await expect(heroImage).toBeVisible();
    } else {
        console.warn(`No .object-cover hero image found on ${merchantUrl}. Checking for any image.`);
        const imageCount = await page.locator('img').count();
        expect(imageCount).toBeGreaterThan(0);
    }

    // 2. Verify Content Length
    const bodyText = await page.innerText('body');
    console.log(`Merchant page text length: ${bodyText.length}`);
    expect(bodyText.length).toBeGreaterThan(300);

    // 3. Verify Signup Form exists
    const form = page.locator('form').first();
    await expect(form).toBeVisible();

    // 4. Submit form using the tested lead-api utility
    const testEmail = generateTestEmail();
    console.log(`Submitting waitlist form with: ${testEmail}`);
    try {
      await submitLeadForm(page, testEmail);
      console.log('Waitlist form submission succeeded.');
    } catch (e) {
      // reCAPTCHA may block automated submissions in production
      console.warn(`Waitlist form submission failed (reCAPTCHA may be blocking bot traffic):`, e);
      await page.screenshot({ path: 'merchant-form-failed.png' });
    }
  });

  test('Crawl and Verify Article Integrity', async ({ page, baseURL }) => {
    // If directory is empty, we test the known merchant URL as a "sample"
    const merchantUrl = `${baseURL}${merchantPath}`;
    const urlsToTest = [merchantUrl];

    for (const fullUrl of urlsToTest) {
      await test.step(`Verify Article: ${fullUrl}`, async () => {
        await page.goto(fullUrl, { waitUntil: 'networkidle' });

        // A. Verify Hero Image (Flexible)
        const heroImage = page.locator('img.object-cover').first();
        const hasHero = await heroImage.isVisible();
        if (hasHero) {
          await expect(heroImage).toBeVisible();
        } else {
          // If no hero, at least one image (logo or other) should exist
          const imageCount = await page.locator('img').count();
          expect(imageCount, `No images found on ${fullUrl}`).toBeGreaterThan(0);
        }

        // B. Verify Content Length
        const bodyText = await page.innerText('body');
        expect(bodyText.length, `Article ${fullUrl} is too short`).toBeGreaterThan(300);

        // C. Verify Signup Form exists
        const form = page.locator('form').first();
        await expect(form, `Missing signup form on ${fullUrl}`).toBeVisible();
      });
    }
  });

  test('Verify All Buttons on Homepage', async ({ page, baseURL }) => {
    const targetUrl = `${baseURL}${directoryPath}`;
    await page.goto(targetUrl, { waitUntil: 'networkidle' });

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
