// store.js — the "simplest JSON storage" the brief asked for.
// Three flat collections persisted to ./data/*.json. No DB, no ORM.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

function path(name) {
  return join(DATA_DIR, `${name}.json`);
}

function load(name, fallback) {
  const p = path(name);
  if (!existsSync(p)) return fallback;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function save(name, value) {
  writeFileSync(path(name), JSON.stringify(value, null, 2));
}

// In-memory mirror, flushed to disk on every write. Fine for a demo.
const db = {
  // chat log per channel: { sales: [...], operations: [...], tech: [...] }
  messages: load('messages', { sales: [], operations: [], tech: [] }),
  // requirement lifecycle records
  requirements: load('requirements', []),
};

export const CHANNELS = ['sales', 'operations', 'tech'];

export function addMessage(channel, msg) {
  if (!db.messages[channel]) db.messages[channel] = [];
  db.messages[channel].push(msg);
  save('messages', db.messages);
  return msg;
}

export function getMessages(channel) {
  return db.messages[channel] || [];
}

export function getAllMessages() {
  return db.messages;
}

export function addRequirement(req) {
  db.requirements.push(req);
  save('requirements', db.requirements);
  return req;
}

export function getRequirement(id) {
  return db.requirements.find((r) => r.id === id);
}

export function getRequirements() {
  return db.requirements;
}

export function updateRequirement(id, patch) {
  const r = getRequirement(id);
  if (!r) return null;
  Object.assign(r, patch, { updatedAt: Date.now() });
  save('requirements', db.requirements);
  return r;
}
