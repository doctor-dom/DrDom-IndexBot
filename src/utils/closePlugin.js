import {PluginManager} from 'sn-plugin-lib';
import {log} from './debug';

export async function closePlugin() {
  try {
    log('App', 'Closing plugin view');
    await PluginManager.closePluginView();
  } catch (e) {
    log('App', `closePluginView failed: ${e?.message || e}`);
  }
}
