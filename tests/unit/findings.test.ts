import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

/**
 * Unit tests for the Recce findings sink + consolidation.
 *
 * We drive the module in a child process (via `bun -e`) per test case because
 * tests/utils/findings.ts captures RECCE_RUN_TS at module init. A child
 * process gives us a fresh module registry and isolated filesystem for each
 * scenario.
 */

const MODULE_PATH = path.resolve(__dirname, "..", "utils", "findings.ts");

let workDir: string;
let savedEnv: Record<string, string | undefined> = {};

const ENV_KEYS = ["RECCE_MODE", "RECCE_RUN_TS", "BASE_URL"] as const;

function snapshotEnv(): void {
	savedEnv = {};
	for (const k of ENV_KEYS) {
		savedEnv[k] = process.env[k];
	}
}

function restoreEnv(): void {
	for (const k of ENV_KEYS) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
}

/**
 * Run a Bun script inside workDir with RECCE_MODE/RECCE_RUN_TS set.
 * Returns stdout so tests can parse JSON results.
 */
function runInChild(
	script: string,
	extraEnv: Record<string, string> = {},
): string {
	const env = {
		...process.env,
		RECCE_MODE: "pulse",
		RECCE_RUN_TS: "2026-04-23T00-00-00.000Z",
		BASE_URL: "http://localhost:9999",
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

beforeEach(() => {
	snapshotEnv();
	workDir = mkdtempSync(path.join(tmpdir(), "recce-findings-"));
	mkdirSync(path.join(workDir, "test-results", "findings"), {
		recursive: true,
	});
});

afterEach(() => {
	restoreEnv();
	try {
		rmSync(workDir, { recursive: true, force: true });
	} catch (e) {
		console.debug(`[findings.test] rm ${workDir} failed:`, e);
	}
});

// --- zod schema mirroring tests/utils/types.ts ---
const SeveritySchema = z.enum(["error", "warn", "info"]);
const ProjectSchema = z.enum(["chromium", "Mobile Chrome", "webkit"]);
const FindingSchema = z.object({
	url: z.string(),
	check: z.string(),
	severity: SeveritySchema,
	message: z.string(),
	element: z
		.object({
			tag: z.string(),
			selector: z.string().optional(),
			attr: z.record(z.string(), z.string()).optional(),
		})
		.optional(),
	expected: z.string().optional(),
	actual: z.string().optional(),
	project: ProjectSchema,
});
const RunSchema = z.object({
	schemaVersion: z.literal(1),
	startedAt: z.string(),
	finishedAt: z.string(),
	mode: z.enum(["pulse", "audit"]),
	baseURL: z.string(),
	pagesCrawled: z.number().int().nonnegative(),
	rateLimited: z.number().int().nonnegative(),
	findingCounts: z.object({
		error: z.number().int().nonnegative(),
		warn: z.number().int().nonnegative(),
		info: z.number().int().nonnegative(),
	}),
});
const ArtifactSchema = z.object({
	run: RunSchema,
	byUrl: z.record(z.string(), z.array(FindingSchema)),
	byCheck: z.record(z.string(), z.array(FindingSchema)),
});

describe("findings: recordFinding", () => {
	test("appends one JSONL line per call; 3 calls -> 3 lines", () => {
		runInChild(`
			const { recordFinding, getCurrentJsonlPath } = require(${JSON.stringify(MODULE_PATH)});
			for (let i = 0; i < 3; i++) {
				recordFinding({
					url: "/p/" + i,
					check: "image-broken",
					severity: "error",
					message: "m" + i,
					project: "chromium",
				});
			}
			process.stdout.write(getCurrentJsonlPath());
		`);
		const jsonlPath = path.join(
			workDir,
			"test-results",
			"findings",
			"pulse-2026-04-23T00-00-00.000Z.jsonl",
		);
		expect(existsSync(jsonlPath)).toBe(true);
		const raw = readFileSync(jsonlPath, "utf8");
		const lines = raw.split("\n").filter((l) => l.trim());
		expect(lines).toHaveLength(3);
		for (let i = 0; i < 3; i++) {
			const parsed = JSON.parse(lines[i]);
			expect(parsed.url).toBe(`/p/${i}`);
			expect(parsed.severity).toBe("error");
		}
	});
});

describe("findings: consolidateFindings", () => {
	test("groups findings by url and by check", () => {
		const out = runInChild(`
			const { recordFinding, consolidateFindings } = require(${JSON.stringify(MODULE_PATH)});
			recordFinding({ url: "/a", check: "image-broken", severity: "error", message: "m1", project: "chromium" });
			recordFinding({ url: "/a", check: "link-broken", severity: "warn", message: "m2", project: "chromium" });
			recordFinding({ url: "/b", check: "image-broken", severity: "error", message: "m3", project: "chromium" });
			const artifact = consolidateFindings({
				startedAt: "2026-04-23T00:00:00.000Z",
				finishedAt: "2026-04-23T00:00:10.000Z",
				mode: "pulse",
				baseURL: "http://localhost:9999",
				pagesCrawled: 2,
				rateLimited: 0,
			});
			process.stdout.write(JSON.stringify(artifact));
		`);
		const artifact = JSON.parse(out);
		expect(Object.keys(artifact.byUrl).sort()).toEqual(["/a", "/b"]);
		expect(artifact.byUrl["/a"]).toHaveLength(2);
		expect(artifact.byUrl["/b"]).toHaveLength(1);
		expect(Object.keys(artifact.byCheck).sort()).toEqual([
			"image-broken",
			"link-broken",
		]);
		expect(artifact.byCheck["image-broken"]).toHaveLength(2);
		expect(artifact.run.findingCounts).toEqual({
			error: 2,
			warn: 1,
			info: 0,
		});
	});

	test("concurrent interleaved writes all land in consolidated JSON", () => {
		// Simulate 2 workers interleaving writes via Promise.all inside a single
		// child process. appendFileSync is atomic for small buffers on POSIX so
		// no lines should be lost or torn.
		const out = runInChild(`
			const { recordFinding, consolidateFindings } = require(${JSON.stringify(MODULE_PATH)});
			const worker = (id, n) => new Promise((resolve) => {
				for (let i = 0; i < n; i++) {
					recordFinding({
						url: "/worker/" + id,
						check: "image-broken",
						severity: "error",
						message: "w" + id + "-" + i,
						project: "chromium",
					});
				}
				resolve();
			});
			Promise.all([worker("A", 25), worker("B", 25)]).then(() => {
				const artifact = consolidateFindings({
					startedAt: "2026-04-23T00:00:00.000Z",
					finishedAt: "2026-04-23T00:00:10.000Z",
					mode: "pulse",
					baseURL: "http://localhost:9999",
					pagesCrawled: 2,
					rateLimited: 0,
				});
				process.stdout.write(JSON.stringify(artifact));
			});
		`);
		const artifact = JSON.parse(out);
		expect(artifact.byUrl["/worker/A"]).toHaveLength(25);
		expect(artifact.byUrl["/worker/B"]).toHaveLength(25);
		expect(artifact.run.findingCounts.error).toBe(50);
	});

	test("empty/missing JSONL yields a valid empty artefact", () => {
		const out = runInChild(`
			const { consolidateFindings } = require(${JSON.stringify(MODULE_PATH)});
			const artifact = consolidateFindings({
				startedAt: "2026-04-23T00:00:00.000Z",
				finishedAt: "2026-04-23T00:00:01.000Z",
				mode: "pulse",
				baseURL: "http://localhost:9999",
				pagesCrawled: 0,
				rateLimited: 0,
			});
			process.stdout.write(JSON.stringify(artifact));
		`);
		const artifact = JSON.parse(out);
		expect(artifact.run.schemaVersion).toBe(1);
		expect(artifact.run.pagesCrawled).toBe(0);
		expect(artifact.run.findingCounts).toEqual({
			error: 0,
			warn: 0,
			info: 0,
		});
		expect(artifact.byUrl).toEqual({});
		expect(artifact.byCheck).toEqual({});

		// Artefact file and findings-latest.json must exist.
		const jsonPath = path.join(
			workDir,
			"test-results",
			"findings",
			"pulse-2026-04-23T00-00-00.000Z.json",
		);
		const latest = path.join(
			workDir,
			"test-results",
			"findings",
			"findings-latest.json",
		);
		expect(existsSync(jsonPath)).toBe(true);
		expect(existsSync(latest)).toBe(true);
	});

	test("consolidated artefact parses against the zod schema", () => {
		const out = runInChild(`
			const { recordFinding, consolidateFindings } = require(${JSON.stringify(MODULE_PATH)});
			recordFinding({
				url: "/x",
				check: "image-broken",
				severity: "error",
				message: "m",
				element: { tag: "img", selector: "img.hero", attr: { src: "/foo.png" } },
				expected: "200",
				actual: "404",
				project: "chromium",
			});
			const artifact = consolidateFindings({
				startedAt: "2026-04-23T00:00:00.000Z",
				finishedAt: "2026-04-23T00:00:10.000Z",
				mode: "pulse",
				baseURL: "http://localhost:9999",
				pagesCrawled: 1,
				rateLimited: 0,
			});
			process.stdout.write(JSON.stringify(artifact));
		`);
		const artifact = JSON.parse(out);
		const parsed = ArtifactSchema.safeParse(artifact);
		if (!parsed.success) {
			throw new Error(
				`well-formed artefact rejected by schema: ${JSON.stringify(parsed.error.issues)}`,
			);
		}
		expect(parsed.success).toBe(true);
	});
});

describe("findings: schema validation", () => {
	test("well-formed Finding parses", () => {
		const good = {
			url: "/a",
			check: "image-broken",
			severity: "error",
			message: "bad",
			project: "chromium",
		};
		expect(FindingSchema.safeParse(good).success).toBe(true);
	});

	test("malformed Finding with missing severity is rejected", () => {
		const bad = {
			url: "/a",
			check: "image-broken",
			// severity missing
			message: "bad",
			project: "chromium",
		};
		expect(FindingSchema.safeParse(bad).success).toBe(false);
	});

	test("malformed Finding with non-string check is rejected", () => {
		const bad = {
			url: "/a",
			check: 42,
			severity: "error",
			message: "bad",
			project: "chromium",
		};
		expect(FindingSchema.safeParse(bad).success).toBe(false);
	});
});
