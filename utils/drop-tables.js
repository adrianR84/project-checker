// Drop all data tables (removes tables entirely — schema gone)
// SKIP_DATA=1 skip projects and repos tables
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const readline = require('node:readline');

const DB_PATH = path.join(__dirname, '..', 'data', 'project-checker.db');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const answer = await new Promise(resolve => rl.question('Drop ALL data tables? Type "yes" to confirm: ', resolve));
rl.close();
if (answer.trim().toLowerCase() !== 'yes') { console.log('Aborted.'); process.exit(0); }

const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA foreign_keys = OFF');
db.exec('DROP TABLE IF EXISTS alert_logs');
db.exec('DROP TABLE IF EXISTS check_logs');
db.exec('DROP TABLE IF EXISTS event_logs');
db.exec('DROP TABLE IF EXISTS token_prices_alerts');
db.exec('DROP TABLE IF EXISTS token_prices');
db.exec('DROP TABLE IF EXISTS twitter_posts');
if (!process.env.SKIP_DATA) {
  db.exec('DROP TABLE IF EXISTS repos');
  db.exec('DROP TABLE IF EXISTS projects');
}
db.exec('PRAGMA foreign_keys = ON');

console.log('All data tables dropped.');
db.close();
