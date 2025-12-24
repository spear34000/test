/**
 * @file bot.js
 * @description KakaoTalk MessengerBot R API2 종합 기능 스크립트.
 * 주요 기능: 채팅 순위, 닉네임 변경 감지, 공질 저장/조회/삭제, 자동응답, 운세, 퀴즈, 랜덤 추첨.
 * @version 1.7.0
 */

const bot = BotManager.getCurrentBot();
const VIEW_MORE = "\u200b".repeat(500);
const PREFIX = "!";

/* ===== PATH 설정 ===== */
const BASE = "sdcard/msgbot/data/customBot/";
const PATH_CHAT = BASE + "chat.json"; // 채팅 순위
const PATH_GONG = BASE + "gong.json"; // 공질 데이터
const PATH_AUTO = BASE + "auto.json"; // 자동응답
const PATH_NICK = BASE + "nick.json"; // 해시별 현재 닉네임
const PATH_NICK_HIS = BASE + "nickHistory.json"; // 닉네임 변경 이력
const PATH_QUIZ = BASE + "quiz.json"; // 퀴즈 랭킹
const PATH_FORTUNE = BASE + "fortune.json"; // 운세 캐시

/* ===== 상수 ===== */
const MAX_CHAT_RANK = 20; // 채팅순위 출력 최대 인원
const MAX_LOG_LENGTH = 2000; // 파일 무한 증식 방지용 공질 로그 길이 제한
const MAX_GONG_ENTRIES = 200; // 공질 등록 최대 개수 (초과 시 가장 오래된 데이터 삭제)
const QUIZ_TIMEOUT_MS = 10000; // 퀴즈 대기 시간 10초
const QUIZ_FETCH_TIMEOUT = 7000; // 퀴즈 API 크롤링 타임아웃 7초
const FORTUNE_FETCH_TIMEOUT = 7000; // 운세 크롤링 타임아웃 7초
const FORTUNE_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 운세 캐시 유지 시간 12시간
const ADMIN_HASHES = [""]; // 관리자로 허용할 hash 목록 (필요 시 채워주세요)
const ADMIN_NAMES = [""]; // hash 미지원 기기용 관리자 닉네임 목록 (필요 시 채워주세요)

/* ===== 유틸: JSON 파일 읽기/쓰기 ===== */
function readJson(path, fallback) {
  let raw = FileStream.read(path);
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    Log.e("JSON parse failed at " + path + ": " + error);
    return fallback;
  }
}

function writeJson(path, data) {
  try {
    FileStream.write(path, JSON.stringify(data, null, 2));
  } catch (error) {
    Log.e("JSON write failed at " + path + ": " + error);
  }
}

/* ===== 데이터 적재 ===== */
let chatStat = readJson(PATH_CHAT, {}); // {room: {id: {name, count}}}
let gongData = readJson(PATH_GONG, {}); // {nickname: {content, writerHash}}
let autoReply = readJson(PATH_AUTO, {}); // {keyword: response}
let nickMap = readJson(PATH_NICK, {}); // {hash: latestName}
let nickHistory = readJson(PATH_NICK_HIS, {}); // {hash: [names...]}
let quizRank = readJson(PATH_QUIZ, {}); // {hash: {name, score}}

let quizState = {}; // {room: {question, answer, options, expires}}
let fortuneCache = readJson(PATH_FORTUNE, {}); // {"YYYYMMDD|남": {date: 'YYYY-MM-DD', text, savedAt}}

/* ===== 헬퍼 ===== */
function formatBlock(title, lines) {
  let box = [];
  box.push("┌═〔 " + title + " 〕" + "═".repeat(14));
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line.length === 0) {
      box.push("│");
    } else {
      box.push("│ • " + line);
    }
  }
  box.push("└" + "─".repeat(18 + title.length));
  return box.join("\n");
}

function formatList(title, items) {
  if (!items || items.length === 0) {
    return formatBlock(title, ["- 없음"]);
  }
  let lines = [];
  for (let i = 0; i < items.length; i++) {
    lines.push((i + 1) + ") " + items[i]);
  }
  return formatBlock(title, lines);
}

