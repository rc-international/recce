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
import { gzipSync } from "node:zlib";

import { normaliseUrl } from "../utils/crawler";

/**
 * Unit tests for the Recce crawler primitive.
 *
 * URL-normalisation and structural tests (depth/page caps, hook ordering,
 * sitemap discovery, 429 retry + rate_limited emission) run via a child
 * process. The child script boots its own copy of tests/utils/findings.ts,
 * using a per-test RECCE_RUN_TS/RECCE_MODE so the JSONL output is isolated.
 *
 * The crawler's real browser path is stubbed: the child constructs a fake
 * `PageLike` object whose goto() consults a scripted response table. This
 * keeps the tests fast and hermetic.
 */

const CRAWLER_PATH = path.resolve(__dirname, "..", "utils", "crawler.ts");
const FINDINGS_PATH = path.resolve(__dirname, "..", "utils", "findings.ts");

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

function runInChild(
	script: string,
	extraEnv: Record<string, string> = {},
): string {
	const env = {
		...process.env,
		RECCE_MODE: "pulse",
		RECCE_RUN_TS: "2026-04-23T00-00-00.000Z",
		BASE_URL: "https://example.test",
		...extraEnv,
	};
	const scriptPath = path.join(
		workDir,
		`child-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`,
	);
	writeFileSync(scriptPath, script, "utf8");
	try {
		return execSync(`bun run ${JSON.stringify(scriptPath)}`, {
			cwd: workDir,
			env,
			encoding: "utf8",
		});
	} catch (e) {
		const err = e as { stdout?: Buffer; stderr?: Buffer; message?: string };
		const stdout = err.stdout?.toString() ?? "";
		const stderr = err.stderr?.toString() ?? "";
		throw new Error(
			`child process failed: ${err.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
		);
	}
}

function readJsonl(): Array<Record<string, unknown>> {
	const p = path.join(
		workDir,
		"test-results",
		"findings",
		"pulse-2026-04-23T00-00-00.000Z.jsonl",
	);
	let raw = "";
	try {
		raw = readFileSync(p, "utf8");
	} catch (e) {
		console.debug(`[crawler.test] readJsonl ${p} failed:`, e);
	}
	return raw
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
}

beforeEach(() => {
	snapshotEnv();
	workDir = mkdtempSync(path.join(tmpdir(), "recce-crawler-"));
	mkdirSync(path.join(workDir, "test-results", "findings"), {
		recursive: true,
	});
});

afterEach(() => {
	restoreEnv();
	try {
		rmSync(workDir, { recursive: true, force: true });
	} catch (e) {
		console.debug(`[crawler.test] rm ${workDir} failed:`, e);
	}
});

// -----------------------------------------------------------------------------
// normaliseUrl — pure, safe to call inline (no side effects, no module init).
// -----------------------------------------------------------------------------

describe("crawler: normaliseUrl", () => {
	test("strips trailing slash except at root", () => {
		expect(normaliseUrl("/articles/en/", "https://ex.com")).toBe(
			"https://ex.com/articles/en",
		);
		expect(normaliseUrl("/", "https://ex.com")).toBe("https://ex.com/");
	});

	test("lowercases host", () => {
		expect(normaliseUrl("https://EXAMPLE.COM/x", "https://example.com")).toBe(
			"https://example.com/x",
		);
	});

	test("drops utm_*, gclid, fbclid but keeps other params", () => {
		const out = normaliseUrl(
			"/x?utm_source=a&utm_medium=b&gclid=g&fbclid=f&keep=1",
			"https://ex.com",
		);
		const u = new URL(out);
		expect(u.searchParams.get("utm_source")).toBeNull();
		expect(u.searchParams.get("utm_medium")).toBeNull();
		expect(u.searchParams.get("gclid")).toBeNull();
		expect(u.searchParams.get("fbclid")).toBeNull();
		expect(u.searchParams.get("keep")).toBe("1");
	});

	test("resolves relative URLs against origin", () => {
		expect(normaliseUrl("foo/bar", "https://ex.com/base/")).toBe(
			"https://ex.com/base/foo/bar",
		);
	});

	test("returns empty string on invalid input", () => {
		expect(normaliseUrl("::::::", "")).toBe("");
	});
});

// -----------------------------------------------------------------------------
// Shared harness for child-process crawler runs.
// -----------------------------------------------------------------------------

/**
 * Builds a standalone child script that:
 *   - imports crawl + findings path
 *   - builds a fake PageLike whose goto/evaluate are driven by a scripted table
 *   - pipes a fake fetcher for sitemap discovery
 *   - prints JSON.stringify(result) to stdout
 *
 * `pageScript` and `fetcherScript` are raw TS snippets inserted into the child
 * source. They must evaluate to a `PageLike` and `Fetcher` respectively.
 */
const RESULT_MARKER_START = "<<<RECCE_RESULT_START>>>";
const RESULT_MARKER_END = "<<<RECCE_RESULT_END>>>";

function buildChildScript(args: {
	seedUrls: string[];
	pageScript: string;
	fetcherScript: string;
	maxPages?: number;
	maxDepth?: number;
	pageHooks?: string; // raw TS expression, e.g. '[async (_p, url) => { console.log("hook:"+url) }]'
	extraPayload?: string; // additional JSON fields, raw expression e.g. '{ __calls: globalThis.__calls }'
}): string {
	// Bun routes console.debug to stdout, so we must isolate our JSON payload
	// inside unique sentinel markers. The test helper runInChild() extracts
	// the payload between the markers.
	return `
		const { crawl } = require(${JSON.stringify(CRAWLER_PATH)});
		// Force findings module to initialise synchronously inside the child.
		require(${JSON.stringify(FINDINGS_PATH)});

		const fakePage = (${args.pageScript});
		const fakeFetcher = (${args.fetcherScript});

		(async () => {
			const result = await crawl(fakePage, {
				baseURL: "https://example.test",
				seedUrls: ${JSON.stringify(args.seedUrls)},
				maxPages: ${args.maxPages ?? 50},
				maxDepth: ${args.maxDepth ?? 7},
				fetcher: fakeFetcher,
				pageHooks: ${args.pageHooks ?? "[]"},
				project: "chromium",
			});
			const payload = Object.assign({
				crawled: result.crawled,
				discoveredLinks: Array.from(result.discoveredLinks),
				rateLimited: result.rateLimited,
			}, ${args.extraPayload ?? "{}"});
			process.stdout.write(${JSON.stringify(RESULT_MARKER_START)} + JSON.stringify(payload) + ${JSON.stringify(RESULT_MARKER_END)});
		})();
	`;
}

type CrawlPayload = {
	crawled: string[];
	discoveredLinks: string[];
	rateLimited: number;
	[extra: string]: unknown;
};

function extractResult(stdout: string): CrawlPayload {
	const i = stdout.indexOf(RESULT_MARKER_START);
	const j = stdout.indexOf(RESULT_MARKER_END);
	if (i < 0 || j < 0 || j <= i) {
		throw new Error(
			`result markers missing in child stdout:\n${stdout.slice(0, 2000)}`,
		);
	}
	return JSON.parse(stdout.slice(i + RESULT_MARKER_START.length, j));
}

// Small helper to escape content for embedding in a template literal.
function esc(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");
}

// -----------------------------------------------------------------------------
// Sitemap discovery chain
// -----------------------------------------------------------------------------

describe("crawler: sitemap discovery chain", () => {
	test("robots.txt sitemap wins, sitemap index is recursed, gz is inflated", () => {
		// Child page with a single url that returns 200 and no hrefs.
		const pageScript = `
			{
				goto: async () => ({
					status: () => 200,
					headers: () => ({}),
				}),
				evaluate: async () => [],
				waitForTimeout: async () => {},
			}
		`;

		const childSitemapGz = gzipSync(
			Buffer.from(
				`<?xml version="1.0"?><urlset><url><loc>https://example.test/articles/en/fromgz</loc></url></urlset>`,
			),
		).toString("base64");

		// Fetcher script: branches on URL.
		const fetcherScript = `
			async (url) => {
				if (url === "https://example.test/robots.txt") {
					return { ok: true, status: 200, contentType: "text/plain",
						body: "Sitemap: https://example.test/sitemap-index.xml\\n" };
				}
				if (url === "https://example.test/sitemap-index.xml") {
					const xml = "<?xml version=\\"1.0\\"?><sitemapindex><sitemap><loc>https://example.test/child.xml.gz</loc></sitemap></sitemapindex>";
					return { ok: true, status: 200, contentType: "application/xml", body: xml };
				}
				if (url === "https://example.test/child.xml.gz") {
					const buf = Buffer.from(${JSON.stringify(childSitemapGz)}, "base64");
					return { ok: true, status: 200, contentType: "application/xml", body: buf };
				}
				return { ok: false, status: 404, contentType: "", body: "" };
			}
		`;

		const script = buildChildScript({
			seedUrls: [],
			pageScript,
			fetcherScript,
			maxPages: 10,
		});
		const out = runInChild(script);
		const result = extractResult(out);
		expect(result.crawled).toContain("https://example.test/articles/en/fromgz");
		const findings = readJsonl();
		// No sitemap-parse-failed expected in the happy path.
		expect(
			findings.filter((f) => f.check === "sitemap-parse-failed").length,
		).toBe(0);
	});

	test("non-XML content-type on /sitemap.xml emits sitemap-parse-failed and falls back to seedUrls", () => {
		const pageScript = `
			{
				goto: async () => ({ status: () => 200, headers: () => ({}) }),
				evaluate: async () => [],
				waitForTimeout: async () => {},
			}
		`;
		const fetcherScript = `
			async (url) => {
				if (url === "https://example.test/robots.txt") {
					return { ok: false, status: 404, contentType: "", body: "" };
				}
				if (url === "https://example.test/sitemap.xml.gz") {
					return { ok: false, status: 404, contentType: "", body: "" };
				}
				if (url === "https://example.test/sitemap.xml") {
					// SPA catch-all returns HTML 200!
					return { ok: true, status: 200, contentType: "text/html",
						body: "<!DOCTYPE html><html><body>hi</body></html>" };
				}
				return { ok: false, status: 404, contentType: "", body: "" };
			}
		`;
		const script = buildChildScript({
			seedUrls: ["/articles/en/fallback"],
			pageScript,
			fetcherScript,
			maxPages: 10,
		});
		const out = runInChild(script);
		const result = extractResult(out);
		expect(result.crawled).toContain(
			"https://example.test/articles/en/fallback",
		);

		const findings = readJsonl();
		const failures = findings.filter((f) => f.check === "sitemap-parse-failed");
		// Exactly one: the sitemap.xml non-XML response.
		const sitemapXml = failures.filter(
			(f) => f.url === "https://example.test/sitemap.xml",
		);
		expect(sitemapXml.length).toBe(1);
		expect((sitemapXml[0] as { severity: string }).severity).toBe("warn");
	});
});

