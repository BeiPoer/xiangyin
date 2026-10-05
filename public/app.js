import * as db from './db.js';
import { eligible, score } from './domain.js';

const $ = selector => document.querySelector(selector);
const icons = {
  book: '<path d="M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4zM13 7a3 3 0 0 1 3-3h5v15h-5a3 3 0 0 0-3 2"/>',
  cards: '<rect x="7" y="6" width="13" height="15" rx="3"/><path d="M4 17V5a3 3 0 0 1 3-3h10M11 11h5m-5 4h3"/>',
  sprout: '<path d="M12 21v-9M12 16C3 16 3 8 3 8s9-1 9 8Zm0-4C12 3 21 3 21 3s1 9-9 9Z"/>',
  sound: '<path d="m11 5-6 4H2v6h3l6 4zM15 8a7 7 0 0 1 0 8m3-11a11 11 0 0 1 0 14"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z"/>',
  mic: '<rect x="8" y="2" width="8" height="13" rx="4"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  cross: '<path d="m6 6 12 12M6 18 18 6"/>',
};
const icon = name => `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || ''}</svg>`;
document.querySelectorAll('[data-icon]').forEach(el => el.innerHTML = icon(el.dataset.icon));
const escape = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let words = [], round = null, page = 'words', filter = 'all', query = '', scope = 'all', count = '10', reviewMode = 'setup', revealed = false;
let ready = false, actionBusy = false, editWord = null, pendingAudio = null, dirty = false, saving = false, recording = false, requestingMic = false, recorder = null, stream = null, timer = null, editGeneration = 0, chooseScope = false;
let audio = null, playbackRun = 0, playbackTimer, toastTimer;
// ponytail: retain at most 8 native players in this tab; increase only if repeat-listening needs it.
const audioCache = new Map();
const editor = $('#editor');
const toast = message => { $('#toast').textContent = message; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 4500); };

function syncAudioButtons() {
  document.querySelectorAll('[data-action="play"], [data-action="reveal"], #preview-button').forEach(button => {
    const isPreview = button.id === 'preview-button';
    const active = audio && (isPreview ? editor.open && audio.key === (pendingAudio || `${editWord?.id}:${editWord?.updatedAt}`) : !editor.open && audio.id === button.dataset.id);
    const state = active ? audio.state : 'idle';
    if (!button.dataset.idleHtml) {
      button.dataset.idleHtml = button.innerHTML;
      button.dataset.idleLabel = button.getAttribute('aria-label') || button.textContent;
    }
    button.dataset.audioState = state;
    button.setAttribute('aria-busy', String(state === 'loading'));
    button.setAttribute('aria-pressed', String(state !== 'idle'));
    if (state === 'idle') {
      button.innerHTML = button.dataset.idleHtml;
      button.setAttribute('aria-label', button.dataset.idleLabel);
      button.removeAttribute('title');
    } else {
      const label = state === 'loading' ? '加载中' : '播放中';
      button.innerHTML = `${state === 'loading' ? '<span class="audio-spinner" aria-hidden="true"></span>' : '<span class="audio-bars" aria-hidden="true"><i></i><i></i><i></i><i></i></span>'}<span class="audio-caption">${label}</span>`;
      button.setAttribute('aria-label', `${label}：${words.find(word => word.id === audio.id)?.text || '试听读音'}，点击停止`);
      button.title = `${label}，点击停止`;
    }
  });
}
function discardAudio(entry) {
  if (audio === entry) stopAudio();
  audioCache.delete(entry.key);
  entry.player.pause(); entry.player.removeAttribute('src'); entry.player.load();
  if (entry.url) URL.revokeObjectURL(entry.url);
}
function stopAudio() {
  const previous = audio;
  audio = null; playbackRun++; clearTimeout(playbackTimer);
  if (previous) {
    previous.player.pause();
    // Abort unfinished downloads on cancellation; fully buffered players remain reusable.
    if (previous.state === 'loading') discardAudio(previous);
  }
  syncAudioButtons();
}
function clearAudioCache() {
  stopAudio();
  for (const entry of audioCache.values()) discardAudio(entry);
}
async function play(id, blob) {
  const key = blob || `${id}:${words.find(word => word.id === id)?.updatedAt}`;
  const wasActive = audio?.key === key;
  stopAudio();
  if (wasActive) return;
  let entry = audioCache.get(key);
  if (!entry) {
    const url = blob ? URL.createObjectURL(blob) : null;
    entry = { key, id, url, player: new Audio(url || `/api/words/${id}/audio`), state: 'idle' };
  }
  audioCache.delete(key); audioCache.set(key, entry);
  while (audioCache.size > 8) discardAudio(audioCache.values().next().value);
  audio = entry;
  const run = playbackRun, player = entry.player;
  const current = () => audio === entry && playbackRun === run;
  const failed = () => {
    if (!current()) return;
    stopAudio(); discardAudio(entry);
    const message = '播放失败或加载超时，请检查网络后点击重试。';
    if (editor.open) $('#editor-error').textContent = message; else toast(message);
  };
  const loading = () => {
    if (!current()) return;
    entry.state = 'loading'; syncAudioButtons(); clearTimeout(playbackTimer);
    playbackTimer = setTimeout(failed, 15000);
  };
  player.onwaiting = loading;
  player.onplaying = () => {
    if (!current()) return;
    clearTimeout(playbackTimer); entry.state = 'playing';
    if (page === 'review' && reviewMode === 'active' && round?.ids[round.answers.length] === id && !revealed) {
      revealed = true; renderReview();
    }
    syncAudioButtons();
  };
  player.onended = player.onpause = () => { if (current() && player.paused) { entry.state = 'idle'; stopAudio(); } };
  player.onerror = failed;
  loading();
  try {
    player.currentTime = 0;
    // Call directly during the tap so iOS keeps the user gesture permission.
    await player.play();
  } catch { failed(); }
}

