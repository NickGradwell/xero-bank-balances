import express from 'express';
import path from 'path';
import session from 'express-session';
import { randomUUID } from 'crypto';
import { config } from './config';
import { logger } from './utils/logger';
import { getAuthorizationUrl, exchangeCodeForToken } from './services/xero/auth';
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
      sessionState: req.session.oauthState,
      sessionStateType: typeof req.session.oauthState,
      sessionExists: !!req.session,
    });

    if (!code || typeof code !== 'string') {
      logger.error('Authorization code missing in callback');
      res.status(400).send('Authorization code missing');
      return;
    }

    // Handle state parameter - Express query params can be string or string[]
    let stateValue: string;
    if (Array.isArray(state)) {
      stateValue = state[0];
      logger.warn('State parameter received as array, using first value', { state });
    } else if (typeof state === 'string') {
      stateValue = state;
    } else {
      logger.error('State parameter missing or invalid type', { state, stateType: typeof state });
      res.status(400).send('State parameter missing');
      return;
    }

    // Store the state from session for logging, but let openid-client validate it
    const storedState = req.session.oauthState;
    
    // Log comparison for debugging but don't fail here - let openid-client handle validation
    if (storedState && stateValue !== storedState) {
      logger.warn('State mismatch detected (will be validated by openid-client)', {
        receivedState: stateValue,
        storedState: storedState,
      });
    }

    // Exchange code for token - openid-client will validate state internally
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

