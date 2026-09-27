import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { WebSocketServer } from 'ws';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const PORT = Number(process.env.PORT || 8787);
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const REFERENCE_CPM = 120;
const RELAY_LIMIT_MS = 12_000;
const ROUND_MULTIPLIERS = [1, 1.1, 1.3, 1.5, 1.5];
const ROUND_DURATION_MS = Number(process.env.ROUND_DURATION_MS || 180_000);
const OVERTIME_MS = Number(process.env.OVERTIME_MS || 10_000);
const INTERMISSION_MS = Number(process.env.INTERMISSION_MS || 4_000);
const WHEEL_DURATION_MS = Number(process.env.WHEEL_DURATION_MS || 7_000);
const PLACEMENT_MS = Number(process.env.PLACEMENT_MS || 30_000);
const TEAM_REVEAL_MS = Number(process.env.TEAM_REVEAL_MS || 7_000);
const ROPE_MAX_STEPS = 10;
const ROPE_POINTS_PER_STEP = 75;
const MAX_PLAYERS_PER_ROOM = 30;
const CHARACTER_IDS = ['rabbit', 'bear', 'cat', 'chick', 'panda', 'sheep', 'fox', 'penguin'];

const WORD_PROMPTS = [
  { word: '윤슬', meaning: '햇빛이나 달빛이 물결에 비쳐 반짝이는 모습', example: '강물 위로 윤슬이 반짝였습니다.', category: '자연' },
  { word: '여우비', meaning: '햇빛이 있는 날 잠깐 내리는 비', example: '맑은 하늘에서 여우비가 내렸습니다.', category: '자연' },
  { word: '너울', meaning: '큰 물결', example: '바다에 너울이 일었습니다.', category: '자연' },
  { word: '모꼬지', meaning: '여러 사람이 모이는 일', example: '친구들과 즐거운 모꼬지를 열었습니다.', category: '모임' },
  { word: '미리내', meaning: '은하수', example: '밤하늘에 미리내가 흐릅니다.', category: '자연' },
  { word: '도란도란', meaning: '여럿이 정답게 이야기하는 모양', example: '아이들이 도란도란 이야기를 나눕니다.', category: '말맛' },
  { word: '가람', meaning: '강', example: '가람을 따라 마을이 이어졌습니다.', category: '자연' },
  { word: '아람', meaning: '잘 익은 열매가 알맞게 벌어진 모양', example: '가을 나무에 아람이 가득 열렸습니다.', category: '자연' },
  { word: '마루', meaning: '산이나 지붕의 가장 높은 곳', example: '산마루에 아침 해가 떠올랐습니다.', category: '자연' },
  { word: '나래', meaning: '날개', example: '새가 나래를 활짝 펼쳤습니다.', category: '자연' },
  { word: '누리', meaning: '세상', example: '누리 곳곳에 한글의 아름다움을 알려요.', category: '마음' },
  { word: '겨레', meaning: '같은 핏줄이나 문화를 가진 사람들', example: '우리 겨레는 오랜 시간 우리말을 지켜 왔습니다.', category: '마음' },
  { word: '샛별', meaning: '새벽 무렵 동쪽 하늘에 보이는 밝은 별', example: '샛별이 떠오르는 이른 아침입니다.', category: '자연' },
  { word: '한가위', meaning: '추석을 이르는 우리말', example: '한가위 보름달처럼 풍성한 하루를 보내요.', category: '문화' },
  { word: '여울', meaning: '강이나 바다의 얕고 빠르게 흐르는 곳', example: '아이들이 여울물에 발을 담갔습니다.', category: '자연' },
  { word: '꽃보라', meaning: '흩날리는 꽃잎을 눈보라에 빗대어 이르는 말', example: '벚꽃 꽃보라가 길 위에 내려앉았습니다.', category: '자연' },
  { word: '시나브로', meaning: '모르는 사이에 조금씩', example: '시나브로 봄이 우리 곁에 왔습니다.', category: '움직임' },
  { word: '오롯이', meaning: '모자람 없이 온전하게', example: '오늘은 책 읽기에 마음을 오롯이 써 보아요.', category: '마음' },
  { word: '바투', meaning: '두 대상 사이가 썩 가깝게', example: '친구와 바투 앉아 이야기를 들었습니다.', category: '모양' },
  { word: '해거름', meaning: '해가 서쪽으로 넘어갈 무렵', example: '해거름에 운동장에 긴 그림자가 생겼습니다.', category: '자연' },
  { word: '어스름', meaning: '조금 어둑한 빛이나 그때의 시간', example: '어스름이 내리자 등불을 밝혔습니다.', category: '자연' },
  { word: '곰살궂다', meaning: '성질이 부드럽고 다정하다', example: '곰살궂은 말 한마디가 친구를 웃게 했습니다.', category: '마음' },
  { word: '살뜰하다', meaning: '정성스럽고 알뜰하다', example: '서로를 살뜰하게 돌보는 교실입니다.', category: '마음' },
  { word: '소담하다', meaning: '모양이 탐스럽고 보기 좋다', example: '소담한 글씨로 한글날 카드를 꾸몄습니다.', category: '모양' },
  { word: '고즈넉하다', meaning: '고요하고 아늑하다', example: '고즈넉한 한옥 마을을 걸었습니다.', category: '모양' },
  { word: '아늑하다', meaning: '포근하고 편안한 느낌이 있다', example: '우리말 책이 있는 교실은 아늑합니다.', category: '마음' },
  { word: '해사하다', meaning: '얼굴이 맑고 밝다', example: '아이들의 해사한 웃음이 운동장을 채웠습니다.', category: '모양' },
  { word: '알음알음', meaning: '서로 아는 관계를 통하여', example: '알음알음 모인 친구들이 한글 퀴즈를 풀었습니다.', category: '모임' },
  { word: '살랑살랑', meaning: '바람이 가볍게 부는 모양', example: '깃발이 살랑살랑 흔들렸습니다.', category: '움직임' },
  { word: '포슬포슬', meaning: '눈이나 가루가 부드럽게 쌓인 모양', example: '포슬포슬 내린 눈 위에 발자국이 남았습니다.', category: '모양' },
  { word: '몽글몽글', meaning: '작은 덩이가 여럿 모여 부드러운 모양', example: '구름이 몽글몽글 피어올랐습니다.', category: '모양' },
  { word: '가만가만', meaning: '움직임이나 말소리가 조용한 모양', example: '가만가만 문장을 읽어 보았습니다.', category: '움직임' },
  { word: '두루두루', meaning: '빠짐없이 골고루', example: '우리말의 아름다움을 두루두루 알아보아요.', category: '마음' },
  { word: '달보드레', meaning: '달콤하고 부드러운 느낌', example: '달보드레한 가을밤의 공기를 느꼈습니다.', category: '느낌' },
  { word: '아지랑이', meaning: '봄날 햇볕에 아른거리는 공기', example: '들판 위로 아지랑이가 피어올랐습니다.', category: '자연' },
  { word: '바람꽃', meaning: '바람에 흔들리며 피어 있는 작은 꽃', example: '들판에 바람꽃이 피었습니다.', category: '자연' },
  { word: '다솜', meaning: '사랑', example: '다솜을 담아 친구에게 따뜻한 말을 건넸습니다.', category: '마음' },
  { word: '온새미로', meaning: '가르거나 쪼개지 않고 생긴 그대로', example: '자연을 온새미로 바라보며 글을 썼습니다.', category: '마음' },
  { word: '보듬다', meaning: '두 팔로 감싸 품다', example: '서로의 실수를 보듬는 마음이 필요합니다.', category: '마음' },
  { word: '새벽녘', meaning: '새벽 무렵', example: '새벽녘 하늘에 샛별이 빛났습니다.', category: '자연' },
  { word: '노을', meaning: '해가 뜨거나 질 때 하늘이 붉게 물드는 현상', example: '서쪽 하늘이 노을로 붉게 물들었습니다.', category: '자연' },
  { word: '이슬', meaning: '밤사이 풀잎 등에 맺힌 작은 물방울', example: '아침 풀잎마다 이슬이 맺혔습니다.', category: '자연' },
  { word: '산들바람', meaning: '시원하고 가볍게 부는 바람', example: '산들바람에 나뭇잎이 흔들렸습니다.', category: '자연' },
  { word: '하늬바람', meaning: '서쪽에서 부는 바람', example: '가을 하늬바람이 들판을 지나갔습니다.', category: '자연' },
  { word: '마파람', meaning: '남쪽에서 부는 바람', example: '따뜻한 마파람이 불어왔습니다.', category: '자연' },
  { word: '된서리', meaning: '늦가을에 아주 세게 내린 서리', example: '된서리가 내려 들판이 하얘졌습니다.', category: '자연' },
  { word: '함박눈', meaning: '굵고 탐스럽게 내리는 눈', example: '운동장에 함박눈이 소복이 쌓였습니다.', category: '자연' },
  { word: '보슬비', meaning: '바람 없이 가늘고 조용히 내리는 비', example: '보슬비가 창밖에 조용히 내렸습니다.', category: '자연' },
  { word: '소나기', meaning: '갑자기 세차게 쏟아지다가 곧 그치는 비', example: '소나기가 지나가자 무지개가 떴습니다.', category: '자연' },
  { word: '꽃샘추위', meaning: '이른 봄, 꽃이 필 무렵에 찾아오는 추위', example: '꽃샘추위에 두꺼운 옷을 다시 꺼냈습니다.', category: '자연' },
  { word: '늦더위', meaning: '여름이 다 지나도 가시지 않는 더위', example: '구월인데도 늦더위가 이어졌습니다.', category: '자연' },
  { word: '해돋이', meaning: '해가 막 솟아오르는 때나 그 모습', example: '새해 첫날 해돋이를 보러 갔습니다.', category: '자연' },
  { word: '달무리', meaning: '달 둘레에 둥그렇게 생기는 허연 테', example: '보름달 둘레에 달무리가 졌습니다.', category: '자연' },
  { word: '별똥별', meaning: '밤하늘에 빛을 내며 떨어지는 별', example: '별똥별을 보며 소원을 빌었습니다.', category: '자연' },
  { word: '구름바다', meaning: '높은 곳에서 내려다본, 바다처럼 넓게 깔린 구름', example: '산꼭대기에서 구름바다를 내려다보았습니다.', category: '자연' },
  { word: '볕뉘', meaning: '작은 틈으로 잠깐 비치는 햇볕', example: '창틈으로 볕뉘가 들어왔습니다.', category: '자연' },
  { word: '꽃망울', meaning: '아직 피지 않은 어린 꽃봉오리', example: '개나리 가지에 꽃망울이 맺혔습니다.', category: '자연' },
  { word: '우듬지', meaning: '나무의 꼭대기 줄기', example: '까치가 우듬지에 둥지를 틀었습니다.', category: '자연' },
  { word: '떡잎', meaning: '씨앗에서 싹이 틀 때 처음 나오는 잎', example: '강낭콩에서 떡잎 두 장이 나왔습니다.', category: '자연' },
  { word: '개울', meaning: '골짜기나 들에 흐르는 작은 물줄기', example: '개울물이 맑게 흘렀습니다.', category: '자연' },
  { word: '오솔길', meaning: '폭이 좁고 호젓한 길', example: '숲속 오솔길을 따라 걸었습니다.', category: '자연' },
  { word: '고샅', meaning: '시골 마을의 좁은 골목길', example: '아이들이 고샅을 뛰어다녔습니다.', category: '자연' },
  { word: '들녘', meaning: '들이 펼쳐진 곳', example: '가을 들녘이 황금빛으로 물들었습니다.', category: '자연' },
  { word: '뫼', meaning: '산', example: '높은 뫼 위로 흰 구름이 걸렸습니다.', category: '자연' },
  { word: '잔물결', meaning: '자잘하게 이는 물결', example: '호수에 잔물결이 일었습니다.', category: '자연' },
  { word: '한살이', meaning: '생물이 태어나서 죽을 때까지의 과정', example: '배추흰나비의 한살이를 관찰했습니다.', category: '자연' },
  { word: '두레', meaning: '농사일을 함께하려고 마을 사람들이 만든 모임', example: '옛날에는 두레를 짜서 모내기를 했습니다.', category: '모임' },
  { word: '품앗이', meaning: '힘든 일을 서로 거들어 주며 품을 주고받는 일', example: '이웃끼리 품앗이로 김장을 했습니다.', category: '모임' },
  { word: '너나들이', meaning: '서로 너, 나 하고 부르며 터놓고 지내는 사이', example: '우리는 어릴 때부터 너나들이하는 사이입니다.', category: '모임' },
  { word: '동무', meaning: '늘 친하게 어울리는 사람', example: '동무들과 함께 줄넘기를 했습니다.', category: '모임' },
  { word: '어깨동무', meaning: '서로 팔을 어깨에 얹고 나란히 서는 일', example: '친구와 어깨동무를 하고 걸었습니다.', category: '모임' },
  { word: '마중', meaning: '오는 사람을 나가서 맞이하는 일', example: '할머니를 마중하러 역에 갔습니다.', category: '모임' },
  { word: '배웅', meaning: '떠나는 사람을 따라 나가 작별하여 보내는 일', example: '전학 가는 친구를 배웅했습니다.', category: '모임' },
  { word: '한뉘', meaning: '한평생', example: '한뉘 동안 우리말을 아끼며 살고 싶어요.', category: '마음' },
  { word: '설렘', meaning: '마음이 들떠서 두근거리는 느낌', example: '현장 체험 학습 전날 설렘에 잠이 오지 않았습니다.', category: '마음' },
  { word: '슬기', meaning: '일을 바르게 판단하고 잘 처리하는 재능', example: '슬기를 모아 문제를 해결했습니다.', category: '마음' },
  { word: '마음씨', meaning: '마음을 쓰는 태도', example: '친구를 돕는 고운 마음씨를 칭찬했습니다.', category: '마음' },
  { word: '눈썰미', meaning: '한두 번 보고 곧 그대로 해내는 재주', example: '눈썰미가 좋아 종이접기를 금방 따라 했습니다.', category: '마음' },
  { word: '너그럽다', meaning: '마음이 넓고 속이 깊다', example: '너그러운 마음으로 친구의 사과를 받아 주었습니다.', category: '마음' },
  { word: '미쁘다', meaning: '믿음직하다', example: '약속을 잘 지키는 미쁜 친구입니다.', category: '마음' },
  { word: '다부지다', meaning: '굳세고 야무지다', example: '다부진 목소리로 발표를 했습니다.', category: '마음' },
  { word: '해맑다', meaning: '티 없이 맑고 깨끗하다', example: '동생이 해맑게 웃었습니다.', category: '모양' },
  { word: '정갈하다', meaning: '깨끗하고 깔끔하다', example: '정갈하게 정리된 책상에서 공부했습니다.', category: '모양' },
  { word: '옹골차다', meaning: '속이 꽉 차서 실속이 있다', example: '옹골차게 여문 밤을 주웠습니다.', category: '모양' },
  { word: '맞춤하다', meaning: '넘치거나 모자라지 않고 꼭 알맞다', example: '신발이 발에 맞춤하게 꼭 맞았습니다.', category: '모양' },
  { word: '알록달록', meaning: '여러 빛깔이 고르지 않게 뒤섞인 모양', example: '알록달록한 단풍잎을 모았습니다.', category: '모양' },
  { word: '옹기종기', meaning: '작은 것들이 고르지 않게 많이 모여 있는 모양', example: '아이들이 옹기종기 모여 앉았습니다.', category: '모양' },
  { word: '뭉게뭉게', meaning: '구름이나 연기가 둥글게 잇따라 피어오르는 모양', example: '하늘에 흰 구름이 뭉게뭉게 피었습니다.', category: '모양' },
  { word: '새근새근', meaning: '어린아이가 곤히 잠들어 조용히 숨 쉬는 소리', example: '아기가 새근새근 잠들었습니다.', category: '말맛' },
  { word: '소곤소곤', meaning: '작은 목소리로 가만가만 이야기하는 소리', example: '도서관에서 소곤소곤 이야기했습니다.', category: '말맛' },
  { word: '졸졸', meaning: '가는 물줄기가 부드럽게 흐르는 소리', example: '시냇물이 졸졸 흘렀습니다.', category: '말맛' },
  { word: '너스레', meaning: '수다스럽게 떠벌려 늘어놓는 말', example: '삼촌의 너스레에 모두 웃었습니다.', category: '말맛' },
  { word: '익살', meaning: '남을 웃기려고 일부러 하는 말이나 몸짓', example: '익살스러운 표정으로 친구들을 웃겼습니다.', category: '말맛' },
  { word: '사뿐사뿐', meaning: '소리가 나지 않을 만큼 가볍게 걷는 모양', example: '고양이가 사뿐사뿐 걸어왔습니다.', category: '움직임' },
  { word: '성큼성큼', meaning: '다리를 크게 떼어 놓으며 걷는 모양', example: '형이 성큼성큼 앞서 걸었습니다.', category: '움직임' },
  { word: '엉금엉금', meaning: '느릿느릿 걷거나 기는 모양', example: '거북이가 엉금엉금 기어갔습니다.', category: '움직임' },
  { word: '방긋방긋', meaning: '입을 예쁘게 조금 벌리며 소리 없이 웃는 모양', example: '아기가 방긋방긋 웃었습니다.', category: '움직임' },
  { word: '손사래', meaning: '거절하거나 아니라고 할 때 손을 펴서 휘젓는 일', example: '칭찬을 받자 손사래를 쳤습니다.', category: '움직임' },
  { word: '곁눈질', meaning: '얼굴은 그대로 두고 눈만 돌려 옆을 보는 일', example: '시험 중에는 곁눈질을 하지 않아요.', category: '움직임' },
  { word: '갈무리', meaning: '물건을 잘 정리하여 간수하거나 일을 마무리하는 일', example: '수업이 끝나고 학용품을 갈무리했습니다.', category: '움직임' },
  { word: '싱그럽다', meaning: '싱싱하고 향기로운 느낌이 있다', example: '비 온 뒤 숲 냄새가 싱그러웠습니다.', category: '느낌' },
  { word: '따사롭다', meaning: '따뜻한 기운이 있다', example: '따사로운 봄볕이 교실에 들었습니다.', category: '느낌' },
  { word: '포근하다', meaning: '부드럽고 따뜻하다', example: '포근한 이불 속에서 잠이 들었습니다.', category: '느낌' },
  { word: '고요', meaning: '조용하고 잠잠한 상태', example: '밤이 되자 마을에 고요가 찾아왔습니다.', category: '느낌' },
  { word: '설빔', meaning: '설날에 입으려고 새로 마련한 옷이나 신발', example: '설빔으로 고운 한복을 입었습니다.', category: '문화' },
  { word: '널뛰기', meaning: '긴 널빤지 양 끝에 서서 번갈아 뛰어오르는 놀이', example: '설날에 널뛰기를 했습니다.', category: '문화' },
  { word: '달맞이', meaning: '정월 대보름에 산이나 들에 나가 달이 뜨기를 기다려 맞이하는 일', example: '대보름날 언덕에 올라 달맞이를 했습니다.', category: '문화' },
  { word: '까치설', meaning: '설날의 전날', example: '까치설에 가족이 모여 만두를 빚었습니다.', category: '문화' },
];

