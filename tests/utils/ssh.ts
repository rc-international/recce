import { readFileSync } from "node:fs";
import { Client } from "ssh2";

interface SSHConfig {
	host: string;
	port: number;
	username: string;
	privateKeyPath: string;
}

const REQUIRED_ENV_VARS = [
	"RECCE_SSH_HOST",
	"RECCE_SSH_PORT",
	"RECCE_SSH_USER",
	"RECCE_SSH_KEY_PATH",
] as const;

/**
 * Build the SSH config strictly from environment variables.
 * Throws when any required variable is missing — we never carry hardcoded
 * production hosts/users/keypaths in source.
 *
 * Required env vars: RECCE_SSH_HOST, RECCE_SSH_PORT, RECCE_SSH_USER,
 * RECCE_SSH_KEY_PATH.
 *
 * Exported for unit tests; production callers go through verifyLeadReceipt.
 */
export function getSSHConfig(): SSHConfig {
	const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
	if (missing.length > 0) {
		throw new Error(
			`Missing required SSH env vars: ${missing.join(", ")}. ` +
				`Set RECCE_SSH_HOST, RECCE_SSH_PORT, RECCE_SSH_USER, RECCE_SSH_KEY_PATH ` +
				`before invoking SSH-based lead receipt verification.`,
		);
	}

	const portRaw = process.env.RECCE_SSH_PORT as string;
	const port = Number.parseInt(portRaw, 10);
	if (!Number.isFinite(port) || port <= 0 || port > 65535) {
		throw new Error(
			`RECCE_SSH_PORT must be a valid TCP port (1-65535); got "${portRaw}".`,
		);
	}

	return {
		host: process.env.RECCE_SSH_HOST as string,
		port,
		username: process.env.RECCE_SSH_USER as string,
		privateKeyPath: process.env.RECCE_SSH_KEY_PATH as string,
	};
}

// Strict allowlist for the email used inside the remote shell command.
// We never want to pass arbitrary characters into `grep -l '<email>'` — quotes,
// backticks, $(), ;, &, |, newlines, etc. could all break out of the literal.
// The local-part allows the conservative subset of RFC 5321 that we actually use;
// reject anything outside it before constructing the command.
const SAFE_EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export async function verifyLeadReceipt(email: string): Promise<boolean> {
	if (!SAFE_EMAIL_RE.test(email)) {
		throw new Error(
			`verifyLeadReceipt: email "${email}" contains characters outside the ` +
				`allowed set [A-Za-z0-9._%+-@]; refusing to build remote shell command.`,
		);
	}

	const config = getSSHConfig();
	const privateKey = readFileSync(config.privateKeyPath);

	return new Promise((resolve, reject) => {
		const client = new Client();

		const timeout = setTimeout(() => {
			client.end();
			reject(new Error("SSH connection timed out after 10s"));
		}, 10000);

		client
			.on("ready", () => {
				// Email is validated by SAFE_EMAIL_RE above, so direct interpolation
				// inside single quotes is safe — the regex forbids the only character
				// (single-quote) that could close the literal.
				const cmd =
					`find /var/lib/lead-details-api/leads/portal -name '*.json' ` +
					`-mmin -5 -exec grep -l '${email}' {} \\; 2>/dev/null | head -1`;

				client.exec(cmd, (err, stream) => {
					if (err) {
						clearTimeout(timeout);
						client.end();
						reject(err);
						return;
					}

					let output = "";
					stream
						.on("data", (data: Buffer) => {
							output += data.toString();
						})
						.on("close", () => {
							clearTimeout(timeout);
							client.end();
							resolve(output.trim().length > 0);
						});
				});
			})
			.on("error", (err) => {
				clearTimeout(timeout);
				reject(err);
			})
			.connect({
				host: config.host,
				port: config.port,
				username: config.username,
				privateKey,
			});
	});
}
