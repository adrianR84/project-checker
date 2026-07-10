// Better Auth instance — uses the same node:sqlite DB as the rest of the app
const { betterAuth } = require('better-auth');
const { getMigrations } = require('better-auth/db/migration');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'project-checker.db');

// ponytail: DatabaseSync is file-based and opens on construction; same instance reused across hot-reloads
const sqlite = new DatabaseSync(DB_PATH, { enableForeignKeyConstraints: true });

const auth = betterAuth({
  database: sqlite,
  baseURL: process.env.BETTER_AUTH_URL || 'http://localhost:3000',
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24,     // update session age every day
  },
});

// Run Better Auth schema migrations at startup (idempotent)
getMigrations({ database: sqlite, auth }).then(m => m.runMigrations()).catch(err => {
  console.error('[better-auth] migration error:', err.message);
});

module.exports = auth;
