import type { Page } from "@playwright/test";
import { recordFinding } from "../findings";
import type { Finding } from "../types";

/**
 * B1 (broken / missing) + B4 (duplicate) + CLS dimension + oversized image
 * checks for article-body images.
 *
 * Single source of truth for `normaliseImageUrl` — the canonical key used
 * for both the HEAD dedup cache (B1) and the duplicate counter (B4).
 */

export const DEFAULT_IMAGE_CDN_HOSTS = [
	"images.unsplash.com",
	"cdn.sanity.io",
	"res.cloudinary.com",
];

const DEFAULT_DUPLICATE_EXEMPT_PATTERNS = [
	"/logo",
	"/favicon",
	"/apple-touch-icon",
	"/brand",
];

const INTENTIONAL_PATTERN_THRESHOLD = 10;

function cdnHosts(): string[] {
	const raw = process.env.RECCE_IMAGE_CDN_HOSTS;
	if (!raw) return DEFAULT_IMAGE_CDN_HOSTS;
	return raw
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
}

function exemptPatterns(): string[] {
	const raw = process.env.RECCE_DUPLICATE_EXEMPT_PATTERNS;
	if (!raw) return DEFAULT_DUPLICATE_EXEMPT_PATTERNS;
	return raw
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
}

/**
 * Produce a stable key for image dedup and HEAD caching.
 *
 *   - Lowercase host.
 *   - Strip trailing slash from path.
 *   - If host matches RECCE_IMAGE_CDN_HOSTS: drop query string entirely.
 *     Else: preserve query string.
 *   - Drop fragment.
 *
 * Inputs that fail URL parsing (e.g. `data:` URIs) are returned as-is,
 * lowercased — every call site still gets a stable string key.
 */
export function normaliseImageUrl(url: string): string {
	if (!url) return "";
	try {
		// Handle protocol-relative URLs by assuming https:.
		const input = url.startsWith("//") ? `https:${url}` : url;
		const u = new URL(input);
		u.host = u.host.toLowerCase();
		if (u.pathname !== "/" && u.pathname.endsWith("/")) {
			u.pathname = u.pathname.replace(/\/+$/, "");
		}
		u.hash = "";
		const hosts = cdnHosts();
		if (hosts.includes(u.host)) {
			u.search = "";
		}
		return u.toString();
	} catch (e) {
		console.debug(`[recce-images] normaliseImageUrl(${url}) failed:`, e);
		return url.toLowerCase();
	}
}

function basename(url: string): string {
	try {
		const u = new URL(url);
		const segs = u.pathname.split("/");
		return (segs[segs.length - 1] || "").toLowerCase();
	} catch (e) {
		console.debug(`[recce-images] basename(${url}) failed:`, e);
		const slash = url.lastIndexOf("/");
		return slash >= 0 ? url.slice(slash + 1).toLowerCase() : url.toLowerCase();
	}
}

function isExempt(src: string, patterns: string[]): boolean {
	const base = basename(src);
	for (const p of patterns) {
		const needle = p.startsWith("/") ? p.slice(1) : p;
		if (base.includes(needle.toLowerCase())) return true;
	}
	return false;
}

/**
 * Pure function: given an ordered list of image srcs observed on a page,
 * return one entry per unique src that appears >= 2 times. Applies:
 *   - RECCE_DUPLICATE_EXEMPT_PATTERNS filter (basename contains pattern)
 *   - canonical normalisation via normaliseImageUrl
 *   - intentional-pattern downgrade: no severity attached here, but count
 *     is preserved so callers can bucket severity.
 *
 * Output is sorted by descending count then src for determinism.
 */
