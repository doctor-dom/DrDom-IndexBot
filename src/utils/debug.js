/**
 * Debug logger for on-device diagnostics.
 */

const MAX_ENTRIES = 300;
const entries = [];
let _listener = null;
let _sessionId = 0;

export function startLogSession(label) {
  _sessionId += 1;
  entries.length = 0;
  log('Session', `#${_sessionId} ${label}`);
  return _sessionId;
}

export function getSessionId() {
  return _sessionId;
}

let _debugServerUrl = '';
try {
  const cfg = require('../../config.local');
  _debugServerUrl = (cfg.default || cfg).debugServerUrl || '';
} catch {
  // optional local config
}

export function log(tag, message) {
  const time = new Date().toLocaleTimeString();
  const entry = `[${time}] ${tag}: ${message}`;
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
  if (_listener) _listener([...entries]);
}

export function logError(tag, err) {
  const msg = err instanceof Error ? err.message : String(err);
  log(tag, `ERROR ${msg}`);
}

export function getEntries() {
  return [...entries];
}

export function setListener(fn) {
  _listener = fn;
}

export async function exportLog() {
  const logText = entries.length ? entries.join('\n') : '(no log entries)';

  if (_debugServerUrl) {
    try {
      const resp = await fetch(_debugServerUrl, {
        method: 'POST',
        headers: {'Content-Type': 'text/plain'},
        body: logText,
      });
      if (resp.ok) return 'Log sent to dev server';
    } catch (err) {
      log('Export', `Dev server failed: ${err.message}`);
    }
  }
  return `${entries.length} entries (no dev server)`;
}
