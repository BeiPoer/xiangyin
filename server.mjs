import http from 'node:http';
import https from 'node:https';
import { readFile, mkdir } from 'node:fs/promises';
import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { grade, makeRound } from './public/domain.js';

const { APP_USERNAME, APP_PASSWORD, DATA_DIR = './data', CERT_FILE, KEY_FILE, PORT = '3025', HOST = '0.0.0.0' } = process.env;
if (!APP_USERNAME || !APP_PASSWORD) {
  throw new Error('请在 .env 中设置 APP_USERNAME 和 APP_PASSWORD，账号和密码不能为空');
}
if (Boolean(CERT_FILE) !== Boolean(KEY_FILE)) throw new Error('CERT_FILE 和 KEY_FILE 必须同时设置');
await mkdir(DATA_DIR, { recursive: true });
const db = new DatabaseSync(join(DATA_DIR, 'shanwei.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS words (id TEXT PRIMARY KEY, data TEXT NOT NULL, audio BLOB, mime TEXT);
  CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires INTEGER NOT NULL);`);
const hash = value => createHash('sha256').update(value).digest('hex');
const credentialTag = (await promisify(scrypt)(APP_PASSWORD, `shanwei:${APP_USERNAME}`, 64)).toString('hex');
if (db.prepare("SELECT value FROM state WHERE key='credentials'").get()?.value !== credentialTag) {
  db.exec('DELETE FROM sessions');
  db.prepare("INSERT OR REPLACE INTO state VALUES ('credentials', ?)").run(credentialTag);
}
const salt = randomBytes(32);
const passwordHash = await promisify(scrypt)(APP_PASSWORD, salt, 64);
const cookie = (req, token, maxAge) => {
  // These headers only enable the stricter cookie flag; they never authorize requests.
  const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' || req.headers.origin?.startsWith('https://');
  return `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
};
const sessionKey = req => hash((req.headers.cookie || '').match(/(?:^|;\s*)session=([a-f0-9]{64})(?:;|$)/)?.[1] || '');
const getWord = id => {
  const row = db.prepare('SELECT data FROM words WHERE id=?').get(id);
  return row ? JSON.parse(row.data) : null;
};
const listWords = () => db.prepare('SELECT data FROM words').all().map(row => JSON.parse(row.data));
const getRound = () => JSON.parse(db.prepare("SELECT value FROM state WHERE key='round'").get()?.value || 'null');
const putRound = round => db.prepare("INSERT OR REPLACE INTO state VALUES ('round', ?)").run(JSON.stringify(round));
function atomic(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
function check(condition, message, status = 400) {
  if (!condition) throw Object.assign(new Error(message), { status });
}
async function readBody(req, limit = 12 * 1024 * 1024) {
  check(req.headers['content-type']?.split(';')[0] === 'application/json', '请求格式错误', 415);
  check(Number(req.headers['content-length'] || 0) <= limit, '录音过大，请录制更短的读音', 413);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    check(size <= limit, '录音过大，请录制更短的读音', 413);
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    check(body && typeof body === 'object' && !Array.isArray(body), '请求格式错误');
    return body;
  } catch { throw Object.assign(new Error('请求格式错误'), { status: 400 }); }
}
const headers = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'microphone=(self), camera=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'Cache-Control': 'no-store',
};
function json(res, value, status = 200, extra = {}) {
  res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', ...extra });
  res.end(JSON.stringify(value));
}
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ...['index.html', 'styles.css', 'app.js', 'db.js', 'domain.js', 'favicon.svg'].map(name => [
    `/${name}`, [name, name.endsWith('.js') ? 'text/javascript; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : name.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8'],
  ]),
]);
// ponytail: one personal account and a single process; use per-user records for a multi-user product.
const attempts = new Map();
let globalAttempts = { until: 0, count: 0 };
async function api(req, res, path) {
  const method = req.method;
  if (!['GET', 'HEAD'].includes(method)) {
    // Custom headers require CORS preflight in browsers. Never allow cross-origin CORS here.
    const site = req.headers['sec-fetch-site'];
    check(req.headers['x-app-request'] === '1' && (!site || site === 'same-origin'), '请从本站页面操作', 403);
  }
  if (path === '/api/login' && method === 'POST') {
    const now = Date.now();
    for (const [key, value] of attempts) if (value.until < now) attempts.delete(key);
    if (globalAttempts.until < now) globalAttempts = { until: now + 900_000, count: 0 };
    const address = req.socket.remoteAddress;
    const attempt = attempts.get(address) || { until: now + 900_000, count: 0 };
    check(attempt.count < 20 && globalAttempts.count < 100, '尝试次数过多，请 15 分钟后再试', 429);
    attempt.count++; globalAttempts.count++; attempts.set(address, attempt);
    const body = await readBody(req, 8192);
    check(typeof body.password === 'string' && body.password.length <= 1024, '账号或密码不正确', 401);
    const candidate = await promisify(scrypt)(body.password, salt, 64);
    check(timingSafeEqual(candidate, passwordHash) && body.username === APP_USERNAME, '账号或密码不正确', 401);
    attempts.delete(address);
    db.prepare('DELETE FROM sessions WHERE expires < ?').run(now);
    const token = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions VALUES (?, ?)').run(hash(token), now + 30 * 86400_000);
    json(res, { username: APP_USERNAME }, 200, { 'Set-Cookie': cookie(req, token, 30 * 86400) }); return;
  }
  check(db.prepare('SELECT token FROM sessions WHERE token=? AND expires>?').get(sessionKey(req), Date.now()), '登录已过期，请重新登录；未保存的内容仍保留在当前页面', 401);
  if (path === '/api/session' && method === 'GET') { json(res, { username: APP_USERNAME }); return; }
  if (path === '/api/logout' && method === 'POST') {
    db.prepare('DELETE FROM sessions WHERE token=?').run(sessionKey(req));
    json(res, {}, 200, { 'Set-Cookie': cookie(req, '', 0) }); return;
  }
  if (path === '/api/words' && method === 'GET') { json(res, listWords()); return; }
  if (path === '/api/words' && method === 'POST') {
    const body = await readBody(req);
    check(typeof body.text === 'string' && body.text.trim().length > 0 && body.text.trim().length <= 50, '字词需要填写 1–50 个字符');
    check(typeof body.note === 'string' && body.note.length <= 1000 && typeof body.favorite === 'boolean', '备注或收藏格式错误');
    const old = body.id ? getWord(body.id) : null;
    check(!body.id || old, '词条已被删除，请刷新后重试', 404);
    check(!old || body.version === old.version, '词条已在另一设备修改，请重新打开后编辑（当前内容仍保留）', 409);
    let audio = null;
    let mime = null;
    if (body.recording) {
      const rec = body.recording;
      check(typeof rec.data === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(rec.data), '录音数据无效');
      check(typeof rec.mime === 'string' && /^(audio\/(webm|mp4|ogg|wav)|video\/mp4)(;codecs=[\w., -]+)?$/i.test(rec.mime), '不支持这种录音格式');
      audio = Buffer.from(rec.data, 'base64'); mime = rec.mime;
      check(audio.length > 0 && audio.length <= 8 * 1024 * 1024, '录音不能超过 8 MB');
    }
    const word = { ...(old || { id: randomUUID(), correct: 0, wrong: 0, streak: 0, mistake: false, createdAt: Date.now() }),
      text: body.text.trim(), note: body.note.trim(), favorite: body.favorite,
      hasAudio: Boolean(audio || old?.hasAudio), version: (old?.version || 0) + 1, updatedAt: Date.now() };
    db.prepare(`INSERT INTO words (id,data,audio,mime) VALUES (?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data, audio=COALESCE(excluded.audio,words.audio), mime=COALESCE(excluded.mime,words.mime)`)
      .run(word.id, JSON.stringify(word), audio, mime);
    json(res, word); return;
  }
  const match = path.match(/^\/api\/words\/([a-f0-9-]{36})(\/audio)?$/);
  if (match) {
    let word = getWord(match[1]);
    check(word, '词条不存在，请刷新词库', 404);
    if (match[2] && method === 'GET') {
      const row = db.prepare('SELECT audio,mime FROM words WHERE id=?').get(word.id);
      check(row.audio, '这个词还没有录音', 404);
      const size = row.audio.length;
      const audioHeaders = { ...headers, 'Content-Type': row.mime, 'Accept-Ranges': 'bytes' };
      if (req.headers.range) {
        const range = req.headers.range.match(/^bytes=(\d*)-(\d*)$/);
        let start = range?.[1] ? Number(range[1]) : Math.max(0, size - Number(range?.[2]));
        let end = range?.[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
        if (!range || (!range[1] && !range[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
          res.writeHead(416, { ...audioHeaders, 'Content-Range': `bytes */${size}` }).end(); return;
        }
        res.writeHead(206, { ...audioHeaders, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}` });
        res.end(row.audio.subarray(start, end + 1)); return;
      }
      res.writeHead(200, { ...audioHeaders, 'Content-Length': size }); res.end(row.audio); return;
    }
    if (!match[2] && method === 'PATCH') {
      const body = await readBody(req, 4096);
      word = getWord(match[1]);
      check(word, '词条已被删除', 404);
      if (typeof body.favorite === 'boolean') word.favorite = body.favorite;
      else if (body.mastered === true) { word.mistake = false; word.streak = 0; }
      else check(false, '无效的词条操作');
      word.version++;
      db.prepare('UPDATE words SET data=? WHERE id=?').run(JSON.stringify(word), word.id);
      json(res, word); return;
    }
    if (!match[2] && method === 'DELETE') {
      const body = await readBody(req, 4096);
      word = getWord(match[1]);
      check(word && body.version === word.version, '词条已在另一设备修改，请重新打开后删除', 409);
      atomic(() => {
        db.prepare('DELETE FROM words WHERE id=?').run(word.id);
        const round = getRound();
        if (round) { round.ids = round.ids.filter((id, i) => i < round.answers.length || id !== word.id); putRound(round); }
      });
      json(res, {}); return;
    }
  }
  if (path === '/api/review' && method === 'GET') { json(res, getRound()); return; }
  if (path === '/api/review' && method === 'POST') {
    const body = await readBody(req, 4096);
    check(['all', 'favorites', 'mistakes', 'retry'].includes(body.scope) && ['10', '20', 'all'].includes(String(body.count)), '复习范围或题量错误');
    const previous = getRound();
    check((previous?.id || null) === (body.previousId || null), '另一设备已开始新的复习，请刷新页面', 409);
    const pool = body.scope === 'retry' ? listWords().filter(word => previous?.answers.some(answer => answer.id === word.id && !answer.correct)) : listWords();
    const round = { ...makeRound(pool, body.scope, body.count), id: randomUUID(), scope: body.scope };
    check(round.ids.length, '这个范围还没有可以复习的录音词条');
    putRound(round); json(res, round); return;
  }
  if (path === '/api/review/answer' && method === 'POST') {
    const body = await readBody(req, 4096);
    check(typeof body.correct === 'boolean', '请选择答对或答错');
    const round = atomic(() => {
      const round = getRound();
      check(round && round.id === body.roundId, '复习已在另一设备更新，请刷新页面', 409);
      const existing = round.answers.find(answer => answer.id === body.wordId);
      if (existing) { check(existing.correct === body.correct, '这道题已记录，请刷新进度', 409); return round; }
      check(round.ids[round.answers.length] === body.wordId, '当前题目已变化，请刷新页面', 409);
      const word = getWord(body.wordId);
      check(word, '词条已被删除，请刷新复习进度', 409);
      db.prepare('UPDATE words SET data=? WHERE id=?').run(JSON.stringify(grade(word, body.correct)), word.id);
      round.answers.push({ id: word.id, correct: body.correct }); putRound(round); return round;
    });
    json(res, round); return;
  }
  check(false, '接口不存在', 404);
}
const server = (CERT_FILE ? https.createServer({ cert: await readFile(CERT_FILE), key: await readFile(KEY_FILE) }) : http.createServer());
server.on('request', async (req, res) => {
  try {
    const path = req.url.split('?')[0];
    if (path.startsWith('/api/')) { await api(req, res, path); return; }
    check(['GET', 'HEAD'].includes(req.method), '不支持此操作', 405);
    const file = files.get(path);
    check(file, '页面不存在', 404);
    const body = await readFile(new URL(`./public/${file[0]}`, import.meta.url));
    res.writeHead(200, { ...headers, 'Content-Type': file[1], 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (error) {
    if (!error.status) console.error(error);
    if (!res.headersSent) json(res, { error: error.status ? error.message : '服务器暂时无法保存，请稍后重试，当前内容已保留' }, error.status || 500);
    else res.end();
  }
});
server.requestTimeout = 60_000;
server.listen(Number(PORT), HOST, () => console.log(`汕尾话词库已启动：${CERT_FILE ? 'https' : 'http'}://localhost:${server.address().port}`));
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