function getUserId(msg) {
  if (msg.author && msg.author.hash) {
    return String(msg.author.hash);
  }
  return msg.author && msg.author.name ? msg.author.name : "";
}

function isAdmin(msg) {
  let id = getUserId(msg);
  let name = msg.author && msg.author.name ? normalizeNickname(msg.author.name) : "";
  for (let i = 0; i < ADMIN_HASHES.length; i++) {
    if (ADMIN_HASHES[i] && ADMIN_HASHES[i] === id) {
      return true;
    }
  }
  for (let j = 0; j < ADMIN_NAMES.length; j++) {
    if (ADMIN_NAMES[j] && normalizeNickname(ADMIN_NAMES[j]) === name) {
      return true;
    }
  }
  return false;
}

function normalizeNickname(text) {
  return text.replace(/\s+/g, " ").trim();
}

function compressSpaces(text) {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeAnswer(text) {
  let lowered = text.toLowerCase();
  lowered = lowered.replace(/\s+/g, " ").trim();
  return lowered;
}

function ensureRoomStat(room) {
  if (!chatStat[room]) {
    chatStat[room] = {};
  }
}

function updateChatCount(msg) {
  let room = msg.room;
  let id = getUserId(msg);
  let name = msg.author && msg.author.name ? msg.author.name : "";
  ensureRoomStat(room);
  if (!chatStat[room][id]) {
    chatStat[room][id] = { name: name, count: 0 };
  }
  chatStat[room][id].name = name;
  chatStat[room][id].count += 1;
  writeJson(PATH_CHAT, chatStat);
}

function detectNicknameChange(msg) {
  let id = getUserId(msg);
  let name = msg.author && msg.author.name ? msg.author.name : "";
  if (id.length === 0 || name.length === 0) {
    return;
  }
  let previous = nickMap[id];
  if (previous && previous !== name) {
    if (!nickHistory[id]) {
      nickHistory[id] = [];
    }
    if (nickHistory[id].length === 0 || nickHistory[id][nickHistory[id].length - 1] !== previous) {
      nickHistory[id].push(previous);
    }
    nickHistory[id].push(name);
    writeJson(PATH_NICK_HIS, nickHistory);
  }
  nickMap[id] = name;
  writeJson(PATH_NICK, nickMap);
}

function showNicknameHistory(targetName) {
  let nameKey = normalizeNickname(targetName);
  let result = [];
  for (let key in nickHistory) {
    let list = nickHistory[key];
    let latest = nickMap[key] || "";
    let matched = false;
    if (latest && normalizeNickname(latest) === nameKey) {
      matched = true;
    } else {
      for (let i = 0; i < list.length; i++) {
        if (normalizeNickname(list[i]) === nameKey) {
          matched = true;
          break;
        }
      }
    }
    if (matched) {
      let combined = list.slice();
      if (latest && combined[combined.length - 1] !== latest) {
        combined.push(latest);
      }
      result.push({ id: key, names: combined });
    }
  }
  if (result.length === 0) {
    return formatBlock("닉네임 변경 이력", ["기록이 없습니다."]);
  }
  let lines = [];
  for (let i = 0; i < result.length; i++) {
    let item = result[i];
    lines.push("ID: " + item.id);
    lines.push("경로: " + item.names.join(" → "));
    if (i < result.length - 1) {
      lines.push("");
    }
  }
  return formatBlock("닉네임 변경 이력", lines);
}

function formatChatRank(room, limit) {
  ensureRoomStat(room);
  let entries = [];
  for (let id in chatStat[room]) {
    entries.push(chatStat[room][id]);
  }
  entries.sort(function (a, b) {
    return b.count - a.count;
  });
  let top = entries.slice(0, limit);
  if (top.length === 0) {
    return formatBlock("채팅 순위", ["데이터가 없습니다."]);
  }
  let lines = [];
  for (let i = 0; i < top.length; i++) {
    let item = top[i];
    lines.push((i + 1) + "위 " + item.name + " · " + item.count + "회");
  }
  return formatBlock("채팅 순위 TOP " + top.length, lines);
}

function resetChatRank(room) {
  chatStat[room] = {};
  writeJson(PATH_CHAT, chatStat);
}

function parseGongContent(text) {
  let requiredKeys = ["닉네임:", "나이", "지역", "키", "MBTI", "혈액형", "주량", "흡연", "프리한시간", "썸상형", "본인매력", "기동력", "오톡", "기연", "입방일"];
  let hasNick = text.indexOf("닉네임:") !== -1;
  let hasAny = false;
  for (let i = 0; i < requiredKeys.length; i++) {
    if (text.indexOf(requiredKeys[i]) !== -1) {
      hasAny = true;
      break;
    }
  }
  if (!hasNick || !hasAny) {
    return null;
  }
  let lines = text.split(/\r?\n/);
  let nickname = "";
  let cleaned = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (line.length === 0) {
      continue;
    }
    if (line.indexOf("닉네임:") === 0) {
      nickname = normalizeNickname(line.replace("닉네임:", ""));
    }
    cleaned.push(line);
  }
  if (nickname.length === 0) {
    return null;
  }
  let content = cleaned.join("\n");
  if (content.length > MAX_LOG_LENGTH) {
    content = content.substring(0, MAX_LOG_LENGTH);
  }
  return { nickname: nickname, content: content };
}

