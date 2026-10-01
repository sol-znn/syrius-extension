const webpack = require('webpack');
const path = require('path');
const fileSystem = require('fs-extra');
const env = require('./utils/env');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const { CleanWebpackPlugin } = require('clean-webpack-plugin');
const TerserPlugin = require('terser-webpack-plugin');

const ASSET_PATH = process.env.ASSET_PATH || '/';
const isProduction = (process.env.NODE_ENV || 'development') === 'production';

const alias = {
  // Pinned to this project's copies: these are polyfills for node built-ins,
  // and every bundle must get the same one whatever asked for it.
  'process/browser': require.resolve('process/browser.js'),
  'crypto-browserify': require.resolve('crypto-browserify'),
};

// Load secrets if they exist
const secretsPath = path.join(__dirname, 'secrets.' + env.NODE_ENV + '.js');
if (fileSystem.existsSync(secretsPath)) {
  alias['secrets'] = secretsPath;
}

// File extensions for assets
const fileExtensions = [
  'jpg', 'jpeg', 'png', 'gif', 'eot', 'otf', 'svg', 'ttf', 'woff', 'woff2'
];

module.exports = {
  mode: process.env.NODE_ENV || 'development',
  target: 'web',

  // Only what the manifest actually loads. The boilerplate's newtab, options,
  // panel and devtools pages were never declared there and never reachable —
  // they only cost build time and a second copy of the vendor chunk.
  entry: {
    popup: path.join(__dirname, './src/sections/Popup/index.jsx'),
    background: path.join(__dirname, './src/sections/Background/index.js'),
    contentScript: path.join(__dirname, './src/sections/Content/index.js'),
    inpage: path.join(__dirname, './src/sections/Inpage/index.js'),
  },

  output: {
    filename: '[name].bundle.js',
    path: path.resolve(__dirname, 'build'),
    clean: true,
    publicPath: ASSET_PATH,
  },

  // A published extension ships whatever is in `build`, and a source map of a
  // 7 MiB bundle is bigger than the bundle. Development keeps them.
  devtool: isProduction ? false : 'cheap-module-source-map',

  optimization: {
    minimizer: [
      new TerserPlugin({
        terserOptions: {
          // This wallet logs addresses, balances and whole account blocks at
          // every step. None of that belongs in a user's console.
          compress: { drop_console: ['log', 'debug', 'info'] },
        },
      }),
    ],
    splitChunks: {
      // The content script and the injected page script run on every site the
      // user visits, so they must stay standalone — a shared vendor chunk they
      // cannot load would break them. Only the popup gets one.
      chunks: (chunk) => chunk.name === 'popup',
      cacheGroups: {
        vendor: {
          // A path test rather than a regex: this repo builds on Windows,
          // where module paths are separated by backslashes.
          test: (module) => (module.resource || '').includes('node_modules'),
          name: 'vendors',
          chunks: (chunk) => chunk.name === 'popup',
        }
      }
    },
  },

  module: {
    noParse: /\.wasm$/,
    rules: [
      {
        test: /\.(css|scss)$/,
        use: [
          'style-loader',
          'css-loader',
          {
            loader: 'sass-loader',
            options: {
              sourceMap: !isProduction,
              sassOptions: {
                quietDeps: true,
                silenceDeprecations: ['legacy-js-api', 'color-functions', 'global-builtin'],
              },
            },
          },
        ],
      },
      {
        test: new RegExp('.(' + fileExtensions.join('|') + ')$'),
        type: 'asset/resource',
        exclude: /node_modules/,
      },
      {
        test: /\.html$/,
        loader: 'html-loader',
        exclude: /node_modules/,
      },
      {
        test: /\.(ts|tsx)$/,
        loader: 'ts-loader',
        exclude: /node_modules/
      },
      {
        test: /\.(js|jsx)$/,
        use: ['babel-loader'],
        exclude: /node_modules/,
      },
      {
        test: /\.wasm$/,
        loader: 'base64-loader',
        type: 'javascript/auto',
      },
    ],
  },

  resolve: {
    // `znn-ts-sdk` is a `file:` dependency, so npm links it rather than copying
    // it, and the linked repo has no node_modules of its own. Following the
    // symlink to its real path makes webpack resolve that package's imports
    // from outside this project entirely, where `process/browser` and
    // `crypto-browserify` do not exist. Keeping the linked path means its
    // dependencies resolve here, like every other package's.
    symlinks: false,

    alias: alias,
    extensions: fileExtensions
      .map(extension => '.' + extension)
      .concat(['.js', '.jsx', '.ts', '.tsx', '.css']),
    fallback: {
      "fs": false,
      "stream": require.resolve("stream-browserify"),
      "buffer": require.resolve("buffer"),
      "crypto": require.resolve("crypto-browserify"),
      "path": require.resolve("path-browserify"),
      "constants": require.resolve("constants-browserify"),
      "assert": require.resolve("assert/"),
      "vm": require.resolve("vm-browserify"),
      "tls": false,
      "net": false,
      "zlib": false,
      "http": false,
      "https": false,
      "events": false
    },
  },

  plugins: [
    new CleanWebpackPlugin({ verbose: false }),

    new webpack.ProgressPlugin(),

    new webpack.EnvironmentPlugin(['NODE_ENV']),

    // Only the dev harness (utils/dev-harness.js) turns this on, for the build
    // it drives itself. Every other build compiles it to 'false', which leaves
    // the auto-unlock in src/services/utils/devWallet.js as dead code.
    new webpack.EnvironmentPlugin({ SYRIUS_DEV_WALLET: 'false' }),

    new CopyWebpackPlugin({
      patterns: [
        { from: path.join(__dirname, 'utils/approval-pow-worker.js'), to: 'approval-pow-worker.js', transform: () => require('./utils/approval-pow-worker')() },
        {
          from: './src/manifest.json',
          to: path.resolve(__dirname, 'build'),
          force: true,
          transform: (content) => {
            return Buffer.from(
              JSON.stringify({
                description: process.env.npm_package_description,
                version: process.env.npm_package_version,
                ...JSON.parse(content.toString()),
              }, null, 2)
            );
          },
        },
        {
          from: './src/assets/img/icon-128.png',
          to: path.resolve(__dirname, 'build'),
          force: true,
        },
        {
          from: './src/assets/img/icon-34.png',
          to: path.resolve(__dirname, 'build'),
          force: true,
        },
      ],
    }),

    new HtmlWebpackPlugin({
      template: './src/sections/Popup/index.html',
      filename: 'popup.html',
      chunks: ['vendors', 'popup'],
      cache: false,
    }),

    new webpack.ProvidePlugin({
      Buffer: ['buffer', 'Buffer'],
      process: 'process/browser',
    }),
  ],

  infrastructureLogging: {
    level: 'info',
  },

  experiments: {
    asyncWebAssembly: true,
    syncWebAssembly: true
  }
};