const WORD_QUIZ_PROMPTS = WORD_PROMPTS.map((prompt, index) => ({
  category: '순우리말',
  meaning: prompt.meaning,
  choices: [prompt.word, WORD_PROMPTS[(index + 7) % WORD_PROMPTS.length].word, WORD_PROMPTS[(index + 15) % WORD_PROMPTS.length].word],
  answer: prompt.word,
  explanation: `${prompt.word}은(는) ‘${prompt.meaning}’이라는 뜻이에요.`,
}));

const HANGUL_CREATION_QUIZ_PROMPTS = [
  { category: '한글 창제', meaning: '훈민정음이 세상에 반포된 해는 언제일까요?', choices: ['1443년', '1446년', '1592년'], answer: '1446년', explanation: '훈민정음은 1443년에 완성되고 1446년에 반포되었습니다.' },
  { category: '한글 창제', meaning: '세종대왕이 훈민정음을 만든 가장 큰 뜻은 무엇일까요?', choices: ['백성이 쉽게 읽고 쓰도록 돕기 위해', '궁궐 장식을 만들기 위해', '외국어를 없애기 위해'], answer: '백성이 쉽게 읽고 쓰도록 돕기 위해', explanation: '세종대왕은 백성이 자신의 생각을 쉽게 표현할 수 있기를 바랐습니다.' },
  { category: '한글 창제', meaning: '훈민정음은 한글의 처음 이름입니다. 맞는 설명은 무엇일까요?', choices: ['백성을 가르치는 바른 소리', '나라를 지키는 큰 노래', '세상을 밝히는 별빛'], answer: '백성을 가르치는 바른 소리', explanation: '훈민정음은 ‘백성을 가르치는 바른 소리’라는 뜻입니다.' },
  { category: '한글 창제', meaning: '한글날은 언제일까요?', choices: ['3월 1일', '10월 9일', '12월 25일'], answer: '10월 9일', explanation: '10월 9일은 한글날로, 훈민정음 반포를 기념합니다.' },
  { category: '한글 창제', meaning: '훈민정음 해례본이 알려 주는 내용은 무엇일까요?', choices: ['창제 원리와 사용 방법', '조선의 음식 조리법', '궁궐의 건축 설계도'], answer: '창제 원리와 사용 방법', explanation: '해례본에는 훈민정음의 원리와 글자를 쓰는 방법이 설명되어 있습니다.' },
  { category: '한글 창제', meaning: '훈민정음의 자음은 무엇을 본떠 만들었을까요?', choices: ['발음할 때의 입과 목 등의 모양', '밤하늘의 별자리', '궁궐의 문양'], answer: '발음할 때의 입과 목 등의 모양', explanation: '기본 자음은 소리를 낼 때의 발음 기관 모양을 본떠 만들었습니다.' },
  { category: '한글 창제', meaning: '훈민정음의 기본 모음이 바탕으로 삼은 것은 무엇일까요?', choices: ['천·지·인', '봄·여름·가을', '산·강·바다'], answer: '천·지·인', explanation: '기본 모음은 하늘, 땅, 사람을 뜻하는 천·지·인을 바탕으로 만들었습니다.' },
  { category: '한글 창제', meaning: '한글의 가장 큰 장점으로 알맞은 것은 무엇일까요?', choices: ['소리와 글자의 관계를 이해하기 쉽다', '오직 왕만 쓸 수 있다', '배우는 데 아주 오랜 시간이 걸린다'], answer: '소리와 글자의 관계를 이해하기 쉽다', explanation: '한글은 소리를 내는 원리와 글자 모양의 관계가 잘 드러납니다.' },
  { category: '한글 창제', meaning: '세종대왕이 훈민정음을 만든 마음과 가장 가까운 것은 무엇일까요?', choices: ['백성을 사랑하는 마음', '경쟁에서 이기려는 마음', '비밀을 숨기려는 마음'], answer: '백성을 사랑하는 마음', explanation: '훈민정음에는 백성을 생각한 세종대왕의 애민 정신이 담겨 있습니다.' },
  { category: '한글 창제', meaning: '오늘 우리가 한글을 지키는 방법으로 알맞은 것은 무엇일까요?', choices: ['우리말을 아끼고 바르게 쓰기', '어려운 말만 골라 쓰기', '다른 사람의 말을 놀리기'], answer: '우리말을 아끼고 바르게 쓰기', explanation: '우리말을 존중하고 정확하게 쓰는 것이 한글 사랑의 시작입니다.' },
];

