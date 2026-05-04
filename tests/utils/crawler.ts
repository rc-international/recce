import { gunzipSync } from "node:zlib";
import type { Page } from "@playwright/test";
import { XMLParser } from "fast-xml-parser";
import { recordFinding } from "./findings";
import type { Finding } from "./types";
import { safeWilcoNotify } from "./wilco-notify";

/**
 * Recce crawler primitive.
 *
 * Bounded BFS against /articles and /sites. Builds a seed list via the
 * ordered discovery chain:
 *
 *   1. /robots.txt `Sitemap:` directives
 *   2. <sitemapindex> children (recursed)
 *   3. Gzipped sitemaps (sitemap.xml.gz)
 *   4. /sitemap.xml
 *   5. config.seedUrls fallback
 *
 * On any sitemap parse/fetch failure, emits a `sitemap-parse-failed` finding
 * at `warn` and continues down the chain. Does NOT abort the run.
 *
 * Per-page politeness: min 750ms between goto() per worker. 429 handling:
 * exponential backoff 2s -> 4s -> 8s (cap 30s) with 0-250ms jitter; requeue
 * once. Honours `Retry-After` header. Second 429 on same URL -> skip + emit
 * `rate_limited` (info). Abort if per-run 429 count exceeds
 * RECCE_MAX_RATE_LIMITED (default 10).
 */

export type Fetcher = (url: string) => Promise<{
	ok: boolean;
	status: number;
	contentType: string;
	body: string | Buffer;
	retryAfter?: string | null;
}>;

export type PageLike = Pick<Page, "goto" | "evaluate" | "waitForTimeout">;

export type CrawlerConfig = {
	baseURL: string;
	seedUrls: string[];
	maxDepth?: number;
	maxPages?: number;
	pageHooks?: ((page: PageLike, url: string) => Promise<void> | void)[];
	perPageChecks?: ((page: PageLike, url: string) => Promise<void> | void)[];
	/**
	 * Override the default HTTP fetcher for sitemap/robots.txt discovery.
	 * Primarily for unit tests; production callers should leave this unset.
	 */
	fetcher?: Fetcher;
	/**
	 * Project name propagated into any findings the crawler emits directly
	 * (sitemap-parse-failed, rate_limited, crawl-aborted-rate-limited).
	 */
	project?: Finding["project"];
};

export type CrawlResult = {
	crawled: string[];
	discoveredLinks: Set<string>;
	rateLimited: number;
};

const DEFAULT_MAX_DEPTH = Number(process.env.MAX_DEPTH ?? "7");
const DEFAULT_MAX_PAGES_PULSE = 50;
const DEFAULT_MAX_PAGES_AUDIT = 2000;
/**
 * Env-level override of per-mode max pages. `run-audit.sh` sets this to 2000
 * by default but ops can lower it for debugging without editing the crawler.
 * Parsed once at module load.
 */
const MAX_PAGES_ENV_OVERRIDE: number | null = (() => {
	const raw = process.env.MAX_PAGES;
	if (!raw) return null;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
})();
/**
 * Concurrency is pinned to 1 because the crawler reuses a single Playwright
 * `Page` instance across all navigations. `Page.goto` + subsequent
 * `page.evaluate` are not re-entrant on the same Page; two workers racing
 * would interleave "go A, evaluate for B" scenarios. A future version may
 * lift this by allocating one Page per worker (BrowserContext.newPage) —
 * until then, pinning to 1 is the correct fix. The env knob is retained as
 * a safety cap so an operator cannot accidentally bump it beyond 1.
 */
const DEFAULT_CONCURRENCY = Math.max(
	1,
	Math.min(1, Number(process.env.CRAWL_CONCURRENCY ?? "1")),
);
const MIN_GOTO_INTERVAL_MS = 750;
const MAX_RATE_LIMITED = Number(process.env.RECCE_MAX_RATE_LIMITED ?? "10");
const BACKOFF_STEPS_MS = [2000, 4000, 8000, 30000];

const TRACK_PARAM_RE = /^(utm_|gclid$|fbclid$)/i;
const ALLOWED_PATH_RE = /^\/(articles|sites)\//;

