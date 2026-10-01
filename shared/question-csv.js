export const MAX_CSV_BYTES = 256 * 1024;
export const MAX_CUSTOM_QUESTIONS = 200;
const REQUIRED_HEADERS = ['문제', '보기1', '보기2', '보기3', '보기4', '정답'];
const OPTIONAL_HEADERS = ['해설', '분류'];

// CSV supports quoted commas, double quotes and line breaks (including Excel CRLF).
export function readCsvRows(input) {
  if (typeof input !== 'string') throw new Error('CSV 파일을 읽을 수 없어요.');
  const text = input.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let closedQuote = false;
  let line = 1;
  let rowLine = 1;
  function pushCell() { row.push(cell.trim()); cell = ''; closedQuote = false; }
  function pushRow() {
    pushCell();
    if (row.some(Boolean)) rows.push({ cells: row, line: rowLine });
    row = [];
  }
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { cell += '"'; index += 1; }
        else { quoted = false; closedQuote = true; }
      } else {
        cell += char;
        if (char === '\n') line += 1;
      }
      continue;
    }
    if (char === ',') { pushCell(); continue; }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      pushRow(); line += 1; rowLine = line;
      continue;
    }
    if (closedQuote) {
      if (char === ' ' || char === '\t') continue;
      throw new Error(`${line}행: 닫는 따옴표 뒤에는 쉼표나 줄바꿈이 필요해요.`);
    }
    if (char === '"') {
      if (cell.trim()) throw new Error(`${line}행: 문장 속 따옴표는 큰따옴표 두 개로 적어 주세요.`);
      cell = ''; quoted = true;
    } else cell += char;
  }
  if (quoted) throw new Error(`${rowLine}행: 닫히지 않은 큰따옴표가 있어요.`);
  pushRow();
  return rows;
}

function field(value, name, maxLength, required = true) {
  if (typeof value !== 'string') throw new Error(`${name}을(를) 확인해 주세요.`);
  const result = value.trim();
  if (required && !result) throw new Error(`${name}이(가) 비어 있어요.`);
  if (result.length > maxLength) throw new Error(`${name}은(는) ${maxLength}자 이내로 적어 주세요.`);
  return result;
}

function validateQuestion(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('문제 형식을 확인해 주세요.');
  const meaning = field(value.meaning, '문제', 500);
  if (!Array.isArray(value.choices) || value.choices.length !== 4) throw new Error('보기는 반드시 4개여야 해요.');
  const choices = value.choices.map((choice, index) => field(choice, `보기${index + 1}`, 200));
  if (new Set(choices).size !== 4) throw new Error('같은 보기가 두 번 있어요. 보기 4개를 다르게 적어 주세요.');
  const answer = field(value.answer, '정답', 200);
  if (!choices.includes(answer)) throw new Error('정답은 보기1~4 중 하나여야 해요.');
  return {
    meaning, choices, answer,
    explanation: field(value.explanation ?? '', '해설', 1000, false),
    category: field(value.category ?? '', '분류', 40, false) || '선생님 문제',
  };
}

// The server validates again: browser validation never grants upload permission.
export function validateCustomQuestions(input) {
  if (!Array.isArray(input) || input.length === 0) throw new Error('문제를 한 개 이상 넣어 주세요.');
  if (input.length > MAX_CUSTOM_QUESTIONS) throw new Error(`문제는 최대 ${MAX_CUSTOM_QUESTIONS}개까지 넣을 수 있어요.`);
  const questions = input.map((question, index) => {
    try { return validateQuestion(question); }
    catch (error) { throw new Error(`${index + 1}번째 문제: ${error.message}`); }
  });
  if (new TextEncoder().encode(JSON.stringify(questions)).length > MAX_CSV_BYTES) throw new Error('문제 내용이 너무 커요. 파일을 나눠 올려 주세요.');
  return questions;
}

export function parseQuestionCsv(input) {
  if (typeof input !== 'string' || new TextEncoder().encode(input).length > MAX_CSV_BYTES) throw new Error('CSV 파일은 256KB 이내로 올려 주세요.');
  const rows = readCsvRows(input);
  if (rows.length === 0) throw new Error('CSV 파일이 비어 있어요. 예시 양식을 내려받아 작성해 주세요.');
  const headers = rows[0].cells;
  if (new Set(headers).size !== headers.length) throw new Error('첫 행에 같은 열 이름이 두 번 있어요.');
  const missing = REQUIRED_HEADERS.filter((name) => !headers.includes(name));
  if (missing.length) throw new Error(`첫 행에 ${missing.join(', ')} 열이 필요해요. 예시 양식을 사용해 주세요.`);
  const unknown = headers.filter((name) => ![...REQUIRED_HEADERS, ...OPTIONAL_HEADERS].includes(name));
  if (unknown.length) throw new Error(`알 수 없는 열: ${unknown.join(', ')}. 예시 양식의 열 이름을 사용해 주세요.`);
  if (rows.length < 2) throw new Error('제목 행 아래에 문제를 한 개 이상 넣어 주세요.');
  if (rows.length - 1 > MAX_CUSTOM_QUESTIONS) throw new Error(`문제는 최대 ${MAX_CUSTOM_QUESTIONS}개까지 넣을 수 있어요.`);
  const questions = rows.slice(1).map(({ cells, line }) => {
    try {
      if (cells.length !== headers.length) throw new Error(`열 개수가 ${headers.length}개여야 해요. 쉼표가 있는 문장은 큰따옴표로 감싸 주세요.`);
      const get = (name) => cells[headers.indexOf(name)] || '';
      const choices = [1, 2, 3, 4].map((index) => get(`보기${index}`));
      const answer = get('정답');
      return validateQuestion({ meaning: get('문제'), choices, answer: /^[1-4]$/.test(answer) ? choices[Number(answer) - 1] : answer, explanation: get('해설'), category: get('분류') });
    } catch (error) { throw new Error(`${line}행: ${error.message}`); }
  });
  return validateCustomQuestions(questions);
}
