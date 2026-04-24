import type { Page } from "@playwright/test";

/**
 * Seeded-bug fixtures used by Phase-3 unit tests to verify that each check
 * (B1 broken image, B2 soft-404, B3 missing hero, B4 duplicate images, B5
 * disabled / reCAPTCHA-managed buttons) detects the exact failure shape
 * described in the plan.
 *
 * Uses Playwright's `page.route()` to intercept a stable set of test-only
 * URLs under the `/__recce_test/*` namespace. Real URLs pass through
 * untouched: the route matcher matches only on the exact `/__recce_test/*`
 * prefix.
 *
 * Each fixture corresponds to a single check under test. Keeping the HTML
 * minimal (no external CSS / no head clutter) makes the expectations easy
 * to reason about.
 */

const FIXTURE_PREFIX = "/__recce_test/";

type FixtureBody = {
	status?: number;
	contentType: string;
	body: string | Buffer;
};

// 10x10 GIF — used for fixtures that need a real image response. Larger
// than the 2x2 tracking-pixel exemption in images.ts so the image-level
// checks (broken / duplicate) actually see these fixture images.
const TEN_PX_GIF = Buffer.from(
	"R0lGODlhCgAKAIAAAP///wAAACH5BAAAAAAALAAAAAAKAAoAAAIWjC2Zhyoc3DOgAnXslfqo3mCMBJFMAQA7",
	"base64",
);

function html(body: string, title = "Seeded Fixture"): FixtureBody {
	return {
		contentType: "text/html; charset=utf-8",
		body: `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`,
	};
}

const FIXTURES: Record<string, FixtureBody> = {
	// B1: article-body image whose src returns 404.
	"broken-image": html(
		`<main><article>
			<p>Broken image test.</p>
			<img src="/__recce_test/missing.jpg" alt="missing">
		</article></main>`,
		"Broken Image Fixture",
	),

	// The 404 target referenced by the broken-image fixture.
	"missing.jpg": {
		status: 404,
		contentType: "text/plain",
		body: "not found",
	},

	// B2: soft-404 page (HTTP 200 + "Not Found" title + < 100 chars body).
	"soft-404": {
		contentType: "text/html; charset=utf-8",
		body: `<!doctype html><html><head><title>Not Found</title></head><body><h1>404 — page missing</h1><p>gone</p></body></html>`,
	},

	// B3: merchant-shaped page with NO img.object-cover (hero missing).
	"missing-hero": html(
		`<main><article>
			<h1>Merchant Without Hero</h1>
			<p>Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</p>
			<img src="/__recce_test/body-image.jpg" alt="body image only">
		</article></main>`,
		"Missing Hero",
	),

	// Serves the body-image referenced above (so B1 doesn't fail on merchant
	// fixtures — we want the hero failure to be the only finding).
	"body-image.jpg": {
		status: 200,
		contentType: "image/gif",
		body: TEN_PX_GIF,
	},

	// B4: same <img src> repeated 3 times.
	"duplicate-images": html(
		`<main><article>
			<p>Duplicate test.</p>
			<img src="/__recce_test/cat.jpg" alt="cat 1">
			<img src="/__recce_test/cat.jpg" alt="cat 2">
			<img src="/__recce_test/cat.jpg" alt="cat 3">
		</article></main>`,
		"Duplicate Images Fixture",
	),

	"cat.jpg": {
		status: 200,
		contentType: "image/gif",
		body: TEN_PX_GIF,
	},

	// B5a: disabled button.
	"disabled-button": html(
		`<main><button disabled>Click</button></main>`,
		"Disabled Button",
	),

	// B5b: reCAPTCHA-managed button — initially enabled, disabled 300ms
	// after load via inline script.
	"recaptcha-button": {
		contentType: "text/html; charset=utf-8",
		body: `<!doctype html><html><head><title>reCAPTCHA</title></head><body>
			<form data-recaptcha>
				<button id="submit" type="submit">Submit</button>
			</form>
			<script>
				setTimeout(() => {
					const b = document.getElementById('submit');
					if (b) b.setAttribute('disabled', '');
				}, 300);
			</script>
		</body></html>`,
	},
};

/**
 * Install the seeded-bug routes on the given Playwright page. Matches only
 * exact `/__recce_test/<key>` paths — everything else is let through via
 * `route.fallback()`.
 */
export async function installSeededBugs(page: Page): Promise<void> {
	await page.route("**/__recce_test/*", async (route) => {
		try {
			const url = new URL(route.request().url());
			const key = url.pathname.replace(FIXTURE_PREFIX, "");
			const fixture = FIXTURES[key];
			if (!fixture) {
				await route.fulfill({
					status: 404,
					contentType: "text/plain",
					body: `no seeded fixture: ${key}`,
				});
				return;
			}
			await route.fulfill({
				status: fixture.status ?? 200,
				contentType: fixture.contentType,
				body: fixture.body,
			});
		} catch (e) {
			console.debug(`[seeded-bugs] route handler failed:`, e);
			try {
				await route.abort("failed");
			} catch (abortErr) {
				console.debug(`[seeded-bugs] route.abort also failed:`, abortErr);
			}
		}
	});
}

/**
 * Exposed for tests that need to construct an absolute fixture URL.
 */
export function fixtureUrl(base: string, key: string): string {
	const b = base.endsWith("/") ? base.slice(0, -1) : base;
	return `${b}${FIXTURE_PREFIX}${key}`;
}

export const SEEDED_FIXTURE_KEYS = Object.keys(FIXTURES);
