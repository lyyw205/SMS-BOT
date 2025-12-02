// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pkg from "pg";
import OpenAI from "openai";

dotenv.config();
const { Pool } = pkg;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL is not set in .env");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
});

// ---------- 유틸: 한국 시간 기준 야간 여부 ----------
function isNightTime(date = new Date()) {
  const kst = new Date(date.toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  const hour = kst.getHours(); // 0~23
  return hour >= 3 && hour < 10; // 03:00 ~ 09:59 야간
}

let cachedConfig = {
  intents: [],
  actionIntentNames: [],
  nightDeferReply: null,
  complaintReply: null,
  lastLoadedAt: null,
};

async function loadConfig() {
  const client = await pool.connect();
  try {
    // 1) intents
    const intentsRes = await client.query(`
      SELECT name, description, is_action, is_complaint_like
      FROM intents
      ORDER BY id;
    `);

    const intents = intentsRes.rows;
    const actionIntentNames = intents
      .filter((i) => i.is_action)
      .map((i) => i.name);

    // 2) bot_settings
    const settingsRes = await client.query(`
      SELECT key, value
      FROM bot_settings;
    `);
    const settings = {};
    for (const row of settingsRes.rows) {
      settings[row.key] = row.value;
    }

    cachedConfig = {
      intents,
      actionIntentNames,
      nightDeferReply:
        settings["night_defer_reply"] ||
        "지금은 야간 자동응답 시간이라 접수만 가능합니다.\n상세 확인 후 오전 10시 이후에 다시 안내드릴게요 :)",
      complaintReply:
        settings["complaint_reply"] ||
        "불편을 드려 정말 죄송합니다.\n내용을 담당자에게 바로 전달했고, 가능한 빠르게 직접 연락드리겠습니다.",
      lastLoadedAt: new Date(),
    };

    console.log("✅ config loaded:", {
      intents: intents.length,
      actionIntentNames: actionIntentNames.length,
    });
  } finally {
    client.release();
  }
}

// 서버 시작할 때 한 번 로드
await loadConfig();

// ---------- (TODO) 게스트 상태 조회 - 지금은 더미 ----------
async function getGuestState(phoneNumber) {
  // 나중에 guest_cache / 구글시트 조회 로직 연결
  // 지금은 항상 'UNKNOWN' 반환
  return "UNKNOWN";
}

// ---------- 인텐트 분류 LLM ----------
async function classifyIntent(text, guestState) {
  // config 없으면 한 번 강제 로드 (안전장치)
  if (!cachedConfig.lastLoadedAt) {
    await loadConfig();
  }

  const intentsText = cachedConfig.intents
    .map(
      (i) =>
        `- ${i.name} : ${i.description}${
          i.is_action ? " (야간에는 처리 보류 대상)" : ""
        }`
    )
    .join("\n");

  const systemPrompt = `
너는 게스트하우스 문자 자동응답 시스템의 "인텐트 분류기"야.
아래 규칙을 꼭 지켜.

- 출력 형식은 반드시 JSON으로만 내보내.
- 키는 항상 intent, confidence, is_complaint 3가지.
- intent는 문자열, confidence는 0~1 숫자, is_complaint는 true/false.

intent는 일단 아래 중에서 가장 어울리는 걸 고르고, 딱 맞는게 없으면 "GENERIC"으로 해.

가능한 intent 값 목록:
${intentsText || "- GENERIC : 기타 문의"}
`;

  const userPrompt = `
[문자 내용]
"${text}"

[현재 게스트 상태]
"${guestState}"

위 문자에 대해 intent, confidence(0~1), is_complaint를 JSON 하나로만 반환해.
예시: {"intent":"CHECKIN_TIME","confidence":0.83,"is_complaint":false}
`;

  try {
    const resp = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: systemPrompt.trim() },
        { role: "user", content: userPrompt.trim() },
      ],
      temperature: 0.0,
    });

    const raw = resp.choices[0]?.message?.content?.trim() || "";
    let parsed;

    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.warn("⚠️ classifyIntent JSON 파싱 실패, raw:", raw);
      // 파싱 실패 시 GENERIC fallback
      return {
        intent: "GENERIC",
        confidence: 0.3,
        is_complaint: false,
      };
    }

    return {
      intent: parsed.intent || "GENERIC",
      confidence:
        typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      is_complaint: !!parsed.is_complaint,
    };
  } catch (err) {
    console.error("❌ classifyIntent OpenAI error:", err);
    // LLM 오류시도 안전한 기본값
    return {
      intent: "GENERIC",
      confidence: 0.2,
      is_complaint: false,
    };
  }
}

