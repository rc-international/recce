import type { Page } from "@playwright/test";
import { recordFinding } from "../findings";
import type { Finding } from "../types";

/**
 * C4 — content-quality leaks.
 *
 * Regexes built ONCE at module load to avoid per-page recompilation. Exported
 * via `CONTENT_QUALITY_REGEXES` so unit tests can exercise each regex in
 * isolation without needing a browser.
 *
 * Subtree stripping
 * -----------------
 * The #1 failure mode for these heuristics is false positives from inline
 * docs and code samples (e.g. `<pre>const x = undefined;</pre>`). The content
 * check runs a single `page.$$eval` that walks the body, removes every
 * `<code>`, `<pre>`, `<script>`, `<style>` subtree, and returns the cleaned
 * text. All regexes run against that cleaned text.
 *
 * Severity calibration (per plan C4)
 * ----------------------------------
 *   - lorem, handlebars, templateLiteral, objectObject -> error
 *   - undefinedLiteral, nanLiteral, nullLiteral -> warn (false positives
 *     possible in legitimate copy)
 *   - empty h1/h2/h3 -> warn
 */

export const CONTENT_QUALITY_REGEXES = {
	lorem: /\bLorem ipsum\b/i,
	handlebars: /\{\{[\w.]+\}\}/,
	templateLiteral: /\$\{[\w.]+\}/,
	undefinedLiteral: /\bundefined\b/,
	nanLiteral: /\bNaN\b/,
	nullLiteral: /\bnull\b/,
	objectObject: /\[object Object\]/,
} as const;

type RegexKey = keyof typeof CONTENT_QUALITY_REGEXES;

const SEVERITY_BY_KEY: Record<RegexKey, Finding["severity"]> = {
	lorem: "error",
	handlebars: "error",
	templateLiteral: "error",
	undefinedLiteral: "warn",
	nanLiteral: "warn",
	nullLiteral: "warn",
	objectObject: "error",
};

const CHECK_BY_KEY: Record<RegexKey, string> = {
	lorem: "content-lorem",
	handlebars: "content-handlebars",
	templateLiteral: "content-template",
	undefinedLiteral: "content-undefined-literal",
	nanLiteral: "content-undefined-literal", // same check name, separate regex
	nullLiteral: "content-undefined-literal",
	objectObject: "content-object-object",
};

/**
 * Return body text with `<code>`, `<pre>`, `<script>`, `<style>` subtrees
 * removed. Also returns the non-whitespace text content of every h1/h2/h3.
 *
 * Runs in a single `page.evaluate` round-trip for performance.
 */
async function extractCleanedBody(page: Page): Promise<{
	text: string;
	emptyHeadings: { tag: string; index: number }[];
}> {
	return (await page.evaluate(() => {
		const body = document.body;
		if (!body) return { text: "", emptyHeadings: [] };

		// Clone the body so we can destructively strip without mutating the page.
		const clone = body.cloneNode(true) as HTMLElement;
		const strip = clone.querySelectorAll("code, pre, script, style, template");
		for (const el of Array.from(strip)) {
			el.parentNode?.removeChild(el);
		}
		const text = (clone.textContent || "").replace(/\s+/g, " ").trim();

		// Empty-heading detection runs against the ORIGINAL body (headings can
		// legitimately not contain code blocks, but if they did we'd still want
		// to know the heading is structurally empty of user-visible text).
		const headings = body.querySelectorAll("h1, h2, h3");
		const emptyHeadings: { tag: string; index: number }[] = [];
		let idx = 0;
		for (const h of Array.from(headings)) {
			const inner = (h.textContent || "").trim();
			if (inner.length === 0) {
				emptyHeadings.push({ tag: h.tagName.toLowerCase(), index: idx });
			}
			idx += 1;
		}
		return { text, emptyHeadings };
	})) as { text: string; emptyHeadings: { tag: string; index: number }[] };
}

/**
 * Scan rendered body text for quality leaks. Emits per-check findings via
 * the shared `recordFinding` sink.
 */
export async function checkContentQuality(
	page: Page,
	options: { url: string; project: Finding["project"] },
): Promise<void> {
	const { url, project } = options;

	let payload: {
		text: string;
		emptyHeadings: { tag: string; index: number }[];
	};
	try {
		payload = await extractCleanedBody(page);
	} catch (e) {
		console.debug(`[recce-content] extractCleanedBody ${url} failed:`, e);
		return;
	}

	const { text, emptyHeadings } = payload;

	// Track which checks we've emitted so we don't spam the same category per
	// page — one finding per (check, url) pair captures the signal.
	const emitted = new Set<string>();

	const keys: RegexKey[] = [
		"lorem",
		"handlebars",
		"templateLiteral",
		"objectObject",
		"undefinedLiteral",
		"nanLiteral",
		"nullLiteral",
	];

	for (const key of keys) {
		try {
			const re = CONTENT_QUALITY_REGEXES[key];
			const match = text.match(re);
			if (!match) continue;
			const check = CHECK_BY_KEY[key];
			if (emitted.has(check)) continue;
			emitted.add(check);
			recordFinding({
				url,
				check,
				severity: SEVERITY_BY_KEY[key],
				message: `content-quality leak (${key}): "${match[0]}" found in body text`,
				actual: match[0],
				project,
			});
		} catch (e) {
			console.debug(`[recce-content] regex ${key} failed on ${url}:`, e);
		}
	}

	for (const h of emptyHeadings) {
		try {
			recordFinding({
				url,
				check: "content-empty-heading",
				severity: "warn",
				message: `empty <${h.tag}> (no non-whitespace text content)`,
				element: { tag: h.tag },
				expected: "non-empty heading text",
				actual: "(whitespace only)",
				project,
			});
		} catch (e) {
			console.debug(`[recce-content] empty-heading record failed:`, e);
		}
	}
}
