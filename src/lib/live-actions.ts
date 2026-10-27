/** Menus for live sessions: writing with a friend (from the Friends page), and picking the page for a request. */

import { cowork } from './cowork.svelte';
import { nameOf } from './friends.svelte';
import { t } from './i18n';
import { store } from './store.svelte';
import { ui, type MenuItem } from './ui.svelte';
import type { Friend, LiveSession } from './cloud';
import type { PageMeta } from './types';

/** Pages that can be written together: ordinary pages that aren't live already. */
const shareable = (p: PageMeta | null | undefined): p is PageMeta => !!p && !p.deletedAt && p.kind !== 'database' && !store.isRow(p) && !p.sharedRoom;

const say = (e: unknown) => ui.toast(e instanceof Error ? e.message : String(e));

/** Invites a friend to a page, saying how it went. */
export function inviteFriend(f: Friend, pageId: string) {
  const title = store.byId.get(pageId)?.title || t('common.untitled');
  cowork.invite(f, pageId).then(() => ui.toast(t('social.write.invited', { name: nameOf(f), title })), say);
}

/** The pages most recently changed that could be written together. */
function recentPages(except?: string): PageMeta[] {
  const recent: PageMeta[] = [];
  for (const p of store.all) {
    if (!shareable(p) || p.id === except) continue;
    recent.push(p);
    recent.sort((a, b) => b.updatedAt - a.updatedAt);
    if (recent.length > 6) recent.pop();
  }
  return recent;
}

/** Writing with a friend from the Friends page: invite them to the page you
 *  were just on, a new one or a recent one of yours, or ask them to pick one
 *  of theirs. */
export function writeWithMenu(f: Friend, anchor: Element) {
  const last = shareable(store.lastPage) ? store.lastPage : null;
  const page = (p: PageMeta, hint?: string): MenuItem => ({ label: p.title || t('common.untitled'), icon: 'page', hint, action: () => inviteFriend(f, p.id) });
  const items: MenuItem[] = [
    { header: t('social.write.withOn', { name: nameOf(f) }) },
    ...(last ? [page(last, t('social.write.justOpen'))] : []),
    {
      label: t('social.write.newPage'),
      icon: 'page-plus',
      action: async () => {
        const made = await store.create(null, { title: t('social.write.pageTitle', { name: nameOf(f) }), open: false });
        if (made) inviteFriend(f, made.id);
      },
    },
    ...recentPages(last?.id).map((p) => page(p)),
    { separator: true },
    {
      label: t('social.write.theirPages'),
      icon: 'user',
      hint: t('social.write.theyChoose'),
      action: () => void cowork.ask(f).then(() => ui.toast(t('social.write.asked', { name: nameOf(f) })), say),
    },
  ];
  ui.openMenuAt(anchor, items);
}

/** Accepting someone's request: which of your pages to write on (the open
 *  one, a new one, or a recent one). Only that page is shared. */
export function choosePage(row: LiveSession, anchor: Element) {
  const share = (pageId: string) => void cowork.share(row, pageId).catch(say);
  const open = store.view === 'page' ? store.current : null;
  const recent = recentPages(open?.id);
  const newTitle = cowork.aboutOther(row, 'social.write.pageTitle', 'social.write.pageTitleFriend');
  const items: MenuItem[] = [{ header: cowork.aboutOther(row, 'social.write.withOn', 'social.write.withOnFriend') }];
  if (shareable(open)) items.push({ label: open.title || t('common.untitled'), icon: 'page', hint: t('social.write.openNow'), action: () => share(open.id) });
  items.push({
    label: t('social.write.newPage'),
    icon: 'page-plus',
    action: async () => {
      const made = await store.create(null, { title: newTitle, open: false });
      if (made) share(made.id);
    },
  });
  if (recent.length) items.push({ separator: true }, ...recent.map((p): MenuItem => ({ label: p.title || t('common.untitled'), icon: 'page', action: () => share(p.id) })));
  ui.openMenuAt(anchor, items);
}
