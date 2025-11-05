# Local Testing Guide

## Quick Start

1. **Create `.env` file** in the project root:
   ```bash
   cat > .env << 'ENVEOF'
   XERO_CLIENT_ID=your_client_id_from_railway_or_xero_portal
   XERO_CLIENT_SECRET=your_client_secret_from_railway_or_xero_portal
   XERO_REDIRECT_URI=http://localhost:3000/auth/xero/callback
   SESSION_SECRET=generate-a-random-secret-string-here
   PORT=3000
   NODE_ENV=development
   LOG_LEVEL=info
   ENVEOF
   ```

2. **Install dependencies** (if not already installed):
   ```bash
   npm install
   ```

3. **Make sure your Xero Developer App has the local redirect URI**:
   - Go to https://developer.xero.com/myapps
   - Edit your app
   - Add redirect URI: `http://localhost:3000/auth/xero/callback`
   - Save

4. **Run in development mode**:
   ```bash
   npm run dev
   ```

5. **Open in browser**: http://localhost:3000

## Getting Your Credentials

You can get your Xero credentials from:
- **Railway Dashboard**: Environment variables section
- **Xero Developer Portal**: https://developer.xero.com/myapps

## Tips

- The dev server (`npm run dev`) uses `tsx watch` which auto-reloads on file changes
- Logs will appear in your terminal with detailed information
- You'll see detailed transaction logging when clicking on bank accounts
