import { expect, type Page, test } from "@playwright/test";
import { flagship, recipes, TENANT } from "./fixtures";
import { settle } from "./layout-shift";
import { type MockEngine, mockEngine } from "./mock-engine";

// What a reader loaded stays in the browser for 7 days. Every visit paints that
// copy at once, then checks the latest version in the background: unchanged →
// nothing more is fetched; changed → the latest replaces it and is cached in turn.
// Nothing reloads on its own — a reader who wants the latest refreshes.

let engine: MockEngine;
test.beforeEach(async ({ page }) => {
  engine = await mockEngine(page, { flagship, tenants: { recipes } });
});

const DAY = 86_400_000;
const article = (page: Page) => page.locator("article.prose");

async function visit(page: Page, url: string) {
  await page.goto(url);
  await settle(page);
}

// Flags if `text` is ever on the page, even for a frame.
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
  test(`${name}: a return visit paints the cached copy at once, even with a slow Engine`, async ({
    page,
  }) => {
    await visit(page, url);
    engine.latencyMs = 10_000;
    await page.goto(url);
    await expect(article(page).locator("h2").first()).toBeVisible({ timeout: 1500 });
    await expect(page.locator(".page-title .skeleton")).toHaveCount(0);
    await expect(page.locator(".page-meta .skeleton")).toHaveCount(0);
  });

  test(`${name}: an unchanged page costs one version check on return`, async ({
    page,
  }) => {
    await visit(page, url);
    engine.reset();
    await visit(page, url);
    // Who you are and which sign-ins exist aren't repo data; they're re-checked
    // in the background on every visit, without holding up the page.
    const identity = (r: string) => r.endsWith("/whoami") || r.endsWith("/auth/status");
    expect(engine.requests.filter((r) => !identity(r))).toEqual(["GET /version"]);
  });
}

test("a changed page shows the cached copy, then the latest, which is then cached", async ({
  page,
}) => {
  const url = TENANT("recipes", "/soup");
  await visit(page, url);

  engine.wiki(recipes.repo).files.soup = "# Soup\n\nNow with pepper.\n";
  const sawOld = await watchFor(page, "A warm bowl");
  await visit(page, url);
  await expect(article(page)).toContainText("Now with pepper");
  await expect(article(page)).not.toContainText("A warm bowl");
  expect(await sawOld()).toBe(true);

  engine.latencyMs = 10_000;
  await page.goto(url);
  await expect(article(page)).toContainText("Now with pepper", { timeout: 1500 });
});

test("a page created since the last visit turns its red links blue", async ({
  page,
}) => {
  await visit(page, TENANT("recipes"));
  await expect(article(page).locator('a[href$="/bread"]')).toHaveClass(/is-red/);

  engine.wiki(recipes.repo).files.bread = "# Bread\n\nSourdough.\n";
  await visit(page, TENANT("recipes"));
  await expect(article(page).locator('a[href$="/bread"]')).not.toHaveClass(/is-red/);
});

test("a deleted page stops being shown once the check says it's gone", async ({
  page,
}) => {
  const url = TENANT("recipes", "/soup");
  await visit(page, url);
  delete engine.wiki(recipes.repo).files.soup;
  await visit(page, url);
  await expect(page.locator(".wiki-status")).toContainText("No page named");
});

test("nothing older than 7 days is shown", async ({ page }) => {
  const url = TENANT("recipes", "/soup");
  await visit(page, url);
  await page.clock.setSystemTime(Date.now() + 8 * DAY);
  engine.latencyMs = 3_000;
  await page.goto(url);
  await page.waitForTimeout(1_000);
  await expect(article(page)).not.toContainText("A warm bowl");
  await expect(article(page)).toContainText("A warm bowl", { timeout: 10_000 });
});

test("your own published edit shows on the next visit", async ({ page }) => {
  const url = TENANT("recipes", "/soup");
  await visit(page, url);

  await page.goto(TENANT("recipes", "/edit/soup"));
  const body = page.locator("textarea.editor-textarea");
  await expect(body).toHaveValue(/A warm bowl/);
  await body.fill("# Soup\n\nNow with garlic.\n");
  await page.getByRole("button", { name: /publish/i }).click();
  await page.getByRole("button", { name: "Submit change" }).click();
  await expect(page.getByText(/published live/i)).toBeVisible({ timeout: 15_000 });

  await visit(page, url);
  await expect(article(page)).toContainText("Now with garlic");
});
