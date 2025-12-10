import { logger } from '../utils/logger';

interface EmailOptions {
  subject: string;
  htmlContent: string;
  textContent?: string;
}

/**
 * Send email using Brevo API
 */
export async function sendEmail(options: EmailOptions): Promise<boolean> {
  const apiKey = process.env.BREVO_API_KEY;
  const recipients = process.env.EMAIL_RECIPIENTS;

  if (!apiKey) {
    logger.error('BREVO_API_KEY not configured - cannot send email');
    return false;
  }

  if (!recipients) {
    logger.error('EMAIL_RECIPIENTS not configured - cannot send email');
    return false;
  }

  // Parse comma-separated recipients
  const recipientList = recipients
    .split(',')
    .map((email) => email.trim())
    .filter((email) => email.length > 0);

  if (recipientList.length === 0) {
    logger.error('No valid email recipients found in EMAIL_RECIPIENTS');
    return false;
  }

  try {
    // Use EMAIL_SENDER or default to a placeholder (must be verified in Brevo)
    const senderEmail = process.env.EMAIL_SENDER || 'noreply@xero-bank-balances.com';
    
    const emailPayload = {
      sender: {
        name: 'Xero Bank Balances',
        email: senderEmail,
      },
      to: recipientList.map((email) => ({ email })),
      subject: options.subject,
      htmlContent: options.htmlContent,
      textContent: options.textContent || options.htmlContent.replace(/<[^>]*>/g, ''), // Strip HTML for text version
    };

    logger.info('Attempting to send email via Brevo', {
      sender: senderEmail,
      recipientCount: recipientList.length,
      subject: options.subject,
      apiKeyPresent: !!apiKey,
      apiKeyLength: apiKey?.length || 0,
    });

    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(emailPayload),
    });

    const responseText = await response.text();
    
    if (!response.ok) {
      let errorData;
      try {
        errorData = JSON.parse(responseText);
      } catch {
        errorData = responseText;
      }
      
      logger.error('Brevo API error', {
        status: response.status,
        statusText: response.statusText,
        error: errorData,
        sender: senderEmail,
        recipients: recipientList,
      });
      return false;
    }

    let result;
    try {
      result = JSON.parse(responseText);
    } catch {
      result = { messageId: responseText };
    }
    
    logger.info('Email sent successfully', {
      messageId: result.messageId,
      recipients: recipientList,
      sender: senderEmail,
    });
    return true;
  } catch (error) {
    logger.error('Failed to send email - exception occurred', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      sender: process.env.EMAIL_SENDER || 'noreply@xero-bank-balances.com',
    });
    return false;
  }
}

/**
 * Send email for Agent 1 (Account IDs collection) completion
 */
export async function sendAccountCollectionEmail(
  totalAccounts: number,
  newAccounts: number,
  updatedAccounts: number,
  errors?: string[]
): Promise<void> {
  const hasErrors = errors && errors.length > 0;
  const subject = hasErrors
    ? `Xero Account Collection - Completed with Errors (${totalAccounts} accounts)`
    : `Xero Account Collection - Completed Successfully (${totalAccounts} accounts)`;

  const htmlContent = `
    <html>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
        <h2 style="color: ${hasErrors ? '#d32f2f' : '#2e7d32'};">Xero Account Collection ${hasErrors ? 'Completed with Errors' : 'Completed Successfully'}</h2>
        
        <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <h3 style="margin-top: 0;">Summary</h3>
          <ul style="list-style-type: none; padding: 0;">
            <li style="margin: 10px 0;"><strong>Total Accounts Found:</strong> ${totalAccounts}</li>
            <li style="margin: 10px 0;"><strong>New Accounts Added:</strong> ${newAccounts}</li>
            <li style="margin: 10px 0;"><strong>Existing Accounts Updated:</strong> ${updatedAccounts}</li>
            ${hasErrors ? `<li style="margin: 10px 0; color: #d32f2f;"><strong>Errors:</strong> ${errors!.length}</li>` : ''}
          </ul>
        </div>

        ${hasErrors ? `
          <div style="background-color: #ffebee; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #d32f2f;">
            <h3 style="margin-top: 0; color: #d32f2f;">Errors</h3>
            <ul>
              ${errors!.map((error) => `<li>${error}</li>`).join('')}
            </ul>
          </div>
        ` : ''}

        <p style="color: #666; font-size: 12px; margin-top: 30px;">
          This is an automated email from the Xero Bank Balances system.
        </p>
      </body>
    </html>
  `;

  const success = await sendEmail({ subject, htmlContent });
  if (!success) {
    logger.error('Failed to send account collection email', {
      totalAccounts,
      newAccounts,
      updatedAccounts,
      hasErrors: !!errors,
    });
  }
}

