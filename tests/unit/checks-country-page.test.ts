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
 * Unit tests for `tests/utils/checks/country-page.ts`.
 *
 * Builds synthetic country-page HTML and drives `checkCountryPage` via a
 * spawned Bun child (mirroring the pattern in checks-seeded). The HTML
 * mimics production's hreflang + canonical + city-link layout so the check
 * exercises the real DOM extraction path.
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
	workDir = mkdtempSync(path.join(tmpdir(), "recce-country-"));
});

afterEach(() => {
	try {
		rmSync(workDir, { recursive: true, force: true });
	} catch (e) {
		console.debug(`[checks-country] cleanup ${workDir} failed:`, e);
	}
	try {
		rmSync(path.join(REPO_ROOT, ".recce-test-scenarios-cp"), {
			recursive: true,
			force: true,
		});
	} catch (e) {
		console.debug(`[checks-country] cleanup scenarios dir failed:`, e);
	}
});

function runScenario(script: string, ts: string): FindingLike[] {
	const scenarioDir = path.join(REPO_ROOT, ".recce-test-scenarios-cp");
	try {
		mkdirSync(scenarioDir, { recursive: true });
	} catch (e) {
		console.debug(`[checks-country] mkdir ${scenarioDir} failed:`, e);
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
		console.debug(`[checks-country] jsonl ${jsonlPath} missing:`, e);
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

type CountryFixture = {
	url: string;
	h1?: string | string[];
	canonical?: string;
	hreflangs?: { hreflang: string; href: string }[];
	cities?: string[]; // anchor hrefs for /articles/<lang>/<country>/<city>
	extraAnchors?: string[];
};

function buildHtml(fx: CountryFixture): string {
	const h1Arr = Array.isArray(fx.h1) ? fx.h1 : fx.h1 == null ? [] : [fx.h1];
	const h1Html = h1Arr.map((t) => `<h1>${t}</h1>`).join("");
	const canonicalHtml = fx.canonical
		? `<link rel="canonical" href="${fx.canonical}">`
		: "";
	const hreflangsHtml = (fx.hreflangs ?? [])
		.map(
			(t) =>
				`<link rel="alternate" hreflang="${t.hreflang}" href="${t.href}">`,
		)
		.join("");
	const cityAnchors = (fx.cities ?? [])
		.map((c, i) => `<a href="${c}">city ${i}</a>`)
		.join("");
	const extras = (fx.extraAnchors ?? [])
		.map((h, i) => `<a href="${h}">extra ${i}</a>`)
		.join("");
	return `<!doctype html><html><head>${canonicalHtml}${hreflangsHtml}</head><body>${h1Html}${cityAnchors}${extras}</body></html>`;
}

function cpScript(fx: CountryFixture): string {
	const html = buildHtml(fx);
	return `
const { chromium } = await import("@playwright/test");
const { checkCountryPage } = await import(${JSON.stringify(path.join(REPO_ROOT, "tests/utils/checks/country-page.ts"))});

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.setContent(${JSON.stringify(html)}, { waitUntil: "domcontentloaded" });
  await checkCountryPage(page, { url: ${JSON.stringify(fx.url)}, project: "chromium" });
} finally {
  await browser.close();
}
`;
}

const HEALTHY_HREFLANGS = [
	{ hreflang: "en", href: "https://valors.io/articles/en/mexico" },
	{ hreflang: "es", href: "https://valors.io/articles/es/mexico" },
	{ hreflang: "pt-BR", href: "https://valors.io/articles/pt/mexico" },
	{ hreflang: "x-default", href: "https://valors.io/articles/es/mexico" },
];

function healthyCities(country: string, lang: string, n = 5): string[] {
	return Array.from(
		{ length: n },
		(_, i) => `/articles/${lang}/${country}/city-${i}`,
	);
}

describe("checkCountryPage", () => {
	test("healthy country page emits no findings", () => {
		const ts = "2026-05-07T12-00-00.000Z";
		const findings = runScenario(
			cpScript({
				url: "https://valors.io/articles/es/mexico",
				h1: "México",
				canonical: "https://valors.io/articles/es/mexico",
				hreflangs: HEALTHY_HREFLANGS,
				cities: healthyCities("Mexico", "es", 5),
			}),
			ts,
		);
		expect(findings).toEqual([]);
	});

	test("country page with too few cities emits country-too-few-cities", () => {
		const ts = "2026-05-07T12-01-00.000Z";
		const findings = runScenario(
			cpScript({
				url: "https://valors.io/articles/es/mexico",
				h1: "México",
				canonical: "https://valors.io/articles/es/mexico",
				hreflangs: HEALTHY_HREFLANGS,
				cities: ["/articles/es/Mexico/only-one"],
			}),
			ts,
		);
		const tooFew = findings.filter(
			(f) => f.check === "country-too-few-cities",
		);
		expect(tooFew).toHaveLength(1);
		expect(tooFew[0].severity).toBe("error");
		expect(tooFew[0].actual).toBe("1");
	});

	test("missing 'pt' hreflang locale emits country-hreflang-coverage", () => {
		const ts = "2026-05-07T12-02-00.000Z";
		const findings = runScenario(
			cpScript({
				url: "https://valors.io/articles/es/mexico",
				h1: "México",
				canonical: "https://valors.io/articles/es/mexico",
				hreflangs: [
					{ hreflang: "en", href: "https://valors.io/articles/en/mexico" },
					{ hreflang: "es", href: "https://valors.io/articles/es/mexico" },
					// pt missing
				],
				cities: healthyCities("Mexico", "es"),
			}),
			ts,
		);
		const cov = findings.filter(
			(f) => f.check === "country-hreflang-coverage",
		);
		expect(cov).toHaveLength(1);
		expect(cov[0].severity).toBe("warn");
		expect(cov[0].message).toContain("pt");
	});

	test("pt-BR satisfies the 'pt' locale requirement", () => {
		const ts = "2026-05-07T12-03-00.000Z";
		const findings = runScenario(
			cpScript({
				url: "https://valors.io/articles/es/mexico",
				h1: "México",
				canonical: "https://valors.io/articles/es/mexico",
				hreflangs: [
					{ hreflang: "en", href: "https://valors.io/articles/en/mexico" },
					{ hreflang: "es", href: "https://valors.io/articles/es/mexico" },
					{ hreflang: "pt-BR", href: "https://valors.io/articles/pt/mexico" },
				],
				cities: healthyCities("Mexico", "es"),
			}),
			ts,
		);
		const cov = findings.filter(
			(f) => f.check === "country-hreflang-coverage",
		);
		expect(cov).toHaveLength(0);
	});

	test("canonical pointing at different origin emits country-canonical-cross-origin", () => {
		const ts = "2026-05-07T12-04-00.000Z";
		const findings = runScenario(
			cpScript({
				url: "https://valors.io/articles/es/mexico",
				h1: "México",
				canonical: "https://other-domain.test/articles/es/mexico",
				hreflangs: HEALTHY_HREFLANGS,
				cities: healthyCities("Mexico", "es"),
			}),
			ts,
		);
		const cross = findings.filter(
			(f) => f.check === "country-canonical-cross-origin",
		);
		expect(cross).toHaveLength(1);
		expect(cross[0].severity).toBe("error");
	});

	test("canonical pathname mismatch emits country-canonical-mismatch", () => {
		const ts = "2026-05-07T12-05-00.000Z";
		const findings = runScenario(
			cpScript({
				url: "https://valors.io/articles/es/mexico",
				h1: "México",
				canonical: "https://valors.io/articles/en/mexico",
				hreflangs: HEALTHY_HREFLANGS,
				cities: healthyCities("Mexico", "es"),
			}),
			ts,
		);
		const mis = findings.filter(
			(f) => f.check === "country-canonical-mismatch",
		);
		expect(mis).toHaveLength(1);
		expect(mis[0].severity).toBe("warn");
	});

	test("canonical case-insensitive match passes (production uses /Mexico/)", () => {
		const ts = "2026-05-07T12-06-00.000Z";
		const findings = runScenario(
			cpScript({
				url: "https://valors.io/articles/es/mexico",
				h1: "México",
				canonical: "https://valors.io/articles/es/Mexico",
				hreflangs: HEALTHY_HREFLANGS,
				cities: healthyCities("Mexico", "es"),
			}),
			ts,
		);
		const mis = findings.filter(
			(f) => f.check === "country-canonical-mismatch",
		);
		expect(mis).toHaveLength(0);
	});

	test("missing h1 emits country-h1-missing", () => {
		const ts = "2026-05-07T12-07-00.000Z";
		const findings = runScenario(
			cpScript({
				url: "https://valors.io/articles/es/mexico",
				// no h1
				canonical: "https://valors.io/articles/es/mexico",
				hreflangs: HEALTHY_HREFLANGS,
				cities: healthyCities("Mexico", "es"),
			}),
			ts,
		);
		const h1Missing = findings.filter(
			(f) => f.check === "country-h1-missing",
		);
		expect(h1Missing).toHaveLength(1);
		expect(h1Missing[0].severity).toBe("error");
	});

	test("multiple h1s emit country-h1-multiple", () => {
		const ts = "2026-05-07T12-08-00.000Z";
		const findings = runScenario(
			cpScript({
				url: "https://valors.io/articles/es/mexico",
				h1: ["México", "Otra"],
				canonical: "https://valors.io/articles/es/mexico",
				hreflangs: HEALTHY_HREFLANGS,
				cities: healthyCities("Mexico", "es"),
			}),
			ts,
		);
		const multi = findings.filter((f) => f.check === "country-h1-multiple");
		expect(multi).toHaveLength(1);
		expect(multi[0].severity).toBe("warn");
		expect(multi[0].actual).toBe("2");
	});

	test("non-country URL is skipped (no findings)", () => {
		const ts = "2026-05-07T12-09-00.000Z";
		const findings = runScenario(
			cpScript({
				url: "https://valors.io/articles/es/Mexico/ciudad-de-mexico",
				h1: "Ciudad de México",
				cities: [],
			}),
			ts,
		);
		expect(findings).toEqual([]);
	});

	test("cross-origin anchors do not count toward city-density threshold", () => {
		// Regression guard: `new URL(absolute, base)` ignores the base when
		// `absolute` is already absolute, so a foreign-origin anchor whose
		// pathname matches /articles/<lang>/<country>/<city> would otherwise
		// inflate cityHrefs.size and suppress a legitimate finding.
		const ts = "2026-05-07T12-11-00.000Z";
		const findings = runScenario(
			cpScript({
				url: "https://valors.io/articles/es/mexico",
				h1: "México",
				canonical: "https://valors.io/articles/es/mexico",
				hreflangs: HEALTHY_HREFLANGS,
				cities: ["/articles/es/Mexico/only-one"],
				extraAnchors: [
					"https://partner-site.test/articles/es/Mexico/foreign-city-1",
					"https://partner-site.test/articles/es/Mexico/foreign-city-2",
					"https://partner-site.test/articles/es/Mexico/foreign-city-3",
				],
			}),
			ts,
		);
		const tooFew = findings.filter(
			(f) => f.check === "country-too-few-cities",
		);
		expect(tooFew).toHaveLength(1);
		// Only the one same-origin city counts.
		expect(tooFew[0].actual).toBe("1");
	});

	test("city links matched case-insensitively on country segment", () => {
		// Production country page uses lowercase URL (/articles/es/mexico)
		// but the city links use capitalized country segment (/Mexico/...).
		// The check must dedup + count those correctly.
		const ts = "2026-05-07T12-10-00.000Z";
		const findings = runScenario(
			cpScript({
				url: "https://valors.io/articles/es/mexico",
				h1: "México",
				canonical: "https://valors.io/articles/es/mexico",
				hreflangs: HEALTHY_HREFLANGS,
				cities: [
					"/articles/es/Mexico/ciudad-de-mexico",
					"/articles/es/Mexico/guadalajara",
					"/articles/es/Mexico/oaxaca",
					"/articles/es/Mexico/merida",
				],
			}),
			ts,
		);
		const tooFew = findings.filter(
			(f) => f.check === "country-too-few-cities",
		);
		expect(tooFew).toHaveLength(0);
	});
});
