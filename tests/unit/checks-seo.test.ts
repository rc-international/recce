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

import { isValidBcp47 } from "../utils/checks/seo";

/**
 * Per-check unit tests for C2 (SEO meta).
 *
 * Mirrors the checks-seeded.test.ts spawn-a-child pattern so each scenario
 * gets an isolated findings sink keyed by its own RECCE_RUN_TS.
 *
 * Pure-function tests (isValidBcp47) run in-process.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const FIXTURE_BASE = "http://localhost:9999"; // intercepted by installSeededBugs

type FindingLike = {
	url: string;
	check: string;
	severity: "error" | "warn" | "info";
	message: string;
	expected?: string;
	actual?: string;
	element?: { tag: string; selector?: string; attr?: Record<string, string> };
	project: string;
};

let workDir: string;
let savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
	"RECCE_MODE",
	"RECCE_RUN_TS",
	"BASE_URL",
	"RECCE_TITLE_MIN_LEN",
	"RECCE_TITLE_MAX_LEN",
	"RECCE_TITLE_NON_EN_MAX",
	"RECCE_TITLE_NON_EN_MIN",
] as const;

function snapshotEnv(): void {
	savedEnv = {};
	for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
}
function restoreEnv(): void {
	for (const k of ENV_KEYS) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
}

beforeEach(() => {
	snapshotEnv();
	workDir = mkdtempSync(path.join(tmpdir(), "recce-seo-"));
});

afterEach(() => {
	restoreEnv();
	try {
		rmSync(workDir, { recursive: true, force: true });
	} catch (e) {
		console.debug(`[checks-seo] cleanup ${workDir} failed:`, e);
	}
	try {
		rmSync(path.join(REPO_ROOT, ".recce-test-scenarios"), {
			recursive: true,
			force: true,
		});
	} catch (e) {
		console.debug(`[checks-seo] cleanup scenarios dir failed:`, e);
	}
});

function runScenario(script: string, ts: string): FindingLike[] {
	const scenarioDir = path.join(REPO_ROOT, ".recce-test-scenarios");
	try {
		mkdirSync(scenarioDir, { recursive: true });
	} catch (e) {
		console.debug(`[checks-seo] mkdir ${scenarioDir} failed:`, e);
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
		BASE_URL: FIXTURE_BASE,
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
		console.debug(`[checks-seo] jsonl ${jsonlPath} missing:`, e);
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

function seoScenario(fixtureKey: string): string {
	// Each scenario starts a real HTTP server on port 9999 (Playwright 1.58
	// does NOT route APIRequestContext.fetch through page.route/context.route
	// handlers, so og:image HEAD/GET needs a real listener). The fixture URLs
	// hard-code localhost:9999 because the <meta property="og:image"> and
	// canonical values in seeded-bugs.ts are baked in.
	return `
const { chromium } = await import("@playwright/test");
const { startSeededBugServer, fixtureUrl } = await import(${JSON.stringify(path.join(REPO_ROOT, "tests/fixtures/seeded-bugs.ts"))});
const { checkSeo } = await import(${JSON.stringify(path.join(REPO_ROOT, "tests/utils/checks/seo.ts"))});

const server = await startSeededBugServer(9999);
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const target = fixtureUrl(${JSON.stringify(FIXTURE_BASE)}, ${JSON.stringify(fixtureKey)});
  await page.goto(target, { waitUntil: "domcontentloaded" });
  const checkedLinks = new Map();
  await checkSeo(page, { url: target, project: "chromium", requestContext: ctx.request, checkedLinks });
} finally {
  try { await browser.close(); } catch (e) { console.debug("browser close failed:", e); }
  try { await server.close(); } catch (e) { console.debug("server close failed:", e); }
}
`;
}

// -----------------------------------------------------------------------------
// Pure function: isValidBcp47
// -----------------------------------------------------------------------------

describe("isValidBcp47", () => {
	test("accepts valid BCP-47 subset", () => {
		expect(isValidBcp47("en")).toBe(true);
		expect(isValidBcp47("es")).toBe(true);
		expect(isValidBcp47("pt-BR")).toBe(true);
		expect(isValidBcp47("en-US")).toBe(true);
	});

	test("rejects non-BCP-47", () => {
		expect(isValidBcp47("english")).toBe(false);
		expect(isValidBcp47("EN")).toBe(false);
		expect(isValidBcp47("xx-xxx")).toBe(false);
		expect(isValidBcp47("")).toBe(false);
		// lowercase country is also rejected (strict spec)
		expect(isValidBcp47("en-us")).toBe(false);
	});

	test("rejects non-string inputs", () => {
		// @ts-expect-error — testing runtime robustness
		expect(isValidBcp47(null)).toBe(false);
		// @ts-expect-error
		expect(isValidBcp47(undefined)).toBe(false);
		// @ts-expect-error
		expect(isValidBcp47(42)).toBe(false);
	});
});

// -----------------------------------------------------------------------------
// Browser-backed seeded fixtures (via installSeededBugs)
// -----------------------------------------------------------------------------

describe("checkSeo — seeded fixtures", () => {
	test("seo-happy-path fixture produces zero findings (ES locale within bounds)", () => {
		const ts = "2026-04-24T11-00-00.000Z";
		const findings = runScenario(seoScenario("seo-happy-path"), ts);
		// Every finding should have check starting with 'seo-'. Anything at all
		// here is a false positive for the happy path.
		const seoFindings = findings.filter((f) => f.check.startsWith("seo-"));
		if (seoFindings.length > 0) {
			// Surface the actual findings in the test output for debugging.
			console.error(
				"Unexpected SEO findings on happy path:",
				JSON.stringify(seoFindings, null, 2),
			);
		}
		expect(seoFindings).toHaveLength(0);
	});

	test("seo-title-too-long (English, 100 chars) emits seo-title-length warn", () => {
		const ts = "2026-04-24T11-01-00.000Z";
		const findings = runScenario(seoScenario("seo-title-too-long"), ts);
		const hits = findings.filter((f) => f.check === "seo-title-length");
		expect(hits).toHaveLength(1);
		expect(hits[0].severity).toBe("warn");
		expect(hits[0].actual).toBe("100");
	});

	test("seo-title-non-english-long (es, 90 chars) warns but does not error", () => {
		const ts = "2026-04-24T11-02-00.000Z";
		const findings = runScenario(seoScenario("seo-title-non-english-long"), ts);
		// 90 > default non-EN max (80) -> warn, not error.
		const hits = findings.filter((f) => f.check === "seo-title-length");
		expect(hits).toHaveLength(1);
		expect(hits[0].severity).toBe("warn");
		// No error-severity title findings for non-English.
		const errs = findings.filter(
			(f) => f.check === "seo-title-length" && f.severity === "error",
		);
		expect(errs).toHaveLength(0);
	});

	test("seo-missing-og-image emits seo-og-missing error for og:image", () => {
		const ts = "2026-04-24T11-03-00.000Z";
		const findings = runScenario(seoScenario("seo-missing-og-image"), ts);
		const missing = findings.filter((f) => f.check === "seo-og-missing");
		expect(missing.some((f) => f.actual === "og:image")).toBe(true);
		expect(missing.every((f) => f.severity === "error")).toBe(true);
	});

	test("seo-og-url-mismatch emits seo-og-url-mismatch warn", () => {
		const ts = "2026-04-24T11-04-00.000Z";
		const findings = runScenario(seoScenario("seo-og-url-mismatch"), ts);
		const mismatches = findings.filter(
			(f) => f.check === "seo-og-url-mismatch",
		);
		expect(mismatches).toHaveLength(1);
		expect(mismatches[0].severity).toBe("warn");
	});

	test("seo-og-image-small emits seo-og-image-small warn (200x200 < 1200x630)", () => {
		const ts = "2026-04-24T11-05-00.000Z";
		const findings = runScenario(seoScenario("seo-og-image-small"), ts);
		const small = findings.filter((f) => f.check === "seo-og-image-small");
		expect(small).toHaveLength(1);
		expect(small[0].severity).toBe("warn");
		expect(small[0].actual).toBe("200x200");
	});

	test("seo-missing-charset emits seo-meta-charset-missing error", () => {
		const ts = "2026-04-24T11-06-00.000Z";
		const findings = runScenario(seoScenario("seo-missing-charset"), ts);
		const hits = findings.filter((f) => f.check === "seo-meta-charset-missing");
		expect(hits).toHaveLength(1);
		expect(hits[0].severity).toBe("error");
	});

	test('seo-bad-html-lang (lang="english") emits seo-html-lang-invalid warn', () => {
		const ts = "2026-04-24T11-07-00.000Z";
		const findings = runScenario(seoScenario("seo-bad-html-lang"), ts);
		const hits = findings.filter((f) => f.check === "seo-html-lang-invalid");
		expect(hits).toHaveLength(1);
		expect(hits[0].severity).toBe("warn");
		expect(hits[0].actual).toBe("english");
	});

	test("seo-jsonld-broken emits seo-jsonld-parse-error warn", () => {
		const ts = "2026-04-24T11-08-00.000Z";
		const findings = runScenario(seoScenario("seo-jsonld-broken"), ts);
		const hits = findings.filter((f) => f.check === "seo-jsonld-parse-error");
		expect(hits).toHaveLength(1);
		expect(hits[0].severity).toBe("warn");
	});
});
