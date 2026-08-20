import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage, styleOf } from './style.js';

const VERBOSE =
  'The issue you are experiencing is likely caused by the fact that the token expiry check ' +
  'in the auth middleware uses a strict comparison. I would recommend that you change it to ' +
  'be inclusive, because the boundary case is what fails here.';

test('language is detected per turn, since one corpus holds both', () => {
  assert.equal(detectLanguage(VERBOSE), 'en');
  assert.equal(
    detectLanguage(
      'Le probleme vient de la comparaison stricte dans le middleware, et il faut que la ' +
        'verification de la date soit inclusive pour que le cas limite passe.',
    ),
    'fr',
  );
});

test('sentence length ignores markdown lines, which otherwise set it', () => {
  const punctuated = styleOf(
    '- Fixed the parser.\n- Rewrote the cache.\n- Added a test.\n- Shipped the fix.\n',
  );
  const unpunctuated = styleOf(
    '- Fixed the parser\n- Rewrote the cache\n- Added a test\n- Shipped the fix\n',
  );
  assert.ok(punctuated && unpunctuated);
  assert.ok(Number.isNaN(punctuated.meanSentenceLength));
  assert.ok(Number.isNaN(unpunctuated.meanSentenceLength));
  assert.equal(punctuated.structureShare, 1);
});

test('a bullet marker is not a word, so glyphs cannot set the shape', () => {
  const style = styleOf(
    'The retry budget was raised because the parser kept timing out on large inputs during the replay.\n' +
      '- one\n- two\n- three\n- four\n',
  );
  assert.ok(style);
  assert.equal(style.words, 21, 'four markers must not count as four words');
  assert.ok(style.structureShare < 0.2, `markers inflated the share to ${style.structureShare}`);
});

test('a compound word survives the same filter that drops the markers', () => {
  const style = styleOf("A well-formed request from d'accord clients never times out during the whole run.");
  assert.ok(style);
  assert.equal(style.words, 13);
});

test('sentence length counts words the way the denominator does', () => {
  const withDigits = styleOf(
    'The retry budget moved from 1 to 2 and then to 3 during the whole long run of tests.',
  );
  assert.ok(withDigits);
  assert.equal(withDigits.words, withDigits.meanSentenceLength);
});

test('a stopword tie is unknown, not whichever language is declared last', () => {
  assert.equal(detectLanguage('the of and to in is le la les de des du xxx yyy zzz www'), 'unknown');
});

test('prose lines still score when structure sits alongside them', () => {
  const style = styleOf(`${VERBOSE}\n\n- one bullet here\n- another bullet here\n`);
  assert.ok(style);
  assert.ok(Number.isFinite(style.meanSentenceLength));
  assert.ok(style.structureShare > 0 && style.structureShare < 1);
});

test('technical spans are excluded, since caveman preserves them by rule', () => {
  const bare = styleOf(VERBOSE);
  const withCode = styleOf(`${VERBOSE} \`src/auth/middleware.ts\` https://example.com/docs`);
  assert.ok(bare && withCode);
  assert.equal(bare.words, withCode.words);
});

test('a turn too short to carry a rate returns null rather than a noisy one', () => {
  assert.equal(styleOf('Done.'), null);
});
