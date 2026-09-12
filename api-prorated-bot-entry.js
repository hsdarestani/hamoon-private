'use strict';
const cleanup = require('./api-prorated-preload').installForBot();
try {
  module.exports = require('./index');
} finally {
  cleanup();
}
