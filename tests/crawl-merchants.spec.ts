import { expect, type Page, test } from "@playwright/test";
import { checkButtons } from "./utils/checks/buttons";
import { checkContentQuality } from "./utils/checks/content";
import { checkImages } from "./utils/checks/images";
import { checkLinks } from "./utils/checks/links";
import { createRuntimeErrorHook } from "./utils/checks/runtime-errors";
import { checkSecurity } from "./utils/checks/security";
import { recordSelectorHit } from "./utils/checks/selector-health";
import { checkSeo } from "./utils/checks/seo";
import { crawl } from "./utils/crawler";
import { recordFinding } from "./utils/findings";
import type { Finding } from "./utils/types";

/**
 * B3 — merchant-page coverage.
 *
 * Merchant URL pattern: /sites/en/<...>/<merchant>/<id>. Pulse samples up to
 * 5; audit up to 200.
 *
 * Per merchant page we assert:
 *   - Hero: `img.object-cover` first-in-DOM, visible, naturalWidth >= 400
 *   - At least one body image beyond the hero
 *   - hero alt != id slug (warn)
 * and reuse B1/B2/B5 via the shared check helpers.
 */

const MERCHANT_RE = /^\/sites\/en\/.+\/.+\/[^/]+$/;

function isMerchantPath(urlStr: string): boolean {
	try {
		const u = new URL(urlStr);
		return MERCHANT_RE.test(u.pathname);
	} catch (e) {
		console.debug(`[crawl-merchants] bad url ${urlStr}:`, e);
		return false;
	}
}

function slugFromUrl(urlStr: string): string {
	try {
		const u = new URL(urlStr);
		const segs = u.pathname.split("/").filter(Boolean);
		return segs[segs.length - 1] || "";
	} catch (e) {
		console.debug(`[crawl-merchants] slugFromUrl ${urlStr} failed:`, e);
		return "";
	}
}

