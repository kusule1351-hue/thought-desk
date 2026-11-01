// Friends: two people (two browser profiles) sharing the fake cloud. Ana
// adds Ben by username on the Friends page, Ben accepts, both see each other
// online; requests can be declined, and friends removed.
import type { Browser, Page } from '@playwright/test';
import { test, expect, open } from './fixtures';
import { FakeCloud } from './fake-cloud';

const LIVE = { timeout: 8000 };

/** A second person: their own browser profile, signed in. */
async function person(browser: Browser, cloud: FakeCloud, email: string, name: string, username: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const user = cloud.addUser({ email, name, username });
  await cloud.attach(context);
  cloud.signIn(context, user);
  const page = await context.newPage();
  await open(page);
  return page;
}

const friendsPage = (page: Page) => page.locator('.friends-view');

/** Switches to another window, as far as the app can tell. */
const away = (page: Page) => page.evaluate(() => void (document.hasFocus = () => false));
/** Comes back to the app's window. */
const back = (page: Page) =>
  page.evaluate(() => {
    delete (document as { hasFocus?: unknown }).hasFocus;
    window.dispatchEvent(new Event('focus'));
  });

/** Opens the Friends page from the sidebar. */
async function openFriends(page: Page) {
  await page.locator('.sidebar .views').getByRole('button', { name: 'Cowork' }).click();
  await expect(friendsPage(page)).toBeVisible();
}

async function addFriend(page: Page, username: string) {
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await openFriends(page);
  await friendsPage(page).locator('.view-head').getByRole('button', { name: 'Add a Friend' }).click();
  await page.getByPlaceholder('@username').fill(username);
  await page.getByRole('button', { name: 'Send Request' }).click();
}

test('adding a friend by username, and accepting', async ({ page: ana, browser }) => {
  const cloud = new FakeCloud();
  const anaUser = cloud.addUser({ email: 'ana@example.com', name: 'Ana Lima', username: 'ana' });
  await cloud.attach(ana.context());
  cloud.signIn(ana.context(), anaUser);
  await open(ana);
  const ben = await person(browser, cloud, 'ben@example.com', 'Ben Ito', 'ben');

  await test.step('mistakes are explained', async () => {
    await addFriend(ana, '@nobody');
    await expect(ana.locator('.toast', { hasText: 'No one is called @nobody.' })).toBeVisible();
    await addFriend(ana, 'ana');
    await expect(ana.locator('.toast', { hasText: "That's you." })).toBeVisible();
  });

  await test.step('Ana asks Ben; it shows as asked', async () => {
    await addFriend(ana, '@Ben');
    await expect(ana.locator('.toast', { hasText: 'Friend request sent to @ben' })).toBeVisible();
    await expect(friendsPage(ana)).toContainText('Ben Ito');
    await expect(friendsPage(ana)).toContainText('Asked');
  });

  await test.step('Ben gets the request, live, and accepts', async () => {
    await expect(ben.locator('.toast', { hasText: 'Ana Lima wants to be friends' })).toBeVisible(LIVE);
    await expect(ben.locator('.sidebar .nav-row', { hasText: 'Cowork' }).locator('.count'), 'the sidebar counts what waits').toHaveText('1');
    await away(ana);
    await openFriends(ben);
    await ben.getByRole('button', { name: 'Accept Ana Lima' }).click();
    await expect(ben.locator('.toast', { hasText: "You're now friends with Ana Lima" })).toBeVisible();
  });

  await test.step('Ana, in another window, hears it from the system, and the news waits for her', async () => {
    const news = ana.locator('.toast', { hasText: 'Ben Ito accepted your friend request' });
    await expect(news).toBeVisible(LIVE);
    await expect.poll(() => ana.evaluate(() => (window as { __notifications?: unknown[] }).__notifications)).toEqual([{ title: 'Ben Ito accepted your friend request', body: '@ben' }]);
    await ana.waitForTimeout(9000);
    await expect(news, 'still there past its time, while she is away').toBeVisible();
    await back(ana);
    await expect(news, 'gone a while after she is back').toHaveCount(0, { timeout: 10_000 });
  });

  await test.step('both are friends, and online', async () => {
    for (const [page, other] of [
      [ana, 'Ben Ito'],
      [ben, 'Ana Lima'],
    ] as const) {
      await expect(friendsPage(page)).toContainText(other, LIVE);
      await expect(friendsPage(page)).not.toContainText('Asked', LIVE);
      await expect(friendsPage(page).locator('.online')).toHaveCount(1, LIVE);
      await expect(friendsPage(page)).toContainText('Here now');
    }
    expect(cloud.friendships).toEqual([expect.objectContaining({ status: 'accepted' })]);
  });

  await test.step('Ben removes Ana', async () => {
    await ben.getByRole('button', { name: 'More for Ana Lima' }).click();
    await ben.getByRole('menuitem', { name: 'Remove Friend' }).click();
    await ben.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(friendsPage(ben)).not.toContainText('Ana Lima');
    await expect(friendsPage(ana)).not.toContainText('Ben Ito', LIVE);
    expect(cloud.friendships).toEqual([]);
  });

  await ben.context().close();
});

test('declining a request, and cancelling one', async ({ page: ana, browser }) => {
  const cloud = new FakeCloud();
  const anaUser = cloud.addUser({ email: 'ana@example.com', name: 'Ana Lima', username: 'ana' });
  await cloud.attach(ana.context());
  cloud.signIn(ana.context(), anaUser);
  await open(ana);
  const cat = await person(browser, cloud, 'cat@example.com', 'Cat Ng', 'cat');

  await addFriend(cat, 'ana');
  await openFriends(ana);
  await expect(friendsPage(ana)).toContainText('Cat Ng', LIVE);
  await ana.getByRole('button', { name: 'Decline Cat Ng' }).click();
  await expect(friendsPage(cat)).not.toContainText('Ana Lima', LIVE);
  await expect(cat.locator('.toast', { hasText: 'Ana Lima declined your friend request.' })).toBeVisible();
  expect(await cat.evaluate(() => (window as { __notifications?: unknown[] }).__notifications), 'only in the app').toBeUndefined();
  expect(cloud.friendships).toEqual([]);

  await addFriend(ana, 'cat');
  await expect(friendsPage(cat)).toContainText('Ana Lima', LIVE);
  await ana.getByRole('button', { name: 'Cancel request to Cat Ng' }).click();
  await expect(friendsPage(ana)).not.toContainText('Cat Ng');
  await expect(friendsPage(cat)).not.toContainText('Ana Lima', LIVE);
  await expect(ana.locator('.toast', { hasText: 'declined' }), 'taking a request back is no news').toHaveCount(0);

  await cat.context().close();
});

test('signed out, the Friends page offers to sign in', async ({ page }) => {
  const cloud = new FakeCloud();
  await cloud.attach(page.context());
  await open(page);
  await openFriends(page);
  await expect(page.locator('.titlebar')).toContainText('Cowork');
  await friendsPage(page).getByRole('button', { name: 'Sign In…' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});
