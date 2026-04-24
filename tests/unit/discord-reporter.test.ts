import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	buildDeliveryPlan,
	classifyDelivery,
	EXTERNAL_UPLOAD_THRESHOLD_BYTES,
	MAX_INLINE_FAILING_URLS,
} from "../utils/discord-reporter";
import type { FindingsArtifact } from "../utils/types";

/**
 * Unit tests for Recce Phase 4 Discord reporter:
 *   - inline vs attach vs external-upload routing by finding count and JSON size
 *   - webhook POST success path and failure path (triggers wilco-notify)
 *
 * We drive the classifier as a pure function (no I/O) so tests are fast and
 * deterministic. A companion live-fire test stands up a Bun.serve webhook
 * listener and asserts the reporter POSTs the expected shape.
 */

function makeArtifact(opts: {
	errors?: number;
	failingUrls?: number;
	mode?: "pulse" | "audit";
}): FindingsArtifact {
	const { errors = 0, failingUrls = 0, mode = "pulse" } = opts;
	const byUrl: Record<string, ReturnType<typeof makeFinding>[]> = {};
	const byCheck: Record<string, ReturnType<typeof makeFinding>[]> = {};
	for (let i = 0; i < failingUrls; i++) {
		const url = `https://valors.io/p/${i}`;
		byUrl[url] = [
			makeFinding({
				url,
				check: "broken-image",
				severity: "error",
				message: `err-${i}`,
			}),
		];
	}
	byCheck["broken-image"] = Object.values(byUrl).flat();
	return {
		run: {
			schemaVersion: 1,
			startedAt: "2026-04-23T00:00:00.000Z",
			finishedAt: "2026-04-23T00:00:10.000Z",
			mode,
			baseURL: "https://valors.io",
			pagesCrawled: 10,
			rateLimited: 0,
			findingCounts: { error: errors, warn: 0, info: 0 },
		},
		byUrl,
		byCheck,
	};
}

function makeFinding(f: {
	url: string;
	check: string;
	severity: "error" | "warn" | "info";
	message: string;
}) {
	return {
		url: f.url,
		check: f.check,
		severity: f.severity,
		message: f.message,
		project: "chromium" as const,
	};
}

describe("discord-reporter: classifyDelivery", () => {
	test("0 findings -> inline mode (green summary)", () => {
		const artifact = makeArtifact({ errors: 0, failingUrls: 0 });
		const plan = classifyDelivery(artifact, 0);
		expect(plan.mode).toBe("inline");
		expect(plan.failingUrlCount).toBe(0);
	});

	test("5 failing URLs -> inline", () => {
		const artifact = makeArtifact({ errors: 5, failingUrls: 5 });
		const plan = classifyDelivery(artifact, 1024);
		expect(plan.mode).toBe("inline");
		expect(plan.failingUrlCount).toBe(5);
	});

	test("10 failing URLs -> still inline (boundary)", () => {
		const artifact = makeArtifact({ errors: 10, failingUrls: 10 });
		const plan = classifyDelivery(artifact, 1024);
		expect(plan.mode).toBe("inline");
	});

	test("11 failing URLs -> attach (file under threshold)", () => {
		const artifact = makeArtifact({ errors: 11, failingUrls: 11 });
		const plan = classifyDelivery(artifact, 1024);
		expect(plan.mode).toBe("attach");
	});

	test("15 failing URLs -> attach (> 10 threshold)", () => {
		const artifact = makeArtifact({ errors: 15, failingUrls: 15 });
		const plan = classifyDelivery(artifact, 100_000);
		expect(plan.mode).toBe("attach");
	});

	test("15 failing URLs + file > 7.5 MB -> external-upload", () => {
		const artifact = makeArtifact({ errors: 15, failingUrls: 15 });
		const plan = classifyDelivery(
			artifact,
			EXTERNAL_UPLOAD_THRESHOLD_BYTES + 1,
		);
		expect(plan.mode).toBe("external-upload");
	});

	test("5 failing URLs + huge file -> external-upload still wins over inline", () => {
		// If the file is enormous we never inline — external is the only safe path.
		const artifact = makeArtifact({ errors: 5, failingUrls: 5 });
		const plan = classifyDelivery(
			artifact,
			EXTERNAL_UPLOAD_THRESHOLD_BYTES + 1,
		);
		expect(plan.mode).toBe("external-upload");
	});
});

