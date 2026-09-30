#!/usr/bin/env node
// Create (or promote) an admin account:
//   npm run create-admin -- admin@example.com 'a-strong-password' "Your Name"
import { loadDotEnv, readConfig } from '../server/config.js';
import { openDb } from '../server/db.js';
import { hashPassword } from '../server/auth.js';

loadDotEnv();
const [email, password, name = 'QodeX Admin'] = process.argv.slice(2);
if (!email || !password || password.length < 8) {
  console.error('usage: npm run create-admin -- <email> <password (8+ chars)> [name]');
  process.exit(1);
}
const config = readConfig();
const db = openDb(config.dataDir);
const hash = await hashPassword(password);
const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
if (existing) {
  db.prepare("UPDATE users SET role = 'admin', password_hash = ?, name = ? WHERE id = ?").run(hash, name, existing.id);
  console.log(`updated ${email} → admin (password reset)`);
} else {
  db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, 'admin')").run(email.toLowerCase(), name, hash);
  console.log(`created admin ${email}`);
}
db.close();
