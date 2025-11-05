import dotenv from 'dotenv';

dotenv.config();

interface Config {
  xero: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    scopes: string[];
  };
  app: {
    port: number;
    nodeEnv: string;
    logLevel: string;
    sessionSecret: string;
  };
}

export const config: Config = {
  xero: {
    clientId: process.env.XERO_CLIENT_ID || '',
    clientSecret: process.env.XERO_CLIENT_SECRET || '',
    redirectUri: process.env.XERO_REDIRECT_URI || 'http://localhost:3000/auth/xero/callback',
        scopes: [
          'accounting.transactions.read',
          'accounting.settings.read',
          'accounting.reports.read',
          'offline_access',
        ],
  },
  app: {
    port: parseInt(process.env.PORT || '3000', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    logLevel: process.env.LOG_LEVEL || 'info',
    sessionSecret: process.env.SESSION_SECRET || 'change-this-secret-in-production',
  },
};

export default config;

