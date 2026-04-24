import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type {
	FullConfig,
	FullResult,
	Reporter,
	Suite,
	TestCase,
	TestResult,
} from "@playwright/test/reporter";
import { getLatestJsonPath } from "./findings";
import type { Finding, FindingsArtifact } from "./types";
import { safeWilcoNotify } from "./wilco-notify";

/**
 * Recce Discord reporter (Phase 4).
 *
 * Delivery routing:
 *   - <= 10 failing URLs AND file <= 7.5 MB → inline embed (JSON webhook POST)
 *   - > 10 failing URLs AND file <= 7.5 MB → attach findings JSON (multipart)
 *   - file > 7.5 MB (regardless of URL count) → upload to public paste host
 *     (0x0.st by default); embed the returned URL in a JSON-only webhook POST.
 *
 * Privacy note: audit-mode findings JSON may contain URLs with query strings
 * or merchant IDs. When the file exceeds the Discord attachment size, the
 * reporter uploads the raw JSON to a PUBLIC paste host (0x0.st). Accepted as
 * a design tradeoff per Phase 4 of the plan — audit reports are internal team
 * use and the tradeoff is documented in the rollout plan.
 *
 * Any webhook delivery failure (non-2xx, timeout, 429-after-retry) escalates
 * via `wilco-notify --level error` so the failure is not silent.
 */

export const MAX_INLINE_FAILING_URLS = 10;
export const EXTERNAL_UPLOAD_THRESHOLD_BYTES = 7.5 * 1024 * 1024;
const EXTERNAL_UPLOAD_TIMEOUT_MS = 10_000;

export type DeliveryMode = "inline" | "attach" | "external-upload";

interface UrlScore {
	url: string;
	errors: number;
	warns: number;
	checks: Set<string>;
}

export interface DeliveryPlan {
	mode: DeliveryMode;
	failingUrlCount: number;
	topFailingUrls: UrlScore[];
	attachmentPath?: string;
	summaryNote: string;
	fileSizeBytes: number;
}

/**
 * Decide the delivery mode from an artifact + the on-disk JSON size.
 * Pure function — no I/O, no env reads. Tests drive this directly.
 */
export function classifyDelivery(
	artifact: FindingsArtifact,
	fileSizeBytes: number,
): DeliveryPlan {
	const scores = scoreByUrl(artifact);
	const failing = scores.filter((s) => s.errors > 0);
	const failingUrlCount = failing.length;

	let mode: DeliveryMode;
	if (fileSizeBytes > EXTERNAL_UPLOAD_THRESHOLD_BYTES) {
		mode = "external-upload";
	} else if (failingUrlCount > MAX_INLINE_FAILING_URLS) {
		mode = "attach";
	} else {
		mode = "inline";
	}

	const topFailingUrls = failing.slice(0, MAX_INLINE_FAILING_URLS);
	return {
		mode,
		failingUrlCount,
		topFailingUrls,
		summaryNote: "",
		fileSizeBytes,
	};
}

/**
 * Build a DeliveryPlan that includes an attachment path and human summary
 * note. `buildDeliveryPlan` is what the reporter actually invokes; the bare
 * `classifyDelivery` is kept as a pure function for unit-test clarity.
 */
export function buildDeliveryPlan(
	artifact: FindingsArtifact,
	fileSizeBytes: number,
	artifactPath?: string,
): DeliveryPlan {
	const base = classifyDelivery(artifact, fileSizeBytes);
	let summaryNote = "";
	let attachmentPath: string | undefined;
	const sizeMB = (fileSizeBytes / (1024 * 1024)).toFixed(1);

	if (base.mode === "attach") {
		attachmentPath = artifactPath;
		summaryNote = `${base.failingUrlCount} failing URLs — see attached JSON`;
	} else if (base.mode === "external-upload") {
		summaryNote = `findings JSON too large (${sizeMB} MB) — uploaded externally`;
	}

	return { ...base, attachmentPath, summaryNote };
}

function scoreByUrl(artifact: FindingsArtifact): UrlScore[] {
	const out: UrlScore[] = [];
	for (const [url, findings] of Object.entries(artifact.byUrl)) {
		let errors = 0;
		let warns = 0;
		const checks = new Set<string>();
		for (const f of findings) {
			if (f.severity === "error") errors += 1;
			else if (f.severity === "warn") warns += 1;
			checks.add(f.check);
		}
		out.push({ url, errors, warns, checks });
	}
	out.sort(
		(a, b) =>
			b.errors - a.errors || b.warns - a.warns || b.checks.size - a.checks.size,
	);
	return out;
}

