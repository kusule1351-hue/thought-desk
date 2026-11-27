<!--
  The chats kept on this computer, behind one button: a menu of them, newest
  first, to open one again. The one that is open can be deleted from the same
  menu. Reading them needs no connection and no sign-in: they are here, with
  the notes.
-->
<script lang="ts">
  import Icon from '../../components/Icon.svelte';
  import { t } from '../../i18n';
  import { relativeTime } from '../../time';
  import { ui, type MenuItem } from '../../ui.svelte';
  import { assistant } from '../assistant.svelte';

  /** How many are listed: the newest, which is what anyone goes back for. */
  const SHOWN = 40;
  /** A title's length in the menu. */
  const WIDE = 44;

  let button = $state<HTMLButtonElement>();

  const named = (title: string) => (title.length > WIDE ? `${title.slice(0, WIDE - 1).trimEnd()}…` : title) || t('assistant.history.untitled');

  async function open() {
    await assistant.refreshChats();
    if (!button) return;
    const items: MenuItem[] = [{ header: t('assistant.history.title') }];
    if (!assistant.chats.length) items.push({ label: t('assistant.history.empty'), disabled: true, action: () => {} });
    for (const chat of assistant.chats.slice(0, SHOWN))
      items.push({ label: named(chat.title), hint: relativeTime(chat.updatedAt), checked: chat.id === assistant.chatId, disabled: assistant.busy, action: () => void assistant.openChat(chat.id) });
    const current = assistant.chatId;
    if (current) items.push({ separator: true }, { label: t('assistant.history.delete'), icon: 'trash', danger: true, disabled: assistant.busy, action: () => void remove(current) });
    ui.openMenuAt(button, items, { alignRight: true });
  }

  async function remove(id: string) {
    const sure = await ui.confirm({ title: t('assistant.history.deleteTitle'), message: t('assistant.history.deleteMessage'), confirmLabel: t('assistant.history.deleteConfirm'), danger: true });
    if (sure) await assistant.deleteChat(id);
  }
</script>

<button class="icon-btn history" bind:this={button} onclick={() => void open()} aria-label={t('assistant.history.button')} data-tip={t('assistant.history.button')}><Icon name="clock" /></button>
