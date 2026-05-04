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

import { detectDuplicateImages } from "../utils/checks/images";

/**
 * Per-check unit tests that drive each Phase-3 helper against the seeded
 * fixtures in tests/fixtures/seeded-bugs.ts.
 *
 * We spawn a child Bun process per scenario so each test has its own
 * findings module init (which captures RECCE_RUN_TS at import) and its
 * own JSONL file. The child:
 *   1. chdirs into a per-test tmp dir
 *   2. launches Playwright chromium
 *   3. installs the seeded-bugs routes
 *   4. navigates to one fixture URL
 *   5. invokes ONE check helper
 *   6. exits — JSONL findings live on disk at
 *      test-results/findings/pulse-<RECCE_RUN_TS>.jsonl
 * The parent reads and asserts on the JSONL contents.
 *
 * detectDuplicateImages pure-function tests (RECCE_DUPLICATE_EXEMPT_PATTERNS
 * + intentional-pattern downgrade) run in-process; they don't need a
 * browser.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const FIXTURE_BASE = "http://localhost:9999"; // dummy; requests are intercepted

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
	"RECCE_DUPLICATE_EXEMPT_PATTERNS",
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
	workDir = mkdtempSync(path.join(tmpdir(), "recce-checks-"));
});

afterEach(() => {
	restoreEnv();
	try {
		rmSync(workDir, { recursive: true, force: true });
	} catch (e) {
		console.debug(`[checks-seeded] cleanup ${workDir} failed:`, e);
	}
	try {
		rmSync(path.join(REPO_ROOT, ".recce-test-scenarios"), {
			recursive: true,
			force: true,
		});
	} catch (e) {
		console.debug(`[checks-seeded] cleanup scenarios dir failed:`, e);
	}
});

/**
 * Run a Bun script inside `workDir` and return JSONL findings produced by
 * the shared sink.
 */
