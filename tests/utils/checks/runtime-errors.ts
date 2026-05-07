import type { Page } from "@playwright/test";
import { recordFinding } from "../findings";
import type { Finding } from "../types";

/**
 * C3 — JS runtime errors + failed fetches.
 *
 * Factory that returns a `pageHook` for the crawler (see crawler.ts:498 —
 * hooks run BEFORE `page.goto` so listeners attach pre-navigation, which is
 * mandatory for catching pageerror / early console errors).
 *
 * URL attribution pattern
 * -----------------------
 * The crawler navigates many URLs through the same `Page`, so each finding
 * must be tagged with the URL of the page-under-test at the moment the event
 * fires — not the URL captured when the hook was installed.
 *
 * We accept a `getCurrentUrl: () => string` getter closure. The crawler calls
 * the hook once per page before each goto; the listeners it registers close
 * over `getCurrentUrl` so every subsequent event resolves the current URL
 * lazily. Callers that reuse the hook across navigations should update the
 * closure's backing state before each goto.
 *
 * Severity calibration (per plan C3)
 * ----------------------------------
 *   - `console.error`  same-origin -> error; external -> warn
 *   - `pageerror`      always same-origin semantically -> error
 *   - `requestfailed`  same-origin -> error; external -> warn
 *
 * Same-origin comparison uses `URL.origin` to avoid port-variation false
 * positives from naive string prefix matching.
 */

function sameOrigin(a: string, b: string): boolean {
	try {
		return new URL(a).origin === new URL(b).origin;
	} catch (e) {
		console.debug(`[recce-runtime] sameOrigin(${a}, ${b}) failed:`, e);
		return false;
	}
}

export function createRuntimeErrorHook(
	getCurrentUrl: () => string,
	project: Finding["project"],
): (page: Page) => Promise<void> {
	return async (page: Page): Promise<void> => {
		// Listeners are attached synchronously inside this async function; the
		// `await` return is a no-op but keeps the signature compatible with the
		// crawler's `pageHooks` contract.
		try {
			page.on("console", (msg) => {
				try {
					if (msg.type() !== "error") return;
					const current = getCurrentUrl();
					// console-error has no "origin" of its own; treat as same-origin
					// relative to the page under test.
					recordFinding({
						url: current,
						check: "console-error",
						severity: "error",
						message: `console.error: ${msg.text()}`,
						project,
					});
				} catch (e) {
					console.debug(`[recce-runtime] console listener failed:`, e);
				}
			});

			page.on("pageerror", (err) => {
				try {
					const current = getCurrentUrl();
					recordFinding({
						url: current,
						check: "pageerror",
						severity: "error",
						message: `pageerror: ${err?.message ?? String(err)}`,
						actual: err?.stack ? err.stack.split("\n")[0] : undefined,
						project,
					});
				} catch (e) {
					console.debug(`[recce-runtime] pageerror listener failed:`, e);
				}
			});

			page.on("requestfailed", (req) => {
				try {
					const current = getCurrentUrl();
					const reqUrl = req.url();
					// Skip data: and blob: URIs — they're internal and noisy.
					if (
						reqUrl.startsWith("data:") ||
						reqUrl.startsWith("blob:") ||
						reqUrl.startsWith("chrome-extension:")
					) {
						return;
					}
					const isSame = sameOrigin(reqUrl, current);
					const severity: Finding["severity"] = isSame ? "error" : "warn";
					const failure = req.failure();
					recordFinding({
						url: current,
						check: "requestfailed",
						severity,
						message: `requestfailed: ${reqUrl} — ${failure?.errorText ?? "(no reason)"}`,
						actual: failure?.errorText ?? undefined,
						project,
					});
				} catch (e) {
					console.debug(`[recce-runtime] requestfailed listener failed:`, e);
				}
			});
		} catch (e) {
			// Listener registration itself failing is unusual; surface it loudly.
			console.warn(`[recce-runtime] attaching listeners failed:`, e);
		}
	};
}
