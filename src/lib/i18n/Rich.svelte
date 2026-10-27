<!--
  A message with markup in the middle (index.ts: parts). Formatting tags in
  the message (<strong>, <kbd>, <code>…) become those elements; any other tag
  is drawn by the snippet of that name, given its text:

    <Rich key="onboarding.shortcutsAside" params={{ mod: MOD }} />
    <Rich key="onboarding.createTag" params={{ q }}>
      {#snippet tag(text: string)}<strong class="tag">#{text}</strong>{/snippet}
    </Rich>

  The elements Rich makes itself belong to Rich, so the parent's scoped CSS
  doesn't reach them: when the parent styles the tag (`.aside kbd`), pass a
  snippet for it instead, which is drawn in the parent's scope.
  A tag with neither (a translator's mistake) shows as its plain text.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { parts, type MessageKey, type Params, type Part, type PluralKey } from './index';

  let {
    key,
    params,
    ...snippets
  }: { key: MessageKey; params?: Params; [tag: string]: Snippet<[string]> | MessageKey | Params | undefined } = $props();

  const ELEMENTS = new Set(['b', 'strong', 'em', 'i', 'kbd', 'code', 'u', 's', 'mark', 'small', 'sub', 'sup']);
  const snippet = (tag: string) => snippets[tag] as Snippet<[string]> | undefined;
  const pieces = $derived(parts(key as PluralKey, params as Params & { count: number }) as Part[]);

  $effect(() => {
    if (!import.meta.env.DEV) return;
    for (const p of pieces) if (p.tag !== undefined && !snippet(p.tag) && !ELEMENTS.has(p.tag)) console.warn(`i18n: "${key}" has <${p.tag}> but Rich has no snippet for it`);
  });
</script>

{#each pieces as p, i (i)}{#if p.tag === undefined}{p.text}{:else if snippet(p.tag)}{@render snippet(p.tag)!(p.text)}{:else if ELEMENTS.has(p.tag)}<svelte:element this={p.tag}>{p.text}</svelte:element>{:else}{p.text}{/if}{/each}
