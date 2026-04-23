/**
 * Recce findings schema.
 *
 * CHANGELOG / SCHEMA VERSION POLICY
 * ---------------------------------
 * Bump `schemaVersion` only on BREAKING changes:
 *   - field removal
 *   - field type change
 *   - field rename
 *
 * ADDITIVE changes (adding a new OPTIONAL field) keep the version.
 * Every version bump must receive a dated entry below with migration notes.
 *
 * v1 (2026-04-23): Initial schema.
 *   - Finding { url, check, severity, message, element?, expected?, actual?, project }
 *   - Run { schemaVersion, startedAt, finishedAt, mode, baseURL, pagesCrawled,
 *            rateLimited, findingCounts }
 *   - FindingsArtifact { run, byUrl, byCheck }
 */

export type Severity = "error" | "warn" | "info";

export type Finding = {
	url: string;
	check: string;
	severity: Severity;
	message: string;
	element?: {
		tag: string;
		selector?: string;
		attr?: Record<string, string>;
	};
	expected?: string;
	actual?: string;
	project: "chromium" | "Mobile Chrome" | "webkit";
};

export type Run = {
	schemaVersion: 1;
	startedAt: string;
	finishedAt: string;
	mode: "pulse" | "audit";
	baseURL: string;
	pagesCrawled: number;
	rateLimited: number;
	findingCounts: { error: number; warn: number; info: number };
};

export type FindingsArtifact = {
	run: Run;
	byUrl: Record<string, Finding[]>;
	byCheck: Record<string, Finding[]>;
};
