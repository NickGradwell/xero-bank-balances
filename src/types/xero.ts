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

export interface BankTransaction {
  transactionId: string;
  date: string;
  description: string;
  reference?: string;
  amount: number;
  amountFormatted: string;
  type: string;
  status: string;
  contactName?: string;
  isReconciled: boolean;
}