function card(word, mistake = false) {
  return `<article class="word-card">
    <button class="word-main" data-action="edit" data-id="${word.id}" aria-label="查看或编辑：${escape(word.text)}"><span class="word-title">${escape(word.text)}</span><span class="word-note">${escape(word.note || (word.hasAudio ? '点开查看词条' : '还没录音，找个时间记下来'))}</span></button>
    <div class="word-buttons"><button class="icon-button favorite ${word.favorite ? 'selected' : ''}" data-action="favorite" data-id="${word.id}" aria-label="${word.favorite ? '取消收藏' : '收藏'}：${escape(word.text)}" aria-pressed="${word.favorite}">${icon('star')}</button><button class="play-button ${word.hasAudio ? '' : 'unrecorded'}" data-action="${word.hasAudio ? 'play' : 'edit'}" data-id="${word.id}" aria-label="${word.hasAudio ? '播放' : '补录'}：${escape(word.text)}">${icon(word.hasAudio ? 'sound' : 'mic')}</button></div>
    ${mistake ? `<div class="mistake-detail"><span>累计答错 <b>${word.wrong}</b> 次 <span class="streak">· 连续答对 ${word.streak}/3</span></span><button class="text-button" data-action="master" data-id="${word.id}">标记已掌握</button></div>` : !word.hasAudio ? '<span class="pending-tag">待录音</span>' : ''}
  </article>`;
}
function empty(title, detail, button = false, name = 'book') {
  return `<div class="empty-state"><div class="empty-icon">${icon(name)}</div><h3>${title}</h3><p>${detail}</p>${button ? `<button class="button primary" data-action="add">${icon('plus')}添加第一个词</button>` : ''}</div>`;
}
function renderList() {
  const mistakes = page === 'mistakes';
  const pool = words.filter(word => (!mistakes || word.mistake) && (filter !== 'favorites' || mistakes || word.favorite) && `${word.text} ${word.note}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  pool.sort((a, b) => mistakes ? b.wrong - a.wrong || b.updatedAt - a.updatedAt : b.createdAt - a.createdAt);
  $('#list-count').textContent = `${pool.length} 个词`;
  $('#word-list').innerHTML = pool.length ? pool.map(word => card(word, mistakes)).join('') : query ? empty('暂时没找到这个词', '换个关键词试试，也可以搜索备注。') : mistakes ? empty('慢慢练，总会记住', '复习中答错的词会自动出现在这里。', false, 'sprout') : filter === 'favorites' ? empty('把想多练的词，留在这里', '点击词条旁的星星，就能加入收藏。', false, 'star') : empty('从一声熟悉的乡音开始', '记一个词，录一段声音。你的汕尾话词库，就从这里开始。', true);
  syncAudioButtons();
}
function renderWords() {
  const mistakes = page === 'mistakes';
  const recorded = words.filter(word => word.hasAudio).length;
  const favorites = words.filter(word => word.favorite).length;
  $('#main').innerHTML = `<section class="page-intro"><div><span class="eyebrow">${mistakes ? '多练一遍，就近一点' : '一字一句，慢慢记住'}</span><h1>${mistakes ? '易错词' : '我的词库'}<span class="title-dot">。</span></h1><p>${mistakes ? '把不太熟的乡音，再听一遍。' : '把乡音留住，把熟悉的声音学会。'}</p></div>${mistakes ? `<button class="button primary" data-action="practice-mistakes" ${eligible(words, 'mistakes').length ? '' : 'disabled'}>${icon('cards')}重点练习</button>` : `<button class="button primary add-button" data-action="add">${icon('plus')}添加字词</button>`}</section>
    ${mistakes ? '<div class="tip-strip">连续答对 3 次，就会自动移出易错词；也可以手动标记已掌握。</div>' : `<section class="stats" aria-label="词库概况"><div><span>已积累字词</span><strong>${words.length}<small>个</small></strong></div><div><span>已留下读音</span><strong>${recorded}<small>段</small></strong></div><div><span>我的收藏</span><strong>${favorites}<small>个</small></strong></div></section>`}
    <div class="library-tools"><label class="search-box">${icon('search')}<input id="search" type="search" placeholder="搜一个字词，或一段备注" aria-label="搜索字词或备注" value="${escape(query)}"></label>${mistakes ? '' : `<div class="segmented" aria-label="词库筛选"><button data-action="filter-all" aria-pressed="${filter === 'all'}" class="${filter === 'all' ? 'active' : ''}">全部词条</button><button data-action="filter-favorites" aria-pressed="${filter === 'favorites'}" class="${filter === 'favorites' ? 'active' : ''}">${icon('star')}我的收藏</button></div>`}</div>
    <div class="list-heading"><h2>${mistakes ? '再给这些词一点时间' : filter === 'favorites' ? '值得多听几遍' : '我的乡音手记'}</h2><span id="list-count"></span></div><div id="word-list" class="word-list"></div>
    <p class="page-footnote">${icon('sound')}每一段读音，都是你亲手留下的乡音</p>`;
  renderList();
}
function renderReview() {
  if (reviewMode === 'active' && round) {
    if (round.answers.length >= round.ids.length) { renderResults(); return; }
    const word = words.find(item => item.id === round.ids[round.answers.length]);
    if (!word) { reviewMode = 'setup'; renderReview(); toast('词条已变化，请重新开始复习'); return; }
    $('#main').innerHTML = `<section class="review-top"><button class="text-button" data-action="pause">← 暂停复习</button><span>第 ${round.answers.length + 1} / ${round.ids.length} 个词</span></section><progress value="${round.answers.length}" max="${round.ids.length}" aria-label="复习进度"></progress>
      <section class="study-card"><span class="eyebrow">先试着读，再听听看</span><h1 class="study-word">${escape(word.text)}</h1><div class="sound-wave" aria-hidden="true">▂ ▅ ▃ ▇ ▄ ▆ ▂</div><button class="button primary listen" data-action="reveal" data-id="${word.id}">${icon('sound')}${revealed ? '再听一遍' : '听读音，对照一下'}</button>${revealed ? `<details><summary>查看释义或备注</summary><p>${escape(word.note || '这个词还没有备注。')}</p></details>` : '<p class="muted">想一想，你记得它的读音吗？</p>'}</section>
      <p class="judge-hint">${revealed ? '刚才读对了吗？诚实地记录就好。' : '听过录音后，就可以判断对错。'}</p><div class="answer-buttons"><button class="button wrong" data-action="wrong" ${revealed ? '' : 'disabled'}>${icon('cross')}答错了</button><button class="button correct" data-action="correct" ${revealed ? '' : 'disabled'}>${icon('check')}答对了</button></div><p class="page-footnote">每完成一题自动保存，随时可以接着练。</p>`;
    syncAudioButtons();
    return;
  }
  const available = eligible(words, scope).length;
  const unfinished = round && round.answers.length < round.ids.length;
  $('#main').innerHTML = `<section class="page-intro"><div><span class="eyebrow">给乡音留一点时间</span><h1>温习一下<span class="title-dot">。</span></h1><p>先自己读，再听录音。一点点，把乡音记牢。</p></div></section>
    ${unfinished ? `<div class="resume-strip"><div><strong>上次练到第 ${round.answers.length + 1} 个词</strong><span>已完成 ${round.answers.length} / ${round.ids.length} 个</span></div><button class="button secondary" data-action="resume">继续复习 →</button></div>` : ''}
    <section class="review-setup"><h2>今天，想练哪些词？</h2><div class="scope-options">${[['all', 'book', '全部词条', '从整个词库随机练习'], ['favorites', 'star', '我的收藏', '多听几遍喜欢的乡音'], ['mistakes', 'sprout', '易错词', '重点练习还不熟悉的词']].map(([value, symbol, title, subtitle]) => `<button class="scope-option ${scope === value ? 'active' : ''}" data-action="scope" data-scope="${value}" aria-pressed="${scope === value}"><span class="scope-icon">${icon(symbol)}</span><span><strong>${title}</strong><small>${subtitle}</small></span><b>${eligible(words, value).length}</b></button>`).join('')}</div><div class="count-heading"><h3>这一轮，练多少？</h3><span>每答对一个得 1 分</span></div><div class="count-options">${[['10', '10 个'], ['20', '20 个'], ['all', '全部']].map(([value, label]) => `<button class="button ${count === value ? 'selected-count' : 'secondary'}" data-action="count" data-count="${value}" aria-pressed="${count === value}">${label}</button>`).join('')}</div><button class="button primary full start-review" data-action="start" ${available ? '' : 'disabled'}>开始复习 · ${count === 'all' ? available : Math.min(Number(count), available)} 个词 <span aria-hidden="true">→</span></button><p class="muted setup-note">${available ? '随机出题，每个词在这一轮只出现一次。' : '还没有可复习的词条，先去词库录一段读音吧。'} 未录音的词暂不参与复习。</p></section>`;
}
function renderResults() {
  const result = score(round);
  const wrong = round.answers.filter(item => !item.correct);
  $('#main').innerHTML = `<section class="result-card"><span class="result-icon">${icon('check')}</span><span class="eyebrow">又记住了一点乡音</span><h1>这一轮，完成了。</h1><p class="result-score"><strong>${result.correct}</strong><span>/ ${result.total} 分</span></p><div class="result-stats"><span>答对 <b>${result.correct}</b></span><span>答错 <b>${result.wrong}</b></span><span>正确率 <b>${result.accuracy}%</b></span></div><p class="muted">${wrong.length ? '没关系，多听一遍，下次就更熟悉。' : '这一轮都记住了，继续保持。'}</p><div class="result-actions">${wrong.length ? '<button class="button primary" data-action="retry">再练本轮错词</button>' : ''}<button class="button secondary" data-action="setup">返回复习</button></div></section>${wrong.length ? `<div class="list-heading"><h2>这一轮，再听听这些词</h2><span>${wrong.length} 个词</span></div><div class="word-list">${wrong.map(answer => words.find(word => word.id === answer.id)).filter(Boolean).map(word => card(word)).join('')}</div>` : ''}`;
}
function render() {
  if (!ready) return;
  document.querySelectorAll('[data-page]').forEach(el => { el.classList.toggle('active', el.dataset.page === page); if (el.dataset.page === page) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); });
  page === 'review' ? renderReview() : renderWords();
  syncAudioButtons();
}
async function refresh() {
  const result = await Promise.all([db.allWords(), db.getRound()]);
  if (round?.id !== result[1]?.id || round?.answers.length !== result[1]?.answers.length) revealed = false;
  [words, round] = result;
  for (const entry of audioCache.values()) {
    if (typeof entry.key === 'string' && !words.some(word => word.hasAudio && `${word.id}:${word.updatedAt}` === entry.key)) discardAudio(entry);
  }
}
async function navigate() {
  if (!ready) return;
  if (editor.open && !closeEditor()) { history.replaceState(null, '', `#${page}`); return; }
  stopAudio();
  page = ['words', 'review', 'mistakes'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'words';
  query = '';
  try { await refresh(); } catch (error) { toast(error.message); }
  if (page === 'review') { reviewMode = !chooseScope && round && round.answers.length < round.ids.length ? 'active' : 'setup'; revealed = false; chooseScope = false; }
  render(); window.scrollTo(0, 0);
}
window.addEventListener('hashchange', navigate);
$('#main').addEventListener('input', event => { if (event.target.id === 'search') { query = event.target.value; renderList(); } });
$('#main').addEventListener('click', async event => {
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled || actionBusy) return;
  const { action, id } = button.dataset;
  if (action === 'play' || action === 'reveal') { void play(id); return; }
  const word = words.find(item => item.id === id);
  actionBusy = true;
  button.disabled = true;
  try {
    if (action === 'add' || action === 'edit') openEditor(word);
    else if (action === 'favorite' || action === 'master') {
      if (action === 'master' && !confirm(`将“${word.text}”标记为已掌握？历史答题记录会保留。`)) return;
      const saved = await db.patchWord(id, action === 'favorite' ? { favorite: !word.favorite } : { mastered: true });
      words = words.map(item => item.id === id ? saved : item); render();
      if (action === 'master') toast('已移出易错词，继续加油');
    } else if (action.startsWith('filter-')) { filter = action === 'filter-all' ? 'all' : 'favorites'; renderWords(); }
    else if (action === 'scope') { scope = button.dataset.scope; renderReview(); }
    else if (action === 'count') { count = button.dataset.count; renderReview(); }
    else if (action === 'resume') { reviewMode = 'active'; revealed = false; renderReview(); }
    else if (action === 'pause' || action === 'setup') { stopAudio(); reviewMode = 'setup'; renderReview(); }
    else if (action === 'start' || action === 'retry') {
      if (round && round.answers.length < round.ids.length && !confirm('开始新一轮复习？已完成题目的学习记录会保留。')) return;
      round = await db.startRound(action === 'retry' ? 'retry' : scope, action === 'retry' ? 'all' : count, round?.id || null);
      await refresh(); reviewMode = 'active'; revealed = false; render(); window.scrollTo(0, 0);
    } else if (action === 'practice-mistakes') { scope = 'mistakes'; chooseScope = true; location.hash = 'review'; }
    else if (action === 'correct' || action === 'wrong') {
      stopAudio();
      round = await db.answerRound(round.id, round.ids[round.answers.length], action === 'correct');
      revealed = false; render();
      // The answer is already committed; a failed refresh must not grade it again.
      try { await refresh(); render(); } catch { toast('本题已保存，词库暂时未刷新'); }
    }
  } catch (error) { toast(error.message); }
  finally { actionBusy = false; button.disabled = false; }
});

function openEditor(word) {
  stopAudio(); editGeneration++; editWord = word || null; pendingAudio = null; dirty = false;
  $('#word-form').reset(); $('#editor-error').textContent = '';
  $('#editor-title').textContent = word ? '词条详情' : '添加字词';
  $('#word-text').value = word?.text || ''; $('#word-note').value = word?.note || ''; $('#word-favorite').checked = word?.favorite || false;
  $('#delete-word').hidden = !word;
  $('#word-stats').textContent = word ? `累计答对 ${word.correct} 次 · 答错 ${word.wrong} 次${word.mistake ? ` · 易错词：连续答对 ${word.streak}/3 次` : ''}` : '';
  $('#record-status').textContent = word?.hasAudio ? '已保存一段读音' : '给这个词留一段读音';
  $('#record-hint').textContent = word?.hasAudio ? '重新录制后，点击保存才会替换旧录音' : '可以现在录音，也可以保存后再补录';
  $('#record-button').textContent = word?.hasAudio ? '重新录音' : '开始录音';
  $('#preview-button').disabled = !word?.hasAudio;
  $('#save-word').disabled = false; $('#record-button').disabled = false;
  editor.showModal();
}
function closeEditor() {
  if (saving) return false;
  if ((dirty || recording || requestingMic) && !confirm('还有未保存的内容，确定放弃并离开吗？')) return false;
  editGeneration++; stopAudio(); clearInterval(timer);
  for (const entry of audioCache.values()) if (entry.url) discardAudio(entry);
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  stream?.getTracks().forEach(track => track.stop());
  recording = false; requestingMic = false; stream = null; pendingAudio = null; dirty = false;
  $('#record-button').classList.remove('is-recording'); editor.close(); return true;
}
$('#close-editor').onclick = closeEditor;
editor.addEventListener('cancel', event => { event.preventDefault(); closeEditor(); });
$('#word-form').addEventListener('input', () => { dirty = true; });
window.addEventListener('beforeunload', event => { if (dirty || recording || requestingMic || saving) { event.preventDefault(); event.returnValue = ''; } });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && recording && recorder?.state === 'recording') { recorder.stop(); toast('录音已暂停，请试听后保存'); }
  if (!document.hidden && ready && !editor.open && !actionBusy) refresh().then(render).catch(error => toast(error.message));
});
$('#record-button').onclick = async () => {
  if (recording) { if (recorder?.state === 'recording') recorder.stop(); return; }
  if (requestingMic || saving) return;
  $('#editor-error').textContent = '';
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) { $('#editor-error').textContent = '手机录音需要通过 HTTPS 打开网站。请使用配置好的 HTTPS 网址，并允许麦克风权限。'; return; }
  if (!window.MediaRecorder) { $('#editor-error').textContent = '当前浏览器不支持录音，请使用新版 Safari、Chrome 或 Edge。'; return; }
  const generation = editGeneration;
  requestingMic = true; $('#record-button').disabled = true; $('#save-word').disabled = true;
  $('#record-status').textContent = '正在等待麦克风授权…';
  try {
    const input = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (generation !== editGeneration) { input.getTracks().forEach(track => track.stop()); return; }
    stream = input; stopAudio();
    const mimeType = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type));
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const currentRecorder = recorder, chunks = [];
    let bytes = 0, failed = false;
    const started = Date.now();
    recorder.ondataavailable = event => { if (event.data.size) { chunks.push(event.data); bytes += event.data.size; if (bytes > 8 * 1024 * 1024 && currentRecorder.state === 'recording') currentRecorder.stop(); } };
    recorder.onerror = () => { failed = true; if (currentRecorder.state === 'recording') currentRecorder.stop(); };
    recorder.onstop = () => {
      input.getTracks().forEach(track => track.stop());
      if (generation !== editGeneration) return;
      clearInterval(timer); recording = false; stream = null;
      $('#record-button').disabled = false; $('#save-word').disabled = false; $('#record-button').classList.remove('is-recording');
      const blob = new Blob(chunks, { type: currentRecorder.mimeType || chunks[0]?.type });
      if (failed || !blob.size || blob.size > 8 * 1024 * 1024) {
        $('#editor-error').textContent = '这次录音未成功或超过 8 MB，请重新录制。原有录音没有被替换。';
        $('#record-status').textContent = '录音未完成';
      } else {
        pendingAudio = blob; dirty = true;
        $('#record-status').textContent = '录好了，听听是否清楚';
        $('#record-hint').textContent = '这段读音尚未保存，确认后点击“保存词条”';
      }
      $('#record-button').textContent = '重新录音'; $('#preview-button').disabled = !(pendingAudio || editWord?.hasAudio);
    };
    recorder.start(1000); recording = true; dirty = true;
    $('#preview-button').disabled = true; $('#record-button').disabled = false; $('#record-button').textContent = '停止录音'; $('#record-button').classList.add('is-recording');
    const updateTime = () => {
      const seconds = Math.floor((Date.now() - started) / 1000);
      $('#record-status').textContent = `正在录音 ${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
      if (seconds >= 180 && currentRecorder.state === 'recording') currentRecorder.stop();
    };
    updateTime(); timer = setInterval(updateTime, 250); $('#record-hint').textContent = '清楚地读一遍即可，最长 3 分钟';
  } catch (error) {
    if (generation !== editGeneration) return;
    stream?.getTracks().forEach(track => track.stop()); stream = null;
    $('#editor-error').textContent = error.name === 'NotAllowedError' ? '麦克风未获授权，请在浏览器的网站权限中允许麦克风，然后重试。' : error.name === 'NotFoundError' ? '没有找到麦克风，请检查设备后重试。' : '无法开始录音，请关闭其他占用麦克风的应用后重试。';
    $('#record-status').textContent = '尚未开始录音'; $('#record-button').disabled = false; $('#save-word').disabled = false;
  } finally { if (generation === editGeneration) requestingMic = false; }
};
$('#preview-button').onclick = () => play(editWord?.id, pendingAudio);
function lockEditor(locked) {
  saving = locked;
  $('#word-form').querySelectorAll('input,textarea,button').forEach(element => { element.disabled = locked; });
  if (!locked) $('#preview-button').disabled = !(pendingAudio || editWord?.hasAudio);
}
$('#word-form').onsubmit = async event => {
  event.preventDefault();
  if (saving || recording || requestingMic) return;
  const text = $('#word-text').value.trim();
  if (!text) { $('#editor-error').textContent = '请填写字词，不能只有空格'; $('#word-text').focus(); return; }
  lockEditor(true);
  $('#editor-error').textContent = '';
  try {
    const saved = await db.saveWord({ id: editWord?.id, version: editWord?.version, text, note: $('#word-note').value, favorite: $('#word-favorite').checked }, pendingAudio);
    words = [...words.filter(word => word.id !== saved.id), saved];
    dirty = false; saving = false; closeEditor(); render(); toast('已保存到你的词库');
  } catch (error) { $('#editor-error').textContent = error.message; }
  finally { lockEditor(false); }
};
$('#delete-word').onclick = async () => {
  if (saving || recording || requestingMic || !confirm(`删除“${editWord.text}”及它的录音和学习记录？此操作无法撤销。`)) return;
  lockEditor(true);
  try {
    await db.removeWord(editWord.id, editWord.version);
    words = words.filter(word => word.id !== editWord.id); dirty = false; saving = false; closeEditor();
    try { await refresh(); } catch { toast('删除已保存，词库暂时未刷新'); }
    render(); toast('词条已删除');
  } catch (error) { $('#editor-error').textContent = error.message; }
  finally { lockEditor(false); }
};

const loginDialog = $('#login-dialog');
window.addEventListener('login-required', () => { clearAudioCache(); if (!loginDialog.open) loginDialog.showModal(); });
loginDialog.addEventListener('cancel', event => event.preventDefault());
$('#login-form').onsubmit = async event => {
  event.preventDefault(); const button = $('#login-form button'); button.disabled = true; $('#login-error').textContent = '';
  try {
    await db.request('/login', 'POST', { username: $('#username').value, password: $('#password').value });
    $('#password').value = ''; loginDialog.close(); await initialize();
  } catch (error) { $('#login-error').textContent = error.message; if (!loginDialog.open) loginDialog.showModal(); }
  finally { button.disabled = false; }
};
$('#logout').onclick = async () => {
  if (!confirm('退出登录？已保存的词条和复习记录会保留。')) return;
  try { await db.request('/logout', 'POST', {}); clearAudioCache(); ready = false; words = []; round = null; $('#main').innerHTML = ''; $('#logout').hidden = true; $('#refresh').hidden = true; loginDialog.showModal(); }
  catch (error) { toast(error.message); }
};
$('#refresh').onclick = async () => { if (!ready || actionBusy) return; try { await refresh(); render(); toast('已更新到最新记录'); } catch (error) { toast(error.message); } };
async function initialize() {
  try {
    await db.request('/session'); await refresh(); ready = true;
    $('#logout').hidden = false; $('#refresh').hidden = false;
    page = ['words', 'review', 'mistakes'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'words';
    reviewMode = round && round.answers.length < round.ids.length ? 'active' : 'setup'; render();
  } catch (error) {
    if (error.status !== 401) { $('#main').innerHTML = `<div class="empty-state"><h2>暂时连不上词库</h2><p>${escape(error.message)}</p><button id="reload-app" class="button primary">重新连接</button></div>`; $('#reload-app').onclick = initialize; }
  }
}
initialize();
