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

import { CONTENT_QUALITY_REGEXES } from "../utils/checks/content";

/**
 * Phase-5a unit tests: runtime errors, content quality, and security checks.
 *
 * Pure-function tests (regex battery) run in-process. Browser-backed scenarios
 * spawn a child Bun process per-test so each gets its own findings module
 * init (which captures RECCE_RUN_TS at import) and its own JSONL file.
 * Mirrors the pattern in checks-seeded.test.ts.
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
const ENV_KEYS = ["RECCE_MODE", "RECCE_RUN_TS", "BASE_URL"] as const;

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
	workDir = mkdtempSync(path.join(tmpdir(), "recce-runtime-"));
});

afterEach(() => {
	restoreEnv();
	try {
		rmSync(workDir, { recursive: true, force: true });
	} catch (e) {
		console.debug(`[checks-runtime] cleanup ${workDir} failed:`, e);
	}
	try {
		rmSync(path.join(REPO_ROOT, ".recce-test-scenarios-runtime"), {
			recursive: true,
			force: true,
		});
	} catch (e) {
		console.debug(`[checks-runtime] cleanup scenarios dir failed:`, e);
	}
});

function runScenario(script: string, ts: string): FindingLike[] {
	const scenarioDir = path.join(REPO_ROOT, ".recce-test-scenarios-runtime");
	try {
		mkdirSync(scenarioDir, { recursive: true });
	} catch (e) {
		console.debug(`[checks-runtime] mkdir ${scenarioDir} failed:`, e);
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
		console.debug(`[checks-runtime] jsonl ${jsonlPath} missing:`, e);
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

// -----------------------------------------------------------------------------
// Pure-function: CONTENT_QUALITY_REGEXES battery
// -----------------------------------------------------------------------------

describe("CONTENT_QUALITY_REGEXES", () => {
	test("lorem matches 'Lorem ipsum' case-insensitively", () => {
		const re = CONTENT_QUALITY_REGEXES.lorem;
		expect(re.test("Lorem ipsum dolor sit amet")).toBe(true);
		expect(re.test("lorem ipsum dolor")).toBe(true);
		expect(re.test("LOREM IPSUM")).toBe(true);
	});

	test("lorem does NOT match 'loremipsum' (no word boundary)", () => {
		const re = CONTENT_QUALITY_REGEXES.lorem;
		// No space between the words -> no match.
		expect(re.test("loremipsum")).toBe(false);
		// With a whitespace separator the full 'Lorem ipsum' phrase matches.
		expect(re.test("Say Lorem ipsum please")).toBe(true);
	});

	test("handlebars matches unresolved {{foo}} but not single-brace", () => {
		const re = CONTENT_QUALITY_REGEXES.handlebars;
		expect(re.test("Hello {{user.name}}!")).toBe(true);
		expect(re.test("{{title}}")).toBe(true);
		expect(re.test("{user}")).toBe(false);
		expect(re.test("{ foo }")).toBe(false);
	});

	// biome-ignore lint/suspicious/noTemplateCurlyInString: test name describes regex behaviour.
	test("templateLiteral matches ${foo} but not plain $foo", () => {
		const re = CONTENT_QUALITY_REGEXES.templateLiteral;
		// biome-ignore lint/suspicious/noTemplateCurlyInString: testing regex that catches unresolved template literals in body text.
		expect(re.test("Price: ${item.price}")).toBe(true);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal for regex test.
		expect(re.test("Total: ${total}")).toBe(true);
		expect(re.test("$5.00")).toBe(false);
		expect(re.test("just $foo no braces")).toBe(false);
	});

	test("undefinedLiteral matches bare 'undefined' but not 'undefinedVar'", () => {
		const re = CONTENT_QUALITY_REGEXES.undefinedLiteral;
		expect(re.test("Price: undefined")).toBe(true);
		expect(re.test("undefined")).toBe(true);
		expect(re.test("undefinedVar")).toBe(false);
		expect(re.test("isUndefined")).toBe(false);
	});

	test("nanLiteral matches bare NaN but not 'NaNoseconds'", () => {
		const re = CONTENT_QUALITY_REGEXES.nanLiteral;
		expect(re.test("Total: NaN")).toBe(true);
		expect(re.test("NaNoseconds")).toBe(false);
	});

	test("nullLiteral matches bare null but not 'nullable'", () => {
		const re = CONTENT_QUALITY_REGEXES.nullLiteral;
		expect(re.test("Value: null")).toBe(true);
		expect(re.test("nullable")).toBe(false);
		expect(re.test("isNull")).toBe(false);
	});

	test("objectObject matches literal '[object Object]'", () => {
		const re = CONTENT_QUALITY_REGEXES.objectObject;
		expect(re.test("[object Object]")).toBe(true);
		expect(re.test("Value: [object Object] here")).toBe(true);
		expect(re.test("object Object")).toBe(false);
	});
});

// -----------------------------------------------------------------------------
// Browser-backed: content checker strips code/pre/script/style subtrees
// -----------------------------------------------------------------------------

describe("checkContentQuality — subtree stripping", () => {
	test("does NOT flag 'undefined' inside <code> or <pre>", () => {
		const ts = "2026-04-24T11-00-00.000Z";
		const script = `
const { chromium } = await import("@playwright/test");
const { checkContentQuality } = await import(${JSON.stringify(path.join(REPO_ROOT, "tests/utils/checks/content.ts"))});

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.setContent('<html><body><p>Hello world</p><code>const x = undefined;</code><pre>NaN problem</pre><script>const lorem="Lorem ipsum"</script><style>/* null */</style></body></html>', { waitUntil: "domcontentloaded" });
  await checkContentQuality(page, { url: ${JSON.stringify(FIXTURE_BASE)} + "/stripped", project: "chromium" });
} finally {
  await browser.close();
}
`;
		const findings = runScenario(script, ts);
		// No content findings should be emitted because all triggers are inside
		// code/pre/script/style.
		const contentFindings = findings.filter((f) =>
			f.check.startsWith("content-"),
		);
		expect(contentFindings).toHaveLength(0);
	});

	test("flags 'undefined' outside code/pre", () => {
		const ts = "2026-04-24T11-00-01.000Z";
		const script = `
