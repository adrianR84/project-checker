#!/bin/bash
# deploy.sh — scp + pm2 restart

set -e

SKIP_INSTALL="${SKIP_INSTALL:-1}"  # 1=skip install (faster), 0=run pnpm install
SKIP_DATA="${SKIP_DATA:-1}"        # 1=skip data folder, 0=include data
SKIP_ENV="${SKIP_ENV:-1}"          # 1=skip .env file, 0=include .env

HOST="adi-vps"
PROJECT_NAME=$(basename "$PWD")
APP_PATH="~/work/$PROJECT_NAME"
APP_NAME="${DEPLOY_PM2:-project-checker}"
SERVER_PORT=$(grep '^PORT=' .env 2>/dev/null | cut -d= -f2 || echo "3002")

echo "→ Deploying $PROJECT_NAME to $HOST:$APP_PATH"

# Create remote folder if it doesn't exist
ssh "$HOST" "mkdir -p $APP_PATH"

# Build tar exclude args
TAR_EXCLUDES=(
  --exclude='node_modules'
  --exclude='.git'
  --exclude='.devlogger'
  --exclude='logs'
  --exclude='.DS_Store'
  --exclude='*.log'
  --exclude='utils/drop-tables.js'
)
[[ "$SKIP_DATA" == "1" ]] && TAR_EXCLUDES+=( --exclude='data' )
[[ "$SKIP_ENV" == "1" ]] && TAR_EXCLUDES+=( --exclude='.env' )

# Upload via tar/pipes
echo "→ Uploading to $HOST:$APP_PATH"
tar -C "$PWD" -cf - "${TAR_EXCLUDES[@]}" . | ssh "$HOST" "cd $APP_PATH && tar -xf -"

# Install deps and (re)start pm2
PM2_CMD="cd $APP_PATH && PORT=$SERVER_PORT pm2 start index.js --name '$APP_NAME' --update-env"
if [[ "$SKIP_INSTALL" != "1" ]]; then
  INSTALL_CMD=$(ssh "$HOST" "which pnpm > /dev/null 2>&1 && echo pnpm || echo npm")
  PM2_CMD="cd $APP_PATH && $INSTALL_CMD install && $PM2_CMD"
fi

# Stop pm2 process and kill anything on the app port
echo "→ (Re)starting pm2"
ssh "$HOST" "pm2 stop '$APP_NAME' 2>/dev/null; fuser -k $SERVER_PORT/tcp 2>/dev/null; sleep 1; $PM2_CMD"

# Wait for pm2 to settle
sleep 2

# Check status (grep-based, no jq needed)
STATUS=$(ssh "$HOST" "pm2 info '$APP_NAME'" 2>/dev/null | grep 'status' | head -1 | awk '{print $NF}')
if [[ "$STATUS" == "online" ]]; then
  echo "✓ $APP_NAME is online"
else
  echo "✗ $APP_NAME status: $STATUS"
  exit 1
fi
