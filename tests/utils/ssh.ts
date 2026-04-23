import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Client } from "ssh2";

interface SSHConfig {
	host: string;
	port: number;
	username: string;
	privateKeyPath: string;
}

function getSSHConfig(): SSHConfig {
	return {
		host: process.env.RECCE_SSH_HOST || "5.161.192.171",
		port: parseInt(process.env.RECCE_SSH_PORT || "333", 10),
		username: process.env.RECCE_SSH_USER || "kernelgnome",
		privateKeyPath:
			process.env.RECCE_SSH_KEY_PATH || `${homedir()}/.ssh/www_vps_key`,
	};
}

export async function verifyLeadReceipt(email: string): Promise<boolean> {
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
