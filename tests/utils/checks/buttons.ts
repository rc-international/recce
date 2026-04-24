import type { Page } from "@playwright/test";
import { recordFinding } from "../findings";
import type { Finding } from "../types";

/**
 * B5 — button / CTA health check.
 *
 * For every `button, [role="button"], a.btn, input[type="submit"],
 * input[type="button"]` that's visible, verify:
 *   - isEnabled()
 *   - accessible name is non-empty
 *   - computed `pointer-events` !== 'none'
 *
 * DOES NOT CLICK. Clicking would submit the waitlist form and pollute the
 * lead list. `isEnabled()` + pointer-events is the proxy.
 *
 * reCAPTCHA exemption:
 *   - Buttons inside `form[data-recaptcha]` are flagged `recaptcha-managed`
 *     at `info` severity, never `error`.
 *   - Buttons that transition enabled -> disabled within 500ms of the first
 *     observation are also flagged `recaptcha-managed` at `info`.
 *
 * Excluded:
 *   - `button[type="submit"]` inside a form with aria-busy="true"
 *   - buttons inside a hidden `<dialog>` behind `<body aria-hidden="true">`
 */

const SELECTOR =
	'button, [role="button"], a.btn, input[type="submit"], input[type="button"]';
const RECAPTCHA_OBSERVE_MS = 500;

type ButtonSnapshot = {
	index: number;
	tag: string;
	classes: string;
	typeAttr: string | null;
	text: string;
	ariaLabel: string | null;
	titleAttr: string | null;
	visible: boolean;
	enabled: boolean;
	pointerEventsNone: boolean;
	inRecaptchaForm: boolean;
	skip: boolean;
	skipReason: string;
};

async function snapshotButtons(page: Page): Promise<ButtonSnapshot[]> {
	return (await page.evaluate((sel) => {
		function isVisible(el: Element): boolean {
			const rect = (el as HTMLElement).getBoundingClientRect();
			const style = window.getComputedStyle(el);
			return (
				rect.width > 0 &&
				rect.height > 0 &&
				style.visibility !== "hidden" &&
				style.display !== "none"
			);
		}

		const out: Array<{
			index: number;
			tag: string;
			classes: string;
			typeAttr: string | null;
			text: string;
			ariaLabel: string | null;
			titleAttr: string | null;
			visible: boolean;
			enabled: boolean;
			pointerEventsNone: boolean;
			inRecaptchaForm: boolean;
			skip: boolean;
			skipReason: string;
		}> = [];

		const nodes = Array.from(document.querySelectorAll(sel));
		const bodyAriaHidden =
			document.body?.getAttribute("aria-hidden") === "true";

		for (let i = 0; i < nodes.length; i += 1) {
			const el = nodes[i] as HTMLElement;
			const style = window.getComputedStyle(el);
			const form = el.closest("form");
			const ariaBusy = form?.getAttribute("aria-busy") === "true";
			const inRecaptchaForm = !!el.closest("form[data-recaptcha]");
			const inHiddenDialog =
				bodyAriaHidden &&
				!!el.closest("dialog") &&
				(el.closest("dialog") as HTMLDialogElement | null)?.open !== true;

			const typeAttr = el.getAttribute("type");
			const isSubmit =
				typeAttr === "submit" ||
				(el.tagName === "BUTTON" && typeAttr !== "button");

			let skip = false;
			let skipReason = "";
			if (isSubmit && ariaBusy) {
				skip = true;
				skipReason = "submit inside aria-busy form";
			} else if (inHiddenDialog) {
				skip = true;
				skipReason = "inside hidden dialog with aria-hidden body";
			}

			const enabled =
				!(el as HTMLButtonElement).disabled &&
				!el.hasAttribute("disabled") &&
				el.getAttribute("aria-disabled") !== "true";

			out.push({
				index: i,
				tag: el.tagName.toLowerCase(),
				classes: el.className || "",
				typeAttr,
				text: (el.textContent || "").trim(),
				ariaLabel: el.getAttribute("aria-label"),
				titleAttr: el.getAttribute("title"),
				visible: isVisible(el),
				enabled,
				pointerEventsNone: style.pointerEvents === "none",
				inRecaptchaForm,
				skip,
				skipReason,
			});
		}
		return out;
	}, SELECTOR)) as ButtonSnapshot[];
}

