import { onCleanup, onMount } from "solid-js";
import { config } from "../config";
import { getJson } from "../lib/api";
import { resolveVersions } from "../lib/content";
import { repoSlug } from "../lib/engine";
import { readCached, writeCached } from "../lib/sha-cache";

// noindex-until-patrolled: a page whose latest revision a maintainer hasn't
// patrolled gets a robots=noindex tag, so unreviewed edits don't get indexed.
// Client-side (the read path is static/CDN, no Worker) — JS-running crawlers
// honor it; it fails open, so a Worker hiccup never deindexes the wiki.
export default function PatrolMeta(props: { slug: string }) {
  if (!config.workerUrl) return null;

  let el: HTMLMetaElement | undefined;
  onMount(async () => {
    try {
      // A revision, once patrolled, stays patrolled: remember that per page sha
      // so an unchanged page isn't re-checked. "Not yet" is always re-asked.
      const blob = (await resolveVersions()).versions[props.slug];
      const key = `${repoSlug()}:patrolled:${props.slug}`;
      if (blob && readCached<boolean>(key, blob)) return;
      const { patrolled } = await getJson<{ patrolled: boolean }>(
        `/patrol-status?slug=${encodeURIComponent(props.slug)}`,
      );
      if (patrolled) {
        if (blob) writeCached(key, blob, true);
        return;
      }
      el = document.createElement("meta");
      el.name = "robots";
      el.content = "noindex";
      el.dataset.patrol = "1";
      document.head.appendChild(el);
    } catch {}
  });
  onCleanup(() => el?.remove());
  return null;
}
