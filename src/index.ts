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

// API endpoint to get 100 transactions (unfiltered, any account)
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

    // Fetch first 100 BankTransactions (unfiltered)
    const validTokenSet = await xeroService.ensureValidToken(tokenSet);
    await setTokenSet(validTokenSet);

    // Access the client through a helper method or use getXeroClient directly
    const client = getXeroClient();
    const response = await client.accountingApi.getBankTransactions(
      tenantId,
      undefined, // ifModifiedSince
      undefined, // where - no filter
      'Date DESC', // order by date descending
      1 // page 1
    );

    const transactions = response.body.bankTransactions || [];
    const limitedTransactions = transactions.slice(0, 100); // Limit to 100

    // Transform to our format
    const formattedTransactions = limitedTransactions.map((tx: any) => {
      let totalAmount = 0;
      if (tx.lineItems && tx.lineItems.length > 0) {
        totalAmount = tx.lineItems.reduce((sum: number, item: any) => {
          return sum + (item.lineAmount || 0);
        }, 0);
      } else if (tx.total) {
        totalAmount = tx.total;
      }

      const txTypeStr = tx.type ? String(tx.type) : '';
      const isCredit = txTypeStr === 'RECEIVE' || txTypeStr === 'RECEIVE-OVERPAYMENT' || txTypeStr === 'RECEIVE-PREPAYMENT';
      const displayAmount = isCredit ? Math.abs(totalAmount) : -Math.abs(totalAmount);

      const currencyCode = tx.currencyCode ? String(tx.currencyCode) : 'GBP';
      const formattedAmount = new Intl.NumberFormat('en-GB', {
        style: 'currency',
        currency: currencyCode,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(displayAmount);

      return {
        transactionId: tx.bankTransactionID || '',
        date: tx.date ? new Date(tx.date).toISOString().split('T')[0] : '',
        description: tx.reference || tx.lineItems?.[0]?.description || '',
        reference: tx.reference,
        amount: displayAmount,
        amountFormatted: formattedAmount,
        type: txTypeStr,
        status: tx.status ? String(tx.status) : 'AUTHORISED',
        bankAccountId: tx.bankAccount?.accountID || '',
        bankAccountName: tx.bankAccount?.name || '',
        bankAccountCode: tx.bankAccount?.code || '',
      };
    });

    res.json({
      count: formattedTransactions.length,
      transactions: formattedTransactions,
    });
  } catch (error) {
    logger.error('Failed to fetch 100 transactions', { error });
    res.status(500).json({ error: 'Failed to fetch 100 transactions' });
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

