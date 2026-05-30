import nodemailer from 'nodemailer';
import { dbPool } from '../db/client.js';

// ─── DB ──────────────────────────────────────────────────────────────────────

async function getYesterdayAnalyses() {
  const result = await dbPool.query(`
    SELECT id, started_at, ended_at, actual_minutes, actual_card_count, analysis
    FROM study_sessions
    WHERE DATE(started_at AT TIME ZONE 'America/Argentina/Buenos_Aires') = CURRENT_DATE - INTERVAL '1 day'
      AND analysis IS NOT NULL AND analysis != ''
      AND (subject_name IS NULL OR LOWER(subject_name) NOT IN ('chino', 'chino produccion'))
    ORDER BY started_at ASC
  `);
  return result.rows;
}

// ─── MARKDOWN → HTML ─────────────────────────────────────────────────────────

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderInlineHtml(text) {
  // Process in order: avoid double-processing
  let out = escapeHtml(text);
  // **bold**
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // `code`
  out = out.replace(/`(.+?)`/g, '<code style="background:#f0f0f0;padding:1px 4px;border-radius:3px;font-family:monospace;color:#c0392b;font-size:0.9em">$1</code>');
  // $inline math$
  out = out.replace(/\$([^$]+)\$/g, '<code style="background:#eaf4fb;padding:1px 4px;border-radius:3px;font-family:monospace;color:#1a5276;font-size:0.9em">$1</code>');
  // *italic*
  out = out.replace(/\*(.+?)\*/g, '<em>$1</em>');
  return out;
}

