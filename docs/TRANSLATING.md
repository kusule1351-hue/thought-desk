# Translating Thought Desk

The interface's text lives in `src/locales/<language>/<area>.json`, one file per area of the app (`shell.json` for the sidebar and title bar, `dbTable.json` for database tables, and so on). English (`src/locales/en`) is complete. Every other language falls back to English message by message, so a translation can be done one area at a time and still be useful.

## Translating

1. **Start a language.** Make the folder `src/locales/<code>`, where `<code>` is the language's code as Intl writes it: `es`, `de`, `pt-BR`, `zh-Hans` (not `pt_BR` or `pt-br`). Put a `meta.json` in it:

   ```json
   { "name": "Español", "english": "Spanish" }
   ```

   Languages written right to left add `"dir": "rtl"`.

   Copy only the area files you're translating, not the whole `en` folder: a message you haven't translated yet should stay missing, so it shows in English and `npm run i18n -- --missing <code>` can list it.

2. **Translate the values, keep the keys.** Each key with `@` in front (`"@open"`) is a note for you about the message of the same name: where it appears, what it means, what its `{placeholders}` are. Don't copy notes into your files.

   ```json
   "open": "Open",
   "@open": "command that opens a page or file (a verb, not 'not closed')"
   ```

3. **Keep `{placeholders}` and tags.** `{name}`, `{count}` and the like are filled in by the app: keep them (anywhere in the sentence your language needs), don't translate the word inside the braces. Tags like `<kbd>…</kbd>`, `<strong>…</strong>` or `<icon/>` mark text that's drawn differently: keep the same tags, around the right words. Type special characters directly (a no-break space is U+00A0), not as `&nbsp;`.

4. **Plurals.** A message that depends on a number has a form for each plural category your language uses, each with `{count}` in it, plus forms for exact numbers when the wording is special:

   ```json
   "rows": { "=0": "No rows", "one": "{count} row", "other": "{count} rows" }
   ```

   Spanish uses `one` and `other`; Russian `one`, `few`, `many` and `other`; Arabic all six. `npm run i18n` tells you which ones your language needs, with example numbers, if one is missing or extra.

5. **Check it.** `npm install`, then `npm run i18n`. It checks every rule above. `npm run i18n -- --missing <code>` lists the messages still to translate (and those still the same as English).

6. **Try it.** `npm run dev` opens the interface at http://localhost:1420. Choose your language in Settings → Appearance → Language; the window restarts in it.

Some things stay English on purpose: the formula language (`if()`, `round()`, `"weeks"`), which is code people type; the words a date field understands when you type one ("tomorrow"), which also accepts your language's month names; and messages from the storage engine, which come from Rust.

## Adding text to the interface

Every word people see comes from a message: `t('area.key')`, never a literal. `npm run i18n` (run in CI) fails on keys the English files don't have, English messages nothing uses, and keys built at run time.

```ts
import { t } from '../i18n';
import { fmt } from '../i18n/format';

t('shell.newPage'); // "New page"
t('pages.movedToTrash', { title }); // "Moved “{title}” to Trash"
t('dbTable.rowCount', { count: rows.length }); // "1 row", "1,234 rows"
```

```svelte
<button aria-label={t('common.actions.close')}><Icon name="x" /></button>
<Rich key="onboarding.shortcutsAside" params={{ mod: MOD }}>
  {#snippet kbd(text: string)}<kbd>{text}</kbd>{/snippet}
</Rich>
```

**Keys.** `area.camelCaseName`, grouped one level deeper when an area has many (`dbEdit.filter.isEmpty`). Name a key for what it is, not its English wording. Never name a group's key `zero`, `one`, `two`, `few`, `many` or `other` (it would read as a plural form): `otherOption`. Keys are whole strings in the code; when a key depends on a value, use a table of whole keys:

```ts
const LABELS: Record<Theme, TextKey> = { light: 'settings.appearance.themes.light', dark: 'settings.appearance.themes.dark', system: 'settings.appearance.themes.auto' };
t(LABELS[theme]);
```

(`TextKey` is a key of a plain-text message; `PluralKey` one with plural forms, which needs a `count`.)

**Notes.** Every one-word message and every message with `{placeholders}` gets a note, `"@key"`, saying where it appears, what it means (a verb or a state? a button?), and what each placeholder is.

**Whole sentences.** A message is a whole sentence or a whole label. Never stitch fragments (`'Moved ' + title + ' to Trash'`, `", last changed {date}"` appended to another message), and never put a translated word into another message as a parameter ("Delete {kind}?" can't agree in gender in Spanish): write one message per case. A parameter is a name, a number, a date already formatted, or a key name, not a word to be grammatically fitted in. Typographic quotes go in the message: `"Moved “{title}” to Trash"`.

**Numbers and plurals.** Pass numbers as numbers: `{ count: n }` picks the plural form and writes `n` the locale's way ("1,234"). A number that mustn't be grouped (a year) is passed as a string. In English plurals, `one` and `other` both contain `{count}`; wording for one exact number goes in `"=1"`, for none in `"=0"`.

**Markup in a sentence.** Text with an element in the middle (`<kbd>`, a bold name, a styled span, a form field) is one message with tags, drawn by `Rich.svelte`. `<b>`, `<strong>`, `<em>`, `<kbd>`, `<code>` and a few others become elements; any other tag is drawn by the snippet of that name. A parent's scoped CSS doesn't reach elements Rich makes, so when the parent styles them, pass a snippet. An icon *beside* a label (not inside a sentence) stays in the markup, and the label is a plain message.

**Dates, times, numbers.** Through `fmt` (`src/lib/i18n/format.ts`): `fmt.date()`, `fmt.time()`, `fmt.dateTime()`, `fmt.range()`, `fmt.relative()`, `fmt.list()`, `fmt.number()`, `fmt.bytes()`, `fmt.monthNames()`, `fmt.weekdayNames()`, `fmt.collator()`. Never `toLocale*String(undefined, …)` or `new Intl.*(undefined, …)`: those follow the system's language, not the one chosen. Don't join a date and a time by hand: `fmt.dateTime()` puts them in the locale's order.

**Identifiers stay English.** An id, a type, a CSS class, a stored setting, a key in a table, the formula language (function names, keywords, units, date patterns), file-format headers meant for other programs, DOM identifiers (`dataTransfer.types` `'Files'`) and the `/` and `@` triggers are never translated, and never shown. What's shown comes from a label message looked up by the id. Never compare, sort for identity, group or key an `{#each}` on translated text.

**Names written into people's notes.** A default the app writes into someone's notes (a template's property and option names, an "Inbox" page, "Untitled", a view called "Table") is written in the language of the day, through `t()`. Code that finds such a name again compares ids when there are any (option ids, view types, template keys), and otherwise checks every language with `tAll()`, so a note made in English is still found in Spanish:

```ts
const inbox = store.roots.find((p) => tAll('planner.inboxTitle').includes(p.title));
```

A formula in a template refers to the property names it was created with: build it from the same translated names.

**Search.** Labels people search by match in both the interface's language and English (`searchText(key, keywordsKey)`), so someone typing "todo" in a Spanish interface still finds the to-do block.

**Errors.** Text from `throw new Error(…)` that reaches a toast is a message. Error text that comes from the Rust side is shown as it comes (English, for now).

**Changing English.** Changing an English message's meaning should come with a new key, so translations of the old one don't silently say the old thing. Changing a default written into people's notes means older notes keep the old name: add the old wording to the code that finds it.
