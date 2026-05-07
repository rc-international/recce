import { readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";

/**
 * Playwright global setup.
 *
 * 1. Captures a single run timestamp (RECCE_RUN_TS) so every worker that
 *    imports tests/utils/findings.ts resolves to the same JSONL path.
 * 2. Cleans stale findings artefacts (>7d) so the directory doesn't grow
 *    unbounded.
 */
export default async function globalSetup(): Promise<void> {
	const now = new Date();
	if (!process.env.RECCE_RUN_TS) {
		process.env.RECCE_RUN_TS = now.toISOString();
	}
	if (!process.env.RECCE_START_AT) {
		process.env.RECCE_START_AT = now.toISOString();
	}

	const dir = path.resolve(process.cwd(), "test-results", "findings");
	const cutoff = now.getTime() - 7 * 24 * 60 * 60 * 1000;
	let cleaned = 0;

	try {
		const entries = readdirSync(dir);
		for (const name of entries) {
			// Never touch the symlink — it gets rewritten every run.
			if (name === "findings-latest.json") continue;
			if (!name.endsWith(".jsonl") && !name.endsWith(".json")) continue;
			const full = path.join(dir, name);
			try {
				const st = statSync(full);
				if (st.mtimeMs < cutoff) {
					unlinkSync(full);
					cleaned += 1;
				}
			} catch (e) {
				console.debug(`[recce-setup] stat/unlink failed for ${full}:`, e);
			}
		}
	} catch (e) {
		// ENOENT on a fresh checkout is expected.
		console.debug(`[recce-setup] readdir ${dir} failed:`, e);
	}

	if (cleaned > 0) {
		console.debug(
			`[recce-setup] cleaned ${cleaned} stale findings files older than 7d`,
		);
	}
}
