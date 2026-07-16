// Drop all data tables (removes tables entirely — schema gone)
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'project-checker.db');

const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA foreign_keys = OFF');
db.exec('DROP TABLE IF EXISTS alert_logs');
db.exec('DROP TABLE IF EXISTS check_logs');
db.exec('DROP TABLE IF EXISTS event_logs');
db.exec('DROP TABLE IF EXISTS token_prices_alerts');
db.exec('DROP TABLE IF EXISTS token_prices');
db.exec('DROP TABLE IF EXISTS twitter_posts');
db.exec('DROP TABLE IF EXISTS repos');
db.exec('DROP TABLE IF EXISTS projects');
db.exec('PRAGMA foreign_keys = ON');

console.log('All data tables dropped.');
db.close();
