import { expect, type Page } from "@playwright/test";

export function generateTestEmail(): string {
	const now = new Date();
	const ts = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
	const rand = Math.random().toString(36).slice(2, 6);
	return `recce-run-${ts}-${rand}@valors.io`;
}

/**
 * Submits the merchant site waitlist form by filling and clicking submit.
 * The React form handles reCAPTCHA token generation, HMAC auth, and API posting.
 * Requires the test server IP to be whitelisted so reCAPTCHA passes.
 */
export async function submitLeadForm(
	page: Page,
	testEmail: string,
): Promise<void> {
	// Wait 4s to pass the 3s time gate in WaitlistForm
	await page.waitForTimeout(4000);

	// Fill visible form fields
	await page.locator("#givenName").fill("E2E");
	await page.locator("#familyName").fill("Tester");
	await page.locator("#email").fill(testEmail);

	// Submit — the React form handles reCAPTCHA + HMAC + API call
	await page.locator('button[type="submit"]').click();

	// Wait for success state (ES: "¡Estás en la lista!", PT: "Você está na lista!")
	await expect(
		page.locator("text=/Estás en la lista|Você está na lista/i"),
	).toBeVisible({ timeout: 20000 });
}
