import { Pool, QueryResult } from 'pg';
import { logger } from '../utils/logger';
import { BankTransaction, XeroTokenSet } from '../types/xero';

let pool: Pool | null = null;

export type BankAccountRecord = {
  accountId: string;
  accountName: string;
  lastCollectedAt: string | null;
};

export type BankStatementLine = {
  id: string;
  accountId: string;
  accountName: string;
  statementDate: string;
  description: string;
  reference: string;
  paymentRef: string;
  spent: string;
  received: string;
  balance: string;
  source: string;
  status: string;
  rawJson?: any;
  createdAt?: string;
};

interface CacheRecord {
  accountId: string;
  accountName: string;
  accountCode: string;
  month: number;
  year: number;
  fetchedAt: string;
  fromDate: string;
  toDate: string;
  transactions: BankTransaction[];
}

export type CacheJobStatus = {
  jobId: string;
  month: number;
  year: number;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  totalAccounts: number | null;
  processedAccounts: number;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
  lastAccountId: string | null;
  lastAccountName: string | null;
};

type CacheJobRow = {
  job_id: string;
  month: number;
  year: number;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  total_accounts: number | null;
  processed_accounts: number;
  started_at: Date | null;
  updated_at: Date;
  completed_at: Date | null;
  error: string | null;
  last_account_id: string | null;
  last_account_name: string | null;
};

export type AdminSettings = {
  enabled: boolean;
  time: string;
  lookbackMonths: number;
  timezone?: string | null;
  updatedAt?: string;
};

const DEFAULT_ADMIN_SETTINGS: AdminSettings = {
  enabled: false,
  time: '02:00',
  lookbackMonths: 1,
  timezone: null,
};

function mapJobRow(row: CacheJobRow): CacheJobStatus {
  return {
    jobId: row.job_id,
    month: row.month,
    year: row.year,
    status: row.status,
    totalAccounts: row.total_accounts,
    processedAccounts: row.processed_accounts,
    startedAt: row.started_at ? row.started_at.toISOString() : null,
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
    error: row.error,
    lastAccountId: row.last_account_id,
    lastAccountName: row.last_account_name,
  };
}

function getPool(): Pool {
  if (!pool) {
    const databaseUrl = process.env.DATABASE_URL;
    
    if (!databaseUrl) {
      throw new Error('DATABASE_URL environment variable is not set. Please configure your PostgreSQL connection string.');
    }

    // Allow overriding SSL validation for self-signed certs (e.g., Railway)
    const sslRejectUnauthorized =
      process.env.PGSSLMODE === 'disable' ? undefined : { rejectUnauthorized: false };

    pool = new Pool({
      connectionString: databaseUrl,
      ssl: sslRejectUnauthorized,
      // Connection pool settings
      max: 10, // Maximum number of clients in the pool
      idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
      connectionTimeoutMillis: 2000, // Return an error after 2 seconds if connection cannot be established
    });

    // Handle pool errors
    pool.on('error', (err) => {
      logger.error('Unexpected error on idle PostgreSQL client', { error: err });
    });

    logger.info('Initialized PostgreSQL connection pool');
  }

  return pool;
}