// ---------- (TODO) 욕설/클레임 감지 ----------
function isComplaint(intentResult) {
  // 나중엔 intentResult.is_complaint or 키워드 기반
  return intentResult.is_complaint === true;
}

// ---------- (TODO) 야간 접수용 기본 멘트 ----------
function buildNightDeferReply(intentResult, guestState) {
  return (
    "지금은 야간 자동응답 시간이라 접수만 가능합니다.\n" +
    "상세 확인 후 오전 10시 이후에 다시 안내드릴게요 :)"
  );
}

// ---------- (TODO) 클레임 기본 멘트 ----------
function buildComplaintAutoReply() {
  return (
    "불편을 드려 정말 죄송합니다.\n" +
    "내용을 담당자에게 바로 전달했고, 가능한 빠르게 직접 연락드리겠습니다."
  );
}

// ---------- 답변 생성 LLM (RAG 없이 1차 버전) ----------
async function generateReplyWithLLM({ text, guestState, intent, knowledge = [] }) {
  const kbText = knowledge
    .map((k) => `- ${k.title}: ${k.content}`)
    .join("\n");

  const userPrompt = `
[손님 문자 내용]
${text}

[현재 게스트 상태 guestState (예: NO_RECORD, BOOKED_UNPAID, BOOKED_PAID, STAYING_TODAY 등)]
${guestState}

[인텐트 intent]
${intent}

[관련 지식 (knowledge_base에서 온 내용)]
${kbText || "(관련 지식 없음)"}

위 정보를 참고해서, 손님에게 보낼 답장 한 개를 한국어로 만들어줘.
앞뒤 따옴표 없이, 실제 문자 그대로 쓸 수 있게 문장만 출력해.
`;

  try {
    const resp = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: systemPrompt.trim() },
        { role: "user", content: userPrompt.trim() },
      ],
      temperature: 0.4,
    });

    const reply =
      resp.choices[0]?.message?.content?.trim() ||
      "문의 감사합니다! 현재 자동응답 시스템 세팅 중입니다 :)";

    return reply;
  } catch (err) {
    console.error("❌ generateReplyWithLLM OpenAI error:", err);
    return "문의 감사합니다! 현재 자동응답 시스템 세팅 중이라, 조금 뒤에 다시 안내드리겠습니다 :)";
  }
}

async function retrieveKnowledge(intentResult) {
  const client = await pool.connect();
  try {
    const q = `
      SELECT title, content
      FROM knowledge_base
      WHERE category = $1
      ORDER BY updated_at DESC
      LIMIT 5;
    `;
    const { rows } = await client.query(q, [intentResult.intent]);
    return rows;
  } finally {
    client.release();
  }
}

// ---------- (TODO) SMS 발송 래퍼 - 지금은 콘솔만 ----------
async function sendSms(to, text) {
  // 나중에 실제 SMS 업체 API와 연동
  console.log("📤 [SEND SMS]", { to, text });
}

// ---------- 헬스체크 ----------
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ---------- SMS Webhook 엔드포인트 ----------
/**
 * 개발용 요청 형식 예시:
 * POST /sms/webhook
 * {
 *   "from": "01012345678",
 *   "text": "체크인 몇 시에요?",
 *   "receivedAt": "2025-12-03T15:00:00+09:00" (옵션)
 * }
 *
 * 실제 SMS 업체 쓰게 되면 parseSmsProviderPayload()만 바꾸면 됨
 */
function parseSmsProviderPayload(body) {
  // ★ 여기만 나중에 업체 포맷에 맞게 수정하면 됨
  const from = body.from || body.phone || body.sender;
  const text = body.text || body.message || "";
  const receivedAt = body.receivedAt ? new Date(body.receivedAt) : new Date();
  return { from, text, receivedAt };
}