function markdownToHtml(mdText) {
  const lines = mdText.split('\n');
  const htmlParts = [];
  let i = 0;
  let inList = false;
  let listTag = '';

  function closeList() {
    if (inList) {
      htmlParts.push(`</${listTag}>`);
      inList = false;
      listTag = '';
    }
  }

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Display math $$...$$ block
    if (trimmed === '$$') {
      closeList();
      const mathLines = [];
      i++;
      while (i < lines.length && lines[i].trim() !== '$$') {
        mathLines.push(escapeHtml(lines[i]));
        i++;
      }
      htmlParts.push(`<pre style="background:#eaf4fb;border-left:4px solid #3498db;padding:12px 16px;border-radius:4px;overflow-x:auto;font-family:monospace;font-size:0.88em;color:#1a5276;white-space:pre-wrap;word-break:break-word">${mathLines.join('\n')}</pre>`);
      i++;
      continue;
    }
    if (trimmed.startsWith('$$') && trimmed.endsWith('$$') && trimmed.length > 4) {
      closeList();
      htmlParts.push(`<pre style="background:#eaf4fb;border-left:4px solid #3498db;padding:12px 16px;border-radius:4px;overflow-x:auto;font-family:monospace;font-size:0.88em;color:#1a5276;white-space:pre-wrap;word-break:break-word">${escapeHtml(trimmed.slice(2, -2).trim())}</pre>`);
      i++;
      continue;
    }

    // Fenced code block ```
    if (trimmed.startsWith('```')) {
      closeList();
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(escapeHtml(lines[i]));
        i++;
      }
      htmlParts.push(`<pre style="background:#f5f5f5;border-left:4px solid #95a5a6;padding:12px 16px;border-radius:4px;overflow-x:auto;font-family:monospace;font-size:0.88em;color:#2c3e50;white-space:pre-wrap;word-break:break-word">${codeLines.join('\n')}</pre>`);
      i++;
      continue;
    }

    // Table
    if (trimmed.startsWith('|')) {
      closeList();
      const tableRows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        tableRows.push(lines[i]);
        i++;
      }
      const dataRows = tableRows.filter(r => !/^\|[\s\-:|]+\|$/.test(r.trim()));
      if (dataRows.length) {
        const parseCells = row => row.split('|').slice(1, -1).map(c => c.trim());
        const grid = dataRows.map(parseCells);
        let tableHtml = '<table style="border-collapse:collapse;width:100%;margin:12px 0;font-size:0.9em">';
        grid.forEach((cells, ri) => {
          const bg = ri === 0 ? '#dfe6e9' : ri % 2 === 0 ? '#ffffff' : '#f8f9fa';
          const tag = ri === 0 ? 'th' : 'td';
          const fw = ri === 0 ? 'bold' : 'normal';
          tableHtml += `<tr style="background:${bg}">`;
          cells.forEach(cell => {
            tableHtml += `<${tag} style="border:1px solid #cccccc;padding:6px 10px;font-weight:${fw}">${renderInlineHtml(cell)}</${tag}>`;
          });
          tableHtml += '</tr>';
        });
        tableHtml += '</table>';
        htmlParts.push(tableHtml);
      }
      continue;
    }

    // H1
    if (line.startsWith('# ')) {
      closeList();
      htmlParts.push(`<h1 style="font-size:1.4em;margin:16px 0 8px;color:#000">${renderInlineHtml(line.slice(2))}</h1>`);
      i++;
      continue;
    }

    // H2
    if (line.startsWith('## ')) {
      closeList();
      htmlParts.push(`<h2 style="font-size:1.2em;margin:14px 0 6px;color:#1a252f">${renderInlineHtml(line.slice(3))}</h2>`);
      i++;
      continue;
    }

    // H3
    if (line.startsWith('### ')) {
      closeList();
      htmlParts.push(`<h3 style="font-size:1.05em;margin:12px 0 4px;color:#2c3e50">${renderInlineHtml(line.slice(4))}</h3>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (trimmed === '---' || trimmed === '***' || trimmed === '___') {
      closeList();
      htmlParts.push('<hr style="border:none;border-top:1px solid #cccccc;margin:12px 0">');
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      closeList();
      htmlParts.push(`<blockquote style="border-left:3px solid #aaaaaa;margin:8px 0;padding:4px 12px;color:#555;font-style:italic">${renderInlineHtml(line.slice(2))}</blockquote>`);
      i++;
      continue;
    }

    // Bullet list
    if (trimmed.match(/^[-*] /)) {
      if (!inList || listTag !== 'ul') {
        closeList();
        htmlParts.push('<ul style="margin:8px 0;padding-left:24px">');
        inList = true;
        listTag = 'ul';
      }
      htmlParts.push(`<li style="margin:3px 0">${renderInlineHtml(trimmed.slice(2))}</li>`);
      i++;
      continue;
    }

    // Numbered list
    const numMatch = trimmed.match(/^(\d+)\.\s+(.*)/);
    if (numMatch) {
      if (!inList || listTag !== 'ol') {
        closeList();
        htmlParts.push('<ol style="margin:8px 0;padding-left:24px">');
        inList = true;
        listTag = 'ol';
      }
      htmlParts.push(`<li style="margin:3px 0">${renderInlineHtml(numMatch[2])}</li>`);
      i++;
      continue;
    }

    // Empty line
    if (!trimmed) {
      closeList();
      htmlParts.push('<br>');
      i++;
      continue;
    }

    // Normal paragraph
    closeList();
    htmlParts.push(`<p style="margin:6px 0;line-height:1.6">${renderInlineHtml(line)}</p>`);
    i++;
  }

  closeList();
  return htmlParts.join('\n');
}

// ─── HTML REPORT ─────────────────────────────────────────────────────────────

function generateHtml(sessions, reportDate) {
  const dateStr = reportDate.toLocaleDateString('es-AR', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'America/Argentina/Buenos_Aires',
  });

  const totalMin = sessions.reduce((s, r) => s + parseFloat(r.actual_minutes || 0), 0);
  const totalCards = sessions.reduce((s, r) => s + (r.actual_card_count || 0), 0);

  const sessionsHtml = sessions.map((session, idx) => {
    const start = new Date(session.started_at);
    const timeStr = start.toLocaleTimeString('es-AR', {
      hour: '2-digit', minute: '2-digit',
      timeZone: 'America/Argentina/Buenos_Aires',
    });
    const mins = Math.round(parseFloat(session.actual_minutes || 0));
    const cards = session.actual_card_count ?? '?';

    return `
      <div style="margin-bottom:32px">
        <div style="background:#f0f0f0;border-radius:6px;padding:10px 16px;margin-bottom:12px">
          <strong style="font-size:1.05em">Sesión ${idx + 1}</strong>
          <span style="color:#555;margin-left:12px">${timeStr} hs &nbsp;·&nbsp; ${mins} min &nbsp;·&nbsp; ${cards} cartas</span>
        </div>
        <div style="font-size:0.97em;line-height:1.7">
          ${session.analysis ? markdownToHtml(session.analysis) : '<em>Sin análisis</em>'}
        </div>
      </div>
    `;
  }).join('<hr style="border:none;border-top:2px solid #e0e0e0;margin:24px 0">');

  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:700px;margin:0 auto;padding:24px 16px;color:#222;background:#fff">
  <div style="text-align:center;margin-bottom:24px;padding-bottom:16px;border-bottom:2px solid #222">
    <h1 style="margin:0 0 4px;font-size:1.6em;letter-spacing:0.02em">REPORTE DE ESTUDIO</h1>
    <div style="color:#555;font-size:0.95em">${dateStr}</div>
    <div style="margin-top:8px;font-size:0.9em;color:#333">
      ${sessions.length} sesión${sessions.length !== 1 ? 'es' : ''}
      &nbsp;·&nbsp; ${Math.round(totalMin)} min
      &nbsp;·&nbsp; ${totalCards} cartas
    </div>
  </div>

  ${sessionsHtml}

  <div style="margin-top:32px;padding-top:12px;border-top:1px solid #e0e0e0;text-align:center;font-size:0.8em;color:#aaa">
    Discriminador · Reporte automático
  </div>
</body>
</html>`;
}

// ─── EMAIL ───────────────────────────────────────────────────────────────────

async function sendReportEmail(htmlBody, reportDate) {
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  const dateLabel = reportDate.toLocaleDateString('es-AR', {
    day: 'numeric', month: 'long', year: 'numeric',
    timeZone: 'America/Argentina/Buenos_Aires',
  });

  await transport.sendMail({
    from: `"Discriminador" <${process.env.SMTP_USER}>`,
    to: process.env.REPORT_EMAIL_TO,
    subject: `Reporte de Estudio — ${dateLabel}`,
    html: htmlBody,
  });
}

// ─── ENTRY POINT ─────────────────────────────────────────────────────────────

export async function runDailyReport() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  try {
    const sessions = await getYesterdayAnalyses();
    if (!sessions.length) {
      console.log('[daily-report] No hay análisis de sesiones para ayer — sin email.');
      return;
    }
    const html = generateHtml(sessions, yesterday);
    await sendReportEmail(html, yesterday);
    console.log(`[daily-report] Email enviado con ${sessions.length} sesión(es).`);
  } catch (err) {
    console.error('[daily-report] Error al generar o enviar reporte:', err.message);
  }
}
