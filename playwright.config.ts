import { defineConfig, devices } from "@playwright/test";

/**
 * Recce - Standalone E2E Sanity Suite
 *
 * This project is decoupled from the main app repo.
 * It takes a BASE_URL and runs daily "pulse check" tests.
 */
export default defineConfig({
	testDir: "./tests",
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	workers: 1,
	reporter: [
		["html"],
		...(process.env.RECCE_DISCORD_WEBHOOK
			? [["./tests/utils/discord-reporter.ts"] as [string]]
			: []),
	],
	use: {
		// The target URL of the application to test
		baseURL: process.env.BASE_URL || "https://valors.io",
		trace: "on-first-retry",
		screenshot: "only-on-failure",
		video: "on-first-retry",
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
		{
			name: "Mobile Chrome",
			use: { ...devices["Pixel 5"] },
		},
		{
			name: "webkit",
			use: { ...devices["Desktop Safari"] },
		},
	],
});