const { chromium } = await import("@playwright/test");
const { checkContentQuality } = await import(${JSON.stringify(path.join(REPO_ROOT, "tests/utils/checks/content.ts"))});

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.setContent('<html><body><p>Price: undefined</p></body></html>', { waitUntil: "domcontentloaded" });
  await checkContentQuality(page, { url: ${JSON.stringify(FIXTURE_BASE)} + "/undef", project: "chromium" });
} finally {
  await browser.close();
}
`;
		const findings = runScenario(script, ts);
		const undef = findings.filter(
			(f) => f.check === "content-undefined-literal",
		);
		expect(undef.length).toBeGreaterThanOrEqual(1);
		expect(undef[0].severity).toBe("warn");
	});

	test("flags {{handlebars}} in body text as error", () => {
		const ts = "2026-04-24T11-00-02.000Z";
		const script = `
const { chromium } = await import("@playwright/test");
const { checkContentQuality } = await import(${JSON.stringify(path.join(REPO_ROOT, "tests/utils/checks/content.ts"))});

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.setContent('<html><body><p>Welcome {{user.name}}</p></body></html>', { waitUntil: "domcontentloaded" });
  await checkContentQuality(page, { url: ${JSON.stringify(FIXTURE_BASE)} + "/hb", project: "chromium" });
} finally {
  await browser.close();
}
`;
		const findings = runScenario(script, ts);
		const hb = findings.filter((f) => f.check === "content-handlebars");
		expect(hb.length).toBeGreaterThanOrEqual(1);
		expect(hb[0].severity).toBe("error");
	});

	test("flags empty <h1> as warn", () => {
		const ts = "2026-04-24T11-00-03.000Z";
		const script = `
