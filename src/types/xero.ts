// TypeScript types for Xero API responses

export interface XeroAccount {
  AccountID: string;
  Code: string;
  Name: string;
  Type: string;
  BankAccountNumber?: string;
  Status: 'ACTIVE' | 'ARCHIVED';
  CurrencyCode: string;
  Balance?: number;
  UpdatedDateUTC?: string;
}

export interface XeroAccountsResponse {
  Accounts: XeroAccount[];
}

export interface XeroTokenSet {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  token_type: string;
  xero_tenant_id: string;
}

export interface BankAccount {
  accountId: string;
  code: string;
  name: string;
  bankAccountNumber?: string;
  status: string;
  currencyCode: string;
  balance: number;
  balanceFormatted: string;
  updatedDateUTC?: string;
}