function buildNightDeferReply(intentResult, guestState) {
  return cachedConfig.nightDeferReply;
}

function buildComplaintAutoReply() {
  return cachedConfig.complaintReply;
}

app.post("/sms/webhook", async (req, res) => {
  const client = await pool.connect();

  try {
    const { from, text, receivedAt } = parseSmsProviderPayload(req.body);
    if (!from || !text) {
      return res.status(400).json({ error: "from, text is required" });
    }

    // 1) IN 메세지 로그 저장
    const insertInQuery = `
      INSERT INTO messages (direction, phone_number, text, created_at)
      VALUES ('IN', $1, $2, $3)
      RETURNING id, created_at;
    `;
    const inResult = await client.query(insertInQuery, [
      from,
      text,
      receivedAt,
    ]);
    const incomingId = inResult.rows[0].id;

    // 2) 게스트 상태 조회
    const guestState = await getGuestState(from);

    // 3) 인텐트 분류
    const intentResult = await classifyIntent(text, guestState);

    // 4) 시간대/정책에 따라 처리 방식 결정
    const night = isNightTime(receivedAt);
    const actionIntents = cachedConfig.actionIntentNames;
    const shouldDefer =
      night && actionIntents.includes(intentResult.intent);

    let replyText = "";
    let needFollowup = false;
    let followupReason = null;

    if (isComplaint(intentResult)) {
      // 욕설/클레임
      replyText = buildComplaintAutoReply();
      needFollowup = true;
      followupReason = "COMPLAINT";
    } else if (shouldDefer) {
      // 야간 접수만
      replyText = buildNightDeferReply(intentResult, guestState);
      needFollowup = true;
      followupReason = "NIGHT_ACTION";
    } else {
      // 일반 케이스: RAG + LLM 답변
      const knowledgeSnippets = await retrieveKnowledge(intentResult);
      replyText = await generateReplyWithLLM({
        text,
        guestState,
        intent: intentResult.intent,
        knowledge: knowledgeSnippets,
      });
    }

    // 5) 문자 실제 발송 (지금은 콘솔만)
    await sendSms(from, replyText);

    // 6) OUT 메시지 로그 + IN에 대한 응답 관계, 분류 결과 업데이트
    const insertOutQuery = `
      INSERT INTO messages (
        direction, phone_number, text, intent, confidence,
        guest_state, handled_by, need_followup, resolved, reply_to_id
      )
      VALUES (
        'OUT', $1, $2, $3, $4,
        $5, $6, $7, $8, $9
      )
      RETURNING id;
    `;

    const handledBy = needFollowup ? "AUTO_PENDING" : "AUTO";
    const resolved = !needFollowup;

    const outResult = await client.query(insertOutQuery, [
      from,
      replyText,
      intentResult.intent,
      intentResult.confidence,
      guestState,
      handledBy,
      needFollowup,
      resolved,
      incomingId,
    ]);
    const outgoingId = outResult.rows[0].id;

    // 7) followup_queue에 등록
    if (needFollowup) {
      const insertFollowupQuery = `
        INSERT INTO followup_queue (message_id, status, reason)
        VALUES ($1, 'PENDING', $2);
      `;
      await client.query(insertFollowupQuery, [incomingId, followupReason]);
    }

    // 8) IN 메시지도 intent/guest_state 업데이트
    const updateInQuery = `
      UPDATE messages
      SET intent = $1,
          confidence = $2,
          guest_state = $3,
          need_followup = $4,
          resolved = $5
      WHERE id = $6;
    `;
    await client.query(updateInQuery, [
      intentResult.intent,
      intentResult.confidence,
      guestState,
      needFollowup,
      resolved,
      incomingId,
    ]);

    res.status(200).json({
      ok: true,
      incoming_id: incomingId,
      outgoing_id: outgoingId,
      intent: intentResult.intent,
      guest_state: guestState,
      night,
      need_followup: needFollowup,
    });
  } catch (err) {
    console.error("❌ Error in /sms/webhook:", err);
    res.status(500).json({ error: "internal_server_error" });
  } finally {
    client.release();
  }
});



// ---------- 서버 시작 ----------
app.listen(PORT, () => {
  console.log(`🚀 SMS bot server listening on port ${PORT}`);
});
