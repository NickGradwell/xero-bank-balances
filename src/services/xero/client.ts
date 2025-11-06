import { XeroClient, Account, AccountType, BankTransaction as XeroBankTransaction, Journal } from 'xero-node';
import { logger } from '../../utils/logger';
import { BankAccount, BankTransaction } from '../../types/xero';
import { getXeroClient, setTokenSet, isTokenExpired, refreshAccessToken } from './auth';
import { XeroTokenSet } from '../../types/xero';

export class XeroService {
  private client: XeroClient;

  constructor(tokenSet?: XeroTokenSet) {
    this.client = getXeroClient();
    if (tokenSet) {
      setTokenSet(tokenSet).catch(err => {
        logger.error('Failed to set token set in constructor', { error: err });
      });
    }
  }

  async ensureValidToken(tokenSet: XeroTokenSet): Promise<XeroTokenSet> {
    if (isTokenExpired(tokenSet)) {
      logger.info('Token expired, refreshing...', { tenantId: tokenSet.xero_tenant_id });
      // Pass tenantId to refresh function so it doesn't need to look it up
      return await refreshAccessToken(tokenSet.refresh_token, tokenSet.xero_tenant_id);
    }
    return tokenSet;
  }

  async getBankAccounts(tokenSet: XeroTokenSet): Promise<BankAccount[]> {
    try {
      // Ensure token is valid
      const validTokenSet = await this.ensureValidToken(tokenSet);
      await setTokenSet(validTokenSet);

      const tenantId = validTokenSet.xero_tenant_id;
      if (!tenantId) {
        throw new Error('No tenant ID available');
      }

      // Get all accounts
      const accountsResponse = await this.client.accountingApi.getAccounts(tenantId);
      const accounts = accountsResponse.body.accounts || [];

      // Filter for bank accounts only - AccountType enum comparison
      const bankAccounts = accounts.filter(
        (account: Account) => account.type === AccountType.BANK
      );

      logger.info(`Retrieved ${bankAccounts.length} bank accounts from Accounts endpoint`);
      
      // Log account details for "The Forest" or other accounts for debugging
      const forestAccount = bankAccounts.find((acc: Account) => 
        acc.name?.toLowerCase().includes('forest') || 
        acc.accountID === 'cec0d2b1-9064-4968-8346-8ac3524e3b52'
      );
      if (forestAccount) {
        logger.info(`Found account details for debugging:`, {
          accountID: forestAccount.accountID,
          name: forestAccount.name,
          code: forestAccount.code || '(empty)',
          type: forestAccount.type,
          status: forestAccount.status,
        });
      } else {
        logger.warn(`Could not find account with ID cec0d2b1-9064-4968-8346-8ac3524e3b52 or name containing 'forest'`);
      }

      // Fetch BankSummary report to get balances
      // The report requires date range - use last 90 days to ensure we capture all accounts
      let balancesMap: Map<string, number> = new Map();
      try {
        const toDate = new Date();
        const fromDate = new Date();
        fromDate.setDate(fromDate.getDate() - 90); // 90 days ago
        
        // Format dates as YYYY-MM-DD for Xero API
        const formatDate = (date: Date): string => {
          return date.toISOString().split('T')[0];
        };
        
        const reportResponse = await this.client.accountingApi.getReportBankSummary(
          tenantId,
          formatDate(fromDate),
          formatDate(toDate)
        );
        const report = reportResponse.body.reports?.[0];
        
        if (report && report.rows) {
          // BankSummary report structure: rows contain sections, each section has rows with account data
          // Recursively process rows to find account balances
          const processRows = (rows: any[]): void => {
            rows.forEach((row: any) => {
              // Check if this row has cells (account data)
              if (row.cells && row.cells.length >= 2) {
                const cells = row.cells;
                // Try to match account by name or code (first cell usually has account name)
                const accountIdentifier = cells[0]?.value;
                // Balance is typically in the last cell
                const balanceValue = cells[cells.length - 1]?.value;
                
                if (accountIdentifier && balanceValue !== undefined && balanceValue !== null) {
                  // Try to find matching account by name or code
                  const matchingAccount = bankAccounts.find(
                    (acc: Account) => 
                      acc.name === accountIdentifier || 
                      acc.code === accountIdentifier ||
                      acc.accountID === accountIdentifier
                  );
                  
                  if (matchingAccount) {
                    // Parse balance - handle string values like "31,144.91" or numeric values
                    const balanceStr = String(balanceValue).replace(/,/g, '');
                    const balance = parseFloat(balanceStr);
                    if (!isNaN(balance)) {
                      balancesMap.set(matchingAccount.accountID || '', balance);
                      logger.debug(`Found balance for account ${matchingAccount.name}: ${balance}`);
                    }
                  }
                }
              }
              
              // Recursively process nested rows
              if (row.rows && Array.isArray(row.rows)) {
                processRows(row.rows);
              }
            });
          };
          
          processRows(report.rows);
        }
        
        logger.info(`Retrieved balances for ${balancesMap.size} bank accounts from BankSummary report`);
      } catch (reportError) {
        const errorDetails: any = {
          message: reportError instanceof Error ? reportError.message : String(reportError),
          stack: reportError instanceof Error ? reportError.stack : undefined,
        };
        
        // Try to extract API response details if available
        if (reportError instanceof Error && (reportError as any).response) {
          errorDetails.response = {
            status: (reportError as any).response?.status,
            statusText: (reportError as any).response?.statusText,
            data: (reportError as any).response?.data,
          };
        }
        
        logger.error('Failed to fetch BankSummary report, balances will default to 0', errorDetails);
      }

      // Transform to our BankAccount format, merging with balances
      return bankAccounts.map((account: Account) => {
        // Get balance from report, default to 0 if not found
        const balance = balancesMap.get(account.accountID || '') ?? 0;
        const currencyCode = account.currencyCode ? String(account.currencyCode) : 'USD';
        const formattedBalance = new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: currencyCode,
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(balance);

        return {
          accountId: account.accountID || '',
          code: account.code || '',
          name: account.name || '',
          bankAccountNumber: account.bankAccountNumber,
          status: account.status ? String(account.status) : 'ACTIVE',
          currencyCode: currencyCode,
          balance: balance,
          balanceFormatted: formattedBalance,
          updatedDateUTC: account.updatedDateUTC ? account.updatedDateUTC.toISOString() : undefined,
        };
      });
    } catch (error) {
      logger.error('Failed to fetch bank accounts', { error });
      throw error;
    }
  }