function shuffledIndexes(length, avoidFirst) {
  const order = Array.from({ length }, (_, index) => index);
  for (let index = length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [order[index], order[swap]] = [order[swap], order[index]];
  }
  if (length > 1 && order[0] === avoidFirst) [order[0], order[1]] = [order[1], order[0]];
  return order;
}

// Each player walks a private shuffled deck that is reshuffled every lap, so
// rounds and players do not all see the same fixed sequence.
function deckIndex(progress, key, length, position) {
  progress.decks ??= {};
  const lap = Math.floor(position / length);
  let deck = progress.decks[key];
  if (!deck || deck.lap !== lap) {
    deck = { lap, order: shuffledIndexes(length, deck?.order[length - 1]) };
    progress.decks[key] = deck;
  }
  return deck.order[position % length];
}

function currentWordPrompt(progress) {
  const index = deckIndex(progress, 'word', WORD_PROMPTS.length, progress.promptIndex);
  return { id: `word-${progress.promptIndex}-${index}`, prompt: WORD_PROMPTS[index] };
}

// Every third quiz question is about Hangul's creation so the large word pool
// does not crowd those questions out.
function currentQuizPrompt(progress) {
  const position = progress.promptIndex;
  if (position % 3 === 2) {
    const index = deckIndex(progress, 'hangul', HANGUL_CREATION_QUIZ_PROMPTS.length, Math.floor(position / 3));
    return { id: `quiz-${position}-hangul-${index}`, prompt: HANGUL_CREATION_QUIZ_PROMPTS[index] };
  }
  const index = deckIndex(progress, 'wordQuiz', WORD_QUIZ_PROMPTS.length, position - Math.floor(position / 3));
  return { id: `quiz-${position}-word-${index}`, prompt: WORD_QUIZ_PROMPTS[index] };
}

