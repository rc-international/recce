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
	// pulse mode now crawls politely (3s between pages, 300ms between in-page
	// HEADs, daily-rotated seed sample) to avoid Vercel/CDN per-IP rate-limit
	// cascades. Pulse run length was ~5–7 min on the old aggressive crawler;
	// the polite cadence pushes that to ~30–60 min, so allow 90min envelope.
	// Daily cron has no urgency — the report only needs to land once per day.
	globalTimeout:
		(process.env.RECCE_MODE as "pulse" | "audit") === "audit"
			? 2 * 60 * 60 * 1000
			: 90 * 60 * 1000,
	// Per-test cap. Default Playwright test timeout is 30s, but the BFS specs
	// (seo-meta, crawl-articles, crawl-merchants) drive crawl() which under
	// the polite cadence hits 100 pages × ~6s each ≈ 10min just for goto
	// pacing, plus checks. Pulse needs 80min so a single spec can finish the
	// 100-page sample without tripping per-test timeout. Audit gets the same
	// envelope; globalTimeout (90min pulse, 2h audit) is the outer wall.
	// (Observed 2026-05-06: prior 5min cap fired after ~50 pages, leaving
	// the runner wedged for 82min until globalTimeout cleaned up.)
	timeout: 80 * 60 * 1000,
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
