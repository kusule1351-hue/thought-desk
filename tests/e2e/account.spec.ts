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
