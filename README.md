# Xero Bank Balances Display

A simple web application to display the balances of all connected bank accounts in a Xero account.

## Features

- OAuth 2.0 authentication with Xero
- Display all connected bank account balances
- Clean, modern web interface using Tailwind CSS
- Real-time balance updates

## Prerequisites

- Node.js 20.x or higher
- A Xero account with bank accounts connected
- Xero Developer App credentials (Client ID and Client Secret)

## Setup

### 1. Create a Xero Developer App

1. Go to [Xero Developer Portal](https://developer.xero.com/myapps)
2. Click "New app" to create a new application
3. Fill in the app details:
   - **App name**: Your app name
   - **Company**: Your company name
   - **OAuth 2.0 redirect URI**: `http://localhost:3000/auth/xero/callback` (for local development)
4. Save your **Client ID** and **Client Secret**
5. Add the following scopes:
   - `accounting.transactions.read`
   - `accounting.settings.read`
   - `offline_access`

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment Variables

Copy `.env.example` to `.env` and fill in your Xero credentials:

```bash
cp .env.example .env
```

Edit `.env` and add your Xero Client ID and Client Secret:

```env
XERO_CLIENT_ID=your_client_id_here
XERO_CLIENT_SECRET=your_client_secret_here
SESSION_SECRET=generate-a-random-secret-string-here
PORT=3000
```

### 4. Build and Run

**Development mode:**
```bash
npm run dev
```

**Production mode:**
```bash
npm run build
npm start
```

The application will be available at `http://localhost:3000`

## Usage

1. Open `http://localhost:3000` in your browser
2. Click "Connect to Xero" to authenticate
3. You'll be redirected to Xero to authorize the app
4. After authorization, you'll be redirected back and see all your connected bank account balances

## Project Structure

```
xero-bank-balances/
├── src/
│   ├── index.ts              # Express server and routes
│   ├── config/
│   │   └── index.ts          # Configuration management
│   ├── services/
│   │   └── xero/
│   │       ├── auth.ts       # OAuth 2.0 authentication
│   │       └── client.ts     # Xero API client
│   ├── types/
│   │   └── xero.ts           # TypeScript types
│   ├── utils/
│   │   └── logger.ts         # Logging utility
│   └── views/
│       ├── index.html        # Main dashboard
│       └── styles.css        # Custom styles
├── package.json
├── tsconfig.json
└── README.md
```

## Technologies

- **Node.js 20.x** - Runtime environment
- **TypeScript** - Type-safe JavaScript
- **Express.js** - Web framework
- **xero-node** - Official Xero Node.js SDK
- **Tailwind CSS** - Utility-first CSS framework
- **Winston** - Logging library

## Notes

- OAuth tokens are stored in session (in-memory). For production, consider using persistent storage.
- The redirect URI must match exactly what's configured in your Xero Developer Portal.
- Bank account balances are retrieved from the Accounts endpoint, filtered by type='BANK'.

## Troubleshooting

### "Invalid redirect URI" error
- Ensure the redirect URI in your `.env` matches exactly what's configured in Xero Developer Portal
- The redirect URI must include the full path: `http://localhost:3000/auth/xero/callback`

### "Access denied" error
- Check that you've authorized the app with the correct scopes in Xero
- Ensure your Xero account has bank accounts connected

### "No bank accounts found"
- Verify that your Xero account has bank accounts connected
- Check that the bank accounts are active in Xero

