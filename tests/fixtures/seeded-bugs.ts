import type { BrowserContext, Page } from "@playwright/test";

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

// 200x200 grayscale PNG — too small for og:image spec (needs >= 1200x630).
const SMALL_PNG_200 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAMgAAADICAAAAACIM/FCAAAA8klEQVR4nO3PAQkAMAzAsEm/9JsYvJxEQTvnE/M6YIuRGiM1RmqM1BipMVJjpMZIjZEaIzVGaozUGKkxUmOkxkiNkRojNUZqjNQYqTFSY6TGSI2RGiM1RmqM1BipMVJjpMZIjZEaIzVGaozUGKkxUmOkxkiNkRojNUZqjNQYqTFSY6TGSI2RGiM1RmqM1BipMVJjpMZIjZEaIzVGaozUGKkxUmOkxkiNkRojNUZqjNQYqTFSY6TGSI2RGiM1RmqM1BipMVJjpMZIjZEaIzVGaozUGKkxUmOkxkiNkRojNUZqjNQYqTFSY6TGSI2RGiM1RmounJgkkxZSiJkAAAAASUVORK5CYII=",
	"base64",
);

// 1200x630 grayscale PNG — meets og:image dimension minimum.
const OG_PNG_1200x630 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAABLAAAAJ2CAAAAABqKySAAAAIHUlEQVR4nO3UMQ0AMAzAsPJHVlilsG+KZCPIlVmAiPkdAPDKsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwgw7CADMMCMgwLyDAsIMOwgAzDAjIMC8gwLCDDsIAMwwIyDAvIMCwg4wBugKguz5gUlAAAAABJRU5ErkJggg==",
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

	// ---- Phase 5a fixtures (C3 + C4 + C7 + C8) --------------------------------

	// C3: script that throws synchronously during parse -> pageerror event.
	pageerror: {
		contentType: "text/html; charset=utf-8",
		body: `<!doctype html><html><head><title>Seeded pageerror</title></head><body>
			<h1>Seeded pageerror</h1>
			<script>throw new Error('seeded pageerror')</script>
		</body></html>`,
	},

	// C3: console.error during load.
	"console-error": {
		contentType: "text/html; charset=utf-8",
		body: `<!doctype html><html><head><title>Seeded console-error</title></head><body>
			<h1>Seeded console error</h1>
			<script>console.error('seeded console error')</script>
		</body></html>`,
	},

	// C3: request that will fail. The page references definitely-404.jpg which
	// the installer intercepts and returns an aborted response for.
	requestfailed: html(
		`<main><h1>Request failed</h1>
			<img src="/__recce_test/definitely-404.jpg" alt="will fail">
		</main>`,
		"Seeded requestfailed",
	),

	// C4: unresolved Handlebars in visible body text.
	"content-handlebars": html(
		`<main><h1>Hello</h1><p>Welcome {{user.name}}</p></main>`,
		"Seeded content-handlebars",
	),

	// C4: visible 'undefined' literal.
	"content-undefined": html(
		`<main><h1>Product</h1><p>Price: undefined</p></main>`,
		"Seeded content-undefined",
	),

	// C4: visible '[object Object]' literal.
	"content-object-object": html(
		`<main><h1>Data</h1><p>[object Object]</p></main>`,
		"Seeded content-object-object",
	),

	// C4: empty H1 (whitespace only).
	"content-empty-h1": html(
		`<main><h1> </h1><p>body content</p></main>`,
		"Seeded content-empty-h1",
	),

	// C7: target="_blank" without rel="noopener".
	"noopener-missing": html(
		`<main><h1>Link</h1><a target="_blank" href="https://external.example/">external</a></main>`,
		"Seeded noopener-missing",
	),

	// C8: mixed content image on https origin — the fixture returns the HTML
	// with a plain http:// img src. The test asserts the finding when the
	// page URL is https (tests can synthesise the origin via setContent rather
	// than relying on the fixture server).
	"mixed-content": html(
		`<main><h1>Mixed</h1><img src="http://insecure.example/pic.jpg" alt="insecure"></main>`,
		"Seeded mixed-content",
	),

	// ---- Phase 5b fixtures (C2 SEO meta) --------------------------------------
	//
	// These fixtures are raw HTML (not via html(...)) so we can control
	// <html lang>, <head>, <meta charset>, canonical, and og tags precisely.

	// C2: <title> tag completely absent.
	"seo-missing-title": {
		contentType: "text/html; charset=utf-8",
		body: `<!doctype html><html lang="en"><head>
			<meta charset="utf-8">
			<meta name="viewport" content="width=device-width, initial-scale=1">
			<meta name="description" content="A description that is long enough to pass the 50..160 char rule.">
			<link rel="canonical" href="http://localhost:9999/__recce_test/seo-missing-title">
			<meta property="og:title" content="t">
			<meta property="og:description" content="d">
			<meta property="og:image" content="http://localhost:9999/__recce_test/seo-og-image-large.png">
			<meta property="og:url" content="http://localhost:9999/__recce_test/seo-missing-title">
		</head><body><h1>Has Heading</h1><p>body</p></body></html>`,
	},

	// C2: English page with 100-char title — should emit seo-title-length warn.
	"seo-title-too-long": {
		contentType: "text/html; charset=utf-8",
		body: `<!doctype html><html lang="en"><head>
			<meta charset="utf-8">
			<meta name="viewport" content="width=device-width, initial-scale=1">
			<title>${"A".repeat(100)}</title>
			<meta name="description" content="A description that is long enough to pass the 50..160 char rule.">
			<link rel="canonical" href="http://localhost:9999/__recce_test/seo-title-too-long">
			<meta property="og:title" content="t">
			<meta property="og:description" content="d">
			<meta property="og:image" content="http://localhost:9999/__recce_test/seo-og-image-large.png">
			<meta property="og:url" content="http://localhost:9999/__recce_test/seo-title-too-long">
		</head><body><h1>Has Heading</h1><p>body</p></body></html>`,
	},

	// C2: Non-English (es) page, 90-char title — exceeds 80 default so WARN,
	// but not an error. Used to prove locale-aware bounds.
	"seo-title-non-english-long": {
		contentType: "text/html; charset=utf-8",
		body: `<!doctype html><html lang="es"><head>
			<meta charset="utf-8">
			<meta name="viewport" content="width=device-width, initial-scale=1">
			<title>${"Á".repeat(90)}</title>
			<meta name="description" content="Una descripción suficientemente larga para pasar la regla de 50 a 160 caracteres.">
			<link rel="canonical" href="http://localhost:9999/__recce_test/seo-title-non-english-long">
			<meta property="og:title" content="t">
			<meta property="og:description" content="d">
			<meta property="og:image" content="http://localhost:9999/__recce_test/seo-og-image-large.png">
			<meta property="og:url" content="http://localhost:9999/__recce_test/seo-title-non-english-long">
		</head><body><h1>Un Encabezado</h1><p>cuerpo</p></body></html>`,
	},

	// C2: no h1 element.
	"seo-missing-h1": {
		contentType: "text/html; charset=utf-8",
		body: `<!doctype html><html lang="en"><head>
			<meta charset="utf-8">
			<meta name="viewport" content="width=device-width, initial-scale=1">
			<title>A title that is within the English 30..65 char range.</title>
			<meta name="description" content="A description that is long enough to pass the 50..160 char rule.">
			<link rel="canonical" href="http://localhost:9999/__recce_test/seo-missing-h1">
			<meta property="og:title" content="t">
			<meta property="og:description" content="d">
			<meta property="og:image" content="http://localhost:9999/__recce_test/seo-og-image-large.png">
			<meta property="og:url" content="http://localhost:9999/__recce_test/seo-missing-h1">
		</head><body><p>No h1 anywhere on this page, just a paragraph.</p></body></html>`,
	},

	// C2: two h1 elements (warn).
	"seo-multiple-h1": {
		contentType: "text/html; charset=utf-8",
		body: `<!doctype html><html lang="en"><head>
			<meta charset="utf-8">
			<meta name="viewport" content="width=device-width, initial-scale=1">
			<title>A title that is within the English 30..65 char range.</title>
			<meta name="description" content="A description that is long enough to pass the 50..160 char rule.">
			<link rel="canonical" href="http://localhost:9999/__recce_test/seo-multiple-h1">
			<meta property="og:title" content="t">
			<meta property="og:description" content="d">
			<meta property="og:image" content="http://localhost:9999/__recce_test/seo-og-image-large.png">
			<meta property="og:url" content="http://localhost:9999/__recce_test/seo-multiple-h1">
		</head><body><h1>First</h1><h1>Second</h1></body></html>`,
	},

	// C2: no canonical link element.
	"seo-missing-canonical": {
		contentType: "text/html; charset=utf-8",
		body: `<!doctype html><html lang="en"><head>
			<meta charset="utf-8">
			<meta name="viewport" content="width=device-width, initial-scale=1">
			<title>A title that is within the English 30..65 char range.</title>
			<meta name="description" content="A description that is long enough to pass the 50..160 char rule.">
			<meta property="og:title" content="t">
			<meta property="og:description" content="d">
			<meta property="og:image" content="http://localhost:9999/__recce_test/seo-og-image-large.png">
			<meta property="og:url" content="http://localhost:9999/__recce_test/seo-missing-canonical">
		</head><body><h1>Heading</h1><p>body</p></body></html>`,
	},

	// C2: og:title / og:description / og:url present, og:image missing.
	"seo-missing-og-image": {
		contentType: "text/html; charset=utf-8",
		body: `<!doctype html><html lang="en"><head>
			<meta charset="utf-8">
			<meta name="viewport" content="width=device-width, initial-scale=1">
			<title>A title that is within the English 30..65 char range.</title>
			<meta name="description" content="A description that is long enough to pass the 50..160 char rule.">
			<link rel="canonical" href="http://localhost:9999/__recce_test/seo-missing-og-image">
			<meta property="og:title" content="t">
			<meta property="og:description" content="d">
			<meta property="og:url" content="http://localhost:9999/__recce_test/seo-missing-og-image">
		</head><body><h1>Heading</h1><p>body</p></body></html>`,
	},

	// C2: og:url differs from canonical (warn).
	"seo-og-url-mismatch": {
		contentType: "text/html; charset=utf-8",
		body: `<!doctype html><html lang="en"><head>
			<meta charset="utf-8">
			<meta name="viewport" content="width=device-width, initial-scale=1">
			<title>A title that is within the English 30..65 char range.</title>
			<meta name="description" content="A description that is long enough to pass the 50..160 char rule.">
			<link rel="canonical" href="http://localhost:9999/__recce_test/foo">
			<meta property="og:title" content="t">
			<meta property="og:description" content="d">
			<meta property="og:image" content="http://localhost:9999/__recce_test/seo-og-image-large.png">
			<meta property="og:url" content="http://localhost:9999/__recce_test/bar">
		</head><body><h1>Heading</h1><p>body</p></body></html>`,
	},

	// C2: og:image resolves but is 200x200 (< 1200x630).
	"seo-og-image-small": {
		contentType: "text/html; charset=utf-8",
		body: `<!doctype html><html lang="en"><head>
			<meta charset="utf-8">
			<meta name="viewport" content="width=device-width, initial-scale=1">
			<title>A title that is within the English 30..65 char range.</title>
			<meta name="description" content="A description that is long enough to pass the 50..160 char rule.">
			<link rel="canonical" href="http://localhost:9999/__recce_test/seo-og-image-small">
			<meta property="og:title" content="t">
			<meta property="og:description" content="d">
			<meta property="og:image" content="http://localhost:9999/__recce_test/seo-og-image-small.png">
			<meta property="og:url" content="http://localhost:9999/__recce_test/seo-og-image-small">
		</head><body><h1>Heading</h1><p>body</p></body></html>`,
	},

	// 200x200 PNG served to back the seo-og-image-small og:image ref.
	"seo-og-image-small.png": {
		status: 200,
		contentType: "image/png",
		body: SMALL_PNG_200,
	},

	// 1200x630 PNG used by the happy-path fixture (no findings expected).
	"seo-og-image-large.png": {
		status: 200,
		contentType: "image/png",
		body: OG_PNG_1200x630,
	},

	// C2: no <meta charset>.
	"seo-missing-charset": {
		contentType: "text/html; charset=utf-8",
		body: `<!doctype html><html lang="en"><head>
			<meta name="viewport" content="width=device-width, initial-scale=1">
			<title>A title that is within the English 30..65 char range.</title>
			<meta name="description" content="A description that is long enough to pass the 50..160 char rule.">
			<link rel="canonical" href="http://localhost:9999/__recce_test/seo-missing-charset">
			<meta property="og:title" content="t">
			<meta property="og:description" content="d">
			<meta property="og:image" content="http://localhost:9999/__recce_test/seo-og-image-large.png">
			<meta property="og:url" content="http://localhost:9999/__recce_test/seo-missing-charset">
		</head><body><h1>Heading</h1><p>body</p></body></html>`,
	},

	// C2: no <meta name="viewport">.
	"seo-missing-viewport": {
		contentType: "text/html; charset=utf-8",
		body: `<!doctype html><html lang="en"><head>
			<meta charset="utf-8">
			<title>A title that is within the English 30..65 char range.</title>
			<meta name="description" content="A description that is long enough to pass the 50..160 char rule.">
			<link rel="canonical" href="http://localhost:9999/__recce_test/seo-missing-viewport">
			<meta property="og:title" content="t">
			<meta property="og:description" content="d">
			<meta property="og:image" content="http://localhost:9999/__recce_test/seo-og-image-large.png">
			<meta property="og:url" content="http://localhost:9999/__recce_test/seo-missing-viewport">
		</head><body><h1>Heading</h1><p>body</p></body></html>`,
	},

	// C2: html lang="english" — not BCP-47.
	"seo-bad-html-lang": {
		contentType: "text/html; charset=utf-8",
		body: `<!doctype html><html lang="english"><head>
			<meta charset="utf-8">
			<meta name="viewport" content="width=device-width, initial-scale=1">
			<title>A title that is within the English 30..65 char range.</title>
			<meta name="description" content="A description that is long enough to pass the 50..160 char rule.">
			<link rel="canonical" href="http://localhost:9999/__recce_test/seo-bad-html-lang">
			<meta property="og:title" content="t">
			<meta property="og:description" content="d">
			<meta property="og:image" content="http://localhost:9999/__recce_test/seo-og-image-large.png">
			<meta property="og:url" content="http://localhost:9999/__recce_test/seo-bad-html-lang">
		</head><body><h1>Heading</h1><p>body</p></body></html>`,
	},

	// C2: JSON-LD block that fails to parse.
	"seo-jsonld-broken": {
		contentType: "text/html; charset=utf-8",
		body: `<!doctype html><html lang="en"><head>
			<meta charset="utf-8">
			<meta name="viewport" content="width=device-width, initial-scale=1">
			<title>A title that is within the English 30..65 char range.</title>
			<meta name="description" content="A description that is long enough to pass the 50..160 char rule.">
			<link rel="canonical" href="http://localhost:9999/__recce_test/seo-jsonld-broken">
			<meta property="og:title" content="t">
			<meta property="og:description" content="d">
			<meta property="og:image" content="http://localhost:9999/__recce_test/seo-og-image-large.png">
			<meta property="og:url" content="http://localhost:9999/__recce_test/seo-jsonld-broken">
			<script type="application/ld+json">{bad json here</script>
		</head><body><h1>Heading</h1><p>body</p></body></html>`,
	},

	// C2: happy-path — every required signal is valid. lang="es" with a
	// short (well under 80 chars) title so locale-aware bounds also pass.
	// Expected to produce ZERO findings.
	"seo-happy-path": {
		contentType: "text/html; charset=utf-8",
		body: `<!doctype html><html lang="es"><head>
			<meta charset="utf-8">
			<meta name="viewport" content="width=device-width, initial-scale=1">
			<title>Café en la Ciudad de México — guía corta</title>
			<meta name="description" content="Una guía breve y práctica sobre cafés en la Ciudad de México para turistas y locales.">
			<link rel="canonical" href="http://localhost:9999/__recce_test/seo-happy-path">
			<meta property="og:title" content="Café CDMX">
			<meta property="og:description" content="Una guía breve sobre cafés en la Ciudad de México.">
			<meta property="og:image" content="http://localhost:9999/__recce_test/seo-og-image-large.png">
			<meta property="og:url" content="http://localhost:9999/__recce_test/seo-happy-path">
			<link rel="alternate" hreflang="es" href="http://localhost:9999/__recce_test/seo-happy-path">
			<link rel="alternate" hreflang="en-US" href="http://localhost:9999/__recce_test/seo-happy-path-en">
			<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"Café CDMX"}</script>
		</head><body><h1>Un Encabezado Válido</h1><p>Cuerpo del artículo con contenido suficiente.</p></body></html>`,
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
			// C3 requestfailed fixture: abort the image request so Playwright
			// fires the `requestfailed` event rather than returning a status.
			if (key === "definitely-404.jpg") {
				await route.abort("failed");
				return;
			}
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
 * Install the seeded-bug routes on a BrowserContext instead of a single
 * Page. Required for checks that use `context.request` (APIRequestContext)
 * since page-level routes do not intercept requests issued via the
 * context-bound API client. Useful for Phase 5b SEO fixtures where
 * `checkSeo` HEADs and GETs og:image URLs via `ctx.request`.
 */
export async function installSeededBugsOnContext(
	context: BrowserContext,
): Promise<void> {
	await context.route("**/__recce_test/*", async (route) => {
		try {
			const url = new URL(route.request().url());
			const key = url.pathname.replace(FIXTURE_PREFIX, "");
			if (key === "definitely-404.jpg") {
				await route.abort("failed");
				return;
			}
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
			console.debug(`[seeded-bugs] context route handler failed:`, e);
			try {
				await route.abort("failed");
			} catch (abortErr) {
				console.debug(
					`[seeded-bugs] context route.abort also failed:`,
					abortErr,
				);
			}
		}
	});
}

/**
 * Start a real HTTP server on `port` that serves the same FIXTURES map as
 * the `page.route` interceptor. Required for checks that use Playwright's
 * APIRequestContext (`ctx.request`) — those requests do NOT go through
 * `page.route` / `context.route` handlers in Playwright 1.58, so any
 * og:image HEAD/GET needs an actual listening server.
 *
 * Returns a `close()` callback the caller must invoke during teardown.
 */
export async function startSeededBugServer(
	port: number,
): Promise<{ close: () => Promise<void>; port: number }> {
	const http = await import("node:http");
	const server = http.createServer((req, res) => {
		try {
			const pathStr = req.url || "/";
			const match = pathStr.match(/^\/__recce_test\/([^?]+)/);
			const key = match ? match[1] : "";
			const fixture = FIXTURES[key];
			if (!fixture) {
				res.statusCode = 404;
				res.setHeader("Content-Type", "text/plain");
				res.end(`no seeded fixture: ${key}`);
				return;
			}
			res.statusCode = fixture.status ?? 200;
			res.setHeader("Content-Type", fixture.contentType);
			if (req.method === "HEAD") {
				res.end();
				return;
			}
			res.end(fixture.body);
		} catch (e) {
			console.debug(`[seeded-bugs] HTTP handler failed:`, e);
			try {
				res.statusCode = 500;
				res.end("");
			} catch (endErr) {
				console.debug(`[seeded-bugs] response end also failed:`, endErr);
			}
		}
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => resolve());
	});
	return {
		port,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
			}),
	};
}

/**
 * Exposed for tests that need to construct an absolute fixture URL.
 */
export function fixtureUrl(base: string, key: string): string {
	const b = base.endsWith("/") ? base.slice(0, -1) : base;
	return `${b}${FIXTURE_PREFIX}${key}`;
}

export const SEEDED_FIXTURE_KEYS = Object.keys(FIXTURES);
