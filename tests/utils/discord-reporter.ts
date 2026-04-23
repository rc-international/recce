import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type {
	FullConfig,
	FullResult,
	Reporter,
	Suite,
	TestCase,
	TestResult,
} from "@playwright/test/reporter";
import { getLatestJsonPath } from "./findings";
import type { FindingsArtifact } from "./types";

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
		const env = process.env.BASE_URL || "https://valors.io";
		const hasRecaptcha = process.env.RECCE_RECAPTCHA !== "false";
		const allPassed = failed === 0 && this.results.length > 0;

		const statusEmoji = allPassed ? ":white_check_mark:" : ":x:";
		const title = `${statusEmoji} Recce E2E — ${allPassed ? "All Passed" : "FAILURES DETECTED"}`;

		const fields: Array<{ name: string; value: string; inline: boolean }> = [
			{ name: "Environment", value: env, inline: true },
			{
				name: "reCAPTCHA",
				value: hasRecaptcha ? "Active" : "Mocked (dev)",
				inline: true,
			},
			{ name: "Duration", value: `${totalDuration}s`, inline: true },
			{ name: "Passed", value: `${passed}`, inline: true },
			{ name: "Failed", value: `${failed}`, inline: true },
			{ name: "Skipped", value: `${skipped}`, inline: true },
		];

		// Add failure details from the Playwright test outcomes.
		const failures = this.results.filter((r) => r.status === "failed");
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

		const embeds: Array<Record<string, unknown>> = [
			{
				title,
				color: allPassed ? 0x00ff00 : 0xff0000,
				fields,
				timestamp: new Date().toISOString(),
				footer: { text: "Recce E2E Suite" },
			},
		];

		// --- Findings-based embed (Phase 1 addition) ---
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

		if (artifact) {
			embeds.push(this.buildFindingsEmbed(artifact));
		} else if (passed > 0 && !process.env.RECCE_TEARDOWN_ESCALATED) {
			// Suspicious: tests ran and passed but no findings artefact exists.
			// global-teardown may have already escalated; only escalate once.
			const msg = `Recce findings-latest.json absent despite ${passed} passing tests`;
			console.error(`[recce-discord] ${msg}`);
			try {
				execSync(
					`wilco-notify --level error --title "Recce findings missing" ${JSON.stringify(msg)}`,
					{ stdio: "ignore" },
				);
			} catch (e) {
				console.error(
					`[recce-discord] wilco-notify escalation failed (likely not installed):`,
					e,
				);
			}
		}

		const payload = {
			username: "Recce",
			embeds,
		};

		try {
			const resp = await fetch(webhookUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			if (!resp.ok) {
				console.error(
					`Discord webhook failed: ${resp.status} ${resp.statusText}`,
				);
				this.escalateDeliveryFailure(
					`status=${resp.status} ${resp.statusText}`,
					latest,
				);
			}
		} catch (err) {
			console.error("Discord webhook error:", err);
			this.escalateDeliveryFailure(String(err), latest);
		}
	}

	private buildFindingsEmbed(
		artifact: FindingsArtifact,
	): Record<string, unknown> {
		const counts = artifact.run.findingCounts;
		const color =
			counts.error > 0 ? 0xff0000 : counts.warn > 0 ? 0xffa500 : 0x00ff00;

		// Top-10 URLs by error count (tie-break on warn count, then total).
		const urlScores: Array<{
			url: string;
			errors: number;
			warns: number;
			checks: Set<string>;
		}> = [];
		for (const [url, findings] of Object.entries(artifact.byUrl)) {
			let errors = 0;
			let warns = 0;
			const checks = new Set<string>();
			for (const f of findings) {
				if (f.severity === "error") errors += 1;
				else if (f.severity === "warn") warns += 1;
				checks.add(f.check);
			}
			urlScores.push({ url, errors, warns, checks });
		}
		urlScores.sort(
			(a, b) =>
				b.errors - a.errors ||
				b.warns - a.warns ||
				b.checks.size - a.checks.size,
		);
		const top = urlScores.filter((s) => s.errors > 0).slice(0, 10);

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

		if (top.length > 0) {
			const lines = top.map(
				(s) =>
					`\`${s.errors}e/${s.warns}w\` ${s.url} — ${Array.from(s.checks).join(", ")}`,
			);
			fields.push({
				name: "Top failing URLs",
				value: lines.join("\n").slice(0, 1024),
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

	private escalateDeliveryFailure(reason: string, findingsPath: string): void {
		const msg = `Recce Discord delivery failed: ${reason} (findings: ${findingsPath})`;
		try {
			execSync(
				`wilco-notify --level error --title "Recce Discord delivery failed" ${JSON.stringify(msg)}`,
				{ stdio: "ignore" },
			);
		} catch (e) {
			console.error(
				`[recce-discord] wilco-notify escalation failed (likely not installed):`,
				e,
			);
		}
	}
}

export default DiscordReporter;