function currentPlacementPrompt(progress) {
  const index = deckIndex(progress, 'placement', PLACEMENT_PROMPTS.length, progress.promptIndex);
  return { id: `placement-${progress.promptIndex}-${index}`, sentence: PLACEMENT_PROMPTS[index] };
}

// Korean typing speed is counted in keystrokes (타): a syllable costs one key
// for the initial consonant, one or two for the vowel, and zero to two for the
// final consonant, depending on whether they are compound jamo.
const COMPOUND_VOWELS = new Set([9, 10, 11, 14, 15, 16, 19]);
const COMPOUND_FINALS = new Set([3, 5, 6, 9, 10, 11, 12, 13, 14, 15, 18]);

function keystrokesFor(char) {
  const code = char.codePointAt(0) - 0xac00;
  if (code < 0 || code > 11171) return 1;
  const vowel = Math.floor(code / 28) % 21;
  const final = code % 28;
  return 1 + (COMPOUND_VOWELS.has(vowel) ? 2 : 1) + (final === 0 ? 0 : COMPOUND_FINALS.has(final) ? 2 : 1);
}

function correctKeystrokes(input, expected) {
  const typed = [...normalizeSentence(input)];
  const target = [...expected];
  let total = 0;
  target.forEach((char, index) => {
    if (typed[index] === char) total += keystrokesFor(char);
  });
  return total;
}

// Strongest typists pick first; each one joins the weaker team that still has
// room, so team sizes differ by at most one and total speed stays close.
function assignTeamsBySkill(players) {
  const maxSize = Math.ceil(players.length / 2);
  const teams = { blue: { size: 0, total: 0 }, white: { size: 0, total: 0 } };
  const ranked = players.map((player, order) => ({ player, order }))
    .sort((a, b) => (b.player.typingSpeed - a.player.typingSpeed) || (a.order - b.order));
  for (const { player } of ranked) {
    const open = ['blue', 'white'].filter((team) => teams[team].size < maxSize);
    const team = open.sort((a, b) => (teams[a].total - teams[b].total) || (teams[a].size - teams[b].size))[0];
    player.team = team;
    teams[team].size += 1;
    teams[team].total += player.typingSpeed;
  }
}

const REPAIR_PROMPTS = [
  {
    question: '한글 날을 맞아 우리말을 사랑해요',
    answer: '한글날을 맞아 우리말을 사랑해요',
    explanation: '기념일 이름인 한글날은 붙여 씁니다.',
  },
  {
    question: '우리말을아끼고한글을사랑합시다',
    answer: '우리말을 아끼고 한글을 사랑합시다',
    explanation: '문장의 의미가 잘 드러나도록 낱말 사이를 띄어 씁니다.',
  },
  {
    question: '세종대왕님고맙습니다',
    answer: '세종대왕님 고맙습니다',
    explanation: '부르는 말과 이어지는 말을 알맞게 띄어 씁니다.',
  },
  {
    question: '한글은누구나쉽게배울수있는문자입니다.',
    answer: '한글은 누구나 쉽게 배울 수 있는 문자입니다.',
    explanation: '문장 속 낱말을 알맞게 띄어 씁니다.',
  },
  {
    question: '훈민정음은백성을위해만들었습니다.',
    answer: '훈민정음은 백성을 위해 만들었습니다.',
    explanation: '조사와 낱말을 구분해 띄어 써야 합니다.',
  },
  {
    question: '10월9일은한글날입니다.',
    answer: '10월 9일은 한글날입니다.',
    explanation: '날짜와 낱말 사이를 정확히 띄어 씁니다.',
  },
  {
    question: '우리함께바른말을써요.',
    answer: '우리 함께 바른말을 써요.',
    explanation: '‘우리 함께’와 ‘바른말을 써요’를 알맞게 띄어 씁니다.',
  },
  {
    question: '세종대왕은백성들이쉽게읽고쓰기를바랐습니다.',
    answer: '세종대왕은 백성들이 쉽게 읽고 쓰기를 바랐습니다.',
    explanation: '문장 속 낱말을 의미 단위에 맞게 띄어 씁니다.',
  },
  {
    question: '한글은소중한우리문화유산입니다.',
    answer: '한글은 소중한 우리 문화유산입니다.',
    explanation: '‘우리 문화유산’처럼 낱말 사이를 띄어 씁니다.',
  },
  {
    question: '뜻을알고쓰면우리말이더재미있어요.',
    answer: '뜻을 알고 쓰면 우리말이 더 재미있어요.',
    explanation: '말의 뜻을 생각하며 낱말 사이를 정확히 띄어 씁니다.',
  },
  {
    question: '모두가읽고쓸수있는글자를만들었습니다.',
    answer: '모두가 읽고 쓸 수 있는 글자를 만들었습니다.',
    explanation: '‘쓸 수 있는’은 낱말 단위로 띄어 씁니다.',
  },
  {
    question: '한글날에우리말도감을만들어보아요.',
    answer: '한글날에 우리말 도감을 만들어 보아요.',
    explanation: '‘만들어 보아요’처럼 보조 용언 앞을 띄어 씁니다.',
  },
  {
    question: '우리말의아름다움을함께느껴요.',
    answer: '우리말의 아름다움을 함께 느껴요.',
    explanation: '조사와 낱말을 구분해 띄어 씁니다.',
  },
];

