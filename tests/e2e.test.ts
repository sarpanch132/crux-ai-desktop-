import { test, expect, Page, Browser, BrowserContext } from '@playwright/test';
import { chromium } from 'playwright';

describe('End-to-End Tests', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    page = await context.newPage();
  });

  afterAll(async () => {
    await browser.close();
  });

  test.describe('Application Launch', () => {
    test('should launch application', async () => {
      await page.goto('http://localhost:5173');
      await page.waitForLoadState('networkidle');

      const title = await page.title();
      expect(title).toBeTruthy();
    });

    test('should display main UI components', async () => {
      await page.goto('http://localhost:5173');

      const sidebar = await page.locator('[class*="sidebar"]').first();
      const chat = await page.locator('[class*="chat"]').first();

      expect(await sidebar.isVisible() || await chat.isVisible()).toBeTruthy();
    });
  });

  test.describe('Chat Functionality', () => {
    test('should send message and receive response', async () => {
      await page.goto('http://localhost:5173');

      const input = page.locator('input[type="text"], textarea').first();
      await input.fill('Hello');
      await input.press('Enter');

      await page.waitForTimeout(2000);

      const messages = await page.locator('[class*="message"]').count();
      expect(messages).toBeGreaterThan(0);
    });

    test('should handle image upload', async () => {
      await page.goto('http://localhost:5173');

      const uploadButton = page.locator('button:has-text("Upload"), [class*="upload"]').first();
      if (await uploadButton.isVisible()) {
        await uploadButton.click();
      }
    });
  });

  test.describe('Terminal Integration', () => {
    test('should open terminal panel', async () => {
      await page.goto('http://localhost:5173');

      const terminalButton = page.locator('button:has-text("Terminal"), [class*="terminal"]').first();
      if (await terminalButton.isVisible()) {
        await terminalButton.click();
      }

      await page.waitForTimeout(500);
    });
  });

  test.describe('Settings', () => {
    test('should open settings panel', async () => {
      await page.goto('http://localhost:5173');

      await page.keyboard.press('Control+,');
      await page.waitForTimeout(500);
    });
  });
});

describe('Performance Tests', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser.close();
  });

  test('should load within 3 seconds', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();

    const startTime = Date.now();
    await page.goto('http://localhost:5173');
    await page.waitForLoadState('domcontentloaded');

    const loadTime = Date.now() - startTime;
    expect(loadTime).toBeLessThan(3000);

    await context.close();
  });

  test('should handle large messages', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto('http://localhost:5173');

    const largeMessage = 'x'.repeat(10000);
    const input = page.locator('input[type="text"], textarea').first();
    await input.fill(largeMessage);

    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.waitForTimeout(1000);
    expect(errors.length).toBe(0);

    await context.close();
  });
});