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
const RELAY_DUEL_PAUSE_MS = Number(process.env.RELAY_DUEL_PAUSE_MS ?? 1_800);
const ROUND_MULTIPLIERS = [1, 1.1, 1.3, 1.5, 1.5];
const ROUND_DURATION_MS = Number(process.env.ROUND_DURATION_MS || 180_000);
const ROUND_INTRO_MS = Number(process.env.ROUND_INTRO_MS ?? 5_000);
const OVERTIME_MS = Number(process.env.OVERTIME_MS || 10_000);
const MAX_RELAY_OVERTIMES = 2;
const INTERMISSION_MS = Number(process.env.INTERMISSION_MS || 4_000);
const WHEEL_DURATION_MS = Number(process.env.WHEEL_DURATION_MS || 7_000);
const PLACEMENT_MS = Number(process.env.PLACEMENT_MS || 30_000);
const TEAM_REVEAL_MS = Number(process.env.TEAM_REVEAL_MS || 7_000);
const ROPE_MAX_STEPS = 20;
const ROPE_POINTS_PER_STEP = 75;
const MAX_PLAYERS_PER_ROOM = 30;
const CHARACTER_IDS = ['rabbit', 'bear', 'cat', 'chick', 'panda', 'sheep', 'fox', 'penguin'];

