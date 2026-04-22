import Anthropic from '@anthropic-ai/sdk';
import { dbPool } from '../db/client.js';
import { sendDM } from './discord-bot.js';

const NUDGE_MODEL = 'claude-haiku-4-5-20251001';
const REPLY_MODEL = 'claude-sonnet-4-6';

let _ai = null;
function getAi() {
  if (!_ai) _ai = new Anthropic();
  return _ai;
}

// Nudge thresholds: days_since_last_study required to trigger, given days_until_exam
function shouldNudge(daysSince, daysUntilExam) {
  if (daysUntilExam === null) return daysSince >= 14;
  if (daysUntilExam <= 30)   return daysSince >= 3;
  if (daysUntilExam <= 90)   return daysSince >= 7;
  return daysSince >= 14;
}

async function buildNudgeMessage(subject, daysSince, daysUntilExam) {
  const examContext = daysUntilExam != null
    ? `El examen es en ${daysUntilExam} días.`
    : 'No hay fecha de examen configurada para esta materia.';

  const resp = await getAi().messages.create({
    model: NUDGE_MODEL,
    max_tokens: 200,
    system: `Sos un asistente de estudio amigable y directo. Escribís mensajes cortos de Discord (2-3 oraciones máximo).
Notás que el usuario no estudió una materia en varios días. Sos curioso, no regañón. Preguntás qué pasó.
No uses más de 1 emoji. Respondé solo el mensaje, sin comillas ni formato adicional.`,
    messages: [
      {
        role: 'user',
        content: `El usuario no estudió "${subject}" en ${daysSince} días. ${examContext} Escribí el mensaje de alerta.`
      }
    ]
  });

  return resp.content[0]?.text?.trim() || `Che, ¿todo bien? No veo que hayas estudiado ${subject} en los últimos ${daysSince} días. ¿Qué está pasando?`;
}

async function buildStudyTips(subject) {
  const resp = await getAi().messages.create({
    model: REPLY_MODEL,
    max_tokens: 400,
    system: `Sos un coach de estudio experto. Proponés estrategias creativas y concretas, no genéricas.
Cada estrategia dura menos de 30 minutos y usa técnicas de recuperación activa, intercalado o aplicación real.
Respondé en español, con viñetas simples. Sin intro ni cierre, solo las estrategias.`,
    messages: [
      {
        role: 'user',
        content: `Propone 2-3 formas innovadoras de avanzar con "${subject}" hoy.`
      }
    ]
  });

  return resp.content[0]?.text?.trim() || '';
}

export async function checkAndNudge(userId) {
  try {
    const [activityRes, examsRes, snoozeRes] = await Promise.all([
      dbPool.query(
        `SELECT subject, MAX(logged_date) AS last_studied
         FROM activity_log
         WHERE user_id = $1
           AND activity_type = 'study'
           AND logged_date >= CURRENT_DATE - INTERVAL '60 days'
         GROUP BY subject`,
        [userId]
      ),
      dbPool.query(
        `SELECT subject, MIN(exam_date) AS next_exam
         FROM subject_exam_dates
         WHERE user_id = $1 AND exam_date >= CURRENT_DATE
         GROUP BY subject`,
        [userId]
      ),
      dbPool.query(
        `SELECT subject FROM subject_snooze
         WHERE user_id = $1 AND snoozed_until >= CURRENT_DATE`,
        [userId]
      )
    ]);

    const snoozedSubjects = new Set(snoozeRes.rows.map((r) => r.subject));
    const examBySubject   = Object.fromEntries(examsRes.rows.map((r) => [r.subject, r.next_exam]));
    const today           = new Date();

    for (const row of activityRes.rows) {
      const { subject, last_studied } = row;
      if (snoozedSubjects.has(subject)) continue;

      const lastDate    = new Date(last_studied);
      const daysSince   = Math.floor((today - lastDate) / 86400000);
      const examDate    = examBySubject[subject] ? new Date(examBySubject[subject]) : null;
      const daysUntilExam = examDate ? Math.ceil((examDate - today) / 86400000) : null;

      if (!shouldNudge(daysSince, daysUntilExam)) continue;

      const message = await buildNudgeMessage(subject, daysSince, daysUntilExam);
      const sent    = await sendDM(message);

      await dbPool.query(
        `INSERT INTO bot_conversations (user_id, discord_channel_id, discord_message_id, direction, subject, body)
         VALUES ($1, $2, $3, 'outbound', $4, $5)`,
        [userId, sent?.channelId || '', sent?.id || null, subject, message]
      );

      // One nudge per day max — break after first to avoid flooding
      break;
    }
  } catch (err) {
    console.error('[study-nudge] checkAndNudge error:', err.message);
  }
}

