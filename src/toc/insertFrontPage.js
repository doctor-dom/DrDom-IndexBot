/**
 * Insert a blank page 1 for the ToC.
 *
 * insertNotePage needs a real template file. Stored page names such as
 * style_8mm_ruled_line_a5x2 return error 802. Prefer getNoteSystemTemplates()
 * names and vUri paths, then a generated PNG of the current page background.
 * If every insert fails, return inserted=false so the ToC can still be written.
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

function unwrapTemplates(res) {
  if (Array.isArray(res)) return res;
  if (Array.isArray(res?.result)) return res.result;
  if (Array.isArray(res?.result?.templates)) return res.result.templates;
  if (Array.isArray(res?.templates)) return res.templates;
  return [];
}

function unwrapInfo(res) {
  if (res?.result && typeof res.result === 'object') return res.result;
  if (res && typeof res === 'object' && res.name) return res;
  return {};
}

function fileishUri(uri) {
  const s = String(uri || '').trim();
  if (!s) return '';
  return s.replace(/^file:\/\//i, '');
}

function stripDeviceSuffix(name) {
  return String(name || '').replace(/_(a[56]x2?|n[56])$/i, '');
}

function templateTokens(tpl) {
  const name = String(tpl?.name || '').trim();
  const vUri = fileishUri(tpl?.vUri);
  const hUri = fileishUri(tpl?.hUri);
  return [name, vUri, hUri].filter(Boolean);
}

function matchSystemTemplate(wanted, templates) {
  if (!wanted || !templates.length) return null;
  const stripped = stripDeviceSuffix(wanted);
  const lower = wanted.toLowerCase();
  const strippedLower = stripped.toLowerCase();

  const scored = templates
    .map(t => {
      const name = String(t?.name || '').toLowerCase();
      if (!name) return {t, score: 0};
      if (name === lower) return {t, score: 100};
      if (name === strippedLower) return {t, score: 90};
      if (name.startsWith(`${strippedLower}_`) || strippedLower.startsWith(name)) {
        return {t, score: 70};
      }
      if (name.includes(strippedLower) || strippedLower.includes(name)) {
        return {t, score: 40};
      }
      return {t, score: 0};
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.t || null;
}

function pickBlankOrFirst(templates) {
  const prefs = ['style_blank', 'style_white', 'blank'];
  for (const p of prefs) {
    const exact = templates.find(
      t => String(t?.name || '').toLowerCase() === p,
    );
    if (exact) return exact;
  }
  const blankish = templates.find(t => /blank|white/i.test(String(t?.name || '')));
  return blankish || templates[0] || null;
}

async function listSystemTemplates() {
  if (typeof PluginCommAPI.getNoteSystemTemplates !== 'function') {
    log(TAG, 'resolver v2 getNoteSystemTemplates unavailable');
    return [];
  }
  try {
    const raw = await withTimeout(
      PluginCommAPI.getNoteSystemTemplates(),
      8000,
      'getNoteSystemTemplates',
    );
    const list = unwrapTemplates(raw);
    log(
      TAG,
      `resolver v2 system templates count=${list.length} sample=${JSON.stringify(
        list.slice(0, 3).map(t => ({
          name: t?.name,
          vUri: t?.vUri,
        })),
      )}`,
    );
    return list;
  } catch (e) {
    log(TAG, `getNoteSystemTemplates failed: ${e.message}`);
    return [];
  }
}

async function readPageTemplate(notePath) {
  if (typeof PluginFileAPI.getNotePageTemplate !== 'function') {
    return {name: '', md5: '0'};
  }
  const filePage = 0;
  try {
    const res = await withTimeout(
      PluginFileAPI.getNotePageTemplate(notePath, filePage),
      8000,
      `getNotePageTemplate(file=${filePage})`,
    );
    const info = unwrapInfo(res);
    const name = String(info?.name || '').trim();
    if (name) {
      log(TAG, `page template file=${filePage} name=${name} md5=${info?.md5}`);
      return {name, md5: String(info?.md5 ?? '0')};
    }
  } catch (e) {
    log(TAG, `getNotePageTemplate(file=${filePage}) failed: ${e.message}`);
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

async function generateTemplatePng(notePath) {
  if (typeof PluginFileAPI.generateNoteTemplatePng !== 'function') {
    return null;
  }
  const pngPath = await resolvePngPath();
  const filePage = 0;
  try {
    const res = await withTimeout(
      PluginFileAPI.generateNoteTemplatePng(notePath, filePage, pngPath),
      15000,
      `generateNoteTemplatePng(file=${filePage})`,
    );
    const ok = res?.success !== false && res?.result !== false;
    log(TAG, `generateNoteTemplatePng file=${filePage} ok=${ok} path=${pngPath}`);
    if (!ok) return null;

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
    log(TAG, `generateNoteTemplatePng(file=${filePage}) failed: ${e.message}`);
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
 * Insert a new first page. Returns {pageCount, inserted}.
 * inserted=false means the caller should write the ToC on existing page 1.
 */
export async function insertFrontPage(notePath) {
  log(TAG, 'resolver v2 start');
  await PluginNoteAPI.saveCurrentNote();

  const systemTemplates = await listSystemTemplates();
  const pageTpl = await readPageTemplate(notePath);
  const matched = matchSystemTemplate(pageTpl.name, systemTemplates);
  const blank = pickBlankOrFirst(systemTemplates);

  const candidates = [];
  const seen = new Set();
  const push = value => {
    if (value && !seen.has(value)) {
      seen.add(value);
      candidates.push(value);
    }
  };

  for (const token of templateTokens(matched)) push(token);
  for (const token of templateTokens(blank)) push(token);
  for (const tpl of systemTemplates.slice(0, 8)) {
    for (const token of templateTokens(tpl)) push(token);
  }

  const png = await generateTemplatePng(notePath);
  push(png);

  log(
    TAG,
    `resolver v2 wanted=${pageTpl.name} matched=${matched?.name || ''} blank=${blank?.name || ''} n=${candidates.length}`,
  );

  let inserted = false;
  for (const template of candidates) {
    try {
      if (await tryInsertNotePage(notePath, 0, template)) {
        inserted = true;
        log(TAG, `resolver v2 inserted with template=${template}`);
        break;
      }
    } catch (e) {
      log(TAG, `insertNotePage threw: ${e.message}`);
    }
  }

  if (!inserted) {
    log(TAG, 'resolver v2 insert failed — ToC will use existing page 1');
    let pageCount = 1;
    try {
      const totalRes = await withTimeout(
        PluginFileAPI.getNoteTotalPageNum(notePath),
        8000,
        'getNoteTotalPageNum',
      );
      pageCount = toHostPageIndex(totalRes?.result ?? totalRes ?? 1);
    } catch {
      // keep default
    }
    return {pageCount, inserted: false};
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
