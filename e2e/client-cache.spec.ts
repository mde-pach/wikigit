import { expect, type Page, test } from "@playwright/test";
import { flagship, recipes, TENANT } from "./fixtures";
import { settle } from "./layout-shift";
import { type MockEngine, mockEngine } from "./mock-engine";

// What a reader already loaded stays in the browser, keyed by the git sha it came
// from: a return visit reuses it instead of going back to the Engine and the CDN,
// and only a changed sha triggers a reload.

let engine: MockEngine;
test.beforeEach(async ({ page }) => {
  engine = await mockEngine(page, { flagship, tenants: { recipes } });
});

// Shortly after the visit the cached versions count as fresh; past this they're
// re-checked. Comfortably beyond any freshness window the reader uses.
const LATER = 10 * 60_000;

async function visitTwice(page: Page, url: string) {
  await page.goto(url);
  await settle(page);
  engine.reset();
  await page.goto(url);
  await settle(page);
}

// Flags if `text` is ever inserted into the page — catches a stale copy painted
// for a single frame before being replaced.
async function watchFor(page: Page, text: string) {
  await page.addInitScript((t) => {
    (window as unknown as { __seen: boolean }).__seen = false;
    new MutationObserver(() => {
      if (document.body?.textContent?.includes(t))
        (window as unknown as { __seen: boolean }).__seen = true;
    }).observe(document, { childList: true, subtree: true, characterData: true });
  }, text);
  return () => page.evaluate(() => (window as unknown as { __seen: boolean }).__seen);
}

for (const [name, url] of [
  ["a flagship article", "/how-it-works/"],
  ["a hosted wiki page", TENANT("recipes")],
] as const) {
  test(`${name}: a return visit makes no Engine or CDN calls`, async ({ page }) => {
    await visitTwice(page, url);
    // Who you are and which sign-ins exist aren't repo data — they're re-checked
    // in the background on every visit, without holding up the page.
    const identity = (r: string) => r.endsWith("/whoami") || r.endsWith("/auth/status");
    expect(engine.requests.filter((r) => !identity(r))).toEqual([]);
  });

  test(`${name}: a return visit paints at once, even with a slow Engine`, async ({
    page,
  }) => {
    await page.goto(url);
    await settle(page);
    engine.latencyMs = 10_000;
    await page.goto(url);
    await expect(page.locator("article.prose h2").first()).toBeVisible({
      timeout: 1500,
    });
    await expect(page.locator(".page-title .skeleton")).toHaveCount(0);
    await expect(page.locator(".page-meta .skeleton")).toHaveCount(0);
  });
}

test("after the freshness window an unchanged page costs one version check", async ({
  page,
}) => {
  const url = TENANT("recipes", "/soup");
  await page.goto(url);
  await settle(page);
  engine.reset();
  await page.clock.setSystemTime(Date.now() + LATER);
  await page.goto(url);
  await settle(page);
  expect(engine.hits("/version")).toBe(1);
  expect(engine.hits("cdn/")).toBe(0);
  await expect(page.locator("article.prose")).toContainText("A warm bowl");
});

test("a page changed since the last visit is reloaded without flashing the old text", async ({
  page,
}) => {
  const url = TENANT("recipes", "/soup");
  await page.goto(url);
  await settle(page);

  engine.wiki(recipes.repo).files.soup = "# Soup\n\nNow with pepper.\n";
  const sawOld = await watchFor(page, "A warm bowl");
  await page.clock.setSystemTime(Date.now() + LATER);
  await page.goto(url);
  await settle(page);
  await expect(page.locator("article.prose")).toContainText("Now with pepper");
  expect(await sawOld()).toBe(false);
});

test("a page created since the last visit turns its red links blue", async ({
  page,
}) => {
  await page.goto(TENANT("recipes"));
  await settle(page);
  await expect(page.locator('article.prose a[href$="/bread"]')).toHaveClass(/is-red/);

  engine.wiki(recipes.repo).files.bread = "# Bread\n\nSourdough.\n";
  await page.clock.setSystemTime(Date.now() + LATER);
  await page.goto(TENANT("recipes"));
  await settle(page);
  await expect(page.locator('article.prose a[href$="/bread"]')).not.toHaveClass(
    /is-red/,
  );
});

test("your own published edit shows right away, cache or not", async ({ page }) => {
  const url = TENANT("recipes", "/soup");
  await page.goto(url);
  await settle(page);

  await page.goto(TENANT("recipes", "/edit/soup"));
  const body = page.locator("textarea.editor-textarea");
  await expect(body).toHaveValue(/A warm bowl/);
  await body.fill("# Soup\n\nNow with garlic.\n");
  await page.getByRole("button", { name: /publish/i }).click();
  await page.getByRole("button", { name: "Submit change" }).click();
  await expect(page.getByText(/published live/i)).toBeVisible({ timeout: 15_000 });

  await page.goto(url);
  await settle(page);
  await expect(page.locator("article.prose")).toContainText("Now with garlic");
});
