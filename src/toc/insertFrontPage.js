/**
 * Insert a blank page 1 for the ToC.
 *
 * insertNotePage requires a template that resolves to a real file. Page metadata
 * names such as style_8mm_ruled_line_a5x2 often do not — error 802.
 * Resolve against getNoteSystemTemplates(), then fall back to a PNG of page 1's
 * background, then a blank/first system template.
 */

import {
  FileUtils,
  PluginCommAPI,
  PluginFileAPI,
  PluginManager,
  PluginNoteAPI,
} from 'sn-plugin-lib';
import RNFS from 'react-native-fs';
import {log} from '../utils/debug';
import {toHostPageIndex} from '../utils/pageIndex';

const TAG = 'InsertFront';
const FALLBACK_DIR = '/storage/emulated/0/MyStyle/IndexBot';
const PNG_NAME = 'front-template.png';

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      val => {
        clearTimeout(timer);
        resolve(val);
      },
      err => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function formatApiError(res) {
  const err = res?.error;
  if (!err) return JSON.stringify(res);
  if (typeof err === 'string') return err;
  const code = err.code ?? err.errorCode ?? '?';
  const msg = err.message ?? err.msg ?? JSON.stringify(err);
  return `code=${code} message=${msg}`;
}

function unwrapList(res) {
  if (Array.isArray(res)) return res;
  if (Array.isArray(res?.result)) return res.result;
  return [];
}

function unwrapInfo(res) {
  if (res?.result && typeof res.result === 'object') return res.result;
  if (res && typeof res === 'object' && res.name) return res;
  return {};
}

function stripDeviceSuffix(name) {
  return String(name || '').replace(/_(a[56]x2?|n[56])$/i, '');
}

function matchSystemTemplate(wanted, names) {
  if (!wanted || !names.length) return null;
  if (names.includes(wanted)) return wanted;

  const stripped = stripDeviceSuffix(wanted);
  if (stripped && names.includes(stripped)) return stripped;

  const lower = wanted.toLowerCase();
  const strippedLower = stripped.toLowerCase();
  const fuzzy = names.find(n => {
    const nl = n.toLowerCase();
    return (
      nl === strippedLower ||
      nl.startsWith(`${strippedLower}_`) ||
      strippedLower.startsWith(nl) ||
      nl.includes(lower) ||
      lower.includes(nl)
    );
  });
  return fuzzy || null;
}

function pickBlankOrFirst(names) {
  const prefs = ['style_blank', 'style_white', 'blank'];
  for (const p of prefs) {
    const exact = names.find(n => n.toLowerCase() === p);
    if (exact) return exact;
  }
  const blankish = names.find(n => /blank|white/i.test(n));
  if (blankish) return blankish;
  return names[0] || null;
}

async function listSystemTemplates() {
  if (typeof PluginCommAPI.getNoteSystemTemplates !== 'function') {
    log(TAG, 'getNoteSystemTemplates unavailable');
    return [];
  }
  try {
    const raw = await withTimeout(
      PluginCommAPI.getNoteSystemTemplates(),
      8000,
      'getNoteSystemTemplates',
    );
    const list = unwrapList(raw);
    const names = list.map(t => t?.name).filter(Boolean);
    log(TAG, `system templates (${names.length}): ${names.slice(0, 12).join(',')}`);
    return names;
  } catch (e) {
    log(TAG, `getNoteSystemTemplates failed: ${e.message}`);
    return [];
  }
}

async function readPageTemplate(notePath, hostPage) {
  if (typeof PluginFileAPI.getNotePageTemplate !== 'function') {
    return {name: '', md5: '0'};
  }
  const indices = [hostPage];
  if (hostPage >= 1) indices.push(hostPage - 1);

  for (const idx of indices) {
    try {
      const res = await withTimeout(
        PluginFileAPI.getNotePageTemplate(notePath, idx),
        8000,
        `getNotePageTemplate(${idx})`,
      );
      const info = unwrapInfo(res);
      const name = String(info?.name || '').trim();
      if (name) {
        log(TAG, `page template idx=${idx} name=${name} md5=${info?.md5}`);
        return {name, md5: String(info?.md5 ?? '0')};
      }
    } catch (e) {
      log(TAG, `getNotePageTemplate(${idx}) failed: ${e.message}`);
    }
  }
  return {name: '', md5: '0'};
}

