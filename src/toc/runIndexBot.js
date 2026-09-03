/**
 * End-to-end IndexBot ToC pipeline.
 */

import {PluginCommAPI, PluginFileAPI, PluginNoteAPI} from 'sn-plugin-lib';
import {collectTitles} from './collectTitles';
import {ocrAllTitles, resolvePageSize} from './ocrTitle';
import {insertTableOfContents} from './insertToc';
import {normalizeLayout} from './layoutModes';
import {log, logError, startLogSession} from '../utils/debug';
import {toHostPageIndex} from '../utils/pageIndex';
import {ensureIndexPermissions} from '../utils/permissions';
import {clearErrorLog, writeErrorLog, writeLastRun} from '../utils/errorLog';

const TAG = 'Run';

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
 * @param {{ layout?: string, onStatus?: Function }} options
 */
export async function runIndexBot(options = {}) {
  const layout = normalizeLayout(options.layout);
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
  const fp = await withTimeout(
    PluginCommAPI.getCurrentFilePath(),
    5000,
    'getCurrentFilePath',
  );
  const notePath = fp?.result || fp;
  if (!notePath || typeof notePath !== 'string') {
    throw new Error('Could not get current note path. Open a NOTE file first.');
  }

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

  const pageSize = await resolvePageSize(notePath, currentPage);
  log(
    TAG,
    `path=${notePath} page=${currentPage} pages=${pageCount} size=${pageSize.width}x${pageSize.height} layout=${layout}`,
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

  let message = `Inserted ${result.inserted} heading${result.inserted === 1 ? '' : 's'}`;
  if (result.columns === 2) message += ' (2 columns)';
  if (result.omitted > 0) {
    message += `. ${result.omitted} omitted (page full)`;
  }

  status('done', message, {result});
  return {
    message,
    ...result,
    titleCount: titles.length,
    phase: lastPhase,
    layout,
  };
}

/**
 * @param {{ layout?: string, onStatus?: Function }} options
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
      onStatus: wrapStatus,
    });
    await clearErrorLog();
    await writeLastRun({
      layout: result.layout,
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