// -----------------------------------------------------------------------------
// URL helpers
// -----------------------------------------------------------------------------

/**
 * Normalise a URL against an origin:
 *   - strip trailing slash (except root)
 *   - lowercase host
 *   - drop utm_*, gclid, fbclid query params
 *
 * Invalid URLs return the empty string.
 */
export function normaliseUrl(href: string, origin: string): string {
	try {
		const u = new URL(href, origin);
		u.host = u.host.toLowerCase();
		const keep: [string, string][] = [];
		u.searchParams.forEach((v, k) => {
			if (!TRACK_PARAM_RE.test(k)) keep.push([k, v]);
		});
		u.search = "";
		for (const [k, v] of keep) u.searchParams.append(k, v);
		if (u.pathname !== "/" && u.pathname.endsWith("/")) {
			u.pathname = u.pathname.replace(/\/+$/, "");
		}
		u.hash = "";
		return u.toString();
	} catch (e) {
		console.debug(`[recce-crawler] normaliseUrl(${href}) failed:`, e);
		return "";
	}
}

function toPathname(absOrPath: string, origin: string): string {
	try {
		return new URL(absOrPath, origin).pathname;
	} catch (e) {
		console.debug(`[recce-crawler] toPathname(${absOrPath}) failed:`, e);
		return "";
	}
}

function isSameOrigin(candidate: string, origin: string): boolean {
	try {
		return new URL(candidate).origin === new URL(origin).origin;
	} catch (e) {
		console.debug(`[recce-crawler] isSameOrigin check failed:`, e);
		return false;
	}
}

// -----------------------------------------------------------------------------
// Default fetcher — uses global fetch (Bun + Node 18+)
// -----------------------------------------------------------------------------

const defaultFetcher: Fetcher = async (url: string) => {
	const res = await fetch(url, { redirect: "follow" });
	const contentType = res.headers.get("content-type") ?? "";
	const retryAfter = res.headers.get("retry-after");
	const isGz = url.endsWith(".gz");
	const body: string | Buffer = isGz
		? Buffer.from(await res.arrayBuffer())
		: await res.text();
	return { ok: res.ok, status: res.status, contentType, body, retryAfter };
};

// -----------------------------------------------------------------------------
// Sitemap discovery chain
// -----------------------------------------------------------------------------

function emitSitemapFailure(
	url: string,
	message: string,
	project: Finding["project"],
): void {
	try {
		recordFinding({
			url,
			check: "sitemap-parse-failed",
			severity: "warn",
			message,
			project,
		});
	} catch (e) {
		console.warn(`[recce-crawler] recordFinding failed for ${url}:`, e);
		safeWilcoNotify(message, {
			level: "warning",
			title: "Recce sitemap parse failed",
			logPrefix: "recce-crawler",
		});
	}
}

function parseRobotsSitemaps(text: string): string[] {
	const out: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		const m = line.match(/^\s*Sitemap:\s*(\S+)/i);
		if (m) out.push(m[1]);
	}
	return out;
}

function maybeGunzipToString(body: string | Buffer, isGz: boolean): string {
	if (!isGz) return typeof body === "string" ? body : body.toString("utf8");
	const buf = typeof body === "string" ? Buffer.from(body) : body;
	return gunzipSync(buf).toString("utf8");
}

function extractUrlsFromSitemapXml(xml: string): {
	kind: "urlset" | "sitemapindex" | null;
	urls: string[];
} {
	const parser = new XMLParser({
		ignoreAttributes: false,
		allowBooleanAttributes: true,
		parseTagValue: false,
	});
	let doc: Record<string, unknown>;
	try {
		doc = parser.parse(xml);
	} catch (e) {
		console.debug(`[recce-crawler] XML parse failed:`, e);
		return { kind: null, urls: [] };
	}
	const rootKey = Object.keys(doc).find((k) => k !== "?xml");
	if (!rootKey) return { kind: null, urls: [] };
	if (rootKey === "urlset") {
		const root = doc.urlset as { url?: unknown };
		const urls: string[] = [];
		const urlNodes = root?.url;
		const nodes = Array.isArray(urlNodes)
			? urlNodes
			: urlNodes != null
				? [urlNodes]
				: [];
		for (const n of nodes) {
			const loc = (n as { loc?: unknown })?.loc;
			if (typeof loc === "string" && loc.trim()) urls.push(loc.trim());
		}
		return { kind: "urlset", urls };
	}
	if (rootKey === "sitemapindex") {
		const root = doc.sitemapindex as { sitemap?: unknown };
		const children: string[] = [];
		const smNodes = root?.sitemap;
		const nodes = Array.isArray(smNodes)
			? smNodes
			: smNodes != null
				? [smNodes]
				: [];
		for (const n of nodes) {
			const loc = (n as { loc?: unknown })?.loc;
			if (typeof loc === "string" && loc.trim()) children.push(loc.trim());
		}
		return { kind: "sitemapindex", urls: children };
	}
	return { kind: null, urls: [] };
}

