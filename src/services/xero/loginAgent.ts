import { chromium, Browser, Page, BrowserContext } from 'playwright';
import { logger } from '../../utils/logger';

export interface LoginResult {
  success: boolean;
  message: string;
  url?: string;
  screenshot?: string;
  error?: string;
}

export interface LoginLog {
  step: string;
  message: string;
  timestamp: Date;
  error?: string;
}

export class XeroLoginAgent {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private logs: LoginLog[] = [];
  private isRunning = false;

  constructor(
    private username: string,
    private password: string,
    private headless: boolean = true
  ) {}

  private addLog(step: string, message: string, error?: string): void {
    const logEntry: LoginLog = {
      step,
      message,
      timestamp: new Date(),
      error,
    };
    this.logs.push(logEntry);
    logger.info(`[Xero Login Agent] [${step}] ${message}`, { error });
  }

  getLogs(): LoginLog[] {
    return [...this.logs];
  }

  clearLogs(): void {
    this.logs = [];
  }

  async initialize(): Promise<void> {
    if (this.browser) {
      return;
    }

    try {
      this.addLog('INIT', 'Initializing browser...');
      this.browser = await chromium.launch({
        headless: this.headless,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });

      this.context = await this.browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      });

      this.page = await this.context.newPage();
      this.addLog('INIT', 'Browser initialized successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.addLog('INIT', 'Failed to initialize browser', errorMessage);
      throw error;
    }
  }

  async login(): Promise<LoginResult> {
    if (this.isRunning) {
      return {
        success: false,
        message: 'Login agent is already running',
      };
    }

    this.isRunning = true;
    this.clearLogs();

    try {
      await this.initialize();

      if (!this.page) {
        throw new Error('Page not initialized');
      }

      const page = this.page;

      // Navigate to Xero login page
      this.addLog('NAVIGATE', 'Navigating to Xero login page...');
      try {
        await page.goto('https://login.xero.com/identity/user/login', {
          waitUntil: 'networkidle',
          timeout: 30000,
        });
        this.addLog('NAVIGATE', 'Successfully navigated to login page');
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Navigation timeout';
        this.addLog('NAVIGATE', 'Navigation failed', errorMessage);
        throw new Error(`Failed to navigate to login page: ${errorMessage}`);
      }

      // Wait for page to load
      await page.waitForTimeout(1000);

      // Check if we're already logged in or redirected
      const currentUrl = page.url();
      if (!currentUrl.includes('/login')) {
        this.addLog('LOGIN', 'Already logged in or redirected', currentUrl);
        return {
          success: true,
          message: 'Already logged in or redirected',
          url: currentUrl,
        };
      }

      // Find and fill email field
      this.addLog('FILL', 'Looking for email input field...');
      const emailSelectors = [
        'input[name="Email"]',
        'input[type="email"]',
        'input[id*="email" i]',
        'input[placeholder*="email" i]',
        'input[data-testid*="email" i]',
      ];

      let emailFilled = false;
      for (const selector of emailSelectors) {
        try {
          const emailField = await page.locator(selector).first();
          if (await emailField.isVisible({ timeout: 2000 })) {
            await emailField.fill(this.username);
            emailFilled = true;
            this.addLog('FILL', `Email filled using selector: ${selector}`);
            break;
          }
        } catch (e) {
          continue;
        }
      }

      if (!emailFilled) {
        // Try using getByLabel or getByPlaceholder
        try {
          await page.getByLabel(/email/i).fill(this.username);
          emailFilled = true;
          this.addLog('FILL', 'Email filled using getByLabel');
        } catch (e) {
          try {
            await page.getByPlaceholder(/email/i).fill(this.username);
            emailFilled = true;
            this.addLog('FILL', 'Email filled using getByPlaceholder');
          } catch (e2) {
            throw new Error('Could not find email input field');
          }
        }
      }

      // Wait a bit before filling password
      await page.waitForTimeout(500);

      // Find and fill password field
      this.addLog('FILL', 'Looking for password input field...');
      const passwordSelectors = [
        'input[name="Password"]',
        'input[type="password"]',
        'input[id*="password" i]',
        'input[placeholder*="password" i]',
        'input[data-testid*="password" i]',
      ];

      let passwordFilled = false;
      for (const selector of passwordSelectors) {
        try {
          const passwordField = await page.locator(selector).first();
          if (await passwordField.isVisible({ timeout: 2000 })) {
            await passwordField.fill(this.password);
            passwordFilled = true;
            this.addLog('FILL', `Password filled using selector: ${selector}`);
            break;
          }
        } catch (e) {
          continue;
        }
      }

      if (!passwordFilled) {
        try {
          await page.getByLabel(/password/i).fill(this.password);
          passwordFilled = true;
          this.addLog('FILL', 'Password filled using getByLabel');
        } catch (e) {
          try {
            await page.getByPlaceholder(/password/i).fill(this.password);
            passwordFilled = true;
            this.addLog('FILL', 'Password filled using getByPlaceholder');
          } catch (e2) {
            throw new Error('Could not find password input field');
          }
        }
      }

      // Wait a bit before submitting
      await page.waitForTimeout(500);

      // Find and click submit button
      this.addLog('SUBMIT', 'Looking for submit button...');
      const submitSelectors = [
        'button[type="submit"]',
        'button:has-text("Log in")',
        'button:has-text("Login")',
        'button:has-text("Sign in")',
        'input[type="submit"]',
        'button[id*="login" i]',
        'button[id*="submit" i]',
      ];

      let submitted = false;
      for (const selector of submitSelectors) {
        try {
          const submitButton = await page.locator(selector).first();
          if (await submitButton.isVisible({ timeout: 2000 })) {
            await submitButton.click();
            submitted = true;
            this.addLog('SUBMIT', `Clicked submit using selector: ${selector}`);
            break;
          }
        } catch (e) {
          continue;
        }
      }

      if (!submitted) {
        try {
          await page.getByRole('button', { name: /log in|login|sign in/i }).click();
          submitted = true;
          this.addLog('SUBMIT', 'Clicked submit using getByRole');
        } catch (e) {
          // Try pressing Enter on the form
          try {
            await page.keyboard.press('Enter');
            submitted = true;
            this.addLog('SUBMIT', 'Submitted form using Enter key');
          } catch (e2) {
            throw new Error('Could not find submit button');
          }
        }
      }

      // Wait for navigation after login
      this.addLog('WAIT', 'Waiting for login to complete...');
      try {
        // Wait for URL to change or for dashboard/home page
        await page.waitForURL(
          (url) => !url.href.includes('/login'),
          { timeout: 20000 }
        ).catch(() => {
          // If URL doesn't change, check if we're still on login page
          if (page.url().includes('/login')) {
            throw new Error('Login failed - still on login page');
          }
        });

        const finalUrl = page.url();
        this.addLog('SUCCESS', `Login successful, current URL: ${finalUrl}`);

        // Take a screenshot
        const screenshot = await page.screenshot({ type: 'png', fullPage: false });

        return {
          success: true,
          message: 'Login successful',
          url: finalUrl,
          screenshot: Buffer.from(screenshot).toString('base64'),
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Login timeout';
        this.addLog('ERROR', 'Login failed', errorMessage);

        // Take a screenshot for debugging
        const screenshot = await page.screenshot({ type: 'png', fullPage: false });

        return {
          success: false,
          message: 'Login failed',
          error: errorMessage,
          screenshot: Buffer.from(screenshot).toString('base64'),
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.addLog('ERROR', 'Login agent error', errorMessage);

      let screenshot: string | undefined;
      if (this.page && !this.page.isClosed()) {
        try {
          const screenshotBuffer = await this.page.screenshot({ type: 'png', fullPage: false });
          screenshot = Buffer.from(screenshotBuffer).toString('base64');
        } catch (e) {
          // Screenshot failed, ignore
        }
      }

      return {
        success: false,
        message: 'Login agent error',
        error: errorMessage,
        screenshot,
      };
    } finally {
      this.isRunning = false;
    }
  }

  async close(): Promise<void> {
    try {
      if (this.page && !this.page.isClosed()) {
        await this.page.close();
      }
      if (this.context) {
        await this.context.close();
      }
      if (this.browser) {
        await this.browser.close();
      }
      this.browser = null;
      this.context = null;
      this.page = null;
      this.addLog('CLEANUP', 'Browser closed');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.addLog('CLEANUP', 'Error closing browser', errorMessage);
    }
  }

  async getCurrentUrl(): Promise<string | null> {
    if (this.page && !this.page.isClosed()) {
      return this.page.url();
    }
    return null;
  }

  async takeScreenshot(): Promise<string | null> {
    if (this.page && !this.page.isClosed()) {
      try {
        const screenshot = await this.page.screenshot({ type: 'png', fullPage: false });
        return Buffer.from(screenshot).toString('base64');
      } catch (error) {
        return null;
      }
    }
    return null;
  }
}

