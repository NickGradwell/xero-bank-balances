import { chromium, Browser, Page, BrowserContext } from 'playwright';
import { authenticator } from 'otplib';
import { logger } from '../../utils/logger';

// Configure authenticator for TOTP (standard Google Authenticator settings)
authenticator.options = {
  digits: 6,
  step: 30, // 30-second windows
  window: [1, 1], // Allow 1 step before/after for clock skew
};

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

export interface BankStatementRow {
  date: string;
  description: string;
  reference: string;
  paymentRef: string;
  spent: string;
  received: string;
  balance: string;
}

export interface AccountStatements {
  accountName: string;
  statements: BankStatementRow[];
  collectedAt: Date;
}

export interface CollectionResult {
  success: boolean;
  accounts: AccountStatements[];
  errors?: string[];
}

export interface AccountIdResult {
  accountId: string;
  accountName: string;
}

export interface StatementLineResult {
  accountId: string;
  accountName?: string;
  lines: BankStatementRow[];
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
    private headless: boolean = true,
    private totpSecret?: string
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
    if (this.browser && this.context && this.page) {
      // Verify browser is still connected
      try {
        if (this.browser.isConnected() && !this.page.isClosed()) {
          return;
        }
      } catch (e) {
        // Browser is disconnected, need to reinitialize
        this.browser = null;
        this.context = null;
        this.page = null;
      }
    }

    // Clean up any existing browser instances first
    if (this.browser || this.context || this.page) {
      this.addLog('INIT', 'Cleaning up existing browser instance...');
      try {
        if (this.page && !this.page.isClosed()) {
          await this.page.close({ runBeforeUnload: false }).catch(() => {});
        }
        if (this.context) {
          await this.context.close().catch(() => {});
        }
        if (this.browser) {
          await this.browser.close().catch(() => {});
        }
      } catch (e) {
        // Ignore cleanup errors
      }
      this.browser = null;
      this.context = null;
      this.page = null;
    }

    try {
      // Only force headless on actual server/cloud environments, not just when DISPLAY is missing
      // (macOS can run headed browsers without DISPLAY set)
      // Check for common server environment indicators
      const envChecks = {
        CI: process.env.CI === 'true',
        RAILWAY_ENVIRONMENT: process.env.RAILWAY_ENVIRONMENT !== undefined,
        DYNO: process.env.DYNO !== undefined,
        VERCEL: process.env.VERCEL !== undefined,
        LINUX_NO_DISPLAY: process.platform === 'linux' && !process.env.DISPLAY,
      };
      
      const isServerEnvironment = 
        envChecks.CI ||
        envChecks.RAILWAY_ENVIRONMENT ||
        envChecks.DYNO ||
        envChecks.VERCEL ||
        envChecks.LINUX_NO_DISPLAY;
      
      const effectiveHeadless = isServerEnvironment ? true : this.headless;
      
      this.addLog('INIT', `Headless mode check: requested=${this.headless}, effective=${effectiveHeadless}, isServer=${isServerEnvironment}`);
      this.addLog('INIT', `Environment checks: ${JSON.stringify(envChecks)}`);
      
      if (isServerEnvironment && !this.headless) {
        this.addLog('INIT', 'Server environment detected - forcing headless mode (headed mode not available)');
      } else {
        this.addLog('INIT', `Initializing browser in ${effectiveHeadless ? 'headless' : 'headed'} mode...`);
      }
      
      const launchArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
      ];
      
      // Add headless-specific args when in headless mode
      if (effectiveHeadless) {
        launchArgs.push(
          '--disable-gpu',
          '--disable-software-rasterizer',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-features=TranslateUI',
          '--disable-ipc-flooding-protection'
        );
      }
      
      this.browser = await chromium.launch({
        headless: effectiveHeadless,
        args: launchArgs,
        // For headed mode on macOS, ensure the window is brought to front
        ...(effectiveHeadless ? {} : { 
          channel: undefined, // Use default Chromium
        }),
      });

      this.addLog('INIT', `Browser launched successfully in ${effectiveHeadless ? 'headless' : 'headed'} mode`);
      if (!effectiveHeadless) {
        this.addLog('INIT', 'Browser window should be visible. If not, check your system display settings.');
        // Give the browser window time to appear
        await new Promise(resolve => setTimeout(resolve, 1000));
        this.addLog('INIT', 'Browser window should now be visible. Check your screen for the Chromium window.');
      }