// -----------------------------------------------------------------------------
// BFS caps (depth + pages)
// -----------------------------------------------------------------------------

describe("crawler: BFS caps", () => {
	test("MAX_DEPTH cap prevents URL at depth N+1 from being crawled", () => {
		// Seed: /articles/en/a (depth 0). Page returns link /articles/en/a/b (depth 1)
		// but maxDepth=0 means nothing past the seed should be enqueued.
		// The crawler calls page.goto then page.evaluate; we track the most
		// recent URL via globalThis so evaluate() can return the right links.
		const pageScript2 = `
			(() => {
				globalThis.__lastUrl = "";
				const linkMap = {
					"https://example.test/articles/en/a": ["/articles/en/a/b"],
					"https://example.test/articles/en/a/b": [],
				};
				return {
					goto: async (url) => {
						globalThis.__lastUrl = url;
						return { status: () => 200, headers: () => ({}) };
					},
					evaluate: async () => linkMap[globalThis.__lastUrl] || [],
					waitForTimeout: async () => {},
				};
			})()
		`;
		const fetcherScript = `
			async () => ({ ok: false, status: 404, contentType: "", body: "" })
		`;
		const script = buildChildScript({
			seedUrls: ["/articles/en/a"],
			pageScript: pageScript2,
			fetcherScript,
			maxDepth: 0,
			maxPages: 10,
		});
		const out = runInChild(script);
		const result = extractResult(out);
		expect(result.crawled).toEqual(["https://example.test/articles/en/a"]);
		expect(result.crawled).not.toContain(
			"https://example.test/articles/en/a/b",
		);
	});

	test("MAX_PAGES cap is honoured", () => {
		// Seed: /articles/en/a — page returns 10 new links each of which
		// itself returns 0. maxPages = 3 means we should see 3 crawled URLs.
		const pageScript = `
			(() => {
				globalThis.__lastUrl = "";
				return {
					goto: async (url) => {
						globalThis.__lastUrl = url;
						return { status: () => 200, headers: () => ({}) };
					},
					evaluate: async () => {
						if (globalThis.__lastUrl === "https://example.test/articles/en/a") {
							return Array.from({length: 10}, (_, i) => "/articles/en/x" + i);
						}
						return [];
					},
					waitForTimeout: async () => {},
				};
			})()
		`;
		const fetcherScript = `
			async () => ({ ok: false, status: 404, contentType: "", body: "" })
		`;
		const script = buildChildScript({
			seedUrls: ["/articles/en/a"],
			pageScript,
			fetcherScript,
			maxPages: 3,
		});
		const out = runInChild(script);
		const result = extractResult(out);
		expect(result.crawled.length).toBeLessThanOrEqual(3);
	});
});

