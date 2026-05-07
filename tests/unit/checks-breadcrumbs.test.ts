import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Unit tests for `tests/utils/checks/breadcrumbs.ts`.
 *
 * Each scenario boots a Chromium page via `page.setContent` (no real
 * network) so the test exercises the production helper end-to-end while
 * staying fast. We drive the helper against synthetic HTML that mirrors
 * production:
 *
 *   - Country page (3-segment URL): one BreadcrumbList item, no link.
 *   - City page (4-segment URL): two items, first has absolute item URL.
 *   - Regression: missing BreadcrumbList → emits breadcrumb-missing.
 *   - Regression: city-page first item points at a different country.
 *   - Regression: visible <a> back to country is missing in DOM.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..");

type FindingLike = {
	url: string;
	check: string;
	severity: "error" | "warn" | "info";
	message: string;
	expected?: string;
	actual?: string;
	project: string;
};

let workDir: string;

beforeEach(() => {
	workDir = mkdtempSync(path.join(tmpdir(), "recce-breadcrumbs-"));
});

afterEach(() => {
	try {
		rmSync(workDir, { recursive: true, force: true });
	} catch (e) {
		console.debug(`[checks-breadcrumbs] cleanup ${workDir} failed:`, e);
	}
	try {
		rmSync(path.join(REPO_ROOT, ".recce-test-scenarios-bc"), {
			recursive: true,
			force: true,
		});
	} catch (e) {
		console.debug(`[checks-breadcrumbs] cleanup scenarios dir failed:`, e);
	}
});

function runScenario(script: string, ts: string): FindingLike[] {
	const scenarioDir = path.join(REPO_ROOT, ".recce-test-scenarios-bc");
	try {
		mkdirSync(scenarioDir, { recursive: true });
	} catch (e) {
		console.debug(`[checks-breadcrumbs] mkdir ${scenarioDir} failed:`, e);
	}
	const scriptPath = path.join(scenarioDir, `scenario-${ts}.mjs`);
	const wrapped = `
process.chdir(${JSON.stringify(workDir)});
${script}
`;
	writeFileSync(scriptPath, wrapped, { encoding: "utf8" });
	const env = {
		...process.env,
		RECCE_MODE: "pulse",
		RECCE_RUN_TS: ts,
		BASE_URL: "https://valors.io",
	};
	try {
		execSync(`bun run ${JSON.stringify(scriptPath)}`, {
			cwd: REPO_ROOT,
			env,
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 60_000,
		});
	} catch (e) {
		const err = e as { stderr?: Buffer; stdout?: Buffer; message?: string };
		const msg = [
			`child failed: ${err.message ?? "(no message)"}`,
			`--- stdout ---`,
			err.stdout?.toString() ?? "",
			`--- stderr ---`,
			err.stderr?.toString() ?? "",
		].join("\n");
		throw new Error(msg);
	}
	const jsonlPath = path.join(
		workDir,
		"test-results",
		"findings",
		`pulse-${ts}.jsonl`,
	);
	let raw = "";
	try {
		raw = readFileSync(jsonlPath, { encoding: "utf8" });
	} catch (e) {
		console.debug(`[checks-breadcrumbs] jsonl ${jsonlPath} missing:`, e);
		return [];
	}
	const out: FindingLike[] = [];
	for (const line of raw.split("\n")) {
		const l = line.trim();
		if (!l) continue;
		out.push(JSON.parse(l) as FindingLike);
	}
	return out;
}

function bcScript(opts: {
	url: string;
	html: string;
}): string {
	return `
const { chromium } = await import("@playwright/test");
const { checkBreadcrumbs } = await import(${JSON.stringify(path.join(REPO_ROOT, "tests/utils/checks/breadcrumbs.ts"))});

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.setContent(${JSON.stringify(opts.html)}, { waitUntil: "domcontentloaded" });
  await checkBreadcrumbs(page, { url: ${JSON.stringify(opts.url)}, project: "chromium" });
} finally {
  await browser.close();
}
`;
}

function bcHtml(itemListElement: object[], extraBody = ""): string {
	const ld = JSON.stringify({
		"@context": "https://schema.org",
		"@type": "BreadcrumbList",
		itemListElement,
	});
	return `<!doctype html><html><head><script type="application/ld+json">${ld}</script></head><body>${extraBody}</body></html>`;
}

