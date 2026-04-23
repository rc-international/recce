import {
	appendFileSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import type { Finding, FindingsArtifact, Run } from "./types";

/**
 * JSONL write-through sink + consolidation for Recce findings.
 *
 * Every worker calls `recordFinding(f)` synchronously. Each call appends a
 * single JSON line to `test-results/findings/<mode>-<ISOts>.jsonl`. No in-memory
 * buffering — if the Playwright runner OOMs mid-run, every finding that reached
 * disk is preserved.
 *
 * At global-teardown, `consolidateFindings(run)` reads the JSONL, groups by URL
 * and by check, writes `test-results/findings/<mode>-<ISOts>.json`, and
 * atomically swaps the `findings-latest.json` symlink.
 */

const FINDINGS_DIR = path.resolve(process.cwd(), "test-results", "findings");

// Captured at module init so every worker in a single Playwright run resolves
// to the same path. The Playwright test runner loads this module once per
// worker process; the timestamp therefore ends up per-worker. To keep a run
// coherent across workers we allow an override via RECCE_RUN_TS which the
// global-setup file writes before spawning workers.
const MODE = (process.env.RECCE_MODE as "pulse" | "audit") || "pulse";
const RUN_TS = process.env.RECCE_RUN_TS || new Date().toISOString();

const JSONL_PATH = path.join(FINDINGS_DIR, `${MODE}-${RUN_TS}.jsonl`);
const JSON_PATH = path.join(FINDINGS_DIR, `${MODE}-${RUN_TS}.json`);
const LATEST_LINK = path.join(FINDINGS_DIR, "findings-latest.json");

function ensureDir(): void {
	try {
		mkdirSync(FINDINGS_DIR, { recursive: true });
	} catch (e) {
		console.debug(`[recce-findings] mkdir ${FINDINGS_DIR} failed:`, e);
	}
}

/**
 * Append a single finding to the run's JSONL file. Synchronous and durable —
 * uses fs.appendFileSync so the line is on disk before the call returns.
 *
 * Every catch logs; nothing is swallowed silently.
 */
export function recordFinding(f: Finding): void {
	ensureDir();
	const line = `${JSON.stringify(f)}\n`;
	try {
		appendFileSync(JSONL_PATH, line, { encoding: "utf8" });
	} catch (e) {
		// Durability failure — log loudly. We can't record into the same sink
		// because that sink is what just failed.
		console.error(
			`[recce-findings] appendFileSync to ${JSONL_PATH} failed:`,
			e,
		);
	}
}

export function getCurrentJsonlPath(): string {
	return JSONL_PATH;
}

export function getLatestJsonPath(): string {
	return LATEST_LINK;
}

function emptyArtifact(run: Partial<Run>): FindingsArtifact {
	const base: Run = {
		schemaVersion: 1,
		startedAt: run.startedAt ?? new Date().toISOString(),
		finishedAt: run.finishedAt ?? new Date().toISOString(),
		mode: (run.mode as "pulse" | "audit") ?? MODE,
		baseURL: run.baseURL ?? process.env.BASE_URL ?? "",
		pagesCrawled: run.pagesCrawled ?? 0,
		rateLimited: run.rateLimited ?? 0,
		findingCounts: run.findingCounts ?? { error: 0, warn: 0, info: 0 },
	};
	return { run: base, byUrl: {}, byCheck: {} };
}

function parseJsonl(contents: string): Finding[] {
	const out: Finding[] = [];
	for (const raw of contents.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		try {
			const parsed = JSON.parse(line) as Finding;
			out.push(parsed);
		} catch (e) {
			console.warn(
				`[recce-findings] skipping malformed JSONL line (len=${line.length}):`,
				e,
			);
		}
	}
	return out;
}

function swapLatestLink(targetJsonPath: string): void {
	// Atomic swap: write temp link, rename over existing. On systems that don't
	// support symlinks we copy the JSON to findings-latest.json instead.
	const tempLink = `${LATEST_LINK}.tmp-${process.pid}-${Date.now()}`;
	try {
		// Remove any stale temp link from a prior crashed run.
		if (existsSync(tempLink)) {
			try {
				unlinkSync(tempLink);
			} catch (e) {
				console.debug(`[recce-findings] unlink stale temp link failed:`, e);
			}
		}
		symlinkSync(path.basename(targetJsonPath), tempLink);
		renameSync(tempLink, LATEST_LINK);
	} catch (e) {
		console.warn(
			`[recce-findings] symlink swap failed, falling back to copy:`,
			e,
		);
		try {
			// If LATEST_LINK existed as a symlink, remove it first so copyFileSync
			// overwrites a regular file rather than following a dangling link.
			if (existsSync(LATEST_LINK) || isLinkSafe(LATEST_LINK)) {
				try {
					unlinkSync(LATEST_LINK);
				} catch (unlinkErr) {
					console.debug(
						`[recce-findings] unlink existing LATEST_LINK failed:`,
						unlinkErr,
					);
				}
			}
			copyFileSync(targetJsonPath, LATEST_LINK);
		} catch (copyErr) {
			console.error(
				`[recce-findings] copy fallback for findings-latest.json failed:`,
				copyErr,
			);
		}
	}
}

function isLinkSafe(p: string): boolean {
	try {
		return lstatSync(p).isSymbolicLink();
	} catch (e) {
		// ENOENT is expected when the link doesn't exist yet.
		console.debug(`[recce-findings] lstat ${p} returned error:`, e);
		return false;
	}
}

/**
 * Read the JSONL sink, group findings by URL and by check, write the
 * consolidated JSON artifact, and atomically update findings-latest.json.
 * Returns the artifact in memory.
 *
 * If the JSONL is missing or empty, returns (and writes) an empty artifact.
 */
export function consolidateFindings(run: Partial<Run>): FindingsArtifact {
	ensureDir();

	let raw = "";
	try {
		if (existsSync(JSONL_PATH)) {
			raw = readFileSync(JSONL_PATH, { encoding: "utf8" });
		}
	} catch (e) {
		console.warn(`[recce-findings] readFile ${JSONL_PATH} failed:`, e);
	}

	const findings = raw ? parseJsonl(raw) : [];

	const byUrl: Record<string, Finding[]> = {};
	const byCheck: Record<string, Finding[]> = {};
	const counts = { error: 0, warn: 0, info: 0 };

	for (const f of findings) {
		if (!byUrl[f.url]) byUrl[f.url] = [];
		byUrl[f.url].push(f);
		if (!byCheck[f.check]) byCheck[f.check] = [];
		byCheck[f.check].push(f);
		counts[f.severity] += 1;
	}

	const mergedRun: Run = {
		schemaVersion: 1,
		startedAt: run.startedAt ?? new Date().toISOString(),
		finishedAt: run.finishedAt ?? new Date().toISOString(),
		mode: (run.mode as "pulse" | "audit") ?? MODE,
		baseURL: run.baseURL ?? process.env.BASE_URL ?? "",
		pagesCrawled: run.pagesCrawled ?? 0,
		rateLimited: run.rateLimited ?? 0,
		findingCounts: counts,
	};

	const artifact: FindingsArtifact = findings.length
		? { run: mergedRun, byUrl, byCheck }
		: emptyArtifact(run);

	try {
		writeFileSync(JSON_PATH, `${JSON.stringify(artifact, null, 2)}\n`, {
			encoding: "utf8",
		});
	} catch (e) {
		console.error(`[recce-findings] writeFile ${JSON_PATH} failed:`, e);
		return artifact;
	}

	swapLatestLink(JSON_PATH);
	return artifact;
}
