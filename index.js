/**
 * IndexBot — Table of Contents from NOTE Titles
 *
 * Button 100 (toolbar, NOTE): Open style picker, generate ToC on current page
 *
 * @format
 */

import {AppRegistry, Image} from 'react-native';
import App from './App';
import {name as appName} from './app.json';
import {PluginManager} from 'sn-plugin-lib';

AppRegistry.registerComponent(appName, () => App);

PluginManager.init();

const icon = Image.resolveAssetSource(require('./assets/icon.png')).uri;

PluginManager.registerButton(1, ['NOTE'], {
  id: 100,
  name: 'IndexBot',
  icon,
  showType: 1,
});