test.describe("Merchants BFS crawl (B3)", () => {
	const crawlSeeds = [
		"/",
		"/sites/en/Mexico/CDMX/Ciudad-de-Mexico/coffee_shop/blend-station/88e4fc",
	];

	test("crawl and verify merchant pages", async ({
		page,
		baseURL,
	}, testInfo) => {
		if (!baseURL) {
			throw new Error("BASE_URL required — see playwright.config.ts");
		}
		const project = testInfo.project.name as Finding["project"];
		const mode = (process.env.RECCE_MODE as "pulse" | "audit") || "pulse";
		const maxMerchants = mode === "audit" ? 200 : 5;

		// Shared caches across B1/B2 so HEAD results are deduplicated within
		// this single test invocation.
		const checkedLinks = new Map<string, number>();
		const soft404Context = {
			visited: new Set<string>(),
			soft404Checked: new Set<string>(),
		};

		// Current-URL ref updated before each per-page check body so the
		// runtime-error hook (installed once pre-navigation) can tag findings
		// with the page under test.
		const urlRef = { value: "" };

		let merchantsChecked = 0;

		const result = await crawl(page, {
			baseURL,
			seedUrls: crawlSeeds,
			maxPages: mode === "audit" ? 2000 : 50,
			project,
			pageHooks: [
				// See crawl-articles.spec.ts for rationale — attach listeners once,
				// cast PageLike -> Page safely in production.
				(() => {
					const hook = createRuntimeErrorHook(() => urlRef.value, project);
					let installed = false;
					return async (pl: unknown) => {
						if (installed) return;
						installed = true;
						await hook(pl as Page);
					};
				})(),
			],
			perPageChecks: [
				async (pl, url) => {
					const p = pl as Page;
					urlRef.value = url;
					soft404Context.visited.add(url);
					if (!isMerchantPath(url)) return;
					if (merchantsChecked >= maxMerchants) return;
					merchantsChecked += 1;

					// Selector-health: track object-cover on merchant pages.
					try {
						const heroCount = await p.evaluate(
							() => document.querySelectorAll("img.object-cover").length,
						);
						recordSelectorHit(
							"merchant",
							"img.object-cover",
							heroCount as number,
						);
					} catch (e) {
						console.debug(
							`[crawl-merchants] recordSelectorHit failed for ${url}:`,
							e,
						);
					}

					// Hero existence + size.
					try {
						const hero = await p.evaluate(() => {
							const el = document.querySelector(
								"img.object-cover",
							) as HTMLImageElement | null;
							if (!el) return null;
							const rect = el.getBoundingClientRect();
							return {
								naturalWidth: el.naturalWidth || 0,
								naturalHeight: el.naturalHeight || 0,
								visible:
									rect.width > 0 &&
									rect.height > 0 &&
									window.getComputedStyle(el).visibility !== "hidden" &&
									window.getComputedStyle(el).display !== "none",
								alt: el.getAttribute("alt") || "",
								src: el.getAttribute("src") || "",
							};
						});
						if (!hero) {
							recordFinding({
								url,
								check: "hero-missing",
								severity: "error",
								message: `merchant page has no img.object-cover`,
								element: { tag: "img", selector: "img.object-cover" },
								expected: "img.object-cover present",
								actual: "(not found)",
								project,
							});
						} else {
							if (!hero.visible) {
								recordFinding({
									url,
									check: "hero-not-visible",
									severity: "error",
									message: `hero img.object-cover not visible`,
									element: {
										tag: "img",
										selector: "img.object-cover",
										attr: { src: hero.src },
									},
									expected: "visible",
									actual: "hidden",
									project,
								});
							}
							if (hero.naturalWidth < 400) {
								recordFinding({
									url,
									check: "hero-too-small",
									severity: "error",
									message: `hero naturalWidth=${hero.naturalWidth} (<400)`,
									element: {
										tag: "img",
										selector: "img.object-cover",
										attr: { src: hero.src },
									},
									expected: ">= 400",
									actual: String(hero.naturalWidth),
									project,
								});
							}
							const slug = slugFromUrl(url);
							if (
								hero.alt &&
								slug &&
								hero.alt.toLowerCase() === slug.toLowerCase()
							) {
								recordFinding({
									url,
									check: "hero-alt-matches-slug",
									severity: "warn",
									message: `hero alt matches url slug "${slug}"`,
									element: {
										tag: "img",
										selector: "img.object-cover",
										attr: { alt: hero.alt },
									},
									project,
								});
							}
						}
					} catch (e) {
						console.debug(`[crawl-merchants] hero check ${url} failed:`, e);
					}

					// Body image beyond hero.
					try {
						const bodyImageCount = await p.evaluate(() => {
							return document.querySelectorAll(
								"article img:not(.object-cover), main img:not(.object-cover)",
							).length;
						});
						if ((bodyImageCount as number) === 0) {
							recordFinding({
								url,
								check: "no-body-images",
								severity: "warn",
								message: `merchant page has no body images beyond hero`,
								expected: ">= 1",
								actual: "0",
								project,
							});
						}
					} catch (e) {
						console.debug(
							`[crawl-merchants] body-image count ${url} failed:`,
							e,
						);
					}

					// B1 + B4 + CLS + oversized
					try {
						await checkImages(p, { url, project, checkedLinks });
					} catch (e) {
						console.debug(`[crawl-merchants] checkImages ${url} failed:`, e);
					}

					// B5 buttons
					try {
						await checkButtons(p, { url, project });
					} catch (e) {
						console.debug(`[crawl-merchants] checkButtons ${url} failed:`, e);
					}

					// B2 (includes soft-404 sweep)
					try {
						await checkLinks(p, {
							url,
							project,
							checkedLinks,
							soft404Context,
						});
					} catch (e) {
						console.debug(`[crawl-merchants] checkLinks ${url} failed:`, e);
					}

					// Phase 5a: content + security.
					try {
						await checkContentQuality(p, { url, project });
					} catch (e) {
						console.debug(
							`[crawl-merchants] checkContentQuality ${url} failed:`,
							e,
						);
					}

					try {
						await checkSecurity(p, { url, project });
					} catch (e) {
						console.debug(`[crawl-merchants] checkSecurity ${url} failed:`, e);
					}

					// Phase 5b: SEO meta (locale-aware title, og, charset, BCP-47).
					try {
						await checkSeo(p, {
							url,
							project,
							requestContext: p.context().request,
							checkedLinks,
						});
					} catch (e) {
						console.debug(`[crawl-merchants] checkSeo ${url} failed:`, e);
					}
				},
			],
		});

		console.log(
			`[crawl-merchants] crawled=${result.crawled.length} merchants=${merchantsChecked} rateLimited=${result.rateLimited}`,
		);
		expect(
			result.crawled.length,
			"crawler produced zero pages — seed list or sitemap broken",
		).toBeGreaterThan(0);
	});
});