const { chromium } = await import("@playwright/test");
const { checkContentQuality } = await import(${JSON.stringify(path.join(REPO_ROOT, "tests/utils/checks/content.ts"))});

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.setContent('<html><body><h1>   </h1><p>body</p></body></html>', { waitUntil: "domcontentloaded" });
  await checkContentQuality(page, { url: ${JSON.stringify(FIXTURE_BASE)} + "/emptyh1", project: "chromium" });
} finally {
  await browser.close();
}
`;
		const findings = runScenario(script, ts);
		const emptyH = findings.filter((f) => f.check === "content-empty-heading");
		expect(emptyH.length).toBeGreaterThanOrEqual(1);
		expect(emptyH[0].severity).toBe("warn");
	});
});

// -----------------------------------------------------------------------------
// Browser-backed: runtime error hook
// -----------------------------------------------------------------------------

describe("createRuntimeErrorHook", () => {
	test("catches seeded pageerror and records finding", () => {
		const ts = "2026-04-24T11-10-00.000Z";
		const script = `
const { chromium } = await import("@playwright/test");
const { createRuntimeErrorHook } = await import(${JSON.stringify(path.join(REPO_ROOT, "tests/utils/checks/runtime-errors.ts"))});

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const url = ${JSON.stringify(FIXTURE_BASE)} + "/pageerror";
  const hook = createRuntimeErrorHook(() => url, "chromium");
  // Hook must attach listeners BEFORE navigation.
  await hook(page);
  await page.setContent('<html><body><script>throw new Error("seeded pageerror")</script></body></html>', { waitUntil: "domcontentloaded" });
  // Give pageerror event a tick to fire.
  await page.waitForTimeout(100);
} finally {
  await browser.close();
}
`;
		const findings = runScenario(script, ts);
		const pageerrors = findings.filter((f) => f.check === "pageerror");
		expect(pageerrors.length).toBeGreaterThanOrEqual(1);
		expect(pageerrors[0].severity).toBe("error");
		expect(pageerrors[0].message.toLowerCase()).toContain("seeded pageerror");
	});

	test("catches console.error as console-error finding", () => {
		const ts = "2026-04-24T11-10-01.000Z";
		const script = `
const { chromium } = await import("@playwright/test");
const { createRuntimeErrorHook } = await import(${JSON.stringify(path.join(REPO_ROOT, "tests/utils/checks/runtime-errors.ts"))});

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const url = ${JSON.stringify(FIXTURE_BASE)} + "/console-error";
  const hook = createRuntimeErrorHook(() => url, "chromium");
  await hook(page);
  await page.setContent('<html><body><script>console.error("seeded console error")</script></body></html>', { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(100);
} finally {
  await browser.close();
}
`;
		const findings = runScenario(script, ts);
		const ce = findings.filter((f) => f.check === "console-error");
		expect(ce.length).toBeGreaterThanOrEqual(1);
		expect(ce[0].severity).toBe("error");
	});
});

// -----------------------------------------------------------------------------
// Browser-backed: security checks
// -----------------------------------------------------------------------------

describe("checkSecurity — noopener", () => {
	test("flags target=_blank missing noopener as error", () => {
		const ts = "2026-04-24T11-20-00.000Z";
		const script = `
const { chromium } = await import("@playwright/test");
const { checkSecurity } = await import(${JSON.stringify(path.join(REPO_ROOT, "tests/utils/checks/security.ts"))});

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.setContent('<html><body><a target="_blank" href="https://external.example/">ext</a></body></html>', { waitUntil: "domcontentloaded" });
  await checkSecurity(page, { url: "https://example.com/noop", project: "chromium" });
} finally {
  await browser.close();
}
`;
		const findings = runScenario(script, ts);
		const noop = findings.filter(
			(f) => f.check === "target-blank-noopener-missing",
		);
		expect(noop).toHaveLength(1);
		expect(noop[0].severity).toBe("error");
	});

	test("warns when noopener present but noreferrer missing", () => {
		const ts = "2026-04-24T11-20-01.000Z";
		const script = `