export async function initTransactionCache(): Promise<void> {
  const database = getPool();
  
  try {
    await database.query(`
      CREATE TABLE IF NOT EXISTS account_transaction_cache (
        account_id TEXT NOT NULL,
        account_name TEXT,
        account_code TEXT,
        month INTEGER NOT NULL,
        year INTEGER NOT NULL,
        fetched_at TEXT NOT NULL,
        from_date TEXT NOT NULL,
        to_date TEXT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (account_id, month, year)
      );
    `);

    await database.query(`
      CREATE TABLE IF NOT EXISTS cache_jobs (
        job_id UUID PRIMARY KEY,
        month INTEGER NOT NULL,
        year INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        total_accounts INTEGER,
        processed_accounts INTEGER NOT NULL DEFAULT 0,
        started_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        error TEXT,
        last_account_id TEXT,
        last_account_name TEXT
      );
    `);

    await database.query(`
      CREATE INDEX IF NOT EXISTS idx_cache_jobs_month_year ON cache_jobs (year DESC, month DESC, started_at DESC);
    `);

    await database.query(`
      CREATE TABLE IF NOT EXISTS admin_settings (
        id INTEGER PRIMARY KEY DEFAULT 1,
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        time TEXT NOT NULL DEFAULT '02:00',
        lookback_months INTEGER NOT NULL DEFAULT 1,
        timezone TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await database.query(`
      CREATE TABLE IF NOT EXISTS xero_tokens (
        id INTEGER PRIMARY KEY DEFAULT 1,
        access_token TEXT,
        refresh_token TEXT,
        expires_at BIGINT,
        token_type TEXT,
        xero_tenant_id TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await database.query(`
      CREATE TABLE IF NOT EXISTS bank_accounts (
        account_id TEXT PRIMARY KEY,
        account_name TEXT NOT NULL,
        last_collected_at TIMESTAMPTZ
      );
    `);

    await database.query(`
      CREATE TABLE IF NOT EXISTS bank_statement_lines (
        id UUID PRIMARY KEY,
        account_id TEXT NOT NULL,
        account_name TEXT,
        statement_date TEXT,
        description TEXT,
        reference TEXT,
        payment_ref TEXT,
        spent TEXT,
        received TEXT,
        balance TEXT,
        source TEXT,
        status TEXT,
        raw_json JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        FOREIGN KEY (account_id) REFERENCES bank_accounts(account_id) ON DELETE CASCADE
      );
    `);

    // Drop old partial index if it exists (migration)
    await database.query(`
      DROP INDEX IF EXISTS idx_bank_statement_unique;
    `);

    // Add unique constraint to prevent duplicates based on transaction details
    // Note: Using a regular unique index (not partial) so it can be used in ON CONFLICT
    await database.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_statement_unique 
      ON bank_statement_lines(account_id, statement_date, description, reference, spent, received, balance);
    `);

    await database.query(`CREATE INDEX IF NOT EXISTS idx_bank_statement_account ON bank_statement_lines(account_id, created_at DESC);`);
    await database.query(`CREATE INDEX IF NOT EXISTS idx_bank_statement_date ON bank_statement_lines(statement_date);`);

    logger.info('Initialized transaction cache database tables');
  } catch (error) {
    logger.error('Failed to initialize transaction cache database', { error });
    throw error;
  }
}

export async function upsertBankAccounts(accounts: BankAccountRecord[]): Promise<void> {
  if (!accounts.length) return;
  const database = getPool();
  const values: any[] = [];
  const chunks: string[] = [];
  accounts.forEach((acc, i) => {
    const idx = i * 3;
    chunks.push(`($${idx + 1}, $${idx + 2}, $${idx + 3})`);
    values.push(acc.accountId, acc.accountName, acc.lastCollectedAt ?? null);
  });
  const sql = `
    INSERT INTO bank_accounts (account_id, account_name, last_collected_at)
    VALUES ${chunks.join(', ')}
    ON CONFLICT (account_id) DO UPDATE
    SET account_name = EXCLUDED.account_name,
        last_collected_at = EXCLUDED.last_collected_at
  `;
  await database.query(sql, values);
}

export async function listBankAccounts(limit = 100): Promise<BankAccountRecord[]> {
  const database = getPool();
  const res = await database.query(
    `SELECT account_id, account_name, last_collected_at FROM bank_accounts ORDER BY account_name ASC LIMIT $1`,
    [limit]
  );
  return res.rows.map((r) => ({
    accountId: r.account_id,
    accountName: r.account_name,
    lastCollectedAt: r.last_collected_at ? new Date(r.last_collected_at).toISOString() : null,
  }));
}

export async function insertBankStatementLines(lines: BankStatementLine[]): Promise<void> {
  if (!lines.length) return;
  const database = getPool();
  const values: any[] = [];
  const chunks: string[] = [];
  lines.forEach((line, i) => {
    const idx = i * 13;
    chunks.push(
      `($${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7}, $${idx + 8}, $${idx + 9}, $${idx + 10}, $${idx + 11}, $${idx + 12}, $${idx + 13})`
    );
    values.push(
      line.id,
      line.accountId,
      line.accountName || null,
      line.statementDate || null,
      line.description || null,
      line.reference || null,
      line.paymentRef || null,
      line.spent || null,
      line.received || null,
      line.balance || null,
      line.source || null,
      line.status || null,
      line.rawJson ? JSON.stringify(line.rawJson) : null
    );
  });
  const sql = `
    INSERT INTO bank_statement_lines (
      id, account_id, account_name, statement_date, description, reference, payment_ref,
      spent, received, balance, source, status, raw_json
    ) VALUES ${chunks.join(', ')}
    ON CONFLICT (account_id, statement_date, description, reference, spent, received, balance) 
    DO NOTHING
  `;
  await database.query(sql, values);
}

export async function getRecentStatementLines(limit = 100): Promise<BankStatementLine[]> {
  const database = getPool();
  const res = await database.query(
    `SELECT id, account_id, account_name, statement_date, description, reference, payment_ref, spent, received, balance, source, status, raw_json, created_at
     FROM bank_statement_lines
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return res.rows.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    accountName: r.account_name,
    statementDate: r.statement_date,
    description: r.description,
    reference: r.reference,
    paymentRef: r.payment_ref,
    spent: r.spent,
    received: r.received,
    balance: r.balance,
    source: r.source,
    status: r.status,
    rawJson: r.raw_json,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : undefined,
  }));
}

