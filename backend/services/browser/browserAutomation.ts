import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import log from 'electron-log';
import type { Browser, Page, BrowserContext, CDPSession } from 'playwright';

export interface BrowserConfig {
  headless: boolean;
  viewport: { width: number; height: number };
  userAgent?: string;
  slowMo: number;
  devtools: boolean;
}

export interface NavigationOptions {
  timeout?: number;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  retries?: number;
}

export interface ElementSelector {
  selector: string;
  timeout?: number;
}

export interface ScreenshotOptions {
  fullPage?: boolean;
  type?: 'png' | 'jpeg';
  quality?: number;
}

export interface ExecuteScriptOptions {
  arg?: any;
}

export interface Cookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export class BrowserAutomation extends EventEmitter {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private context: BrowserContext | null = null;
  private cdpSession: CDPSession | null = null;
  private config: BrowserConfig;
  private isInitialized: boolean = false;
  private navigationHistory: { url: string; timestamp: number }[] = [];
  private maxHistory: number = 50;

  constructor(config: Partial<BrowserConfig> = {}) {
    super();
    this.config = {
      headless: config.headless ?? true,
      viewport: config.viewport ?? { width: 1920, height: 1080 },
      userAgent: config.userAgent,
      slowMo: config.slowMo ?? 0,
      devtools: config.devtools ?? false,
    };
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      const { chromium } = await import('playwright');
      
      this.browser = await chromium.launch({
        headless: this.config.headless,
        devtools: this.config.devtools,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
        ],
      });

      this.context = await this.browser.newContext({
        viewport: this.config.viewport,
        userAgent: this.config.userAgent,
      });

      this.page = await this.context.newPage();
      
      this.page.on('console', (msg) => {
        this.emit('console', {
          type: msg.type(),
          text: msg.text(),
          timestamp: Date.now(),
        });
      });

      this.page.on('pageerror', (error) => {
        this.emit('error', { message: error.message, timestamp: Date.now() });
      });

      this.page.on('navigation', () => {
        this.emit('navigation', { url: this.page?.url(), timestamp: Date.now() });
      });

      const cdp = await this.context.newCDPSession(this.page);
      this.cdpSession = cdp;

