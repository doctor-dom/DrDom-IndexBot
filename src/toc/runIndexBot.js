/**
 * End-to-end IndexBot ToC pipeline.
 */

import {PluginCommAPI, PluginFileAPI, PluginNoteAPI} from 'sn-plugin-lib';
import {collectTitles} from './collectTitles';
import {ocrAllTitles, resolvePageSize} from './ocrTitle';
import {insertTableOfContents} from './insertToc';
import {normalizeLayout} from './layoutModes';
import {checkInsertPage, assertInsertPageReady} from './checkInsertPage';
import {syncSnapBackLinks} from './snapBackLinks';
import {log, logError, startLogSession} from '../utils/debug';
import {toHostPageIndex} from '../utils/pageIndex';
import {ensureIndexPermissions} from '../utils/permissions';
import {clearErrorLog, writeErrorLog, writeLastRun} from '../utils/errorLog';

const TAG = 'Run';
const TOC_PAGE = 1;

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

/**
 * @param {{ layout?: string, snapBack?: boolean, onStatus?: Function }} options
 */
export async function runIndexBot(options = {}) {
  const layout = normalizeLayout(options.layout);
  const snapBack = Boolean(options.snapBack);
  const onStatus = options.onStatus;
  let lastPhase = 'start';
  const status = (phase, message, extra = {}) => {
    lastPhase = phase;
    log(TAG, `${phase}: ${message}`);
    if (typeof onStatus === 'function') {
      onStatus({phase, message, ...extra});
    }
  };

  status('permissions', 'Checking permissions…');
  await ensureIndexPermissions();

  status('save', 'Saving note…');
  await PluginNoteAPI.saveCurrentNote();

  status('context', 'Reading note…');
  const preflight = await checkInsertPage();
  assertInsertPageReady(preflight);
  const notePath = preflight.notePath;
  const runMode = preflight.mode;

  const pn = await withTimeout(
    PluginCommAPI.getCurrentPageNum(),
    5000,
    'getCurrentPageNum',
  );
  const currentPage = toHostPageIndex(pn?.result ?? pn);

  const totalRes = await withTimeout(
    PluginFileAPI.getNoteTotalPageNum(notePath),
    8000,
    'getNoteTotalPageNum',
  );
  const pageCount = toHostPageIndex(
    totalRes?.result ?? totalRes ?? currentPage,
  );

  const pageSize = await resolvePageSize(notePath, TOC_PAGE);
  log(
    TAG,
    `path=${notePath} page=${currentPage} tocPage=${TOC_PAGE} mode=${runMode} pages=${pageCount} layout=${layout} snapBack=${snapBack}`,
  );

  status('collect', 'Finding titles…');
  const titles = await collectTitles(notePath, pageCount, currentPage);
  if (!titles.length) {
    throw new Error(
      'No Titles found. Mark headings with the Title tool, then try again.',
    );
  }
  status('collect', `Found ${titles.length} titles`, {
    current: 0,
    total: titles.length,
  });

  status('ocr', `Recognizing 0/${titles.length}…`, {
    current: 0,
    total: titles.length,
  });
  const recognized = await ocrAllTitles(
    titles,
    notePath,
    pageSize,
    (current, total, text) => {
      status('ocr', `Recognizing ${current}/${total}…`, {
        current,
        total,
        lastText: text,
      });
    },
  );

  status('insert', 'Writing table of contents…');
  const result = await insertTableOfContents({
    notePath,
    tocPage: TOC_PAGE,
    currentPage,
    pageSize,
    headings: recognized,
    layout,
  });

  if (!result.inserted) {
    const err = new Error('No headings were inserted (page full or empty).');
    err.phase = lastPhase;
    throw err;
  }

  status('snapback', snapBack ? 'Adding snap-back links…' : 'Cleaning snap-back links…');
  const snapResult = await syncSnapBackLinks({
    notePath,
    tocPage: TOC_PAGE,
    headings: recognized,
    pageSize,
    pageCount,
    enabled: snapBack,
  });

  let message = `Inserted ${result.inserted} heading${result.inserted === 1 ? '' : 's'}`;
  if (result.columns === 2) message += ' (2 columns)';
  if (result.omitted > 0) {
    message += `. ${result.omitted} omitted (page full)`;
  }
  if (snapBack && snapResult.inserted > 0) {
    message += `. Snap-back on ${snapResult.inserted} page${snapResult.inserted === 1 ? '' : 's'}`;
  }
  if (!snapBack && snapResult.removed > 0) {
    message += `. Removed ${snapResult.removed} snap-back link${snapResult.removed === 1 ? '' : 's'}`;
  }

  status('done', message, {result, snapResult});
  return {
    message,
    ...result,
    titleCount: titles.length,
    phase: lastPhase,
    layout,
    mode: runMode,
    snapBack,
    snapBackPages: snapResult.inserted,
    snapBackRemoved: snapResult.removed,
  };
}

/**
 * @param {{ layout?: string, snapBack?: boolean, onStatus?: Function }} options
 */
export async function runIndexBotSafe(options = {}) {
  const onStatus = options.onStatus;
  startLogSession('IndexBot');
  let lastPhase = 'start';
  const wrapStatus = status => {
    if (status?.phase) lastPhase = status.phase;
    if (typeof onStatus === 'function') onStatus(status);
  };

  try {
    const result = await runIndexBot({
      layout: options.layout,
      snapBack: options.snapBack,
      onStatus: wrapStatus,
    });
    await clearErrorLog();
    await writeLastRun({
      layout: result.layout,
      mode: result.mode,
      snapBack: result.snapBack,
      message: result.message,
      inserted: result.inserted,
      titleCount: result.titleCount,
    });
    return {ok: true, ...result};
  } catch (err) {
    logError(TAG, err);
    const message = err instanceof Error ? err.message : String(err);
    const phase = err?.phase || lastPhase;
    await writeErrorLog({phase, message});
    return {
      ok: false,
      message,
      phase,
    };
  }
}
