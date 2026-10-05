import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { startServer, client, credentials } from './helpers.mjs';

test('简单密码登录、权限保护、音频、同步、冲突、复习幂等和重启持久化', async () => {
  let server = await startServer();
  const directory = server.dataDir;
  try {
    let api = await client(server);
    assert.equal((await api('/words')).status, 401);
    assert.equal((await api('/login', 'POST', credentials, { Origin: 'https://elsewhere.example' })).status, 403);
    assert.equal((await api('/login', 'POST', { ...credentials, password: 'wrong' })).status, 401);
    const login = await api('/login', 'POST', credentials);
    assert.equal(login.status, 200); assert.match(login.headers.get('set-cookie'), /HttpOnly/);
    assert.equal((await api('/words', 'POST', { text: ' ', note: '', favorite: false })).status, 400);
    const payload = { text: '叔叔', note: '<script>不会执行</script>', favorite: false };
    let draft = (await api('/words', 'POST', payload)).value;
    assert.equal(draft.hasAudio, false);
    assert.equal((await api('/review', 'POST', { scope: 'all', count: '10' })).status, 400);
    const recording = { data: Buffer.from('audio-test-bytes').toString('base64'), mime: 'audio/webm' };
    let word = (await api('/words', 'POST', { ...draft, recording })).value;
    assert.equal(word.hasAudio, true);
    assert.equal((await api(`/words/${word.id}/audio`)).value.toString(), 'audio-test-bytes');
    const partial = await api(`/words/${word.id}/audio`, 'GET', undefined, { Range: 'bytes=0-1' });
    assert.equal(partial.status, 206); assert.equal(partial.value.toString(), 'au');
    assert.equal(partial.headers.get('content-range'), 'bytes 0-1/16');
    assert.equal((await api(`/words/${word.id}/audio`, 'GET', undefined, { Range: 'bytes=-5' })).value.toString(), 'bytes');
    assert.equal((await api(`/words/${word.id}/audio`, 'GET', undefined, { Range: 'bytes=999-' })).status, 416);
    assert.equal((await api('/words', 'POST', { ...draft, text: '过期修改' })).status, 409);
    const second = await client(server); await second('/login', 'POST', credentials);
    assert.equal((await second('/words')).value[0].text, '叔叔');
    word = (await second(`/words/${word.id}`, 'PATCH', { favorite: true })).value;
    assert.equal((await api('/words')).value[0].favorite, true);
    let round = (await api('/review', 'POST', { scope: 'favorites', count: '10' })).value;
    assert.equal(round.ids.length, 1);
    const wrong = { roundId: round.id, wordId: word.id, correct: false };
    const concurrent = await Promise.all([api('/review/answer', 'POST', wrong), second('/review/answer', 'POST', wrong)]);
    assert.ok(concurrent.every(result => result.status === 200));
    word = (await api('/words')).value[0]; assert.equal(word.wrong, 1); assert.equal(word.mistake, true);
    assert.equal((await second('/review')).value.answers.length, 1);
    assert.equal((await api('/review/answer', 'POST', { ...wrong, correct: true })).status, 409);
    for (let i = 0; i < 3; i++) {
      round = (await api('/review', 'POST', { scope: 'mistakes', count: '10', previousId: round.id })).value;
      assert.equal((await api('/review/answer', 'POST', { roundId: round.id, wordId: word.id, correct: true })).status, 200);
    }
    word = (await api('/words')).value[0]; assert.equal(word.mistake, false); assert.equal(word.correct, 3);
    assert.equal((await api('/review', 'POST', { scope: 'all', count: 10, previousId: 'old-round' })).status, 409);
    word = (await api('/words', 'POST', { ...word, text: '叔叔（改）' })).value;
    assert.equal(word.correct, 3); assert.equal(word.hasAudio, true);
    assert.equal((await api(`/words/${word.id}/audio`)).value.toString(), 'audio-test-bytes');
    assert.equal((await fetch(`${server.url}/.env`)).status, 404);
    assert.equal((await fetch(`${server.url}/data/shanwei.sqlite`)).status, 404);
    await server.stop(false); server = await startServer(directory); api = await client(server);
    await api('/login', 'POST', credentials);
    assert.equal((await api('/words')).value[0].correct, 3);
    assert.equal((await api('/review')).value.answers.length, 1);
    round = (await api('/review', 'POST', { scope: 'all', count: 'all', previousId: round.id })).value;
    assert.equal((await api(`/words/${word.id}`, 'DELETE', { version: word.version - 1 })).status, 409);
    assert.equal((await api(`/words/${word.id}`, 'DELETE', { version: word.version })).status, 200);
    assert.equal((await api('/review')).value.ids.length, 0);
    assert.equal((await api(`/words/${word.id}/audio`)).status, 404);
    await api('/logout', 'POST', {}); assert.equal((await api('/words')).status, 401);
  } finally { await server.stop(false); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
