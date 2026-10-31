const fs = require('fs');
const path = require('path');

const STORAGE_DIR = path.join(__dirname, '..', 'storage');

function ensureStorageDir() {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }
}

function readJson(fileName, fallbackValue) {
  ensureStorageDir();
  const filePath = path.join(STORAGE_DIR, fileName);
  if (!fs.existsSync(filePath)) return fallbackValue;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return fallbackValue;
    return JSON.parse(raw);
  } catch {
    return fallbackValue;
  }
}

function writeJson(fileName, value) {
  ensureStorageDir();
  const filePath = path.join(STORAGE_DIR, fileName);
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

module.exports = {
  STORAGE_DIR,
  readJson,
  writeJson,
};
