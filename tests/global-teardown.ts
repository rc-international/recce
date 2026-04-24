import { existsSync } from "node:fs";
import { consolidateFindings, getLatestJsonPath } from "./utils/findings";
import { safeWilcoNotify } from "./utils/wilco-notify";

/**
 * Playwright global teardown.
 *
 * Consolidates the per-run JSONL sink into the final `<mode>-<ts>.json`
 * artefact and swaps the `findings-latest.json` symlink. If the symlink is
 * missing after consolidation, escalates via wilco-notify so a silent loss of
 * the Recce report surfaces immediately.
 */
export default async function globalTeardown(): Promise<void> {
	const startedAt = process.env.RECCE_START_AT ?? new Date().toISOString();
	const finishedAt = new Date().toISOString();
	const mode = (process.env.RECCE_MODE as "pulse" | "audit") || "pulse";
	const baseURL = process.env.BASE_URL ?? "";

	try {
		consolidateFindings({
			startedAt,
			finishedAt,
			mode,
			baseURL,
			// pagesCrawled / rateLimited are populated by the crawler in later
			// phases; for Phase 1 we leave them at their defaults.
		});
	} catch (e) {
		console.error(`[recce-teardown] consolidateFindings threw:`, e);
	}

	const latest = getLatestJsonPath();
	if (!existsSync(latest)) {
		const msg = `findings-latest.json is missing after teardown (mode=${mode})`;
		console.error(`[recce-teardown] ${msg}`);
		process.env.RECCE_TEARDOWN_ESCALATED = "1";
		safeWilcoNotify(msg, {
			level: "error",
			title: "Recce report lost",
			logPrefix: "recce-teardown",
		});
	}
}
