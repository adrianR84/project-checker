// Express entry point
require('dotenv/config');

// Sentry must be loaded before other modules to instrument them
const Sentry = require('@sentry/node');
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || 'development',
  integrations: [Sentry.captureConsoleIntegration()],
});


const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { toNodeHandler } = require('better-auth/node');
const auth = require('./services/auth');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
// When SKIP_AUTH=1, fake a valid session so the frontend SPA can init without login
if (process.env.SKIP_AUTH === '1') {
  app.all('/api/auth/get-session', (req, res) => {
    res.json({ user: { id: process.env.DEFAULT_USER_ID || '' } });
  });
} else {

  // Hide register endpoint — return 404 so it appears unavailable
  app.post('/api/auth/sign-up/email', (req, res) => res.status(404).end());
  
  app.all('/api/auth/*', toNodeHandler(auth));
}
app.use(express.json({ limit: '1mb' }));

// Telegram webhook — no session cookie, must be registered before session middleware
const telegramWebhook = require('./routes/telegram-webhook');
app.post('/telWHook2345721453', telegramWebhook);

// Routes — imported after db init so they can use the proxy
const projectsRouter = require('./routes/projects');
const checkLogsRouter = require('./routes/checkLogs');
const settingsRouter = require('./routes/settings');
const dashboardRouter = require('./routes/dashboard');
const apiRouter = require('./routes/api');

app.use('/api/v1', apiRouter);   // public bearer-token API — handles its own auth (mounted before session middleware)

// Session middleware — extracts userId from cookie and attaches to req
// All /api/* routes (except /api/auth/* and /api/v1/*) require authentication
const { fromNodeHeaders } = require('better-auth/node');
app.use('/api', async (req, res, next) => {
  if (req.path.startsWith('/auth')) return next(); // better-auth handles its own routes
  if (req.path.startsWith('/v1')) return next();  // /api/v1/* has its own auth
  // ponytail: dev bypass — use DEFAULT_USER_ID env var or fall back to first user in DB
  if (process.env.SKIP_AUTH === '1') {
    req.userId = process.env.DEFAULT_USER_ID || '';
    if (!req.userId) {
      const { DatabaseSync } = require('node:sqlite');
      const devDb = new DatabaseSync(require('path').join(__dirname, 'data', 'project-checker.db'));
      const row = devDb.prepare('SELECT user_id FROM projects LIMIT 1').get();
      req.userId = row ? row.user_id : '';
    }
    return next();
  }
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!session) return res.status(401).json({ error: 'Unauthorized' });
  req.userId = session.user.id;
  next();
});

app.use('/api/projects', projectsRouter);
app.use('/api/check-logs', checkLogsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/dashboard', dashboardRouter);

// Serve static public/ in production
const publicDir = path.join(__dirname, 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get(/^\/(?!api).*/, (req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });
}

async function start() {
  const db = require('./services/db');
  await db.init(); // db.init exists on the module, not the proxy

  // Purge old logs on every startup (catches missed runs while app was down)
  const scheduler = require('./services/scheduler');
  await scheduler.purgeCheckLogs();
  await scheduler.purgeEventLogs();
  await scheduler.purgeAlertLogs();

  // Initialize scheduler after DB is ready
  require('./services/scheduler').init();

  app.listen(PORT, () => {
    console.log(`[${new Date().toISOString()}] Project Checker server listening on port ${PORT}`);
  });
}

start().catch(err => {
  console.error(`[${new Date().toISOString()}] Failed to start server:`, err);
  process.exit(1);
});
