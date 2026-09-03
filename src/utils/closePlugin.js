import {PluginManager} from 'sn-plugin-lib';
import {log} from './debug';

export function closePlugin() {
  log('App', 'Closing plugin view');
  PluginManager.closePluginView();
}