/**
 * Fetch one sitemap URL (possibly .gz) and return locs or child-sitemap URLs.
 * Emits sitemap-parse-failed on any validation failure.
 */
async function fetchSitemapUrl(
	url: string,
	fetcher: Fetcher,
	project: Finding["project"],
	seen: Set<string>,
): Promise<string[]> {
	if (seen.has(url)) return [];
	seen.add(url);

	let resp: Awaited<ReturnType<Fetcher>>;
	try {
		resp = await fetcher(url);
	} catch (e) {
		console.debug(`[recce-crawler] sitemap fetch ${url} threw:`, e);
		emitSitemapFailure(
			url,
			`sitemap fetch threw: ${(e as Error).message}`,
			project,
		);
		return [];
	}
	if (!resp.ok) {
		emitSitemapFailure(url, `sitemap HTTP ${resp.status}`, project);
		return [];
	}
	// Accept XML content-types AND gzip content-types for .gz URLs (some CDNs
	// serve sitemap.xml.gz as application/gzip, application/x-gzip, or the
	// generic application/octet-stream rather than application/xml). Also
	// tolerate empty content-type on .gz URLs — rare but seen in the wild.
	const ct = resp.contentType || "";
	const isXml = /xml/i.test(ct);
	const isGzUrl = url.endsWith(".gz");
	const isGzCt =
		isGzUrl && (/(^|\b)(gzip|x-gzip|octet-stream)\b/i.test(ct) || ct === "");
	if (!isXml && !isGzCt) {
		emitSitemapFailure(
			url,
			`sitemap content-type not XML: ${resp.contentType || "(empty)"}`,
			project,
		);
		return [];
	}

	let xml: string;
	try {
		xml = maybeGunzipToString(resp.body, url.endsWith(".gz"));
	} catch (e) {
		emitSitemapFailure(
			url,
			`sitemap gunzip failed: ${(e as Error).message}`,
			project,
		);
		return [];
	}

	const { kind, urls } = extractUrlsFromSitemapXml(xml);
	if (!kind) {
		emitSitemapFailure(
			url,
			`sitemap root element not urlset/sitemapindex`,
			project,
		);
		return [];
	}
	if (kind === "sitemapindex") {
		const collected: string[] = [];
		for (const child of urls) {
			const more = await fetchSitemapUrl(child, fetcher, project, seen);
			collected.push(...more);
		}
		return collected;
	}
	return urls; // urlset
}

async function discoverSeeds(
	baseURL: string,
	fetcher: Fetcher,
	project: Finding["project"],
): Promise<string[]> {
	const seen = new Set<string>();

	// 1. robots.txt
	try {
		const robots = await fetcher(new URL("/robots.txt", baseURL).toString());
		if (robots.ok && typeof robots.body !== "undefined") {
			const text =
				typeof robots.body === "string"
					? robots.body
					: robots.body.toString("utf8");
			const sitemaps = parseRobotsSitemaps(text);
			const accumulated: string[] = [];
			for (const sm of sitemaps) {
				const urls = await fetchSitemapUrl(sm, fetcher, project, seen);
				accumulated.push(...urls);
			}
			if (accumulated.length > 0) return accumulated;
		} else if (!robots.ok) {
			console.debug(`[recce-crawler] robots.txt HTTP ${robots.status}`);
		}
	} catch (e) {
		console.debug(`[recce-crawler] robots.txt fetch threw:`, e);
	}

	// 2/3. sitemap.xml.gz then sitemap.xml
	for (const candidate of ["/sitemap.xml.gz", "/sitemap.xml"]) {
		const full = new URL(candidate, baseURL).toString();
		const urls = await fetchSitemapUrl(full, fetcher, project, seen);
		if (urls.length > 0) return urls;
	}

	// 4. fallback: empty -> caller will use seedUrls
	return [];
}

