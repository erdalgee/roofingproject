#!/bin/bash
# Deploy to Railway

echo "Deploying Belgian Roofing Wholesalers API to Railway..."

# Check if railway CLI is installed
if ! command -v railway &> /dev/null; then
    echo "Installing Railway CLI..."
    npm install -g @railway/cli
fi

# Login
railway login

# Initialize project
railway init --name belgian-roofing-api

# Set environment variables
railway variables set API_KEY=demo-key
railway variables set ADMIN_KEY=admin-key-$(openssl rand -hex 8)

# Deploy
railway up

echo "Deployment complete!"
echo "Get your URL with: railway status"
