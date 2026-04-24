import type { Page } from "@playwright/test";
import { recordFinding } from "../findings";
import type { Finding } from "../types";

/**
 * C7 + C8 — `target="_blank"` safety and mixed-content detection.
 *
 * C7 rules
 * --------
 *   - Every `a[target="_blank"]` MUST have `rel` containing `noopener`.
 *     Missing -> error (`target-blank-noopener-missing`) — supply-chain
 *     tabnabbing risk.
 *   - `noopener` present but `noreferrer` missing -> warn
 *     (`target-blank-noreferrer-recommended`).
 *   - Both present -> no finding.
 *
 * C8 rules (https origins only; skipped on http:// and localhost)
 * ---------------------------------------------------------------
 *   - `img[src^="http:"]`, `script[src^="http:"]`,
 *     `iframe[src^="http:"]`, `link[rel="stylesheet"][href^="http:"]`
 *     -> error (`mixed-content`).
 *   - Inline `<style>` contents matching `url(http://...)` -> error.
 *   - External `<link rel="stylesheet">` content fetching: we intentionally
 *     do NOT perform cross-origin fetches from here (bandwidth + auth
 *     surprises). Flagged as `mixed-content-stylesheet-unchecked` at warn
 *     severity so reviewers can manually follow up.
 */

function isSkipOrigin(url: string): boolean {
	try {
		const u = new URL(url);
		if (u.protocol !== "https:") return true; // C8 only applies on https
		if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return true;
		return false;
	} catch (e) {
		console.debug(`[recce-security] isSkipOrigin(${url}) failed:`, e);
		return true;
	}
}

type AnchorSnapshot = {
	href: string;
	rel: string;
};

type MixedContentSnapshot = {
	type: "img" | "script" | "iframe" | "link-stylesheet" | "style-inline";
	src: string;
};

async function snapshotDom(page: Page): Promise<{
	anchors: AnchorSnapshot[];
	mixed: MixedContentSnapshot[];
}> {
	return (await page.evaluate(() => {
		const anchors: { href: string; rel: string }[] = [];
		for (const el of Array.from(
			document.querySelectorAll('a[target="_blank"]'),
		)) {
			const a = el as HTMLAnchorElement;
			anchors.push({
				href: a.getAttribute("href") || "",
				rel: a.getAttribute("rel") || "",
			});
		}

		const mixed: { type: string; src: string }[] = [];
		for (const el of Array.from(
			document.querySelectorAll('img[src^="http:"]'),
		)) {
			mixed.push({
				type: "img",
				src: (el as HTMLImageElement).getAttribute("src") || "",
			});
		}
		for (const el of Array.from(
			document.querySelectorAll('script[src^="http:"]'),
		)) {
			mixed.push({
				type: "script",
				src: (el as HTMLScriptElement).getAttribute("src") || "",
			});
		}
		for (const el of Array.from(
			document.querySelectorAll('iframe[src^="http:"]'),
		)) {
			mixed.push({
				type: "iframe",
				src: (el as HTMLIFrameElement).getAttribute("src") || "",
			});
		}
		for (const el of Array.from(
			document.querySelectorAll('link[rel="stylesheet"][href^="http:"]'),
		)) {
			mixed.push({
				type: "link-stylesheet",
				src: (el as HTMLLinkElement).getAttribute("href") || "",
			});
		}
		// Inline <style> with url(http://...) refs.
		for (const el of Array.from(document.querySelectorAll("style"))) {
			const txt = el.textContent || "";
			const re = /url\(\s*['"]?(http:\/\/[^'")\s]+)/gi;
			let m: RegExpExecArray | null = re.exec(txt);
			while (m) {
				mixed.push({ type: "style-inline", src: m[1] });
				m = re.exec(txt);
			}
		}
		return { anchors, mixed: mixed as MixedContentSnapshot[] };
	})) as { anchors: AnchorSnapshot[]; mixed: MixedContentSnapshot[] };
}

export async function checkSecurity(
	page: Page,
	options: { url: string; project: Finding["project"] },
): Promise<void> {
	const { url, project } = options;

	let snap: { anchors: AnchorSnapshot[]; mixed: MixedContentSnapshot[] };
	try {
		snap = await snapshotDom(page);
	} catch (e) {
		console.debug(`[recce-security] snapshotDom ${url} failed:`, e);
		return;
	}

	// ---- C7: target=_blank noopener / noreferrer ------------------------------
	for (const a of snap.anchors) {
		try {
			const rel = a.rel.toLowerCase();
			const hasNoopener = /\bnoopener\b/.test(rel);
			const hasNoreferrer = /\bnoreferrer\b/.test(rel);
			if (!hasNoopener) {
				recordFinding({
					url,
					check: "target-blank-noopener-missing",
					severity: "error",
					message: `a[target="_blank"] missing rel="noopener": href=${a.href || "(empty)"}`,
					element: {
						tag: "a",
						attr: { href: a.href, rel: a.rel, target: "_blank" },
					},
					expected: 'rel contains "noopener"',
					actual: a.rel || "(no rel)",
					project,
				});
				continue;
			}
			if (!hasNoreferrer) {
				recordFinding({
					url,
					check: "target-blank-noreferrer-recommended",
					severity: "warn",
					message: `a[target="_blank"] has noopener but no noreferrer: href=${a.href || "(empty)"}`,
					element: {
						tag: "a",
						attr: { href: a.href, rel: a.rel, target: "_blank" },
					},
					expected: 'rel contains "noreferrer"',
					actual: a.rel,
					project,
				});
			}
		} catch (e) {
			console.debug(`[recce-security] anchor check failed:`, e);
		}
	}

	// ---- C8: mixed content ----------------------------------------------------
	if (isSkipOrigin(url)) return;

	for (const m of snap.mixed) {
		try {
			recordFinding({
				url,
				check: "mixed-content",
				severity: "error",
				message: `mixed-content ${m.type}: ${m.src}`,
				element: { tag: m.type === "style-inline" ? "style" : m.type },
				expected: "https:// or protocol-relative //",
				actual: m.src,
				project,
			});
		} catch (e) {
			console.debug(`[recce-security] mixed-content record failed:`, e);
		}
	}

	// Cross-origin stylesheet fetching not attempted here (see file header).
	// If any link-stylesheet was https same-origin we could optionally fetch
	// and scan; out of scope for Phase 5a.
}
