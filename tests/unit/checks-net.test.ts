import { describe, expect, test } from "bun:test";
import type { APIRequestContext } from "@playwright/test";
import { headOrGet } from "../utils/checks/net";

/**
 * Unit tests for tests/utils/checks/net.ts — the shared HEAD-then-GET
 * fallback helper used by checkLinks, checkImages, and checkSeo.
 *
 * Two invariants matter for downstream consumers:
 *   1. cacheKey and fetchUrl are SEPARATE — callers dedup on a normalized
 *      key but the network hit must use the original URL. Regression-guarded
 *      here because a prior images.ts bug fetched the stripped key, causing
 *      spurious 403/404 findings on perfectly reachable CDN transform URLs.
 *   2. HEAD → GET fallback triggers on 403, 405, AND 501 (not just the
 *      original 405/501) — CDNs like Cloudinary refuse HEAD on transforms
 *      with 403.
 */

interface Call {
	method: "HEAD" | "GET";
	url: string;
}

function makeCtx(responses: Record<string, { head?: number; get?: number }>): {
	ctx: APIRequestContext;
	calls: Call[];
} {
	const calls: Call[] = [];
	const ctx = {
		head: async (url: string) => {
			calls.push({ method: "HEAD", url });
			const r = responses[url];
			if (!r || r.head === undefined)
				throw new Error(`no mock HEAD for ${url}`);
			return { status: () => r.head as number };
		},
		get: async (url: string) => {
			calls.push({ method: "GET", url });
			const r = responses[url];
			if (!r || r.get === undefined) throw new Error(`no mock GET for ${url}`);
			return { status: () => r.get as number };
		},
	} as unknown as APIRequestContext;
	return { ctx, calls };
}

describe("headOrGet — cache vs fetch URL separation", () => {
	test("fetches fetchUrl, caches under cacheKey", async () => {
		const { ctx, calls } = makeCtx({
			"https://cdn.example.com/img.jpg?w=800": { head: 200 },
		});
		const cache = new Map<string, number>();
		const status = await headOrGet(
			ctx,
			"https://cdn.example.com/img.jpg?w=800", // fetchUrl keeps query string
			"https://cdn.example.com/img.jpg", // cacheKey strips query (CDN-norm)
			cache,
		);
		expect(status).toBe(200);
		expect(calls).toEqual([
			{ method: "HEAD", url: "https://cdn.example.com/img.jpg?w=800" },
		]);
		expect(cache.get("https://cdn.example.com/img.jpg")).toBe(200);
		expect(cache.has("https://cdn.example.com/img.jpg?w=800")).toBe(false);
	});

	test("cache hit short-circuits network — no calls made", async () => {
		const { ctx, calls } = makeCtx({});
		const cache = new Map<string, number>([["key", 429]]);
		const status = await headOrGet(ctx, "unused-fetch-url", "key", cache);
		expect(status).toBe(429);
		expect(calls).toHaveLength(0);
	});
});

describe("headOrGet — GET fallback", () => {
	test("HEAD 405 → GET fallback", async () => {
		const { ctx, calls } = makeCtx({
			"https://a.test/x": { head: 405, get: 200 },
		});
		const cache = new Map<string, number>();
		const status = await headOrGet(
			ctx,
			"https://a.test/x",
			"https://a.test/x",
			cache,
		);
		expect(status).toBe(200);
		expect(calls).toEqual([
			{ method: "HEAD", url: "https://a.test/x" },
			{ method: "GET", url: "https://a.test/x" },
		]);
	});

	test("HEAD 501 → GET fallback", async () => {
		const { ctx, calls } = makeCtx({
			"https://b.test/x": { head: 501, get: 200 },
		});
		const cache = new Map<string, number>();
		const status = await headOrGet(
			ctx,
			"https://b.test/x",
			"https://b.test/x",
			cache,
		);
		expect(status).toBe(200);
		expect(calls.map((c) => c.method)).toEqual(["HEAD", "GET"]);
	});

	test("HEAD 403 → GET fallback (CDN transform URL semantic)", async () => {
		// Regression guard — without this, checkImages would emit spurious
		// broken-image findings for every Cloudinary/Sanity transform URL.
		const { ctx, calls } = makeCtx({
			"https://cdn.example.com/t.jpg?w=400": { head: 403, get: 200 },
		});
		const cache = new Map<string, number>();
		const status = await headOrGet(
			ctx,
			"https://cdn.example.com/t.jpg?w=400",
			"https://cdn.example.com/t.jpg",
			cache,
		);
		expect(status).toBe(200);
		expect(calls.map((c) => c.method)).toEqual(["HEAD", "GET"]);
	});

	test("HEAD throws → GET fallback", async () => {
		const calls: Call[] = [];
		const ctx = {
			head: async (url: string) => {
				calls.push({ method: "HEAD", url });
				throw new Error("network");
			},
			get: async (url: string) => {
				calls.push({ method: "GET", url });
				return { status: () => 200 };
			},
		} as unknown as APIRequestContext;
		const cache = new Map<string, number>();
		const status = await headOrGet(
			ctx,
			"https://c.test/x",
			"https://c.test/x",
			cache,
		);
		expect(status).toBe(200);
		expect(calls.map((c) => c.method)).toEqual(["HEAD", "GET"]);
	});

	test("HEAD 200 → no GET fallback (single round-trip)", async () => {
		const { ctx, calls } = makeCtx({
			"https://d.test/x": { head: 200 },
		});
		const cache = new Map<string, number>();
		const status = await headOrGet(
			ctx,
			"https://d.test/x",
			"https://d.test/x",
			cache,
		);
		expect(status).toBe(200);
		expect(calls).toHaveLength(1);
		expect(calls[0].method).toBe("HEAD");
	});

	test("HEAD 404 → no GET fallback (404 is NOT retried)", async () => {
		// 404 is an explicit "gone" signal; retrying with GET would double
		// per-request cost for every dead link on a 404-heavy crawl.
		const { ctx, calls } = makeCtx({
			"https://e.test/x": { head: 404 },
		});
		const cache = new Map<string, number>();
		const status = await headOrGet(
			ctx,
			"https://e.test/x",
			"https://e.test/x",
			cache,
		);
		expect(status).toBe(404);
		expect(calls).toHaveLength(1);
	});

	test("HEAD throws AND GET throws → status 0 (caller decides severity)", async () => {
		const ctx = {
			head: async () => {
				throw new Error("head-fail");
			},
			get: async () => {
				throw new Error("get-fail");
			},
		} as unknown as APIRequestContext;
		const cache = new Map<string, number>();
		const status = await headOrGet(
			ctx,
			"https://f.test/x",
			"https://f.test/x",
			cache,
		);
		expect(status).toBe(0);
		expect(cache.get("https://f.test/x")).toBe(0);
	});
});
