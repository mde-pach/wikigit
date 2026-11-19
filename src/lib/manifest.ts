import { config } from "../config";
import { onSwapReset } from "./cache-reset";
import { resolveVersions } from "./content";
import { repoSlug } from "./engine";
import { readCached, readLatest, writeCached } from "./sha-cache";
import { engineFetch } from "./tenant";

// Set of all existing page slugs — powers wikilink resolution, red links,
// search, and backlinks. Kept per head sha, so it's only refetched after a commit.
let cache: Promise<Set<string>> | undefined;

const pagesKey = () => `${repoSlug()}:pages`;

export function pageSet(): Promise<Set<string>> {
  if (!cache) cache = load();
  return cache;
}

// The page set as this browser last saw it — synchronous, for a first-frame
// paint before the live version is known.
export function lastSeenPageSet(): Set<string> | undefined {
  const hit = readLatest<string[]>(pagesKey());
  return hit && new Set(hit.value);
}

// Re-fetch after an in-site edit so a newly created page stops being a red link.
onSwapReset(() => {
  cache = undefined;
});

async function load(): Promise<Set<string>> {
  if (!config.workerUrl) return new Set();
  try {
    const { sha } = await resolveVersions();
    const hit = readCached<string[]>(pagesKey(), sha);
    if (hit) return new Set(hit);
    const res = await engineFetch("/pages");
    if (!res.ok) return new Set();
    const { pages } = (await res.json()) as { pages: string[] };
    writeCached(pagesKey(), sha, pages);
    return new Set(pages);
  } catch {
    return new Set();
  }
}