function saveGong(msg, parsed) {
  gongData[parsed.nickname] = { content: parsed.content, writerHash: getUserId(msg), updatedAt: new Date().toISOString() };
  let names = Object.keys(gongData);
  if (names.length > MAX_GONG_ENTRIES) {
    names.sort(function (a, b) {
      let aTime = gongData[a].updatedAt || "";
      let bTime = gongData[b].updatedAt || "";
      if (aTime === bTime) {
        return 0;
      }
      return aTime < bTime ? -1 : 1;
    });
    let overflow = names.length - MAX_GONG_ENTRIES;
    for (let i = 0; i < overflow; i++) {
      let target = names[i];
      delete gongData[target];
    }
  }
  writeJson(PATH_GONG, gongData);
}

function renderGong(nickname) {
  let data = gongData[nickname];
  if (!data) {
    return formatBlock("공질", ["등록된 공질이 없습니다."]);
  }
  return formatBlock(nickname + "님의 공질", [VIEW_MORE + data.content]);
}

function listGongNames() {
  let names = Object.keys(gongData);
  if (names.length === 0) {
    return formatBlock("공질 목록", ["등록된 공질이 없습니다."]);
  }
  return formatBlock("공질 닉네임 목록", [VIEW_MORE + names.join(", ")]);
}

function deleteGong(name) {
  if (!gongData[name]) {
    return false;
  }
  delete gongData[name];
  writeJson(PATH_GONG, gongData);
  return true;
}

function joinArgs(args, startIndex) {
  let collected = [];
  for (let i = startIndex; i < args.length; i++) {
    collected.push(args[i]);
  }
  return normalizeNickname(collected.join(" "));
}

function addAutoReply(keyword, message) {
  autoReply[keyword] = message;
  writeJson(PATH_AUTO, autoReply);
}

function handleAutoReply(msg) {
  let key = msg.content;
  if (autoReply[key]) {
    msg.reply(autoReply[key]);
  }
}

function listAutoReplies() {
  let keys = Object.keys(autoReply);
  if (keys.length === 0) {
    return formatBlock("자동응답", ["등록된 키워드가 없습니다."]);
  }
  let items = [];
  for (let i = 0; i < keys.length; i++) {
    let key = keys[i];
    items.push(key + " → " + autoReply[key]);
  }
  return formatList("자동응답 목록", items);
}

function deleteAutoReply(keyword) {
  if (!autoReply[keyword]) {
    return false;
  }
  delete autoReply[keyword];
  writeJson(PATH_AUTO, autoReply);
  return true;
}

function resetAutoReplies() {
  autoReply = {};
  writeJson(PATH_AUTO, autoReply);
}

