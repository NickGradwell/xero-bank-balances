#!/bin/bash

echo "Setting up local development environment..."
echo ""

# Check if .env exists
if [ ! -f .env ]; then
  echo "Creating .env file from .env.example..."
  cp .env.example .env
  echo "✓ Created .env file"
  echo ""
  echo "⚠️  IMPORTANT: Edit .env and add your Xero credentials:"
  echo "   - XERO_CLIENT_ID"
  echo "   - XERO_CLIENT_SECRET"
  echo "   - SESSION_SECRET (generate a random string)"
  echo ""
else
  echo "✓ .env file already exists"
fi

# Check if node_modules exists
if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
  echo "✓ Dependencies installed"
else
  echo "✓ Dependencies already installed"
fi

echo ""
echo "Setup complete! Next steps:"
echo "1. Edit .env and add your Xero credentials"
echo "2. Run: npm run dev"
echo "3. Open http://localhost:3000 in your browser"
