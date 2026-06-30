// Express entry point
require('dotenv/config');
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Routes — imported after db init so they can use the proxy
const projectsRouter = require('./routes/projects');
const checkLogsRouter = require('./routes/checkLogs');
const settingsRouter = require('./routes/settings');
const dashboardRouter = require('./routes/dashboard');

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