// -----------------------------------------------------------------------------
// Semaphore
// -----------------------------------------------------------------------------

function createSemaphore(n: number): {
	acquire: () => Promise<() => void>;
} {
	let active = 0;
	const waiters: Array<() => void> = [];
	const acquire = (): Promise<() => void> => {
		return new Promise((resolve) => {
			const tryAcquire = (): void => {
				if (active < n) {
					active += 1;
					resolve(() => {
						active -= 1;
						const next = waiters.shift();
						if (next) next();
					});
				} else {
					waiters.push(tryAcquire);
				}
			};
			tryAcquire();
		});
	};
	return { acquire };
}

// -----------------------------------------------------------------------------
// Rate-limit / backoff helpers
// -----------------------------------------------------------------------------

function jitter(ms: number): number {
	return ms + Math.floor(Math.random() * 251); // 0..250ms
}

function parseRetryAfter(raw: string | null | undefined): number | null {
	if (!raw) return null;
	const asNum = Number(raw);
	if (Number.isFinite(asNum)) return Math.max(0, Math.floor(asNum)) * 1000;
	const asDate = Date.parse(raw);
	if (Number.isFinite(asDate)) {
		const delta = asDate - Date.now();
		return delta > 0 ? delta : 0;
	}
	return null;
}

async function sleep(ms: number): Promise<void> {
	if (ms <= 0) return;
	await new Promise((r) => setTimeout(r, ms));
}

// -----------------------------------------------------------------------------
// Main crawl
// -----------------------------------------------------------------------------

/**
 * Run bounded BFS against `baseURL`, starting from config.seedUrls (augmented
 * by sitemap discovery). Returns crawl result; findings are written to the
 * shared sink via recordFinding().
 *
 * The single Playwright `Page` is reused across all navigations; the crawler
 * serialises goto() calls internally and honours politeness delays.
 */
