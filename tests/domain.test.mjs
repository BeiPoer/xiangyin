import test from 'node:test';
import assert from 'node:assert/strict';
import { eligible, grade, makeRound, score } from '../public/domain.js';

const word = { id: '1', hasAudio: true, favorite: true, correct: 0, wrong: 0, streak: 0, mistake: false };
test('错词进入、三次连续答对移出、再次答错重新进入且历史保留', () => {
  let current = grade(word, false);
  assert.equal(current.mistake, true);
  current = grade(grade(current, true), true);
  assert.equal(current.mistake, true);
  current = grade(current, false);
  assert.equal(current.streak, 0);
  current = grade(grade(grade(current, true), true), true);
  assert.equal(current.mistake, false);
  assert.equal(current.correct, 5);
  assert.equal(current.wrong, 2);
  assert.equal(grade(current, false).mistake, true);
  assert.equal(word.wrong, 0);
});
test('复习排除未录音词、筛选、题量、随机去重及计分', () => {
  const words = Array.from({ length: 25 }, (_, index) => ({ ...word, id: String(index), hasAudio: index !== 0, favorite: index % 2 === 0, mistake: index === 3 }));
  assert.equal(eligible(words, 'all').length, 24);
  assert.equal(eligible(words, 'favorites').length, 12);
  assert.equal(eligible(words, 'mistakes').length, 1);
  const round = makeRound(words, 'all', 10, () => 0.5);
  assert.equal(new Set(round.ids).size, 10);
  assert.ok(!round.ids.includes('0'));
  assert.equal(makeRound(words, 'mistakes', 20).ids.length, 1);
  assert.equal(makeRound(words, 'all', 'all').ids.length, 24);
  assert.deepEqual(score({ answers: [] }), { correct: 0, wrong: 0, total: 0, accuracy: 0 });
  assert.deepEqual(score({ answers: [{ correct: true }, { correct: false }, { correct: true }] }), { correct: 2, wrong: 1, total: 3, accuracy: 67 });
});
