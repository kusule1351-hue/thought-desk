<script lang="ts">
  /**
   * Markdown from the model, drawn without ever becoming HTML.
   *
   * What the assistant writes was shaped by notes and files it read, so it is
   * untrusted. The text is lexed with marked and the tokens are walked into
   * ordinary Svelte markup: no {@html}, no innerHTML, no rendered output from
   * marked. HTML in the text is shown as the characters it is; only http,
   * https and mailto links are links; images are never fetched (their
   * description is shown instead).
   */
  import { Lexer, type Token, type Tokens } from 'marked';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { t } from '../../i18n';
  import { store } from '../../store.svelte';
  import { ui } from '../../ui.svelte';
  import { pageTitled } from '../notes';

  let { text }: { text: string } = $props();

  /** Lexed again on every streamed chunk: cheap at the length of an answer. */
  const tokens = $derived.by((): Token[] | null => {
    try {
      // A line break is kept as one: cards and short lines a model writes one under another stay that way.
      return new Lexer({ gfm: true, breaks: true }).lex(text);
    } catch {
      return null;
    }
  });

  const LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
  /** The address of a link when it is one we open, else null (the text is shown plain). */
  function safeHref(href: string | undefined): string | null {
    if (!href) return null;
    try {
      const url = new URL(href);
      return LINK_PROTOCOLS.has(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  }

  function follow(e: MouseEvent, href: string) {
    e.preventDefault();
    openUrl(href).catch(ui.error);
  }

  /** A stretch of text split into plain pieces and [[Title]] links that resolve to a note. */
  type Piece = { text: string; page?: string };
  const PAGE_LINK = /\[\[([^[\]\n]{1,200})\]\]/g;
  function pieces(source: string): Piece[] {
    const out: Piece[] = [];
    let last = 0;
    for (const m of source.matchAll(PAGE_LINK)) {
      const page = pageTitled(m[1]);
      if (!page) continue;
      if (m.index > last) out.push({ text: source.slice(last, m.index) });
      out.push({ text: m[1], page });
      last = m.index + m[0].length;
    }
    if (last < source.length) out.push({ text: source.slice(last) });
    return out;
  }

  const ALIGNS = new Set(['left', 'center', 'right']);
  const align = (a: string | null | undefined) => (a && ALIGNS.has(a) ? a : undefined);
</script>

{#snippet inline(list: Token[] | undefined, inLink: boolean)}
  {#each list ?? [] as tok, i (i)}
    {#if tok.type === 'text' || tok.type === 'escape'}
      {@const x = tok as Tokens.Text}
      {#if x.tokens && x.tokens.length}
        {@render inline(x.tokens, inLink)}
      {:else if inLink}
        {x.text}
      {:else}
        {#each pieces(x.text) as p, j (j)}
          {#if p.page}
            {@const id = p.page}
            <button class="page-link" onclick={() => store.open(id)}>{p.text}</button>
          {:else}
            {p.text}
          {/if}
        {/each}
      {/if}
    {:else if tok.type === 'strong'}
      <strong>{@render inline((tok as Tokens.Strong).tokens, inLink)}</strong>
    {:else if tok.type === 'em'}
      <em>{@render inline((tok as Tokens.Em).tokens, inLink)}</em>
    {:else if tok.type === 'del'}
      <del>{@render inline((tok as Tokens.Del).tokens, inLink)}</del>
    {:else if tok.type === 'codespan'}
      <code>{(tok as Tokens.Codespan).text}</code>
    {:else if tok.type === 'br'}
      <br />
    {:else if tok.type === 'link'}
      {@const l = tok as Tokens.Link}
      {@const href = safeHref(l.href)}
      {#if href}
        <a {href} onclick={(e) => follow(e, href)}>{@render inline(l.tokens, true)}</a>
      {:else}
        {@render inline(l.tokens, true)}
      {/if}
    {:else if tok.type === 'image'}
      {(tok as Tokens.Image).text}
    {:else if tok.type === 'html'}
      {(tok as Tokens.HTML).text}
    {:else if 'raw' in tok && typeof tok.raw === 'string'}
      {tok.raw}
    {/if}
  {/each}
{/snippet}

{#snippet blocks(list: Token[] | undefined)}
  {#each list ?? [] as tok, i (i)}
    {#if tok.type === 'paragraph'}
      <p>{@render inline((tok as Tokens.Paragraph).tokens, false)}</p>
    {:else if tok.type === 'text'}
      {@const x = tok as Tokens.Text}
      <p class="tight">{@render inline(x.tokens ?? [x], false)}</p>
    {:else if tok.type === 'heading'}
      <p class="heading">{@render inline((tok as Tokens.Heading).tokens, false)}</p>
    {:else if tok.type === 'code'}
      <pre><code>{(tok as Tokens.Code).text}</code></pre>
    {:else if tok.type === 'blockquote'}
      <blockquote>{@render blocks((tok as Tokens.Blockquote).tokens)}</blockquote>
    {:else if tok.type === 'list'}
      {@const l = tok as Tokens.List}
      {#if l.ordered}
        <ol start={typeof l.start === 'number' ? l.start : undefined}>
          {#each l.items as item, j (j)}
            <li class:task={item.task}>{@render blocks(item.tokens)}</li>
          {/each}
        </ol>
      {:else}
        <ul>
          {#each l.items as item, j (j)}
            <li class:task={item.task}>{@render blocks(item.tokens)}</li>
          {/each}
        </ul>
      {/if}
    {:else if tok.type === 'checkbox'}
      {@const c = tok as Tokens.Checkbox}
      <input type="checkbox" disabled checked={c.checked} aria-label={c.checked ? t('assistant.marks.done') : t('assistant.marks.notDone')} />
    {:else if tok.type === 'table'}
      {@const tb = tok as Tokens.Table}
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              {#each tb.header as cell, j (j)}
                <th style:text-align={align(cell.align)}>{@render inline(cell.tokens, false)}</th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each tb.rows as row, r (r)}
              <tr>
                {#each row as cell, j (j)}
                  <td style:text-align={align(cell.align)}>{@render inline(cell.tokens, false)}</td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else if tok.type === 'hr'}
      <hr />
    {:else if tok.type === 'html'}
      <p>{(tok as Tokens.HTML).text.trim()}</p>
    {:else if tok.type === 'space' || tok.type === 'def'}
      <!-- nothing to show -->
    {:else if 'raw' in tok && typeof tok.raw === 'string' && tok.raw.trim()}
      <p>{tok.raw.trim()}</p>
    {/if}
  {/each}
{/snippet}

<div class="md">
  {#if tokens}
    {@render blocks(tokens)}
  {:else}
    <p>{text}</p>
  {/if}
</div>

<style>
  .md {
    min-width: 0;
    font-size: var(--fs-ui);
    line-height: 1.55;
    color: var(--text);
    overflow-wrap: anywhere;
    user-select: text;
    -webkit-user-select: text;
  }
  .md > :global(:first-child) {
    margin-top: 0;
  }
  .md > :global(:last-child) {
    margin-bottom: 0;
  }
  p {
    margin: 0 0 8px;
  }
  p.tight {
    margin: 0;
  }
  p.heading {
    margin: 12px 0 4px;
    font-weight: var(--fw-650);
  }
  strong {
    font-weight: var(--fw-650);
  }
  del {
    color: var(--text-2);
  }
  code {
    padding: 1px 4px;
    border-radius: var(--r-xs);
    background: var(--fill-2);
    font-family: var(--font-mono);
    font-size: 0.92em;
  }
  pre {
    margin: 0 0 8px;
    padding: 8px 10px;
    overflow-x: auto;
    border-radius: var(--r-sm);
    background: var(--code-bg);
    box-shadow: 0 0 0 0.5px var(--hairline);
    font-size: var(--fs-footnote);
    line-height: 1.5;
  }
  pre code {
    padding: 0;
    background: none;
    font-size: inherit;
    white-space: pre;
  }
  ul,
  ol {
    margin: 0 0 8px;
    padding-left: 20px;
  }
  li {
    margin: 2px 0;
  }
  li ul,
  li ol {
    margin: 2px 0 0;
  }
  li.task {
    list-style: none;
    margin-left: -20px;
  }
  li.task input {
    display: inline-block;
    vertical-align: -2px;
    margin: 0 6px 0 0;
  }
  li.task p {
    display: inline;
  }
  blockquote {
    margin: 0 0 8px;
    padding: 0 0 0 10px;
    border-left: 2px solid var(--separator-strong);
    color: var(--text-2);
  }
  hr {
    margin: 12px 0;
    border: none;
    border-top: 1px solid var(--separator);
  }
  .table-wrap {
    margin: 0 0 8px;
    overflow-x: auto;
  }
  table {
    border-collapse: collapse;
    font-size: var(--fs-footnote);
  }
  th,
  td {
    padding: 4px 10px;
    border: 1px solid var(--separator);
    text-align: left;
    vertical-align: top;
  }
  th {
    font-weight: var(--fw-600);
    background: var(--fill);
  }
  a {
    color: var(--text);
    text-decoration: underline;
    text-decoration-color: var(--text-4);
    text-underline-offset: 2px;
    cursor: pointer;
  }
  a:hover {
    text-decoration-color: var(--text);
  }
  .page-link {
    display: inline;
    padding: 0 4px;
    border-radius: var(--r-xs);
    background: var(--fill);
    color: var(--text);
    font: inherit;
    cursor: pointer;
  }
  .page-link:hover {
    background: var(--fill-2);
  }
</style>
