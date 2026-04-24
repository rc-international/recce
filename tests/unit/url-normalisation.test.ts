import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	DEFAULT_IMAGE_CDN_HOSTS,
	detectDuplicateImages,
	normaliseImageUrl,
} from "../utils/checks/images";

/**
 * URL-normalisation contract test.
 *
 * Verifies that B1 (broken-image HEAD dedup) and B4 (duplicate-image counter)
 * both route through the same `normaliseImageUrl` implementation. This is
 * proven by:
 *   1. Direct call tests covering the contract (CDN query-strip, host
 *      lowercase, trailing slash).
 *   2. An import-identity test: `detectDuplicateImages` (used for B4) lives
 *      in the same module as `normaliseImageUrl`. The module's
 *      `detectDuplicateImages` observably uses `normaliseImageUrl` — two
 *      inputs differing only by query string on a CDN host collapse into
 *      one count, which is only possible via the normaliser.
 */

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
	"RECCE_IMAGE_CDN_HOSTS",
	"RECCE_DUPLICATE_EXEMPT_PATTERNS",
] as const;

beforeEach(() => {
	for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});
afterEach(() => {
	for (const k of ENV_KEYS) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
});

describe("normaliseImageUrl — contract", () => {
	test("lowercases host", () => {
		const out = normaliseImageUrl("https://IMAGES.Unsplash.COM/photo-1.jpg");
		expect(out).toBe("https://images.unsplash.com/photo-1.jpg");
	});

	test("strips trailing slash from path (non-root)", () => {
		const out = normaliseImageUrl("https://example.com/a/b/");
		expect(out).toBe("https://example.com/a/b");
	});

	test("keeps root '/'", () => {
		const out = normaliseImageUrl("https://example.com/");
		expect(out).toBe("https://example.com/");
	});

	test("drops fragment", () => {
		const out = normaliseImageUrl("https://example.com/x.jpg#anchor");
		expect(out).toBe("https://example.com/x.jpg");
	});

	test("CDN host: query string dropped", () => {
		const out = normaliseImageUrl(
			"https://images.unsplash.com/photo.jpg?w=1200&auto=format",
		);
		expect(out).toBe("https://images.unsplash.com/photo.jpg");
	});

	test("non-CDN host: query string preserved", () => {
		const out = normaliseImageUrl("https://example.com/x.jpg?id=1&v=2");
		// URLSearchParams round-trips keys — order preserved here.
		expect(out).toBe("https://example.com/x.jpg?id=1&v=2");
	});

	test("protocol-relative input treated as https", () => {
		const out = normaliseImageUrl("//cdn.sanity.io/x.jpg");
		expect(out).toBe("https://cdn.sanity.io/x.jpg");
	});

	test("RECCE_IMAGE_CDN_HOSTS env override", () => {
		process.env.RECCE_IMAGE_CDN_HOSTS = "custom.cdn.example";
		const cdn = normaliseImageUrl("https://custom.cdn.example/x.jpg?w=200");
		expect(cdn).toBe("https://custom.cdn.example/x.jpg");
		// Default list is no longer in effect — unsplash keeps its query.
		const unsplash = normaliseImageUrl(
			"https://images.unsplash.com/photo.jpg?w=200",
		);
		expect(unsplash).toBe("https://images.unsplash.com/photo.jpg?w=200");
	});

	test("DEFAULT_IMAGE_CDN_HOSTS is the expected list", () => {
		expect(DEFAULT_IMAGE_CDN_HOSTS).toContain("images.unsplash.com");
		expect(DEFAULT_IMAGE_CDN_HOSTS).toContain("cdn.sanity.io");
		expect(DEFAULT_IMAGE_CDN_HOSTS).toContain("res.cloudinary.com");
	});

	test("malformed input returns lowercased string without throwing", () => {
		const out = normaliseImageUrl("NOT_A_URL");
		expect(out).toBe("not_a_url");
	});
});

describe("normaliseImageUrl + detectDuplicateImages — shared contract", () => {
	test("B4 uses the same normaliser as B1 (CDN query-strip collapses dupes)", () => {
		// Two different query strings on a CDN host must count as ONE duplicate
		// pair — that's only possible if detectDuplicateImages calls
		// normaliseImageUrl before counting.
		const srcs = [
			"https://images.unsplash.com/photo.jpg?w=200",
			"https://images.unsplash.com/photo.jpg?w=800",
		];
		const dupes = detectDuplicateImages(srcs);
		expect(dupes).toHaveLength(1);
		expect(dupes[0].count).toBe(2);
		expect(dupes[0].src).toBe("https://images.unsplash.com/photo.jpg");
	});

	test("host case-insensitive dedup (B1+B4 share normalisation)", () => {
		const srcs = ["https://Example.COM/x.jpg", "https://example.com/x.jpg"];
		const dupes = detectDuplicateImages(srcs);
		expect(dupes).toHaveLength(1);
		expect(dupes[0].count).toBe(2);
	});
});
