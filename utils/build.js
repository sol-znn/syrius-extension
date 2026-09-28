// Do this as the first thing so that any code reading it knows the right env.
process.env.BABEL_ENV = 'production';
process.env.NODE_ENV = 'production';
process.env.ASSET_PATH = '/';

var webpack = require('webpack'),
  config = require('../webpack.config');

delete config.chromeExtensionBoilerplate;

config.mode = 'production';

console.log('Starting webpack build...');

webpack(config, function (err, stats) {
  if (err) {
    console.error('Webpack error:', err);
    throw err;
  }
  
  if (stats.hasErrors()) {
    console.error('Build errors:');
    console.error(stats.toString({ colors: true }));
    process.exitCode = 1;
    return;
  }
  
  if (stats.hasWarnings()) {
    console.warn('Build warnings:');
    console.warn(stats.toString({ colors: true }));
  }
  
  console.log('Build completed successfully!');
  console.log(stats.toString({ colors: true, chunks: false }));
});