const RELAY_PROMPTS = [
  '우리말을 아끼고 한글을 소중히 지켜요.',
  '한글날에는 우리말의 아름다움을 함께 느껴요.',
  '세종대왕님, 누구나 읽고 쓰는 세상을 열어 주셔서 고맙습니다.',
  '정확한 말과 따뜻한 마음으로 서로를 존중해요.',
  '세종대왕은 백성이 쉽게 읽고 쓰도록 훈민정음을 만들었습니다.',
  '훈민정음은 1446년에 세상에 반포되었습니다.',
  '한글의 자음과 모음에는 소리를 생각한 원리가 담겨 있습니다.',
  '오늘도 바른 우리말로 서로의 마음을 따뜻하게 전해요.',
];

const PLACEMENT_PROMPTS = [
  '한글은 세종대왕이 만든 글자입니다.',
  '우리말을 바르고 고운 말로 써요.',
  '가을 하늘이 맑고 높습니다.',
  '친구와 함께 줄다리기를 해요.',
  '훈민정음은 백성을 위한 글자예요.',
  '책을 읽으면 생각이 쑥쑥 자라요.',
  '바람이 살랑살랑 불어옵니다.',
  '우리 반 모두 힘을 모아요.',
  '또박또박 정확하게 입력해요.',
  '한글날에는 우리말을 더 아껴요.',
  '햇살이 운동장을 따뜻하게 비춰요.',
  '서로 도우면 무엇이든 할 수 있어요.',
];

const MODES = [
  { id: 'word', name: '말모이 기본전', description: '더 다양해진 순우리말을 빠르고 정확하게 입력해요.', duration: ROUND_DURATION_MS },
  { id: 'quiz', name: '뜻풀이 객관식 역전전', description: '순우리말과 한글 창제 이야기를 골라 배워요.', duration: ROUND_DURATION_MS },
  { id: 'repair', name: '바른말 수리공', description: '띄어쓰기를 제대로 해서 바른 문장을 완성해요.', duration: ROUND_DURATION_MS },
  { id: 'relay', name: '훈민정음 랜덤 릴레이', description: '랜덤 대표 선수끼리 한글 문장으로 대결해요.', duration: ROUND_DURATION_MS },
];

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const rooms = new Map();
const socketRooms = new Map();

function createGame() {
  return {
    phase: 'lobby',
    roundIndex: -1,
    modeIndex: -1,
    mode: null,
    roundStartedAt: 0,
    roundEndsAt: 0,
    intermissionUntil: 0,
    wheelEndsAt: 0,
    wheelSelectedIndex: null,
    overtimeCount: 0,
    scores: { blue: 0, white: 0 },
    rawScores: { blue: 0, white: 0 },
    roundScores: [],
    rosterCounts: { blue: 0, white: 0 },
    relay: null,
    relayUsed: { blue: new Set(), white: new Set() },
    winner: null,
    notice: '',
  };
}

function createRoomId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let roomId = '';
  do {
    roomId = Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms.has(roomId));
  return roomId;
}

function createRoom() {
  const room = {
    id: createRoomId(),
    game: createGame(),
    players: new Map(),
    createdAt: Date.now(),
  };
  rooms.set(room.id, room);
  return room;
}