/**
 * Upload a file to 0x0.st via curl. Returns the paste URL or null on failure.
 * We shell out to curl so the timeout and -F semantics match what ops runs
 * manually; Bun's fetch + FormData works too but curl is available on every
 * VPS in the fleet.
 */
export async function uploadToPasteHost(
	filePath: string,
): Promise<string | null> {
	const result = spawnSync(
		"curl",
		[
			"-sS",
			"--max-time",
			String(Math.ceil(EXTERNAL_UPLOAD_TIMEOUT_MS / 1000)),
			"-F",
			`file=@${filePath}`,
			"https://0x0.st",
		],
		{ encoding: "utf8", timeout: EXTERNAL_UPLOAD_TIMEOUT_MS + 2_000 },
	);
	if (result.status !== 0) {
		console.warn(
			`[recce-discord] 0x0.st upload failed (exit ${result.status}): ${result.stderr}`,
		);
		return null;
	}
	const url = (result.stdout || "").trim();
	if (!/^https?:\/\//.test(url)) {
		console.warn(
			`[recce-discord] 0x0.st returned non-URL response: ${url.slice(0, 200)}`,
		);
		return null;
	}
	return url;
}

export interface DeliverReportOpts {
	webhookUrl: string;
	artifact: FindingsArtifact;
	artifactPath: string;
	suiteSummary: {
		passed: number;
		failed: number;
		skipped: number;
		totalDurationSec: string;
		baseURL: string;
		hasRecaptcha: boolean;
	};
	failureDetails: Array<{ title: string; error?: string }>;
	// Injectable for tests; defaults to uploadToPasteHost
	externalUploader?: (filePath: string) => Promise<string | null>;
	// When false, the function will NOT spawn wilco-notify on delivery failure.
	// Tests set this to false to keep unit-test environments clean.
	escalate?: boolean;
}

export interface DeliverReportResult {
	delivered: boolean;
	mode: DeliveryMode;
	failureReason?: string;
	externalUrl?: string;
}

/**
 * Exported for tests and for production use in onEnd. Runs the full
 * decision → build payload → POST flow, returns a structured result.
 */
export async function deliverReport(
	opts: DeliverReportOpts,
): Promise<DeliverReportResult> {
	const {
		webhookUrl,
		artifact,
		artifactPath,
		suiteSummary,
		failureDetails,
		externalUploader = uploadToPasteHost,
		escalate = true,
	} = opts;

	let fileSizeBytes = 0;
	try {
		if (existsSync(artifactPath)) {
			fileSizeBytes = statSync(artifactPath).size;
		}
	} catch (e) {
		console.warn(`[recce-discord] stat ${artifactPath} failed:`, e);
	}

	const plan = buildDeliveryPlan(artifact, fileSizeBytes, artifactPath);
	const suiteEmbed = buildSuiteEmbed(suiteSummary, failureDetails);
	const findingsEmbed = buildFindingsEmbed(artifact, plan);

	// External-upload path: try paste host first, fall back to inline truncation.
	let externalUrl: string | undefined;
	let finalPlan = plan;
	if (plan.mode === "external-upload") {
		const url = await externalUploader(artifactPath);
		if (url) {
			externalUrl = url;
			findingsEmbed.fields = appendField(findingsEmbed.fields, {
				name: "Full findings",
				value: url,
				inline: false,
			});
		} else {
			// Fallback — paste host down. Inline the top-N failing URLs and an
			// ATTENTION banner so the report is NOT silently lost. Downgrade the
			// delivery mode to "inline" so the POST path below sends a JSON
			// webhook (not a multipart attach, which would require an attachment
			// path we don't have at this size).
			console.warn(
				`[recce-discord] external upload failed; falling back to truncated inline`,
			);
			findingsEmbed.fields = appendField(findingsEmbed.fields, {
				name: "ATTENTION",
				value:
					`findings JSON too large (${(fileSizeBytes / (1024 * 1024)).toFixed(1)} MB) ` +
					`and external upload failed — showing top ${plan.topFailingUrls.length} failing URL(s) only. ` +
					`Full findings remain on disk at ${artifactPath}`,
				inline: false,
			});
			if (plan.topFailingUrls.length > 0) {
				const lines = plan.topFailingUrls.map(
					(s) =>
						`• ${s.url} — ${s.errors}e/${s.warns}w [${Array.from(s.checks).slice(0, 3).join(",")}]`,
				);
				findingsEmbed.fields = appendField(findingsEmbed.fields, {
					name: "Top failing URLs",
					value: lines.join("\n").slice(0, 1024),
					inline: false,
				});
			}
			finalPlan = { ...plan, mode: "inline" };
		}
	}

	const payloadJson = {
		username: "Recce",
		embeds: [suiteEmbed, findingsEmbed],
	};

	try {
		let resp: Response;
		if (finalPlan.mode === "attach" && plan.attachmentPath) {
			const form = new FormData();
			form.append("payload_json", JSON.stringify(payloadJson));
			const buf = readFileSync(plan.attachmentPath);
			const blob = new Blob([new Uint8Array(buf)], {
				type: "application/json",
			});
			form.append("files[0]", blob, path.basename(plan.attachmentPath));
			resp = await fetch(webhookUrl, { method: "POST", body: form });
		} else {
			resp = await fetch(webhookUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payloadJson),
			});
		}

		if (!resp.ok) {
			const reason = `status=${resp.status} ${resp.statusText}`;
			console.error(`[recce-discord] Discord webhook failed: ${reason}`);
			if (escalate) {
				escalateDeliveryFailure(reason, artifactPath);
			}
			return {
				delivered: false,
				mode: finalPlan.mode,
				failureReason: reason,
				externalUrl,
			};
		}

		return {
			delivered: true,
			mode: finalPlan.mode,
			externalUrl,
		};
	} catch (err) {
		const reason = String(err);
		console.error(`[recce-discord] Discord webhook error:`, err);
		if (escalate) {
			escalateDeliveryFailure(reason, artifactPath);
		}
		return {
			delivered: false,
			mode: finalPlan.mode,
			failureReason: reason,
			externalUrl,
		};
	}
}