function showFortuneUsage() {
  let lines = [];
  lines.push("명령: !운세 YYYYMMDD|남/여");
  lines.push("예시: !운세 20010101|여");
  lines.push("조건: 생년월일 8자리 숫자");
  lines.push("성별: 남 또는 여 (공백 없이)");
  lines.push("구분자: | 반드시 포함");
  return formatBlock("운세 가이드", lines);
}

function isValidFortuneDate(date) {
  if (!/^[0-9]{8}$/.test(date)) {
    return false;
  }
  let year = parseInt(date.substring(0, 4), 10);
  let month = parseInt(date.substring(4, 6), 10) - 1;
  let day = parseInt(date.substring(6, 8), 10);
  let d = new Date(year, month, day);
  if (!(d.getFullYear() === year && d.getMonth() === month && d.getDate() === day)) {
    return false;
  }
  let currentYear = new Date().getFullYear();
  return year >= 1900 && year <= currentYear;
}

function isValidFortuneGender(gender) {
  let trimmed = gender ? gender.trim() : "";
  return trimmed === "남" || trimmed === "여";
}

function buildFortuneError(parts) {
  let error = [];
  error.push("⚠️ 입력 형식이 올바르지 않습니다.");
  error.push("");
  if (parts.length < 2) {
    error.push("• 생년월일과 성별을 모두 입력해주세요.");
  } else {
    if (!isValidFortuneDate(parts[0])) {
      error.push("• 생년월일은 YYYYMMDD 형식으로 입력해주세요.");
    }
    if (!isValidFortuneGender(parts[1])) {
      error.push("• 성별은 '남' 또는 '여'로만 입력 가능합니다.");
    }
  }
  error.push("");
  error.push("✨ 예시: !운세 20010101|여");
  return formatBlock("운세 입력 오류", error);
}

function cleanFortuneResponse(body) {
  let trimmed = String(body || "");
  trimmed = trimmed.replace(/^[^{]*({[\s\S]*})[^}]*$/, "$1");
  return trimmed;
}

function fetchFortuneFromNaver(birth, gender) {
  let today = new Date();
  let todayKey = today.getFullYear() + "-" + (today.getMonth() + 1) + "-" + today.getDate();
  let cacheKey = birth + "|" + gender;
  let cached = fortuneCache[cacheKey];
  if (cached && cached.date === todayKey && cached.savedAt && Date.now() - cached.savedAt < FORTUNE_CACHE_TTL_MS) {
    return cached.text;
  }

  try {
    let apiUrl = "https://m.search.naver.com/p/csearch/content/apirender.nhn?where=m&q=%EC%83%9D%EB%85%84%EC%9B%94%EC%9D%BC+%EC%9A%B4%EC%84%B8&u3=solar&u4=12&u2=" + birth + "&u1=" + (gender === "남" ? "m" : "f");
    let response = org.jsoup.Jsoup.connect(apiUrl).ignoreContentType(true).timeout(FORTUNE_FETCH_TIMEOUT).execute().body();
    if (!response) {
      if (cached && cached.text) {
        return cached.text + " (캐시)";
      }
      return "운세 정보를 가져오지 못했습니다. 잠시 후 다시 시도해 주세요.";
    }
    let clean = cleanFortuneResponse(response);
    let json = JSON.parse(clean);
    let text = processFortuneResult(json);
    if (text && text.length > 0) {
      fortuneCache[cacheKey] = { date: todayKey, text: text, savedAt: Date.now() };
      writeJson(PATH_FORTUNE, fortuneCache);
      return text;
    }
  } catch (error) {
    Log.e("fetchFortuneFromNaver error: " + error);
  }
  if (cached && cached.text) {
    return cached.text + " (캐시)";
  }
  return "운세 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.";
}

