import PDFDocument from 'pdfkit';
import nodemailer from 'nodemailer';
import { dbPool } from '../db/client.js';

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

function generatePDF(sessions, reportDate) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const dateStr = reportDate.toLocaleDateString('es-AR', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      timeZone: 'America/Argentina/Buenos_Aires',
    });

    // Header
    doc.fontSize(20).font('Helvetica-Bold').text('REPORTE DE ESTUDIO', { align: 'center' });
    doc.fontSize(13).font('Helvetica').text(dateStr, { align: 'center' });
    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(1);

    // Summary totals
    const totalMin = sessions.reduce((s, r) => s + (r.actual_minutes || 0), 0);
    const totalCards = sessions.reduce((s, r) => s + (r.actual_card_count || 0), 0);
    doc.fontSize(11).font('Helvetica')
      .text(`Total: ${sessions.length} sesión${sessions.length !== 1 ? 'es' : ''} · ${totalMin} min · ${totalCards} cartas`, { align: 'center' });
    doc.moveDown(1.5);

    // Sessions
    sessions.forEach((session, idx) => {
      const start = new Date(session.started_at);
      const timeStr = start.toLocaleTimeString('es-AR', {
        hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires',
      });

      doc.fontSize(12).font('Helvetica-Bold')
        .text(`SESIÓN ${idx + 1}  —  ${timeStr} hs  |  ${session.actual_minutes ?? '?'} min  |  ${session.actual_card_count ?? '?'} cartas`);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#cccccc').stroke();
      doc.moveDown(0.5);

      doc.fontSize(10).font('Helvetica').fillColor('#222222')
        .text(session.analysis, { lineGap: 3 });
      doc.moveDown(1.5);
    });

    // Page numbers
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.fontSize(9).fillColor('#aaaaaa')
        .text(`Página ${i + 1} de ${range.count}`, 50, doc.page.height - 40, { align: 'center', width: 495 });
    }

    doc.flushPages();
    doc.end();
  });
}

async function sendReportEmail(pdfBuffer, reportDate) {
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const dateLabel = reportDate.toLocaleDateString('es-AR', {
    day: 'numeric', month: 'long', year: 'numeric',
    timeZone: 'America/Argentina/Buenos_Aires',
  });
  const filename = `reporte-estudio-${reportDate.toISOString().slice(0, 10)}.pdf`;

  await transport.sendMail({
    from: `"Discriminador" <${process.env.SMTP_USER}>`,
    to: process.env.REPORT_EMAIL_TO,
    subject: `Reporte de Estudio — ${dateLabel}`,
    text: `Adjunto encontrás el reporte de tus sesiones de estudio del ${dateLabel}.`,
    attachments: [{ filename, content: pdfBuffer, contentType: 'application/pdf' }],
  });
}

export async function runDailyReport() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  try {
    const sessions = await getYesterdayAnalyses();
    if (sessions.length === 0) {
      console.log('[daily-report] No hay análisis de sesiones para ayer — sin email.');
      return;
    }
    const pdf = await generatePDF(sessions, yesterday);
    await sendReportEmail(pdf, yesterday);
    console.log(`[daily-report] Email enviado con ${sessions.length} sesión(es).`);
  } catch (err) {
    console.error('[daily-report] Error al generar o enviar reporte:', err.message);
  }
}
