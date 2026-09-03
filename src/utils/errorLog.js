/**
 * On-device run logs for IndexBot.
 * Error: /storage/emulated/0/MyStyle/IndexBot/indexbot-error.log
 * Success: /storage/emulated/0/MyStyle/IndexBot/indexbot-last-run.txt
 */

import RNFS from 'react-native-fs';
import {getEntries, log} from './debug';

const TAG = 'RunLog';
const LOG_DIR = '/storage/emulated/0/MyStyle/IndexBot';
const ERROR_FILE = `${LOG_DIR}/indexbot-error.log`;
const LAST_RUN_FILE = `${LOG_DIR}/indexbot-last-run.txt`;

async function ensureDir() {
  const exists = await RNFS.exists(LOG_DIR);
  if (!exists) {
    await RNFS.mkdir(LOG_DIR);
  }
}

export async function writeErrorLog({phase, message}) {
  const stamp = new Date().toISOString();
  const dump = getEntries().join('\n') || '(no debug entries)';
  const body = [
    `IndexBot error log`,
    `time: ${stamp}`,
    `phase: ${phase || 'unknown'}`,
    `message: ${message || 'unknown'}`,
    ``,
    `--- debug ---`,
    dump,
    ``,
  ].join('\n');

  try {
    await ensureDir();
    await RNFS.writeFile(ERROR_FILE, body, 'utf8');
    log(TAG, `Wrote ${ERROR_FILE}`);
    return ERROR_FILE;
  } catch (e) {
    log(TAG, `Failed to write error log: ${e.message}`);
    return null;
  }
}

export async function writeLastRun({layout, mode, snapBack, message, inserted, titleCount}) {
  const stamp = new Date().toISOString();
  const line = `${stamp} ok mode=${mode || 'initial'} layout=${layout || 'compact'} snapBack=${snapBack ? 1 : 0} titles=${titleCount ?? 0} inserted=${inserted ?? 0} ${message || ''}\n`;

  try {
    await ensureDir();
    await RNFS.writeFile(LAST_RUN_FILE, line, 'utf8');
    log(TAG, `Wrote ${LAST_RUN_FILE}`);
    return LAST_RUN_FILE;
  } catch (e) {
    log(TAG, `Failed to write last-run log: ${e.message}`);
    return null;
  }
}

export async function clearErrorLog() {
  try {
    if (await RNFS.exists(ERROR_FILE)) {
      await RNFS.unlink(ERROR_FILE);
      log(TAG, `Cleared ${ERROR_FILE}`);
    }
  } catch (e) {
    log(TAG, `Failed to clear error log: ${e.message}`);
  }
}
