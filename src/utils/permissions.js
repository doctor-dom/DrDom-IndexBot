/**
 * PluginHost permission gate (FILE:READ / FILE:WRITE).
 */

import {PluginManager} from 'sn-plugin-lib';
import {log} from './debug';

export const PERM_FILE_READ = 'plugin.permission.FILE:READ';
export const PERM_FILE_WRITE = 'plugin.permission.FILE:WRITE';

const REQUIRED = [
  {
    name: PERM_FILE_READ,
    desc: 'Read titles and handwriting in the current note to build a table of contents.',
  },
  {
    name: PERM_FILE_WRITE,
    desc: 'Insert the table of contents text and jump links on the current page.',
  },
];

function unwrapStatus(res) {
  if (typeof res === 'number' && Number.isFinite(res)) return res;
  if (res == null) return 0;
  if (typeof res.result === 'number') return res.result;
  if (typeof res.result === 'string' && res.result !== '') {
    const n = Number(res.result);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function isGranted(status) {
  return status === 1 || status === 2;
}

async function callHasPermission(permission) {
  if (typeof PluginManager.hasPermission !== 'function') {
    log('Perm', 'hasPermission not on this host; skipping check');
    return 1;
  }
  return unwrapStatus(await PluginManager.hasPermission(permission));
}

async function callRequestPermission(permission, desc) {
  if (typeof PluginManager.requestPermission !== 'function') {
    log('Perm', 'requestPermission not on this host; skipping request');
    return 1;
  }
  return unwrapStatus(await PluginManager.requestPermission(permission, desc));
}

export async function ensureIndexPermissions() {
  for (const {name, desc} of REQUIRED) {
    let status = await callHasPermission(name);
    log('Perm', `${name} hasPermission=${status}`);
    if (isGranted(status)) continue;

    status = await callRequestPermission(name, desc);
    log('Perm', `${name} requestPermission=${status}`);
    if (!isGranted(status)) {
      throw new Error(
        `Permission required: ${name}. Choose Allow and tap IndexBot again.`,
      );
    }
  }
}