export async function handleUserReply({ discordUserId, replyText, channelId, messageId }) {
  // Resolve internal user_id from discord_user_id env match
  const configuredDiscordId = process.env.DISCORD_USER_ID;
  if (!configuredDiscordId || discordUserId !== configuredDiscordId) return;

  const userRes = await dbPool.query(
    `SELECT id FROM users ORDER BY id ASC LIMIT 1`
  );
  if (!userRes.rows.length) return;
  const userId = userRes.rows[0].id;

  // Store incoming message
  await dbPool.query(
    `INSERT INTO bot_conversations (user_id, discord_channel_id, discord_message_id, direction, body)
     VALUES ($1, $2, $3, 'inbound', $4)`,
    [userId, channelId, messageId, replyText]
  );

  // Fetch recent conversation context
  const contextRes = await dbPool.query(
    `SELECT direction, subject, body FROM bot_conversations
     WHERE user_id = $1
     ORDER BY created_at DESC LIMIT 6`,
    [userId]
  );
  const history = contextRes.rows.reverse();
  const contextText = history.map((r) => `[${r.direction}] ${r.body}`).join('\n');

  // Ask Claude to parse intent and generate reply
  const parseResp = await getAi().messages.create({
    model: REPLY_MODEL,
    max_tokens: 500,
    system: `Sos un asistente de estudio que analiza respuestas de un estudiante.
El estudiante respondió a un mensaje tuyo sobre una materia que no estudió.
Analizá el contexto y devolvé SOLO JSON válido con estos campos:
{
  "intent": "explained_priority" | "will_study" | "needs_help" | "other",
  "subject": "nombre de la materia o null",
  "snooze_until": "YYYY-MM-DD o null",
  "reply_message": "respuesta cálida y concisa para enviar de vuelta"
}
Para "explained_priority": si el estudiante explica que el examen es en N meses/semanas, calculá snooze_until como la fecha actual más (N meses - 60 días).
Para "will_study": snooze_until es null, reply_message los alienta.
Para "needs_help": snooze_until es null, el campo reply_message puede ser más largo con sugerencias.
Hoy es ${new Date().toISOString().slice(0, 10)}.`,
    messages: [
      {
        role: 'user',
        content: `Conversación reciente:\n${contextText}\n\nÚltima respuesta del usuario: "${replyText}"`
      }
    ]
  });

  let parsed;
  try {
    const raw = parseResp.content[0]?.text?.trim() || '{}';
    parsed = JSON.parse(raw);
  } catch {
    parsed = { intent: 'other', reply_message: 'Gracias por tu respuesta. ¡Seguí así!' };
  }

  // Store snooze if applicable
  if (parsed.intent === 'explained_priority' && parsed.subject && parsed.snooze_until) {
    await dbPool.query(
      `INSERT INTO subject_snooze (user_id, subject, reason, snoozed_until)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, subject) DO UPDATE
         SET reason = EXCLUDED.reason, snoozed_until = EXCLUDED.snoozed_until, created_at = now()`,
      [userId, parsed.subject, replyText, parsed.snooze_until]
    );
  }

  // Append study tips for needs_help
  let replyText2 = parsed.reply_message || '¡Gracias por escribir!';
  if (parsed.intent === 'needs_help' && parsed.subject) {
    const tips = await buildStudyTips(parsed.subject);
    if (tips) replyText2 += `\n\n${tips}`;
  }

  const sent = await sendDM(replyText2);

  await dbPool.query(
    `INSERT INTO bot_conversations (user_id, discord_channel_id, discord_message_id, direction, subject, body)
     VALUES ($1, $2, $3, 'outbound', $4, $5)`,
    [userId, channelId, sent?.id || null, parsed.subject || null, replyText2]
  );
}
