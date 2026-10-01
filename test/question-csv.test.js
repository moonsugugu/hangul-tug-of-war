import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MAX_CSV_BYTES, MAX_CUSTOM_QUESTIONS, parseQuestionCsv, validateCustomQuestions } from '../shared/question-csv.js';

const headers = '문제,보기1,보기2,보기3,보기4,정답,해설,분류';
const valid = `${headers}\r\n문제입니다,가,나,다,라,2,설명,분류`;

test('예시 CSV는 한글 Excel용 BOM과 보기 4개를 포함하고 그대로 업로드할 수 있어요', async () => {
  const bytes = await readFile(new URL('../public/templates/malmoe-quiz-example.csv', import.meta.url));
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const questions = parseQuestionCsv(bytes.toString('utf8'));
  assert.equal(questions.length, 4);
  assert.deepEqual(questions.map((question) => question.answer), ['윤슬', '백성을 가르치는 바른 소리', '10월 9일', '5']);
});

test('CSV: 쉼표·따옴표·줄바꿈·빈 행·텍스트 정답·열 순서·선택 열', () => {
  const quoted = `${headers}\r\n"쉼표, 따옴표 ""예시""\n두 번째 줄",가,나,다,라,라,"풀이, 예시",\r\n\r\n`;
  const [question] = parseQuestionCsv(`\uFEFF${quoted}`);
  assert.equal(question.meaning, '쉼표, 따옴표 "예시"\n두 번째 줄');
  assert.equal(question.answer, '라');
  assert.equal(question.explanation, '풀이, 예시');
  assert.equal(question.category, '선생님 문제');
  const minimal = '정답,보기4,보기3,보기2,보기1,문제\n1,라,다,나,가,질문';
  assert.equal(parseQuestionCsv(minimal)[0].answer, '가');
  assert.equal(parseQuestionCsv(minimal)[0].explanation, '');
});

test('CSV: 잘못된 행은 위치와 오류를 알려 줘요', () => {
  assert.throws(() => parseQuestionCsv(''), /비어/);
  assert.throws(() => parseQuestionCsv(headers), /한 개 이상/);
  assert.throws(() => parseQuestionCsv('질문,보기1\n문제,가'), /문제.*열/);
  assert.throws(() => parseQuestionCsv(`${headers},정답\n문제,가,나,다,라,1,,,1`), /같은 열/);
  assert.throws(() => parseQuestionCsv(`${headers},추가\n문제,가,나,다,라,1,,,추가`), /알 수 없는 열/);
  assert.throws(() => parseQuestionCsv(valid.replace('가,나,다,라', '가,가,다,라')), /2행.*같은 보기/);
  assert.throws(() => parseQuestionCsv(valid.replace(',2,설명', ',5,설명')), /2행.*정답/);
  assert.throws(() => parseQuestionCsv(valid.replace('문제입니다,', ',')), /2행.*문제/);
  assert.throws(() => parseQuestionCsv(valid.replace(',나,', ',,')), /2행.*보기2/);
  assert.throws(() => parseQuestionCsv(valid.replace(',설명,분류', ',설명')), /2행.*열 개수/);
  assert.throws(() => parseQuestionCsv(`${headers}\n"닫히지 않은 질문`), /2행.*닫히지/);
  assert.throws(() => parseQuestionCsv(`${headers}\n"질문"내용,가,나,다,라,1,,`), /2행.*닫는 따옴표/);
  assert.throws(() => parseQuestionCsv('가'.repeat(MAX_CSV_BYTES)), /256KB/);
});

test('서버 검증: 빈 배열·과다 문제·중복 보기·없는 정답·긴 문자열을 거부해요', () => {
  const [question] = parseQuestionCsv(valid);
  assert.throws(() => validateCustomQuestions([]), /한 개 이상/);
  assert.throws(() => validateCustomQuestions(Array(MAX_CUSTOM_QUESTIONS + 1).fill(question)), /최대 200/);
  assert.throws(() => validateCustomQuestions([{ ...question, choices: ['가', '가', '나', '다'] }]), /같은 보기/);
  assert.throws(() => validateCustomQuestions([{ ...question, answer: '없는 답' }]), /정답/);
  assert.throws(() => validateCustomQuestions([{ ...question, meaning: '가'.repeat(501) }]), /500자/);
  assert.equal(validateCustomQuestions([question])[0].answer, '나');
});