describe("discord-reporter: constants", () => {
	test("inline threshold is 10", () => {
		expect(MAX_INLINE_FAILING_URLS).toBe(10);
	});

	test("external-upload threshold is 7.5 MB", () => {
		expect(EXTERNAL_UPLOAD_THRESHOLD_BYTES).toBe(7.5 * 1024 * 1024);
	});
});

describe("discord-reporter: buildDeliveryPlan", () => {
	test("inline plan includes top-N URLs and no attachment", () => {
		const artifact = makeArtifact({ errors: 3, failingUrls: 3 });
		const plan = buildDeliveryPlan(artifact, 1024);
		expect(plan.mode).toBe("inline");
		expect(plan.topFailingUrls.length).toBe(3);
		expect(plan.attachmentPath).toBeUndefined();
	});

	test("attach plan includes attachmentPath and full count note", () => {
		const artifact = makeArtifact({ errors: 15, failingUrls: 15 });
		const plan = buildDeliveryPlan(artifact, 100_000, "/tmp/findings.json");
		expect(plan.mode).toBe("attach");
		expect(plan.attachmentPath).toBe("/tmp/findings.json");
		expect(plan.summaryNote).toContain("15");
	});

	test("external plan carries file size in MB in the note", () => {
		const artifact = makeArtifact({ errors: 15, failingUrls: 15 });
		const bytes = 8 * 1024 * 1024;
		const plan = buildDeliveryPlan(artifact, bytes, "/tmp/findings.json");
		expect(plan.mode).toBe("external-upload");
		// Should indicate size approximately
		expect(plan.summaryNote).toMatch(/8(\.0)? MB/);
	});
});

// ---------------------------------------------------------------------------
// Live-fire: mock Discord webhook server + real reporter POST
// ---------------------------------------------------------------------------

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let workDir: string;
let savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
	"RECCE_DISCORD_WEBHOOK",
	"RECCE_MODE",
	"RECCE_RUN_TS",
	"BASE_URL",
] as const;

function snapshotEnv() {
	savedEnv = {};
	for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
}
function restoreEnv() {
	for (const k of ENV_KEYS) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
}

beforeEach(() => {
	snapshotEnv();
	workDir = mkdtempSync(path.join(tmpdir(), "recce-discord-"));
	mkdirSync(path.join(workDir, "test-results", "findings"), {
		recursive: true,
	});
});

afterEach(() => {
	restoreEnv();
	try {
		rmSync(workDir, { recursive: true, force: true });
	} catch (e) {
		console.debug(`[discord-reporter.test] rm ${workDir} failed:`, e);
	}
});