describe("checkBreadcrumbs", () => {
	test("country page (depth 3) with one ListItem emits no findings", () => {
		const ts = "2026-05-07T10-00-00.000Z";
		const html = bcHtml([
			{ "@type": "ListItem", position: 1, name: "México" },
		]);
		const findings = runScenario(
			bcScript({ url: "https://valors.io/articles/es/mexico", html }),
			ts,
		);
		expect(findings).toEqual([]);
	});

	test("country page with extra ListItems flags breadcrumb-country-shape", () => {
		const ts = "2026-05-07T10-01-00.000Z";
		const html = bcHtml([
			{
				"@type": "ListItem",
				position: 1,
				name: "México",
				item: "https://valors.io/articles/es/mexico",
			},
			{ "@type": "ListItem", position: 2, name: "Extra" },
		]);
		const findings = runScenario(
			bcScript({ url: "https://valors.io/articles/es/mexico", html }),
			ts,
		);
		const shape = findings.filter(
			(f) => f.check === "breadcrumb-country-shape",
		);
		expect(shape).toHaveLength(1);
		expect(shape[0].severity).toBe("warn");
	});

	test("city page (depth 4) with country link + visible anchor passes cleanly", () => {
		const ts = "2026-05-07T10-02-00.000Z";
		const html = bcHtml(
			[
				{
					"@type": "ListItem",
					position: 1,
					name: "México",
					item: "https://valors.io/articles/es/Mexico",
				},
				{ "@type": "ListItem", position: 2, name: "Ciudad De Mexico" },
			],
			'<a class="hover:text-primary transition-colors" href="/articles/es/Mexico">México</a>',
		);
		const findings = runScenario(
			bcScript({
				url: "https://valors.io/articles/es/Mexico/ciudad-de-mexico",
				html,
			}),
			ts,
		);
		expect(findings).toEqual([]);
	});

	test("missing BreadcrumbList emits breadcrumb-missing", () => {
		const ts = "2026-05-07T10-03-00.000Z";
		const html = `<!doctype html><html><head></head><body>no breadcrumbs here</body></html>`;
		const findings = runScenario(
			bcScript({ url: "https://valors.io/articles/es/mexico", html }),
			ts,
		);
		const missing = findings.filter((f) => f.check === "breadcrumb-missing");
		expect(missing).toHaveLength(1);
		expect(missing[0].severity).toBe("error");
	});

	test("city page first crumb pointing at wrong country emits breadcrumb-country-link-wrong", () => {
		const ts = "2026-05-07T10-04-00.000Z";
		const html = bcHtml(
			[
				{
					"@type": "ListItem",
					position: 1,
					name: "Brasil",
					item: "https://valors.io/articles/es/Brazil",
				},
				{ "@type": "ListItem", position: 2, name: "Ciudad De Mexico" },
			],
			'<a href="/articles/es/Brazil">Brasil</a>',
		);
		const findings = runScenario(
			bcScript({
				url: "https://valors.io/articles/es/Mexico/ciudad-de-mexico",
				html,
			}),
			ts,
		);
		const wrong = findings.filter(
			(f) => f.check === "breadcrumb-country-link-wrong",
		);
		expect(wrong).toHaveLength(1);
		expect(wrong[0].severity).toBe("error");
	});

	test("city page without visible country anchor emits breadcrumb-country-anchor-missing", () => {
		const ts = "2026-05-07T10-05-00.000Z";
		const html = bcHtml([
			{
				"@type": "ListItem",
				position: 1,
				name: "México",
				item: "https://valors.io/articles/es/Mexico",
			},
			{ "@type": "ListItem", position: 2, name: "Ciudad De Mexico" },
		]); // no extraBody → no <a> back to country
		const findings = runScenario(
			bcScript({
				url: "https://valors.io/articles/es/Mexico/ciudad-de-mexico",
				html,
			}),
			ts,
		);
		const noAnchor = findings.filter(
			(f) => f.check === "breadcrumb-country-anchor-missing",
		);
		expect(noAnchor).toHaveLength(1);
		expect(noAnchor[0].severity).toBe("warn");
	});

	test("non-final ListItem with relative item URL emits breadcrumb-item-not-absolute", () => {
		const ts = "2026-05-07T10-06-00.000Z";
		const html = bcHtml(
			[
				{
					"@type": "ListItem",
					position: 1,
					name: "México",
					item: "/articles/es/Mexico",
				},
				{ "@type": "ListItem", position: 2, name: "Ciudad De Mexico" },
			],
			'<a href="/articles/es/Mexico">México</a>',
		);
		const findings = runScenario(
			bcScript({
				url: "https://valors.io/articles/es/Mexico/ciudad-de-mexico",
				html,
			}),
			ts,
		);
		const notAbs = findings.filter(
			(f) => f.check === "breadcrumb-item-not-absolute",
		);
		expect(notAbs).toHaveLength(1);
		expect(notAbs[0].severity).toBe("error");
	});

	test("first crumb pointing at a deeper city under the right country still flags breadcrumb-country-link-wrong", () => {
		// Regression guard: same lang + country segments but depth 4 (a city
		// URL) is NOT a valid country root and must be flagged. Without the
		// depth-3 check, this slipped through silently.
		const ts = "2026-05-07T10-08-00.000Z";
		const html = bcHtml(
			[
				{
					"@type": "ListItem",
					position: 1,
					name: "México",
					item: "https://valors.io/articles/es/Mexico/another-city",
				},
				{ "@type": "ListItem", position: 2, name: "Ciudad De Mexico" },
			],
			'<a href="/articles/es/Mexico">México</a>',
		);
		const findings = runScenario(
			bcScript({
				url: "https://valors.io/articles/es/Mexico/ciudad-de-mexico",
				html,
			}),
			ts,
		);
		const wrong = findings.filter(
			(f) => f.check === "breadcrumb-country-link-wrong",
		);
		expect(wrong).toHaveLength(1);
		expect(wrong[0].severity).toBe("error");
	});

	test("non-articles URL is skipped (no findings)", () => {
		const ts = "2026-05-07T10-07-00.000Z";
		const html = `<!doctype html><html><head></head><body>home</body></html>`;
		const findings = runScenario(
			bcScript({ url: "https://valors.io/", html }),
			ts,
		);
		expect(findings).toEqual([]);
	});
});