// -----------------------------------------------------------------------------
// pageHooks — fire before navigation
// -----------------------------------------------------------------------------

describe("crawler: pageHooks", () => {
	test("hook fires BEFORE goto for every visited URL", () => {
		const pageScript = `
			(() => {
				globalThis.__calls = [];
				globalThis.__lastUrl = "";
				return {
					goto: async (url) => {
						globalThis.__lastUrl = url;
						globalThis.__calls.push({ op: "goto", url });
						return { status: () => 200, headers: () => ({}) };
					},
					evaluate: async () => [],
					waitForTimeout: async () => {},
				};
			})()
		`;
		const fetcherScript = `
			async () => ({ ok: false, status: 404, contentType: "", body: "" })
		`;
		const hooks = `[
			async (_p, url) => { globalThis.__calls.push({ op: "hook", url }); }
		]`;
		const script = buildChildScript({
			seedUrls: ["/articles/en/x"],
			pageScript,
			fetcherScript,
			pageHooks: hooks,
			maxPages: 5,
			extraPayload: "{ __calls: globalThis.__calls }",
		});
		const out = runInChild(script);
		const result = extractResult(out);
		const calls = result.__calls as Array<{ op: string; url: string }>;
		// Find the first hook and first goto for the seed URL.
		const seed = "https://example.test/articles/en/x";
		const idxHook = calls.findIndex((c) => c.op === "hook" && c.url === seed);
		const idxGoto = calls.findIndex((c) => c.op === "goto" && c.url === seed);
		expect(idxHook).toBeGreaterThanOrEqual(0);
		expect(idxGoto).toBeGreaterThanOrEqual(0);
		expect(idxHook).toBeLessThan(idxGoto);
	});
});

