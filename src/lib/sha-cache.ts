// Browser-side cache for data derived from git: each value is stored with the sha
// it was read at, and is only handed back while that sha is still current — so a
// return visit reuses it instead of refetching, and a new commit invalidates it
// without any expiry bookkeeping. Every access is guarded: storage can be full,
// disabled (private mode) or absent (SSR), and the reader must work regardless.

const PREFIX = "wikigit:c:";

interface Entry<T> {
  sha: string;
  at: number;
  value: T;
}

function storage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function readEntry<T>(key: string): Entry<T> | undefined {
  try {
    const raw = storage()?.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as Entry<T>) : undefined;
  } catch {
    return undefined;
  }
}

export function readCached<T>(key: string, sha: string): T | undefined {
  const e = readEntry<T>(key);
  return e && e.sha === sha ? e.value : undefined;
}

// The latest entry regardless of sha, with its age — for the one value that is
// itself the source of shas (the version map), which is trusted for a short while.
export function readLatest<T>(
  key: string,
): { sha: string; age: number; value: T } | undefined {
  const e = readEntry<T>(key);
  return e ? { sha: e.sha, age: Date.now() - e.at, value: e.value } : undefined;
}

export function writeCached<T>(key: string, sha: string, value: T): void {
  const s = storage();
  if (!s) return;
  const raw = JSON.stringify({ sha, at: Date.now(), value } satisfies Entry<T>);
  try {
    s.setItem(PREFIX + key, raw);
  } catch {
    // Full: drop the older half of our entries and try once more.
    evictOldest(s);
    try {
      s.setItem(PREFIX + key, raw);
    } catch {}
  }
}

export function forgetCached(key: string): void {
  try {
    storage()?.removeItem(PREFIX + key);
  } catch {}
}

function evictOldest(s: Storage): void {
  const ours: { key: string; at: number }[] = [];
  for (let i = 0; i < s.length; i++) {
    const key = s.key(i);
    if (!key?.startsWith(PREFIX)) continue;
    try {
      ours.push({
        key,
        at: (JSON.parse(s.getItem(key) ?? "{}") as Entry<unknown>).at ?? 0,
      });
    } catch {
      ours.push({ key, at: 0 });
    }
  }
  ours.sort((a, b) => a.at - b.at);
  for (const { key } of ours.slice(0, Math.ceil(ours.length / 2))) s.removeItem(key);
}
