import { expect, type Page, test } from "@playwright/test";
import { flagship, recipes, TENANT } from "./fixtures";
import { cls, explain, recordShifts, settle, shifts } from "./layout-shift";
import { mockEngine } from "./mock-engine";

// Nothing on screen may move while a page loads its client-side content — not on
// a first visit (empty cache, everything over the network) and not on a return.
// Each case fails with the list of elements that moved and by how much.

// [name, url, where it lands — for a redirect]
const PAGES: [string, string, RegExp?][] = [
  ["the flagship home", "/"],
  ["a flagship article", "/how-it-works/"],
  ["a flagship article without notices", "/about/"],
  ["a flagship redirect", "/editing/", /\/help\/editing.*redirectedfrom=editing/],
  ["a hosted wiki's home", TENANT("recipes")],
  ["a hosted wiki's short article", TENANT("recipes", "/soup")],
];

test.beforeEach(async ({ page }) => {
  await recordShifts(page);
  await mockEngine(page, { flagship, tenants: { recipes } });
});

for (const [name, url, lands] of PAGES) {
  const visit = async (page: Page) => {
    await page.goto(url);
    if (lands) await page.waitForURL(lands);
    await settle(page);
  };

  test(`${name} doesn't shift on a first visit`, async ({ page }) => {
    await visit(page);
    const moved = await shifts(page);
    expect(cls(moved), explain(moved)).toBe(0);
  });

  test(`${name} doesn't shift on a return visit`, async ({ page }) => {
    await visit(page);
    await visit(page);
    const moved = await shifts(page);
    expect(cls(moved), explain(moved)).toBe(0);
  });
}
