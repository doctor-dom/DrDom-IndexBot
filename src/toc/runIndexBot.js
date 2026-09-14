/**

 * End-to-end IndexBot ToC pipeline.

 */



import {PluginCommAPI, PluginFileAPI, PluginNoteAPI} from 'sn-plugin-lib';

import {collectTitles, shiftTitlePages} from './collectTitles';

import {ocrAllTitles, resolvePageSize} from './ocrTitle';

import {insertTableOfContents} from './insertToc';

import {normalizeLayout} from './layoutModes';

import {
  checkInsertPage,
  assertInsertPageReady,
  detectExistingToc,
} from './checkInsertPage';

import {insertFrontPage} from './insertFrontPage';

import {syncSnapBackLinks} from './snapBackLinks';

import {log, logError, startLogSession} from '../utils/debug';

import {toHostPageIndex, toFilePageIndex, filePageToHost} from '../utils/pageIndex';

import {ensureIndexPermissions} from '../utils/permissions';

import {throwIfCancelled, shouldCancelFn} from '../utils/cancelToken';

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



function fireAndForget(promise, label) {

  promise.catch(e => log(TAG, `${label} failed: ${e.message}`));

}



/**

 * @param {{ layout?: string, snapBack?: boolean, cancelToken?: { cancelled?: boolean }, onStatus?: Function }} options

 */

