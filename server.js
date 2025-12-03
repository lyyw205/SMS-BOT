// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pkg from "pg";
import OpenAI from "openai";
import {
  ORCHESTRATOR_SYSTEM_PROMPT,
  buildOrchestratorUserPrompt,
} from "./llm_spec.js";

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
  templates: {},
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

    // 3) intent_templates 🔥
    const tmplRes = await client.query(`
      SELECT intent_name, sub_intent, display_label, message
      FROM intent_templates
      WHERE is_active = TRUE
      ORDER BY intent_name, sort_order, id;
    `);

    const templatesByIntent = {};
    for (const row of tmplRes.rows) {
      if (!templatesByIntent[row.intent_name]) {
        templatesByIntent[row.intent_name] = [];
      }
      templatesByIntent[row.intent_name].push({
        sub_intent: row.sub_intent,
        label: row.display_label,
        message: row.message,
      });
    }

    cachedConfig = {
      intents,
      actionIntentNames,
      templates: templatesByIntent,   // 🔹 추가
      lastLoadedAt: new Date(),
    };

    console.log("✅ config loaded:", {
      intents: intents.length,
      actionIntentNames: actionIntentNames.length,
      templatesIntents: Object.keys(templatesByIntent).length,
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



// ---------- (TODO) 욕설/클레임 감지 ----------
function isComplaint(intentResult) {
  // 나중엔 intentResult.is_complaint or 키워드 기반
  return intentResult.is_complaint === true;
}


async function retrieveKnowledge(intentResult, dbClient) {
  const client = dbClient || await pool.connect(); 
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
    if (!dbClient) client.release();
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


// RAG용 지식 조회 (일단은 PARTY 관련만, 나중에 확장 가능)
async function retrieveKnowledgeForRAG({ text, client }) {
  // TODO: 나중에는 text 기반 벡터 서치 or full text search 로 바꾸면 됨
  const q = `
    SELECT category, title, content
    FROM knowledge_base
    WHERE category IN ('PARTY', 'PARTY_RESERVATION_FLOW', 'CHECKIN', 'CHECKOUT')
    ORDER BY updated_at DESC
    LIMIT 20;
  `;
  const { rows } = await client.query(q);
  return rows;
}

async function runOrchestratorLLM({ text, guestState, history, knowledge }) {
  const userPrompt = buildOrchestratorUserPrompt({
    text,
    guestState,
    history,
    knowledge,
  });

  try {
    const resp = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: ORCHESTRATOR_SYSTEM_PROMPT.trim() },
        { role: "user", content: userPrompt.trim() },
      ],
      temperature: 0.3,
    });

    const raw = resp.choices[0]?.message?.content?.trim() || "{}";
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error("❌ Orchestrator JSON parse error:", raw);
      parsed = null;
    }

    if (!parsed || typeof parsed !== "object") {
      return {
        reply_text:
          "문의 감사합니다! 현재 자동응답 시스템 세팅 중이라, 조금 뒤에 다시 안내드리겠습니다 :)",
        intent: "GENERIC",
        flow_type: null,
        slots: {},
        need_followup: true,
        end_flow: false,
      };
    }

    return {
      reply_text: parsed.reply_text || "",
      intent: parsed.intent || "GENERIC",
      flow_type: parsed.flow_type || null,
      slots: parsed.slots || {},
      need_followup: !!parsed.need_followup,
      end_flow: !!parsed.end_flow,
    };
  } catch (err) {
    console.error("❌ runOrchestratorLLM error:", err);
    return {
      reply_text:
        "문의 감사합니다! 현재 자동응답 시스템 세팅 중이라, 조금 뒤에 다시 안내드리겠습니다 :)",
      intent: "GENERIC",
      flow_type: null,
      slots: {},
      need_followup: true,
      end_flow: false,
    };
  }
}


