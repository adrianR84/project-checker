// Drop all data tables (removes tables entirely — schema gone)
// --keep-data skips projects and repos tables
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const readline = require('readline');

const DB_PATH = path.join(__dirname, '..', 'data', 'project-checker.db');
const keepData = process.argv.includes('--keep-data');

const TABLES = ['alert_logs', 'check_logs', 'event_logs', 'token_prices_alerts', 'token_prices', 'twitter_posts'];
if (!keepData) TABLES.push('repos', 'projects');

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(resolve => {
    rl.question(`Drop tables:\n${TABLES.join('\n')}\n\nType "yes" to confirm: `, resolve);
  });
  rl.close();

  if (answer.trim().toLowerCase() !== 'yes') {
    console.log('\nAborted.');
    process.exit(0);
  }

  const db = new DatabaseSync(DB_PATH);
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    for (const t of TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`);
    db.exec('PRAGMA foreign_keys = ON');
  } finally {
    db.close();
  }
  console.log(`\nDropped: ${TABLES.join(', ')}`);
}

main().catch(err => { console.error(err); process.exit(1); });
