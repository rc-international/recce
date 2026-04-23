import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getSSHConfig } from "../utils/ssh";

const ENV_KEYS = [
	"RECCE_SSH_HOST",
	"RECCE_SSH_PORT",
	"RECCE_SSH_USER",
	"RECCE_SSH_KEY_PATH",
] as const;

describe("getSSHConfig", () => {
	let saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		// Snapshot then clear so each test starts from a known-empty env.
		saved = {};
		for (const k of ENV_KEYS) {
			saved[k] = process.env[k];
			delete process.env[k];
		}
	});

	afterEach(() => {
		for (const k of ENV_KEYS) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});

	test("throws when all SSH env vars are missing", () => {
		expect(() => getSSHConfig()).toThrow(/Missing required SSH env vars/);
	});

	test("throws and lists every missing var", () => {
		process.env.RECCE_SSH_HOST = "example.test";
		process.env.RECCE_SSH_PORT = "22";
		// USER and KEY_PATH still missing
		expect(() => getSSHConfig()).toThrow(
			/RECCE_SSH_USER.*RECCE_SSH_KEY_PATH|RECCE_SSH_KEY_PATH.*RECCE_SSH_USER/,
		);
	});

	test("rejects non-numeric port", () => {
		process.env.RECCE_SSH_HOST = "example.test";
		process.env.RECCE_SSH_PORT = "not-a-port";
		process.env.RECCE_SSH_USER = "user";
		process.env.RECCE_SSH_KEY_PATH = "/tmp/key";
		expect(() => getSSHConfig()).toThrow(/valid TCP port/);
	});

	test("rejects out-of-range port", () => {
		process.env.RECCE_SSH_HOST = "example.test";
		process.env.RECCE_SSH_PORT = "99999";
		process.env.RECCE_SSH_USER = "user";
		process.env.RECCE_SSH_KEY_PATH = "/tmp/key";
		expect(() => getSSHConfig()).toThrow(/valid TCP port/);
	});

	test("returns a populated config when all env vars are set", () => {
		process.env.RECCE_SSH_HOST = "ssh.example.test";
		process.env.RECCE_SSH_PORT = "2222";
		process.env.RECCE_SSH_USER = "ci-bot";
		process.env.RECCE_SSH_KEY_PATH = "/tmp/example-key";

		const cfg = getSSHConfig();
		expect(cfg).toEqual({
			host: "ssh.example.test",
			port: 2222,
			username: "ci-bot",
			privateKeyPath: "/tmp/example-key",
		});
	});
});