const { chromium } = await import("@playwright/test");
const { checkSecurity } = await import(${JSON.stringify(path.join(REPO_ROOT, "tests/utils/checks/security.ts"))});

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.setContent('<html><body><a target="_blank" rel="noopener" href="https://external.example/">ext</a></body></html>', { waitUntil: "domcontentloaded" });
  await checkSecurity(page, { url: "https://example.com/noref", project: "chromium" });
} finally {
  await browser.close();
}
`;
		const findings = runScenario(script, ts);
		const noref = findings.filter(
			(f) => f.check === "target-blank-noreferrer-recommended",
		);
		expect(noref).toHaveLength(1);
		expect(noref[0].severity).toBe("warn");
		const missing = findings.filter(
			(f) => f.check === "target-blank-noopener-missing",
		);
		expect(missing).toHaveLength(0);
	});

	test("no finding when both noopener and noreferrer present", () => {
		const ts = "2026-04-24T11-20-02.000Z";
		const script = `
const { chromium } = await import("@playwright/test");
const { checkSecurity } = await import(${JSON.stringify(path.join(REPO_ROOT, "tests/utils/checks/security.ts"))});

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.setContent('<html><body><a target="_blank" rel="noopener noreferrer" href="https://external.example/">ext</a></body></html>', { waitUntil: "domcontentloaded" });
  await checkSecurity(page, { url: "https://example.com/both", project: "chromium" });
} finally {
  await browser.close();
}
`;
		const findings = runScenario(script, ts);
		const any = findings.filter((f) => f.check.startsWith("target-blank-"));
		expect(any).toHaveLength(0);
	});
});

describe("checkSecurity — mixed content", () => {
	test("flags http:// img src on https origin", () => {
		const ts = "2026-04-24T11-30-00.000Z";
		const script = `
const { chromium } = await import("@playwright/test");
const { checkSecurity } = await import(${JSON.stringify(path.join(REPO_ROOT, "tests/utils/checks/security.ts"))});

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.setContent('<html><body><img src="http://insecure.example/pic.jpg"><p>ok</p></body></html>', { waitUntil: "domcontentloaded" });
  await checkSecurity(page, { url: "https://example.com/mx", project: "chromium" });
} finally {
  await browser.close();
}
`;
		const findings = runScenario(script, ts);
		const mx = findings.filter((f) => f.check === "mixed-content");
		expect(mx.length).toBeGreaterThanOrEqual(1);
		expect(mx[0].severity).toBe("error");
	});

	test("skipped on http:// origin (mixed-content rule doesn't apply)", () => {
		const ts = "2026-04-24T11-30-01.000Z";
		const script = `
const { chromium } = await import("@playwright/test");
const { checkSecurity } = await import(${JSON.stringify(path.join(REPO_ROOT, "tests/utils/checks/security.ts"))});

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.setContent('<html><body><img src="http://insecure.example/pic.jpg"></body></html>', { waitUntil: "domcontentloaded" });
  await checkSecurity(page, { url: "http://example.com/mx", project: "chromium" });
} finally {
  await browser.close();
}
`;
		const findings = runScenario(script, ts);
		const mx = findings.filter((f) => f.check === "mixed-content");
		expect(mx).toHaveLength(0);
	});

	test("skipped on localhost origin", () => {
		const ts = "2026-04-24T11-30-02.000Z";
		const script = `
const { chromium } = await import("@playwright/test");
const { checkSecurity } = await import(${JSON.stringify(path.join(REPO_ROOT, "tests/utils/checks/security.ts"))});

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.setContent('<html><body><img src="http://insecure.example/pic.jpg"></body></html>', { waitUntil: "domcontentloaded" });
  await checkSecurity(page, { url: "https://localhost:3000/mx", project: "chromium" });
} finally {
  await browser.close();
}
`;
		const findings = runScenario(script, ts);
		const mx = findings.filter((f) => f.check === "mixed-content");
		expect(mx).toHaveLength(0);
	});
});