describe("discord-reporter: live-fire webhook POST", () => {
	test("inline mode POSTs JSON payload to mock webhook", async () => {
		const received: Array<{
			contentType: string | null;
			bodySize: number;
			hasEmbed: boolean;
		}> = [];
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				const ct = req.headers.get("content-type");
				const bodyBuf = await req.arrayBuffer();
				let hasEmbed = false;
				if (ct?.includes("application/json")) {
					try {
						const j = JSON.parse(new TextDecoder().decode(bodyBuf));
						hasEmbed = Array.isArray(j.embeds) && j.embeds.length > 0;
					} catch (e) {
						console.debug(`[test] parse webhook body failed:`, e);
					}
				}
				received.push({
					contentType: ct,
					bodySize: bodyBuf.byteLength,
					hasEmbed,
				});
				return new Response("{}", { status: 200 });
			},
		});

		try {
			const webhook = `http://127.0.0.1:${server.port}/webhook`;
			process.env.RECCE_DISCORD_WEBHOOK = webhook;
			process.env.BASE_URL = "https://valors.io";

			const artifact = makeArtifact({ errors: 3, failingUrls: 3 });
			const artifactPath = path.join(
				workDir,
				"test-results",
				"findings",
				"findings-latest.json",
			);
			writeFileSync(artifactPath, JSON.stringify(artifact), "utf8");

			// Import the reporter's raw delivery function
			const { deliverReport } = await import("../utils/discord-reporter");
			const result = await deliverReport({
				webhookUrl: webhook,
				artifact,
				artifactPath,
				suiteSummary: {
					passed: 10,
					failed: 0,
					skipped: 0,
					totalDurationSec: "5.0",
					baseURL: "https://valors.io",
					hasRecaptcha: true,
				},
				failureDetails: [],
			});
			expect(result.delivered).toBe(true);
			expect(result.mode).toBe("inline");
			expect(received).toHaveLength(1);
			expect(received[0].contentType).toContain("application/json");
			expect(received[0].hasEmbed).toBe(true);
		} finally {
			server.stop(true);
		}
	});

	test("attach mode POSTs multipart body with file", async () => {
		const received: Array<{ contentType: string | null; bodySize: number }> =
			[];
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				const ct = req.headers.get("content-type");
				const bodyBuf = await req.arrayBuffer();
				received.push({ contentType: ct, bodySize: bodyBuf.byteLength });
				return new Response("{}", { status: 200 });
			},
		});

		try {
			const webhook = `http://127.0.0.1:${server.port}/webhook`;
			process.env.RECCE_DISCORD_WEBHOOK = webhook;
			process.env.BASE_URL = "https://valors.io";

			const artifact = makeArtifact({ errors: 15, failingUrls: 15 });
			const artifactPath = path.join(
				workDir,
				"test-results",
				"findings",
				"findings-latest.json",
			);
			writeFileSync(artifactPath, JSON.stringify(artifact), "utf8");

			const { deliverReport } = await import("../utils/discord-reporter");
			const result = await deliverReport({
				webhookUrl: webhook,
				artifact,
				artifactPath,
				suiteSummary: {
					passed: 10,
					failed: 15,
					skipped: 0,
					totalDurationSec: "5.0",
					baseURL: "https://valors.io",
					hasRecaptcha: true,
				},
				failureDetails: [],
			});
			expect(result.delivered).toBe(true);
			expect(result.mode).toBe("attach");
			expect(received).toHaveLength(1);
			expect(received[0].contentType).toContain("multipart/form-data");
		} finally {
			server.stop(true);
		}
	});

	test("external-upload path is taken for > 7.5 MB file", async () => {
		const received: Array<{ contentType: string | null }> = [];
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				const ct = req.headers.get("content-type");
				await req.arrayBuffer();
				received.push({ contentType: ct });
				return new Response("{}", { status: 200 });
			},
		});

		try {
			const webhook = `http://127.0.0.1:${server.port}/webhook`;
			process.env.RECCE_DISCORD_WEBHOOK = webhook;
			process.env.BASE_URL = "https://valors.io";

			const artifact = makeArtifact({ errors: 15, failingUrls: 15 });
			const artifactPath = path.join(
				workDir,
				"test-results",
				"findings",
				"findings-latest.json",
			);
			// Write a >7.5 MB file to force external-upload path.
			const padding = "x".repeat(EXTERNAL_UPLOAD_THRESHOLD_BYTES + 1024);
			const fatArtifact = { ...artifact, _padding: padding };
			writeFileSync(artifactPath, JSON.stringify(fatArtifact), "utf8");

			const { deliverReport } = await import("../utils/discord-reporter");
			// Mock external upload: we inject a stub uploader so the test does
			// not actually hit 0x0.st from CI.
			const result = await deliverReport({
				webhookUrl: webhook,
				artifact,
				artifactPath,
				suiteSummary: {
					passed: 10,
					failed: 15,
					skipped: 0,
					totalDurationSec: "5.0",
					baseURL: "https://valors.io",
					hasRecaptcha: true,
				},
				failureDetails: [],
				externalUploader: async (_p: string) => "https://0x0.st/fake-stub-id",
			});
			expect(result.delivered).toBe(true);
			expect(result.mode).toBe("external-upload");
			expect(result.externalUrl).toBe("https://0x0.st/fake-stub-id");
			// Webhook should still have received a JSON body (the summary embed)
			expect(received).toHaveLength(1);
			expect(received[0].contentType).toContain("application/json");
		} finally {
			server.stop(true);
		}
	});

	test("external-upload fallback — when paste host fails, downgrade to inline with top-N URLs", async () => {
		// Regression guard. Prior version:
		//   - set finalPlan.mode = "external-upload" after paste host failure,
		//     which caused the multipart/attach branch to attempt upload of a
		//     file we already said was too large;
		//   - never appended the top-N failing URLs, so on paste-host outage
		//     the Discord report carried ONLY the ATTENTION banner with no
		//     actionable URL list — the exact silent-failure the reporter was
		//     designed to prevent.
		//
		// New semantics: paste-host null → downgrade to "inline" mode +
		// ATTENTION banner + top-N URL list embedded in the JSON payload.
		const received: Array<{ body: string; contentType: string | null }> = [];
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				const ct = req.headers.get("content-type");
				const body = await req.text();
				received.push({ body, contentType: ct });
				return new Response("{}", { status: 200 });
			},
		});
		try {
			const webhook = `http://127.0.0.1:${server.port}/webhook`;
			process.env.RECCE_DISCORD_WEBHOOK = webhook;
			process.env.BASE_URL = "https://valors.io";

			const artifact = makeArtifact({ errors: 15, failingUrls: 15 });
			const artifactPath = path.join(
				workDir,
				"test-results",
				"findings",
				"findings-latest.json",
			);
			const padding = "x".repeat(EXTERNAL_UPLOAD_THRESHOLD_BYTES + 1024);
			const fatArtifact = { ...artifact, _padding: padding };
			writeFileSync(artifactPath, JSON.stringify(fatArtifact), "utf8");

			const { deliverReport } = await import("../utils/discord-reporter");
			const result = await deliverReport({
				webhookUrl: webhook,
				artifact,
				artifactPath,
				suiteSummary: {
					passed: 10,
					failed: 15,
					skipped: 0,
					totalDurationSec: "5.0",
					baseURL: "https://valors.io",
					hasRecaptcha: true,
				},
				failureDetails: [],
				// Simulate paste host outage — uploader returns null.
				externalUploader: async (_p: string) => null,
				escalate: false,
			});
			expect(result.delivered).toBe(true);
			// Downgraded from external-upload → inline so the JSON payload flows.
			expect(result.mode).toBe("inline");
			expect(received).toHaveLength(1);
			expect(received[0].contentType).toContain("application/json");
			// Verify the embed carries BOTH the ATTENTION banner AND the top
			// URL list. Without the list, ops sees only "upload failed" — the
			// silent-report regression we're guarding against.
			const payload = JSON.parse(received[0].body);
			const findingsEmbed = payload.embeds[1];
			const fieldNames = (findingsEmbed.fields ?? []).map(
				(f: { name: string }) => f.name,
			);
			expect(fieldNames).toContain("ATTENTION");
			expect(fieldNames).toContain("Top failing URLs");
			const topField = findingsEmbed.fields.find(
				(f: { name: string }) => f.name === "Top failing URLs",
			);
			// First failing URL must appear in the rendered list.
			expect(topField.value).toContain("https://valors.io/p/0");
		} finally {
			server.stop(true);
		}
	});

	test("webhook 500 triggers delivered=false and escalation reason", async () => {
		const server = Bun.serve({
			port: 0,
			fetch() {
				return new Response("boom", { status: 500 });
			},
		});
		try {
			const webhook = `http://127.0.0.1:${server.port}/webhook`;
			process.env.RECCE_DISCORD_WEBHOOK = webhook;
			process.env.BASE_URL = "https://valors.io";

			const artifact = makeArtifact({ errors: 3, failingUrls: 3 });
			const artifactPath = path.join(
				workDir,
				"test-results",
				"findings",
				"findings-latest.json",
			);
			writeFileSync(artifactPath, JSON.stringify(artifact), "utf8");

			const { deliverReport } = await import("../utils/discord-reporter");
			const result = await deliverReport({
				webhookUrl: webhook,
				artifact,
				artifactPath,
				suiteSummary: {
					passed: 10,
					failed: 0,
					skipped: 0,
					totalDurationSec: "5.0",
					baseURL: "https://valors.io",
					hasRecaptcha: true,
				},
				failureDetails: [],
				// Skip wilco-notify side-effect from tests
				escalate: false,
			});
			expect(result.delivered).toBe(false);
			expect(result.failureReason).toContain("500");
		} finally {
			server.stop(true);
		}
	});
});
