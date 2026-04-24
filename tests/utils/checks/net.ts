import type { APIRequestContext } from "@playwright/test";

/**
 * Shared HEAD-with-GET-fallback helper for link/image/SEO probes.
 *
 * Prior to extraction, images.ts and links.ts had two near-duplicate copies,
 * and seo.ts had a HEAD-only variant that polluted the shared `checkedLinks`
 * cache — downstream checkImages then saw cached 405s and skipped its own
 * fallback, causing spurious "broken-image" findings on perfectly reachable
 * CDN URLs that only served GET.
 *
 * Cache semantics:
 *   - Key = `cacheKey` arg. Callers that want to dedup across transform URLs
 *     (e.g. cloudinary/sanity) pass the normalized key; callers that want
 *     per-URL semantics pass the URL itself.
 *   - Value = final HTTP status after HEAD + (optional) GET fallback, or 0 on
 *     total failure.
 *   - `fetchUrl` is what we actually request. This MUST stay separate from
 *     cacheKey: CDN-normalized keys often strip query strings, and issuing a
 *     HEAD against the stripped URL can 403/404 when the transform URL itself
 *     is 200.
 *
 * GET fallback statuses: 403, 405, 501. Some CDNs (notably Cloudinary) refuse
 * HEAD on transform URLs with 403; others return 405/501. A second GET covers
 * all three.
 */

const GET_FALLBACK_STATUSES = new Set([403, 405, 501]);

export async function headOrGet(
	ctx: APIRequestContext,
	fetchUrl: string,
	cacheKey: string,
	cache: Map<string, number>,
	timeoutMs = 5000,
): Promise<number> {
	const cached = cache.get(cacheKey);
	if (cached !== undefined) return cached;
	let status = 0;
	try {
		const res = await ctx.head(fetchUrl, { timeout: timeoutMs });
		status = res.status();
		if (GET_FALLBACK_STATUSES.has(status)) {
			const r2 = await ctx.get(fetchUrl, { timeout: timeoutMs });
			status = r2.status();
		}
	} catch (e) {
		console.debug(`[recce-net] HEAD ${fetchUrl} threw:`, e);
		try {
			const r3 = await ctx.get(fetchUrl, { timeout: timeoutMs });
			status = r3.status();
		} catch (e2) {
			console.debug(`[recce-net] GET fallback ${fetchUrl} threw:`, e2);
			status = 0;
		}
	}
	cache.set(cacheKey, status);
	return status;
}

/**
 * Also exported so callers that need to mirror the fallback list elsewhere
 * (e.g. SEO og:image dimensions) don't drift.
 */
export { GET_FALLBACK_STATUSES };
