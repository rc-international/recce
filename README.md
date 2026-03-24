# Recce - E2E Sanity Suite

Standalone Playwright-based testing suite for Valors. This suite is designed to perform daily "pulse checks" against a deployed environment without being tied to the application source code.

## Strategy
1. **Dynamic Discovery**: Crawls the home page of the target `BASE_URL` to find internal links.
2. **Seed Fallback**: Uses hardcoded critical paths to ensure core pages are tested even if crawling fails.
3. **Random Sampling**: Picks 10 unique URLs to visit and verify.
4. **Health Check**: Asserts HTTP 200 responses and ensures basic UI components (Header/Footer) are visible.

## Getting Started

### Local Setup
```bash
# Install dependencies
npm install

# Install Playwright browsers
npx playwright install --with-deps
```

### Running Tests
By default, tests target `http://localhost:3000`. You can override this using the `BASE_URL` environment variable.

```bash
# Test local dev server
npm run test

# Test production/staging
BASE_URL=https://valors.io npm run test
```

## CI/CD
The suite is configured to run daily via GitHub Actions. It can also be triggered manually with a custom URL.
- **Workflow**: `.github/workflows/daily-sanity.yml`
- **Variable**: Set `PRODUCTION_URL` in your GitHub Repository Variables to configure the default target.
