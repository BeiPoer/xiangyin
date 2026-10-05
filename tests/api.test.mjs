import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { MIMEType } from 'node:util';
import { startServer, client, credentials } from './helpers.mjs';

test('录音 MIME 支持空格、引号和编码列表，失败时保留旧录音', async () => {
  const server = await startServer();
  try {
    const api = await client(server);
    await api('/login', 'POST', credentials);
    const bytes = Buffer.from('recording-payload');
    let word = { text: '叔叔', note: '', favorite: false };
    for (const mime of ['audio/mp4', 'audio/mp4; codecs=mp4a.40.2', 'audio/mp4;codecs="mp4a.40.2"',
      'audio/mp4; codecs="mp4a.40.2"', 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
      'audio/webm;codecs=opus', 'audio/ogg; codecs="opus"', 'audio/wav']) {
      const saved = await api('/words', 'POST', { ...word, recording: { data: bytes.toString('base64'), mime } });
      assert.equal(saved.status, 200, mime);
      word = saved.value;
      const audio = await api(`/words/${word.id}/audio`);
      assert.deepEqual(audio.value, bytes);
      assert.equal(audio.headers.get('content-type'), new MIMEType(mime).toString());
    }
    for (const mime of ['text/html', 'application/octet-stream', 'not-a-mime', 'audio/mp4\r\nX-Test: injected', '', null]) {
      const saved = await api('/words', 'POST', { ...word, recording: { data: Buffer.from('replacement').toString('base64'), mime } });
      assert.equal(saved.status, 400);
      assert.equal(saved.value.error, '不支持这种录音格式');
      assert.deepEqual((await api(`/words/${word.id}/audio`)).value, bytes);
      assert.equal((await api('/words')).value[0].version, word.version);
    }
  } finally { await server.stop(); }
});

test('简单密码登录、权限保护、音频、同步、冲突、复习幂等和重启持久化', async () => {
  let server = await startServer();
  const directory = server.dataDir;
  try {
    let api = await client(server);
    assert.equal((await api('/words')).status, 401);
    assert.equal((await api('/login', 'POST', credentials, { Origin: 'https://elsewhere.example', 'Sec-Fetch-Site': 'cross-site' })).status, 403);
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

test('HTTPS 反向代理无需域名配置，保留跨站防护及安全 Cookie', async () => {
  const server = await startServer();
  try {
    const api = await client(server);
    const browser = { Origin: 'https://words.example.com:8443', 'Sec-Fetch-Site': 'same-origin' };
    const login = await api('/login', 'POST', credentials, browser);
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie'), /; Secure/);
    assert.match(login.headers.get('set-cookie'), /SameSite=Strict/);
    assert.equal(login.headers.get('access-control-allow-origin'), null);
    const word = { text: '叔叔', note: '', favorite: false };
    assert.equal((await api('/words', 'POST', word, browser)).status, 200);
    for (const site of ['cross-site', 'same-site', 'none']) {
      assert.equal((await api('/words', 'POST', word, { ...browser, 'Sec-Fetch-Site': site })).status, 403);
    }
    assert.equal((await api('/words', 'POST', word, { ...browser, 'X-App-Request': '' })).status, 403);
    assert.equal((await api('/words', 'POST', word, { ...browser, 'Content-Type': 'text/plain' })).status, 415);
    const preflight = await fetch(`${server.url}/api/login`, { method: 'OPTIONS', headers: {
      Origin: 'https://elsewhere.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-app-request',
    } });
    assert.equal(preflight.status, 403);
    assert.equal(preflight.headers.get('access-control-allow-origin'), null);
    const logout = await api('/logout', 'POST', {}, browser);
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie'), /Max-Age=0; Secure/);
    // Older browsers without Fetch Metadata remain protected by the custom-header preflight.
    assert.equal((await api('/login', 'POST', credentials, { Origin: 'https://words.example.com' })).status, 200);
    const forwarded = await api('/login', 'POST', credentials, { Origin: '', 'X-Forwarded-Proto': 'https' });
    assert.match(forwarded.headers.get('set-cookie'), /; Secure/);
    const direct = await api('/login', 'POST', credentials);
    assert.equal(direct.status, 200);
    assert.doesNotMatch(direct.headers.get('set-cookie'), /; Secure/);
  } finally { await server.stop(); }
});