export async function getCachedTransactions(
  accountId: string,
  month: number,
  year: number
): Promise<CacheRecord | null> {
  const database = getPool();
  
  try {
    const result: QueryResult<{
      account_id: string;
      account_name: string;
      account_code: string;
      month: number;
      year: number;
      fetched_at: string;
      from_date: string;
      to_date: string;
      data: string;
    }> = await database.query(
      `SELECT account_id, account_name, account_code, month, year, fetched_at, from_date, to_date, data
       FROM account_transaction_cache
       WHERE account_id = $1 AND month = $2 AND year = $3`,
      [accountId, month, year]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];

    try {
      const transactions: BankTransaction[] = JSON.parse(row.data);
      return {
        accountId: row.account_id,
        accountName: row.account_name,
        accountCode: row.account_code,
        month: row.month,
        year: row.year,
        fetchedAt: row.fetched_at,
        fromDate: row.from_date,
        toDate: row.to_date,
        transactions,
      };
    } catch (error) {
      logger.error('Failed to parse cached transaction JSON', { error });
      return null;
    }
  } catch (error) {
    logger.error('Failed to get cached transactions', { error, accountId, month, year });
    return null;
  }
}

export async function saveTransactionsToCache(params: {
  accountId: string;
  accountName: string;
  accountCode: string;
  month: number;
  year: number;
  fromDate: string;
  toDate: string;
  transactions: BankTransaction[];
}): Promise<string> {
  const database = getPool();
  const { accountId, accountName, accountCode, month, year, fromDate, toDate, transactions } = params;
  const fetchedAt = new Date().toISOString();

  try {
    await database.query(
      `INSERT INTO account_transaction_cache (
        account_id,
        account_name,
        account_code,
        month,
        year,
        fetched_at,
        from_date,
        to_date,
        data
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT(account_id, month, year) DO UPDATE SET
        account_name = EXCLUDED.account_name,
        account_code = EXCLUDED.account_code,
        fetched_at = EXCLUDED.fetched_at,
        from_date = EXCLUDED.from_date,
        to_date = EXCLUDED.to_date,
        data = EXCLUDED.data`,
      [
        accountId,
        accountName,
        accountCode,
        month,
        year,
        fetchedAt,
        fromDate,
        toDate,
        JSON.stringify(transactions),
      ]
    );

    logger.info('Cached transactions for account/month', {
      accountId,
      accountName,
      accountCode,
      month,
      year,
      transactionCount: transactions.length,
    });

    return fetchedAt;
  } catch (error) {
    logger.error('Failed to save transactions to cache', { error, accountId, month, year });
    throw error;
  }
}

export async function clearCacheForAccountMonth(
  accountId: string,
  month: number,
  year: number
): Promise<void> {
  const database = getPool();
  
  try {
    await database.query(
      `DELETE FROM account_transaction_cache WHERE account_id = $1 AND month = $2 AND year = $3`,
      [accountId, month, year]
    );
    logger.info('Cleared transaction cache for account/month', { accountId, month, year });
  } catch (error) {
    logger.error('Failed to clear cache for account/month', { error, accountId, month, year });
    throw error;
  }
}

export async function listCachedMonths(
  accountId: string
): Promise<Array<{ month: number; year: number; fetchedAt: string }>> {
  const database = getPool();
  
  try {
    const result: QueryResult<{ month: number; year: number; fetched_at: string }> = await database.query(
      `SELECT month, year, fetched_at FROM account_transaction_cache WHERE account_id = $1 ORDER BY year DESC, month DESC`,
      [accountId]
    );
    return result.rows.map((row) => ({
      month: row.month,
      year: row.year,
      fetchedAt: row.fetched_at,
    }));
  } catch (error) {
    logger.error('Failed to list cached months', { error, accountId });
    return [];
  }
}

