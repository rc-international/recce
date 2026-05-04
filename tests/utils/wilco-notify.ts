import { execFileSync } from "node:child_process";

/**
 * Safe `wilco-notify` wrapper.
 *
 * Prior versions of the Recce codebase invoked `wilco-notify` via
 * `execSync(\`wilco-notify ... "${msg}"\`)` with only a naive quote-replacement
 * on the message. That was exploitable: a hostile upstream response with a
 * carefully crafted `Content-Type` header or sitemap URL could inject backticks
 * or `$(...)` subshells and execute arbitrary commands on the cron host
 * running the test suite.
 *
 * This helper uses `execFileSync` with argv (not a shell-parsed string) so no
 * interpretation happens: every argument is passed verbatim.
 *
 * All callers must go through this helper — direct `execSync`/`spawnSync` with
 * shell-parsed command strings are banned for this CLI.
 */

export type NotifyLevel = "info" | "warning" | "error";

export interface NotifyOptions {
	level: NotifyLevel;
	title?: string;
	/**
	 * Context prefix used in console.debug/error log lines when wilco-notify is
	 * unavailable. Keep short (e.g. "recce-crawler", "recce-discord").
	 */
	logPrefix?: string;
}

/**
 * Build the argv array that will be passed verbatim to `wilco-notify`.
 *
 * Exported separately so unit tests can assert the argv shape (the property
 * that actually matters for shell-injection resistance: the caller must NEVER
 * build a shell-parsed command string). Tests skip the actual exec — under
 * Bun, `execFileSync` does not re-resolve PATH from mutated `process.env`
 * unless an explicit `env` is passed, which makes the stub approach flaky.
 */
export function buildNotifyArgv(
	message: string,
	opts: NotifyOptions,
): string[] {
	const args: string[] = ["--level", opts.level];
	if (opts.title) args.push("--title", opts.title);
	args.push(message);
	return args;
}

/**
 * Fire-and-forget escalation. On failure (wilco-notify missing on CI, non-zero
 * exit, etc.) logs at `console.debug` — per /home/gordon/wilco/rules/
 * error-handling.md silent failure is worse than noisy logs.
 *
 * Never throws. Caller continues regardless.
 */
export function safeWilcoNotify(message: string, opts: NotifyOptions): void {
	const args = buildNotifyArgv(message, opts);
	const prefix = opts.logPrefix ?? "recce";
	try {
		// Pass env explicitly so execFileSync resolves `wilco-notify` from the
		// CURRENT `process.env.PATH` (Bun's execFileSync uses a cached PATH
		// otherwise — observed 2026-04-24). This matters for the unit test
		// that simulates wilco-notify being absent by setting PATH to
		// /nonexistent; without this, PATH mutation is silently ignored and
		// the test's "survives ENOENT" assertion is never actually exercised.
		execFileSync("wilco-notify", args, {
			stdio: "ignore",
			env: process.env,
		});
	} catch (e) {
		console.debug(
			`[${prefix}] wilco-notify escalation failed (likely not installed):`,
			e,
		);
	}
}
