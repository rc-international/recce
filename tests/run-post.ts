import { existsSync, readFileSync } from "node:fs";
import { deliverReport } from "./utils/discord-reporter";
import { consolidateFindings, getLatestJsonPath } from "./utils/findings";
import type { FindingsArtifact } from "./utils/types";

/**
 * Standalone post-run driver for run-daily.sh.
 *
 * Why this exists: Playwright's globalTeardown does NOT reliably run when
 * `globalTimeout` fires (observed 2026-05-04: 15-min timeout terminated the
 * runner but findings-latest.json was never written and Discord never
 * received a report). The custom Discord reporter's `onEnd` is also tied to
 * Playwright's lifecycle and can be skipped on abnormal exit.
 *
 * To make the daily pulse self-healing, run-daily.sh invokes this script
 * UNCONDITIONALLY after `npx playwright test` exits — success, failure, or
 * SIGTERM. It re-runs the consolidation + posts a best-effort Discord report
 * so operators never get a silent run.
 *
 * Suite summary fields (passed/failed/skipped) come from the playwright
 * stdout if the file is provided via RECCE_RUN_LOG; otherwise they default
 * to 0 with a note that the report was generated post-mortem.
 */

function parseSuiteSummaryFromLog(logPath: string): {
	passed: number;
	failed: number;
	skipped: number;
	durationSec: string;
} {
	const fallback = { passed: 0, failed: 0, skipped: 0, durationSec: "?" };
	if (!logPath || !existsSync(logPath)) return fallback;
	try {
		const raw = readFileSync(logPath, { encoding: "utf8" });
		// Playwright's terminal output (when not html-only) prints
		//   "  X passed (Y)" or "  X failed (Y)"
		// We can also pick up "Y" as duration. The html reporter is silent so
		// this often returns the fallback — that's acceptable; the artifact
		// embed still carries the meaningful per-finding data.
		const m = raw.match(/(\d+)\s+passed/);
		const f = raw.match(/(\d+)\s+failed/);
		const s = raw.match(/(\d+)\s+skipped/);
		const d = raw.match(/\((\d+(?:\.\d+)?)(s|m)\)/);
		const duration = d
			? d[2] === "m"
				? `${(parseFloat(d[1]) * 60).toFixed(1)}`
				: d[1]
			: "?";
		return {
			passed: m ? parseInt(m[1], 10) : 0,
			failed: f ? parseInt(f[1], 10) : 0,
			skipped: s ? parseInt(s[1], 10) : 0,
			durationSec: duration,
		};
	} catch (e) {
		console.warn(`[recce-post] parse log ${logPath} failed:`, e);
		return fallback;
	}
}

async function main(): Promise<number> {
	const webhookUrl = process.env.RECCE_DISCORD_WEBHOOK;
	if (!webhookUrl) {
		console.warn(`[recce-post] RECCE_DISCORD_WEBHOOK unset — skipping post`);
		return 0;
	}

	const baseURL = process.env.BASE_URL ?? "";
	const mode = (process.env.RECCE_MODE as "pulse" | "audit") || "pulse";
	const startedAt = process.env.RECCE_START_AT ?? new Date().toISOString();
	const finishedAt = new Date().toISOString();

	// Always re-run consolidation. If the JSONL is empty/missing,
	// consolidateFindings returns (and writes) an empty artifact and swaps
	// the symlink — the Discord post then carries the empty-counts fallback.
	let artifact: FindingsArtifact;
	try {
		artifact = consolidateFindings({
			startedAt,
			finishedAt,
			mode,
			baseURL,
		});
	} catch (e) {
		console.error(`[recce-post] consolidateFindings threw:`, e);
		return 1;
	}

	const latest = getLatestJsonPath();
	const summary = parseSuiteSummaryFromLog(
		process.env.RECCE_RUN_LOG ?? "/tmp/recce-last-run.log",
	);

	try {
		await deliverReport({
			webhookUrl,
			artifact,
			artifactPath: latest,
			suiteSummary: {
				passed: summary.passed,
				failed: summary.failed,
				skipped: summary.skipped,
				totalDurationSec: summary.durationSec,
				baseURL,
				hasRecaptcha: process.env.RECCE_RECAPTCHA !== "false",
			},
			failureDetails: [],
		});
		console.log(`[recce-post] Discord report posted (mode=${mode})`);
		return 0;
	} catch (e) {
		console.error(`[recce-post] deliverReport failed:`, e);
		return 1;
	}
}

main().then(
	(code) => process.exit(code),
	(e) => {
		console.error(`[recce-post] uncaught:`, e);
		process.exit(1);
	},
);
