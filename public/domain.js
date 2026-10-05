export function eligible(words, scope) {
  return words.filter(word => word.hasAudio && (scope === 'favorites' ? word.favorite : scope === 'mistakes' ? word.mistake : true));
}

export function makeRound(words, scope, count, random = Math.random) {
  const pool = eligible(words, scope).map(word => word.id);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return { ids: pool.slice(0, count === 'all' ? pool.length : Number(count)), answers: [] };
}

export function grade(word, correct) {
  const streak = correct ? word.streak + 1 : 0;
  return {
    ...word,
    correct: word.correct + Number(correct),
    wrong: word.wrong + Number(!correct),
    streak,
    mistake: correct ? word.mistake && streak < 3 : true,
  };
}

export function score(round) {
  const correct = round.answers.filter(answer => answer.correct).length;
  return { correct, wrong: round.answers.length - correct, total: round.answers.length,
    accuracy: round.answers.length ? Math.round(correct / round.answers.length * 100) : 0 };
}