function normalizeRoomId(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

// networkInterfaces() 는 Windows 에서 1회 수십 ms 가 걸린다. 상태를 보낼 때마다(플레이어 수 × 0.5초마다)
// 부르면 30명 방에서 서버가 밀려 입장이 15명 안팎에서 멈췄다. 1분 동안 결과를 기억해 둔다.
let lanAddressCache = { value: '', at: 0 };
function getLanAddress() {
  if (lanAddressCache.value && Date.now() - lanAddressCache.at < 60_000) return lanAddressCache.value;
  let found = '127.0.0.1';
  for (const entries of Object.values(networkInterfaces())) {
    const address = entries?.find((entry) => !entry.internal && (entry.family === 'IPv4' || entry.family === 4));
    if (address?.address) { found = address.address; break; }
  }
  lanAddressCache = { value: found, at: Date.now() };
  return found;
}

function getRoomUrl(roomId) {
  const baseUrl = PUBLIC_BASE_URL || `http://${getLanAddress()}:${PORT}`;
  return `${baseUrl}/?room=${encodeURIComponent(roomId)}`;
}

function getRoomBySocket(ws) {
  const roomId = socketRooms.get(ws);
  return roomId ? rooms.get(roomId) : null;
}

function getPlayerBySocket(ws) {
  const room = getRoomBySocket(ws);
  return room ? [...room.players.values()].find((player) => player.ws === ws) : null;
}

function getRoomForPlayer(player) {
  return player ? rooms.get(player.roomId) : null;
}

function getActivePlayers(room) {
  return [...room.players.values()].filter((player) => !player.spectator);
}

function getCounts(room) {
  const game = room.game;
  if (game.phase !== 'lobby' && game.rosterCounts.blue + game.rosterCounts.white > 0) {
    return { ...game.rosterCounts };
  }

  return getActivePlayers(room).reduce((counts, player) => {
    counts[player.team] += 1;
    return counts;
  }, { blue: 0, white: 0 });
}

function getMultipliers(room) {
  const counts = getCounts(room);
  const target = Math.max(counts.blue, counts.white, 1);
  return {
    blue: counts.blue ? target / counts.blue : 1,
    white: counts.white ? target / counts.white : 1,
  };
}

function sanitizeName(name) {
  return String(name || '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 18);
}

function sanitizeCharacter(characterId) {
  return CHARACTER_IDS.includes(characterId) ? characterId : 'bear';
}

function normalizeWord(value) {
  return String(value || '').normalize('NFKC').trim();
}

function normalizeSentence(value) {
  return String(value || '').normalize('NFKC').replace(/\r/g, '').trim();
}

function getMode(room) {
  const game = room.game;
  return MODES[game.modeIndex] || null;
}

function getPromptFor(room, player) {
  const game = room.game;
  if (game.phase === 'placement' && player?.progress) {
    const { id, sentence } = currentPlacementPrompt(player.progress);
    return { kind: 'placement', id, sentence };
  }
  if (game.phase !== 'round' || !player || player.spectator) return null;
  const mode = getMode(room);
  if (!mode) return null;

  if (mode.id === 'word') {
    const { id, prompt } = currentWordPrompt(player.progress);
    return { kind: 'word', id, word: prompt.word, category: prompt.category, length: [...prompt.word].length };
  }

  if (mode.id === 'quiz') {
    const { id, prompt } = currentQuizPrompt(player.progress);
    return { kind: 'quiz', id, category: prompt.category, meaning: prompt.meaning, choices: prompt.choices };
  }

  if (mode.id === 'repair') {
    const index = player.progress.promptIndex % REPAIR_PROMPTS.length;
    const prompt = REPAIR_PROMPTS[index];
    return { kind: 'repair', id: `repair-${index}`, question: prompt.question };
  }

  if (mode.id === 'relay' && game.relay) {
    const isSelected = game.relay.blueId === player.id || game.relay.whiteId === player.id;
    return {
      kind: 'relay',
      selected: isSelected,
      selectedTeam: game.relay.blueId === player.id ? 'blue' : game.relay.whiteId === player.id ? 'white' : null,
      prompt: game.relay.prompt,
      relayDeadline: game.relay.deadline,
    };
  }

  return null;
}

function publicStateFor(room, player) {
  const game = room.game;
  const counts = getCounts(room);
  const multipliers = getMultipliers(room);
  const difference = game.scores.blue - game.scores.white;
  // One visible step is roughly one accurate answer. Either team can pull the
  // center marker through all ten steps, even if the other team has no score.
  const ropeStep = Math.max(-ROPE_MAX_STEPS, Math.min(ROPE_MAX_STEPS, -Math.round(difference / ROPE_POINTS_PER_STEP)));
  const ropePosition = 50 + ropeStep * (43 / ROPE_MAX_STEPS);
  const mode = getMode(room);

  return {
    type: 'state',
    roomId: room.id,
    roomUrl: getRoomUrl(room.id),
    maxPlayers: MAX_PLAYERS_PER_ROOM,
    phase: game.phase,
    roundIndex: game.roundIndex,
    roundNumber: game.roundIndex + 1,
    totalRounds: game.roundIndex === MODES.length || game.wheelSelectedIndex !== null ? MODES.length + 1 : MODES.length,
    mode: mode ? { ...mode } : null,
    timeRemainingMs: game.phase === 'round' ? Math.max(0, game.roundEndsAt - Date.now()) : 0,
    intermissionRemainingMs: game.phase === 'intermission' ? Math.max(0, game.intermissionUntil - Date.now()) : 0,
    wheelRemainingMs: game.phase === 'wheel' ? Math.max(0, game.wheelEndsAt - Date.now()) : 0,
    placementRemainingMs: game.phase === 'placement' ? Math.max(0, game.placementEndsAt - Date.now()) : 0,
    placementDurationMs: PLACEMENT_MS,
    teamRevealRemainingMs: game.phase === 'teamReveal' ? Math.max(0, game.teamRevealUntil - Date.now()) : 0,
    wheelDurationMs: WHEEL_DURATION_MS,
    wheelSelectedIndex: game.wheelSelectedIndex,
    overtimeCount: game.overtimeCount,
    scores: game.scores,
    rawScores: game.rawScores,
    roundScores: game.roundScores,
    roundWins: {
      blue: game.roundScores.filter((round) => round.winner === 'blue').length,
      white: game.roundScores.filter((round) => round.winner === 'white').length,
    },
    counts,
    multipliers,
    ropePosition,
    ropeStep,
    ropeMaxSteps: ROPE_MAX_STEPS,
    winner: game.winner,
    notice: game.notice,
    self: player ? {
      id: player.id,
      name: player.name,
      team: player.team,
      characterId: player.characterId,
      isHost: player.isHost,
      spectator: player.spectator,
      // Typing results stay private to each player; others only see teams.
      placementKeystrokes: player.placementKeystrokes || 0,
      typingSpeed: player.typingSpeed ?? null,
    } : null,
    players: [...room.players.values()].map((entry) => ({
      id: entry.id,
      name: entry.name,
      team: entry.team,
      characterId: entry.characterId,
      isHost: entry.isHost,
      spectator: entry.spectator,
      connected: entry.ws.readyState === entry.ws.OPEN,
      scoreCount: entry.scoreCount || 0,
    })),
    prompt: getPromptFor(room, player),
    relay: game.relay ? {
      blueId: game.relay.blueId,
      whiteId: game.relay.whiteId,
      prompt: game.relay.prompt,
      deadline: game.relay.deadline,
      blueSubmitted: Boolean(game.relay.submissions.blue),
      whiteSubmitted: Boolean(game.relay.submissions.white),
      lastResult: game.relay.lastResult || null,
    } : null,
  };
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function broadcast(room) {
  if (!room || !rooms.has(room.id)) return;
  for (const player of room.players.values()) {
    send(player.ws, publicStateFor(room, player));
  }
  // 방마다 따로 기록한다. 전역 하나로 두면 한 반에서 답이 들어올 때마다 시각이 갱신돼
  // 다른 반들의 0.5초 정기 갱신이 계속 밀린다(20개 반 동시 사용 시 최장 4초 멈춤 실측).
  room.lastBroadcastAt = Date.now();
}

function setNotice(room, text) {
  const game = room.game;
  game.notice = text;
  setTimeout(() => {
    if (rooms.get(room.id) === room && game.notice === text) {
      game.notice = '';
      broadcast(room);
    }
  }, 3_000);
}

function checkRopeWin(room) {
  const ropeStep = publicStateFor(room, null).ropeStep;
  if (Math.abs(ropeStep) === ROPE_MAX_STEPS) finishRound(room, 'rope');
}

function addTeamScore(room, team, score, checkWin = true) {
  const game = room.game;
  const multiplier = getMultipliers(room)[team];
  const weighted = Math.max(0, score) * ROUND_MULTIPLIERS[game.roundIndex];
  game.rawScores[team] += weighted;
  game.scores[team] += weighted * multiplier;

  if (checkWin) checkRopeWin(room);
}

// Clients flash a player's name tag whenever this counter goes up.
function creditPlayer(player, score) {
  if (player && score > 0) player.scoreCount = (player.scoreCount || 0) + 1;
}

function calculateTypedScore(input, expected, elapsedMs, mode = 'word') {
  const typed = [...String(input || '')];
  const target = [...expected];
  const comparedLength = Math.max(typed.length, target.length);
  let correctChars = 0;
  for (let index = 0; index < comparedLength; index += 1) {
    if (typed[index] && typed[index] === target[index]) correctChars += 1;
  }

  const accuracy = comparedLength ? correctChars / comparedLength : 0;
  const seconds = Math.max(0.75, elapsedMs / 1000);
  const cpm = correctChars / seconds * 60;
  const speed = Math.min(1, cpm / (mode === 'repair' ? 150 : REFERENCE_CPM));
  const exact = normalizeSentence(input) === normalizeSentence(expected);

  return {
    exact,
    accuracy,
    cpm,
    score: accuracy * 60 + speed * 40,
    correctChars,
  };
}

function resetPlayerProgress(room) {
  const now = Date.now();
  for (const player of getActivePlayers(room)) {
    player.progress = { promptIndex: 0, promptStartedAt: now };
  }
}

function beginRound(room, index) {
  const game = room.game;
  const modeIndex = index === MODES.length ? game.wheelSelectedIndex : index;
  const mode = MODES[modeIndex];
  if (!mode) return;

  game.phase = 'round';
  game.roundIndex = index;
  game.modeIndex = modeIndex;
  game.mode = mode.id;
  game.roundStartedAt = Date.now();
  game.roundEndsAt = game.roundStartedAt + mode.duration;
  game.overtimeCount = 0;
  game.scores = { blue: 0, white: 0 };
  game.rawScores = { blue: 0, white: 0 };
  game.notice = `${index === MODES.length ? '결승' : `${index + 1}라운드`} · ${mode.name}`;
  game.relay = null;
  game.relayUsed = { blue: new Set(), white: new Set() };
  resetPlayerProgress(room);

  if (mode.id === 'relay') startRelayDuel(room);
  broadcast(room);
}

function finishRound(room, reason = 'time') {
  const game = room.game;
  if (game.phase !== 'round') return;
  const bluePoints = Math.round(game.scores.blue);
  const whitePoints = Math.round(game.scores.white);
  if (bluePoints === whitePoints) {
    game.overtimeCount += 1;
    game.roundEndsAt = Date.now() + OVERTIME_MS;
    game.notice = `동점! ${Math.round(OVERTIME_MS / 1000)}초 연장전이 시작됩니다.`;
    broadcast(room);
    return;
  }
  const winner = bluePoints > whitePoints ? 'blue' : 'white';
  const roundScore = {
    round: game.roundIndex + 1,
    mode: getMode(room)?.name || '',
    blue: bluePoints,
    white: whitePoints,
    winner,
    reason,
    overtimeCount: game.overtimeCount,
  };
  game.roundScores.push(roundScore);
  game.relay = null;

  if (game.roundIndex === MODES.length) {
    endGame(room, winner);
    return;
  }

  if (game.roundIndex === MODES.length - 1) {
    const blueWins = game.roundScores.filter((round) => round.winner === 'blue').length;
    const whiteWins = game.roundScores.filter((round) => round.winner === 'white').length;
    if (blueWins !== whiteWins) {
      endGame(room, blueWins > whiteWins ? 'blue' : 'white');
      return;
    }
    game.phase = 'wheel';
    game.wheelSelectedIndex = Math.floor(Math.random() * MODES.length);
    game.wheelEndsAt = Date.now() + WHEEL_DURATION_MS;
    game.notice = '2:2 동점! 돌림판으로 결승 종목을 정합니다.';
    broadcast(room);
    return;
  }

  game.phase = 'intermission';
  game.intermissionUntil = Date.now() + INTERMISSION_MS;
  game.notice = `${game.roundIndex + 1}라운드 ${winner === 'blue' ? '청팀' : '백팀'} 승리! 다음 라운드를 준비하세요.`;
  broadcast(room);
}

function endGame(room, winner) {
  const game = room.game;
  if (game.phase === 'results') return;
  game.phase = 'results';
  game.winner = winner;
  game.roundEndsAt = 0;
  game.relay = null;
  game.notice = `${winner === 'blue' ? '청팀' : '백팀'} 최종 승리!`;
  broadcast(room);
}

function startRelayDuel(room) {
  const game = room.game;
  if (game.phase !== 'round' || game.mode !== 'relay') return;
  const byTeam = {
    blue: getActivePlayers(room).filter((player) => player.team === 'blue'),
    white: getActivePlayers(room).filter((player) => player.team === 'white'),
  };
  if (!byTeam.blue.length || !byTeam.white.length) return;

  const selected = {};
  for (const team of ['blue', 'white']) {
    let available = byTeam[team].filter((player) => !game.relayUsed[team].has(player.id));
    if (!available.length) {
      game.relayUsed[team].clear();
      available = byTeam[team];
    }
    const player = available[Math.floor(Math.random() * available.length)];
    game.relayUsed[team].add(player.id);
    selected[team] = player.id;
  }

  const prompt = RELAY_PROMPTS[Math.floor(Math.random() * RELAY_PROMPTS.length)];
  game.relay = {
    blueId: selected.blue,
    whiteId: selected.white,
    prompt,
    startedAt: Date.now(),
    deadline: Date.now() + RELAY_LIMIT_MS,
    submissions: {},
    lastResult: null,
  };
  broadcast(room);
}

function finishRelayDuel(room) {
  const game = room.game;
  const relay = game.relay;
  if (!relay || relay.lastResult) return;

  const blue = relay.submissions.blue;
  const white = relay.submissions.white;
  const blueScore = blue?.exact ? Math.max(0, 60 + Math.min(40, 40 * (1 - blue.elapsedMs / RELAY_LIMIT_MS))) : 0;
  const whiteScore = white?.exact ? Math.max(0, 60 + Math.min(40, 40 * (1 - white.elapsedMs / RELAY_LIMIT_MS))) : 0;

  creditPlayer(room.players.get(relay.blueId), blueScore);
  creditPlayer(room.players.get(relay.whiteId), whiteScore);
  if (blueScore) addTeamScore(room, 'blue', blueScore, false);
  if (whiteScore) addTeamScore(room, 'white', whiteScore, false);
  checkRopeWin(room);

  const winner = blueScore === whiteScore ? 'draw' : blueScore > whiteScore ? 'blue' : 'white';
  relay.lastResult = { winner, blueScore, whiteScore };
  broadcast(room);

  setTimeout(() => {
    if (rooms.get(room.id) === room && game.phase === 'round' && game.mode === 'relay') startRelayDuel(room);
  }, 1_800);
}

function handlePlacementAnswer(room, player, answer) {
  const game = room.game;
  if (!player.progress) return;
  if (Date.now() >= game.placementEndsAt) return finishPlacement(room);
  const { sentence } = currentPlacementPrompt(player.progress);
  const keystrokes = correctKeystrokes(answer, sentence);
  player.placementKeystrokes = (player.placementKeystrokes || 0) + keystrokes;
  player.progress.promptIndex += 1;
  player.progress.promptStartedAt = Date.now();
  send(player.ws, {
    type: 'placementResult',
    correct: normalizeSentence(answer) === sentence,
    keystrokes,
    totalKeystrokes: player.placementKeystrokes,
  });
  broadcast(room);
}

function finishPlacement(room) {
  const game = room.game;
  if (game.phase !== 'placement') return;
  const minutes = PLACEMENT_MS / 60_000;
  const players = getActivePlayers(room);
  for (const player of players) {
    player.typingSpeed = Math.round((player.placementKeystrokes || 0) / minutes);
  }
  assignTeamsBySkill(players);
  game.rosterCounts = getActivePlayers(room).reduce((counts, player) => {
    counts[player.team] += 1;
    return counts;
  }, { blue: 0, white: 0 });
  game.phase = 'teamReveal';
  game.teamRevealUntil = Date.now() + TEAM_REVEAL_MS;
  game.notice = '타자 실력이 비슷하도록 팀을 나눴어요!';
  broadcast(room);
}

function handleTypedAnswer(player, answer) {
  const room = getRoomForPlayer(player);
  if (!room) return;
  const game = room.game;
  if (game.phase === 'placement') return handlePlacementAnswer(room, player, answer);
  if (game.phase !== 'round' || !player.progress || !getMode(room)) return;
  if (Date.now() >= game.roundEndsAt) return finishRound(room);
  const mode = getMode(room);
  if (!['word', 'repair'].includes(mode.id)) return;

  const source = mode.id === 'word'
    ? currentWordPrompt(player.progress).prompt
    : REPAIR_PROMPTS[player.progress.promptIndex % REPAIR_PROMPTS.length];
  const expected = mode.id === 'word' ? source.word : source.answer;
  const elapsedMs = Date.now() - player.progress.promptStartedAt;
  const result = calculateTypedScore(answer, expected, elapsedMs, mode.id);
  creditPlayer(player, result.score);
  addTeamScore(room, player.team, result.score);
  player.progress.promptIndex += 1;
  player.progress.promptStartedAt = Date.now();

  send(player.ws, {
    type: 'answerResult',
    correct: result.exact,
    score: result.score,
    accuracy: result.accuracy,
    cpm: result.cpm,
    word: mode.id === 'word' ? source.word : undefined,
    meaning: mode.id === 'word' ? source.meaning : undefined,
    example: mode.id === 'word' ? source.example : undefined,
    category: mode.id === 'word' ? source.category : undefined,
    correctAnswer: mode.id === 'repair' ? source.answer : undefined,
    explanation: mode.id === 'repair' ? source.explanation : undefined,
  });
  broadcast(room);
}

function handleChoice(player, choice) {
  const room = getRoomForPlayer(player);
  if (!room) return;
  const game = room.game;
  if (game.phase !== 'round' || getMode(room)?.id !== 'quiz') return;
  if (Date.now() >= game.roundEndsAt) return finishRound(room);
  const { prompt } = currentQuizPrompt(player.progress);
  const elapsedMs = Date.now() - player.progress.promptStartedAt;
  const correct = choice === prompt.answer;
  const speedBonus = Math.max(0, 40 * (1 - Math.min(elapsedMs, 8_000) / 8_000));
  const score = correct ? 60 + speedBonus : 0;

  creditPlayer(player, score);
  addTeamScore(room, player.team, score);
  player.progress.promptIndex += 1;
  player.progress.promptStartedAt = Date.now();
  send(player.ws, {
    type: 'choiceResult',
    correct,
    score,
    answer: prompt.answer,
    meaning: prompt.meaning,
    category: prompt.category,
    explanation: prompt.explanation,
  });
  broadcast(room);
}

function handleRelayAnswer(player, answer) {
  const room = getRoomForPlayer(player);
  if (!room) return;
  const game = room.game;
  const relay = game.relay;
  if (game.phase !== 'round' || game.mode !== 'relay' || !relay) return;
  if (Date.now() >= game.roundEndsAt) return finishRound(room);
  const team = relay.blueId === player.id ? 'blue' : relay.whiteId === player.id ? 'white' : null;
  if (!team || relay.submissions[team]) return;

  const elapsedMs = Date.now() - relay.startedAt;
  relay.submissions[team] = {
    exact: normalizeSentence(answer) === normalizeSentence(relay.prompt),
    elapsedMs,
  };
  send(player.ws, { type: 'relayAnswerResult', correct: relay.submissions[team].exact });
  if (relay.submissions.blue && relay.submissions.white) finishRelayDuel(room);
  else broadcast(room);
}

function startGame(player) {
  const room = getRoomForPlayer(player);
  if (!room) return;
  const game = room.game;
  if (!player.isHost || game.phase !== 'lobby') return;
  if (room.players.size < 2) {
    send(player.ws, { type: 'error', message: '두 명 이상 모여야 팀을 나누고 시작할 수 있어요.' });
    return;
  }

  // Teams are decided by a short typing test before round 1.
  const now = Date.now();
  room.game = createGame();
  room.game.phase = 'placement';
  room.game.placementEndsAt = now + PLACEMENT_MS;
  room.game.notice = '타자 실력을 재고 있어요. 문장을 정확하게 입력해 주세요!';
  for (const entry of room.players.values()) {
    entry.spectator = false;
    entry.progress = { promptIndex: 0, promptStartedAt: now };
    entry.placementKeystrokes = 0;
    entry.typingSpeed = null;
    entry.scoreCount = 0;
  }
  broadcast(room);
}

function resetToLobby(player) {
  const room = getRoomForPlayer(player);
  if (!room) return;
  if (!player.isHost) return;
  room.game = createGame();
  for (const entry of room.players.values()) {
    entry.spectator = false;
    entry.progress = { promptIndex: 0, promptStartedAt: 0 };
  }
  broadcast(room);
}

function joinPlayer(ws, message) {
  if (getPlayerBySocket(ws)) {
    send(ws, { type: 'error', message: '이미 방에 들어와 있어요.' });
    return;
  }

  const roomId = normalizeRoomId(message.roomId);
  const room = rooms.get(roomId);
  if (!room) {
    send(ws, { type: 'error', message: '방을 찾을 수 없어요. 방 코드가 맞는지 확인해 주세요.' });
    return;
  }

  const game = room.game;
  if (game.phase !== 'lobby') {
    send(ws, { type: 'error', message: '게임이 이미 진행 중입니다. 다음 게임을 기다려 주세요.' });
    return;
  }
  if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
    send(ws, { type: 'error', message: '이 방은 최대 30명까지 참여할 수 있어요.' });
    return;
  }

  const name = sanitizeName(message.name);
  if (!name) {
    send(ws, { type: 'error', message: '닉네임을 한 글자 이상 입력해 주세요.' });
    return;
  }

  const counts = getCounts(room);
  const team = counts.blue <= counts.white ? 'blue' : 'white';
  const player = {
    id: randomUUID(),
    roomId,
    ws,
    name,
    team,
    characterId: sanitizeCharacter(message.characterId),
    isHost: room.players.size === 0,
    spectator: false,
    progress: { promptIndex: 0, promptStartedAt: 0 },
  };
  room.players.set(player.id, player);
  socketRooms.set(ws, roomId);
  send(ws, { type: 'joined', roomId, roomUrl: getRoomUrl(roomId), player: { id: player.id, name: player.name, team: player.team, characterId: player.characterId, isHost: player.isHost } });
  broadcast(room);
}

function createRoomAndJoin(ws, message) {
  if (getPlayerBySocket(ws)) {
    send(ws, { type: 'error', message: '이미 방에 들어와 있어요.' });
    return;
  }

  const name = sanitizeName(message.name);
  if (!name) {
    send(ws, { type: 'error', message: '닉네임을 한 글자 이상 입력해 주세요.' });
    return;
  }

  const room = createRoom();
  send(ws, { type: 'roomCreated', roomId: room.id, roomUrl: getRoomUrl(room.id) });
  joinPlayer(ws, { ...message, name, roomId: room.id });
}

function handleMessage(ws, rawMessage) {
  let message;
  try {
    message = JSON.parse(rawMessage.toString());
  } catch {
    send(ws, { type: 'error', message: '잘못된 요청입니다.' });
    return;
  }

  if (message.type === 'createRoom') return createRoomAndJoin(ws, message);
  if (message.type === 'join') return joinPlayer(ws, message);
  const player = getPlayerBySocket(ws);
  if (!player) return;

  if (message.type === 'start') return startGame(player);
  if (message.type === 'restart') return resetToLobby(player);
  if (message.type === 'answer') return handleTypedAnswer(player, message.answer);
  if (message.type === 'choice') return handleChoice(player, message.choice);
  if (message.type === 'relayAnswer') return handleRelayAnswer(player, message.answer);
}

function tick() {
  const now = Date.now();
  for (const room of rooms.values()) {
    const game = room.game;
    if (game.phase === 'round') {
      if (now >= game.roundEndsAt) finishRound(room);
      else if (game.mode === 'relay' && game.relay && now >= game.relay.deadline) finishRelayDuel(room);
    } else if (game.phase === 'placement' && now >= game.placementEndsAt) {
      finishPlacement(room);
    } else if (game.phase === 'teamReveal' && now >= game.teamRevealUntil) {
      beginRound(room, 0);
    } else if (game.phase === 'intermission' && now >= game.intermissionUntil) {
      beginRound(room, game.roundIndex + 1);
    } else if (game.phase === 'wheel' && now >= game.wheelEndsAt) {
      beginRound(room, MODES.length);
    }
  }

  for (const room of rooms.values()) {
    if (now - (room.lastBroadcastAt || 0) >= 500) broadcast(room);
  }
}

async function serveStatic(req, res) {
  const pathname = decodeURIComponent((req.url || '/').split('?')[0]);
  if (pathname === '/health') {
    const playerCount = [...rooms.values()].reduce((total, room) => total + room.players.size, 0);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, players: playerCount, rooms: rooms.size }));
    return;
  }

  const root = existsSync(DIST) ? DIST : ROOT;
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = resolve(root, `.${requested}`);
  if (relative(root, filePath).startsWith('..')) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const fileStat = await stat(filePath);
    const target = fileStat.isDirectory() ? join(filePath, 'index.html') : filePath;
    const body = await readFile(target);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[extname(target)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    if (existsSync(DIST)) {
      const fallback = await readFile(join(DIST, 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME_TYPES['.html'] });
      res.end(fallback);
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  }
}