function processFortuneResult(data) {
  try {
    let todayHtml = data.flick && data.flick.length > 0 ? data.flick[0] : "";
    if (!todayHtml) {
      return "";
    }
    let doc = org.jsoup.Jsoup.parse(todayHtml);
    let fortuneItems = doc.select("li._foldContainer");
    if (!fortuneItems || fortuneItems.size() === 0) {
      return "";
    }
    let result = [];
    result.push("🌟 오늘의 운세 🌟");
    result.push("");
    let totalLuck = fortuneItems.get(0);
    let totalSummary = totalLuck.select("span.summary").text().trim();
    let totalContent = totalLuck.select("p.text").text().trim();
    result.push("《📌 총운》");
    result.push(totalSummary);
    result.push(totalContent);
    result.push("");
    result.push(VIEW_MORE);
    result.push("");
    for (let i = 1; i < fortuneItems.size(); i++) {
      let item = fortuneItems.get(i);
      let title = item.select("strong.title").text().replace("접기", "").replace("펴기", "").trim();
      let content = item.select("p.text").text().trim();
      if (title.length === 0 || content.length === 0) {
        continue;
      }
      result.push("《" + getCategoryEmoji(title) + " " + title + "》");
      result.push(content);
      result.push("");
    }
    let zodiacInfo = parseFortuneZodiac(data.relation);
    result.push("━━━━━━━━━━━━━━━━");
    result.push("🔮 당신의 띠와 별자리");
    result.push(zodiacInfo);
    return result.join("\n");
  } catch (error) {
    Log.e("processFortuneResult error: " + error);
    return "";
  }
}

function getCategoryEmoji(category) {
  let emojis = { "애정운": "💝", "재물운": "💰", "직장운": "💼", "학업·시험운": "📚", "건강운": "🏥" };
  return emojis[category] || "✨";
}

function parseFortuneZodiac(relationHtml) {
  if (!relationHtml) {
    return "정보 없음";
  }
  let doc = org.jsoup.Jsoup.parse(relationHtml);
  let items = doc.select("a");
  if (!items || items.size() < 2) {
    return "정보 없음";
  }
  return "• 《" + items.get(0).text() + "》  《" + items.get(1).text() + "》";
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    let j = Math.floor(Math.random() * (i + 1));
    let temp = arr[i];
    arr[i] = arr[j];
    arr[j] = temp;
  }
  return arr;
}

