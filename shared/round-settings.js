export function defaultRoundSettings(playMode, durationSeconds = 180) {
  return Array.from({ length: 4 }, (_, index) => ({ durationSeconds, answerSeconds: playMode === 'typing' && index === 3 ? 12 : 0 }));
}

export function validateRoundSettings(settings, placementSeconds, playMode) {
  if (!Array.isArray(settings) || settings.length !== 4) throw new Error('네 라운드의 시간을 모두 정해 주세요.');
  const rounds = settings.map((entry, index) => {
    if (!Number.isInteger(entry?.durationSeconds) || entry.durationSeconds < 30 || entry.durationSeconds > 600) throw new Error('라운드 시간은 30~600초로 정해 주세요.');
    const minimum = playMode === 'typing' && index === 3 ? 1 : 0;
    if (!Number.isInteger(entry.answerSeconds) || entry.answerSeconds < minimum || entry.answerSeconds > 120) throw new Error('문제당 시간은 1~120초 또는 제한 없음으로 정해 주세요. 릴레이는 제한 시간이 필요해요.');
    return { durationSeconds: entry.durationSeconds, answerSeconds: entry.answerSeconds };
  });
  if (!Number.isInteger(placementSeconds) || placementSeconds < 10 || placementSeconds > 120) throw new Error('타자 테스트 시간은 10~120초로 정해 주세요.');
  return rounds;
}