app.post("/sms/webhook", async (req, res) => {
  const client = await pool.connect();

  try {
    const { from, text, receivedAt } = parseSmsProviderPayload(req.body);
    if (!from || !text) {
      return res.status(400).json({ error: "from, text is required" });
    }

    await client.query("BEGIN");

    // 1) IN 메세지 저장
    const inRes = await client.query(
      `
      INSERT INTO messages (direction, phone_number, text, created_at)
      VALUES ('IN', $1, $2, $3)
      RETURNING id;
      `,
      [from, text, receivedAt]
    );
    const incomingId = inRes.rows[0].id;

    // 2) 게스트 상태 + 최근 대화 히스토리
    const guestState = await getGuestState(from);

    const historyRes = await client.query(
      `
      SELECT direction, text
      FROM messages
      WHERE phone_number = $1
      ORDER BY id DESC
      LIMIT 10;
      `,
      [from]
    );
    const history = historyRes.rows
      .reverse()
      .map((r) => ({ direction: r.direction, text: r.text }));

    // 3) RAG: 관련 지식 불러오기
    const knowledge = await retrieveKnowledgeForRAG({ text, client });

    // 4) LLM 오케스트레이터 호출
    const {
      reply_text,
      intent,
      flow_type,
      slots,
      need_followup,
      end_flow,
    } = await runOrchestratorLLM({
      text,
      guestState,
      history,
      knowledge,
    });

    let outgoingId = null;

    // 5) 문자 발송 + OUT 저장
    if (reply_text && reply_text.trim() !== "") {
      await sendSms(from, reply_text);

      const outRes = await client.query(
        `
        INSERT INTO messages (
          direction, phone_number, text,
          intent, guest_state, handled_by,
          need_followup, resolved, reply_to_id,
          slots, flow_type
        )
        VALUES (
          'OUT', $1, $2,
          $3, $4, $5,
          $6, $7, $8,
          $9, $10
        )
        RETURNING id;
        `,
        [
          from,
          reply_text,
          intent || null,
          guestState || null,
          "LLM_ORCHESTRATOR",
          !!need_followup,
          !need_followup,
          incomingId,
          Object.keys(slots || {}).length > 0 ? JSON.stringify(slots) : null,
          flow_type || null,
        ]
      );
      outgoingId = outRes.rows[0].id;
    }

    // 6) followup_queue 등록 (필요 시)
    if (need_followup) {
      await client.query(
        `
        INSERT INTO followup_queue (message_id, status, reason)
        VALUES ($1, 'PENDING', $2);
        `,
        [incomingId, "LLM_FLAGGED"]
      );
    }

    // 7) IN 메시지 업데이트
    await client.query(
      `
      UPDATE messages
      SET intent = $1,
          guest_state = $2,
          need_followup = $3,
          resolved = $4
      WHERE id = $5;
      `,
      [intent || null, guestState || null, !!need_followup, !need_followup, incomingId]
    );

    await client.query("COMMIT");

    res.json({
      ok: true,
      incoming_id: incomingId,
      outgoing_id: outgoingId,
      intent,
      flow_type,
      end_flow,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ /sms/webhook error:", err);
    res.status(500).json({ error: "internal_server_error" });
  } finally {
    client.release();
  }
});


// ==========================================
// [ADMIN API] 1. 인텐트 관리 (Intents)
// ==========================================

// 조회
app.get("/admin/intents", async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query("SELECT * FROM intents ORDER BY id");
    res.json(result.rows);
  } finally { client.release(); }
});

