import { config } from "../config";
import { onSwapReset } from "./cache-reset";
import { activeRepo, engineUrl, repoSlug } from "./engine";
import type { PageMeta } from "./frontmatter";
import { forgetCached, readCached, readLatest, writeCached } from "./sha-cache";
import { bootTenant } from "./tenant";

export class PageNotFoundError extends Error {
  constructor(public slug: string) {
    super(`Page not found: ${slug}`);
    this.name = "PageNotFoundError";
  }
}

// The head SHA plus a per-page content-version map (`slug → git blob sha`), so a
// build-time page can tell whether its baked copy is still current without
// fetching the file. The blob sha changes iff the page's bytes change.
export interface Versions {
  sha: string;
  versions: Record<string, string>;
}

// One resolution per page view, shared by the article, every transclusion and
// every hovercard (they'd otherwise each re-fetch). Cleared on the router swap
// that follows an in-site edit so the next view re-resolves the post-merge state.
let versionsCache: Promise<Versions> | undefined;
onSwapReset(() => {
  versionsCache = undefined;
});

// How long a reader trusts the version map it already holds before asking the
// Engine again. Within it a return visit paints entirely from cache; past it one
// small /version call decides what (if anything) changed. A write made through
// this site drops it at once (forgetVersions), so your own edits never wait.
const VERSIONS_FRESH_MS = 30_000;
const versionsKey = () => `${repoSlug()}:versions`;

// The cached version map when it's still fresh — synchronous, so a page can paint
// on its first frame. Call only once the tenant is known (see tenantKnown).
export function freshVersions(): Versions | undefined {
  const hit = readLatest<Record<string, string>>(versionsKey());
  if (!hit || hit.age > VERSIONS_FRESH_MS) return undefined;
  return { sha: hit.sha, versions: hit.value };
}

export function forgetVersions(): void {
  versionsCache = undefined;
  forgetCached(versionsKey());
}

export function resolveVersions(): Promise<Versions> {
  if (!versionsCache) {
    versionsCache = bootTenant().then(
      () => freshVersions() ?? resolveVersionsUncached().then(rememberVersions),
    );
    versionsCache.catch(() => {
      versionsCache = undefined;
    });
  }
  return versionsCache;
}

// A page as rendered from one exact file (its blob sha): the article HTML with
// its diagrams drawn but red links not yet resolved — those depend on the live
// page set, so they're marked at paint time. `raw` is absent for a copy made from
// the build's baked HTML. Diagrams are drawn per colour theme, hence `theme`.
export interface CachedPage {
  title: string;
  html: string;
  meta: PageMeta;
  raw?: string;
}

const pageKey = (slug: string, theme: string) => `${repoSlug()}:page:${theme}:${slug}`;

export function cachedPage(
  slug: string,
  blobSha: string,
  theme: string,
): CachedPage | undefined {
  return readCached<CachedPage>(pageKey(slug, theme), blobSha);
}

export function rememberPage(
  slug: string,
  blobSha: string,
  theme: string,
  page: CachedPage,
): void {
  writeCached(pageKey(slug, theme), blobSha, page);
}

function rememberVersions(v: Versions): Versions {
  // An empty map is the no-Engine fallback (head sha only): nothing to reuse.
  if (Object.keys(v.versions).length) writeCached(versionsKey(), v.sha, v.versions);
  return v;
}

// `no-store` stops the browser pinning a stale SHA after a merge; the in-flight
// memo above, not the HTTP cache, is what coalesces the per-view fan-out. Without
// a Worker we can still resolve the head SHA from GitHub, but not per-page blob
// shas — an empty map means every page is treated as stale (fetched), exactly the
// pre-staleness-check behavior.
async function resolveVersionsUncached(): Promise<Versions> {
  await bootTenant();
  if (config.workerUrl) {
    try {
      const res = await fetch(engineUrl("/version"), { cache: "no-store" });
      if (res.ok) return (await res.json()) as Versions;
    } catch {
      // fall back to the GitHub API below
    }
  }
  const { owner, name } = activeRepo();
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${name}/commits/${config.branch}`,
    { headers: { Accept: "application/vnd.github.sha" }, cache: "no-store" },
  );
  if (!res.ok) throw new Error(`Could not resolve latest commit (HTTP ${res.status}).`);
  return { sha: (await res.text()).trim(), versions: {} };
}

function cdnUrl(sha: string, slug: string): string {
  const path = `${config.contentDir}/${slug}.md`;
  const { owner, name } = activeRepo();
  return `https://cdn.jsdelivr.net/gh/${owner}/${name}@${sha}/${path}`;
}

// The live file, from the browser cache when its blob sha hasn't changed — so
// transclusions, hovercards and editors don't refetch an unchanged page.
export async function fetchMarkdown(slug: string): Promise<string> {
  const v = await resolveVersions();
  const blob = v.versions[slug];
  const key = `${repoSlug()}:raw:${slug}`;
  const hit = blob ? readCached<string>(key, blob) : undefined;
  if (hit !== undefined) return hit;
  const raw = await fetchMarkdownAt(slug, v.sha);
  if (blob) writeCached(key, blob, raw);
  return raw;
}

// Fetch a page pinned to a specific commit SHA (permalink to a revision).
export async function fetchMarkdownAt(slug: string, sha: string): Promise<string> {
  await bootTenant();
  const res = await fetch(cdnUrl(sha, slug));
  if (res.status === 404) throw new PageNotFoundError(slug);
  if (!res.ok) throw new Error(`Failed to fetch content (HTTP ${res.status}).`);
  return res.text();
}