function decodeHtmlEntities(text) {
  let replaced = text;
  replaced = replaced.replace(/&quot;/g, '"');
  replaced = replaced.replace(/&#39;/g, "'");
  replaced = replaced.replace(/&amp;/g, "&");
  replaced = replaced.replace(/&lt;/g, "<");
  replaced = replaced.replace(/&gt;/g, ">");
  return replaced;
}

const LOCAL_QUIZ_BANK = [
  { question: "🧩 퀴즈 (10초)\n캄보디아의 수도는?", answer: "프놈펜", options: ["프놈펜", "방콕", "자카르타", "쿠알라룸푸르"], hint: "초성: ㅍㄴㅍ" },
  { question: "🧩 퀴즈 (10초)\n프랑스의 수도는?", answer: "파리", options: ["파리", "런던", "베를린", "마드리드"], hint: "에펠탑" },
  { question: "🧩 퀴즈 (10초)\n대한민국의 수도는?", answer: "서울", options: ["서울", "부산", "대구", "광주"], hint: "한강" },
  { question: "🧩 퀴즈 (10초)\n애플이 만든 스마트폰 이름은?", answer: "아이폰", options: ["아이폰", "갤럭시", "픽셀", "노트"], hint: "iOS" },
  { question: "🧩 퀴즈 (10초)\n수도권 전철 2호선의 색상은?", answer: "초록", options: ["초록", "빨강", "파랑", "보라"], hint: "순환" }
];

function getLocalQuizQuestion() {
  if (LOCAL_QUIZ_BANK.length === 0) {
    return null;
  }
  let idx = Math.floor(Math.random() * LOCAL_QUIZ_BANK.length);
  let item = LOCAL_QUIZ_BANK[idx];
  let options = uniqueOptions(item.options.slice());
  shuffleArray(options);
  return { question: item.question, answer: item.answer, options: options, hint: item.hint };
}

function fetchQuizQuestion() {
  return getLocalQuizQuestion();
}

function uniqueOptions(options) {
  let seen = {};
  let result = [];
  for (let i = 0; i < options.length; i++) {
    let key = options[i];
    if (!seen[key]) {
      seen[key] = true;
      result.push(key);
    }
  }
  return result;
}

function startQuiz(room) {
  if (quizState[room] && Date.now() < quizState[room].expires) {
    return formatBlock("퀴즈", ["이미 퀴즈가 진행 중입니다. 이전 문제를 먼저 풀어주세요."]);
  }
  let quiz = fetchQuizQuestion();
  if (!quiz) {
    quiz = { question: "3 + 4 = ?", answer: "7", options: ["5", "6", "7", "8"], hint: "덧셈" };
  }
  quizState[room] = { question: quiz.question, answer: quiz.answer, options: quiz.options, expires: Date.now() + QUIZ_TIMEOUT_MS };
  let lines = [];
  lines.push("문제: " + quiz.question);
  if (quiz.hint) {
    lines.push("힌트: " + quiz.hint);
  }
  for (let i = 0; i < quiz.options.length; i++) {
    lines.push((i + 1) + ". " + quiz.options[i]);
  }
  lines.push("정답은 번호 또는 내용으로 입력하세요. (제한 시간 10초)");
  return formatBlock("퀴즈", lines);
}

function checkQuizTimeout(room) {
  if (!quizState[room]) {
    return null;
  }
  if (Date.now() > quizState[room].expires) {
    let answer = quizState[room].answer;
    delete quizState[room];
    return answer || "";
  }
  return null;
}

function addQuizScore(msg) {
  let id = getUserId(msg);
  let name = msg.author && msg.author.name ? msg.author.name : "";
  if (!quizRank[id]) {
    quizRank[id] = { name: name, score: 0 };
  }
  quizRank[id].name = name;
  quizRank[id].score += 1;
  writeJson(PATH_QUIZ, quizRank);
}

function renderQuizRank() {
  let entries = [];
  for (let id in quizRank) {
    entries.push(quizRank[id]);
  }
  entries.sort(function (a, b) {
    return b.score - a.score;
  });
  if (entries.length === 0) {
    return formatBlock("퀴즈 랭킹", ["데이터가 없습니다."]);
  }
  let lines = [];
  for (let i = 0; i < entries.length; i++) {
    lines.push((i + 1) + "위 " + entries[i].name + " - " + entries[i].score + "점");
  }
  return formatBlock("퀴즈 랭킹", lines);
}

function pickRandom(args) {
  if (!args || args.length === 0) {
    return formatBlock("추첨", ["대상이 없습니다."]);
  }
  let pool = [];
  for (let i = 0; i < args.length; i++) {
    pool.push(args[i]);
  }
  shuffleArray(pool);
  let winner = pool[0];
  let lines = [];
  lines.push("당첨: " + winner);
  if (pool.length > 1) {
    lines.push("순서: " + pool.slice(1).join(", "));
  }
  return formatBlock("추첨", lines);
}

/* ===== 메시지 이벤트 ===== */
function onMessage(msg) {
  try {
    updateChatCount(msg);
    detectNicknameChange(msg);

    let parsed = parseGongContent(msg.content);
    if (parsed) {
      saveGong(msg, parsed);
      msg.reply(parsed.nickname + "님의 공질이 저장되었습니다.");
      return;
    }

    handleAutoReply(msg);

    if (quizState[msg.room]) {
      let expiredAnswer = checkQuizTimeout(msg.room);
      if (expiredAnswer !== null) {
        msg.reply("퀴즈 시간이 종료되었습니다. 정답: " + expiredAnswer + "\n!퀴즈로 다시 시작하세요.");
        return;
      }
      let answer = quizState[msg.room].answer;
      let input = String(msg.content).trim();
      let numberMatch = false;
      if (quizState[msg.room].options) {
        for (let i = 0; i < quizState[msg.room].options.length; i++) {
          if (String(i + 1) === input && quizState[msg.room].options[i] === answer) {
            numberMatch = true;
            break;
          }
        }
      }
      if (numberMatch || normalizeAnswer(input) === normalizeAnswer(answer)) {
        addQuizScore(msg);
        msg.reply("정답입니다!\n" + quizState[msg.room].question + "의 정답: " + answer);
        delete quizState[msg.room];
        return;
      }
    }
  } catch (error) {
    Log.e("onMessage error: " + error);
  }
}

/* ===== 명령어 이벤트 ===== */
function onCommand(cmd) {
  try {
    let args = cmd.args || [];
    if (cmd.command === "도움말") {
      let sections = [];
      sections.push(formatBlock("기본", [
        "!도움말 : 안내 열기",
        "!채팅순위 [숫자] | 초기화",
        "!닉변조회 닉네임"
      ]));
      sections.push(formatBlock("공질", [
        "!공질 : 템플릿 보기",
        "!공질 닉네임 : 저장된 내용",
        "!공질 목록 / 수정 / 삭제 닉네임"
      ]));
      sections.push(formatBlock("자동응답", [
        "!자동응답추가 키워드 내용",
        "!자동응답수정 키워드 내용",
        "!자동응답삭제 키워드",
        "!자동응답목록",
        "!자동응답초기화"
      ]));
      sections.push(formatBlock("운세", [
        "!운세 YYYYMMDD|남/여"
      ]));
      sections.push(formatBlock("퀴즈·추첨", [
        "!퀴즈, !퀴즈랭킹",
        "!추첨 A B C ..."
      ]));
      cmd.reply(sections.join("\n"));
      return;
    }
    if (cmd.command === "채팅순위") {
      if (args.length > 0 && args[0] === "초기화") {
        resetChatRank(cmd.room);
        cmd.reply("채팅 순위를 초기화했습니다.");
        return;
      }
      let limit = args.length > 0 ? parseInt(args[0], 10) : MAX_CHAT_RANK;
      if (isNaN(limit) || limit <= 0) {
        limit = MAX_CHAT_RANK;
      }
      if (limit > MAX_CHAT_RANK) {
        limit = MAX_CHAT_RANK;
      }
      let body = formatChatRank(cmd.room, limit);
      cmd.reply("채팅 순위 Top" + limit + "\n" + VIEW_MORE + body);
      return;
    }

    if (cmd.command === "닉변조회") {
      if (args.length === 0) {
        cmd.reply("사용법: !닉변조회 닉네임");
        return;
      }
      cmd.reply(showNicknameHistory(args[0]));
      return;
    }

    if (cmd.command === "자동응답목록") {
      cmd.reply(listAutoReplies());
      return;
    }

    if (cmd.command === "자동응답초기화") {
      resetAutoReplies();
      cmd.reply(formatBlock("자동응답", ["모든 자동응답을 초기화했습니다."]));
      return;
    }

    if (cmd.command === "자동응답삭제") {
      if (args.length < 1) {
        cmd.reply("사용법: !자동응답삭제 키워드");
        return;
      }
      let targetKeyword = args[0];
      if (deleteAutoReply(targetKeyword)) {
        cmd.reply(formatBlock("자동응답", ["삭제 완료: " + targetKeyword]));
      } else {
        cmd.reply(formatBlock("자동응답", ["삭제할 키워드가 없습니다."]));
      }
      return;
    }

    if (cmd.command === "자동응답수정") {
      if (args.length < 2) {
        cmd.reply("사용법: !자동응답수정 키워드 내용");
        return;
      }
      let keyword = args[0];
      let message = cmd.content.replace(PREFIX + cmd.command + " " + keyword, "").trim();
      if (message.length === 0) {
        cmd.reply("응답 내용을 입력하세요.");
        return;
      }
      addAutoReply(keyword, message);
      cmd.reply(formatBlock("자동응답", ["수정 완료: " + keyword]));
      return;
    }

    if (cmd.command === "자동응답추가") {
      if (args.length < 2) {
        cmd.reply("사용법: !자동응답추가 키워드 내용");
        return;
      }
      let keyword = args[0];
      let message = cmd.content.replace(PREFIX + cmd.command + " " + keyword, "").trim();
      if (message.length === 0) {
        cmd.reply("응답 내용을 입력하세요.");
        return;
      }
      addAutoReply(keyword, message);
      cmd.reply("자동응답이 추가되었습니다: " + keyword);
      return;
    }

    if (cmd.command === "공질") {
      if (args.length === 0) {
        cmd.reply("공식 질문 템플릿\n" + VIEW_MORE + "닉네임:\n💚나이/지역:\n💜키:\n🧡MBTI/혈액형:\n🩷주량/흡연:\n💛프리한시간:\n💜썸상형:\n💜본인매력:\n❤️기동력:\n🩵오톡/기연:\n💜입방일:");
        return;
      }
      if (args[0] === "목록") {
        cmd.reply(listGongNames());
        return;
      }
      if (args[0] === "삭제") {
        if (args.length < 2) {
          cmd.reply("사용법: !공질 삭제 닉네임");
          return;
        }
        if (!isAdmin(cmd)) {
          cmd.reply(formatBlock("공질", ["삭제 권한이 없습니다."]));
          return;
        }
        let target = joinArgs(args, 1);
        if (deleteGong(target)) {
          cmd.reply(formatBlock("공질", [target + "님의 공질을 삭제했습니다."]));
        } else {
          cmd.reply(formatBlock("공질", ["삭제할 공질이 없습니다."]));
        }
        return;
      }
      if (args[0] === "수정") {
        if (args.length < 2) {
          cmd.reply("사용법: !공질 수정 닉네임 (새 템플릿을 그대로 입력해 주세요)");
          return;
        }
        if (!isAdmin(cmd)) {
          cmd.reply(formatBlock("공질", ["수정 권한이 없습니다."]));
          return;
        }
        let target = joinArgs(args, 1);
        if (!gongData[target]) {
          cmd.reply(formatBlock("공질", ["해당 닉네임의 공질이 없습니다. 새로 작성해 주세요."]));
          return;
        }
        deleteGong(target);
        cmd.reply(formatBlock("공질", [target + "님의 기존 공질을 삭제했습니다. 템플릿을 다시 입력하면 저장됩니다."]));
        return;
      }
      let nickname = joinArgs(args, 0);
      cmd.reply(renderGong(nickname));
      return;
    }

    if (cmd.command === "운세") {
      if (args.length === 0) {
        cmd.reply(showFortuneUsage());
        return;
      }
      let joined = cmd.content.substring((PREFIX + cmd.command).length).trim();
      if (joined.length === 0 || joined === cmd.command) {
        cmd.reply(showFortuneUsage());
        return;
      }
      let parts = joined.split("|");
      if (parts.length !== 2) {
        cmd.reply(buildFortuneError(parts));
        return;
      }
      let birth = parts[0].trim();
      let gender = parts[1].trim();
      if (!isValidFortuneDate(birth) || !isValidFortuneGender(gender)) {
        cmd.reply(buildFortuneError(parts));
        return;
      }
      let fortune = fetchFortuneFromNaver(birth, gender);
      if (!fortune || fortune.length === 0) {
        cmd.reply("운세 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.");
        return;
      }
      cmd.reply(fortune);
      return;
    }

    if (cmd.command === "퀴즈") {
      let question = startQuiz(cmd.room);
      if (!question) {
        cmd.reply("퀴즈 문제를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.");
        return;
      }
      if (quizState[cmd.room] && question.indexOf("이미 퀴즈가 진행 중입니다") === 0) {
        cmd.reply(question);
        return;
      }
      cmd.reply("퀴즈가 시작되었습니다!\n" + question);
      return;
    }

    if (cmd.command === "퀴즈랭킹") {
      cmd.reply(renderQuizRank());
      return;
    }

    if (cmd.command === "추첨") {
      if (args.length === 0) {
        cmd.reply("사용법: !추첨 A B C ...");
        return;
      }
      cmd.reply(pickRandom(args));
      return;
    }
  } catch (error) {
    Log.e("onCommand error: " + error);
    cmd.reply("명령 처리 중 오류가 발생했습니다.");
  }
}

bot.setCommandPrefix(PREFIX);
bot.addListener(Event.MESSAGE, onMessage);
bot.addListener(Event.COMMAND, onCommand);