// -----------------------------------------------------------------------------
// 429 handling
// -----------------------------------------------------------------------------

describe("crawler: 429 rate-limit handling", () => {
	test("first 429 triggers delay + requeue; second 429 emits rate_limited", () => {
		// Page returns 429 on every goto. We should see exactly one rate_limited
		// finding for the single seed URL (the SECOND 429 on the same URL).
		const pageScript = `
			(() => {
				globalThis.__gotoCount = 0;
				return {
					goto: async () => {
						globalThis.__gotoCount += 1;
						return { status: () => 429, headers: () => ({ "retry-after": "0" }) };
					},
					evaluate: async () => [],
					waitForTimeout: async () => {},
				};
			})()
		`;
		const fetcherScript = `
			async () => ({ ok: false, status: 404, contentType: "", body: "" })
		`;
		const script = buildChildScript({
			seedUrls: ["/articles/en/boom"],
			pageScript,
			fetcherScript,
			maxPages: 5,
		});
		const out = runInChild(script);
		const result = extractResult(out);
		expect(result.rateLimited).toBeGreaterThanOrEqual(2); // first + second hit
		const findings = readJsonl();
		const rl = findings.filter((f) => f.check === "rate_limited");
		expect(rl.length).toBe(1);
		expect((rl[0] as { url: string }).url).toBe(
			"https://example.test/articles/en/boom",
		);
	});
});

// Suppress unused-var warning from bun; `gzipSync` and `esc` are reachable
// when new tests are added.
void esc;
