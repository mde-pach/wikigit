import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Page, Route } from "@playwright/test";
import { parse as parseYaml } from "yaml";
import {
  buildNode,
  graphFromMap,
  type IndexMap,
  searchDocsFromMap,
} from "../worker/src/indexlib";

// The hosted Engine (api.wikigit.org) and the content CDN (jsDelivr), answered
// from in-memory repos via Playwright's request interception. Each response waits
// `latencyMs` so client-side loading behaves like it does over a real network.

export type Files = Record<string, string>; // slug → raw markdown

export interface Wiki {
  repo: string; // owner/name
  files: Files;
  config?: Record<string, unknown>;
}

const blobSha = (raw: string) => {
  const bytes = Buffer.from(raw, "utf8");
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
};

export function repoContent(): Files {
  const dir = join(import.meta.dirname, "..", "content");
  const files: Files = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md"))
        files[relative(dir, p).slice(0, -3)] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return files;
}

function frontmatter(raw: string): Record<string, unknown> {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  return (parseYaml(m[1]) as Record<string, unknown>) ?? {};
}

function indexOf(files: Files): IndexMap {
  const map: IndexMap = {};
  for (const [slug, raw] of Object.entries(files)) {
    const meta = frontmatter(raw);
    map[slug] = buildNode(
      slug,
      raw,
      typeof meta.redirect === "string" ? meta.redirect : undefined,
      typeof meta.translationKey === "string" ? meta.translationKey : undefined,
      Array.isArray(meta.tags) ? (meta.tags as string[]) : undefined,
    );
  }
  return map;
}

function headSha(files: Files): string {
  const h = createHash("sha1");
  for (const slug of Object.keys(files).sort()) h.update(slug).update(files[slug]);
  return h.digest("hex");
}

export interface MockEngine {
  requests: string[];
  // This test's own copy of a wiki, to change content between visits.
  wiki(repo: string): Wiki;
  latencyMs: number;
  // Engine/CDN calls since the last reset, as "METHOD path" without the query.
  hits(pathOrHost: string): number;
  reset(): void;
}

export async function mockEngine(
  page: Page,
  opts: {
    flagship: Wiki;
    tenants?: Record<string, Wiki>; // subdomain label → wiki
    latencyMs?: number;
  },
): Promise<MockEngine> {
  const requests: string[] = [];
  const byRepo = new Map<string, Wiki>();
  const tenants: Record<string, Wiki> = {};
  byRepo.set(opts.flagship.repo, structuredClone(opts.flagship));
  for (const [label, w] of Object.entries(opts.tenants ?? {})) {
    tenants[label] = structuredClone(w);
    byRepo.set(w.repo, tenants[label]);
  }
  const engine: MockEngine = {
    requests,
    latencyMs: opts.latencyMs ?? 250,
    wiki: (repo) => byRepo.get(repo) as Wiki,
    hits: (p) => requests.filter((r) => r.includes(p)).length,
    reset: () => {
      requests.length = 0;
    },
  };

  const reply = async (route: Route, status: number, body: unknown) => {
    await new Promise((r) => setTimeout(r, engine.latencyMs));
    const text = typeof body === "string" ? body : JSON.stringify(body);
    await route
      .fulfill({
        status,
        body: text,
        contentType: typeof body === "string" ? "text/plain" : "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
      })
      // The page may have navigated away (a redirect) while we waited.
      .catch(() => {});
  };

  await page.route("https://api.wikigit.org/**", async (route) => {
    const url = new URL(route.request().url());
    requests.push(`${route.request().method()} ${url.pathname}`);
    const wiki = byRepo.get(url.searchParams.get("repo") ?? opts.flagship.repo);
    const files = wiki?.files ?? {};
    const index = indexOf(files);

    switch (url.pathname) {
      case "/resolve": {
        const host = (url.searchParams.get("host") ?? "").split(":")[0];
        const label = host.endsWith(".wikigit.org") ? host.split(".")[0] : "";
        const t = tenants[label];
        return t
          ? reply(route, 200, { name: label, repo: t.repo, lane: "platform" })
          : reply(route, 404, { error: "No wiki registered for this address." });
      }
      case "/version":
        return reply(route, 200, {
          sha: headSha(files),
          versions: Object.fromEntries(
            Object.entries(files).map(([s, raw]) => [s, blobSha(raw)]),
          ),
        });
      case "/latest":
        return reply(route, 200, { sha: headSha(files) });
      case "/pages":
        return reply(route, 200, { pages: Object.keys(files).sort() });
      case "/config":
        return reply(route, 200, { config: wiki?.config ?? {} });
      case "/search-index":
        return reply(route, 200, { docs: searchDocsFromMap(index) });
      case "/link-graph":
        return reply(route, 200, graphFromMap(index, "index"));
      case "/whoami":
        return reply(route, 200, {
          author: "anon-0123456789abcdef",
          tier: "open",
          avatar: null,
          isAnon: true,
        });
      case "/auth/status":
        return reply(route, 200, { providers: { github: true, wikigit: true } });
      case "/patrol-status":
        return reply(route, 200, { patrolled: true, sha: null });
      case "/edit": {
        const { slug, content } = route.request().postDataJSON() as {
          slug: string;
          content: string;
        };
        files[slug] = content;
        return reply(route, 200, { live: true, author: "anon-0123456789abcdef" });
      }
      case "/history":
        return reply(route, 200, {
          revisions: [
            {
              sha: headSha(files),
              parent: null,
              author: "alice",
              date: "2026-11-01T10:00:00Z",
              message: "Edit",
            },
          ],
          hasMore: false,
        });
      default:
        return reply(route, 404, { error: "Not found" });
    }
  });

  await page.route("https://cdn.jsdelivr.net/gh/**", async (route) => {
    const url = new URL(route.request().url());
    requests.push(`GET cdn${url.pathname}`);
    const m = url.pathname.match(
      /^\/gh\/([^/]+)\/([^@]+)@[0-9a-f]+\/content\/(.+)\.md$/,
    );
    const raw = m ? byRepo.get(`${m[1]}/${m[2]}`)?.files[m[3]] : undefined;
    return raw === undefined ? reply(route, 404, "Not found") : reply(route, 200, raw);
  });

  return engine;
}
