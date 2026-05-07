import { describe, expect, test } from "bun:test";
import { buildNotifyArgv, safeWilcoNotify } from "../utils/wilco-notify";

/**
 * Regression tests for the shell-injection class of bugs in the old
 * `execSync(\`wilco-notify ... "${msg}"\`)` sites.
 *
 * The concrete vulnerability we're guarding against: a hostile upstream
 * serving a crafted `Content-Type` header, sitemap entry, or page title
 * could inject backticks, `$(...)` subshells, or unbalanced quotes and the
 * old code would execute them as part of the shell command string.
 *
 * Invariant we assert: `buildNotifyArgv` returns an array of strings that
 * will be passed to `execFileSync` argv-by-argv (no shell parse), so every
 * message character is preserved verbatim. `execFileSync` with an argv
 * array never re-parses — Node passes the strings to execvp() as a char*[].
 *
 * We don't exec the stub in-test because Bun's `execFileSync` does not
 * re-resolve PATH from mutated `process.env.PATH` unless `env` is passed
 * explicitly (observed 2026-04-24), which makes a PATH-shadowing stub
 * approach flaky. Asserting the argv shape is sufficient: if the argv
 * carries the exact hostile payload as its own element, Node/libuv cannot
 * shell-expand it.
 */

describe("buildNotifyArgv — argv shape resists shell injection", () => {
	test("double-quoted payload lands as a single argv element", () => {
		const hostile = `before"; echo PWNED; echo "after`;
		const argv = buildNotifyArgv(hostile, {
			level: "error",
			title: "t",
		});
		expect(argv).toEqual(["--level", "error", "--title", "t", hostile]);
		// Crucially, "PWNED" is NOT its own argv entry — it's part of the
		// message string, so execvp() will never treat it as a command.
		expect(argv.filter((a) => a === "PWNED")).toHaveLength(0);
	});

	test("backtick payload stays in-element (no command substitution possible)", () => {
		const hostile = "before `id` after";
		const argv = buildNotifyArgv(hostile, { level: "warning" });
		expect(argv).toEqual(["--level", "warning", hostile]);
		expect(argv[argv.length - 1]).toContain("`id`");
	});

	test("$(...) payload stays in-element (no subshell possible)", () => {
		const hostile = "boom $(whoami) boom";
		const argv = buildNotifyArgv(hostile, { level: "error" });
		expect(argv[argv.length - 1]).toBe(hostile);
		expect(argv[argv.length - 1]).toContain("$(whoami)");
	});

	test("newlines in payload are preserved, not terminators", () => {
		const hostile = "line1\nline2; touch /tmp/SHOULD-NOT-EXIST";
		const argv = buildNotifyArgv(hostile, { level: "info" });
		expect(argv[argv.length - 1]).toBe(hostile);
		// If the old code had interpolated this into a shell string, the
		// `line2; touch ...` would run as a separate command.
		expect(argv.filter((a) => a.startsWith("touch "))).toHaveLength(0);
	});

	test("level + optional title + message in canonical order", () => {
		expect(buildNotifyArgv("m", { level: "info" })).toEqual([
			"--level",
			"info",
			"m",
		]);
		expect(buildNotifyArgv("m", { level: "error", title: "T" })).toEqual([
			"--level",
			"error",
			"--title",
			"T",
			"m",
		]);
	});
});

describe("safeWilcoNotify — never throws", () => {
	test("survives missing wilco-notify binary (ENOENT)", () => {
		const savedPath = process.env.PATH;
		try {
			process.env.PATH = "/nonexistent";
			expect(() =>
				safeWilcoNotify("ping", { level: "info", logPrefix: "test" }),
			).not.toThrow();
		} finally {
			process.env.PATH = savedPath;
		}
	});
});