      this.isInitialized = true;
      log.info('Browser automation initialized');
    } catch (error) {
      log.error('Browser initialization failed:', error);
      throw error;
    }
  }

  async navigate(url: string, options: NavigationOptions = {}): Promise<void> {
    if (!this.page) throw new Error('Browser not initialized');

    const { timeout = 30000, waitUntil = 'networkidle', retries = 0 } = options;
    let attempts = 0;
    let lastError: Error | null = null;

    while (attempts <= retries) {
      try {
        await this.page.goto(url, { timeout, waitUntil });
        
        this.navigationHistory.unshift({ url, timestamp: Date.now() });
        if (this.navigationHistory.length > this.maxHistory) {
          this.navigationHistory.pop();
        }

        this.emit('navigated', { url, timestamp: Date.now() });
        return;
      } catch (error) {
        lastError = error as Error;
        attempts++;
        
        if (attempts <= retries) {
          await this.sleep(1000 * attempts);
        }
      }
    }

    throw lastError || new Error('Navigation failed');
  }

  async click(selector: string, options: { timeout?: number; force?: boolean } = {}): Promise<void> {
    if (!this.page) throw new Error('Browser not initialized');
    
    await this.page.click(selector, { 
      timeout: options.timeout ?? 30000,
      force: options.force,
    });
  }

  async type(selector: string, text: string, options: { timeout?: number; delay?: number } = {}): Promise<void> {
    if (!this.page) throw new Error('Browser not initialized');
    
    await this.page.fill(selector, text).catch(async () => {
      await this.page.click(selector);
      await this.page.keyboard.type(text, { delay: options.delay ?? 50 });
    });
  }

  async select(selector: string, value: string | string[]): Promise<void> {
    if (!this.page) throw new Error('Browser not initialized');
    await this.page.selectOption(selector, value);
  }

  async hover(selector: string, options: { timeout?: number } = {}): Promise<void> {
    if (!this.page) throw new Error('Browser not initialized');
    await this.page.hover(selector, { timeout: options.timeout ?? 30000 });
  }

  async scrollTo(selector: string): Promise<void> {
    if (!this.page) throw new Error('Browser not initialized');
    await this.page.locator(selector).scrollIntoViewIfNeeded();
  }

  async evaluate<T>(script: string | ((...args: any[]) => T), ...args: any[]): Promise<T> {
    if (!this.page) throw new Error('Browser not initialized');
    return await this.page.evaluate(script, ...args);
  }

  async evaluateOnDocument<T>(script: string | ((...args: any[]) => T), ...args: any[]): Promise<T> {
    if (!this.page) throw new Error('Browser not initialized');
    return await this.page.evaluateHandle(script, ...args) as unknown as T;
  }

  async getAttribute(selector: string, attribute: string): Promise<string | null> {
    if (!this.page) throw new Error('Browser not initialized');
    return await this.page.getAttribute(selector, attribute);
  }

  async getText(selector: string): Promise<string> {
    if (!this.page) throw new Error('Browser not initialized');
    return await this.page.textContent(selector) ?? '';
  }

  async getValue(selector: string): Promise<string> {
    if (!this.page) throw new Error('Browser not initialized');
    return await this.page.inputValue(selector);
  }

  async isVisible(selector: string): Promise<boolean> {
    if (!this.page) throw new Error('Browser not initialized');
    return await this.page.isVisible(selector);
  }

  async isEnabled(selector: string): Promise<boolean> {
    if (!this.page) throw new Error('Browser not initialized');
    return await this.page.isEnabled(selector);
  }

  async waitForSelector(selector: string, options: { timeout?: number; state?: 'attached' | 'visible' | 'hidden' | 'detached' } = {}): Promise<void> {
    if (!this.page) throw new Error('Browser not initialized');
    await this.page.waitForSelector(selector, { 
      timeout: options.timeout ?? 30000,
      state: options.state ?? 'visible',
    });
  }

  async waitForLoadState(state: 'load' | 'domcontentloaded' | 'networkidle', options: { timeout?: number } = {}): Promise<void> {
    if (!this.page) throw new Error('Browser not initialized');
    await this.page.waitForLoadState(state, { timeout: options.timeout ?? 30000 });
  }

  async waitForFunction(fn: string | (() => boolean), options: { timeout?: number } = {}): Promise<void> {
    if (!this.page) throw new Error('Browser not initialized');
    await this.page.waitForFunction(fn, { timeout: options.timeout ?? 30000 });
  }

  async screenshot(options: ScreenshotOptions = {}): Promise<Buffer> {
    if (!this.page) throw new Error('Browser not initialized');
    
    return await this.page.screenshot({
      fullPage: options.fullPage ?? false,
      type: options.type ?? 'png',
      quality: options.quality,
    });
  }

  async screenshotToFile(filePath: string, options: ScreenshotOptions = {}): Promise<void> {
    if (!this.page) throw new Error('Browser not initialized');
    
    await this.page.screenshot({
      path: filePath,
      fullPage: options.fullPage ?? false,
      type: options.type ?? 'png',
      quality: options.quality,
    });
  }

  async getCookies(): Promise<Cookie[]> {
    if (!this.context) throw new Error('Browser not initialized');
    
    const cookies = await this.context.cookies();
    return cookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite as Cookie['sameSite'],
    }));
  }

  async setCookies(cookies: Cookie[]): Promise<void> {
    if (!this.context) throw new Error('Browser not initialized');
    
    await this.context.addCookies(cookies);
  }

  async clearCookies(): Promise<void> {
    if (!this.context) throw new Error('Browser not initialized');
    await this.context.clearCookies();
  }

  async getLocalStorage(): Promise<Record<string, string>> {
    if (!this.page) throw new Error('Browser not initialized');
    return await this.page.evaluate(() => {
      const result: Record<string, string> = {};
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key) result[key] = localStorage.getItem(key) ?? '';
      }
      return result;
    });
  }

  async setLocalStorage(key: string, value: string): Promise<void> {
    if (!this.page) throw new Error('Browser not initialized');
    await this.page.evaluate(([k, v]) => {
      localStorage.setItem(k, v);
    }, [key, value]);
  }

  async getSessionStorage(): Promise<Record<string, string>> {
    if (!this.page) throw new Error('Browser not initialized');
    return await this.page.evaluate(() => {
      const result: Record<string, string> = {};
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (key) result[key] = sessionStorage.getItem(key) ?? '';
      }
      return result;
    });
  }

  async setSessionStorage(key: string, value: string): Promise<void> {
    if (!this.page) throw new Error('Browser not initialized');
    await this.page.evaluate(([k, v]) => {
      sessionStorage.setItem(k, v);
    }, [key, value]);
  }

  async getHTML(): Promise<string> {
    if (!this.page) throw new Error('Browser not initialized');
    return await this.page.content();
  }

  async getTitle(): Promise<string> {
    if (!this.page) throw new Error('Browser not initialized');
    return await this.page.title();
  }

  async getCurrentURL(): Promise<string> {
    if (!this.page) throw new Error('Browser not initialized');
    return this.page.url();
  }

  async goBack(): Promise<void> {
    if (!this.page) throw new Error('Browser not initialized');
    await this.page.goBack();
  }

  async goForward(): Promise<void> {
    if (!this.page) throw new Error('Browser not initialized');
    await this.page.goForward();
  }

  async reload(): Promise<void> {
    if (!this.page) throw new Error('Browser not initialized');
    await this.page.reload();
  }

  async uploadFile(selector: string, filePath: string): Promise<void> {
    if (!this.page) throw new Error('Browser not initialized');
    await this.page.setInputFiles(selector, filePath);
  }

  async pressKey(selector: string, key: string): Promise<void> {
    if (!this.page) throw new Error('Browser not initialized');
    await this.page.click(selector);
    await this.page.keyboard.press(key);
  }

  async sendFile(filePath: string): Promise<void> {
    if (!this.page) throw new Error('Browser not initialized');
    
    const fs = await import('fs');
    const fileBuffer = fs.readFileSync(filePath);
    const fileName = filePath.split(/[/\\]/).pop() ?? 'file';
    
    await this.page.evaluate(([buffer, name]) => {
      const blob = new Blob([buffer], { type: 'application/octet-stream' });
      const data = new DataTransfer();
      const file = new File([blob], name);
      data.items.add(file);
    }, [fileBuffer.toString('base64'), fileName]);
  }

  async executeCDP(command: string, params?: Record<string, any>): Promise<any> {
    if (!this.cdpSession) throw new Error('CDP session not available');
    return await this.cdpSession.send(command, params);
  }

  async getMetrics(): Promise<any> {
    return await this.executeCDP('Performance.getMetrics');
  }

  async takeHeapSnapshot(): Promise<any> {
    return await this.executeCDP('Memory.takeHeapSnapshot');
  }

  async forceGC(): Promise<void> {
    await this.executeCDP('HeapProfiler.collectGarbage');
  }

  async getConsoleLogs(): Promise<{ type: string; text: string }[]> {
    if (!this.page) throw new Error('Browser not initialized');
    return await this.evaluate(() => {
      return (window as any).__consoleLogs ?? [];
    });
  }

  async getNetworkLogs(): Promise<any[]> {
    if (!this.page) throw new Error('Browser not initialized');
    return [];
  }

  async download(options: { url: string; destination: string }): Promise<void> {
    const fs = await import('fs');
    const response = await fetch(options.url);
    const buffer = await response.arrayBuffer();
    fs.writeFileSync(options.destination, Buffer.from(buffer));
  }

  async newTab(url?: string): Promise<Page> {
    if (!this.context) throw new Error('Browser not initialized');
    const newPage = await this.context.newPage();
    if (url) await newPage.goto(url);
    return newPage;
  }

  async closeTab(page: Page): Promise<void> {
    await page.close();
  }

  async switchToFrame(frameId: string): Promise<void> {
    if (!this.page) throw new Error('Browser not initialized');
    const frame = this.page.frame(frameId);
    if (!frame) throw new Error(`Frame not found: ${frameId}`);
  }

  getPage(): Page | null {
    return this.page;
  }

  getNavigationHistory(): { url: string; timestamp: number }[] {
    return [...this.navigationHistory];
  }

  async close(): Promise<void> {
    if (this.cdpSession) {
      await this.cdpSession.detach();
      this.cdpSession = null;
    }

    if (this.page) {
      await this.page.close();
      this.page = null;
    }

    if (this.context) {
      await this.context.close();
      this.context = null;
    }

    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }

    this.isInitialized = false;
    log.info('Browser closed');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getStatus(): { initialized: boolean; currentURL: string | null } {
    return {
      initialized: this.isInitialized,
      currentURL: this.page?.url() ?? null,
    };
  }
}

export const createBrowserAutomation = (config?: Partial<BrowserConfig>): BrowserAutomation => {
  return new BrowserAutomation(config);
};

export default BrowserAutomation;