import express from 'express';
import path from 'path';
import session from 'express-session';
import { randomUUID } from 'crypto';
import { config } from './config';
import { logger } from './utils/logger';
import { getAuthorizationUrl, exchangeCodeForToken, setTokenSet, getXeroClient } from './services/xero/auth';
import { XeroService } from './services/xero/client';
import { XeroTokenSet } from './types/xero';

const app = express();

// Extend Express Session to include Xero token set
declare module 'express-session' {
  interface SessionData {
    xeroTokenSet?: XeroTokenSet;
    oauthState?: string;
  }
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Trust proxy headers
app.set('trust proxy', 1);

// Session configuration
app.use(
  session({
    secret: config.app.sessionSecret,
    resave: false,
    saveUninitialized: false,
    name: 'xero.session',
    cookie: {
      secure: config.app.nodeEnv === 'production',
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      sameSite: 'lax',
    },
  })
);

// Serve static files (web UI)
app.use(express.static(path.join(__dirname, 'views')));

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'xero-bank-balances',
  });
});

// OAuth 2.0 - Initiate authorization
app.get('/auth/xero', async (req, res) => {
  try {
    const state = randomUUID();
    req.session.oauthState = state;

    const authUrl = await getAuthorizationUrl(state);
    logger.info('Redirecting to Xero authorization', { state });

    res.redirect(authUrl);
  } catch (error) {
    logger.error('Failed to initiate OAuth flow', { error });
    res.status(500).json({ error: 'Failed to initiate authorization' });
  }
});

// OAuth 2.0 - Handle callback
app.get('/auth/xero/callback', async (req, res): Promise<void> => {
  try {
    const { code, state } = req.query;

    logger.info('OAuth callback received', {
      hasCode: !!code,
      hasState: !!state,
      stateType: typeof state,
      stateValue: state,
    });

    if (!code || typeof code !== 'string') {
      logger.error('Authorization code missing in callback');
      res.status(400).send('Authorization code missing');
      return;
    }

    // Extract state parameter - Express query params can be undefined, string, string[], or ParsedQs
    // openid-client will validate state automatically, so we just need to ensure we have a string
    let stateValue: string = '';
    
    if (state === undefined || state === null) {
      // State might be missing, but openid-client will handle validation
      logger.warn('State parameter missing from callback (will be validated by openid-client)');
    } else if (typeof state === 'string') {
      stateValue = state;
    } else if (Array.isArray(state)) {
      // Handle array case - use first element if it's a string
      const firstState = state[0];
      if (typeof firstState === 'string') {
        stateValue = firstState;
      } else {
        logger.warn('State parameter array contains non-string value', { state });
      }
    } else {
      // Handle ParsedQs case - convert to string
      stateValue = String(state);
      logger.warn('State parameter is ParsedQs type, converting to string', { state });
    }

    // Exchange code for token - openid-client extracts state from URL and validates it automatically
    const tokenSet = await exchangeCodeForToken(code, stateValue);

    // Store token set in session
    req.session.xeroTokenSet = tokenSet;
    req.session.oauthState = undefined;

    logger.info('OAuth callback successful', {
      tenantId: tokenSet.xero_tenant_id,
    });

    // Redirect to main page
    res.redirect('/');
  } catch (error) {
    // Log the full error details
    const errorDetails: any = {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      name: error instanceof Error ? error.name : undefined,
    };
    
    // Try to extract response details if available
    if (error instanceof Error && (error as any).response) {
      errorDetails.response = {
        status: (error as any).response?.status,
        statusText: (error as any).response?.statusText,
        data: (error as any).response?.data,
      };
    }
    
    logger.error('OAuth callback failed', errorDetails);
    res.status(500).send('Authentication failed. Please try again.');
  }
});

// Logout endpoint
app.post('/auth/logout', (req, res): void => {
  req.session.destroy((err) => {
    if (err) {
      logger.error('Failed to destroy session', { error: err });
      res.status(500).json({ error: 'Failed to logout' });
      return;
    }
    res.redirect('/');
  });
});

// Debug endpoint - Get current tokens (for Postman testing)
// WARNING: This endpoint exposes sensitive tokens. Remove or secure in production!
app.get('/api/debug/tokens', (req, res): void => {
  const tokenSet = req.session.xeroTokenSet;
  if (!tokenSet) {
    res.status(401).json({ 
      error: 'Not authenticated',
      message: 'Please complete OAuth flow first by visiting /auth/xero'
    });
    return;
  }
  
  res.json({
    access_token: tokenSet.access_token,
    xero_tenant_id: tokenSet.xero_tenant_id,
    expires_at: tokenSet.expires_at,
    expires_at_formatted: new Date(tokenSet.expires_at * 1000).toISOString(),
    expires_in_seconds: Math.max(0, tokenSet.expires_at - Math.floor(Date.now() / 1000)),
    token_type: tokenSet.token_type,
    note: 'Copy access_token and xero_tenant_id to Postman collection variables',
  });
});