  async getBankTransactions(
    tokenSet: XeroTokenSet,
    accountId: string,
    accountName: string,
    accountCode: string,
    fromDate: string,
    toDate: string
  ): Promise<BankTransaction[]> {
    try {
      // Ensure token is valid
      const validTokenSet = await this.ensureValidToken(tokenSet);
      await setTokenSet(validTokenSet);

      const tenantId = validTokenSet.xero_tenant_id;
      if (!tenantId) {
        throw new Error('No tenant ID available');
      }

      // Convert date strings to Date objects for client-side filtering
      const fromDateObj = new Date(fromDate);
      fromDateObj.setHours(0, 0, 0, 0); // Start of day
      const toDateObj = new Date(toDate);
      toDateObj.setHours(23, 59, 59, 999); // End of day

      // Try using where clause to filter by account AND date range - Xero API supports filtering
      // According to Xero docs, we can filter by BankAccount.AccountID using Guid syntax
      // Format: BankAccount.AccountID=Guid("account-id") AND Date >= DateTime(...) AND Date <= DateTime(...)
      let where: string | undefined = undefined;
      
      // Format dates for Xero where clause: DateTime(YYYY, MM, DD)
      const formatDateForWhere = (date: Date): string => {
        const year = date.getFullYear();
        const month = date.getMonth() + 1;
        const day = date.getDate();
        return `DateTime(${year}, ${month}, ${day})`;
      };
      
      // Enable where clause to filter by account ID and date range
      // This should return only transactions for this account in the specified date range
      if (accountId) {
        // Try with date range in where clause first
        where = `BankAccount.AccountID=Guid("${accountId}") AND Date >= ${formatDateForWhere(fromDateObj)} AND Date <= ${formatDateForWhere(toDateObj)}`;
        logger.info(`Using where clause with account ID and date range: ${where}`);
      }

      logger.info('Fetching bank transactions', {
        accountId,
        accountName,
        accountCode,
        fromDate,
        toDate,
        usingWhereClause: !!where,
        whereClause: where,
      });

      // Get bank transactions for the specified account
      // We'll filter by date range and account ID client-side since Xero API filtering can be unreliable
      // Note: Xero API pagination starts at page 1, returns up to 100 records per page
      let allTransactions: XeroBankTransaction[] = [];
      let page = 1;
      const pageSize = 100; // Xero typically returns up to 100 per page
      const maxPages = 50; // Safety limit to prevent infinite loops (5000 transactions max)
      let hasMore = true;
      
      logger.info('Starting pagination fetch', {
        accountId,
        accountName,
        accountCode,
        maxPages,
      });
      
      while (hasMore && page <= maxPages) {
        const response = await this.client.accountingApi.getBankTransactions(
          tenantId,
          undefined, // ifModifiedSince - set to undefined to get all transactions regardless of modification date
          where,
          'Date DESC', // order by date descending
          page,
          undefined // unitdp
        );
        
        const transactions = response.body.bankTransactions || [];
        allTransactions = allTransactions.concat(transactions);
        
        // Log response metadata if available
        const responseBody = response.body as any;
        logger.info(`Fetched page ${page}: ${transactions.length} transactions (total so far: ${allTransactions.length})`, {
          hasPagination: !!responseBody.pagination,
          paginationInfo: responseBody.pagination,
          responseKeys: Object.keys(responseBody),
        });
        
        // Check if there are more pages - continue fetching even if < pageSize
        // Only stop if we get 0 transactions (definitely no more pages)
        if (transactions.length === 0) {
          hasMore = false;
          logger.info(`Pagination complete: page ${page} returned 0 transactions`);
        } else {
          // Continue to next page even if we got fewer than pageSize
          // The API might return fewer records per page but still have more pages
          page++;
        }
      }
      
      logger.info(`Pagination finished: fetched ${allTransactions.length} total transactions across ${page - 1} page(s)`);
      
      // Log detailed information about the API response
      logger.info(`API response received: ${allTransactions.length} total transactions fetched`);
      
      if (allTransactions.length > 0) {
        const firstTx = allTransactions[0];
        const lastTx = allTransactions[allTransactions.length - 1];
        logger.info(`First transaction: date=${firstTx.date}, bankAccountId=${firstTx.bankAccount?.accountID}, bankAccountName=${firstTx.bankAccount?.name}`);
        logger.info(`Last transaction: date=${lastTx.date}, bankAccountId=${lastTx.bankAccount?.accountID}, bankAccountName=${lastTx.bankAccount?.name}`);
        
        // Log account IDs from first 5 transactions
        const accountIds = allTransactions.slice(0, 5).map((tx: XeroBankTransaction) => ({
          date: tx.date,
          bankAccountId: tx.bankAccount?.accountID,
          bankAccountName: tx.bankAccount?.name,
          bankAccountCode: tx.bankAccount?.code,
        }));
        logger.info(`First 5 transaction account details: ${JSON.stringify(accountIds)}`);
      } else if (where) {
        // If where clause was used and we got 0 transactions, log this info
        logger.info(`Where clause returned 0 transactions - this could mean no transactions exist for account ${accountId} or all are outside date range`);
        // Try alternate where clause syntaxes to account for API quirks
        const alternateWhereClauses: string[] = [
          `BankAccount.AccountID==Guid("${accountId}")`,
          `BankAccount.AccountID=="${accountId}"`,
          `BankAccount.AccountID="${accountId}"`,
          `AccountID==Guid("${accountId}")`,
          `AccountID=="${accountId}"`,
          `BankAccountID==Guid("${accountId}")`,
          `BankAccountID=="${accountId}"`,
        ];

        for (const altWhere of alternateWhereClauses) {
          try {
            logger.info(`Attempting alternate where clause: ${altWhere}`);
            const testResponse = await this.client.accountingApi.getBankTransactions(
              tenantId,
              undefined,
              altWhere,
              'Date DESC',
              1,
              undefined
            );
            const testTx = testResponse.body.bankTransactions || [];
            logger.info(`Alternate where result: ${testTx.length} transactions`);
            if (testTx.length > 0) {
              // Use this alternate where for the full pagination
              where = altWhere;
              allTransactions = [];
              page = 1;
              hasMore = true;
              logger.info(`Using alternate where clause for pagination: ${where}`);
              while (hasMore && page <= maxPages) {
                const resp = await this.client.accountingApi.getBankTransactions(
                  tenantId,
                  undefined,
                  where,
                  'Date DESC',
                  page,
                  undefined
                );
                const txs = resp.body.bankTransactions || [];
                allTransactions = allTransactions.concat(txs);
                logger.info(`(ALT) Fetched page ${page}: ${txs.length} transactions (total so far: ${allTransactions.length})`);
                if (txs.length < pageSize) {
                  hasMore = false;
                } else {
                  page++;
                }
              }
              logger.info(`(ALT) Pagination finished: fetched ${allTransactions.length} total transactions across ${page - 1} page(s)`);
              break;
            }
          } catch (altErr) {
            logger.warn(`Alternate where clause failed: ${altWhere}`, { error: altErr });
          }
        }

        // If still zero, run an unfiltered diagnostic fetch (first 10 pages) to list account IDs/names present
        if (allTransactions.length === 0) {
          try {
            logger.info('Running unfiltered diagnostics fetch to list account IDs/names present in BankTransactions');
            const diagnosticTransactions: XeroBankTransaction[] = [];
            let diagPage = 1;
            const diagMaxPages = 10; // Fetch more pages for diagnostics
            while (diagPage <= diagMaxPages) {
              const diagResp = await this.client.accountingApi.getBankTransactions(
                tenantId,
                undefined, // ifModifiedSince - undefined to get all
                undefined, // where - undefined to get all accounts
                'Date DESC',
                diagPage,
                undefined
              );
              const txs = diagResp.body.bankTransactions || [];
              diagnosticTransactions.push(...txs);
              
              // Log response metadata
              const diagResponseBody = diagResp.body as any;
              logger.info(`(DIAG) Page ${diagPage}: ${txs.length} transactions (total so far: ${diagnosticTransactions.length})`, {
                hasPagination: !!diagResponseBody.pagination,
                paginationInfo: diagResponseBody.pagination,
              });
              
              // Continue fetching even if < pageSize - only stop if 0 transactions
              if (txs.length === 0) {
                logger.info(`(DIAG) Page ${diagPage} returned 0 transactions, stopping diagnostics pagination`);
                break;
              }
              diagPage++;
            }
            const diagIds = Array.from(new Set(diagnosticTransactions.map(t => t.bankAccount?.accountID).filter(Boolean)));
            const diagNames = Array.from(new Set(diagnosticTransactions.map(t => t.bankAccount?.name).filter(Boolean)));
            logger.info(`(DIAG) Unique account IDs in unfiltered transactions: ${JSON.stringify(diagIds)}`);
            logger.info(`(DIAG) Unique account names in unfiltered transactions: ${JSON.stringify(diagNames)}`);
          } catch (diagErr) {
            logger.warn('Unfiltered diagnostics fetch failed', { error: diagErr });
          }
        }
      }

      // Filter transactions by account ID, name, code, and date range (client-side filtering)
      const filteredTransactions = allTransactions.filter((tx: XeroBankTransaction) => {
        // Get all possible identifiers from transaction
        const txAccountId = tx.bankAccount?.accountID;
        const txAccountName = tx.bankAccount?.name;
        const txAccountCode = tx.bankAccount?.code;
        
        // Try matching by ID first
        let accountMatches = false;
        if (txAccountId && accountId) {
          accountMatches = txAccountId.toLowerCase().trim() === accountId.toLowerCase().trim();
        }
        
        // If ID doesn't match, try matching by name (case-insensitive, trim whitespace)
        if (!accountMatches && txAccountName && accountName) {
          const normalizedTxName = txAccountName.toLowerCase().trim();
          const normalizedAccountName = accountName.toLowerCase().trim();
          accountMatches = normalizedTxName === normalizedAccountName;
          
          // Also try partial matching in case of slight differences
          if (!accountMatches) {
            // Check if one contains the other (for variations like "The Forest" vs "Forest")
            accountMatches = normalizedTxName.includes(normalizedAccountName) || 
                            normalizedAccountName.includes(normalizedTxName);
          }
        }
        
        // If still no match, try matching by account code
        if (!accountMatches && txAccountCode && accountCode) {
          const normalizedTxCode = txAccountCode.toLowerCase().trim();
          const normalizedAccountCode = accountCode.toLowerCase().trim();
          accountMatches = normalizedTxCode === normalizedAccountCode;
        }
        
        if (!accountMatches) {
          return false;
        }
        
        // Filter by date range - but log if transactions are being filtered out due to date
        if (!tx.date) return false;
        const txDate = new Date(tx.date);
        const isInDateRange = txDate >= fromDateObj && txDate <= toDateObj;
        
        // Log if transaction matches account but is outside date range
        if (!isInDateRange && accountMatches) {
          logger.debug(`Transaction matched account but outside date range`, {
            txDate: txDate.toISOString(),
            dateRange: `${fromDateObj.toISOString()} to ${toDateObj.toISOString()}`,
            accountName: txAccountName,
          });
        }
        
        return isInDateRange;
      });
      
      // If where clause returned 0 transactions, try fetching without date filter to see if transactions exist
      if (where && allTransactions.length === 0) {
        logger.info(`Where clause returned 0 transactions. Trying fallback: fetch without date filter to check if account has any transactions...`);
        
        // Try fetching without date filter - use a very wide date range (last 10 years)
        // Note: Xero API where clause might support date filtering, but we'll try without first
        try {
          const fallbackResponse = await this.client.accountingApi.getBankTransactions(
            tenantId,
            undefined,
            where, // Still use where clause to filter by account
            'Date DESC',
            1,
            undefined
          );
          
          const fallbackTransactions = fallbackResponse.body.bankTransactions || [];
          if (fallbackTransactions.length > 0) {
            logger.info(`Fallback query found ${fallbackTransactions.length} transactions for account ${accountId} (without date filter)`);
            const firstFallbackTx = fallbackTransactions[0];
            const lastFallbackTx = fallbackTransactions[fallbackTransactions.length - 1];
            logger.info(`Transaction date range: ${firstFallbackTx.date} to ${lastFallbackTx.date}`);
            logger.warn(`Account has transactions but none in requested date range: ${fromDateObj.toISOString()} to ${toDateObj.toISOString()}`);
          } else {
            logger.warn(`Fallback query also returned 0 transactions - account ${accountId} (${accountName}) appears to have no transactions at all`);
          }
        } catch (fallbackError) {
          logger.error('Fallback query failed', { error: fallbackError });
        }
      }
      
      // Log detailed match information for debugging
      if (filteredTransactions.length === 0 && allTransactions.length > 0) {
        // Check account matches without date filtering
        const accountMatches = allTransactions.filter((tx: XeroBankTransaction) => {
          const txAccountId = tx.bankAccount?.accountID;
          const txAccountName = tx.bankAccount?.name;
          const txAccountCode = tx.bankAccount?.code;
          
          let matches = false;
          if (txAccountId && accountId) {
            matches = txAccountId.toLowerCase().trim() === accountId.toLowerCase().trim();
          }
          
          if (!matches && txAccountName && accountName) {
            const normalizedTxName = txAccountName.toLowerCase().trim();
            const normalizedAccountName = accountName.toLowerCase().trim();
            matches = normalizedTxName === normalizedAccountName ||
                     normalizedTxName.includes(normalizedAccountName) || 
                     normalizedAccountName.includes(normalizedTxName);
          }
          
          if (!matches && txAccountCode && accountCode) {
            matches = txAccountCode.toLowerCase().trim() === accountCode.toLowerCase().trim();
          }
          
          return matches;
        });
        
        logger.info(`No transactions found after filtering. Account matches (without date filter): ${accountMatches.length}`, {
          requestedName: accountName,
          requestedAccountId: accountId,
          requestedAccountCode: accountCode,
          dateRange: `${fromDateObj.toISOString()} to ${toDateObj.toISOString()}`,
          matchingTransactions: accountMatches.slice(0, 5).map((tx: XeroBankTransaction) => ({
            name: tx.bankAccount?.name,
            code: tx.bankAccount?.code,
            date: tx.date,
            accountId: tx.bankAccount?.accountID,
          })),
        });
      }

      logger.info(`Retrieved ${filteredTransactions.length} transactions for account ${accountId} (${accountName}) (from ${allTransactions.length} total)`);
      
      // Log detailed filtering results only if we filtered client-side
      // If we used a where clause, we should only get transactions for this account
      if (!where) {
        const uniqueAccountIds = Array.from(new Set(allTransactions.map((tx: XeroBankTransaction) => 
          tx.bankAccount?.accountID
        ).filter(Boolean)));
        const uniqueAccountNames = Array.from(new Set(allTransactions.map((tx: XeroBankTransaction) => 
          tx.bankAccount?.name
        ).filter(Boolean)));
        const uniqueAccountCodes = Array.from(new Set(allTransactions.map((tx: XeroBankTransaction) => 
          tx.bankAccount?.code
        ).filter(Boolean)));
        logger.info(`Date range: ${fromDateObj.toISOString()} to ${toDateObj.toISOString()}`);
        logger.info(`Account IDs found in transactions: ${JSON.stringify(uniqueAccountIds.slice(0, 10))}`);
        logger.info(`Account names found in transactions: ${JSON.stringify(uniqueAccountNames.slice(0, 10))}`);
        logger.info(`Account codes found in transactions: ${JSON.stringify(uniqueAccountCodes.filter(c => c && c.trim()).slice(0, 10))}`);
        logger.info(`Requested account ID: ${accountId}, Name: ${accountName}, Code: ${accountCode}`);
        
        // Log ALL account names found - this will help us see if "The Forest" appears with a different name
        logger.info(`All account names in transactions (${uniqueAccountNames.length} total): ${JSON.stringify(uniqueAccountNames)}`);
        
        // Check for partial name matches including "forest" in any form
        const forestMatches = uniqueAccountNames.filter(name => {
          if (!name) return false;
          const normalizedName = name.toLowerCase().trim();
          return normalizedName.includes('forest');
        });
        if (forestMatches.length > 0) {
          logger.info(`Found account names containing 'forest': ${JSON.stringify(forestMatches)}`);
        }
        
        // Check for partial name matches
        const nameMatches = uniqueAccountNames.filter(name => {
          if (!name || !accountName) return false;
          const normalizedName = name.toLowerCase().trim();
          const normalizedAccountName = accountName.toLowerCase().trim();
          return normalizedName.includes(normalizedAccountName) || 
                 normalizedAccountName.includes(normalizedName);
        });
        const codeMatches = uniqueAccountCodes.filter(code => {
          if (!code || !accountCode) return false;
          return code.toLowerCase().trim() === accountCode.toLowerCase().trim();
        });
        logger.info(`Match found by ID: ${uniqueAccountIds.includes(accountId)}, by Name (exact): ${uniqueAccountNames.includes(accountName)}, by Name (partial): ${nameMatches.length > 0} (${JSON.stringify(nameMatches)}), by Code: ${codeMatches.length > 0}`);
      } else {
        // If we used where clause, log simpler summary
        logger.info(`Where clause was used - transactions should be filtered by account ID already`);
        if (filteredTransactions.length === 0 && allTransactions.length > 0) {
          logger.warn(`No transactions match date range ${fromDateObj.toISOString()} to ${toDateObj.toISOString()} for account ${accountId}`);
          logger.warn(`Found ${allTransactions.length} transactions for this account, but all are outside the requested date range`);
        } else if (filteredTransactions.length === 0 && allTransactions.length === 0) {
          logger.warn(`No transactions found for account ${accountId} (${accountName}) - this could mean:`);
          logger.warn(`  1. The account has no transactions at all`);
          logger.warn(`  2. All transactions are outside the date range: ${fromDateObj.toISOString()} to ${toDateObj.toISOString()}`);
          logger.warn(`  3. The account ID might not match between Accounts and BankTransactions endpoints`);
        }
      }

      // Log status distribution for visibility
      const statusCounts = new Map<string, number>();
      filteredTransactions.forEach((tx: XeroBankTransaction) => {
        const status = tx.status ? String(tx.status) : '(no status)';
        statusCounts.set(status, (statusCounts.get(status) || 0) + 1);
      });
      logger.info(`Transaction status distribution (filtered set): ${JSON.stringify(Array.from(statusCounts.entries()))}`);

      // Transform to our BankTransaction format
      return filteredTransactions.map((tx: XeroBankTransaction) => {
        // Calculate total amount (sum of line items)
        let totalAmount = 0;
        if (tx.lineItems && tx.lineItems.length > 0) {
          totalAmount = tx.lineItems.reduce((sum, item) => {
            const amount = item.lineAmount || 0;
            return sum + amount;
          }, 0);
        } else if (tx.total) {
          // Fallback to total if line items are not available
          totalAmount = tx.total;
        }

        // Determine if it's a credit or debit based on type
        // Convert enum to string for comparison
        const txTypeStr = tx.type ? String(tx.type) : '';
        const isCredit = txTypeStr === 'RECEIVE' || txTypeStr === 'RECEIVE-OVERPAYMENT' || txTypeStr === 'RECEIVE-PREPAYMENT';
        const displayAmount = isCredit ? Math.abs(totalAmount) : -Math.abs(totalAmount);

        // Get currency code from transaction or default
        // Convert enum to string if needed
        const currencyCode = tx.currencyCode ? String(tx.currencyCode) : 'USD';

        // Format amount
        const formattedAmount = new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: currencyCode,
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(displayAmount);

        // Get description from reference or first line item
        let description = tx.reference || '';
        if (!description && tx.lineItems && tx.lineItems.length > 0) {
          description = tx.lineItems[0].description || '';
        }
        if (!description) {
          description = txTypeStr || 'Transaction';
        }

        return {
          transactionId: tx.bankTransactionID || '',
          date: tx.date ? new Date(tx.date).toISOString().split('T')[0] : '',
          description: description,
          reference: tx.reference,
          amount: displayAmount,
          amountFormatted: formattedAmount,
          type: txTypeStr,
          status: tx.status ? String(tx.status) : 'AUTHORISED',
          contactName: tx.contact?.name,
          isReconciled: tx.isReconciled || false,
        };
      });
    } catch (error) {
      const errorDetails: any = {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        accountId,
        accountName,
        accountCode,
        fromDate,
        toDate,
      };
      
      // Try to extract API response details if available
      if (error instanceof Error && (error as any).response) {
        errorDetails.response = {
          status: (error as any).response?.status,
          statusText: (error as any).response?.statusText,
          data: (error as any).response?.data,
        };
      }
      
      // If where clause failed, log a warning and suggest fallback
      if (errorDetails.message.includes('QueryParseException') || errorDetails.message.includes('where') || (errorDetails.response?.status === 400)) {
        logger.warn('Where clause may have failed - this could mean the account has no transactions or the syntax needs adjustment', errorDetails);
      }
      
      logger.error('Failed to fetch bank transactions', errorDetails);
      throw error;
    }
  }

