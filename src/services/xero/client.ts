import { XeroClient } from 'xero-node';
import { logger } from '../../utils/logger';
import { BankAccount, XeroAccount } from '../../types/xero';
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
      logger.info('Token expired, refreshing...');
      return await refreshAccessToken(tokenSet.refresh_token);
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
      const response = await this.client.accountingApi.getAccounts(tenantId);
      const accounts = response.body.accounts || [];

      // Filter for bank accounts only
      const bankAccounts = accounts.filter(
        (account: XeroAccount) => account.Type === 'BANK'
      );

      logger.info(`Retrieved ${bankAccounts.length} bank accounts`);

      // Transform to our BankAccount format
      return bankAccounts.map((account: XeroAccount) => {
        const balance = account.Balance || 0;
        const formattedBalance = new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: account.CurrencyCode || 'USD',
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(balance);

        return {
          accountId: account.AccountID,
          code: account.Code,
          name: account.Name,
          bankAccountNumber: account.BankAccountNumber,
          status: account.Status,
          currencyCode: account.CurrencyCode,
          balance: balance,
          balanceFormatted: formattedBalance,
          updatedDateUTC: account.UpdatedDateUTC,
        };
      });
    } catch (error) {
      logger.error('Failed to fetch bank accounts', { error });
      throw error;
    }
  }
}

