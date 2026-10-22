import { expect, test, type Page } from '@playwright/test';

const openTab = async (page: Page, name: string) => {
  const tabButton = page
    .locator('.filters')
    .getByRole('button', { name, exact: true });
  await tabButton.evaluate((node: HTMLButtonElement) => {
    node.click();
  });
  await expect(tabButton).toHaveAttribute('aria-pressed', 'true');
};

test.describe('FcShowcase demo', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'FC API / 链路 / 增强组件验证' })
    ).toBeVisible();
  });

  test('runs reactivity smoke flow', async ({ page }) => {
    await openTab(page, 'Reactivity');

    // 页面上还有其他 demo 也包含 `count:` 文案，这里收窄到 showcase 列表内。
    const showcase = page.locator('.list');
    await expect(showcase.getByText('count:').first()).toContainText(
      /count:\s*0\s*\|\s*doubled:\s*0/
    );
    await page.getByRole('button', { name: '+1' }).click();
    await expect(showcase.getByText('count:').first()).toContainText(
      /count:\s*1\s*\|\s*doubled:\s*2/
    );

    await page.getByRole('button', { name: 'run transition' }).click();
    await expect(page.getByText('pending:')).toContainText('pending: no');
    await expect(page.getByText('transition -> 1')).toBeVisible();
  });

  test('preserves KeepAlive state', async ({ page }) => {
    await openTab(page, 'Enhanced');

    await page.getByPlaceholder('type in Page A').fill('persist-me');
    await page.getByRole('button', { name: 'page-b' }).click();
    await expect(page.getByPlaceholder('type in Page B')).toBeVisible();
    await page.getByRole('button', { name: 'page-a' }).click();
    await expect(page.getByPlaceholder('type in Page A')).toHaveValue(
      'persist-me'
    );
  });

  test('resets Enhanced state when re-entering the tab', async ({ page }) => {
    await openTab(page, 'Enhanced');
    await page.getByRole('button', { name: 'page-b' }).click();
    await expect(page.getByText('Page B (cached)')).toBeVisible();

    await openTab(page, 'Reactivity');
    await openTab(page, 'Enhanced');
    await expect(page.getByText('Page A (cached)')).toBeVisible();
  });

  test('handles ErrorBoundary reset', async ({ page }) => {
    await openTab(page, 'Suspense');
    await page
      .getByRole('button', { name: 'toggle error', exact: true })
      .click();
    await expect(
      page.getByText(/caught:.*manual suspense demo error/)
    ).toBeVisible();
  });

  test('resets Suspense state when re-entering the tab', async ({ page }) => {
    await openTab(page, 'Suspense');
    await page.getByRole('button', { name: 'name=lania' }).click();
    await expect(
      page.getByText('Lazy component resolved: lania')
    ).toBeVisible();

    await openTab(page, 'Reactivity');
    await openTab(page, 'Suspense');
    await expect(
      page.getByText('Lazy component resolved: world')
    ).toBeVisible();
  });

  test('runs TransitionGroup list interactions', async ({ page }) => {
    await openTab(page, 'Transition');

    await expect(page.locator('.list [data-key="a"]')).toBeVisible();
    await expect(page.locator('.list [data-key="b"]')).toBeVisible();
    await expect(page.locator('.list [data-key="c"]')).toBeVisible();

    await page
      .getByRole('button', { name: 'append item', exact: true })
      .click();
    await page.getByRole('button', { name: 'move first', exact: true }).click();
    await page
      .getByRole('button', { name: 'remove first', exact: true })
      .click();

    await expect(page.getByText(/move:.*:move/).first()).toBeVisible();
    await expect(page.getByText(/leave:.*:leave/).first()).toBeVisible();
    await expect(page.getByText(/enter:.*:enter/).first()).toBeVisible();
  });
});