export async function createCacheJobRecord(params: {
  jobId: string;
  month: number;
  year: number;
}): Promise<CacheJobStatus> {
  const database = getPool();
  const { jobId, month, year } = params;

  try {
    const result: QueryResult<CacheJobRow> = await database.query(
      `INSERT INTO cache_jobs (job_id, month, year, status, processed_accounts, updated_at)
       VALUES ($1, $2, $3, 'pending', 0, NOW())
       ON CONFLICT (job_id) DO UPDATE SET
         month = EXCLUDED.month,
         year = EXCLUDED.year,
         status = 'pending',
         processed_accounts = 0,
         total_accounts = NULL,
         started_at = NULL,
         completed_at = NULL,
         error = NULL,
         last_account_id = NULL,
         last_account_name = NULL,
         updated_at = NOW()
       RETURNING *`
      , [jobId, month, year]
    );
    return mapJobRow(result.rows[0]);
  } catch (error) {
    logger.error('Failed to create cache job record', { error, jobId, month, year });
    throw error;
  }
}

export async function markCacheJobStarted(params: {
  jobId: string;
  totalAccounts: number;
}): Promise<void> {
  const database = getPool();
  const { jobId, totalAccounts } = params;

  try {
    await database.query(
      `UPDATE cache_jobs
       SET status = 'running',
           total_accounts = $2,
           processed_accounts = 0,
           started_at = NOW(),
           updated_at = NOW(),
           error = NULL,
           last_account_id = NULL,
           last_account_name = NULL
       WHERE job_id = $1`
      , [jobId, totalAccounts]
    );
  } catch (error) {
    logger.error('Failed to mark cache job as started', { error, jobId, totalAccounts });
  }
}

export async function updateCacheJobProgress(params: {
  jobId: string;
  processedAccounts: number;
  lastAccountId: string | null;
  lastAccountName: string | null;
}): Promise<void> {
  const database = getPool();
  const { jobId, processedAccounts, lastAccountId, lastAccountName } = params;

  try {
    await database.query(
      `UPDATE cache_jobs
       SET processed_accounts = $2,
           updated_at = NOW(),
           last_account_id = $3,
           last_account_name = $4
       WHERE job_id = $1`
      , [jobId, processedAccounts, lastAccountId, lastAccountName]
    );
  } catch (error) {
    logger.error('Failed to update cache job progress', { error, jobId, processedAccounts });
  }
}

export async function completeCacheJob(jobId: string): Promise<void> {
  const database = getPool();

  try {
    await database.query(
      `UPDATE cache_jobs
       SET status = 'succeeded',
           completed_at = NOW(),
           updated_at = NOW()
       WHERE job_id = $1`,
      [jobId]
    );
  } catch (error) {
    logger.error('Failed to complete cache job', { error, jobId });
  }
}

export async function failCacheJob(params: { jobId: string; errorMessage: string }): Promise<void> {
  const database = getPool();
  const { jobId, errorMessage } = params;

  try {
    await database.query(
      `UPDATE cache_jobs
       SET status = 'failed',
           error = $2,
           updated_at = NOW(),
           completed_at = NOW()
       WHERE job_id = $1`,
      [jobId, errorMessage.substring(0, 1000)]
    );
  } catch (error) {
    logger.error('Failed to mark cache job as failed', { error, jobId, errorMessage });
  }
}