export function detectDuplicateImages(
	srcs: string[],
): Array<{ src: string; count: number }> {
	const patterns = exemptPatterns();
	const counts = new Map<string, number>();
	for (const raw of srcs) {
		if (!raw) continue;
		const key = normaliseImageUrl(raw);
		if (!key) continue;
		if (isExempt(key, patterns)) continue;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const out: Array<{ src: string; count: number }> = [];
	for (const [src, count] of counts) {
		if (count >= 2) out.push({ src, count });
	}
	out.sort((a, b) => b.count - a.count || a.src.localeCompare(b.src));
	return out;
}

type ImageInfo = {
	src: string;
	currentSrc: string;
	alt: string | null;
	loading: string | null;
	hasWidthAttr: boolean;
	hasHeightAttr: boolean;
	hasInlineDims: boolean;
	naturalWidth: number;
	naturalHeight: number;
	renderedWidth: number;
	complete: boolean;
	inArticleScope: boolean;
};

/**
 * Harvest image metadata in one `page.evaluate` round-trip to minimise
 * per-image latency. Also triggers scroll-into-view for lazy images.
 */
async function collectImages(page: Page): Promise<ImageInfo[]> {
	// First pass — scroll lazy images into view so naturalWidth / complete
	// are meaningful.
	try {
		await page.evaluate(() => {
			const imgs = document.querySelectorAll("img");
			for (const img of imgs) {
				const loading = img.getAttribute("loading");
				const hasDataSrc = !!img.getAttribute("data-src");
				if (loading === "lazy" || hasDataSrc) {
					img.scrollIntoView({ block: "center", inline: "nearest" });
				}
			}
		});
	} catch (e) {
		console.debug(`[recce-images] scroll pass failed:`, e);
	}

	// 1s settle for lazy images.
	try {
		await page.waitForTimeout(1000);
	} catch (e) {
		console.debug(`[recce-images] settle sleep failed:`, e);
	}

	const SCOPED = "article img, main img, [data-article-body] img";
	const FALLBACK = "img:not(header img):not(footer img):not(nav img)";

	const raw = await page.evaluate(
		({ scoped, fallback }) => {
			const scopedNodes = Array.from(document.querySelectorAll(scoped));
			const pool =
				scopedNodes.length > 0
					? scopedNodes
					: Array.from(document.querySelectorAll(fallback));

			const result: Array<{
				src: string;
				currentSrc: string;
				alt: string | null;
				loading: string | null;
				hasWidthAttr: boolean;
				hasHeightAttr: boolean;
				hasInlineDims: boolean;
				naturalWidth: number;
				naturalHeight: number;
				renderedWidth: number;
				complete: boolean;
				inArticleScope: boolean;
			}> = [];

			for (const el of pool) {
				const img = el as HTMLImageElement;
				const style = img.getAttribute("style") || "";
				const hasInline =
					/width\s*:\s*\d/.test(style) && /height\s*:\s*\d/.test(style);
				result.push({
					src: img.getAttribute("src") || "",
					currentSrc: img.currentSrc || img.src || "",
					alt: img.getAttribute("alt"),
					loading: img.getAttribute("loading"),
					hasWidthAttr: img.hasAttribute("width"),
					hasHeightAttr: img.hasAttribute("height"),
					hasInlineDims: hasInline,
					naturalWidth: img.naturalWidth || 0,
					naturalHeight: img.naturalHeight || 0,
					renderedWidth: img.getBoundingClientRect().width || 0,
					complete: img.complete,
					inArticleScope: scopedNodes.length > 0,
				});
			}
			return result;
		},
		{ scoped: SCOPED, fallback: FALLBACK },
	);

	return raw as ImageInfo[];
}

async function headOrGet(
	page: Page,
	target: string,
	cache: Map<string, number>,
): Promise<number> {
	const cached = cache.get(target);
	if (cached !== undefined) return cached;

	const ctx = page.context();
	let status = 0;
	try {
		const res = await ctx.request.head(target, { timeout: 5000 });
		status = res.status();
		if (status === 405 || status === 501) {
			const r2 = await ctx.request.get(target, { timeout: 5000 });
			status = r2.status();
		}
	} catch (e) {
		console.debug(`[recce-images] HEAD ${target} threw:`, e);
		try {
			const r3 = await ctx.request.get(target, { timeout: 5000 });
			status = r3.status();
		} catch (e2) {
			console.debug(`[recce-images] GET fallback ${target} threw:`, e2);
			status = 0;
		}
	}
	cache.set(target, status);
	return status;
}

/**
 * Run B1 + B4 + CLS + oversized checks on the current page state.
 *
 * Findings are emitted via the shared `recordFinding()` sink. Caller must
 * supply a `checkedLinks` cache so image-HEAD dedup is shared with
 * `checkLinks` (B2).
 */
export async function checkImages(
	page: Page,
	options: {
		url: string;
		project: Finding["project"];
		checkedLinks: Map<string, number>;
	},
): Promise<void> {
	const { url, project, checkedLinks } = options;

	let imgs: ImageInfo[] = [];
	try {
		imgs = await collectImages(page);
	} catch (e) {
		console.warn(`[recce-images] collectImages ${url} failed:`, e);
		return;
	}

	const duplicateSrcs: string[] = [];

	for (const img of imgs) {
		// Skip tracking pixels.
		if (
			img.naturalWidth > 0 &&
			img.naturalWidth <= 2 &&
			img.naturalHeight <= 2
		) {
			continue;
		}

		// Skip decorative placeholders (role=presentation implied via empty alt
		// + 0 bytes): we can't see role here, but 0x0 empty-alt is the soft case.
		const decorative =
			img.alt === "" &&
			img.naturalWidth === 0 &&
			img.naturalHeight === 0 &&
			!img.complete;

		const broken = !img.naturalWidth || !img.naturalHeight || !img.complete;

		if (broken && !decorative) {
			recordFinding({
				url,
				check: "broken-image",
				severity: "error",
				message: `image fails load: src=${img.src || "(empty)"}`,
				element: {
					tag: "img",
					attr: {
						src: img.src,
						alt: img.alt ?? "",
						loading: img.loading ?? "",
					},
				},
				expected: "naturalWidth>0 && complete=true",
				actual: !img.complete
					? "img.complete=false"
					: `naturalWidth=${img.naturalWidth}`,
				project,
			});
			continue;
		}

		// HEAD check on currentSrc for non-broken images.
		if (img.currentSrc && /^https?:/i.test(img.currentSrc)) {
			const key = normaliseImageUrl(img.currentSrc);
			const status = await headOrGet(page, key, checkedLinks);
			if (status && (status < 200 || status >= 300)) {
				recordFinding({
					url,
					check: "broken-image",
					severity: "error",
					message: `image HTTP ${status}: ${img.src}`,
					element: {
						tag: "img",
						attr: {
							src: img.src,
							alt: img.alt ?? "",
							loading: img.loading ?? "",
						},
					},
					expected: "2xx",
					actual: `HTTP ${status}`,
					project,
				});
				continue;
			}
		}

		// CLS: missing dimensions.
		if (!img.hasWidthAttr && !img.hasHeightAttr && !img.hasInlineDims) {
			recordFinding({
				url,
				check: "image-missing-dimensions",
				severity: "warn",
				message: `image has no width/height attrs or inline dims: ${img.src}`,
				element: {
					tag: "img",
					attr: { src: img.src, alt: img.alt ?? "" },
				},
				expected: "width+height attrs or inline style dims",
				actual: "(none)",
				project,
			});
		}

		// Oversized.
		if (img.renderedWidth > 0 && img.naturalWidth / img.renderedWidth > 2) {
			recordFinding({
				url,
				check: "image-oversized",
				severity: "warn",
				message: `image ${Math.round(img.naturalWidth / img.renderedWidth)}x rendered size: ${img.src}`,
				element: {
					tag: "img",
					attr: { src: img.src, alt: img.alt ?? "" },
				},
				expected: "naturalWidth / renderedWidth <= 2",
				actual: `${img.naturalWidth}/${img.renderedWidth}`,
				project,
			});
		}

		if (img.src) duplicateSrcs.push(img.src);
	}

	// B4: duplicate detection.
	const dupes = detectDuplicateImages(duplicateSrcs);
	for (const d of dupes) {
		const severity: Finding["severity"] =
			d.count >= INTENTIONAL_PATTERN_THRESHOLD ? "warn" : "error";
		recordFinding({
			url,
			check: "duplicate-image",
			severity,
			message: `image src appears ${d.count} times on page: ${d.src}`,
			element: { tag: "img", attr: { src: d.src } },
			expected: "1 occurrence",
			actual: `${d.count} occurrences`,
			project,
		});
	}
}