function appendField(
	fields: Array<{ name: string; value: string; inline: boolean }> | undefined,
	f: { name: string; value: string; inline: boolean },
): Array<{ name: string; value: string; inline: boolean }> {
	const next = fields ? [...fields] : [];
	next.push(f);
	return next;
}

function buildSuiteEmbed(
	summary: DeliverReportOpts["suiteSummary"],
	failures: Array<{ title: string; error?: string }>,
): Record<string, unknown> & {
	fields: Array<{ name: string; value: string; inline: boolean }>;
} {
	const total = summary.passed + summary.failed + summary.skipped;
	const allPassed = summary.failed === 0 && total > 0;
	const statusEmoji = allPassed ? ":white_check_mark:" : ":x:";
	const title = `${statusEmoji} Recce E2E — ${allPassed ? "All Passed" : "FAILURES DETECTED"}`;
	const fields = [
		{ name: "Environment", value: summary.baseURL, inline: true },
		{
			name: "reCAPTCHA",
			value: summary.hasRecaptcha ? "Active" : "Mocked (dev)",
			inline: true,
		},
		{ name: "Duration", value: `${summary.totalDurationSec}s`, inline: true },
		{ name: "Passed", value: `${summary.passed}`, inline: true },
		{ name: "Failed", value: `${summary.failed}`, inline: true },
		{ name: "Skipped", value: `${summary.skipped}`, inline: true },
	];

	if (failures.length > 0) {
		const failureText = failures
			.map(
				(f) => `**${f.title}**\n\`\`\`${f.error || "No error message"}\`\`\``,
			)
			.join("\n");
		fields.push({
			name: "Failures",
			value: failureText.slice(0, 1024),
			inline: false,
		});
	}

	return {
		title,
		color: allPassed ? 0x00ff00 : 0xff0000,
		fields,
		timestamp: new Date().toISOString(),
		footer: { text: "Recce E2E Suite" },
	};
}

function buildFindingsEmbed(
	artifact: FindingsArtifact,
	plan: DeliveryPlan,
): Record<string, unknown> & {
	fields: Array<{ name: string; value: string; inline: boolean }>;
} {
	const counts = artifact.run.findingCounts;
	const color =
		counts.error > 0 ? 0xff0000 : counts.warn > 0 ? 0xffa500 : 0x00ff00;

	const fields: Array<{ name: string; value: string; inline: boolean }> = [
		{ name: "Errors", value: `${counts.error}`, inline: true },
		{ name: "Warnings", value: `${counts.warn}`, inline: true },
		{ name: "Info", value: `${counts.info}`, inline: true },
		{
			name: "Pages crawled",
			value: `${artifact.run.pagesCrawled}`,
			inline: true,
		},
		{
			name: "Rate limited",
			value: `${artifact.run.rateLimited}`,
			inline: true,
		},
		{ name: "Mode", value: artifact.run.mode, inline: true },
	];

	// Inline the top-N failing URLs only when mode == inline. In attach/external
	// the same info is in the JSON or paste URL.
	if (plan.mode === "inline" && plan.topFailingUrls.length > 0) {
		const lines = plan.topFailingUrls.map(
			(s) =>
				`\`${s.errors}e/${s.warns}w\` ${s.url} — ${Array.from(s.checks).join(", ")}`,
		);
		fields.push({
			name: "Top failing URLs",
			value: lines.join("\n").slice(0, 1024),
			inline: false,
		});
	} else if (plan.mode !== "inline" && plan.summaryNote) {
		fields.push({
			name: "Delivery note",
			value: plan.summaryNote,
			inline: false,
		});
	}

	return {
		title: `Recce findings — ${counts.error} error / ${counts.warn} warn / ${counts.info} info`,
		color,
		fields,
		timestamp: artifact.run.finishedAt,
		footer: { text: `Recce ${artifact.run.mode} findings` },
	};
}

