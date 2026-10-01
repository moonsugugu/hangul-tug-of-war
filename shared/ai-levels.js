// A local computer opponent: higher levels answer faster and more accurately.
export const AI_LEVELS = [
  { level: 1, label: '첫 연습', accuracy: 0.35, quizDelayMs: 12_000, typingCpm: 35 },
  { level: 2, label: '느긋하게', accuracy: 0.43, quizDelayMs: 10_500, typingCpm: 50 },
  { level: 3, label: '천천히', accuracy: 0.51, quizDelayMs: 9_000, typingCpm: 65 },
  { level: 4, label: '가볍게', accuracy: 0.59, quizDelayMs: 7_500, typingCpm: 85 },
  { level: 5, label: '보통', accuracy: 0.67, quizDelayMs: 6_000, typingCpm: 110 },
  { level: 6, label: '집중', accuracy: 0.75, quizDelayMs: 4_800, typingCpm: 140 },
  { level: 7, label: '빠르게', accuracy: 0.83, quizDelayMs: 3_700, typingCpm: 180 },
  { level: 8, label: '도전', accuracy: 0.89, quizDelayMs: 2_800, typingCpm: 230 },
  { level: 9, label: '고수', accuracy: 0.94, quizDelayMs: 2_000, typingCpm: 300 },
  { level: 10, label: '최강', accuracy: 0.98, quizDelayMs: 1_200, typingCpm: 400 },
];

export function getAiLevel(level) {
  return AI_LEVELS.find((entry) => entry.level === level);
}

export function getAiAnswerDelay(level, prompt, random = Math.random) {
  const settings = getAiLevel(level);
  if (!settings || !prompt) return 0;
  const text = prompt.word || prompt.question || prompt.prompt || '';
  const base = prompt.kind === 'quiz' ? settings.quizDelayMs : [...text].length / settings.typingCpm * 60_000;
  return Math.round(Math.max(750, base * (0.9 + random() * 0.2)));
}
