'use strict';

function count(source, needle) {
  return String(source).split(needle).length - 1;
}

function replaceOnce(source, needle, replacement, label) {
  const matches = count(source, needle);
  if (matches !== 1) {
    throw new Error(`[survey-bootstrap] ${label}: expected 1 match, found ${matches}`);
  }
  return source.replace(needle, replacement);
}

function applySurveyPatches(input) {
  let source = String(input || '');

  source = replaceOnce(
    source,
    "const additionalIpBilling = require('./services/hetzner-additional-ip-billing');",
    "const additionalIpBilling = require('./services/hetzner-additional-ip-billing');\nconst survey = require('./survey-service');",
    'survey import'
  );

  source = replaceOnce(
    source,
    "const state = {};\nconst adminState = { impersonating: null };",
    "const state = {};\nconst adminState = { impersonating: null };\nsurvey.configure({ bot, sendMessage, showMainMenu });\nsurvey.startBroadcast();",
    'survey runtime configuration'
  );

  source = replaceOnce(
    source,
    "    const text = msg.text || '';\n\n    if (text.startsWith('/')) {",
    "    const text = msg.text || '';\n\n    if (!isImpersonating && await survey.handleMessage({ msg, userId: effectiveUserId, chatId: effectiveChatId })) {\n        return;\n    }\n\n    if (text.startsWith('/')) {",
    'message gate'
  );

  source = replaceOnce(
    source,
    "  const data = q.data;\n\n  const directManagePayload = parseDirectManageCb(data);",
    "  const data = q.data;\n\n  if (!isImpersonating && await survey.handleCallback({ query: q, userId: effectiveUserId, chatId: effectiveChatId })) {\n    return;\n  }\n\n  const directManagePayload = parseDirectManageCb(data);",
    'callback gate'
  );

  return source;
}

module.exports = { applySurveyPatches };
