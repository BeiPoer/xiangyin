export async function request(path, method = 'GET', body) {
  let response;
  try {
    response = await fetch(`/api${path}`, {
      method, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-App-Request': '1' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch { throw new Error('网络连接失败，内容已保留，请检查网络后重试'); }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401 && path !== '/login') window.dispatchEvent(new Event('login-required'));
    throw Object.assign(new Error(payload.error || '操作失败，请稍后重试'), { status: response.status });
  }
  return response.json();
}
export const allWords = () => request('/words');
export const patchWord = (id, patch) => request(`/words/${id}`, 'PATCH', patch);
export const removeWord = (id, version) => request(`/words/${id}`, 'DELETE', { version });
export const getRound = () => request('/review');
export const startRound = (scope, count, previousId) => request('/review', 'POST', { scope, count, previousId });
export const answerRound = (roundId, wordId, correct) => request('/review/answer', 'POST', { roundId, wordId, correct });
export async function saveWord(word, audio) {
  let recording;
  if (audio) {
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.slice(reader.result.lastIndexOf(',') + 1));
      reader.onerror = () => reject(new Error('无法读取录音，请重试'));
      reader.readAsDataURL(audio);
    });
    recording = { data, mime: audio.type };
  }
  return request('/words', 'POST', { ...word, recording });
}
