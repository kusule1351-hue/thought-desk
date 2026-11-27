// Accounts: signing in (Google, GitHub or an emailed code), picking a
// username, editing the profile and signing out, against the fake cloud.
import type { Page } from '@playwright/test';
import { test, expect, open, MOD } from './fixtures';
import { EMAIL_CODE, FakeCloud } from './fake-cloud';

/** Opens Settings on its Account pane (the first in its list). */
async function openSettingsAccount(page: Page) {
  await page.keyboard.press(`${MOD}+Comma`);
  await page.getByRole('tablist', { name: 'Settings' }).getByRole('tab').first().click();
}

async function openAccount(page: Page) {
  await openSettingsAccount(page);
  const button = page.getByRole('button', { name: /^(Sign In…|Edit Profile…)$/ });
  await expect(button).toBeEnabled();
  await button.click();
}

test('signing in with Google, then picking a username', async ({ page }) => {
  const cloud = new FakeCloud();
  cloud.addUser({ email: 'someone@example.com', name: 'Another Ana', username: 'analima' });
  await cloud.attach(page.context(), { email: 'ana@example.com', name: 'Ana Lima' });
  await open(page);
  await openAccount(page);

  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page.getByRole('heading', { name: 'Pick a username' })).toBeVisible();
  // Someone who signed in with the wrong account can leave before picking anything.
  await expect(page.getByRole('button', { name: 'Sign Out' })).toBeVisible();
  const username = page.getByLabel('Username');
  // Suggested from the name; someone has @analima, so the next one that is free is offered, ready to take.
  await expect(username).toHaveValue('analima2');
  await expect(page.getByText('@analima2 is available.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
  // A name the person types themselves is never changed for them.
  await username.fill('analima');
  await expect(page.getByText('@analima is taken.')).toBeVisible();
  await expect(username).toHaveValue('analima');
  await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();

  await username.fill('Ana_L!');
  await expect(username, 'lowercase, and only letters, digits and _').toHaveValue('ana_l');
  await expect(page.getByText('@ana_l is available.')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('.toast', { hasText: "You're @ana_l" })).toBeVisible();

  await page.keyboard.press('Escape');
  await openSettingsAccount(page);
  await expect(page.locator('.group').filter({ hasText: '@ana_l' })).toContainText('Ana Lima');
});

test('signing in with an emailed code, and staying signed in', async ({ page }) => {
  const cloud = new FakeCloud();
  await cloud.attach(page.context());
  await open(page);
  await openAccount(page);

  await page.getByLabel('Email').fill('ben@example.com');
  await page.getByRole('button', { name: 'Email Me a Code' }).click();
  await expect(page.getByText('We sent a 6-digit code to')).toContainText('ben@example.com');
  await page.getByLabel('Code').fill('111111');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText("That code isn't right");

  await page.getByLabel('Code').fill(EMAIL_CODE);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Pick a username' })).toBeVisible();
  await page.getByLabel('Username').fill('ben');
  await expect(page.getByText('@ben is available.')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('.toast', { hasText: "You're @ben" })).toBeVisible();

  await page.reload();
  await page.locator('.sidebar').waitFor();
  await openSettingsAccount(page);
  await expect(page.getByRole('button', { name: 'Edit Profile…' })).toBeVisible();
  await expect(page.locator('.group').filter({ hasText: '@ben' })).toBeVisible();
});

test('editing the profile, then signing out', async ({ page }) => {
  const cloud = new FakeCloud();
  cloud.addUser({ email: 'cat@example.com', name: 'Cat', username: 'cat' });
  await cloud.attach(page.context(), { email: 'cat@example.com', name: 'Cat' });
  await open(page);
  await openAccount(page);
  await page.getByRole('button', { name: 'Continue with GitHub' }).click();

  const sheet = page.getByRole('dialog', { name: 'Account' });
  await expect(sheet.getByRole('button', { name: 'Save' })).toBeDisabled();
  await sheet.getByLabel('Name', { exact: true }).fill('Cat Ng');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.toast', { hasText: 'Profile saved' })).toBeVisible();
  expect([...cloud.users.values()].find((u) => u.email === 'cat@example.com')!.profile.displayName).toBe('Cat Ng');

  await sheet.getByRole('button', { name: 'Sign Out' }).click();
  await expect(page.getByRole('button', { name: 'Continue with GitHub' })).toBeVisible();
  await page.keyboard.press('Escape');
  await openSettingsAccount(page);
  await expect(page.getByRole('button', { name: 'Sign In…' })).toBeVisible();
});

test('someone who closed the username step once is not asked again at each sign-in, only where a username is needed', async ({ page }) => {
  const cloud = new FakeCloud();
  await cloud.attach(page.context(), { email: 'ana@example.com', name: 'Ana Lima' });
  await open(page);
  const sheet = page.getByRole('dialog', { name: 'Account' });
  const signIn = async () => {
    await page.evaluate(async () => {
      const { ui } = await import('/src/lib/ui.svelte.ts' as string);
      ui.settingsOpen = false;
      ui.accountSheet = true;
    });
    await page.getByRole('button', { name: 'Continue with Google' }).click();
  };
  const signOut = () =>
    page.evaluate(async () => {
      const { account } = await import('/src/lib/account.svelte.ts' as string);
      await account.signOut();
    });

  // The first sign-in asks, and closing it is an answer.
  await signIn();
  await expect(page.getByRole('heading', { name: 'Pick a username' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);

  // Signing in again: the sheet goes away by itself, signed in.
  await signOut();
  await signIn();
  await expect(sheet).toHaveCount(0);
  expect(await page.evaluate(async () => (await import('/src/lib/account.svelte.ts' as string)).account.signedIn)).toBe(true);

  // Opened on purpose (as the Friends view does), it still offers the username.
  await page.evaluate(async () => {
    const { ui } = await import('/src/lib/ui.svelte.ts' as string);
    ui.accountSheet = true;
  });
  await expect(page.getByRole('heading', { name: 'Pick a username' })).toBeVisible();
  await expect(page.getByLabel('Username')).toHaveValue('analima');
});

test('the sign-in sheet closes with its button too', async ({ page }) => {
  const cloud = new FakeCloud();
  await cloud.attach(page.context());
  await open(page);
  await openAccount(page);
  const sheet = page.getByRole('dialog', { name: 'Account' });
  await expect(sheet.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(sheet).toHaveCount(0);
});

test('deleting the account from Settings: asked once, proved with a code from the email, and the notes stay', async ({ page, errors }) => {
  const cloud = new FakeCloud();
  const ana = cloud.addUser({ email: 'ana@example.com', name: 'Ana Lima', username: 'ana' });
  const ben = cloud.addUser({ email: 'ben@example.com', name: 'Ben Okafor', username: 'ben' });
  cloud.befriend(ana, ben);
  await cloud.attach(page.context(), { email: 'ana@example.com', name: 'Ana Lima' });
  cloud.signIn(page.context(), ana);
  // The server's part (it stops Pro, removes the synced copy and the assistant's counts): a stand-in that can fail.
  const asked: { method: string; auth: string | null }[] = [];
  let status = 502;
  await page.addInitScript(() => ((window as unknown as { __assistantUrl: string }).__assistantUrl = location.origin + '/__ai'));
  await page.route('**/__ai/account', (route) => {
    asked.push({ method: route.request().method(), auth: route.request().headers().authorization ?? null });
    return route.fulfill({ status, contentType: 'application/json', body: status === 204 ? '' : JSON.stringify({ error: 'unavailable' }) });
  });
  await open(page);
  await openSettingsAccount(page);
  const settings = page.getByRole('dialog');
  await expect(settings.getByText('Leaving Thought Desk')).toBeVisible();
  // The newest one: a dialog that has been answered is still fading out when the next one opens.
  const ask = page.getByRole('alertdialog').last();

  // It asks first, in words that say what goes and what stays; backing out deletes nothing.
  await settings.getByRole('button', { name: 'Delete Account…' }).click();
  await expect(ask).toContainText('Delete your account?');
  await expect(ask).toContainText('It can’t be undone. The notes on this computer stay.');
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(ask).toHaveCount(0);
  expect(asked).toHaveLength(0);

  // Going ahead: this sign-in wasn't proved lately, so a code goes to the account's email. A wrong one asks again.
  await settings.getByRole('button', { name: 'Delete Account…' }).click();
  await ask.getByRole('button', { name: 'Delete Account', exact: true }).click();
  await expect(ask).toContainText('we emailed a 6-digit code to ana@example.com');
  await ask.getByRole('textbox').fill('000000');
  await ask.getByRole('button', { name: 'Delete Account', exact: true }).click();
  await expect(page.getByText('That code isn’t right', { exact: false }).or(page.getByText("That code isn't right", { exact: false })).first()).toBeVisible();
  await expect(ask).toContainText('Enter the code we sent');
  expect(asked).toHaveLength(0);
  expect(cloud.deleted).toEqual([]);

  // The right code, but the last step couldn't go through (the database says so when only asked): it stops
  // before the server has removed anything.
  cloud.deleteBroken = true;
  await ask.getByRole('textbox').fill(EMAIL_CODE);
  await ask.getByRole('button', { name: 'Delete Account', exact: true }).click();
  await expect(page.getByText('The account can’t be deleted from here right now.', { exact: false })).toBeVisible();
  expect(asked).toHaveLength(0);
  expect(cloud.deleted).toEqual([]);
  cloud.deleteBroken = false;

  // That is mended, but the server can't do its part: nothing is deleted, and it says so. (No second code: the
  // sign-in was just proved.)
  await settings.getByRole('button', { name: 'Delete Account…' }).click();
  await ask.getByRole('button', { name: 'Delete Account', exact: true }).click();
  await expect(page.getByText('Couldn’t delete the account just now. Nothing was deleted.', { exact: false })).toBeVisible();
  expect(asked).toEqual([{ method: 'DELETE', auth: `Bearer test.${ana.id}` }]);
  expect(cloud.deleted).toEqual([]);
  expect(cloud.users.has(ana.id)).toBe(true);
  await expect(settings.getByText('Ana Lima').first()).toBeVisible();

  // Tried again with the server back: the account goes.
  status = 204;
  await settings.getByRole('button', { name: 'Delete Account…' }).click();
  await ask.getByRole('button', { name: 'Delete Account', exact: true }).click();
  await expect(page.getByText('Your account was deleted.')).toBeVisible();
  await expect(ask).toHaveCount(0);
  expect(asked).toHaveLength(2);
  expect(cloud.deleted).toEqual([ana.id]);
  expect(cloud.users.has(ana.id)).toBe(false);
  expect(cloud.friendships).toEqual([]);
  expect(cloud.users.has(ben.id)).toBe(true);
  // Signed out here, with nothing left to delete; the notes are where they were.
  await expect(settings.getByText('Not signed in').first()).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Delete Account…' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('.sidebar').getByText('Study plan')).toBeVisible();
  // The wrong code, the server's refusal (and the browser's own line about it) were shown, and are the only errors there were.
  expect(errors).toHaveLength(4);
  errors.length = 0;
});