const httpServer = createServer((req, res) => {
  serveStatic(req, res).catch(() => {
    res.writeHead(500);
    res.end('Internal server error');
  });
});

// 상태 메시지(약 15KB JSON)를 0.5초마다 전원에게 보내므로 압축 효과가 크다.
// 20개 반 600명 실측: 전송량 161Mbps → 3Mbps. 대신 서버 CPU 약 2배, 메모리 약 +330MB.
// 브라우저는 permessage-deflate 를 기본 지원해 클라이언트 수정이 필요 없다. WS_COMPRESS=0 으로 끌 수 있다.
const websocketServer = new WebSocketServer({
  server: httpServer,
  path: '/ws',
  perMessageDeflate: process.env.WS_COMPRESS === '0' ? false : { zlibDeflateOptions: { level: 3 }, threshold: 1024 },
});
websocketServer.on('connection', (ws) => {
  ws.on('message', (message) => handleMessage(ws, message));
  ws.on('close', () => {
    const room = getRoomBySocket(ws);
    const player = getPlayerBySocket(ws);
    if (!player) return;
    room.players.delete(player.id);
    socketRooms.delete(ws);
    if (room.game.phase === 'lobby' && player.isHost) {
      const nextHost = room.players.values().next().value;
      if (nextHost) nextHost.isHost = true;
    }
    if (room.players.size === 0) rooms.delete(room.id);
    else broadcast(room);
  });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`말모이 줄다리기 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});

setInterval(tick, 250);