export async function crawl(
	page: PageLike,
	config: CrawlerConfig,
): Promise<CrawlResult> {
	const mode = (process.env.RECCE_MODE as "pulse" | "audit") || "pulse";
	const maxPagesModeDefault =
		mode === "audit" ? DEFAULT_MAX_PAGES_AUDIT : DEFAULT_MAX_PAGES_PULSE;
	// Env override wins over the per-mode default but NOT over an explicit
	// config.maxPages (callers like pulse specs may hardcode e.g. 25 for the
	// 5-minute budget).
	const maxPagesDefault = MAX_PAGES_ENV_OVERRIDE ?? maxPagesModeDefault;
	const maxDepth = config.maxDepth ?? DEFAULT_MAX_DEPTH;
	const maxPages = config.maxPages ?? maxPagesDefault;
	const fetcher = config.fetcher ?? defaultFetcher;
	const project = config.project ?? "chromium";
	const hooks = config.pageHooks ?? [];
	const perPageChecks = config.perPageChecks ?? [];

	// Sitemap discovery (best-effort). Findings already emitted inside.
	let sitemapSeeds: string[] = [];
	try {
		sitemapSeeds = await discoverSeeds(config.baseURL, fetcher, project);
	} catch (e) {
		console.warn(`[recce-crawler] sitemap discovery threw:`, e);
		safeWilcoNotify((e as Error).message, {
			level: "warning",
			title: "Recce sitemap discovery threw",
			logPrefix: "recce-crawler",
		});
	}

	// Compose starting queue: sitemap locs + configured seeds (deduped).
	const queueSet = new Set<string>();
	const pushSeed = (s: string): void => {
		const n = normaliseUrl(s, config.baseURL);
		if (!n) return;
		if (!isSameOrigin(n, config.baseURL)) return;
		const path = toPathname(n, config.baseURL);
		if (!ALLOWED_PATH_RE.test(path) && path !== "/") return;
		queueSet.add(n);
	};
	for (const s of sitemapSeeds) pushSeed(s);
	for (const s of config.seedUrls) pushSeed(s);

	type Task = { url: string; depth: number; retried: boolean };
	const queue: Task[] = [];
	for (const u of queueSet) queue.push({ url: u, depth: 0, retried: false });

	const visited = new Set<string>();
	const discoveredLinks = new Set<string>();
	const crawled: string[] = [];
	let rateLimited = 0;
	const rateLimitedUrls = new Set<string>();

	const sem = createSemaphore(DEFAULT_CONCURRENCY);

	let lastGotoAt = 0;
	// Promise-chain lock instead of busy-wait. Each caller chains onto the
	// previous, so the next contender awaits a settled promise rather than
	// polling `gotoLock.locked` every 10ms. At concurrency=1 there is never
	// contention, but the chain keeps the code correct if a future change
	// raises concurrency (and avoids CPU wakeups in the meantime).
	let gotoChain: Promise<void> = Promise.resolve();

	const enforcePoliteness = (): Promise<void> => {
		const next = gotoChain.then(async () => {
			const delta = MIN_GOTO_INTERVAL_MS - (Date.now() - lastGotoAt);
			if (delta > 0) await sleep(delta);
			lastGotoAt = Date.now();
		});
		gotoChain = next.catch(() => {});
		return next;
	};

	let aborted = false;

	const processTask = async (task: Task): Promise<void> => {
		if (aborted) return;
		if (crawled.length >= maxPages) return;
		if (visited.has(task.url)) return;
		if (task.depth > maxDepth) return;
		visited.add(task.url);

		// Run pageHooks BEFORE goto so listeners (pageerror, request, etc.) attach
		// in time to catch the navigation.
		for (const hook of hooks) {
			try {
				await hook(page, task.url);
			} catch (e) {
				console.warn(`[recce-crawler] pageHook threw for ${task.url}:`, e);
			}
		}

		await enforcePoliteness();

		let status: number | null = null;
		let retryAfterMs: number | null = null;
		try {
			// `networkidle` is fragile on SPA/analytics-heavy pages — they keep
			// a trickle of requests open past the point of meaningful render.
			// Use `domcontentloaded` for the hard gate, then best-effort
			// `networkidle` with a short cap for the settle signal. A timeout
			// on the soft-wait is NOT an error — we proceed to checks either
			// way.
			const resp = await page.goto(task.url, {
				waitUntil: "domcontentloaded",
				timeout: 15000,
			});
			try {
				// Playwright's Page type has waitForLoadState; PageLike doesn't
				// strictly, so guard for the unit-test stub case.
				const waitFn = (
					page as unknown as {
						waitForLoadState?: (
							s: string,
							o: { timeout: number },
						) => Promise<void>;
					}
				).waitForLoadState;
				if (typeof waitFn === "function") {
					await waitFn
						.call(page, "networkidle", { timeout: 5000 })
						.catch((e: unknown) => {
							console.debug(
								`[recce-crawler] networkidle wait ${task.url} timed out:`,
								e,
							);
						});
				}
			} catch (e) {
				console.debug(
					`[recce-crawler] waitForLoadState ${task.url} failed:`,
					e,
				);
			}
			status = resp?.status() ?? null;
			if (status === 429 || status === 503) {
				const raw = resp?.headers()?.["retry-after"];
				retryAfterMs = parseRetryAfter(raw ?? null);
			}
		} catch (e) {
			const msg = (e as Error)?.message ?? String(e);
			console.debug(`[recce-crawler] goto ${task.url} threw:`, e);
			// Emit a formal finding so navigation failures surface in the
			// findings artifact rather than being silently swallowed.
			try {
				recordFinding({
					url: task.url,
					check: "crawl-goto-failed",
					severity: "warn",
					message: `page.goto threw: ${msg.slice(0, 200)}`,
					actual: msg.slice(0, 200),
					project,
				});
			} catch (inner) {
				console.warn(
					`[recce-crawler] recordFinding crawl-goto-failed failed:`,
					inner,
				);
			}
			return;
		}

		if (status === 429) {
			rateLimited += 1;
			if (!task.retried && !rateLimitedUrls.has(task.url)) {
				rateLimitedUrls.add(task.url);
				const base = BACKOFF_STEPS_MS[0];
				const delay = retryAfterMs ?? jitter(base);
				await sleep(delay);
				visited.delete(task.url);
				queue.push({ ...task, retried: true });
			} else {
				// Second 429: give up and record.
				try {
					recordFinding({
						url: task.url,
						check: "rate_limited",
						severity: "info",
						message: `429 received twice; giving up`,
						actual: "HTTP 429",
						project,
					});
				} catch (e) {
					console.warn(`[recce-crawler] recordFinding rate_limited failed:`, e);
				}
			}
			if (rateLimited > MAX_RATE_LIMITED && !aborted) {
				aborted = true;
				try {
					recordFinding({
						url: config.baseURL,
						check: "crawl-aborted-rate-limited",
						severity: "error",
						message: `Aborted after ${rateLimited} 429s (threshold ${MAX_RATE_LIMITED})`,
						actual: String(rateLimited),
						project,
					});
				} catch (e) {
					console.error(
						`[recce-crawler] recordFinding crawl-aborted-rate-limited failed:`,
						e,
					);
				}
				safeWilcoNotify(`${rateLimited} 429s on ${config.baseURL}`, {
					level: "error",
					title: "Recce crawl aborted — rate-limited",
					logPrefix: "recce-crawler",
				});
			}
			return;
		}

		if (status === 503 && retryAfterMs != null && !task.retried) {
			await sleep(retryAfterMs);
			visited.delete(task.url);
			queue.push({ ...task, retried: true });
			return;
		}

		if (status == null || status >= 400) {
			// Non-2xx: don't enqueue link discoveries, but still count as visited.
			return;
		}

		crawled.push(task.url);

		for (const check of perPageChecks) {
			try {
				await check(page, task.url);
			} catch (e) {
				console.warn(`[recce-crawler] perPageCheck threw for ${task.url}:`, e);
			}
		}

		// Extract hrefs. In unit tests the stubbed page returns an empty array.
		let hrefs: string[] = [];
		try {
			hrefs = (await page.evaluate(() => {
				return Array.from(document.querySelectorAll("a"))
					.map((a) => a.getAttribute("href"))
					.filter((h): h is string => !!h);
			})) as string[];
		} catch (e) {
			console.debug(`[recce-crawler] evaluate hrefs ${task.url} failed:`, e);
		}

		for (const raw of hrefs) {
			if (raw.startsWith("mailto:") || raw.startsWith("tel:")) continue;
			const norm = normaliseUrl(raw, task.url);
			if (!norm) continue;
			if (!isSameOrigin(norm, config.baseURL)) {
				discoveredLinks.add(norm);
				continue;
			}
			const path = toPathname(norm, config.baseURL);
			discoveredLinks.add(norm);
			if (!ALLOWED_PATH_RE.test(path)) continue;
			if (visited.has(norm)) continue;
			if (task.depth + 1 > maxDepth) continue;
			if (crawled.length + queue.length >= maxPages) continue;
			queue.push({ url: norm, depth: task.depth + 1, retried: false });
		}
	};

	// Drain the queue with bounded concurrency.
	const inflight: Promise<void>[] = [];
	while ((queue.length > 0 || inflight.length > 0) && !aborted) {
		while (
			queue.length > 0 &&
			inflight.length < DEFAULT_CONCURRENCY &&
			crawled.length < maxPages
		) {
			const task = queue.shift();
			if (!task) break;
			const p = (async (): Promise<void> => {
				const release = await sem.acquire();
				try {
					await processTask(task);
				} finally {
					release();
				}
			})();
			inflight.push(p);
			p.finally(() => {
				const idx = inflight.indexOf(p);
				if (idx >= 0) inflight.splice(idx, 1);
			});
		}
		if (inflight.length > 0) {
			await Promise.race(inflight);
		}
	}
	await Promise.all(inflight);

	return { crawled, discoveredLinks, rateLimited };
}
