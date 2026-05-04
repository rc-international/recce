import { defineConfig, devices } from "@playwright/test";

/**
 * Recce - Standalone E2E Sanity Suite
 *
 * This project is decoupled from the main app repo.
 * It takes a BASE_URL and runs daily "pulse check" tests.
 */
export default defineConfig({
	testDir: "./tests",
	// tests/unit/** is driven by `bun test`, not Playwright — those files import
	// `bun:test`, which Playwright's transformer can't resolve. Keep them out of
	// the Playwright test sweep so both runners can coexist.
	testIgnore: ["**/unit/**"],
	globalSetup: "./tests/global-setup.ts",
	globalTeardown: "./tests/global-teardown.ts",
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	workers: 1,
	// Safety net — bound the entire suite. If any single spec or worker stalls
	// (e.g. SSR cold-start cascading into stuck networkidle waits, accumulated
	// listener leaks, or Playwright's between-spec lifecycle wedging), the
	// runner force-stops, runs globalTeardown, and the Discord reporter's
	// onEnd still fires. Without this, a hung worker keeps the parent node
	// process alive indefinitely (observed 2026-05-04: pulse hung at ~13min
	// with chromium renderer in futex_wait, no sockets, test runner CPU-hot).
	// pulse mode normally finishes in 5–7 min; audit needs a wider envelope.
	globalTimeout:
		(process.env.RECCE_MODE as "pulse" | "audit") === "audit"
			? 60 * 60 * 1000
			: 15 * 60 * 1000,
	// Per-test cap. Default Playwright test timeout is 30s, but the BFS specs
	// (seo-meta, crawl-articles, crawl-merchants) drive crawl() which hits
	// 10–15 pages × ~20s each. Bump to 5min so the legitimate work finishes,
	// while still bounding individual stalls so globalTimeout doesn't have to
	// be the only safety net.
	timeout: 5 * 60 * 1000,
	reporter: [
		["html"],
		...(process.env.RECCE_DISCORD_WEBHOOK
			? [["./tests/utils/discord-reporter.ts"] as [string]]
			: []),
	],
	use: {
		// The target URL of the application to test.
		// BASE_URL must be set explicitly (no production default) so a misconfigured
		// local run cannot accidentally hit prod. The cron wrapper run-daily.sh
		// supplies BASE_URL=https://valors.io for the scheduled job.
		baseURL: (() => {
			const url = process.env.BASE_URL;
			if (!url)
				throw new Error(
					"BASE_URL is required (e.g. BASE_URL=https://valors.io or http://localhost:3000)",
				);
			return url;
		})(),
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
