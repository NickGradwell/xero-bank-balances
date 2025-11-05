import { XeroClient } from 'xero-node';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { XeroTokenSet } from '../../types/xero';

let xeroClient: XeroClient | null = null;

export function getXeroClient(): XeroClient {
  if (!xeroClient) {
    xeroClient = new XeroClient({
      clientId: config.xero.clientId,
      clientSecret: config.xero.clientSecret,
      redirectUris: [config.xero.redirectUri],
      scopes: config.xero.scopes,
    });
  }
  return xeroClient;
}

export async function getAuthorizationUrl(): Promise<string> {
  try {
    const client = getXeroClient();
    const consentUrl = await client.buildConsentUrl();
    logger.info('Generated Xero authorization URL');
    return consentUrl;
  } catch (error) {
    logger.error('Failed to generate authorization URL', { error });
    throw error;
  }
}

export async function exchangeCodeForToken(
  code: string,
  state: string,
  req?: any
): Promise<XeroTokenSet> {
  try {
    const client = getXeroClient();
    
    // apiCallback can accept either a URL string or the request object
    // Try with the request object first if available, otherwise use URL string
    let tokenSet;
    if (req) {
      tokenSet = await client.apiCallback(req);
    } else {
      const callbackUrl = `${config.xero.redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
      tokenSet = await client.apiCallback(callbackUrl);
    }
    
    await client.updateTenants();
    
    const tenantId = client.tenants?.[0]?.tenantId || '';
    
    if (!tokenSet) {
      throw new Error('Token set is null or undefined');
    }

    logger.info('Successfully exchanged code for token', {
      tenantId: tenantId,
      hasAccessToken: !!tokenSet.access_token,
      hasRefreshToken: !!tokenSet.refresh_token,
    });

    return {
      access_token: tokenSet.access_token || '',
      refresh_token: tokenSet.refresh_token || '',
      expires_at: tokenSet.expires_at || 0,
      token_type: tokenSet.token_type || 'Bearer',
      xero_tenant_id: tenantId,
    };
  } catch (error) {
    logger.error('Failed to exchange code for token', { 
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}

export async function refreshAccessToken(refreshToken: string): Promise<XeroTokenSet> {
  try {
    const client = getXeroClient();
    // Set the refresh token first
    client.setTokenSet({
      refresh_token: refreshToken,
    } as any);
    
    // Refresh the token - need to pass tenantId, redirectUri, and scope
    const tenantId = client.tenants?.[0]?.tenantId || '';
    if (!tenantId) {
      throw new Error('No tenant ID available for token refresh');
    }
    
    await client.refreshWithRefreshToken(
      tenantId,
      config.xero.redirectUri,
      config.xero.scopes.join(' ')
    );
    await client.updateTenants();
    
    // Get the updated token set
    const tokenSet = (client as any).tokenSet;
    if (!tokenSet) {
      throw new Error('Token refresh failed - no token set returned');
    }

    const updatedTenantId = client.tenants?.[0]?.tenantId || (tokenSet.tenantId || '');

    logger.info('Successfully refreshed access token');

    return {
      access_token: tokenSet.access_token || '',
      refresh_token: tokenSet.refresh_token || '',
      expires_at: tokenSet.expires_at || 0,
      token_type: tokenSet.token_type || 'Bearer',
      xero_tenant_id: updatedTenantId,
    };
  } catch (error) {
    logger.error('Failed to refresh access token', { error });
    throw error;
  }
}

export async function setTokenSet(tokenSet: XeroTokenSet): Promise<void> {
  const client = getXeroClient();
  client.setTokenSet({
    access_token: tokenSet.access_token,
    refresh_token: tokenSet.refresh_token,
    expires_at: tokenSet.expires_at,
    token_type: tokenSet.token_type,
    id_token: '',
    expires_in: tokenSet.expires_at - Math.floor(Date.now() / 1000),
    tenantId: tokenSet.xero_tenant_id,
  });
  await client.updateTenants();
}

export function isTokenExpired(tokenSet: XeroTokenSet): boolean {
  if (!tokenSet.expires_at) {
    return true;
  }
  // Add 5 minute buffer before expiration
  const bufferTime = 5 * 60 * 1000;
  return Date.now() >= (tokenSet.expires_at * 1000 - bufferTime);
}