/**
 * Send email for Agent 2 (Bank Statements collection) completion
 */
export async function sendStatementCollectionEmail(
  accountsProcessed: number,
  totalLines: number,
  linesByAccount: Array<{ accountName: string; lineCount: number }>,
  errors?: string[]
): Promise<void> {
  const hasErrors = errors && errors.length > 0;
  const subject = hasErrors
    ? `Xero Bank Statements Collection - Completed with Errors (${totalLines} transactions)`
    : `Xero Bank Statements Collection - Completed Successfully (${totalLines} transactions)`;

  const htmlContent = `
    <html>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
        <h2 style="color: ${hasErrors ? '#d32f2f' : '#2e7d32'};">Xero Bank Statements Collection ${hasErrors ? 'Completed with Errors' : 'Completed Successfully'}</h2>
        
        <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <h3 style="margin-top: 0;">Summary</h3>
          <ul style="list-style-type: none; padding: 0;">
            <li style="margin: 10px 0;"><strong>Accounts Processed:</strong> ${accountsProcessed}</li>
            <li style="margin: 10px 0;"><strong>Total Transactions Collected:</strong> ${totalLines}</li>
            ${hasErrors ? `<li style="margin: 10px 0; color: #d32f2f;"><strong>Errors:</strong> ${errors!.length}</li>` : ''}
          </ul>
        </div>

        <div style="background-color: #fff; padding: 15px; border-radius: 5px; margin: 20px 0; border: 1px solid #ddd;">
          <h3 style="margin-top: 0;">Transactions by Account</h3>
          <table style="width: 100%; border-collapse: collapse;">
            <thead>
              <tr style="background-color: #f9f9f9;">
                <th style="padding: 10px; text-align: left; border-bottom: 2px solid #ddd;">Account Name</th>
                <th style="padding: 10px; text-align: right; border-bottom: 2px solid #ddd;">Transactions</th>
              </tr>
            </thead>
            <tbody>
              ${linesByAccount.map(
                (acc) => `
                <tr>
                  <td style="padding: 8px; border-bottom: 1px solid #eee;">${acc.accountName}</td>
                  <td style="padding: 8px; text-align: right; border-bottom: 1px solid #eee;">${acc.lineCount}</td>
                </tr>
              `
              ).join('')}
            </tbody>
          </table>
        </div>

        ${hasErrors ? `
          <div style="background-color: #ffebee; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #d32f2f;">
            <h3 style="margin-top: 0; color: #d32f2f;">Errors</h3>
            <ul>
              ${errors!.map((error) => `<li>${error}</li>`).join('')}
            </ul>
          </div>
        ` : ''}

        <p style="color: #666; font-size: 12px; margin-top: 30px;">
          This is an automated email from the Xero Bank Balances system.
        </p>
      </body>
    </html>
  `;

  const success = await sendEmail({ subject, htmlContent });
  if (!success) {
    logger.error('Failed to send statement collection email', {
      accountsProcessed,
      totalLines,
      hasErrors: !!errors,
    });
  }
}

/**
 * Send error email
 */
export async function sendErrorEmail(
  agent: 'Agent 1' | 'Agent 2',
  error: string,
  details?: Record<string, any>
): Promise<void> {
  const subject = `Xero ${agent} - Error Occurred`;

  const htmlContent = `
    <html>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
        <h2 style="color: #d32f2f;">Error in ${agent}</h2>
        
        <div style="background-color: #ffebee; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #d32f2f;">
          <h3 style="margin-top: 0; color: #d32f2f;">Error Message</h3>
          <p style="margin: 0;">${error}</p>
        </div>

        ${details ? `
          <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <h3 style="margin-top: 0;">Details</h3>
            <pre style="background-color: #fff; padding: 10px; border-radius: 3px; overflow-x: auto;">${JSON.stringify(details, null, 2)}</pre>
          </div>
        ` : ''}

        <p style="color: #666; font-size: 12px; margin-top: 30px;">
          This is an automated error notification from the Xero Bank Balances system.
        </p>
      </body>
    </html>
  `;

  const success = await sendEmail({ subject, htmlContent });
  if (!success) {
    logger.error('Failed to send error email', {
      agent,
      error,
    });
  }
}

