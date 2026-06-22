const crypto = require('crypto');

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const NUMBERS = '23456789';
const SYMBOLS = '!@#$%*-_=+';
const ALL = UPPER + LOWER + NUMBERS + SYMBOLS;

function pick(chars) {
  return chars[crypto.randomInt(0, chars.length)];
}

function shuffle(chars) {
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars;
}

function generateStrongPassword(length = 18) {
  const size = Math.max(12, Number(length) || 18);
  const chars = [pick(UPPER), pick(LOWER), pick(NUMBERS), pick(SYMBOLS)];
  while (chars.length < size) chars.push(pick(ALL));
  return shuffle(chars).join('');
}

module.exports = { generateStrongPassword };
