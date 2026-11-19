import { createSignal, onMount, Show } from "solid-js";
import { getHistory, lastSeenHistory, type Revision } from "../lib/history";
import { viewHref } from "../lib/paths";
import { tenantKnown } from "../lib/tenant";

// Rendered client-only from the live (or sha-cached) history: the build's git log
// is the flagship's, wrong on a hosted wiki and stale after any edit.
export default function PageMeta(props: { slug: string }) {
  const [hist, setHist] = createSignal<Revision[]>();
  // Paint what this browser last saw, then the live history (same text when
  // the page hasn't changed; the line is fixed-height, so a change can't shift).
  onMount(() => {
    if (tenantKnown()) setHist(lastSeenHistory(props.slug));
    getHistory(props.slug).then(setHist, () => {});
  });
  const last = () => hist()?.[0];
  // Collapse the home → /history (not /history/index, which Pages 308-strips) — W4.
  const historyHref = viewHref("history", props.slug);
  // Format from the ISO date's own Y-M-D parts (the author's calendar day), not
  // via toLocaleDateString — locale-dependent output would differ between readers.
  const editedOn = (iso?: string) => {
    const m = (iso ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
  };

  return (
    <div class="page-meta">
      <Show
        when={hist()}
        fallback={<span class="meta-skeleton skeleton" aria-hidden="true" />}
      >
        <Show when={last()} fallback={<span>Not yet saved</span>}>
          <span>Last edited by</span>
          <a class="pseudonym" href={historyHref}>
            {last()?.author}
          </a>
          <span class="dot">·</span>
          <a href={historyHref}>{editedOn(last()?.date)}</a>
          <span class="dot">·</span>
          <a href={historyHref}>{hist()?.length} revisions</a>
        </Show>
      </Show>
    </div>
  );
}