  // Fetch recent bank transactions without account filter for diagnostics/inspection
  async getAllBankTransactions(
    tokenSet: XeroTokenSet,
    maxPages: number = 3
  ): Promise<Array<{
    transactionId: string;
    date: string;
    description: string;
    reference?: string;
    amount: number;
    amountFormatted: string;
    type: string;
    status: string;
    isReconciled: boolean;
    bankAccountId?: string;
    bankAccountName?: string;
    bankAccountCode?: string;
    currencyCode: string;
  }>> {
    // Ensure token is valid
    const validTokenSet = await this.ensureValidToken(tokenSet);
    await setTokenSet(validTokenSet);

    const tenantId = validTokenSet.xero_tenant_id;
    if (!tenantId) {
      throw new Error('No tenant ID available');
    }

    let allTransactions: XeroBankTransaction[] = [];
    let page = 1;
    const actualMaxPages = Math.max(1, maxPages);
    logger.info(`(ALL) Fetching up to ${actualMaxPages} pages of transactions`);
    
    while (page <= actualMaxPages) {
      const response = await this.client.accountingApi.getBankTransactions(
        tenantId,
        undefined,
        undefined,
        'Date DESC',
        page,
        undefined
      );
      const transactions = response.body.bankTransactions || [];
      allTransactions = allTransactions.concat(transactions);
      
      // Log response metadata to understand Xero's pagination behavior
      const responseBody = response.body as any;
      logger.info(`(ALL) Page ${page}: ${transactions.length} transactions (total so far: ${allTransactions.length})`, {
        hasPagination: !!responseBody.pagination,
        paginationInfo: responseBody.pagination,
        responseKeys: Object.keys(responseBody),
      });
      
      // Continue fetching even if we get fewer than pageSize - the API might have more pages
      // Only stop if we get 0 transactions (definitely no more pages)
      if (transactions.length === 0) {
        logger.info(`(ALL) Page ${page} returned 0 transactions, stopping pagination`);
        break;
      }
      
      page++;
    }
    
    logger.info(`(ALL) Finished pagination: fetched ${allTransactions.length} total transactions across ${page - 1} page(s)`);

    // Log status distribution for visibility
    const allStatusCounts = new Map<string, number>();
    allTransactions.forEach((tx: XeroBankTransaction) => {
      const status = tx.status ? String(tx.status) : '(no status)';
      allStatusCounts.set(status, (allStatusCounts.get(status) || 0) + 1);
    });
    logger.info(`(ALL) Transaction status distribution: ${JSON.stringify(Array.from(allStatusCounts.entries()))}`);

    return allTransactions.map((tx: XeroBankTransaction) => {
      // Calculate total amount (sum of line items) with fallback
      let totalAmount = 0;
      if (tx.lineItems && tx.lineItems.length > 0) {
        totalAmount = tx.lineItems.reduce((sum, item) => {
          const amount = item.lineAmount || 0;
          return sum + amount;
        }, 0);
      } else if (tx.total) {
        totalAmount = tx.total;
      }

      const txTypeStr = tx.type ? String(tx.type) : '';
      const isCredit = txTypeStr === 'RECEIVE' || txTypeStr === 'RECEIVE-OVERPAYMENT' || txTypeStr === 'RECEIVE-PREPAYMENT';
      const displayAmount = isCredit ? Math.abs(totalAmount) : -Math.abs(totalAmount);

      const currencyCode = tx.currencyCode ? String(tx.currencyCode) : 'USD';
      const formattedAmount = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currencyCode,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(displayAmount);

      let description = tx.reference || '';
      if (!description && tx.lineItems && tx.lineItems.length > 0) {
        description = tx.lineItems[0].description || '';
      }
      if (!description) {
        description = txTypeStr || 'Transaction';
      }

      return {
        transactionId: tx.bankTransactionID || '',
        date: tx.date ? new Date(tx.date).toISOString().split('T')[0] : '',
        description,
        reference: tx.reference,
        amount: displayAmount,
        amountFormatted: formattedAmount,
        type: txTypeStr,
        status: tx.status ? String(tx.status) : 'AUTHORISED',
        isReconciled: tx.isReconciled || false,
        bankAccountId: tx.bankAccount?.accountID,
        bankAccountName: tx.bankAccount?.name,
        bankAccountCode: tx.bankAccount?.code,
        currencyCode,
      };
    });
  }