      this.context = await this.browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      });

      this.page = await this.context.newPage();
      this.addLog('INIT', 'Browser initialized successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.addLog('INIT', 'Failed to initialize browser', errorMessage);
      // Ensure cleanup on failure
      this.browser = null;
      this.context = null;
      this.page = null;
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
        // Wait a bit for the page to process the login
        await page.waitForTimeout(3000);

        // Check if we're on a 2FA page
        const urlAfterSubmit = page.url();
        const pageText = await page.textContent('body').catch(() => '') || '';
        const lowerPageText = pageText.toLowerCase();
        
        const is2FAPage = urlAfterSubmit.includes('/2fa') || 
                          urlAfterSubmit.includes('/two-factor') ||
                          urlAfterSubmit.includes('/verify') ||
                          urlAfterSubmit.includes('/authenticator') ||
                          lowerPageText.includes('authenticator') ||
                          lowerPageText.includes('two-factor') ||
                          lowerPageText.includes('two factor') ||
                          lowerPageText.includes('6-digit code') ||
                          lowerPageText.includes('verification code') ||
                          lowerPageText.includes('enter the code') ||
                          lowerPageText.includes('enter code') ||
                          lowerPageText.includes('security code');

        if (is2FAPage && this.totpSecret) {
          this.addLog('2FA', '2FA challenge detected, generating TOTP code...');
          
          // Trim and validate secret
          const trimmedSecret = this.totpSecret.trim();
          if (!trimmedSecret) {
            throw new Error('TOTP secret is empty after trimming');
          }
          
          this.addLog('2FA', `Using TOTP secret (length: ${trimmedSecret.length}, first 4 chars: ${trimmedSecret.substring(0, 4)}...)`);
          
          // Generate the 6-digit code
          let code: string;
          try {
            code = authenticator.generate(trimmedSecret);
            if (!code || code.length !== 6) {
              throw new Error(`Invalid code generated: ${code}`);
            }
            this.addLog('2FA', `Generated TOTP code: ${code} (at ${new Date().toISOString()})`);
          } catch (genError) {
            const errorMsg = genError instanceof Error ? genError.message : 'Unknown error';
            this.addLog('2FA', `Failed to generate TOTP code: ${errorMsg}`, errorMsg);
            throw new Error(`TOTP code generation failed: ${errorMsg}. Please verify your TOTP secret is correct.`);
          }
          
          // Find and fill the 2FA code input
          const codeSelectors = [
            'input[name="totp"]',
            'input[name="code"]',
            'input[name="verificationCode"]',
            'input[name="twoFactorCode"]',
            'input[placeholder*="code" i]',
            'input[placeholder*="Code" i]',
            'input[type="tel"]',
            'input[inputmode="numeric"]',
            'input[maxlength="6"]',
            'input[data-testid*="code"]',
            'input[data-testid*="totp"]',
            'input[id*="code"]',
            'input[id*="totp"]',
          ];
          
          let codeFilled = false;
          for (const selector of codeSelectors) {
            try {
              const codeField = page.locator(selector).first();
              if (await codeField.isVisible({ timeout: 2000 })) {
                // Clear the field first, then fill
                await codeField.clear();
                await codeField.fill(code);
                // Verify the code was entered correctly
                const enteredValue = await codeField.inputValue();
                if (enteredValue !== code) {
                  this.addLog('2FA', `Warning: Code mismatch. Expected: ${code}, Got: ${enteredValue}`);
                  // Try again
                  await codeField.clear();
                  await codeField.fill(code);
                }
                codeFilled = true;
                this.addLog('2FA', `Filled 2FA code using selector: ${selector}, verified: ${enteredValue}`);
                break;
              }
            } catch (e) {
              continue;
            }
          }
          
          if (!codeFilled) {
            // Try getByLabel/getByPlaceholder as fallback
            try {
              await page.getByLabel(/code|verification/i).fill(code);
              codeFilled = true;
              this.addLog('2FA', 'Filled 2FA code using getByLabel');
            } catch (e) {
              try {
                await page.getByPlaceholder(/code|verification/i).fill(code);
                codeFilled = true;
                this.addLog('2FA', 'Filled 2FA code using getByPlaceholder');
              } catch (e2) {
                throw new Error('Could not find 2FA code input field');
              }
            }
          }
          
          // Click verify/continue button
          const confirmSelectors = [
            'button:has-text("Verify")',
            'button:has-text("Continue")',
            'button:has-text("Confirm")',
            'button:has-text("Submit")',
            'button[type="submit"]',
            'form button[type="submit"]',
            'button[data-testid*="verify"]',
            'button[data-testid*="submit"]',
            'button[id*="verify"]',
            'button[id*="submit"]',
          ];
          
          let submitted2FA = false;
          for (const selector of confirmSelectors) {
            try {
              const btn = page.locator(selector).first();
              if (await btn.isVisible({ timeout: 2000 })) {
                await btn.click();
                submitted2FA = true;
                this.addLog('2FA', `Submitted 2FA code using selector: ${selector}`);
                break;
              }
            } catch (e) {
              continue;
            }
          }
          
          if (!submitted2FA) {
            // Try getByRole as fallback
            try {
              await page.getByRole('button', { name: /verify|continue|confirm|submit/i }).click();
              submitted2FA = true;
              this.addLog('2FA', 'Submitted 2FA code using getByRole');
            } catch (e) {
              // Last resort: press Enter on the form
              try {
                await page.keyboard.press('Enter');
                submitted2FA = true;
                this.addLog('2FA', 'Submitted 2FA code using Enter key');
              } catch (e2) {
                throw new Error('Could not find 2FA submit button');
              }
            }
          }
          
          // Wait for navigation after 2FA submission
          this.addLog('2FA', 'Waiting for 2FA verification to complete...');
          await page.waitForTimeout(3000);
          
          // Check if login succeeded (should be redirected away from login/2FA pages)
          const finalUrlAfter2FA = page.url();
          if (finalUrlAfter2FA.includes('/login') || finalUrlAfter2FA.includes('/2fa') || finalUrlAfter2FA.includes('/verify') || finalUrlAfter2FA.includes('/authenticator')) {
            // Check if there's an error message
            const errorText = await page.textContent('body').catch(() => '') || '';
            const lowerErrorText = errorText.toLowerCase();
            if (lowerErrorText.includes('invalid') || lowerErrorText.includes('incorrect') || lowerErrorText.includes('wrong')) {
              throw new Error('2FA verification failed - invalid code');
            }
            throw new Error('2FA verification may have failed - still on login/2FA page');
          }
          
          this.addLog('2FA', `2FA verification successful, redirected to: ${finalUrlAfter2FA}`);
        } else if (is2FAPage && !this.totpSecret) {
          throw new Error('2FA challenge detected but no TOTP secret configured. Please configure your TOTP secret in the agent settings.');
        }

        // Check for error messages on the page first
        const errorSelectors = [
          '[role="alert"]',
          '.error',
          '.error-message',
          '[class*="error"]',
          '[id*="error"]',
          'div:has-text("incorrect")',
          'div:has-text("locked")',
          'div:has-text("failed")',
          'div:has-text("wrong")',
        ];

        let errorMessage = null;
        for (const selector of errorSelectors) {
          try {
            const errorElement = await page.locator(selector).first();
            if (await errorElement.isVisible({ timeout: 1000 })) {
              errorMessage = await errorElement.textContent();
              if (errorMessage && errorMessage.trim()) {
                this.addLog('ERROR', `Found error message on page: ${errorMessage}`);
                break;
              }
            }
          } catch (e) {
            // Try next selector
            continue;
          }
        }

        // Also check page content for common error messages
        if (!errorMessage) {
          const pageContent = await page.content();
          const lowerContent = pageContent.toLowerCase();
          
          if (lowerContent.includes('incorrect') || lowerContent.includes('wrong password')) {
            errorMessage = 'Incorrect email or password';
          } else if (lowerContent.includes('locked') || lowerContent.includes('account locked')) {
            errorMessage = 'Account has been locked';
          } else if (lowerContent.includes('sso') || lowerContent.includes('single sign on')) {
            errorMessage = 'Account is connected to SSO provider';
          } else if (lowerContent.includes('cookies')) {
            errorMessage = 'Cookies are required to log in';
          }
        }

        // Wait for URL to change or for dashboard/home page
        let urlChanged = false;
        try {
          await page.waitForURL(
            (url) => !url.href.includes('/login'),
            { timeout: 15000 }
          );
          urlChanged = true;
        } catch (e) {
          // URL didn't change, check current state
          const currentUrl = page.url();
          if (currentUrl.includes('/login')) {
            if (errorMessage) {
              throw new Error(`Login failed: ${errorMessage}`);
            }
            throw new Error('Login failed - still on login page after submission');
          }
          // URL changed but didn't match our pattern, might still be success
          urlChanged = true;
        }

        const finalUrl = page.url();
        
        // If we have an error message but URL changed, log it but continue
        if (errorMessage && urlChanged) {
          this.addLog('WARN', `Warning: Error message detected but URL changed: ${errorMessage}`);
        }

        if (errorMessage && !urlChanged) {
          throw new Error(`Login failed: ${errorMessage}`);
        }

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

        // Try to get more details from the page
        try {
          const pageText = await page.textContent('body');
          if (pageText) {
            const errorSnippet = pageText.substring(0, 500);
            this.addLog('DEBUG', `Page content snippet: ${errorSnippet}`);
          }
        } catch (e) {
          // Ignore if we can't get page content
        }

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
      // Close page first
      if (this.page && !this.page.isClosed()) {
        try {
          await this.page.close({ runBeforeUnload: false });
        } catch (e) {
          // Ignore errors when closing page
        }
      }
      this.page = null;

      // Close context
      if (this.context) {
        try {
          await this.context.close();
        } catch (e) {
          // Ignore errors when closing context
        }
      }
      this.context = null;

      // Close browser last
      if (this.browser) {
        try {
          await this.browser.close();
        } catch (e) {
          // Ignore errors when closing browser
        }
      }
      this.browser = null;

      this.addLog('CLEANUP', 'Browser closed');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.addLog('CLEANUP', 'Error closing browser', errorMessage);
      // Force reset even if cleanup failed
      this.browser = null;
      this.context = null;
      this.page = null;
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

  async collectBankStatements(limit: number = 3): Promise<CollectionResult> {
    if (!this.page || this.page.isClosed()) {
      throw new Error('Page not initialized. Please login first.');
    }

    const page = this.page;
    const accounts: AccountStatements[] = [];
    const errors: string[] = [];

    try {
      // Wait for dashboard to load (up to 60 seconds)
      this.addLog('COLLECT', 'Waiting for dashboard to load (up to 60s)...');
      try {
        await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {
          this.addLog('COLLECT', 'networkidle timeout, waiting for page elements...');
        });
        // Wait for account headings to appear (up to 60s)
        await page.waitForSelector('h2.mf-bank-widget-heading-large', { timeout: 60000 });
        await page.waitForTimeout(3000); // Additional wait for dynamic content
      } catch (e) {
        this.addLog('COLLECT', 'Dashboard load timeout, proceeding anyway after 60s...');
      }

      // Find all account cards via headings on the dashboard
      this.addLog('COLLECT', 'Looking for account cards (h2.mf-bank-widget-heading-large)...');
      let accountCards: any[] = [];
      try {
        const headingCards = await page.locator('h2.mf-bank-widget-heading-large').all();
        if (headingCards.length > 0) {
          this.addLog('COLLECT', `Found ${headingCards.length} account headings`);
          accountCards = headingCards;
        }
      } catch (e) {
        // ignore
      }

      // Fallback to previous selector list if needed
      if (accountCards.length === 0) {
        const accountCardSelectors = [
          '[data-testid*="account"]',
          '.account-card',
          '.account-item',
          '[class*="account"]',
          'a[href*="/account/"]',
          'div[class*="AccountCard"]',
          'li[class*="account"]',
        ];

        for (const selector of accountCardSelectors) {
          try {
            const cards = await page.locator(selector).all();
            if (cards.length > 0) {
              this.addLog('COLLECT', `Found ${cards.length} account cards using selector: ${selector}`);
              accountCards = cards;
              break;
            }
          } catch (e) {
            continue;
          }
        }
      }

      if (accountCards.length === 0) {
        throw new Error('Could not find any account cards on the page');
      }

      const cardsToProcess = accountCards.slice(0, limit);
      this.addLog('COLLECT', `Processing ${cardsToProcess.length} account cards...`);

      for (let i = 0; i < cardsToProcess.length; i++) {
        const card = cardsToProcess[i];
        let accountName = 'Unknown Account';

        try {
          this.addLog('COLLECT', `Processing account ${i + 1} of ${cardsToProcess.length}...`);

          // Extract account name from the heading
          try {
            const nameText = await card.textContent();
            if (nameText) {
              accountName = nameText.trim().split('\n')[0].trim();
              accountName = accountName.replace(/\s*\(\d+\)\s*$/, '').trim();
            }
          } catch (e) {
            this.addLog('COLLECT', `Could not extract account name, using default`);
          }

          this.addLog('COLLECT', `Account name: ${accountName}`);

          // Click on the account heading (with multiple strategies)
          const clickTargets = [
            card,
            card.locator('xpath=ancestor::a[1]'),
            card.locator('xpath=ancestor::button[1]'),
            card.locator('xpath=ancestor::*[self::div or self::li][1]'),
          ];

          let clicked = false;
          for (const target of clickTargets) {
            try {
              await target.scrollIntoViewIfNeeded();
              await page.waitForTimeout(200);
              await target.click({ timeout: 5000, force: true });
              this.addLog('COLLECT', `Clicked on account: ${accountName}`);
              clicked = true;
              break;
            } catch (e) {
              continue;
            }
          }

          if (!clicked) {
            const errorMsg = `Failed to click on account ${accountName}`;
            this.addLog('COLLECT', errorMsg, errorMsg);
            errors.push(errorMsg);
            continue;
          }

          // Wait for account detail page to load
          this.addLog('COLLECT', `Waiting for account detail page to load...`);
          await page.waitForTimeout(3000); // Wait for page to start loading
          try {
            await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {
              this.addLog('COLLECT', 'networkidle timeout, proceeding...');
            });
            await page.waitForTimeout(2000); // Additional wait
          } catch (e) {
            this.addLog('COLLECT', 'Page load timeout, proceeding anyway...');
          }

          // Look for "Bank Statements" link
          this.addLog('COLLECT', `Looking for "Bank Statements" link...`);
          // Look for explicit Bank statements tab/link
          this.addLog('COLLECT', 'Looking for "Bank statements" tab/link...');
          let bankStatementsTab = page.locator('a[href*="Bank/Statements.aspx"]', { hasText: /bank statements/i }).first();
          try {
            if (!(await bankStatementsTab.isVisible({ timeout: 15000 }))) {
              // fallback to generic text
              bankStatementsTab = page.locator('a:has-text("Bank statements"), button:has-text("Bank statements")').first();
              await bankStatementsTab.waitFor({ timeout: 15000 });
            }
          } catch (e) {
            this.addLog('COLLECT', 'Bank statements tab not immediately visible, continuing to search...');
          }

          try {
            await bankStatementsTab.scrollIntoViewIfNeeded();
            await page.waitForTimeout(200);
            await bankStatementsTab.click({ timeout: 15000, force: true });
            this.addLog('COLLECT', 'Clicked "Bank statements" tab');
          } catch (e) {
            const errorMsg = `Failed to click "Bank statements" tab for account "${accountName}"`;
            this.addLog('COLLECT', errorMsg, errorMsg);
            errors.push(errorMsg);
            await this.navigateToHome();
            continue;
          }

          // Wait for navigation to statements page
          try {
            await page.waitForURL(/Bank\/Statements\.aspx/i, { timeout: 30000 });
            this.addLog('COLLECT', 'Navigated to Bank statements page');
          } catch (e) {
            this.addLog('COLLECT', 'URL did not change to Bank statements, continuing to look for table');
          }

          // Click on "Bank statements" tab (already located as bankStatementsTab)
          this.addLog('COLLECT', `Clicking "Bank statements" tab...`);
          try {
            await bankStatementsTab.scrollIntoViewIfNeeded();
            await page.waitForTimeout(200);
            await bankStatementsTab.click({ timeout: 10000, force: true });
            this.addLog('COLLECT', 'Clicked "Bank statements" tab');
          } catch (e) {
            const errorMsg = `Failed to click "Bank statements" tab for account "${accountName}"`;
            this.addLog('COLLECT', errorMsg, errorMsg);
            errors.push(errorMsg);
            await this.navigateToHome();
            continue;
          }

          // Wait for table to load (specific table) up to 45s
          this.addLog('COLLECT', `Waiting for statements table to load...`);
          await page.waitForTimeout(3000); // start loading
          try {
            await page.waitForSelector('table#statementDetails.standard[data-automationid="statementGrid"]', { timeout: 45000 });
            this.addLog('COLLECT', 'Statement table found, waiting for data...');
            await page.waitForTimeout(3000); // Additional wait for data
          } catch (e) {
            const errorMsg = `Table did not load for account "${accountName}"`;
            this.addLog('COLLECT', errorMsg, errorMsg);
            errors.push(errorMsg);
            await this.navigateToHome();
            continue;
          }

          // Extract table data
          this.addLog('COLLECT', `Extracting table data for account "${accountName}"...`);
          const statements = await this.extractTableData(page);

          if (statements.length === 0) {
            this.addLog('COLLECT', `No statements found in table for account "${accountName}"`);
          } else {
            this.addLog('COLLECT', `Extracted ${statements.length} statement rows for account "${accountName}"`);
          }

          accounts.push({
            accountName,
            statements,
            collectedAt: new Date(),
          });

          // Navigate back to home/dashboard
          await this.navigateToHome();
          await page.waitForTimeout(2000); // Wait before processing next account

        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          const fullError = `Error processing account "${accountName}": ${errorMsg}`;
          this.addLog('COLLECT', fullError, fullError);
          errors.push(fullError);
          // Try to navigate back to home
          try {
            await this.navigateToHome();
          } catch (e) {
            // If navigation fails, try to reload the page
            try {
              await page.goto(page.url().split('/').slice(0, 3).join('/'));
            } catch (e2) {
              // Ignore
            }
          }
        }
      }

      this.addLog('COLLECT', `Collection complete. Processed ${accounts.length} accounts with ${errors.length} errors.`);

      return {
        success: accounts.length > 0,
        accounts,
        errors: errors.length > 0 ? errors : undefined,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.addLog('COLLECT', `Collection failed: ${errorMessage}`, errorMessage);
      return {
        success: false,
        accounts,
        errors: [...(errors || []), errorMessage],
      };
    }
  }

  /**
   * Agent 1: collect account IDs and names from the dashboard headings/cards.
   */
  async collectAccountIds(limit: number = 3): Promise<{ success: boolean; accounts: AccountIdResult[]; errors?: string[] }> {
    if (!this.page || this.page.isClosed()) {
      throw new Error('Page not initialized. Please login first.');
    }

    const page = this.page;
    const accounts: AccountIdResult[] = [];
    const errors: string[] = [];

    this.addLog('ACCOUNTS', `Starting account ID collection (limit: ${limit})...`);
    this.addLog('ACCOUNTS', `Current URL: ${page.url()}`);
    
    // Check if we're on the dashboard/home page
    const currentUrl = page.url();
    if (!currentUrl.includes('go.xero.com') || currentUrl.includes('/login')) {
      this.addLog('ACCOUNTS', 'Not on dashboard, navigating to home...');
      await this.navigateToHome();
      await page.waitForTimeout(2000);
    }

    this.addLog('ACCOUNTS', 'Looking for account headings (h2.mf-bank-widget-heading-large)...');
    try {
      await page.waitForSelector('h2.mf-bank-widget-heading-large', { timeout: 60000 });
      this.addLog('ACCOUNTS', 'Account headings found!');
    } catch (e) {
      const errorMsg = `Timed out waiting for account headings after 60s. Current URL: ${page.url()}`;
      this.addLog('ACCOUNTS', errorMsg, errorMsg);
      // Try to take a screenshot for debugging
      try {
        await page.screenshot({ path: undefined, fullPage: false });
        this.addLog('ACCOUNTS', 'Screenshot captured for debugging');
      } catch (screenshotError) {
        this.addLog('ACCOUNTS', `Screenshot failed: ${screenshotError instanceof Error ? screenshotError.message : 'Unknown'}`);
      }
      return { success: false, accounts, errors: [errorMsg] };
    }

    const headings = await page.locator('h2.mf-bank-widget-heading-large').all();
    this.addLog('ACCOUNTS', `Found ${headings.length} account headings, processing first ${limit}...`);
    const toProcess = headings.slice(0, limit);

    for (let i = 0; i < toProcess.length; i++) {
      const heading = toProcess[i];
      try {
        this.addLog('ACCOUNTS', `Processing heading ${i + 1}/${toProcess.length}...`);
        const nameText = (await heading.textContent()) || '';
        const accountName = nameText.trim().replace(/\s+\(\d+\)\s*$/, '');
        this.addLog('ACCOUNTS', `Found account name: "${accountName}"`);

        // Try to find an href with accountID near this heading
        let accountId: string | null = null;

        // 1) closest ancestor link
        this.addLog('ACCOUNTS', `  Method 1: Checking ancestor link...`);
        const ancestorLink = heading.locator('xpath=ancestor::a[1]');
        try {
          if (await ancestorLink.count()) {
            const href = await ancestorLink.getAttribute('href');
            this.addLog('ACCOUNTS', `  Found ancestor href: ${href || 'null'}`);
            // Check for accountID or accountId (case-insensitive)
            if (href && /accountId?=/i.test(href)) {
              // Try multiple regex patterns to extract accountID (case-insensitive)
              // Pattern 1: accountID=value or accountId=value (standard, case-insensitive)
              let match = href.match(/accountId?=([A-Za-z0-9\-_]+)/i);
              // Pattern 2: accountID%3Dvalue or accountId%3Dvalue (URL encoded)
              if (!match) {
                const decoded = decodeURIComponent(href);
                match = decoded.match(/accountId?=([A-Za-z0-9\-_]+)/i);
              }
              // Pattern 3: accountID%3Dvalue in original (direct match, case-insensitive)
              if (!match) {
                match = href.match(/accountId?%3D([A-Za-z0-9\-_]+)/i);
              }
              // Pattern 4: accountID=value& or accountID=value" or accountID=value'
              if (!match) {
                match = href.match(/accountId?=([A-Za-z0-9\-_]+)[&"']?/i);
              }
              if (match && match[1]) {
                accountId = match[1];
                this.addLog('ACCOUNTS', `  ✓ Found accountID via ancestor: ${accountId}`);
              } else {
                this.addLog('ACCOUNTS', `  ✗ Could not extract accountID from href: ${href}`);
              }
            } else {
              this.addLog('ACCOUNTS', `  Href does not contain accountID/accountId parameter`);
            }
          } else {
            this.addLog('ACCOUNTS', `  No ancestor link found`);
          }
        } catch (e) {
          this.addLog('ACCOUNTS', `  Error checking ancestor: ${e instanceof Error ? e.message : 'Unknown'}`);
        }

        // 2) search within the card block
        if (!accountId) {
          this.addLog('ACCOUNTS', `  Method 2: Checking card block links...`);
          try {
            const cardLink = heading.locator('xpath=ancestor::*[self::div or self::li][1]').locator('a[href*="accountID="]').first();
            if (await cardLink.count()) {
              const href = await cardLink.getAttribute('href');
              this.addLog('ACCOUNTS', `  Found card href: ${href || 'null'}`);
              // Check for accountID or accountId (case-insensitive)
              if (href && /accountId?=/i.test(href)) {
                // Try multiple regex patterns to extract accountID (case-insensitive)
                let match = href.match(/accountId?=([A-Za-z0-9\-_]+)/i);
                if (!match) {
                  const decoded = decodeURIComponent(href);
                  match = decoded.match(/accountId?=([A-Za-z0-9\-_]+)/i);
                }
                if (!match) {
                  match = href.match(/accountId?%3D([A-Za-z0-9\-_]+)/i);
                }
                if (!match) {
                  match = href.match(/accountId?=([A-Za-z0-9\-_]+)[&"']?/i);
                }
                if (match && match[1]) {
                  accountId = match[1];
                  this.addLog('ACCOUNTS', `  ✓ Found accountID via card: ${accountId}`);
                } else {
                  this.addLog('ACCOUNTS', `  ✗ Could not extract accountID from card href: ${href}`);
                }
              }
            } else {
              this.addLog('ACCOUNTS', `  No card link found`);
            }
          } catch (e) {
            this.addLog('ACCOUNTS', `  Error checking card: ${e instanceof Error ? e.message : 'Unknown'}`);
          }
        }

        // 3) global fallback search by text
        if (!accountId) {
          this.addLog('ACCOUNTS', `  Method 3: Searching by account name text...`);
          try {
            const linkByText = page.locator(`a:has-text("${accountName}")`).filter({ has: page.locator('a[href*="accountID="]') }).first();
            if (await linkByText.count()) {
              const href = await linkByText.getAttribute('href');
              this.addLog('ACCOUNTS', `  Found text link href: ${href || 'null'}`);
              // Check for accountID or accountId (case-insensitive)
              if (href && /accountId?=/i.test(href)) {
                // Try multiple regex patterns to extract accountID (case-insensitive)
                let match = href.match(/accountId?=([A-Za-z0-9\-_]+)/i);
                if (!match) {
                  const decoded = decodeURIComponent(href);
                  match = decoded.match(/accountId?=([A-Za-z0-9\-_]+)/i);
                }
                if (!match) {
                  match = href.match(/accountId?%3D([A-Za-z0-9\-_]+)/i);
                }
                if (!match) {
                  match = href.match(/accountId?=([A-Za-z0-9\-_]+)[&"']?/i);
                }
                if (match && match[1]) {
                  accountId = match[1];
                  this.addLog('ACCOUNTS', `  ✓ Found accountID via text search: ${accountId}`);
                } else {
                  this.addLog('ACCOUNTS', `  ✗ Could not extract accountID from text link href: ${href}`);
                }
              } else {
                this.addLog('ACCOUNTS', `  No accountID/accountId in text link href`);
              }
            } else {
              this.addLog('ACCOUNTS', `  No text link found`);
            }
          } catch (e) {
            this.addLog('ACCOUNTS', `  Error checking text link: ${e instanceof Error ? e.message : 'Unknown'}`);
          }
        }

        if (accountId) {
          accounts.push({ accountId, accountName });
          this.addLog('ACCOUNTS', `✓ Successfully captured account: ${accountName} (ID: ${accountId})`);
        } else {
          const msg = `Could not find accountID for "${accountName}" after trying all methods`;
          errors.push(msg);
          this.addLog('ACCOUNTS', `✗ ${msg}`, msg);
        }
      } catch (e) {
        const msg = `Error processing heading ${i + 1}: ${e instanceof Error ? e.message : 'Unknown error'}`;
        errors.push(msg);
        this.addLog('ACCOUNTS', `✗ ${msg}`, msg);
      }
    }

    this.addLog('ACCOUNTS', `Collection complete: ${accounts.length} accounts captured, ${errors.length} errors`);
    return { success: accounts.length > 0, accounts, errors: errors.length ? errors : undefined };
  }

  /**
   * Agent 2: collect statements by direct account IDs.
   */
  async collectStatementsByIds(
    accountInputs: { accountId: string; accountName?: string }[],
    limit: number = 3
  ): Promise<{ success: boolean; results: StatementLineResult[]; errors?: string[] }> {
    if (!this.page || this.page.isClosed()) {
      throw new Error('Page not initialized. Please login first.');
    }

    const page = this.page;
    const results: StatementLineResult[] = [];
    const errors: string[] = [];
    const toProcess = accountInputs.slice(0, limit);

    for (const acc of toProcess) {
      const { accountId, accountName } = acc;
      const nameLabel = accountName || accountId;
      try {
        this.addLog('COLLECT_ID', `Navigating to statements for ${nameLabel} (${accountId})`);
        const url = `https://go.xero.com/Bank/Statements.aspx?accountID=${accountId}`;
        await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => null);
        await page.waitForTimeout(3000);

        try {
          await page.waitForSelector('table#statementDetails.standard[data-automationid="statementGrid"]', { timeout: 45000 });
          this.addLog('COLLECT_ID', 'Statement table found, extracting rows...');
        } catch (e) {
          const msg = `Table did not load for account ${nameLabel}`;
          errors.push(msg);
          this.addLog('COLLECT_ID', msg, msg);
          continue;
        }

        const lines: BankStatementRow[] = [];
        const rows = await page.locator('table#statementDetails.standard[data-automationid="statementGrid"] tbody tr[data-statementid]').all();
        for (const row of rows) {
          try {
            const cells = await row.locator('td, th').all();
            if (cells.length < 10) continue;

            const texts: string[] = [];
            for (const cell of cells) {
              const t = await cell.textContent();
              texts.push(t ? t.trim() : '');
            }

            const date = texts[1] || '';
            const particulars = texts[4] || '';
            const code = texts[5] || '';
            const reference = texts[6] || '';
            const spent = texts[8] || '';
            const received = texts[9] || '';
            const balance = texts[10] || '';
            // const source = texts[11] || '';
            // const status = texts[12] || '';

            const description = particulars;
            const paymentRef = code;

            if (date) {
              lines.push({
                date,
                description,
                reference,
                paymentRef,
                spent,
                received,
                balance,
              });
            }
          } catch (e) {
            continue;
          }
        }

        results.push({ accountId, accountName, lines });
        this.addLog('COLLECT_ID', `Extracted ${lines.length} rows for ${nameLabel}`);
      } catch (e) {
        const msg = `Error collecting statements for ${nameLabel}: ${e instanceof Error ? e.message : 'Unknown error'}`;
        errors.push(msg);
        this.addLog('COLLECT_ID', msg, msg);
      }
    }

    return { success: results.length > 0, results, errors: errors.length ? errors : undefined };
  }

  private async navigateToHome(): Promise<void> {
    if (!this.page || this.page.isClosed()) {
      return;
    }

    const page = this.page;
    this.addLog('NAVIGATE', 'Navigating to home/dashboard...');

    // Try various ways to get back to home
    const homeSelectors = [
      'a:has-text("Home")',
      'button:has-text("Home")',
      '[role="link"]:has-text("Home")',
      'a[href*="/dashboard"]',
      'a[href*="/home"]',
      'a[aria-label*="Home" i]',
      'button[aria-label*="Home" i]',
      '[data-testid*="home"]',
      '[data-testid*="dashboard"]',
    ];

    let navigated = false;
    for (const selector of homeSelectors) {
      try {
        const homeLink = page.locator(selector).first();
        if (await homeLink.isVisible({ timeout: 2000 })) {
          await homeLink.click();
          navigated = true;
          this.addLog('NAVIGATE', `Clicked home using selector: ${selector}`);
          break;
        }
      } catch (e) {
        continue;
      }
    }

    if (!navigated) {
      // Try getByRole
      try {
        await page.getByRole('link', { name: /home/i }).first().click();
        navigated = true;
        this.addLog('NAVIGATE', 'Clicked home using getByRole');
      } catch (e) {
        // Try navigating to base URL
        try {
          const currentUrl = page.url();
          const baseUrl = currentUrl.split('/').slice(0, 3).join('/');
          await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 15000 });
          navigated = true;
          this.addLog('NAVIGATE', `Navigated to base URL: ${baseUrl}`);
        } catch (e2) {
          this.addLog('NAVIGATE', 'Could not navigate to home, continuing anyway...');
        }
      }
    }

    if (navigated) {
      await page.waitForTimeout(2000); // Wait for page to load
    }
  }

  private async extractTableData(page: Page): Promise<BankStatementRow[]> {
    const statements: BankStatementRow[] = [];

    try {
      // Find the specific statements table
      const table = page.locator('table#statementDetails.standard[data-automationid="statementGrid"]').first();
      if (!(await table.isVisible({ timeout: 4000 }))) {
        this.addLog('EXTRACT', 'Statement table not visible');
        return statements;
      }

      // Get all data rows (skip header)
      const rows = await table.locator('tbody tr[data-statementid]').all();
      this.addLog('EXTRACT', `Found ${rows.length} data rows`);

      for (const row of rows) {
        try {
          const cells = await row.locator('td, th').all();
          if (cells.length < 10) {
            continue; // Not enough cells to map expected columns
          }

          const cellTexts: string[] = [];
          for (const cell of cells) {
            const text = await cell.textContent();
            cellTexts.push(text ? text.trim() : '');
          }

          // Table columns order (after the checkbox column):
          // 0: checkbox, 1: Date, 2: Type, 3: Payee, 4: Particulars, 5: Code,
          // 6: Reference, 7: Analysis Code, 8: Spent, 9: Received, 10: Balance, 11: Source, 12: Status
          const date = cellTexts[1] || '';
          // const type = cellTexts[2] || ''; // Not used in current output
          const payee = cellTexts[3] || '';
          const particulars = cellTexts[4] || '';
          const code = cellTexts[5] || '';
          const reference = cellTexts[6] || '';
          const spent = cellTexts[8] || '';
          const received = cellTexts[9] || '';
          const balance = cellTexts[10] || '';

          // Map to our existing structure:
          // description -> particulars (fallback to payee), paymentRef -> code
          const description = particulars || payee || '';
          const paymentRef = code;

          if (date) {
            statements.push({
              date,
              description,
              reference,
              paymentRef,
              spent,
              received,
              balance,
            });
          }
        } catch (e) {
          // Skip this row if there's an error
          continue;
        }
      }

      this.addLog('EXTRACT', `Successfully extracted ${statements.length} statement rows`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.addLog('EXTRACT', `Error extracting table data: ${errorMessage}`, errorMessage);
    }

    return statements;
  }
}

