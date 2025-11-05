# Xero Developer App Setup Guide

This guide will walk you through creating a Xero Developer App and obtaining the credentials needed to use the Xero Bank Balances application.

## Prerequisites

- A Xero account (if you don't have one, sign up at [xero.com](https://www.xero.com))
- Access to the Xero organization you want to connect

---

## Step 1: Create a Xero Developer Account

1. Go to the [Xero Developer Portal](https://developer.xero.com/)
2. Click **"Sign in"** or **"Get started"** in the top right
3. Sign in with your Xero account credentials
   - If you don't have a Xero account, you'll need to create one first at [xero.com](https://www.xero.com)

---

## Step 2: Register a New Application

1. Once logged in, you'll see the **"My Apps"** dashboard
2. Click the **"New app"** button (usually a blue button in the top right)
3. You'll be asked to fill in application details:

   **App name:**
   - Enter a descriptive name, e.g., "Bank Balances Display" or "Xero Bank Balances"
   
   **Company:**
   - Enter your company or organization name
   
   **App URL:**
   - This is optional but recommended
   - Enter your application URL (e.g., `https://your-app-name.up.railway.app`)
   - If deploying to Railway, you can update this later with your Railway URL
   
   **Support email:**
   - Enter your support email address

4. Click **"Create app"**

---

## Step 3: Configure OAuth Redirect URIs

After creating your app, you'll see the app details page. This is where you'll configure the redirect URIs.

### For Local Development:

1. In the **"Redirect URIs"** section, click **"Add redirect URI"**
2. Enter: `http://localhost:3000/auth/xero/callback`
3. Click **"Save"**

### For Railway Deployment:

1. **First, deploy your app to Railway** (see RAILWAY_DEPLOYMENT.md)
2. Once you have your Railway URL (e.g., `https://your-app-name.up.railway.app`)
3. Come back to this page and add another redirect URI:
   - Click **"Add redirect URI"**
   - Enter: `https://your-app-name.up.railway.app/auth/xero/callback`
   - Replace `your-app-name.up.railway.app` with your actual Railway URL
4. Click **"Save"**

**Important:** You can add multiple redirect URIs, so you can have both local development and production URLs configured.

---

## Step 4: OAuth Scopes (Already Configured!)

**Good news!** OAuth scopes are not configured in the Xero Developer Portal - they're specified in your application code when making the authorization request. 

The scopes are already configured in your application (`src/config/index.ts`):
- ✅ **accounting.transactions.read** - Read accounting transactions
- ✅ **accounting.settings.read** - Read accounting settings
- ✅ **accounting.reports.read** - Read accounting reports (required for bank balances)
- ✅ **offline_access** - Access data when user is offline (required for refresh tokens)

**You don't need to do anything here** - the application will automatically request these scopes when you click "Connect to Xero". The user will see these permissions when they authorize your app.

---

## Step 5: Get Your Credentials

1. On the app details page, you'll see two important values:

   **Client ID:**
   - This is displayed prominently on the page
   - Copy this value - you'll need it for your `.env` file

   **Client Secret:**
   - Click the **"Show"** button next to "Client Secret"
   - Copy this value - you'll need it for your `.env` file
   - **Important:** Keep this secret secure and never commit it to version control

2. These credentials are what you'll use to authenticate your application with Xero

---

## Step 6: Configure Your Environment Variables

### For Local Development:

1. In your project directory, create a `.env` file (if it doesn't exist)
2. Add the following:

```env
XERO_CLIENT_ID=your_client_id_here
XERO_CLIENT_SECRET=your_client_secret_here
XERO_REDIRECT_URI=http://localhost:3000/auth/xero/callback
SESSION_SECRET=generate-a-random-secret-string-here
PORT=3000
NODE_ENV=development
LOG_LEVEL=info
```

3. Replace `your_client_id_here` and `your_client_secret_here` with the values from Step 5
4. Generate a secure random string for `SESSION_SECRET` (you can use an online generator or run: `openssl rand -base64 32`)

### For Railway Deployment:

See the **RAILWAY_DEPLOYMENT.md** guide for setting environment variables in Railway.

---

## Step 7: Test Your Connection

1. Start your application locally:
   ```bash
   npm run dev
   ```

2. Open your browser and go to `http://localhost:3000`

3. Click **"Connect to Xero"**

4. You should be redirected to Xero's authorization page

5. Select the Xero organization you want to connect

6. Click **"Allow access"**

7. You should be redirected back to your application and see your bank account balances

---

## Troubleshooting

### "Invalid redirect URI" Error

- Make sure the redirect URI in your `.env` file exactly matches what's configured in Xero Developer Portal
- The redirect URI is case-sensitive and must include the full path: `/auth/xero/callback`
- For Railway, make sure you've added the Railway URL to your redirect URIs in Xero

### "Access Denied" Error

- Verify that you've selected the correct scopes in Step 4
- Make sure you're using the correct Client ID and Client Secret
- Check that your Xero account has permission to access the organization

### "No bank accounts found"

- Verify that your Xero account has bank accounts connected
- Check that the bank accounts are active in Xero
- Ensure you've authorized the app with the correct organization

### Can't Find "My Apps" Section

- Make sure you're logged in to the Xero Developer Portal
- Try navigating directly to: https://developer.xero.com/myapps

---

## Security Best Practices

1. **Never commit your `.env` file** - It's already in `.gitignore`
2. **Keep your Client Secret secure** - Treat it like a password
3. **Use different credentials for development and production** - You can create separate apps for each environment
4. **Rotate secrets regularly** - If you suspect a breach, regenerate your Client Secret in Xero Developer Portal
5. **Use strong session secrets** - Generate random strings for production

---

## Next Steps

Once you have your Xero credentials set up:

1. ✅ Test locally to ensure everything works
2. ✅ Deploy to Railway (see RAILWAY_DEPLOYMENT.md)
3. ✅ Update Xero redirect URI with your Railway URL
4. ✅ Set environment variables in Railway dashboard
5. ✅ Test the deployed application

---

## Additional Resources

- [Xero Developer Portal](https://developer.xero.com/)
- [Xero API Documentation](https://developer.xero.com/documentation/api/accounting-api/overview)
- [Xero OAuth 2.0 Overview](https://developer.xero.com/documentation/oauth2/overview)

---

## Quick Reference

**Xero Developer Portal:** https://developer.xero.com/myapps

**Required Scopes:**
- `accounting.transactions.read`
- `accounting.settings.read`
- `offline_access`

**Redirect URI Format:**
- Local: `http://localhost:3000/auth/xero/callback`
- Railway: `https://your-app-name.up.railway.app/auth/xero/callback`

