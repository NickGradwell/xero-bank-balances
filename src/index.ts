import express from 'express';
import path from 'path';
import session from 'express-session';
import { randomUUID } from 'crypto';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { config } from './config';
import { logger } from './utils/logger';
import { getAuthorizationUrl, exchangeCodeForToken, setTokenSet } from './services/xero/auth';
import { XeroService } from './services/xero/client';
import { XeroTokenSet, BankTransaction } from './types/xero';
import { XeroLoginAgent } from './services/xero/loginAgent';

// Configure authenticator for TOTP
authenticator.options = {
  digits: 6,
  step: 30,
  window: [1, 1],
};
import {
  initTransactionCache,
  getCachedTransactions,
  saveTransactionsToCache,
  closeDatabaseConnection,
  createCacheJobRecord,
  markCacheJobStarted,
  updateCacheJobProgress,
  completeCacheJob,
  failCacheJob,
  getCacheJobById,
  getLatestCacheJob,
  getAdminSettings,
  saveAdminSettings,
  getStoredTokenSet,
  getRecentCacheJobs,
  upsertBankAccounts,
  listBankAccounts,
  insertBankStatementLines,
  getRecentStatementLines,
} from './database/transactionCache';

const app = express();

// Initialize local transaction cache (will be awaited before server starts)
let dbInitialized = false;
const initializeDatabase = async (): Promise<void> => {
  if (!dbInitialized) {
    await initTransactionCache();
    dbInitialized = true;
  }
};

// Extend Express Session to include Xero token set
declare module 'express-session' {
  interface SessionData {
    xeroTokenSet?: XeroTokenSet;
    oauthState?: string;
  }
}

type AppSession = session.Session & { xeroTokenSet?: XeroTokenSet };

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Helper to cache transactions for a full month across multiple accounts
async function cacheTransactionsForAccountsMonth(
  sessionData: AppSession | null,
  month: number,
  year: number,
  accountIds: string[] | undefined,
  jobId: string,
  initialTokenSet?: XeroTokenSet
): Promise<void> {
  try {
    const tokenCandidate = sessionData?.xeroTokenSet ?? initialTokenSet ?? (await getStoredTokenSet());

    if (!tokenCandidate) {
      logger.warn('Cache job aborted: no token set available');
      await failCacheJob({ jobId, errorMessage: 'No token set available for cache job' });
      return;
    }

    let currentTokenSet: XeroTokenSet = tokenCandidate;

    const fromDate = new Date(year, month - 1, 1);
    const toDate = new Date(year, month, 0);
    const fromDateStr = fromDate.toISOString().split('T')[0];
    const toDateStr = toDate.toISOString().split('T')[0];

    const initialService = new XeroService(currentTokenSet);
    currentTokenSet = await initialService.ensureValidToken(currentTokenSet);
    await setTokenSet(currentTokenSet, { persist: false, updateTenants: false });
    if (sessionData) {
      sessionData.xeroTokenSet = currentTokenSet;
    }

    const bankAccounts = await initialService.getBankAccounts(currentTokenSet);
    const accountsToProcess = accountIds && accountIds.length > 0
      ? bankAccounts.filter((acc) => accountIds.includes(acc.accountId))
      : bankAccounts;

    if (!accountsToProcess.length) {
      logger.warn('Cache job aborted: no matching accounts found', { month, year, accountIds });
      await failCacheJob({ jobId, errorMessage: 'No matching accounts found for cache job' });
      return;
    }

    logger.info('Starting cache job for month', {
      month,
      year,
      totalAccounts: accountsToProcess.length,
    });

    await markCacheJobStarted({ jobId, totalAccounts: accountsToProcess.length });

    let processed = 0;
    for (const account of accountsToProcess) {
      processed += 1;
      const lastAccountId = account.accountId;
      const lastAccountName = account.name || '';
      try {
        const sessionToken: XeroTokenSet = sessionData?.xeroTokenSet ?? currentTokenSet;
        const service = new XeroService(sessionToken);
        currentTokenSet = await service.ensureValidToken(sessionToken);
        await setTokenSet(currentTokenSet, { persist: false, updateTenants: false });
        if (sessionData) {
          sessionData.xeroTokenSet = currentTokenSet;
        }

        logger.info('Caching account transactions', {
          accountId: account.accountId,
          accountName: account.name,
          month,
          year,
          position: processed,
          total: accountsToProcess.length,
        });

        const transactions = await service.getAccountTransactionsReport(
          currentTokenSet,
          account.accountId,
          account.name || '',
          account.code || '',
          fromDateStr,
          toDateStr
        );

        const fetchedAt = await saveTransactionsToCache({
          accountId: account.accountId,
          accountName: account.name || '',
          accountCode: account.code || '',
          month,
          year,
          fromDate: fromDateStr,
          toDate: toDateStr,
          transactions,
        });

        logger.info('Cached account transactions', {
          accountId: account.accountId,
          accountName: account.name,
          month,
          year,
          transactionCount: transactions.length,
          fetchedAt,
        });
      } catch (error) {
        logger.error('Failed to cache transactions for account', {
          accountId: account.accountId,
          accountName: account.name,
          month,
          year,
          error,
        });
      }

      await updateCacheJobProgress({
        jobId,
        processedAccounts: processed,
        lastAccountId,
        lastAccountName,
      });

      await delay(1000); // brief pause between accounts to stay within rate limits
    }

    logger.info('Completed cache job', { month, year });
    await completeCacheJob(jobId);
  } catch (error) {
    logger.error('Cache job failed', { month, year, error });
    await failCacheJob({ jobId, errorMessage: error instanceof Error ? error.message : 'Unknown error' });
  }
}