function escalateDeliveryFailure(reason: string, findingsPath: string): void {
	const msg = `Recce Discord delivery failed: ${reason} (findings: ${findingsPath})`;
	safeWilcoNotify(msg, {
		level: "error",
		title: "Recce Discord delivery failed",
		logPrefix: "recce-discord",
	});
}

// ---------------------------------------------------------------------------
// Playwright Reporter wrapper
// ---------------------------------------------------------------------------

interface TestOutcome {
	title: string;
	status: string;
	duration: number;
	error?: string;
}

class DiscordReporter implements Reporter {
	private results: TestOutcome[] = [];
	private startTime = 0;

	onBegin(_config: FullConfig, _suite: Suite) {
		this.startTime = Date.now();
	}

	onTestEnd(test: TestCase, result: TestResult) {
		this.results.push({
			title: test.title,
			status: result.status,
			duration: result.duration,
			error:
				result.status === "failed"
					? result.errors.map((e) => e.message?.slice(0, 200)).join("\n")
					: undefined,
		});
	}

	async onEnd(_result: FullResult) {
		if (this.results.length === 0) return;

		const webhookUrl = process.env.RECCE_DISCORD_WEBHOOK;
		if (!webhookUrl) return;

		const totalDuration = ((Date.now() - this.startTime) / 1000).toFixed(1);
		const passed = this.results.filter((r) => r.status === "passed").length;
		const failed = this.results.filter((r) => r.status === "failed").length;
		const skipped = this.results.filter((r) => r.status === "skipped").length;
		const baseURL = process.env.BASE_URL || "https://valors.io";
		const hasRecaptcha = process.env.RECCE_RECAPTCHA !== "false";

		const failureDetails = this.results
			.filter((r) => r.status === "failed")
			.map((r) => ({ title: r.title, error: r.error }));

		const latest = getLatestJsonPath();
		let artifact: FindingsArtifact | null = null;
		if (existsSync(latest)) {
			try {
				const raw = readFileSync(latest, { encoding: "utf8" });
				artifact = JSON.parse(raw) as FindingsArtifact;
			} catch (e) {
				console.error(`[recce-discord] failed to parse ${latest}:`, e);
			}
		}

		// Sentinel: tests ran and passed but no findings artefact → escalate once.
		if (!artifact && passed > 0 && !process.env.RECCE_TEARDOWN_ESCALATED) {
			const msg = `Recce findings-latest.json absent despite ${passed} passing tests`;
			console.error(`[recce-discord] ${msg}`);
			safeWilcoNotify(msg, {
				level: "error",
				title: "Recce findings missing",
				logPrefix: "recce-discord",
			});
		}

		// If no artifact, post a bare suite-summary message rather than skip.
		if (!artifact) {
			const fallback: FindingsArtifact = {
				run: {
					schemaVersion: 1,
					startedAt: new Date(this.startTime).toISOString(),
					finishedAt: new Date().toISOString(),
					mode: (process.env.RECCE_MODE as "pulse" | "audit") || "pulse",
					baseURL,
					pagesCrawled: 0,
					rateLimited: 0,
					findingCounts: { error: 0, warn: 0, info: 0 },
				},
				byUrl: {},
				byCheck: {},
			};
			await deliverReport({
				webhookUrl,
				artifact: fallback,
				artifactPath: latest,
				suiteSummary: {
					passed,
					failed,
					skipped,
					totalDurationSec: totalDuration,
					baseURL,
					hasRecaptcha,
				},
				failureDetails,
			});
			return;
		}

		await deliverReport({
			webhookUrl,
			artifact,
			artifactPath: latest,
			suiteSummary: {
				passed,
				failed,
				skipped,
				totalDurationSec: totalDuration,
				baseURL,
				hasRecaptcha,
			},
			failureDetails,
		});
	}

	// Helper type-only export so findings.ts type import stays happy.
	static _findingType?: Finding;
}

export default DiscordReporter;