// API endpoint to get bank accounts
app.get('/api/xero/accounts', async (req, res): Promise<void> => {
  try {
    const tokenSet = req.session.xeroTokenSet;

    if (!tokenSet) {
      res.status(401).json({
        error: 'Not authenticated',
        requiresAuth: true,
      });
      return;
    }

    const xeroService = new XeroService(tokenSet);
    const bankAccounts = await xeroService.getBankAccounts(tokenSet);

    // Update session with potentially refreshed token
    const updatedTokenSet = req.session.xeroTokenSet;
    if (updatedTokenSet && updatedTokenSet !== tokenSet) {
      req.session.xeroTokenSet = updatedTokenSet;
    }

    res.json({
      accounts: bankAccounts,
      count: bankAccounts.length,
    });
  } catch (error) {
    logger.error('Failed to fetch bank accounts', { error });
    res.status(500).json({
      error: 'Failed to fetch bank accounts',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// API endpoint to get all transactions for "The Forest" account (using Journals)
app.get('/api/xero/transactions/all', async (req, res): Promise<void> => {
  try {
    const tokenSet = req.session.xeroTokenSet;

    if (!tokenSet) {
      res.status(401).json({ error: 'Not authenticated', requiresAuth: true });
      return;
    }

    // Get current month/year or use query params
    const month = req.query.month ? parseInt(req.query.month as string, 10) : new Date().getMonth() + 1;
    const year = req.query.year ? parseInt(req.query.year as string, 10) : new Date().getFullYear();

    // Validate month and year
    if (month < 1 || month > 12) {
      res.status(400).json({ error: 'Invalid month. Must be between 1 and 12.' });
      return;
    }

    if (year < 2000 || year > 2100) {
      res.status(400).json({ error: 'Invalid year.' });
      return;
    }

    // Calculate date range for the selected month
    const fromDate = new Date(year, month - 1, 1);
    const toDate = new Date(year, month, 0); // Last day of the month

    // Format dates as YYYY-MM-DD
    const formatDate = (date: Date): string => {
      return date.toISOString().split('T')[0];
    };

    const xeroService = new XeroService(tokenSet);
    
    // First, get bank accounts to find "The Forest" account
    const bankAccounts = await xeroService.getBankAccounts(tokenSet);
    const forestAccount = bankAccounts.find(acc => 
      acc.name.toLowerCase().includes('forest')
    );

    if (!forestAccount) {
      res.status(404).json({ error: 'Could not find "The Forest" account' });
      return;
    }

        // Get transactions for "The Forest" account using Account Transactions Report
        const transactions = await xeroService.getAccountTransactionsReport(
          tokenSet,
          forestAccount.accountId,
          forestAccount.name,
          forestAccount.code,
          formatDate(fromDate),
          formatDate(toDate)
        );

    // Update session with potentially refreshed token
    const updatedTokenSet = req.session.xeroTokenSet;
    if (updatedTokenSet && updatedTokenSet !== tokenSet) {
      req.session.xeroTokenSet = updatedTokenSet;
    }

    res.json({ 
      count: transactions.length, 
      month: month,
      year: year,
      account: {
        id: forestAccount.accountId,
        name: forestAccount.name,
        code: forestAccount.code,
      },
      transactions: transactions 
    });
  } catch (error) {
    logger.error('Failed to fetch all transactions', { error });
    res.status(500).json({ error: 'Failed to fetch all transactions' });
  }
});

// API endpoint to get 100 journal entries (unfiltered, any account)
app.get('/api/xero/transactions/100', async (req, res): Promise<void> => {
  try {
    const tokenSet = req.session.xeroTokenSet;

    if (!tokenSet) {
      res.status(401).json({ error: 'Not authenticated', requiresAuth: true });
      return;
    }

    const xeroService = new XeroService(tokenSet);
    const tenantId = tokenSet.xero_tenant_id;
    if (!tenantId) {
      res.status(500).json({ error: 'No tenant ID available' });
      return;
    }

    // Fetch first 100 Journals (unfiltered)
    const validTokenSet = await xeroService.ensureValidToken(tokenSet);
    await setTokenSet(validTokenSet);

    const client = getXeroClient();
    const response = await client.accountingApi.getJournals(
      tenantId,
      undefined, // ifModifiedSince - no filter
      0, // offset - start at 0
      false // paymentsOnly - false = get all journals
    );

    const journals = response.body.journals || [];
    const limitedJournals = journals.slice(0, 100); // Limit to 100 journals

    // Transform journals to our format - show journal lines with account info
    const formattedTransactions: any[] = [];
    
    for (const journal of limitedJournals) {
      if (!journal.journalLines || journal.journalLines.length === 0) continue;
      
      // Each journal line represents a transaction entry
      for (const line of journal.journalLines) {
        const amount = line.netAmount || line.grossAmount || 0;
        const currencyCode = 'GBP'; // Default, or extract from journal if available
        
        const formattedAmount = new Intl.NumberFormat('en-GB', {
          style: 'currency',
          currency: currencyCode,
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(amount);

        let description = journal.reference || journal.sourceID || '';
        if (!description && line.description) {
          description = line.description;
        }
        if (!description) {
          description = journal.journalNumber?.toString() || 'Journal Entry';
        }

        formattedTransactions.push({
          transactionId: journal.journalID || `journal-${journal.journalNumber}`,
          date: journal.journalDate ? new Date(journal.journalDate).toISOString().split('T')[0] : '',
          description: description,
          reference: journal.reference || journal.sourceID,
          amount: amount,
          amountFormatted: formattedAmount,
          type: amount >= 0 ? 'DEBIT' : 'CREDIT',
          status: journal.createdDateUTC ? 'AUTHORISED' : 'DRAFT',
          bankAccountId: line.accountID || '',
          bankAccountName: line.accountName || '',
          bankAccountCode: line.accountCode || '',
          journalNumber: journal.journalNumber,
          journalID: journal.journalID,
        });

        // Stop if we've collected 100 entries
        if (formattedTransactions.length >= 100) break;
      }
      
      // Stop if we've collected 100 entries
      if (formattedTransactions.length >= 100) break;
    }

    // Limit to 100 total entries (across all journal lines)
    const finalTransactions = formattedTransactions.slice(0, 100);

    logger.info(`Fetched ${finalTransactions.length} journal entries from ${limitedJournals.length} journals`);

    res.json({
      count: finalTransactions.length,
      transactions: finalTransactions,
      note: 'Showing journal entries (each journal may have multiple lines)',
    });
  } catch (error) {
    logger.error('Failed to fetch 100 journal entries', { error });
    res.status(500).json({ error: 'Failed to fetch 100 journal entries' });
  }
});

// API endpoint to get bank transactions for a specific account
app.get('/api/xero/accounts/:accountId/transactions', async (req, res): Promise<void> => {
  try {
    const tokenSet = req.session.xeroTokenSet;

    if (!tokenSet) {
      res.status(401).json({
        error: 'Not authenticated',
        requiresAuth: true,
      });
      return;
    }

    const { accountId } = req.params;
    const accountName = req.query.accountName as string | undefined;
    const accountCode = req.query.accountCode as string | undefined;
    const month = req.query.month ? parseInt(req.query.month as string, 10) : new Date().getMonth() + 1;
    const year = req.query.year ? parseInt(req.query.year as string, 10) : new Date().getFullYear();

    // Validate month and year
    if (month < 1 || month > 12) {
      res.status(400).json({ error: 'Invalid month. Must be between 1 and 12.' });
      return;
    }

    if (year < 2000 || year > 2100) {
      res.status(400).json({ error: 'Invalid year.' });
      return;
    }

    // Calculate date range for the selected month
    const fromDate = new Date(year, month - 1, 1);
    const toDate = new Date(year, month, 0); // Last day of the month

    // Format dates as YYYY-MM-DD
    const formatDate = (date: Date): string => {
      return date.toISOString().split('T')[0];
    };

        const xeroService = new XeroService(tokenSet);
        
        // Get the account code if not provided - fetch from bank accounts list
        let effectiveAccountCode = accountCode || '';
        if (!effectiveAccountCode) {
          const bankAccounts = await xeroService.getBankAccounts(tokenSet);
          const matchingAccount = bankAccounts.find(acc => acc.accountId === accountId);
          if (matchingAccount) {
            effectiveAccountCode = matchingAccount.code;
            logger.info(`Retrieved account code for ${accountName}: ${effectiveAccountCode}`);
          }
        }
        
        // Use Account Transactions Report - combines BankTransactions + Payments + BankTransfers
        const transactions = await xeroService.getAccountTransactionsReport(
          tokenSet,
          accountId,
          accountName || '',
          effectiveAccountCode,
          formatDate(fromDate),
          formatDate(toDate)
        );

    // Update session with potentially refreshed token
    const updatedTokenSet = req.session.xeroTokenSet;
    if (updatedTokenSet && updatedTokenSet !== tokenSet) {
      req.session.xeroTokenSet = updatedTokenSet;
    }

    res.json({
      transactions: transactions,
      count: transactions.length,
      month: month,
      year: year,
      fromDate: formatDate(fromDate),
      toDate: formatDate(toDate),
    });
  } catch (error) {
    logger.error('Failed to fetch bank transactions', { error });
    res.status(500).json({
      error: 'Failed to fetch bank transactions',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Check authentication status
app.get('/api/auth/status', (req, res) => {
  const tokenSet = req.session.xeroTokenSet;
  res.json({
    authenticated: !!tokenSet,
    tenantId: tokenSet?.xero_tenant_id,
  });
});

// Serve main page
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// Start server
const PORT = config.app.port;
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`, {
    nodeEnv: config.app.nodeEnv,
    port: PORT,
    deployPing: `deployed-${new Date().toISOString()}`,
  });
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (error) => {
  logger.error('Unhandled promise rejection', { error });
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error });
  process.exit(1);
});