  // Get account transactions using Journals endpoint (more comprehensive than BankTransactions)
  async getAccountTransactionsFromJournals(
    tokenSet: XeroTokenSet,
    accountId: string,
    accountName: string,
    accountCode: string,
    fromDate: string,
    toDate: string
  ): Promise<BankTransaction[]> {
    try {
      // Ensure token is valid
      const validTokenSet = await this.ensureValidToken(tokenSet);
      await setTokenSet(validTokenSet);

      const tenantId = validTokenSet.xero_tenant_id;
      if (!tenantId) {
        throw new Error('No tenant ID available');
      }

      // Convert date strings to Date objects
      const fromDateObj = new Date(fromDate);
      fromDateObj.setHours(0, 0, 0, 0);
      const toDateObj = new Date(toDate);
      toDateObj.setHours(23, 59, 59, 999);

      logger.info('Fetching account transactions from Journals', {
        accountId,
        accountName,
        accountCode,
        fromDate,
        toDate,
      });

      // Fetch all journals with pagination
      let allJournals: Journal[] = [];
      let offset = 0;
      const pageSize = 100;
      const maxPages = 100; // Safety limit (10,000 journals max)
      let hasMore = true;

      while (hasMore && offset < maxPages * pageSize) {
        try {
          const response = await this.client.accountingApi.getJournals(
            tenantId,
            undefined, // ifModifiedSince
            offset, // offset for pagination
            undefined // where clause (not supported for journals)
          );

          const journals = response.body.journals || [];
          allJournals = allJournals.concat(journals);

          logger.info(`(JOURNALS) Fetched offset ${offset}: ${journals.length} journals (total so far: ${allJournals.length})`);

          // If we got fewer than pageSize, we've reached the end
          if (journals.length < pageSize) {
            hasMore = false;
            logger.info(`(JOURNALS) Pagination complete: received ${journals.length} journals (less than page size ${pageSize})`);
          } else {
            offset += pageSize;
          }
        } catch (err) {
          logger.error(`(JOURNALS) Error fetching journals at offset ${offset}`, { error: err });
          hasMore = false;
        }
      }

      logger.info(`(JOURNALS) Finished pagination: fetched ${allJournals.length} total journals`);

      // Filter journals by account and date range
      const matchingTransactions: BankTransaction[] = [];

      for (const journal of allJournals) {
        // Check if journal date is within range
        if (!journal.journalDate) continue;
        const journalDate = new Date(journal.journalDate);
        if (journalDate < fromDateObj || journalDate > toDateObj) {
          continue;
        }

        // Check journal lines for matching account
        if (!journal.journalLines || journal.journalLines.length === 0) continue;

        for (const line of journal.journalLines) {
          // Match by account ID, name, or code
          const lineAccountId = line.accountID || '';
          const lineAccountCode = line.accountCode || '';
          const lineAccountName = line.accountName || '';

          const matchesAccount =
            (accountId && lineAccountId === accountId) ||
            (accountCode && lineAccountCode === accountCode) ||
            (accountName && lineAccountName.toLowerCase().trim() === accountName.toLowerCase().trim());

          if (matchesAccount) {
            // Calculate amount - use netAmount or grossAmount
            const amount = line.netAmount || line.grossAmount || 0;

            // Format amount - default to GBP (can be enhanced to get from account if needed)
            const currencyCode = 'GBP';
            const formattedAmount = new Intl.NumberFormat('en-GB', {
              style: 'currency',
              currency: currencyCode,
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            }).format(amount);

            // Get description from journal or line
            let description = journal.reference || journal.sourceID || '';
            if (!description && line.description) {
              description = line.description;
            }
            if (!description) {
              description = journal.journalNumber?.toString() || 'Journal Entry';
            }

            matchingTransactions.push({
              transactionId: journal.journalID || `journal-${journal.journalNumber}`,
              date: journal.journalDate ? new Date(journal.journalDate).toISOString().split('T')[0] : '',
              description,
              reference: journal.reference || journal.sourceID,
              amount: amount,
              amountFormatted: formattedAmount,
              type: amount >= 0 ? 'DEBIT' : 'CREDIT',
              status: journal.createdDateUTC ? 'AUTHORISED' : 'DRAFT',
              contactName: journal.sourceType ? String(journal.sourceType) : undefined,
              isReconciled: false, // Journals don't have reconciliation status
            });
          }
        }
      }

      // Sort by date descending
      matchingTransactions.sort((a, b) => {
        const dateA = new Date(a.date).getTime();
        const dateB = new Date(b.date).getTime();
        return dateB - dateA;
      });

      logger.info(`(JOURNALS) Found ${matchingTransactions.length} transactions for account ${accountName} (${accountId})`);

      return matchingTransactions;
    } catch (error) {
      const errorDetails: any = {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      };

      if (error instanceof Error && (error as any).response) {
        errorDetails.response = {
          status: (error as any).response?.status,
          statusText: (error as any).response?.statusText,
          data: (error as any).response?.data,
        };
      }

      logger.error('Failed to fetch account transactions from journals', errorDetails);
      throw error;
    }
  }
}