const parseMonthString = (value: string): { year: number; month: number } | null => {
  if (!value || typeof value !== 'string') {
    return null;
  }
  const match = value.match(/^(\d{4})-(\d{2})$/);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (Number.isNaN(year) || Number.isNaN(month) || month < 1 || month > 12) {
    return null;
  }
  return { year, month };
};

const buildLookbackMonths = (count: number): Array<{ year: number; month: number }> => {
  const months: Array<{ year: number; month: number }> = [];
  const now = new Date();
  const current = new Date(now.getFullYear(), now.getMonth(), 1);
  for (let i = 0; i < count; i += 1) {
    months.push({ year: current.getFullYear(), month: current.getMonth() + 1 });
    current.setMonth(current.getMonth() - 1);
  }
  return months;
};

const getEffectiveTokenSet = async (sessionData?: AppSession | null): Promise<XeroTokenSet> => {
  if (sessionData?.xeroTokenSet) {
    return sessionData.xeroTokenSet;
  }
  const stored = await getStoredTokenSet();
  if (stored) {
    return stored;
  }
  throw new Error('No stored Xero token set available');
};

const kickOffCacheJob = (
  jobId: string,
  month: number,
  year: number,
  accountIds: string[] | undefined,
  sessionData: AppSession | null,
  tokenSet: XeroTokenSet
): void => {
  setImmediate(() => {
    cacheTransactionsForAccountsMonth(sessionData, month, year, accountIds, jobId, tokenSet).catch((error) => {
      logger.error('Background cache job failed', { jobId, month, year, error });
      failCacheJob({ jobId, errorMessage: error instanceof Error ? error.message : 'Unknown error' }).catch((err) => {
        logger.error('Failed to record cache job failure', { jobId, err });
      });
    });
  });
};

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
  req.session.destroy((err: Error | null) => {
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

// API endpoint to get bank transactions for a specific account
app.post('/api/xero/cache/month', async (req, res): Promise<void> => {
  const sessionData = req.session as AppSession;

  let effectiveTokenSet: XeroTokenSet;
  try {
    effectiveTokenSet = await getEffectiveTokenSet(sessionData);
    sessionData.xeroTokenSet = effectiveTokenSet;
  } catch (error) {
    logger.warn('Attempted to start cache job without available token set', { error });
    res.status(401).json({ error: 'Not authenticated', requiresAuth: true });
    return;
  }

  const body = (req.body || {}) as { month?: number | string; year?: number | string; accountIds?: string[] };
  const monthInt = body.month ? parseInt(String(body.month), 10) : new Date().getMonth() + 1;
  const yearInt = body.year ? parseInt(String(body.year), 10) : new Date().getFullYear();

  if (Number.isNaN(monthInt) || monthInt < 1 || monthInt > 12) {
    res.status(400).json({ error: 'Invalid month. Must be between 1 and 12.' });
    return;
  }

  if (Number.isNaN(yearInt) || yearInt < 2000 || yearInt > 2100) {
    res.status(400).json({ error: 'Invalid year.' });
    return;
  }

  let accountsArray: string[] | undefined;
  if (Array.isArray(body.accountIds)) {
    accountsArray = body.accountIds.map((id) => String(id)).filter((id) => id.length > 0);
  }

  const jobId = randomUUID();

  try {
    const jobRecord = await createCacheJobRecord({ jobId, month: monthInt, year: yearInt });

    logger.info('Starting background cache job via API request', {
      jobId,
      month: monthInt,
      year: yearInt,
      requestedAccounts: accountsArray ? accountsArray.length : 'all',
    });

    res.status(202).json({
      status: 'started',
      job: jobRecord,
    });

    kickOffCacheJob(jobId, monthInt, yearInt, accountsArray, sessionData, effectiveTokenSet);
  } catch (error) {
    logger.error('Failed to create cache job record', { month: monthInt, year: yearInt, error });
    res.status(500).json({ error: 'Failed to start cache job' });
  }
});

app.get('/api/admin/settings', async (req, res): Promise<void> => {
  const sessionData = req.session as AppSession;
  const hasToken = sessionData?.xeroTokenSet || (await getStoredTokenSet());

  if (!hasToken) {
    res.status(401).json({ error: 'Not authenticated', requiresAuth: true });
    return;
  }

  const settings = await getAdminSettings();
  res.json({ settings });
});

app.post('/api/admin/settings', async (req, res): Promise<void> => {
  const sessionData = req.session as AppSession;
  const hasToken = sessionData?.xeroTokenSet || (await getStoredTokenSet());

  if (!hasToken) {
    res.status(401).json({ error: 'Not authenticated', requiresAuth: true });
    return;
  }

  const body = req.body as Partial<{ enabled: boolean; time: string; lookbackMonths: number; timezone?: string }>;

  if (typeof body.enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled must be a boolean' });
    return;
  }

  if (typeof body.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.time)) {
    res.status(400).json({ error: 'time must be provided in HH:MM (24h) format' });
    return;
  }

  const lookbackMonths = Number(body.lookbackMonths ?? 1);
  if (Number.isNaN(lookbackMonths) || lookbackMonths < 1 || lookbackMonths > 12) {
    res.status(400).json({ error: 'lookbackMonths must be between 1 and 12' });
    return;
  }

  try {
    const saved = await saveAdminSettings({
      enabled: body.enabled,
      time: body.time,
      lookbackMonths,
      timezone: typeof body.timezone === 'string' ? body.timezone : null,
    });
    res.json({ settings: saved });
  } catch (error) {
    logger.error('Failed to save admin settings', { error });
    res.status(500).json({ error: 'Failed to save admin settings' });
  }
});

app.post('/api/admin/sync', async (req, res): Promise<void> => {
  const sessionData = req.session as AppSession;

  let tokenSet: XeroTokenSet;
  try {
    tokenSet = await getEffectiveTokenSet(sessionData);
    if (sessionData) {
      sessionData.xeroTokenSet = tokenSet;
    }
  } catch (error) {
    logger.warn('Manual sync requested without token set', { error });
    res.status(401).json({ error: 'Not authenticated', requiresAuth: true });
    return;
  }

  const body = req.body as Partial<{ months: string[] }>;
  const requestedMonths = Array.isArray(body.months) ? Array.from(new Set(body.months)) : [];

  const parsedMonths = requestedMonths
    .map((value) => parseMonthString(value))
    .filter((value): value is { year: number; month: number } => !!value)
    .filter(({ year }) => year >= 2000 && year <= 2100);

  if (!parsedMonths.length) {
    res.status(400).json({ error: 'At least one valid month (YYYY-MM) must be provided.' });
    return;
  }

  try {
    const jobs = await Promise.all(
      parsedMonths.map(async ({ year, month }) => {
        const jobId = randomUUID();
        const jobRecord = await createCacheJobRecord({ jobId, month, year });
        kickOffCacheJob(jobId, month, year, undefined, sessionData, tokenSet);
        return jobRecord;
      })
    );

    res.status(202).json({
      message: 'Manual sync started',
      jobs,
    });
  } catch (error) {
    logger.error('Failed to initiate manual sync', { error });
    res.status(500).json({ error: 'Failed to start manual sync' });
  }
});

app.post('/api/admin/sync/run-nightly', async (req, res): Promise<void> => {
  const sessionData = req.session as AppSession;

  let tokenSet: XeroTokenSet;
  try {
    tokenSet = await getEffectiveTokenSet(sessionData);
    if (sessionData) {
      sessionData.xeroTokenSet = tokenSet;
    }
  } catch (error) {
    logger.warn('Nightly sync requested without token set', { error });
    res.status(401).json({ error: 'Not authenticated', requiresAuth: true });
    return;
  }

  const settings = await getAdminSettings();
  const lookback = Math.max(1, Math.min(settings.lookbackMonths || 1, 12));
  const months = buildLookbackMonths(lookback);

  if (!months.length) {
    res.status(400).json({ error: 'Unable to determine months for nightly sync.' });
    return;
  }

  try {
    const jobs = await Promise.all(
      months.map(async ({ year, month }) => {
        const jobId = randomUUID();
        const jobRecord = await createCacheJobRecord({ jobId, month, year });
        kickOffCacheJob(jobId, month, year, undefined, sessionData, tokenSet);
        return jobRecord;
      })
    );

    res.status(202).json({
      message: settings.enabled
        ? 'Nightly sync triggered using saved schedule.'
        : 'Nightly sync triggered manually (schedule currently disabled).',
      jobs,
    });
  } catch (error) {
    logger.error('Failed to initiate nightly sync', { error });
    res.status(500).json({ error: 'Failed to start nightly sync' });
  }
});

app.get('/api/admin/jobs/recent', async (req, res): Promise<void> => {
  const sessionData = req.session as AppSession;
  const hasToken = sessionData?.xeroTokenSet || (await getStoredTokenSet());

  if (!hasToken) {
    res.status(401).json({ error: 'Not authenticated', requiresAuth: true });
    return;
  }

  const limitParam = req.query.limit ? Number(req.query.limit) : 10;
  const limit = Number.isNaN(limitParam) ? 10 : Math.min(Math.max(limitParam, 1), 50);

  try {
    const jobs = await getRecentCacheJobs(limit);
    res.json({ jobs });
  } catch (error) {
    logger.error('Failed to load recent cache jobs', { error });
    res.status(500).json({ error: 'Failed to load recent jobs' });
  }
});

app.get('/api/xero/cache/month/status', async (req, res): Promise<void> => {
  const tokenSet = req.session.xeroTokenSet;

  if (!tokenSet) {
    res.status(401).json({ error: 'Not authenticated', requiresAuth: true });
    return;
  }

  const monthParam = req.query.month;
  const yearParam = req.query.year;

  if (!monthParam || !yearParam) {
    res.status(400).json({ error: 'Month and year are required.' });
    return;
  }

  const month = parseInt(String(monthParam), 10);
  const year = parseInt(String(yearParam), 10);

  if (Number.isNaN(month) || month < 1 || month > 12) {
    res.status(400).json({ error: 'Invalid month. Must be between 1 and 12.' });
    return;
  }

  if (Number.isNaN(year) || year < 2000 || year > 2100) {
    res.status(400).json({ error: 'Invalid year.' });
    return;
  }

  const job = await getLatestCacheJob({ month, year });
  res.json({ job });
});

app.get('/api/xero/cache/job/:jobId', async (req, res): Promise<void> => {
  const tokenSet = req.session.xeroTokenSet;

  if (!tokenSet) {
    res.status(401).json({ error: 'Not authenticated', requiresAuth: true });
    return;
  }

  const { jobId } = req.params;

  if (!jobId) {
    res.status(400).json({ error: 'Job ID is required.' });
    return;
  }

  const job = await getCacheJobById(jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found.' });
    return;
  }

  res.json({ job });
});

app.get('/api/xero/accounts/:accountId/transactions', async (req, res): Promise<void> => {
  try {
    const sessionData = req.session as AppSession | null;
    const { accountId } = req.params;

    if (!sessionData?.xeroTokenSet) {
      logger.debug('Serving cached transactions without active session token', { accountId });
    }

    const accountNameParam = typeof req.query.accountName === 'string' ? req.query.accountName : undefined;
    const accountCodeParam = typeof req.query.accountCode === 'string' ? req.query.accountCode : undefined;
    const forceRefresh = req.query.forceRefresh === 'true';
    const fromDateParam = req.query.fromDate as string | undefined;
    const toDateParam = req.query.toDate as string | undefined;
    const fallbackMonth = req.query.month ? parseInt(req.query.month as string, 10) : undefined;
    const fallbackYear = req.query.year ? parseInt(req.query.year as string, 10) : undefined;

    if (forceRefresh) {
      logger.warn('forceRefresh parameter is ignored; returning cached data only', { accountId });
    }

    const parseDateInput = (value: string, endOfRange = false): Date | null => {
      const monthMatch = value.match(/^\d{4}-\d{2}$/);
      const dateMatch = value.match(/^\d{4}-\d{2}-\d{2}$/);

      if (monthMatch) {
        const [yearStr, monthStr] = value.split('-');
        const yearNum = Number(yearStr);
        const monthNum = Number(monthStr);
        if (Number.isNaN(yearNum) || Number.isNaN(monthNum) || monthNum < 1 || monthNum > 12) {
          return null;
        }
        if (endOfRange) {
          return new Date(yearNum, monthNum, 0); // last day of month
        }
        return new Date(yearNum, monthNum - 1, 1);
      }

      if (dateMatch) {
        const date = new Date(`${value}T00:00:00`);
        if (Number.isNaN(date.getTime())) {
          return null;
        }
        return date;
      }

      return null;
    };

    let rangeStartDate: Date | null = null;
    let rangeEndDate: Date | null = null;

    if (fromDateParam && toDateParam) {
      rangeStartDate = parseDateInput(fromDateParam, false);
      rangeEndDate = parseDateInput(toDateParam, true);
      if (!rangeStartDate || !rangeEndDate) {
        res.status(400).json({ error: 'Invalid fromDate or toDate. Use YYYY-MM or YYYY-MM-DD.' });
        return;
      }
    } else if (fallbackMonth !== undefined || fallbackYear !== undefined) {
      const month = fallbackMonth ?? new Date().getMonth() + 1;
      const year = fallbackYear ?? new Date().getFullYear();

      if (month < 1 || month > 12) {
        res.status(400).json({ error: 'Invalid month. Must be between 1 and 12.' });
        return;
      }

      if (year < 2000 || year > 2100) {
        res.status(400).json({ error: 'Invalid year.' });
        return;
      }

      rangeStartDate = new Date(year, month - 1, 1);
      rangeEndDate = new Date(year, month, 0);
    } else {
      // Default: last 12 full months ending this month
      const now = new Date();
      const endOfCurrentMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      const startOfRollingWindow = new Date(endOfCurrentMonth);
      startOfRollingWindow.setMonth(startOfRollingWindow.getMonth() - 11);
      startOfRollingWindow.setDate(1);
      rangeStartDate = startOfRollingWindow;
      rangeEndDate = endOfCurrentMonth;
    }

    if (!rangeStartDate || !rangeEndDate || rangeStartDate > rangeEndDate) {
      res.status(400).json({ error: 'Invalid date range. Ensure fromDate is before toDate.' });
      return;
    }

    const normalizedRangeStart = new Date(rangeStartDate);
    normalizedRangeStart.setHours(0, 0, 0, 0);
    const normalizedRangeEnd = new Date(rangeEndDate);
    normalizedRangeEnd.setHours(23, 59, 59, 999);

    const monthEntries: Array<{ year: number; month: number; start: Date; end: Date }> = [];
    const iteratorStart = new Date(normalizedRangeStart.getFullYear(), normalizedRangeStart.getMonth(), 1);
    const iteratorEnd = new Date(normalizedRangeEnd.getFullYear(), normalizedRangeEnd.getMonth(), 1);

    let iterator = iteratorStart;
    while (iterator <= iteratorEnd) {
      const year = iterator.getFullYear();
      const month = iterator.getMonth() + 1;
      const monthStart = new Date(year, month - 1, 1);
      const monthEnd = new Date(year, month, 0);
      monthEntries.push({ year, month, start: monthStart, end: monthEnd });
      iterator = new Date(iterator.getFullYear(), iterator.getMonth() + 1, 1);
    }

    if (monthEntries.length === 0) {
      res.json({
        transactions: [],
        count: 0,
        fromDate: normalizedRangeStart.toISOString(),
        toDate: normalizedRangeEnd.toISOString(),
        range: { months: 0, cachedMonths: 0, refreshedMonths: 0, missingMonths: 0, cachedMonthDetails: [], missingMonthDetails: [] },
        cacheStatus: 'missing',
      });
      return;
    }

    const formatDate = (date: Date): string => date.toISOString().split('T')[0];

    const aggregatedTransactions: BankTransaction[] = [];
    const cachedMonthDetails: Array<{ month: number; year: number; fetchedAt: string; fromDate: string; toDate: string; transactionCount: number }> = [];
    const missingMonthDetails: Array<{ month: number; year: number }> = [];

    let cachedMonths = 0;
    let effectiveAccountName = accountNameParam || '';
    let effectiveAccountCode = accountCodeParam || '';

    for (const entry of monthEntries) {
      const cached = await getCachedTransactions(accountId, entry.month, entry.year);
      if (cached) {
        aggregatedTransactions.push(...cached.transactions);
        cachedMonths += 1;
        cachedMonthDetails.push({
          month: entry.month,
          year: entry.year,
          fetchedAt: cached.fetchedAt,
          fromDate: cached.fromDate,
          toDate: cached.toDate,
          transactionCount: cached.transactions.length,
        });

        if (!effectiveAccountName && cached.accountName) {
          effectiveAccountName = cached.accountName;
        }

        if (!effectiveAccountCode && cached.accountCode) {
          effectiveAccountCode = cached.accountCode;
        }
      } else {
        missingMonthDetails.push({ month: entry.month, year: entry.year });
      }
    }

    if (missingMonthDetails.length > 0) {
      logger.warn('Transactions requested for months not yet cached', {
        accountId,
        missingMonths: missingMonthDetails,
      });
    }

    const startTime = normalizedRangeStart.getTime();
    const endTime = normalizedRangeEnd.getTime();

    const filteredTransactions = aggregatedTransactions.filter((tx) => {
      if (!tx.date) {
        return false;
      }
      const txTime = new Date(tx.date).getTime();
      if (Number.isNaN(txTime)) {
        return false;
      }
      return txTime >= startTime && txTime <= endTime;
    });

    filteredTransactions.sort((a, b) => {
      const dateA = new Date(a.date ?? '').getTime();
      const dateB = new Date(b.date ?? '').getTime();
      return dateB - dateA;
    });

    const rangeSummary = {
      fromDate: formatDate(normalizedRangeStart),
      toDate: formatDate(normalizedRangeEnd),
      months: monthEntries.length,
      cachedMonths,
      refreshedMonths: 0,
      missingMonths: missingMonthDetails.length,
      cachedMonthDetails,
      missingMonthDetails,
    };

    const cacheStatus = missingMonthDetails.length === 0 ? 'complete' : cachedMonths > 0 ? 'partial' : 'missing';

    res.json({
      transactions: filteredTransactions,
      count: filteredTransactions.length,
      fromDate: rangeSummary.fromDate,
      toDate: rangeSummary.toDate,
      range: rangeSummary,
      cacheStatus,
      cachedMonths: cachedMonthDetails,
      missingMonths: missingMonthDetails,
      account: {
        id: accountId,
        name: effectiveAccountName,
        code: effectiveAccountCode,
      },
      cached: cacheStatus === 'complete',
    });
  } catch (error) {
    logger.error('Failed to load cached bank transactions', { error });
    res.status(500).json({
      error: 'Failed to load cached bank transactions',
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

// Xero Login Agent routes
let activeLoginAgent: XeroLoginAgent | null = null;

app.post('/api/xero/login-agent/start', async (req, res): Promise<void> => {
  try {
    if (activeLoginAgent) {
      res.status(400).json({
        error: 'Login agent is already running',
        message: 'Please wait for the current login attempt to complete',
      });
      return;
    }

    const { headless = true } = req.body as { headless?: boolean };
    const username = process.env.XERO_USERNAME || 'nickg@amberleyinnovations.com';
    const password = process.env.XERO_PASSWORD || 'xeEspresso321!';
    const totpSecret = process.env.XERO_TOTP_SECRET || '';

    activeLoginAgent = new XeroLoginAgent(username, password, headless, totpSecret || undefined);

    // Run login in background
    setImmediate(async () => {
      try {
        await activeLoginAgent?.login();
      } catch (error) {
        logger.error('Login agent error', { error });
      }
    });

    res.json({
      status: 'started',
      message: 'Login agent started',
    });
  } catch (error) {
    logger.error('Failed to start login agent', { error });
    res.status(500).json({
      error: 'Failed to start login agent',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.get('/api/xero/login-agent/status', async (_req, res): Promise<void> => {
  try {
    if (!activeLoginAgent) {
      res.json({
        running: false,
        message: 'No active login agent',
      });
      return;
    }

    const logs = activeLoginAgent.getLogs();
    const currentUrl = await activeLoginAgent.getCurrentUrl();
    const screenshot = await activeLoginAgent.takeScreenshot();

    res.json({
      running: true,
      logs,
      currentUrl,
      screenshot,
    });
  } catch (error) {
    logger.error('Failed to get login agent status', { error });
    res.status(500).json({
      error: 'Failed to get login agent status',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.post('/api/xero/login-agent/stop', async (_req, res): Promise<void> => {
  try {
    if (activeLoginAgent) {
      await activeLoginAgent.close();
      activeLoginAgent = null;
      res.json({
        status: 'stopped',
        message: 'Login agent stopped',
      });
    } else {
      res.json({
        status: 'not_running',
        message: 'No active login agent to stop',
      });
    }
  } catch (error) {
    logger.error('Failed to stop login agent', { error });
    res.status(500).json({
      error: 'Failed to stop login agent',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Bank Statements Collection endpoint
app.post('/api/xero/bank-statements/collect', async (req, res): Promise<void> => {
  try {
    const { limit = 3, headless: requestedHeadless = true } = req.body as { limit?: number; headless?: boolean };
    
    // Use existing agent if available and logged in, otherwise create new one
    let agent = activeLoginAgent;
    let needsLogin = false;

    if (!agent || !agent.getCurrentUrl() || (await agent.getCurrentUrl())?.includes('/login')) {
      needsLogin = true;
      logger.info('No active agent or not logged in, creating new agent for bank statements collection');
      
      // Only force headless on actual server/cloud environments, not just when DISPLAY is missing
      // (macOS can run headed browsers without DISPLAY set)
      const isServerEnvironment = 
        process.env.CI === 'true' ||
        process.env.RAILWAY_ENVIRONMENT !== undefined ||
        process.env.DYNO !== undefined ||
        process.env.VERCEL !== undefined ||
        (process.platform === 'linux' && !process.env.DISPLAY);
      
      const effectiveHeadless = isServerEnvironment ? true : requestedHeadless;
      
      const username = process.env.XERO_USERNAME || 'nickg@amberleyinnovations.com';
      const password = process.env.XERO_PASSWORD || 'xeEspresso321!';
      const totpSecret = (process.env.XERO_TOTP_SECRET || '').trim();

      agent = new XeroLoginAgent(username, password, effectiveHeadless, totpSecret || undefined);
      activeLoginAgent = agent; // Make sure it's set as active so logs can be polled
    }

    try {
      // Login first if needed
      if (needsLogin) {
        logger.info('Logging in before collecting bank statements...');
        const loginResult = await agent.login();
        if (!loginResult.success) {
          res.status(500).json({
            success: false,
            message: 'Login failed',
            error: loginResult.error || 'Could not login to Xero',
          });
          return;
        }
        logger.info('Login successful, proceeding with bank statements collection');
      }

      // Collect bank statements
      // Keep agent active so logs can be polled during collection
      logger.info(`Starting bank statements collection (limit: ${limit}, headless: ${requestedHeadless})`);
      const result = await agent.collectBankStatements(limit);
      
      // Don't close the agent - keep it active so user can see logs and potentially collect more
      // Only close if we created a new agent and user wants to clean up (handled by stop endpoint)
      
      res.json(result);
    } catch (error) {
      logger.error('Bank statements collection error', { error });
      res.status(500).json({
        success: false,
        message: 'Bank statements collection error',
        error: error instanceof Error ? error.message : 'Unknown error',
        accounts: [],
      });
    }
  } catch (error) {
    logger.error('Bank statements collection endpoint error', { error });
    res.status(500).json({
      success: false,
      message: 'Bank statements collection endpoint error',
      error: error instanceof Error ? error.message : 'Unknown error',
      accounts: [],
    });
  }
});

// Agent 1: collect account IDs
app.post('/api/xero/accounts/collect', async (req, res): Promise<void> => {
  try {
    const { limit = 3, headless: requestedHeadless = true } = req.body as { limit?: number; headless?: boolean };

    // Only force headless on actual server/cloud environments, not just when DISPLAY is missing
    // (macOS can run headed browsers without DISPLAY set)
    const isServerEnvironment =
      process.env.CI === 'true' ||
      process.env.RAILWAY_ENVIRONMENT !== undefined ||
      process.env.DYNO !== undefined ||
      process.env.VERCEL !== undefined ||
      (process.platform === 'linux' && !process.env.DISPLAY);

    const effectiveHeadless = isServerEnvironment ? true : requestedHeadless;

    logger.info('Starting account ID collection', {
      limit,
      requestedHeadless,
      effectiveHeadless,
      isServerEnvironment,
      platform: process.platform,
      DISPLAY: process.env.DISPLAY,
    });

    const username = process.env.XERO_USERNAME || 'nickg@amberleyinnovations.com';
    const password = process.env.XERO_PASSWORD || 'xeEspresso321!';
    const totpSecret = (process.env.XERO_TOTP_SECRET || '').trim();

    const agent = new XeroLoginAgent(username, password, effectiveHeadless, totpSecret || undefined);
    activeLoginAgent = agent; // Set as active so logs can be polled

    const loginResult = await agent.login();
    if (!loginResult.success) {
      await agent.close();
      activeLoginAgent = null;
      res.status(500).json({ success: false, error: loginResult.error || 'Login failed' });
      return;
    }

    const collectResult = await agent.collectAccountIds(limit);
    await agent.close();
    activeLoginAgent = null;

    if (collectResult.accounts.length) {
      const nowIso = new Date().toISOString();
      await upsertBankAccounts(
        collectResult.accounts.map((a) => ({
          accountId: a.accountId,
          accountName: a.accountName,
          lastCollectedAt: nowIso,
        }))
      );
    }

    res.json(collectResult);
  } catch (error) {
    logger.error('Accounts collect error', { error });
    res.status(500).json({
      success: false,
      message: 'Accounts collect error',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// List stored accounts
app.get('/api/xero/accounts', async (_req, res): Promise<void> => {
  try {
    const accounts = await listBankAccounts(200);
    res.json({ success: true, accounts });
  } catch (error) {
    logger.error('List accounts error', { error });
    res.status(500).json({ success: false, error: 'Failed to list accounts' });
  }
});

// Agent 2: collect statements by stored account IDs
app.post('/api/xero/bank-statements/collect-by-id', async (req, res): Promise<void> => {
  try {
    const { limit = 3, headless: requestedHeadless = true } = req.body as { limit?: number; headless?: boolean };

    const accounts = await listBankAccounts(limit);
    if (!accounts.length) {
      res.status(400).json({ success: false, error: 'No stored accounts. Run account ID collection first.' });
      return;
    }

    // Only force headless on actual server/cloud environments, not just when DISPLAY is missing
    // (macOS can run headed browsers without DISPLAY set)
    const isServerEnvironment =
      process.env.CI === 'true' ||
      process.env.RAILWAY_ENVIRONMENT !== undefined ||
      process.env.DYNO !== undefined ||
      process.env.VERCEL !== undefined ||
      (process.platform === 'linux' && !process.env.DISPLAY);

    const effectiveHeadless = isServerEnvironment ? true : requestedHeadless;

    const username = process.env.XERO_USERNAME || 'nickg@amberleyinnovations.com';
    const password = process.env.XERO_PASSWORD || 'xeEspresso321!';
    const totpSecret = (process.env.XERO_TOTP_SECRET || '').trim();

    const agent = new XeroLoginAgent(username, password, effectiveHeadless, totpSecret || undefined);

    const loginResult = await agent.login();
    if (!loginResult.success) {
      await agent.close();
      res.status(500).json({ success: false, error: loginResult.error || 'Login failed' });
      return;
    }

    const collectResult = await agent.collectStatementsByIds(
      accounts.map((a) => ({ accountId: a.accountId, accountName: a.accountName })),
      limit
    );

    // store lines
    for (const r of collectResult.results) {
      const linesWithIds = r.lines.map((line) => ({
        id: crypto.randomUUID(),
        accountId: r.accountId,
        accountName: r.accountName || '',
        statementDate: line.date,
        description: line.description,
        reference: line.reference,
        paymentRef: line.paymentRef,
        spent: line.spent,
        received: line.received,
        balance: line.balance,
        source: '',
        status: '',
        rawJson: line,
      }));
      await insertBankStatementLines(linesWithIds);
    }

    await agent.close();

    res.json(collectResult);
  } catch (error) {
    logger.error('Collect-by-id error', { error });
    res.status(500).json({
      success: false,
      message: 'Collect-by-id error',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Recent statement lines
app.get('/api/xero/statements/recent', async (req, res): Promise<void> => {
  try {
    const limit = parseInt((req.query.limit as string) || '100', 10);
    const lines = await getRecentStatementLines(limit);
    res.json({ success: true, lines });
  } catch (error) {
    logger.error('List recent statements error', { error });
    res.status(500).json({ success: false, error: 'Failed to list statement lines' });
  }
});

app.post('/api/xero/login-agent/run', async (req, res): Promise<void> => {
  try {
    const { headless: requestedHeadless = true } = req.body as { headless?: boolean };
    
    // Only force headless on actual server/cloud environments, not just when DISPLAY is missing
    // (macOS can run headed browsers without DISPLAY set)
    const isServerEnvironment = 
      process.env.CI === 'true' ||
      process.env.RAILWAY_ENVIRONMENT !== undefined ||
      process.env.DYNO !== undefined ||
      process.env.VERCEL !== undefined ||
      (process.platform === 'linux' && !process.env.DISPLAY);
    
    const effectiveHeadless = isServerEnvironment ? true : requestedHeadless;
    
    if (isServerEnvironment && !requestedHeadless) {
      logger.warn('Server environment detected - forcing headless mode', {
        requestedHeadless,
        effectiveHeadless,
        environment: {
          DISPLAY: process.env.DISPLAY,
          CI: process.env.CI,
          RAILWAY_ENVIRONMENT: process.env.RAILWAY_ENVIRONMENT,
          platform: process.platform,
        },
      });
    }
    
    const username = process.env.XERO_USERNAME || 'nickg@amberleyinnovations.com';
    const password = process.env.XERO_PASSWORD || 'xeEspresso321!';
    const totpSecret = (process.env.XERO_TOTP_SECRET || '').trim();

    logger.info('Starting login agent', {
      requestedHeadless,
      effectiveHeadless,
      isServerEnvironment,
      hasTotpSecret: !!totpSecret,
      totpSecretLength: totpSecret.length,
      totpSecretPreview: totpSecret ? `${totpSecret.substring(0, 4)}...` : 'none',
    });

    const agent = new XeroLoginAgent(username, password, effectiveHeadless, totpSecret || undefined);

    try {
      const result = await agent.login();
      res.json(result);
    } finally {
      await agent.close();
    }
  } catch (error) {
    logger.error('Login agent run error', { error });
    res.status(500).json({
      success: false,
      message: 'Login agent error',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// TOTP Secret Management endpoints
app.get('/api/xero/totp-secret', async (_req, res): Promise<void> => {
  try {
    const secret = process.env.XERO_TOTP_SECRET || '';
    // Return masked version if secret exists
    res.json({
      secret: secret ? '••••••••' : '',
      configured: !!secret,
    });
  } catch (error) {
    logger.error('Failed to get TOTP secret', { error });
    res.status(500).json({
      error: 'Failed to get TOTP secret',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.post('/api/xero/totp-secret', async (req, res): Promise<void> => {
  try {
    const { secret } = req.body as { secret?: string };
    
    if (!secret || secret.trim() === '') {
      res.status(400).json({
        error: 'TOTP secret is required',
      });
      return;
    }

    const trimmedSecret = secret.trim();

    // Validate secret format (should be base32)
    try {
      const testCode = authenticator.generate(trimmedSecret);
      if (!testCode || testCode.length !== 6) {
        throw new Error('Generated code is invalid');
      }
      
      logger.info('TOTP secret validated', {
        secretLength: trimmedSecret.length,
        secretPreview: `${trimmedSecret.substring(0, 4)}...`,
        testCode: testCode,
      });
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : 'Unknown error';
      logger.error('TOTP secret validation failed', { error: errorMsg, secretLength: trimmedSecret.length });
      res.status(400).json({
        error: 'Invalid TOTP secret format',
        message: `The secret must be a valid base32 encoded string. Error: ${errorMsg}`,
        hint: 'Make sure the secret is in base32 format (A-Z, 2-7 characters only, no spaces)',
      });
      return;
    }

    // In a real application, you'd save this to a secure storage (database, key vault, etc.)
    // For now, we'll just return success - the user should set it as an environment variable
    res.json({
      success: true,
      message: 'TOTP secret validated. Please set XERO_TOTP_SECRET environment variable with this value for production use.',
      note: 'For security, set this as an environment variable rather than storing in code.',
    });
  } catch (error) {
    logger.error('Failed to save TOTP secret', { error });
    res.status(500).json({
      error: 'Failed to save TOTP secret',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.post('/api/xero/totp-secret/generate', async (_req, res): Promise<void> => {
  try {
    // Generate a new TOTP secret
    const secret = authenticator.generateSecret();
    
    // Validate the generated secret works
    try {
      const testCode = authenticator.generate(secret);
      if (!testCode || testCode.length !== 6) {
        throw new Error('Generated secret produces invalid codes');
      }
      logger.info('Generated TOTP secret validated', { secretLength: secret.length });
    } catch (validateError) {
      logger.error('Generated TOTP secret validation failed', { error: validateError });
      throw new Error('Generated secret is invalid');
    }
    
    // Create QR code data URL for easy setup
    const otpAuthUrl = authenticator.keyuri(
      'nickg@amberleyinnovations.com',
      'Xero',
      secret
    );
    
    let qrCodeDataUrl = '';
    try {
      qrCodeDataUrl = await QRCode.toDataURL(otpAuthUrl);
    } catch (qrError) {
      logger.warn('Failed to generate QR code', { error: qrError });
    }

    res.json({
      secret,
      qrCode: qrCodeDataUrl,
      otpAuthUrl,
      secretLength: secret.length,
      message: 'New TOTP secret generated. Scan the QR code with your authenticator app or enter the secret manually.',
      note: 'Make sure to set this as XERO_TOTP_SECRET environment variable for the agent to use it.',
    });
  } catch (error) {
    logger.error('Failed to generate TOTP secret', { error });
    res.status(500).json({
      error: 'Failed to generate TOTP secret',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Test endpoint to verify TOTP secret works
app.post('/api/xero/totp-secret/test', async (req, res): Promise<void> => {
  try {
    const { secret } = req.body as { secret?: string };
    
    if (!secret || secret.trim() === '') {
      res.status(400).json({
        error: 'TOTP secret is required',
      });
      return;
    }

    const trimmedSecret = secret.trim();

    // Try to generate multiple codes to verify it works
    const codes: string[] = [];
    const errors: string[] = [];

    try {
      const code1 = authenticator.generate(trimmedSecret);
      codes.push(code1);
      
      // Wait a moment and generate another (might be same or different depending on timing)
      await new Promise(resolve => setTimeout(resolve, 1000));
      const code2 = authenticator.generate(trimmedSecret);
      codes.push(code2);
      
      logger.info('TOTP secret test successful', {
        secretLength: trimmedSecret.length,
        codes: codes,
      });

      res.json({
        success: true,
        secretLength: trimmedSecret.length,
        secretFormat: 'base32',
        codes,
        message: 'TOTP secret is valid and can generate codes',
        note: 'If these codes don\'t match your authenticator app, check: 1) Secret is correct, 2) Time is synchronized, 3) App uses same algorithm (TOTP, 6 digits, 30s step)',
      });
    } catch (genError) {
      const errorMsg = genError instanceof Error ? genError.message : 'Unknown error';
      errors.push(errorMsg);
      
      logger.error('TOTP secret test failed', {
        error: errorMsg,
        secretLength: trimmedSecret.length,
        secretPreview: `${trimmedSecret.substring(0, 4)}...`,
      });

      res.status(400).json({
        success: false,
        error: 'TOTP secret is invalid',
        message: `Failed to generate codes: ${errorMsg}`,
        hint: 'The secret must be a valid base32 encoded string (A-Z, 2-7, no spaces or special characters)',
      });
    }
  } catch (error) {
    logger.error('TOTP secret test error', { error });
    res.status(500).json({
      error: 'Failed to test TOTP secret',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.post('/api/xero/totp-code/preview', async (req, res): Promise<void> => {
  try {
    // Allow secret to be passed in request body, fallback to environment variable
    const { secret: requestSecret } = req.body as { secret?: string };
    const secret = (requestSecret || process.env.XERO_TOTP_SECRET || '').trim();
    
    if (!secret) {
      res.status(400).json({
        error: 'TOTP secret is not configured',
        message: 'Please provide a TOTP secret in the request body or configure XERO_TOTP_SECRET environment variable',
      });
      return;
    }

    // Generate current code with detailed info
    let code: string;
    try {
      code = authenticator.generate(secret);
      if (!code || code.length !== 6) {
        throw new Error(`Invalid code generated: ${code}`);
      }
    } catch (genError) {
      const errorMsg = genError instanceof Error ? genError.message : 'Unknown error';
      logger.error('TOTP code generation failed in preview', { 
        error: errorMsg,
        secretLength: secret.length,
        secretPreview: `${secret.substring(0, 4)}...`,
      });
      res.status(400).json({
        error: 'Failed to generate TOTP code',
        message: `TOTP code generation failed: ${errorMsg}. Please verify your TOTP secret is correct.`,
        hint: 'The secret must be a valid base32 encoded string. Check for extra spaces or invalid characters.',
      });
      return;
    }

    const step = authenticator.options.step || 30;
    const now = Math.floor(Date.now() / 1000);
    const remainingSeconds = step - (now % step);
    const serverTime = new Date().toISOString();

    logger.info('TOTP code preview generated', {
      code,
      remainingSeconds,
      serverTime,
      secretLength: secret.length,
    });

    res.json({
      code,
      remainingSeconds,
      step,
      serverTime,
      secretLength: secret.length,
      note: 'This code is for testing/login purposes only. It will expire in the remaining seconds shown.',
    });
  } catch (error) {
    logger.error('Failed to generate TOTP code preview', { error });
    res.status(500).json({
      error: 'Failed to generate TOTP code',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Serve Xero Agent page
app.get('/xero-agent', (_req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'xero-agent.html'));
});

// Serve main page
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// Start server
const PORT = config.app.port;

// Initialize database and start server
initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`, {
        nodeEnv: config.app.nodeEnv,
        port: PORT,
        deployPing: `deployed-${new Date().toISOString()}`,
      });
    });
  })
  .catch((error) => {
    logger.error('Failed to initialize database', { error });
    process.exit(1);
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

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, closing database connections...');
  await closeDatabaseConnection();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, closing database connections...');
  await closeDatabaseConnection();
  process.exit(0);
});