async function resolvePngPath() {
  let dir = FALLBACK_DIR;
  try {
    if (typeof PluginManager.getPluginDirPath === 'function') {
      const p = await withTimeout(
        PluginManager.getPluginDirPath(),
        3000,
        'getPluginDirPath',
      );
      if (p && typeof p === 'string') dir = p;
    }
  } catch (e) {
    log(TAG, `getPluginDirPath failed: ${e.message}`);
  }

  try {
    const exists = await RNFS.exists(dir);
    if (!exists) await RNFS.mkdir(dir);
  } catch (e) {
    log(TAG, `mkdir ${dir} failed: ${e.message}`);
  }

  return `${dir.replace(/\/$/, '')}/${PNG_NAME}`;
}

async function generateTemplatePng(notePath, hostPage) {
  if (typeof PluginFileAPI.generateNoteTemplatePng !== 'function') {
    return null;
  }
  const pngPath = await resolvePngPath();
  const indices = [hostPage];
  if (hostPage >= 1) indices.push(hostPage - 1);

  for (const idx of indices) {
    try {
      const res = await withTimeout(
        PluginFileAPI.generateNoteTemplatePng(notePath, idx, pngPath),
        15000,
        `generateNoteTemplatePng(${idx})`,
      );
      const ok = res?.success !== false && res?.result !== false;
      log(TAG, `generateNoteTemplatePng idx=${idx} ok=${ok} path=${pngPath}`);
      if (!ok) continue;

      let exists = false;
      try {
        exists = await RNFS.exists(pngPath);
      } catch {
        exists = false;
      }
      if (!exists && typeof FileUtils?.exists === 'function') {
        exists = await FileUtils.exists(pngPath);
      }
      if (exists) return pngPath;
      log(TAG, `PNG missing after generate: ${pngPath}`);
    } catch (e) {
      log(TAG, `generateNoteTemplatePng(${idx}) failed: ${e.message}`);
    }
  }
  return null;
}

async function tryInsertNotePage(notePath, page, template) {
  log(TAG, `insertNotePage template=${template} page=${page}`);
  const res = await withTimeout(
    PluginFileAPI.insertNotePage({notePath, page, template}),
    15000,
    `insertNotePage(${page})`,
  );
  const ok = res?.success !== false && res?.result !== false;
  if (!ok) {
    log(TAG, `insertNotePage page=${page} failed (${formatApiError(res)})`);
  }
  return ok;
}

/**
 * Insert a new first page. Returns updated pageCount.
 */
export async function insertFrontPage(notePath) {
  await PluginNoteAPI.saveCurrentNote();

  const systemNames = await listSystemTemplates();
  const pageTpl = await readPageTemplate(notePath, 1);
  const matched = matchSystemTemplate(pageTpl.name, systemNames);
  const blank = pickBlankOrFirst(systemNames);

  const candidates = [];
  const seen = new Set();
  const push = value => {
    if (value && !seen.has(value)) {
      seen.add(value);
      candidates.push(value);
    }
  };

  push(matched);
  if (pageTpl.md5 && pageTpl.md5 !== '0') {
    const png = await generateTemplatePng(notePath, 1);
    push(png);
  }
  push(blank);
  if (!pageTpl.md5 || pageTpl.md5 === '0') {
    const png = await generateTemplatePng(notePath, 1);
    push(png);
  }
  push(pageTpl.name);

  log(
    TAG,
    `candidates wanted=${pageTpl.name} matched=${matched || ''} blank=${blank || ''} n=${candidates.length}`,
  );

  if (candidates.length === 0) {
    throw new Error(
      'Could not insert a blank page: no usable note template on this device.',
    );
  }

  // insertNotePage page index starts at 0 (new page 1).
  let inserted = false;
  let lastError = '';
  for (const template of candidates) {
    try {
      if (await tryInsertNotePage(notePath, 0, template)) {
        inserted = true;
        log(TAG, `inserted front page with template=${template}`);
        break;
      }
    } catch (e) {
      lastError = e.message;
      log(TAG, `insertNotePage threw: ${e.message}`);
    }
  }

  if (!inserted) {
    throw new Error(
      lastError
        ? `Could not insert a blank page: ${lastError}`
        : 'Could not insert a blank page: Background template file does not exist!',
    );
  }

  await PluginNoteAPI.saveCurrentNote();
  try {
    await PluginCommAPI.reloadFile();
  } catch (e) {
    log(TAG, `reloadFile: ${e.message}`);
  }

  let pageCount = 1;
  try {
    const totalRes = await withTimeout(
      PluginFileAPI.getNoteTotalPageNum(notePath),
      8000,
      'getNoteTotalPageNum',
    );
    pageCount = toHostPageIndex(totalRes?.result ?? totalRes ?? 1);
  } catch (e) {
    log(TAG, `getNoteTotalPageNum after insert: ${e.message}`);
  }

  return {pageCount, inserted: true};
}
