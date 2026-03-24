# Recce - Architectural Context & Intent

## Overview
**Recce** (short for reconnaissance) is a standalone, decoupled end-to-end (E2E) testing suite designed for the Valors platform. It is intentionally separated from the main application repository to ensure that testing dependencies do not bloat the production build and that the testing lifecycle remains independent of the deployment pipeline.

## Rationale for Separation
1. **Zero Production Overhead**: Playwright and its browser binaries are heavy. Keeping them in a separate repo ensures they never touch the main app's `node_modules` or build artifacts.
2. **Decoupled Lifecycles**: Daily sanity checks can run on a schedule (e.g., 8 AM UTC) without triggering the main app's CI/CD or requiring a new deployment.
3. **Environment Agnostic**: The suite is designed to "recon" any environment (Local, Staging, Production) simply by providing a `BASE_URL`.

## The "Crawl & Sample" Strategy
Unlike traditional E2E tests that follow hardcoded user flows, Recce uses a dynamic discovery approach to ensure broad coverage of a rapidly changing directory platform.

### 1. Dynamic Discovery (Crawl)
The suite visits the homepage and extracts all unique internal links. This allows the test to automatically "find" new city pages, category pages, or business listings as they are added to the platform.

### 2. Seed URL Fallback
To mitigate risks where the crawler might be blocked (e.g., by a WAF or rate limiting) or if the homepage structure changes, the suite includes a list of "Seed URLs". These are high-value, representative paths (e.g., `/directory/en/colombia/antioquia/medellin/cafe`) that ensure the test always has a baseline of critical pages to verify.

### 3. Random Sampling
Visiting every page in a large directory is inefficient and risks being flagged as a bot. Recce selects **10+ random URLs** from the combined pool of discovered and seed URLs. This provides a statistically significant "pulse check" of the site's health every day.

## Verification Criteria
For every sampled URL, Recce verifies:
- **HTTP 200 Status**: The page is reachable and not throwing server errors.
- **Structural Integrity**: Core UI components (specifically `<header>` and `<footer>`) are visible, ensuring the layout has rendered correctly.
- **Load Performance**: Page load times are measured and logged for trend analysis in Playwright reports.

## Resiliency Features
- **Rate Limit Handling**: The suite includes a 1-second delay between requests and gracefully "soft-fails" (logs a warning instead of failing the test) if it encounters an HTTP 429 (Too Many Requests) error, which is common when running automated tools against production environments.
- **Cross-Browser Coverage**: Configured to run across Chromium, Firefox (Webkit), and Mobile Chrome to catch browser-specific regressions.
