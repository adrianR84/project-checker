// node:sqlite — VACUUM to reclaim unused pages after deleting data
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'project-checker.db');

const db = new DatabaseSync(DB_PATH);

console.log(`Vacuuming ${DB_PATH}...`);
db.exec('VACUUM');
console.log('VACUUM complete.');

db.close();
