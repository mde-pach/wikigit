import { defineConfig, devices } from "@playwright/test";

// Browser tests against the production-shaped build (see `test:e2e`): the site is
// served as nginx would, and every *.wikigit.org host resolves to it, so the apex
// and tenant subdomains load exactly as on wikigit.org. The Engine and the
// content CDN are mocked per test (e2e/mock-engine.ts).
const PORT = 4329;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: `http://wikigit.org:${PORT}`,
    launchOptions: {
      args: [
        "--host-resolver-rules=MAP wikigit.org 127.0.0.1, MAP *.wikigit.org 127.0.0.1",
      ],
    },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: `PORT=${PORT} bun e2e/serve.ts`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
  },
});