// 추가
app.post("/admin/intents", async (req, res) => {
  const { name, description, is_action, is_complaint_like } = req.body;
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO intents (name, description, is_action, is_complaint_like) VALUES ($1, $2, $3, $4)`,
      [name, description, is_action, is_complaint_like]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
  finally { client.release(); }
});

// 수정
app.put("/admin/intents/:id", async (req, res) => {
  const { id } = req.params;
  const { description, is_action, is_complaint_like } = req.body;
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE intents SET description=$1, is_action=$2, is_complaint_like=$3 WHERE id=$4`,
      [description, is_action, is_complaint_like, id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
  finally { client.release(); }
});

// 삭제
app.delete("/admin/intents/:id", async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query(`DELETE FROM intents WHERE id=$1`, [id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
  finally { client.release(); }
});


// ==========================================
// [ADMIN API] 2. 템플릿 관리 (Templates)
// ==========================================

// 조회
app.get("/admin/templates", async (req, res) => {
  const { intent } = req.query;
  const client = await pool.connect();
  try {
    let q = `SELECT * FROM intent_templates WHERE is_active = TRUE`;
    const params = [];
    if (intent) {
      q += ` AND intent_name = $1`;
      params.push(intent);
    }
    q += ` ORDER BY intent_name, sort_order, id`;
    const result = await client.query(q, params);
    res.json(result.rows);
  } finally { client.release(); }
});

// 추가
app.post("/admin/templates", async (req, res) => {
  const { intent_name, sub_intent, display_label, message } = req.body;
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO intent_templates (intent_name, sub_intent, display_label, message) VALUES ($1, $2, $3, $4)`,
      [intent_name, sub_intent, display_label, message]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
  finally { client.release(); }
});

// 수정
app.put("/admin/templates/:id", async (req, res) => {
  const { id } = req.params;
  const { intent_name, sub_intent, display_label, message } = req.body;
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE intent_templates SET intent_name=$1, sub_intent=$2, display_label=$3, message=$4 WHERE id=$5`,
      [intent_name, sub_intent, display_label, message, id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
  finally { client.release(); }
});

// 삭제
app.delete("/admin/templates/:id", async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query(`DELETE FROM intent_templates WHERE id=$1`, [id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
  finally { client.release(); }
});


// ==========================================
// [ADMIN API] 3. 지식 관리 (Knowledge Base)
// ==========================================

// 조회
app.get("/admin/knowledge", async (req, res) => {
  const { intent } = req.query;
  const client = await pool.connect();
  try {
    let q = `SELECT * FROM knowledge_base`;
    const params = [];
    if (intent) {
      q += ` WHERE category = $1`;
      params.push(intent);
    }
    q += ` ORDER BY updated_at DESC`;
    const result = await client.query(q, params);
    res.json(result.rows);
  } finally { client.release(); }
});

// 추가
app.post("/admin/knowledge", async (req, res) => {
  const { category, title, content } = req.body;
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO knowledge_base (category, title, content) VALUES ($1, $2, $3)`,
      [category, title, content]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
  finally { client.release(); }
});

// 수정
app.put("/admin/knowledge/:id", async (req, res) => {
  const { id } = req.params;
  const { category, title, content } = req.body;
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE knowledge_base SET category=$1, title=$2, content=$3, updated_at=NOW() WHERE id=$4`,
      [category, title, content, id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
  finally { client.release(); }
});

// 삭제
app.delete("/admin/knowledge/:id", async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query(`DELETE FROM knowledge_base WHERE id=$1`, [id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
  finally { client.release(); }
});


// ==========================================
// [ADMIN API] 4. 팔로우업 & 설정 관리
// ==========================================

// 팔로우업 상태/메모 수정
app.patch("/admin/followups/:id", async (req, res) => {
  const { id } = req.params;
  const { status, memo, resolved } = req.body;

  const client = await pool.connect();
  try {
    const fields = [];
    const params = [];
    let idx = 1;

    if (status) {
      fields.push(`status = $${idx++}`);
      params.push(status);
    }
    if (memo !== undefined) {
      fields.push(`memo = $${idx++}`);
      params.push(memo);
    }
    if (resolved !== undefined) {
      fields.push(`resolved = $${idx++}`);
      params.push(resolved);
    }

    if (fields.length === 0) {
      return res.status(400).json({ error: "no fields to update" });
    }

    const q = `
      UPDATE followup_queue
      SET ${fields.join(", ")},
          updated_at = NOW()
      WHERE id = $${idx}
    `;
    params.push(id);

    await client.query(q, params);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ followup PATCH error:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 팔로우업 상태 수정 (완료 처리 or 메모 저장)
app.get("/admin/followups", async (req, res) => {
  const status = req.query.status;
  const reason = req.query.reason;
  
  const client = await pool.connect();
  try {
    // 1. 쿼리 작성: 컬럼명 앞에 f. 또는 m. 을 명확히 붙여줍니다.
    let q = `
      SELECT 
        f.id, 
        f.status, 
        f.reason, 
        f.memo, 
        f.created_at,   -- 여기가 핵심! f.created_at 이라고 명시
        m.phone_number, 
        m.text, 
        m.guest_state, 
        m.intent
      FROM followup_queue f
      LEFT JOIN messages m ON f.message_id = m.id
      WHERE 1=1
    `;
    
    const params = [];
    let idx = 1;

    // 2. 필터 조건
    if (status && status !== 'ALL') {
      q += ` AND f.status = $${idx++}`;
      params.push(status);
    }
    if (reason) {
      q += ` AND f.reason = $${idx++}`;
      params.push(reason);
    }
    
    // 3. 정렬: 여기서도 f.created_at 이라고 명시해야 에러가 안 납니다.
    q += ` ORDER BY f.created_at DESC LIMIT 100`;

    // (디버깅용) 터미널에 쿼리를 찍어봅니다.
    // console.log("📝 실행될 쿼리:", q);

    const result = await client.query(q, params);

    res.json(result.rows.map(row => ({
      id: row.id,
      status: row.status,
      reason: row.reason,
      memo: row.memo,
      message: {
        phone_number: row.phone_number || "정보 없음", // LEFT JOIN 대비
        text: row.text || "(삭제된 메시지)",
        guest_state: row.guest_state,
        intent: row.intent,
        created_at: row.created_at
      }
    })));

  } catch (err) { 
    // ★ 에러가 나면 터미널에 빨간색으로 이유를 출력합니다.
    console.error("❌ Followup 조회 에러:", err); 
    res.status(500).json({ error: err.message }); 
  } finally { 
    client.release(); 
  }
});

// 설정 리로드
app.post("/admin/reload-config", async (req, res) => {
  try {
    await loadConfig();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



// ---------- 서버 시작 ----------
app.listen(PORT, () => {
  console.log(`🚀 SMS bot server listening on port ${PORT}`);
});