export async function getCacheJobById(jobId: string): Promise<CacheJobStatus | null> {
  const database = getPool();

  try {
    const result: QueryResult<CacheJobRow> = await database.query(
      `SELECT * FROM cache_jobs WHERE job_id = $1`,
      [jobId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return mapJobRow(result.rows[0]);
  } catch (error) {
    logger.error('Failed to fetch cache job by id', { error, jobId });
    return null;
  }
}

export async function getLatestCacheJob(params: {
  month: number;
  year: number;
}): Promise<CacheJobStatus | null> {
  const database = getPool();
  const { month, year } = params;

  try {
    const result: QueryResult<CacheJobRow> = await database.query(
      `SELECT *
       FROM cache_jobs
       WHERE month = $1 AND year = $2
       ORDER BY started_at DESC NULLS LAST, updated_at DESC
       LIMIT 1`,
      [month, year]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return mapJobRow(result.rows[0]);
  } catch (error) {
    logger.error('Failed to fetch latest cache job for month/year', { error, month, year });
    return null;
  }
}

export async function getAdminSettings(): Promise<AdminSettings> {
  const database = getPool();

  try {
    const result = await database.query<{
      enabled: boolean;
      time: string;
      lookback_months: number;
      timezone: string | null;
      updated_at: Date;
    }>(
      `SELECT enabled, time, lookback_months, timezone, updated_at FROM admin_settings WHERE id = 1`
    );

    if (result.rows.length === 0) {
      return { ...DEFAULT_ADMIN_SETTINGS };
    }

    const row = result.rows[0];
    return {
      enabled: row.enabled,
      time: row.time || DEFAULT_ADMIN_SETTINGS.time,
      lookbackMonths: row.lookback_months || DEFAULT_ADMIN_SETTINGS.lookbackMonths,
      timezone: row.timezone,
      updatedAt: row.updated_at.toISOString(),
    };
  } catch (error) {
    logger.error('Failed to load admin settings', { error });
    return { ...DEFAULT_ADMIN_SETTINGS };
  }
}

export async function saveAdminSettings(settings: AdminSettings): Promise<AdminSettings> {
  const database = getPool();

  try {
    const result = await database.query<{
      enabled: boolean;
      time: string;
      lookback_months: number;
      timezone: string | null;
      updated_at: Date;
    }>(
      `INSERT INTO admin_settings (id, enabled, time, lookback_months, timezone, updated_at)
       VALUES (1, $1, $2, $3, $4, NOW())
       ON CONFLICT (id) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         time = EXCLUDED.time,
         lookback_months = EXCLUDED.lookback_months,
         timezone = EXCLUDED.timezone,
         updated_at = NOW()
       RETURNING enabled, time, lookback_months, timezone, updated_at`,
      [settings.enabled, settings.time, settings.lookbackMonths, settings.timezone ?? null]
    );

    const row = result.rows[0];
    return {
      enabled: row.enabled,
      time: row.time || DEFAULT_ADMIN_SETTINGS.time,
      lookbackMonths: row.lookback_months || DEFAULT_ADMIN_SETTINGS.lookbackMonths,
      timezone: row.timezone,
      updatedAt: row.updated_at.toISOString(),
    };
  } catch (error) {
    logger.error('Failed to save admin settings', { error, settings });
    throw error;
  }
}

export async function getStoredTokenSet(): Promise<XeroTokenSet | null> {
  const database = getPool();

  try {
    const result = await database.query<{
      access_token: string | null;
      refresh_token: string | null;
      expires_at: number | null;
      token_type: string | null;
      xero_tenant_id: string | null;
    }>(`SELECT access_token, refresh_token, expires_at, token_type, xero_tenant_id FROM xero_tokens WHERE id = 1`);

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    if (!row.access_token || !row.refresh_token || !row.xero_tenant_id) {
      return null;
    }

    return {
      access_token: row.access_token,
      refresh_token: row.refresh_token,
      expires_at: row.expires_at ?? 0,
      token_type: row.token_type || 'Bearer',
      xero_tenant_id: row.xero_tenant_id,
    };
  } catch (error) {
    logger.error('Failed to load stored token set', { error });
    return null;
  }
}

export async function getRecentCacheJobs(limit: number): Promise<CacheJobStatus[]> {
  const database = getPool();

  try {
    const result: QueryResult<CacheJobRow> = await database.query(
      `SELECT * FROM cache_jobs ORDER BY updated_at DESC LIMIT $1`,
      [limit]
    );
    return result.rows.map(mapJobRow);
  } catch (error) {
    logger.error('Failed to load recent cache jobs', { error, limit });
    return [];
  }
}

export async function storeTokenSet(tokenSet: XeroTokenSet): Promise<void> {
  const database = getPool();

  try {
    await database.query(
      `INSERT INTO xero_tokens (id, access_token, refresh_token, expires_at, token_type, xero_tenant_id, updated_at)
       VALUES (1, $1, $2, $3, $4, $5, NOW())
       ON CONFLICT (id) DO UPDATE SET
         access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         expires_at = EXCLUDED.expires_at,
         token_type = EXCLUDED.token_type,
         xero_tenant_id = EXCLUDED.xero_tenant_id,
         updated_at = NOW()` ,
      [
        tokenSet.access_token,
        tokenSet.refresh_token,
        tokenSet.expires_at,
        tokenSet.token_type,
        tokenSet.xero_tenant_id,
      ]
    );
  } catch (error) {
    logger.error('Failed to persist Xero token set', { error });
  }
}

export async function closeDatabaseConnection(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info('Closed PostgreSQL connection pool');
  }
}