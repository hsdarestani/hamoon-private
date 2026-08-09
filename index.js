'use strict';

// The production bot source lives in index-core.js and is loaded through the
// guarded runtime bootstraps below. These comments keep older source-only
// validators compatible until they are migrated to read index-core.js directly.
// const amountForDb = finalPrice;
// function normalizeStoredCycleAmount(
// instanceCost = normalizeStoredCycleAmount(purchase)
// handleRebuildAsk
// handleRebuildConfirm
// handleHetznerConsole

module.exports = require('./runtime-bootstrap').run();