function describeElement(b: ButtonSnapshot): Finding["element"] {
	const selector =
		b.classes.trim().length > 0
			? `${b.tag}.${b.classes.trim().split(/\s+/).join(".")}:nth-of-type(${b.index + 1})`
			: `${b.tag}:nth-of-type(${b.index + 1})`;
	return {
		tag: b.tag,
		selector,
		attr: {
			type: b.typeAttr ?? "",
			"aria-label": b.ariaLabel ?? "",
			title: b.titleAttr ?? "",
		},
	};
}

function accessibleName(b: ButtonSnapshot): string {
	return b.text || b.ariaLabel || b.titleAttr || "";
}

/**
 * Run the B5 button check for the current page state.
 */
export async function checkButtons(
	page: Page,
	options: { url: string; project: Finding["project"] },
): Promise<void> {
	const { url, project } = options;

	let first: ButtonSnapshot[] = [];
	try {
		first = await snapshotButtons(page);
	} catch (e) {
		console.debug(`[recce-buttons] snapshot(first) ${url} failed:`, e);
		return;
	}

	// Observe for reCAPTCHA-style enabled->disabled transitions.
	try {
		await page.waitForTimeout(RECAPTCHA_OBSERVE_MS);
	} catch (e) {
		console.debug(`[recce-buttons] observe sleep failed:`, e);
	}

	let second: ButtonSnapshot[] = [];
	try {
		second = await snapshotButtons(page);
	} catch (e) {
		console.debug(`[recce-buttons] snapshot(second) ${url} failed:`, e);
		second = first;
	}

	// Align by index — DOM shouldn't reshuffle within 500ms. If lengths
	// differ, fall back to the first snapshot for the overlap.
	const len = Math.min(first.length, second.length);

	for (let i = 0; i < len; i += 1) {
		const a = first[i];
		const b = second[i];
		if (a.skip) continue;
		if (!a.visible) continue;

		const transitionedToDisabled = a.enabled && !b.enabled;
		const recaptchaManaged = a.inRecaptchaForm || transitionedToDisabled;

		if (recaptchaManaged) {
			recordFinding({
				url,
				check: "recaptcha-managed",
				severity: "info",
				message: `button is reCAPTCHA-managed (${a.inRecaptchaForm ? "form[data-recaptcha]" : "enabled->disabled within 500ms"}): ${accessibleName(a) || "(no text)"}`,
				element: describeElement(a),
				project,
			});
			continue;
		}

		if (!b.enabled) {
			recordFinding({
				url,
				check: "button-disabled",
				severity: "error",
				message: `visible button is disabled: ${accessibleName(a) || "(no text)"}`,
				element: describeElement(a),
				expected: "enabled",
				actual: "disabled",
				project,
			});
			continue;
		}

		if (b.pointerEventsNone) {
			recordFinding({
				url,
				check: "button-pointer-events-none",
				severity: "error",
				message: `button pointer-events:none blocks clicks: ${accessibleName(a) || "(no text)"}`,
				element: describeElement(a),
				expected: "pointer-events != none",
				actual: "pointer-events: none",
				project,
			});
			continue;
		}

		if (!accessibleName(b).trim()) {
			recordFinding({
				url,
				check: "button-missing-name",
				severity: "warn",
				message: `button has no accessible name`,
				element: describeElement(a),
				expected: "innerText, aria-label, or title",
				actual: "(empty)",
				project,
			});
		}
	}
}