const BASE_WORD_PROMPTS = [
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

const ADDITIONAL_WORD_PROMPTS = [
  { word: '가랑비', meaning: '가늘고 조용히 내리는 비', example: '가랑비가 내려 우산을 펼쳤습니다.', category: '자연' },
  { word: '가랑잎', meaning: '나뭇가지에서 떨어진 마른 잎', example: '가랑잎을 밟을 때마다 바스락 소리가 났습니다.', category: '자연' },
  { word: '강바람', meaning: '강에서 불어오는 바람', example: '강바람이 불어 더위가 한결 가셨습니다.', category: '자연' },
  { word: '갯벌', meaning: '바닷물이 드나드는 모래와 진흙의 벌판', example: '갯벌에서 조개를 관찰했습니다.', category: '자연' },
  { word: '고드름', meaning: '처마 끝에 얼어붙은 얼음 기둥', example: '처마에 고드름이 길게 매달렸습니다.', category: '자연' },
  { word: '골바람', meaning: '골짜기에서 불어 나오는 바람', example: '골바람이 산길을 시원하게 훑고 지나갔습니다.', category: '자연' },
  { word: '그루터기', meaning: '나무를 베고 남은 밑동', example: '아이들은 그루터기에 앉아 잠시 쉬었습니다.', category: '자연' },
  { word: '길섶', meaning: '길의 가장자리', example: '길섶에 작은 들꽃이 피었습니다.', category: '자연' },
  { word: '나뭇결', meaning: '나무에 나타난 무늬나 질감', example: '나무 책상의 나뭇결이 아름다웠습니다.', category: '자연' },
  { word: '너럭바위', meaning: '넓고 평평한 바위', example: '너럭바위에 앉아 물소리를 들었습니다.', category: '자연' },
  { word: '다랑논', meaning: '산비탈을 계단처럼 만들어 놓은 논', example: '산골 마을의 다랑논이 초록빛으로 물들었습니다.', category: '자연' },
  { word: '달개비', meaning: '여름에 파란 꽃이 피는 풀', example: '담장 아래 달개비 꽃이 피었습니다.', category: '자연' },
  { word: '도랑', meaning: '물을 흘려보내려고 판 작은 개울', example: '빗물이 도랑을 따라 흘러갔습니다.', category: '자연' },
  { word: '들꽃', meaning: '들에서 저절로 피는 꽃', example: '들꽃 한 송이를 꺾지 않고 눈으로만 감상했습니다.', category: '자연' },
  { word: '물결', meaning: '물이 흔들려 이루는 잔무늬나 움직임', example: '연못에 물결이 동그랗게 퍼졌습니다.', category: '자연' },
  { word: '물안개', meaning: '물 위에 피어오르는 안개', example: '새벽 강 위로 물안개가 피어올랐습니다.', category: '자연' },
  { word: '물비늘', meaning: '물결에 햇빛이 비쳐 반짝이는 모양', example: '호수의 물비늘이 햇살을 받아 빛났습니다.', category: '자연' },
  { word: '바람결', meaning: '바람이 부는 기세나 느낌', example: '바람결에 꽃향기가 실려 왔습니다.', category: '자연' },
  { word: '보늬', meaning: '밤이나 도토리의 속껍질', example: '밤의 보늬를 조심스럽게 벗겼습니다.', category: '자연' },
  { word: '봄볕', meaning: '봄철의 따뜻한 햇볕', example: '봄볕을 쬐며 운동장을 걸었습니다.', category: '자연' },
  { word: '샘물', meaning: '땅에서 솟아나는 맑은 물', example: '산속 샘물을 한 모금 마셨습니다.', category: '자연' },
  { word: '솔바람', meaning: '소나무 숲에서 부는 바람', example: '솔바람이 솔잎 사이로 살랑살랑 불었습니다.', category: '자연' },
  { word: '숲정이', meaning: '마을 가까이에 있는 작은 숲', example: '숲정이에서 새들의 노랫소리를 들었습니다.', category: '자연' },
  { word: '조각달', meaning: '조각처럼 가늘게 보이는 달', example: '밤하늘에 조각달이 떠올랐습니다.', category: '자연' },
  { word: '초승달', meaning: '음력 초사흘 무렵의 가느다란 달', example: '초승달 옆에 별 하나가 반짝였습니다.', category: '자연' },
  { word: '햇귀', meaning: '해가 처음 솟을 때의 빛', example: '햇귀가 어두운 마을을 환하게 밝혔습니다.', category: '자연' },
  { word: '햇무리', meaning: '해 둘레에 둥글게 생기는 빛의 테', example: '하늘에 햇무리가 생겨 날씨를 살펴보았습니다.', category: '자연' },
  { word: '흙내', meaning: '흙에서 나는 냄새', example: '비가 그친 뒤 촉촉한 흙내가 났습니다.', category: '자연' },
  { word: '소슬바람', meaning: '가을에 쓸쓸하게 부는 바람', example: '소슬바람에 낙엽이 하나둘 떨어졌습니다.', category: '자연' },
  { word: '마중물', meaning: '펌프에서 물을 끌어올리려고 먼저 붓는 물', example: '펌프에 마중물을 붓자 맑은 물이 나왔습니다.', category: '자연' },
  { word: '가시버시', meaning: '부부를 다정하게 이르는 말', example: '가시버시가 나란히 한글 책을 읽었습니다.', category: '모임' },
  { word: '길동무', meaning: '길을 함께 가는 친구', example: '친구가 즐거운 길동무가 되어 주었습니다.', category: '모임' },
  { word: '나들이', meaning: '집을 떠나 가까운 곳에 다녀오는 일', example: '한글날에 가족과 박물관 나들이를 했습니다.', category: '모임' },
  { word: '늦깎이', meaning: '나이가 들어서 어떤 일을 시작한 사람', example: '늦깎이 학생도 매일 한글을 익혔습니다.', category: '모임' },
  { word: '말동무', meaning: '이야기를 나누는 친구', example: '책 속 주인공이 좋은 말동무가 되어 주었습니다.', category: '모임' },
  { word: '벗', meaning: '가깝게 사귀는 친구', example: '오래된 벗과 우리말 이야기를 나누었습니다.', category: '모임' },
  { word: '살붙이', meaning: '혈연으로 가까운 사람', example: '명절에 살붙이들이 한자리에 모였습니다.', category: '모임' },
  { word: '새내기', meaning: '새로 들어온 사람', example: '새내기 친구에게 교실을 안내해 주었습니다.', category: '모임' },
  { word: '오누이', meaning: '오빠와 누이처럼 남매 사이인 사람들', example: '오누이가 마주 앉아 동화책을 읽었습니다.', category: '모임' },
  { word: '어울림', meaning: '여럿이 잘 어울리는 일이나 모습', example: '서로 다른 생각도 어울림 속에서 빛났습니다.', category: '모임' },
  { word: '이웃사촌', meaning: '가까이 지내는 이웃을 사촌처럼 이르는 말', example: '이웃사촌과 함께 마을 잔치를 준비했습니다.', category: '모임' },
  { word: '풋내기', meaning: '일이나 경험이 아직 서투른 사람', example: '풋내기라도 용기를 내어 발표했습니다.', category: '모임' },
  { word: '한솥밥', meaning: '한집에서 함께 지내며 먹는 밥', example: '우리는 한솥밥을 먹는 식구처럼 서로 도왔습니다.', category: '모임' },
  { word: '길라잡이', meaning: '길을 안내해 주는 사람이나 물건', example: '우리말 사전이 낯선 낱말의 길라잡이가 되었습니다.', category: '모임' },
  { word: '도우미', meaning: '남이 하는 일을 곁에서 도와주는 사람', example: '도우미 친구가 책상 정리를 도왔습니다.', category: '모임' },
  { word: '마실', meaning: '이웃에 놀러 다니는 일', example: '저녁에 이웃집으로 마실을 갔습니다.', category: '모임' },
  { word: '살림살이', meaning: '집안의 생활이나 살림을 꾸리는 일', example: '살림살이를 아끼는 지혜를 배웠습니다.', category: '모임' },
  { word: '쉼터', meaning: '잠시 쉬도록 마련한 곳', example: '도서관 한쪽에 작은 쉼터가 있습니다.', category: '모임' },
  { word: '한마음', meaning: '여럿이 같은 마음을 가지는 일', example: '우리 반은 한마음으로 응원했습니다.', category: '모임' },
  { word: '가엾다', meaning: '딱하고 불쌍한 마음이 들다', example: '비를 맞은 강아지가 가엾어 우산을 씌워 주었습니다.', category: '마음' },
  { word: '갸륵하다', meaning: '마음이나 행동이 착하고 장하다', example: '동생을 챙기는 마음이 갸륵했습니다.', category: '마음' },
  { word: '기껍다', meaning: '마음에 들어 기쁘고 만족스럽다', example: '친구의 도움을 받아 기꺼웠습니다.', category: '마음' },
  { word: '도탑다', meaning: '서로의 관계가 깊고 정답다', example: '두 친구의 우정이 도타웠습니다.', category: '마음' },
  { word: '무던하다', meaning: '성격이 너그럽고 까다롭지 않다', example: '무던한 친구는 누구와도 잘 지냈습니다.', category: '마음' },
  { word: '벅차다', meaning: '감정이 가득하여 힘에 겹다', example: '한글날 무대에 서니 가슴이 벅찼습니다.', category: '마음' },
  { word: '살갑다', meaning: '마음씨가 부드럽고 다정하다', example: '살가운 인사 한마디가 마음을 따뜻하게 했습니다.', category: '마음' },
  { word: '수더분하다', meaning: '꾸밈이 없고 소박하며 편안하다', example: '수더분한 웃음이 보기 좋았습니다.', category: '마음' },
  { word: '안쓰럽다', meaning: '여리고 힘들어 보여 마음이 아프다', example: '혼자 남은 친구가 안쓰러워 곁에 앉았습니다.', category: '마음' },
  { word: '애틋하다', meaning: '마음이 간절하고 애잔하다', example: '고향을 생각하는 마음이 애틋했습니다.', category: '마음' },
  { word: '올곧다', meaning: '마음이나 태도가 바르고 곧다', example: '올곧은 마음으로 약속을 지켰습니다.', category: '마음' },
  { word: '의젓하다', meaning: '말과 행동이 점잖고 믿음직하다', example: '어려운 일에도 의젓하게 대처했습니다.', category: '마음' },
  { word: '참하다', meaning: '모습이나 행동이 단정하고 얌전하다', example: '참한 글씨로 한글날 카드를 꾸몄습니다.', category: '모양' },
  { word: '흐뭇하다', meaning: '마음에 흐뭇한 만족감이 있다', example: '친구들이 서로 돕는 모습이 흐뭇했습니다.', category: '마음' },
  { word: '보드랍다', meaning: '살결이나 느낌이 부드럽다', example: '보드라운 수건으로 손을 닦았습니다.', category: '모양' },
  { word: '싹싹하다', meaning: '성격이 밝고 붙임성이 좋다', example: '싹싹한 학생이 손님을 반갑게 맞았습니다.', category: '마음' },
  { word: '찬찬하다', meaning: '성질이 차분하고 꼼꼼하다', example: '찬찬하게 글자를 한 자씩 살폈습니다.', category: '마음' },
  { word: '풋풋하다', meaning: '싱그럽고 순수한 느낌이 있다', example: '아이들의 풋풋한 웃음이 운동장에 퍼졌습니다.', category: '느낌' },
  { word: '어엿하다', meaning: '행동이나 모습이 의젓하고 번듯하다', example: '어엿한 한글 지킴이로 자라고 있습니다.', category: '모양' },
  { word: '다소곳하다', meaning: '고개를 조금 숙이고 얌전하다', example: '아이가 다소곳하게 인사를 했습니다.', category: '모양' },
  { word: '야무지다', meaning: '사람이나 일이 빈틈없이 단단하다', example: '야무지게 준비물을 챙겼습니다.', category: '마음' },
  { word: '정답다', meaning: '따뜻하고 친근한 느낌이 있다', example: '정다운 우리말로 서로를 불렀습니다.', category: '마음' },
  { word: '알뜰살뜰', meaning: '정성을 다해 빈틈없이 보살피는 모양', example: '친구들이 교실을 알뜰살뜰 가꾸었습니다.', category: '마음' },
  { word: '오순도순', meaning: '여럿이 정답게 이야기하는 모양', example: '가족이 오순도순 둘러앉았습니다.', category: '말맛' },
  { word: '아기자기', meaning: '작은 것들이 예쁘게 어울려 정답다', example: '아기자기한 글씨로 표지를 꾸몄습니다.', category: '모양' },
  { word: '거닐다', meaning: '가까운 곳을 이리저리 천천히 걷다', example: '궁궐 뜰을 거닐며 옛글을 살펴보았습니다.', category: '움직임' },
  { word: '굽이치다', meaning: '길이나 물줄기가 이리저리 휘어 흐르다', example: '강물이 들판 사이로 굽이쳤습니다.', category: '움직임' },
  { word: '나부끼다', meaning: '얇은 천이나 잎이 바람에 흔들리다', example: '청팀 깃발이 힘차게 나부꼈습니다.', category: '움직임' },
  { word: '다독이다', meaning: '가볍게 두드리거나 잘하도록 타이르다', example: '선생님이 긴장한 아이를 다독였습니다.', category: '움직임' },
  { word: '도맡다', meaning: '어떤 일을 혼자 책임지고 맡다', example: '친구가 안내 방송을 도맡았습니다.', category: '움직임' },
  { word: '뒤척이다', meaning: '몸을 이리저리 움직이며 잠을 이루지 못하다', example: '기대되는 경기 전날 밤 잠을 뒤척였습니다.', category: '움직임' },
  { word: '들르다', meaning: '지나는 길에 잠깐 들어가 머무르다', example: '도서관에 들러 우리말 책을 빌렸습니다.', category: '움직임' },
  { word: '머금다', meaning: '물이나 감정 등을 입이나 마음에 간직하다', example: '아이는 환한 미소를 머금었습니다.', category: '마음' },
  { word: '무르익다', meaning: '과일이나 일이 충분히 익거나 발전하다', example: '가을이 무르익어 들판이 황금빛이 되었습니다.', category: '움직임' },
  { word: '사무치다', meaning: '마음 깊이 느껴지다', example: '친구의 고마움이 마음에 사무쳤습니다.', category: '마음' },
  { word: '서성이다', meaning: '한곳에 머물러 이리저리 천천히 걷다', example: '발표 순서를 기다리며 복도를 서성였습니다.', category: '움직임' },
  { word: '스미다', meaning: '조금씩 배어들거나 마음에 느껴지다', example: '따뜻한 햇살이 창문으로 스며들었습니다.', category: '움직임' },
  { word: '아우르다', meaning: '여럿을 한데 모아 하나로 묶다', example: '서로 다른 생각을 아우르는 문장을 만들었습니다.', category: '움직임' },
  { word: '어루만지다', meaning: '손으로 부드럽게 쓰다듬다', example: '할머니가 손자의 머리를 어루만졌습니다.', category: '움직임' },
  { word: '우러나다', meaning: '생각이나 느낌이 마음에서 저절로 생겨나다', example: '친구를 아끼는 마음이 우러났습니다.', category: '마음' },
  { word: '움츠리다', meaning: '몸이나 마음을 오그라뜨리다', example: '찬바람에 어깨를 움츠렸습니다.', category: '움직임' },
  { word: '재잘거리다', meaning: '작은 목소리로 즐겁게 자꾸 이야기하다', example: '아이들이 쉬는 시간에 재잘거렸습니다.', category: '말맛' },
  { word: '주무르다', meaning: '손으로 이리저리 누르고 비비다', example: '반죽을 손으로 골고루 주물렀습니다.', category: '움직임' },
  { word: '추스르다', meaning: '몸이나 마음을 가다듬어 바로잡다', example: '숨을 고르고 마음을 추슬렀습니다.', category: '움직임' },
  { word: '헤아리다', meaning: '수를 세거나 마음을 깊이 생각하다', example: '친구의 마음을 헤아려 따뜻하게 말했습니다.', category: '마음' },
  { word: '가꾸다', meaning: '좋은 상태가 되도록 보살피고 꾸미다', example: '우리말 정원을 함께 가꾸었습니다.', category: '움직임' },
  { word: '기웃거리다', meaning: '무엇을 보려고 고개나 몸을 자꾸 기울이다', example: '아이들이 전시 작품을 기웃거리며 살펴보았습니다.', category: '움직임' },
  { word: '내디디다', meaning: '발을 앞으로 내놓다', example: '새로운 배움에 첫발을 내디뎠습니다.', category: '움직임' },
  { word: '노닐다', meaning: '한가롭게 이리저리 다니며 즐기다', example: '나비가 꽃밭에서 노닐었습니다.', category: '움직임' },
  { word: '다지다', meaning: '마음이나 뜻을 굳게 정하다', example: '오늘은 정확하게 치겠다고 마음을 다졌습니다.', category: '마음' },
  { word: '되새기다', meaning: '지난 일을 다시 생각하거나 되풀이해 익히다', example: '훈민정음의 뜻을 여러 번 되새겼습니다.', category: '움직임' },
  { word: '살피다', meaning: '자세히 보고 살펴 알아보다', example: '문장의 띄어쓰기를 꼼꼼히 살폈습니다.', category: '움직임' },
  { word: '스치다', meaning: '가볍게 닿거나 지나가다', example: '산들바람이 뺨을 스쳤습니다.', category: '움직임' },
  { word: '일구다', meaning: '밭을 갈아 만들거나 보람 있는 일을 이루다', example: '친구들과 힘을 모아 멋진 결과를 일구었습니다.', category: '움직임' },
  { word: '타이르다', meaning: '잘 알아듣도록 차분히 일러 주다', example: '선생님이 바른 말의 소중함을 타일렀습니다.', category: '움직임' },
  { word: '헤매다', meaning: '갈 곳을 몰라 이리저리 돌아다니다', example: '낯선 낱말 뜻을 찾느라 사전을 헤맸습니다.', category: '움직임' },
  { word: '가마솥', meaning: '쇠로 만든 크고 둥근 솥', example: '가마솥에서 따뜻한 국 냄새가 났습니다.', category: '문화' },
  { word: '구들', meaning: '방바닥 밑으로 불기운이 지나가게 만든 난방 시설', example: '옛 한옥의 구들이 방을 따뜻하게 했습니다.', category: '문화' },
  { word: '나막신', meaning: '나무로 만든 신', example: '박물관에서 옛 나막신을 보았습니다.', category: '문화' },
  { word: '너와집', meaning: '나무 조각을 지붕에 얹은 집', example: '산골의 너와집이 고즈넉하게 서 있었습니다.', category: '문화' },
  { word: '도리깨', meaning: '곡식의 이삭을 두드려 알곡을 떠는 농기구', example: '농부가 도리깨로 곡식을 털었습니다.', category: '문화' },
  { word: '두레박', meaning: '우물에서 물을 퍼 올리는 바가지', example: '두레박으로 우물물을 길었습니다.', category: '문화' },
  { word: '디딜방아', meaning: '발로 디뎌 곡식을 찧는 방아', example: '전통 마을에서 디딜방아를 체험했습니다.', category: '문화' },
  { word: '멍석', meaning: '곡식이나 물건을 펴 놓는 큰 깔개', example: '마당에 멍석을 펴고 이야기를 나누었습니다.', category: '문화' },
  { word: '모시', meaning: '모시풀의 껍질로 짠 여름 옷감', example: '모시로 만든 시원한 옷을 구경했습니다.', category: '문화' },
  { word: '보자기', meaning: '물건을 싸거나 덮는 네모난 천', example: '선물을 예쁜 보자기에 싸 보았습니다.', category: '문화' },
  { word: '삿갓', meaning: '비나 햇볕을 가리려고 쓰는 갓', example: '농부 인형이 삿갓을 쓰고 있었습니다.', category: '문화' },
  { word: '섬돌', meaning: '집 앞에 오르내리도록 놓은 돌계단', example: '섬돌에 앉아 신발끈을 고쳤습니다.', category: '문화' },
  { word: '소쿠리', meaning: '대나무나 싸리로 엮은 작은 바구니', example: '소쿠리에 주운 밤을 담았습니다.', category: '문화' },
  { word: '시루', meaning: '떡이나 음식을 찌는 그릇', example: '시루에서 김이 모락모락 올랐습니다.', category: '문화' },
  { word: '아궁이', meaning: '불을 지피는 구멍이나 부엌의 시설', example: '아궁이에 장작불이 활활 타올랐습니다.', category: '문화' },
  { word: '옹기', meaning: '흙으로 빚어 구운 그릇', example: '장독대에 여러 옹기가 놓여 있었습니다.', category: '문화' },
  { word: '자배기', meaning: '아가리가 넓고 둥근 질그릇', example: '자배기에 빨래를 담아 날랐습니다.', category: '문화' },
  { word: '장독대', meaning: '간장이나 된장 항아리를 놓아두는 곳', example: '햇볕 좋은 장독대에서 장이 익어 갔습니다.', category: '문화' },
  { word: '지게', meaning: '짐을 등에 지도록 만든 운반 도구', example: '나무꾼이 지게에 땔감을 실었습니다.', category: '문화' },
  { word: '키', meaning: '곡식의 쭉정이나 티를 날려 고르는 도구', example: '키질로 곡식과 쭉정이를 가려냈습니다.', category: '문화' },
  { word: '함지박', meaning: '통나무를 파서 만든 큰 그릇', example: '함지박에 시원한 물을 받아 두었습니다.', category: '문화' },
  { word: '고누', meaning: '말판에 말을 놓고 겨루는 옛놀이', example: '친구와 고누를 두며 옛놀이를 배웠습니다.', category: '문화' },
  { word: '두런두런', meaning: '여럿이 나지막한 목소리로 이야기하는 소리', example: '아이들이 두런두런 책 이야기를 나누었습니다.', category: '말맛' },
  { word: '살금살금', meaning: '남이 알아차리지 못하게 조심조심 움직이는 모양', example: '고양이가 살금살금 다가왔습니다.', category: '움직임' },
  { word: '아장아장', meaning: '어린아이가 작은 걸음으로 걷는 모양', example: '아기가 아장아장 걸어왔습니다.', category: '움직임' },
  { word: '어기적어기적', meaning: '팔다리를 부자연스럽게 움직이며 걷는 모양', example: '오리가 어기적어기적 연못으로 갔습니다.', category: '움직임' },
  { word: '우물우물', meaning: '음식을 입 안에 넣고 천천히 씹는 모양', example: '아이들이 간식을 우물우물 먹었습니다.', category: '움직임' },
  { word: '주렁주렁', meaning: '열매나 물건이 많이 매달린 모양', example: '감나무에 감이 주렁주렁 열렸습니다.', category: '모양' },
  { word: '찰랑찰랑', meaning: '물이나 액체가 가볍게 흔들리는 모양', example: '잔에 담긴 물이 찰랑찰랑 흔들렸습니다.', category: '모양' },
  { word: '포르르', meaning: '작은 새나 나비가 가볍게 날아오르는 모양', example: '참새가 포르르 날아갔습니다.', category: '움직임' },
  { word: '후다닥', meaning: '매우 빠르게 뛰거나 일을 해치우는 모양', example: '종이 울리자 모두 후다닥 자리에 앉았습니다.', category: '움직임' },
  { word: '깡충깡충', meaning: '짧은 다리로 자꾸 뛰는 모양', example: '토끼가 들판을 깡충깡충 뛰었습니다.', category: '움직임' },
  { word: '뚜벅뚜벅', meaning: '발을 힘주어 걸을 때 나는 소리나 모양', example: '친구가 뚜벅뚜벅 교실로 들어왔습니다.', category: '말맛' },
  { word: '보글보글', meaning: '물이 끓거나 거품이 잇따라 올라오는 모양', example: '냄비에서 국물이 보글보글 끓었습니다.', category: '모양' },
  { word: '오목조목', meaning: '작은 것들이 옹기종기 모여 있는 모양', example: '오목조목한 마을 풍경을 그렸습니다.', category: '모양' },
  { word: '올망졸망', meaning: '작은 것들이 고르지 않게 많이 모인 모양', example: '아이들이 올망졸망 모여 앉았습니다.', category: '모양' },
  { word: '차곡차곡', meaning: '물건을 가지런히 겹쳐 쌓는 모양', example: '책을 차곡차곡 책장에 꽂았습니다.', category: '모양' },
  { word: '해죽해죽', meaning: '만족스러운 듯 입을 조금 벌리고 자꾸 웃는 모양', example: '아이들이 선물을 받고 해죽해죽 웃었습니다.', category: '움직임' },
  { word: '화들짝', meaning: '갑자기 놀라 몸을 크게 움직이는 모양', example: '문이 열리자 모두 화들짝 놀랐습니다.', category: '움직임' },
  { word: '보송보송', meaning: '살결이나 물건이 마르고 부드러운 모양', example: '햇볕에 말린 수건이 보송보송했습니다.', category: '모양' },
  { word: '말랑말랑', meaning: '물체가 부드럽고 말랑한 느낌', example: '새로 만든 찰흙이 말랑말랑했습니다.', category: '느낌' },
  { word: '새콤달콤', meaning: '신맛과 단맛이 함께 나는 맛', example: '새콤달콤한 과일을 나누어 먹었습니다.', category: '느낌' },
];

const WORD_PROMPTS = [...BASE_WORD_PROMPTS, ...ADDITIONAL_WORD_PROMPTS];

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

function shuffledWordIndexes(length, avoidFirst) {
  const groups = new Map();
  for (let index = 0; index < length; index += 1) {
    const category = WORD_PROMPTS[index]?.category || '기타';
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(index);
  }

  const categories = [...groups.keys()];
  const categoryOrder = shuffledIndexes(categories.length, -1).map((index) => categories[index]);
  const order = [];
  while (order.length < length) {
    for (const category of categoryOrder) {
      const group = groups.get(category);
      if (!group?.length) continue;
      const pick = Math.floor(Math.random() * group.length);
      order.push(group.splice(pick, 1)[0]);
    }
  }

  if (length > 1 && order[0] === avoidFirst) [order[0], order[1]] = [order[1], order[0]];
  return order;
}

// Each player walks a private shuffled deck that is reshuffled every lap, so
// rounds and players do not all see the same fixed sequence.
function deckIndex(progress, key, length, position, makeOrder = shuffledIndexes) {
  progress.decks ??= {};
  const lap = Math.floor(position / length);
  let deck = progress.decks[key];
  if (!deck || deck.lap !== lap) {
    deck = { lap, order: makeOrder(length, deck?.order[length - 1]) };
    progress.decks[key] = deck;
  }
  return deck.order[position % length];
}

function currentWordPrompt(progress, key = 'word') {
  const index = deckIndex(progress, key, WORD_PROMPTS.length, progress.promptIndex, shuffledWordIndexes);
  return { id: `word-${progress.promptIndex}-${index}`, prompt: WORD_PROMPTS[index] };
}

function currentPracticePrompt(progress) {
  const { id, prompt } = currentWordPrompt(progress, 'practice');
  return { id: `practice-${id}`, prompt };
}

// Every third quiz question is about Hangul's creation so the large word pool
// does not crowd those questions out.
function currentQuizPrompt(progress) {
  const position = progress.promptIndex;
  let id;
  let prompt;
  if (position % 3 === 2) {
    const index = deckIndex(progress, 'hangul', HANGUL_CREATION_QUIZ_PROMPTS.length, Math.floor(position / 3));
    id = `quiz-${position}-hangul-${index}`;
    prompt = HANGUL_CREATION_QUIZ_PROMPTS[index];
  } else {
    const index = deckIndex(progress, 'wordQuiz', WORD_QUIZ_PROMPTS.length, position - Math.floor(position / 3));
    id = `quiz-${position}-word-${index}`;
    prompt = WORD_QUIZ_PROMPTS[index];
  }

  // Keep each question's randomized choices stable across frequent state broadcasts,
  // and avoid putting the answer in the same position twice in a row.
  if (progress.quizChoicePromptId !== id) {
    const choices = [...prompt.choices];
    for (let index = choices.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(Math.random() * (index + 1));
      [choices[index], choices[swap]] = [choices[swap], choices[index]];
    }
    let answerIndex = choices.indexOf(prompt.answer);
    if (choices.length > 1 && answerIndex === progress.lastQuizAnswerIndex) {
      const swapIndex = (answerIndex + 1 + Math.floor(Math.random() * (choices.length - 1))) % choices.length;
      [choices[answerIndex], choices[swapIndex]] = [choices[swapIndex], choices[answerIndex]];
      answerIndex = swapIndex;
    }
    progress.quizChoicePromptId = id;
    progress.quizChoices = choices;
    progress.lastQuizAnswerIndex = answerIndex;
  }
  return { id, prompt: { ...prompt, choices: progress.quizChoices } };
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
  { id: 'relay', name: '훈민정음 랜덤 릴레이', description: '대표가 정답을 맞히면 줄을 2칸 당기고, 친구들의 정답은 1점씩 보태요.', duration: ROUND_DURATION_MS },
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
    roundIntroUntil: 0,
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
  if (game.phase === 'lobby' && player?.progress) {
    const { id, prompt } = currentPracticePrompt(player.progress);
    return {
      kind: 'practice',
      id,
      word: prompt.word,
      category: prompt.category,
      meaning: prompt.meaning,
      example: prompt.example,
    };
  }
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
      submitted: Boolean(game.relay.submissions[player.id]),
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
  // center marker through all twenty steps, even if the other team has no score.
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
    // The fifth slot is always part of the match plan. It becomes active only
    // when rounds 1–4 finish 2:2 and the wheel selects a rematch mode.
    totalRounds: MODES.length + 1,
    mode: mode ? { ...mode } : null,
    timeRemainingMs: game.phase === 'round' ? Math.max(0, game.roundEndsAt - Date.now()) : 0,
    roundIntroRemainingMs: game.phase === 'roundIntro' ? Math.max(0, game.roundIntroUntil - Date.now()) : 0,
    roundIntroDurationMs: ROUND_INTRO_MS,
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
      practiceCount: player.practiceCount || 0,
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
      blueSubmitted: Boolean(game.relay.submissions[game.relay.blueId]),
      whiteSubmitted: Boolean(game.relay.submissions[game.relay.whiteId]),
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
  // Relay keeps rotating representatives until its round timer expires.
  if (room.game.mode === 'relay') return;
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

function addRelayScore(room, team, score) {
  const points = Math.max(0, score);
  if (!points) return;
  const game = room.game;
  // Relay points are literal: an exact representative answer is 150 points
  // (two 75-point rope steps), while each supporter adds exactly one point.
  game.rawScores[team] += points / getMultipliers(room)[team];
  game.scores[team] += points;
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
    player.roundDraft = null;
  }
}

function queueRound(room, index) {
  const game = room.game;
  const modeIndex = index === MODES.length ? game.wheelSelectedIndex : index;
  const mode = MODES[modeIndex];
  if (!mode) return;
  game.phase = 'roundIntro';
  game.roundIndex = index;
  game.modeIndex = modeIndex;
  game.mode = mode.id;
  game.roundIntroUntil = Date.now() + ROUND_INTRO_MS;
  game.scores = { blue: 0, white: 0 };
  game.rawScores = { blue: 0, white: 0 };
  game.relay = null;
  game.notice = `${index === MODES.length ? '결승' : `${index + 1}라운드`} · ${mode.name} 규칙을 확인하세요!`;
  if (ROUND_INTRO_MS <= 0) beginRound(room, index);
  else broadcast(room);
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
  if (reason === 'time') settleRoundDrafts(room);
  const bluePoints = Math.round(game.scores.blue);
  const whitePoints = Math.round(game.scores.white);
  const relayTiebreak = bluePoints === whitePoints && game.mode === 'relay' && game.overtimeCount >= MAX_RELAY_OVERTIMES;
  if (bluePoints === whitePoints && !relayTiebreak) {
    game.overtimeCount += 1;
    game.roundEndsAt = Date.now() + OVERTIME_MS;
    game.notice = `동점! ${Math.round(OVERTIME_MS / 1000)}초 연장전이 시작됩니다.`;
    if (game.mode === 'relay') startRelayDuel(room);
    broadcast(room);
    return;
  }
  const winner = relayTiebreak ? (Math.random() < 0.5 ? 'blue' : 'white') : bluePoints > whitePoints ? 'blue' : 'white';
  const roundScore = {
    round: game.roundIndex + 1,
    mode: getMode(room)?.name || '',
    blue: bluePoints,
    white: whitePoints,
    winner,
    reason: relayTiebreak ? 'tiebreak' : reason,
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
  game.notice = relayTiebreak
    ? `연장 2회 후에도 동점이라 추첨으로 ${winner === 'blue' ? '청팀' : '백팀'}이 승리했어요. 다음 라운드를 준비하세요.`
    : `${game.roundIndex + 1}라운드 ${winner === 'blue' ? '청팀' : '백팀'} 승리! 다음 라운드를 준비하세요.`;
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
  if (game.phase !== 'round' || game.mode !== 'relay' || Date.now() >= game.roundEndsAt) return;
  const byTeam = {
    blue: getActivePlayers(room).filter((player) => player.team === 'blue'),
    white: getActivePlayers(room).filter((player) => player.team === 'white'),
  };
  if (!byTeam.blue.length || !byTeam.white.length) return;
  for (const player of getActivePlayers(room)) player.roundDraft = null;

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
  if (game.phase !== 'round' || !relay || relay.lastResult) return;
  settleRelayDrafts(room, relay);
  checkRopeWin(room);
  if (game.phase !== 'round') return;

  const blueScore = Object.values(relay.submissions).filter((entry) => entry.team === 'blue').reduce((sum, entry) => sum + entry.score, 0);
  const whiteScore = Object.values(relay.submissions).filter((entry) => entry.team === 'white').reduce((sum, entry) => sum + entry.score, 0);

  const winner = blueScore === whiteScore ? 'draw' : blueScore > whiteScore ? 'blue' : 'white';
  relay.lastResult = { winner, blueScore, whiteScore };
  broadcast(room);

  setTimeout(() => {
    if (rooms.get(room.id) === room && game.phase === 'round' && game.mode === 'relay' && game.relay === relay) startRelayDuel(room);
  }, RELAY_DUEL_PAUSE_MS);
}

function awardTimeoutScore(room, player, score) {
  if (score <= 0) return;
  creditPlayer(player, score);
  addTeamScore(room, player.team, score, false);
  send(player.ws, { type: 'timeoutScore', score });
}

function settleRelayDrafts(room, relay) {
  for (const player of getActivePlayers(room)) {
    const draft = player.roundDraft;
    player.roundDraft = null;
    if (!draft || draft.kind !== 'relay' || draft.deadline !== relay.deadline || relay.submissions[player.id] || !normalizeSentence(draft.text)) continue;
    const result = calculateTypedScore(draft.text, relay.prompt, Date.now() - relay.startedAt, 'repair');
    const representative = player.id === relay.blueId || player.id === relay.whiteId;
    const maxScore = representative ? ROPE_POINTS_PER_STEP * 2 : 1;
    const score = result.exact ? maxScore : result.score / 100 * maxScore;
    relay.submissions[player.id] = { team: player.team, exact: result.exact, score };
    if (score > 0) {
      creditPlayer(player, score);
      addRelayScore(room, player.team, score);
      send(player.ws, { type: 'timeoutScore', score, relay: true, representative });
    }
  }
}

function settleRoundDrafts(room) {
  const mode = getMode(room)?.id;
  if (mode === 'relay') {
    if (room.game.relay && !room.game.relay.lastResult) settleRelayDrafts(room, room.game.relay);
    return;
  }
  if (!['word', 'repair'].includes(mode)) return;
  for (const player of getActivePlayers(room)) {
    const draft = player.roundDraft;
    player.roundDraft = null;
    const prompt = getPromptFor(room, player);
    if (!draft || draft.kind !== mode || draft.promptId !== prompt?.id || !normalizeSentence(draft.text)) continue;
    const expected = mode === 'word'
      ? currentWordPrompt(player.progress).prompt.word
      : REPAIR_PROMPTS[player.progress.promptIndex % REPAIR_PROMPTS.length].answer;
    const result = calculateTypedScore(draft.text, expected, Date.now() - player.progress.promptStartedAt, mode);
    awardTimeoutScore(room, player, result.score);
    player.progress.promptIndex += 1;
    player.progress.promptStartedAt = Date.now();
  }
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
  // Team assignment is automatic, so do not hold the class on a separate
  // reveal screen. The first round begins as soon as the 30-second test ends.
  game.notice = '타자 실력이 비슷하도록 팀을 나눴어요! 1라운드를 시작합니다.';
  queueRound(room, 0);
}

function handlePracticeAnswer(room, player, answer) {
  const game = room.game;
  if (game.phase !== 'lobby' || !player.progress || !normalizeSentence(answer)) return;
  const { prompt } = currentPracticePrompt(player.progress);
  const elapsedMs = Date.now() - player.progress.promptStartedAt;
  const result = calculateTypedScore(answer, prompt.word, elapsedMs, 'word');
  player.practiceCount = (player.practiceCount || 0) + 1;
  player.progress.promptIndex += 1;
  player.progress.promptStartedAt = Date.now();
  send(player.ws, {
    type: 'practiceResult',
    correct: result.exact,
    word: prompt.word,
    meaning: prompt.meaning,
    example: prompt.example,
    category: prompt.category,
    keystrokes: result.correctChars,
    cpm: result.cpm,
    practiceCount: player.practiceCount,
  });
  broadcast(room);
}

function handleTypedAnswer(player, answer) {
  const room = getRoomForPlayer(player);
  if (!room) return;
  const game = room.game;
  if (game.phase === 'lobby') return handlePracticeAnswer(room, player, answer);
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
  player.roundDraft = null;
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

function handleRelayAnswer(player, answer, deadline) {
  const room = getRoomForPlayer(player);
  if (!room) return;
  const game = room.game;
  const relay = game.relay;
  if (game.phase !== 'round' || game.mode !== 'relay' || !relay) return;
  if (Date.now() >= game.roundEndsAt) return finishRound(room);
  if (Date.now() >= relay.deadline) return finishRelayDuel(room);
  if (deadline !== relay.deadline) return;
  const team = relay.blueId === player.id ? 'blue' : relay.whiteId === player.id ? 'white' : null;
  if (!player.team || player.spectator || relay.submissions[player.id] || relay.lastResult) return;

  const exact = normalizeSentence(answer) === normalizeSentence(relay.prompt);
  const representative = Boolean(team);
  const score = exact ? representative ? ROPE_POINTS_PER_STEP * 2 : 1 : 0;
  player.roundDraft = null;
  relay.submissions[player.id] = { team: player.team, exact, score };
  send(player.ws, { type: 'relayAnswerResult', correct: exact, score, representative });
  if (score) {
    creditPlayer(player, score);
    addRelayScore(room, player.team, score);
  }
  if (game.phase !== 'round') return;
  if (getActivePlayers(room).every((entry) => relay.submissions[entry.id])) finishRelayDuel(room);
  else broadcast(room);
}

function handleDraft(player, message) {
  const room = getRoomForPlayer(player);
  if (!room || player.spectator || !player.progress || typeof message.text !== 'string') return;
  const game = room.game;
  if (game.phase !== 'round') return;
  if (Date.now() >= game.roundEndsAt) return finishRound(room);
  const mode = getMode(room)?.id;
  const text = message.text.slice(0, 500);
  if (mode === 'relay') {
    const relay = game.relay;
    if (!relay || relay.lastResult || relay.submissions[player.id]) return;
    if (Date.now() >= relay.deadline) return finishRelayDuel(room);
    if (message.deadline !== relay.deadline) return;
    player.roundDraft = { kind: 'relay', deadline: relay.deadline, text };
    return;
  }
  if (!['word', 'repair'].includes(mode)) return;
  const prompt = getPromptFor(room, player);
  if (message.promptId !== prompt?.id) return;
  player.roundDraft = { kind: mode, promptId: prompt.id, text };
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
    entry.progress = { promptIndex: 0, promptStartedAt: Date.now() };
    entry.practiceCount = 0;
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
    progress: { promptIndex: 0, promptStartedAt: Date.now() },
    practiceCount: 0,
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
  if (message.type === 'relayAnswer') return handleRelayAnswer(player, message.answer, message.deadline);
  if (message.type === 'draft') return handleDraft(player, message);
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
      queueRound(room, 0);
    } else if (game.phase === 'intermission' && now >= game.intermissionUntil) {
      queueRound(room, game.roundIndex + 1);
    } else if (game.phase === 'wheel' && now >= game.wheelEndsAt) {
      queueRound(room, MODES.length);
    } else if (game.phase === 'roundIntro' && now >= game.roundIntroUntil) {
      beginRound(room, game.roundIndex);
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
