# Railway Deployment Guide

This guide will walk you through deploying the Xero Bank Balances application to Railway.app.

## Prerequisites

- GitHub account with the repository pushed
- Railway account (sign up at [railway.app](https://railway.app))
- Xero Developer App created (see XERO_SETUP_GUIDE.md)
- Xero Client ID and Client Secret ready

---

## Step 1: Connect Railway to GitHub

1. Go to [Railway Dashboard](https://railway.app)
2. Click **"Login"** and sign in with your GitHub account
3. Authorize Railway to access your GitHub repositories

---

## Step 2: Create a New Project

1. In the Railway dashboard, click **"New Project"**
2. Select **"Deploy from GitHub repo"**
3. You'll see a list of your GitHub repositories
4. Find and select **`xero-bank-balances`** (or `NickGradwell/xero-bank-balances`)
5. Railway will automatically detect it's a Node.js project and start building

---

## Step 3: Configure Build Settings

Railway should automatically detect the build configuration from `railway.json` and `package.json`. However, verify:

1. Click on your service in Railway
2. Go to **"Settings"** tab
3. Verify the build command is detected (should be `npm install` and `npm run build`)
4. Verify the start command is `npm start` (from Procfile)

---

## Step 4: Set Environment Variables

1. In your Railway service, go to the **"Variables"** tab
2. Click **"New Variable"** to add each environment variable
3. Add the following variables:

### Required Environment Variables

```env
# Xero API Credentials (from Xero Developer Portal)
XERO_CLIENT_ID=your_client_id_here
XERO_CLIENT_SECRET=your_client_secret_here

# OAuth Redirect URI (update after you get Railway URL)
XERO_REDIRECT_URI=https://your-app-name.up.railway.app/auth/xero/callback

# Session Secret (generate a secure random string)
# Use: openssl rand -base64 32
SESSION_SECRET=your_secure_random_session_secret_here

# Application Settings
PORT=3000
NODE_ENV=production
LOG_LEVEL=info
```

### Important Notes:

- **XERO_REDIRECT_URI**: You'll need to update this after Step 5 when you get your Railway URL
- **SESSION_SECRET**: Generate a secure random string (don't use the example value)
- Replace `your_client_id_here` and `your_client_secret_here` with your actual Xero credentials

---

## Step 5: Get Your Railway URL

1. In your Railway service, go to the **"Settings"** tab
2. Scroll down to **"Networking"** section
3. Under **"Public Domain"**, you'll see your Railway URL
   - It will look like: `xero-bank-balances-production-abc123.up.railway.app`
4. Copy this URL

---

## Step 6: Update Redirect URI in Xero

1. Go back to [Xero Developer Portal](https://developer.xero.com/myapps)
2. Click on your app
3. In the **"Redirect URIs"** section, click **"Add redirect URI"**
4. Enter: `https://your-railway-url.up.railway.app/auth/xero/callback`
   - Replace `your-railway-url.up.railway.app` with your actual Railway URL from Step 5
5. Click **"Save"**

---

## Step 7: Update Railway Environment Variable

1. Go back to Railway dashboard
2. Go to **"Variables"** tab
3. Find the `XERO_REDIRECT_URI` variable
4. Click the edit icon (pencil)
5. Update it to: `https://your-railway-url.up.railway.app/auth/xero/callback`
   - Replace with your actual Railway URL
6. Click **"Save"**
7. Railway will automatically redeploy with the new environment variable

---

## Step 8: Verify Deployment

1. Wait for Railway to finish building and deploying (watch the logs)
2. Once deployment is complete, click on your Railway URL
3. You should see the Xero Bank Balances application
4. Click **"Connect to Xero"**
5. You should be redirected to Xero's authorization page
6. After authorizing, you should see your bank account balances

---

## Step 9: Set Up Custom Domain (Optional)

If you want to use a custom domain:

1. In Railway service settings, go to **"Networking"**
2. Under **"Custom Domain"**, click **"Custom Domain"**
3. Enter your domain name
4. Follow Railway's instructions to configure DNS records
5. Update the `XERO_REDIRECT_URI` in both Railway and Xero Developer Portal

---

## Monitoring & Logs

### View Logs

1. In Railway dashboard, click on your service
2. Go to **"Deployments"** tab
3. Click on the latest deployment
4. View the build logs and runtime logs

### Health Check

Your application includes a health check endpoint:
- `https://your-railway-url.up.railway.app/health`

Railway will use this to monitor your application's health.

---

## Troubleshooting

### Build Fails

**Error: "Cannot find module"**
- Check that all dependencies are listed in `package.json`
- Verify `node_modules` is not committed (it's in `.gitignore`)

**Error: "TypeScript compilation failed"**
- Check the build logs for specific TypeScript errors
- Ensure `tsconfig.json` is configured correctly
- Run `npm run build` locally to verify

### Deployment Succeeds but App Doesn't Work

**502 Bad Gateway**
- Check the runtime logs in Railway
- Verify all environment variables are set correctly
- Ensure `PORT` environment variable is set (Railway sets this automatically)

**"Invalid redirect URI" Error**
- Verify `XERO_REDIRECT_URI` in Railway matches exactly what's in Xero Developer Portal
- Make sure you've added the Railway URL to Xero redirect URIs
- The URL is case-sensitive

**"Not authenticated" Error**
- Check that `XERO_CLIENT_ID` and `XERO_CLIENT_SECRET` are set correctly
- Verify `SESSION_SECRET` is set and is a secure random string
- Check Railway logs for authentication errors

### Application Crashes

1. Check Railway logs for error messages
2. Verify all required environment variables are set
3. Check that the build completed successfully
4. Ensure Node.js version matches (should be 20.x per `package.json`)

---

## Updating Your Application

When you push changes to GitHub:

1. Railway will automatically detect the changes
2. It will trigger a new build and deployment
3. Watch the deployment logs to ensure it completes successfully

You can also manually trigger a redeploy:
1. Go to your service in Railway
2. Click on **"Deployments"** tab
3. Click **"Redeploy"** on the latest deployment

---

## Environment Variables Reference

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `XERO_CLIENT_ID` | Yes | Xero Client ID from Developer Portal | `abc123...` |
| `XERO_CLIENT_SECRET` | Yes | Xero Client Secret from Developer Portal | `xyz789...` |
| `XERO_REDIRECT_URI` | Yes | OAuth callback URL | `https://app.up.railway.app/auth/xero/callback` |
| `SESSION_SECRET` | Yes | Secure random string for session encryption | `generated-random-string` |
| `PORT` | No | Port to run on (Railway sets this automatically) | `3000` |
| `NODE_ENV` | Recommended | Environment mode | `production` |
| `LOG_LEVEL` | No | Logging level | `info` |

---

## Security Checklist

- ✅ All sensitive credentials are set as environment variables (not in code)
- ✅ `SESSION_SECRET` is a strong random string
- ✅ `.env` file is in `.gitignore` (not committed)
- ✅ Xero Client Secret is kept secure
- ✅ Redirect URIs are configured correctly in Xero
- ✅ Using HTTPS (Railway provides this automatically)

---

## Next Steps

After successful deployment:

1. ✅ Test the application thoroughly
2. ✅ Monitor logs for any errors
3. ✅ Set up monitoring/alerting (optional)
4. ✅ Consider setting up a custom domain (optional)
5. ✅ Document your Railway URL for future reference

---

## Additional Resources

- [Railway Documentation](https://docs.railway.app/)
- [Railway Discord Community](https://discord.gg/railway)
- [Xero Developer Portal](https://developer.xero.com/)

---

## Quick Reference

**Railway Dashboard:** https://railway.app/dashboard

**Xero Developer Portal:** https://developer.xero.com/myapps

**Health Check Endpoint:** `https://your-app.up.railway.app/health`

**Redirect URI Format:** `https://your-app.up.railway.app/auth/xero/callback`

