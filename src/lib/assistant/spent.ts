/**
 * The month's allowance is used up: said once in a dialog, the first time it
 * happens in a month on a plan, with the way to Pro for someone on the free
 * plan. After that the line in the conversation says it, without interrupting.
 */

import { t } from '../i18n';
import { fmt } from '../i18n/format';
import { ui } from '../ui.svelte';
import { plan, refreshPlan, upgrade } from './plan.svelte';

const KEY = 'thoughtdesk.assistant.spentSaid';

/** The first day of next month (the server counts months in UTC). */
function renewal(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 12));
}

export async function saySpent(): Promise<void> {
  await refreshPlan();
  const said = `${new Date().toISOString().slice(0, 7)}:${plan.pro ? 'pro' : 'free'}`;
  try {
    if (localStorage.getItem(KEY) === said) return;
    localStorage.setItem(KEY, said);
  } catch {
    /* no storage: it is said each time */
  }
  const date = fmt.date(renewal(), { month: 'long', day: 'numeric', timeZone: 'UTC' });
  const offer = plan.on && !plan.pro;
  const yes = await ui.confirm({
    title: t('assistant.spent.title'),
    message: offer ? t('assistant.spent.free', { date }) : t('assistant.spent.plain', { date }),
    confirmLabel: offer ? t('assistant.plan.upgrade') : t('assistant.spent.ok'),
    cancelLabel: offer ? t('assistant.spent.later') : null,
    icon: 'clock',
  });
  if (yes && offer) upgrade();
}
