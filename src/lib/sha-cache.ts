// Browser-side cache for data derived from git, each value stored with the sha it
// was read at. A visit paints the latest stored value at once (readLatest), then
// checks the live sha: a match (readCached) means nothing to refetch, a mismatch
// means fetch, replace, store. Entries live 7 days. Every access is guarded:
// storage can be full, disabled (private mode) or absent (SSR).

const PREFIX = "wikigit:c:";
const MAX_AGE_MS = 7 * 86_400_000;

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
    const e = raw ? (JSON.parse(raw) as Entry<T>) : undefined;
    return e && Date.now() - e.at <= MAX_AGE_MS ? e : undefined;
  } catch {
    return undefined;
  }
}

export function readCached<T>(key: string, sha: string): T | undefined {
  const e = readEntry<T>(key);
  return e && e.sha === sha ? e.value : undefined;
}

// The latest stored value whatever its sha — what a visit paints before it knows
// whether anything changed.
export function readLatest<T>(key: string): { sha: string; value: T } | undefined {
  const e = readEntry<T>(key);
  return e ? { sha: e.sha, value: e.value } : undefined;
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