export async function runIndexBot(options = {}) {

  const layout = normalizeLayout(options.layout);

  const snapBack = Boolean(options.snapBack);

  const cancelToken = options.cancelToken;

  const shouldCancel = shouldCancelFn(cancelToken);

  const onStatus = options.onStatus;

  let lastPhase = 'start';

  const status = (phase, message, extra = {}) => {

    lastPhase = phase;

    log(TAG, `${phase}: ${message}`);

    if (typeof onStatus === 'function') {

      onStatus({phase, message, ...extra});

    }

  };



  throwIfCancelled(cancelToken);

  status('permissions', 'Checking permissions…');

  await ensureIndexPermissions();



  throwIfCancelled(cancelToken);

  status('save', 'Saving note…');

  await PluginNoteAPI.saveCurrentNote();



  throwIfCancelled(cancelToken);

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



  let totalRes = await withTimeout(

    PluginFileAPI.getNoteTotalPageNum(notePath),

    8000,

    'getNoteTotalPageNum',

  );

  let pageCount = toHostPageIndex(

    totalRes?.result ?? totalRes ?? currentPage,

  );

  const tocRecheckEarly = await detectExistingToc(notePath, pageCount);
  const hasTocEarly = preflight.hasExistingToc || tocRecheckEarly.found;
  const tocHostPage = hasTocEarly
    ? toHostPageIndex(
        preflight.detectedTocHostPage ??
          tocRecheckEarly.hostPage ??
          (preflight.detectedTocFilePage != null
            ? filePageToHost(preflight.detectedTocFilePage)
            : tocRecheckEarly.filePage != null
              ? filePageToHost(tocRecheckEarly.filePage)
              : TOC_PAGE),
      )
    : TOC_PAGE;



  throwIfCancelled(cancelToken);

  status('collect', 'Finding titles…');

  let titles = await collectTitles(notePath, pageCount, {
    tocHostPage,
    excludeTocHostPage: hasTocEarly,
  });

  if (!titles.length) {

    throw new Error(

      'No Titles found. Mark headings with the Title tool, then try again.',

    );

  }

  status('collect', `Found ${titles.length} titles`, {

    current: 0,

    total: titles.length,

  });



  let insertedFrontPage = false;
  const hasToc = hasTocEarly;
  const effectiveRunMode = hasToc ? 'refresh' : runMode;

  if (runMode === 'initial' && !preflight.isBlank && !hasToc) {
    throwIfCancelled(cancelToken);

    status('insertPage', 'Inserting blank page 1…');

    const inserted = await insertFrontPage(notePath);

    if (inserted.inserted) {
      pageCount = inserted.pageCount;
      titles = shiftTitlePages(titles, 1);
      insertedFrontPage = true;
      log(TAG, `auto insertFront complete pages=${pageCount}`);
    } else {
      pageCount = inserted.pageCount || pageCount;
      log(TAG, 'auto insertFront skipped; writing ToC on existing page 1');
    }
  } else if (hasToc && runMode === 'initial') {
    log(
      TAG,
      `skip insertFront: ToC detected on host page ${tocHostPage} (file=${toFilePageIndex(tocHostPage)})`,
    );
  }

  const beforeTocFilter = titles.length;
  titles = titles.filter(t => toHostPageIndex(t.page) !== tocHostPage);
  const excludedOnTocPage = beforeTocFilter - titles.length;
  if (excludedOnTocPage > 0) {
    log(TAG, `excludedOnTocPage=${excludedOnTocPage} host=${tocHostPage}`);
  }
  if (!titles.length) {
    throw new Error(
      'No Titles found. Mark headings with the Title tool, then try again.',
    );
  }



  const pageSize = await resolvePageSize(notePath, tocHostPage);

  log(

    TAG,

    `path=${notePath} page=${currentPage} tocHost=${tocHostPage} mode=${effectiveRunMode} pages=${pageCount} layout=${layout} snapBack=${snapBack} insertedFront=${insertedFrontPage}`,

  );



  throwIfCancelled(cancelToken);

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

    shouldCancel,

    currentPage,

  );



  throwIfCancelled(cancelToken);

  status('insert', 'Writing table of contents…');

  const result = await insertTableOfContents({

    notePath,

    tocPage: tocHostPage,

    pageSize,

    headings: recognized,

    layout,

    onProgress: (current, total) => {

      status('insert', `Writing row ${current}/${total}…`, {current, total});

    },

  });



  if (!result.inserted) {

    const err = new Error('No headings were inserted (page full or empty).');

    err.phase = lastPhase;

    throw err;

  }



  throwIfCancelled(cancelToken);

  status(

    'snapback',

    snapBack ? 'Adding snap-back links…' : 'Cleaning snap-back links…',

  );

  const snapResult = await syncSnapBackLinks({

    notePath,

    tocPage: tocHostPage,

    headings: recognized,

    pageSize,

    enabled: snapBack,

    onProgress: (current, total) => {

      status('snapback', `Updating snap-back ${current}/${total}…`, {

        current,

        total,

      });

    },

  });



  let message = `Inserted ${result.inserted} heading${result.inserted === 1 ? '' : 's'}`;

  if (result.columns === 2) message += ' (2 columns)';

  if (result.omitted > 0) {

    message += `. ${result.omitted} omitted (page full)`;

  }

  if (insertedFrontPage) {

    message += '. New page 1 added for ToC';

  }

  if (snapBack && snapResult.inserted > 0) {

    message += `. Snap-back on ${snapResult.inserted} page${snapResult.inserted === 1 ? '' : 's'}`;

  }

  if (snapBack && snapResult.failed > 0) {

    message += `. Snap-back failed on ${snapResult.failed} page${snapResult.failed === 1 ? '' : 's'}`;

  }

  if (!snapBack && snapResult.removed > 0) {

    message += `. Removed ${snapResult.removed} snap-back link${snapResult.removed === 1 ? '' : 's'}`;

  }



  status('done', message, {result, snapResult});

  await PluginNoteAPI.saveCurrentNote();

  fireAndForget(
    PluginCommAPI.reloadFile().catch(e => log(TAG, `reloadFile: ${e.message}`)),
    'reloadFile',
  );

  return {

    message,

    ...result,

    titleCount: titles.length,

    phase: lastPhase,

    layout,

    mode: effectiveRunMode,

    snapBack,

    insertedFrontPage,

    snapBackPages: snapResult.inserted,

    snapBackFailed: snapResult.failed,

    snapBackRemoved: snapResult.removed,

    tocHostPage,

    tocLinks: result.tocLinks ?? result.inserted,

  };

}



/**

 * @param {{ layout?: string, snapBack?: boolean, cancelToken?: { cancelled?: boolean }, onStatus?: Function }} options

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

      cancelToken: options.cancelToken,

      onStatus: wrapStatus,

    });

    fireAndForget(clearErrorLog(), 'clearErrorLog');

    fireAndForget(

      writeLastRun({

        layout: result.layout,

        mode: result.mode,

        snapBack: result.snapBack,

        insertedFrontPage: result.insertedFrontPage,

        message: result.message,

        inserted: result.inserted,

        tocLinks: result.tocLinks,

        titleCount: result.titleCount,

        snapIn: result.snapBackPages,

        snapFail: result.snapBackFailed,

        tocHostPage: result.tocHostPage,

      }),

      'writeLastRun',

    );

    return {ok: true, ...result};

  } catch (err) {

    if (err?.code === 'CANCELLED') {

      log(TAG, 'Run cancelled by user');

      return {ok: false, cancelled: true, message: 'Cancelled', phase: lastPhase};

    }

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


