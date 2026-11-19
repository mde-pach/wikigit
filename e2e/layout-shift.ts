import type { Page } from "@playwright/test";

// Records every layout shift from navigation start (buffered, so shifts before the
// observer attached count too), with the elements that moved — so a failing test
// says *what* jumped, not just a score.

export interface Shift {
  value: number;
  at: number;
  moved: { node: string; from: string; to: string }[];
}

declare global {
  interface Window {
    __shifts: Shift[];
  }
}

export async function recordShifts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__shifts = [];
    const describe = (n: Node | null) => {
      if (!(n instanceof Element)) return n?.nodeName ?? "?";
      const id = n.id ? `#${n.id}` : "";
      const cls = n.classList.length
        ? `.${[...n.classList].slice(0, 3).join(".")}`
        : "";
      return `${n.tagName.toLowerCase()}${id}${cls}`;
    };
    const rect = (r: DOMRectReadOnly) =>
      `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as {
        value: number;
        startTime: number;
        hadRecentInput: boolean;
        sources: {
          node: Node | null;
          previousRect: DOMRectReadOnly;
          currentRect: DOMRectReadOnly;
        }[];
      }[]) {
        if (e.hadRecentInput) continue;
        window.__shifts.push({
          value: e.value,
          at: Math.round(e.startTime),
          moved: e.sources.map((s) => ({
            node: describe(s.node),
            from: rect(s.previousRect),
            to: rect(s.currentRect),
          })),
        });
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
}

// Wait until the page has finished loading its client-side content: the article
// body replaced its skeleton and no request has completed for a while. (Not
// Playwright's "networkidle", which can hang after a scripted redirect.)
export async function settle(page: Page): Promise<void> {
  await page.waitForSelector("article.prose > div:not(.sk-article), .wiki-status");
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __n?: number; __t?: number };
      const n = performance.getEntriesByType("resource").length;
      if (w.__n !== n) {
        w.__n = n;
        w.__t = performance.now();
        return false;
      }
      return performance.now() - (w.__t ?? 0) > 600;
    },
    null,
    { polling: 100 },
  );
}

export async function shifts(page: Page): Promise<Shift[]> {
  return page.evaluate(() => window.__shifts);
}

export const cls = (list: Shift[]) => list.reduce((n, s) => n + s.value, 0);

export function explain(list: Shift[]): string {
  return list
    .map(
      (s) =>
        `+${s.value.toFixed(4)} @${s.at}ms\n${s.moved
          .map((m) => `    ${m.node}: ${m.from} → ${m.to}`)
          .join("\n")}`,
    )
    .join("\n");
}