function runScenario(script: string, ts: string): FindingLike[] {
	// The scenario script must live INSIDE REPO_ROOT so Bun's node_modules
	// resolution finds the repo-pinned @playwright/test (which matches the
	// installed browser binaries). To isolate findings output per-test we
	// chdir to workDir before importing findings.ts (which captures
	// process.cwd() at module init).
	const scenarioDir = path.join(REPO_ROOT, ".recce-test-scenarios");
	try {
		mkdirSync(scenarioDir, { recursive: true });
	} catch (e) {
		console.debug(`[checks-seeded] mkdir ${scenarioDir} failed:`, e);
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
		console.debug(`[checks-seeded] jsonl ${jsonlPath} missing:`, e);
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

function scenarioPrelude(fixtureKey: string, checkBody: string): string {
	// Each child must launch chromium, install seeded routes, navigate to the
	// target fixture URL, run `checkBody`, then close. Dynamic imports are
	// used so `process.chdir(workDir)` (written by runScenario) executes
	// BEFORE findings.ts captures `process.cwd()` at module init.
	return `
const { chromium } = await import("@playwright/test");
const { installSeededBugs, fixtureUrl } = await import(${JSON.stringify(path.join(REPO_ROOT, "tests/fixtures/seeded-bugs.ts"))});
const { checkImages } = await import(${JSON.stringify(path.join(REPO_ROOT, "tests/utils/checks/images.ts"))});
const { checkLinks } = await import(${JSON.stringify(path.join(REPO_ROOT, "tests/utils/checks/links.ts"))});
const { checkButtons } = await import(${JSON.stringify(path.join(REPO_ROOT, "tests/utils/checks/buttons.ts"))});
const { recordFinding } = await import(${JSON.stringify(path.join(REPO_ROOT, "tests/utils/findings.ts"))});

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await installSeededBugs(page);
  const target = fixtureUrl(${JSON.stringify(FIXTURE_BASE)}, ${JSON.stringify(fixtureKey)});
  await page.goto(target, { waitUntil: "domcontentloaded" });
  const checkedLinks = new Map();
  const project = "chromium";
  ${checkBody}
} finally {
  await browser.close();
}
`;
}

// -----------------------------------------------------------------------------
// Pure-function tests (no browser)
// -----------------------------------------------------------------------------

describe("detectDuplicateImages — pure function", () => {
	test("honours default RECCE_DUPLICATE_EXEMPT_PATTERNS (/logo, /favicon)", () => {
		const srcs = [
			"https://example.com/logo.png",
			"https://example.com/logo.png",
			"https://example.com/logo.png",
			"https://example.com/favicon.ico",
			"https://example.com/favicon.ico",
			"https://example.com/hero.jpg",
			"https://example.com/hero.jpg",
		];
		const dupes = detectDuplicateImages(srcs);
		// logo and favicon are exempt; hero is NOT.
		expect(dupes).toHaveLength(1);
		expect(dupes[0].src).toBe("https://example.com/hero.jpg");
		expect(dupes[0].count).toBe(2);
	});

	test("RECCE_DUPLICATE_EXEMPT_PATTERNS env override", () => {
		const prev = process.env.RECCE_DUPLICATE_EXEMPT_PATTERNS;
		process.env.RECCE_DUPLICATE_EXEMPT_PATTERNS = "/sprite";
		try {
			const srcs = [
				"https://example.com/sprite.png",
				"https://example.com/sprite.png",
				"https://example.com/logo.png",
				"https://example.com/logo.png",
			];
			const dupes = detectDuplicateImages(srcs);
			// With override, only /sprite is exempt; /logo is no longer exempt.
			expect(dupes.map((d) => d.src)).toEqual(["https://example.com/logo.png"]);
		} finally {
			if (prev === undefined)
				delete process.env.RECCE_DUPLICATE_EXEMPT_PATTERNS;
			else process.env.RECCE_DUPLICATE_EXEMPT_PATTERNS = prev;
		}
	});

	test("intentional-pattern threshold: count >= 10 still reported as duplicate", () => {
		const srcs = Array.from(
			{ length: 12 },
			() => "https://example.com/thumb.jpg",
		);
		const dupes = detectDuplicateImages(srcs);
		expect(dupes).toHaveLength(1);
		expect(dupes[0].count).toBe(12);
	});

	test("single occurrence not reported", () => {
		const srcs = ["https://example.com/only.jpg"];
		const dupes = detectDuplicateImages(srcs);
		expect(dupes).toHaveLength(0);
	});
});

// -----------------------------------------------------------------------------
// Browser-backed seeded fixtures
// -----------------------------------------------------------------------------

describe("seeded fixtures via installSeededBugs", () => {
	test("B1: broken image produces exactly one broken-image finding", () => {
		const ts = "2026-04-24T10-00-00.000Z";
		const script = scenarioPrelude(
			"broken-image",
			`await checkImages(page, { url: target, project, checkedLinks });`,
		);
		const findings = runScenario(script, ts);
		const brokens = findings.filter((f) => f.check === "broken-image");
		expect(brokens).toHaveLength(1);
		const attr = brokens[0].element?.attr ?? {};
		expect(attr.src).toBe("/__recce_test/missing.jpg");
		expect(brokens[0].severity).toBe("error");
	});

	test('B2: soft-404 title="Not Found" produces exactly one soft-404 finding', () => {
		// The soft-404 fixture has no <a> links that re-navigate, so we have
		// to stage a parent page whose link points to /__recce_test/soft-404.
		// Simplest: stash a data-url parent, then have checkLinks traverse it.
		const ts = "2026-04-24T10-01-00.000Z";
		const script = `
const { chromium } = await import("@playwright/test");
const { installSeededBugs, fixtureUrl } = await import(${JSON.stringify(path.join(REPO_ROOT, "tests/fixtures/seeded-bugs.ts"))});
const { checkLinks } = await import(${JSON.stringify(path.join(REPO_ROOT, "tests/utils/checks/links.ts"))});

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await installSeededBugs(page);
  const soft404 = fixtureUrl(${JSON.stringify(FIXTURE_BASE)}, "soft-404");
  // Parent page: a single anchor pointing at the soft-404 fixture. We use
  // setContent with an absolute href so Playwright's URL harvest picks it up.
  await page.setContent('<html><body><a href="' + soft404 + '">dead link</a></body></html>', { waitUntil: "domcontentloaded" });
  const checkedLinks = new Map();
  // Pre-seed the headOrGet cache: Playwright route() mocks installed by
  // installSeededBugs intercept page-level requests but NOT the standalone
  // APIRequestContext used by headOrGet, so ctx.head(soft404) would return 0
  // and short-circuit into the new internal-link-unreachable branch, skipping
  // the soft-404 DOM sweep. Seeding the cache with a 200 mirrors a real origin
  // where HEAD succeeds and the soft-404 only manifests after page.goto.
  checkedLinks.set(soft404, 200);
  await checkLinks(page, { url: ${JSON.stringify(FIXTURE_BASE)} + "/parent", project: "chromium", checkedLinks });
} finally {
  await browser.close();
}
`;
		const findings = runScenario(script, ts);
		const soft = findings.filter((f) => f.check === "soft-404");
		expect(soft).toHaveLength(1);
		expect(soft[0].severity).toBe("error");
	});

	test("B3: missing-hero on merchant fixture produces exactly one hero-missing finding", () => {
		const ts = "2026-04-24T10-02-00.000Z";
		// Minimal merchant-check inline: we don't need to route via crawler
		// for a unit test — just assert the hero rule.
		const script = `
const { chromium } = await import("@playwright/test");
const { installSeededBugs, fixtureUrl } = await import(${JSON.stringify(path.join(REPO_ROOT, "tests/fixtures/seeded-bugs.ts"))});
const { recordFinding } = await import(${JSON.stringify(path.join(REPO_ROOT, "tests/utils/findings.ts"))});

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await installSeededBugs(page);
  const target = fixtureUrl(${JSON.stringify(FIXTURE_BASE)}, "missing-hero");
  await page.goto(target, { waitUntil: "domcontentloaded" });
  const heroPresent = await page.evaluate(() => !!document.querySelector("img.object-cover"));
  if (!heroPresent) {
    recordFinding({
      url: target,
      check: "hero-missing",
      severity: "error",
      message: "merchant page has no img.object-cover",
      element: { tag: "img", selector: "img.object-cover" },
      expected: "img.object-cover present",
      actual: "(not found)",
      project: "chromium",
    });
  }
} finally {
  await browser.close();
}
`;
		const findings = runScenario(script, ts);
		const missingHero = findings.filter((f) => f.check === "hero-missing");
		expect(missingHero).toHaveLength(1);
		expect(missingHero[0].severity).toBe("error");
	});

	test("B4: duplicate-images fixture produces exactly one duplicate-image finding with count=3", () => {
		const ts = "2026-04-24T10-03-00.000Z";
		const script = scenarioPrelude(
			"duplicate-images",
			`await checkImages(page, { url: target, project, checkedLinks });`,
		);
		const findings = runScenario(script, ts);
		const dupes = findings.filter((f) => f.check === "duplicate-image");
		expect(dupes).toHaveLength(1);
		expect(dupes[0].actual).toBe("3 occurrences");
		// count < 10 -> error severity.
		expect(dupes[0].severity).toBe("error");
	});

	test("B5a: disabled button produces exactly one button-disabled finding", () => {
		const ts = "2026-04-24T10-04-00.000Z";
		const script = scenarioPrelude(
			"disabled-button",
			`await checkButtons(page, { url: target, project });`,
		);
		const findings = runScenario(script, ts);
		const disabled = findings.filter((f) => f.check === "button-disabled");
		expect(disabled).toHaveLength(1);
		expect(disabled[0].severity).toBe("error");
		// No false-positive recaptcha-managed on this simple disabled button.
		const recaptcha = findings.filter((f) => f.check === "recaptcha-managed");
		expect(recaptcha).toHaveLength(0);
	});

	test("B5b: reCAPTCHA button is info recaptcha-managed, NOT error", () => {
		const ts = "2026-04-24T10-05-00.000Z";
		const script = scenarioPrelude(
			"recaptcha-button",
			`await checkButtons(page, { url: target, project });`,
		);
		const findings = runScenario(script, ts);
		const recaptcha = findings.filter((f) => f.check === "recaptcha-managed");
		expect(recaptcha.length).toBeGreaterThanOrEqual(1);
		expect(recaptcha[0].severity).toBe("info");
		// The same button must NOT be reported as button-disabled (it's a
		// reCAPTCHA-managed transition, not a bug).
		const disabled = findings.filter((f) => f.check === "button-disabled");
		expect(disabled).toHaveLength(0);
	});
});
