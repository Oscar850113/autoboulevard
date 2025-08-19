// server.js
import fs from 'fs';
import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import QRCode from 'qrcode';
import pino from 'pino';
import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} from '@whiskeysockets/baileys';

const PORT   = process.env.PORT || 3000;
const ORIGIN = process.env.ALLOW_ORIGIN || '*'; // luego fíjalo a tu dominio
const SLOTS  = (process.env.SLOTS || 'slot1,slot2,slot3').split(',').map(s => s.trim());

fs.mkdirSync('data', { recursive: true });
const log = pino({ level: process.env.LOG_LEVEL || 'info' });

/* ==== Express ==== */
const app = express();
app.use(cors({ origin: ORIGIN }));
app.use(express.json());

/* ==== DB (SQLite) ==== */
const db = new Database('data/wa.db');
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot TEXT NOT NULL,
  jid TEXT NOT NULL,
  from_number TEXT,
  ts INTEGER NOT NULL,
  type TEXT,
  text TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
CREATE INDEX IF NOT EXISTS idx_messages_slot ON messages(slot);
CREATE INDEX IF NOT EXISTS idx_messages_slot_from_ts ON messages(slot, from_number, ts);

CREATE TABLE IF NOT EXISTS tags(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_number TEXT NOT NULL,
  tag TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);
const insMsg = db.prepare(`
  INSERT INTO messages (slot, jid, from_number, ts, type, text)
  VALUES (@slot, @jid, @from_number, @ts, @type, @text)
`);
const selLast = db.prepare(`
  SELECT slot, jid, from_number, ts, type, text
  FROM messages
  WHERE (? IS NULL OR slot = ?)
    AND ts BETWEEN ? AND ?
  ORDER BY ts DESC
  LIMIT ?
`);

/* ==== Helpers ==== */
const sessions = {}; // slot -> { sock, qr, status, me }

const toTel = (jid) => (jid || '').replace(/@.*/, '');

function extractText(message) {
  const msg = message || {};
  return (
    msg.conversation ??
    msg.extendedTextMessage?.text ??
    msg.imageMessage?.caption ??
    msg.videoMessage?.caption ??
    msg.buttonsResponseMessage?.selectedDisplayText ??
    msg.templateButtonReplyMessage?.selectedDisplayText ??
    msg.listResponseMessage?.title ??
    msg.reactionMessage?.text ??
    '[mensaje no soportado]'
  );
}

function saveRowSafe(row) {
  try {
    insMsg.run(row);
  } catch (e) {
    log.warn({ e, row }, '⚠️ No se pudo insertar el mensaje');
  }
}

/* ==== WhatsApp slots ==== */
async function startSlot(slot) {
  const { state, saveCreds } = await useMultiFileAuthState(`data/auth_${slot}`);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['AutoBoulevard Dashboard', 'Chrome', '1.0'],
    emitOwnEvents: true,     // imprescindible para ver nuestros "out"
    syncFullHistory: true    // intenta recibir el lote inicial (si aplica)
  });

  sessions[slot] = { sock, qr: null, status: 'starting', me: null };

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, qr, lastDisconnect }) => {
    if (qr) sessions[slot].qr = qr;

    if (connection === 'open') {
      sessions[slot].status = 'connected';
      sessions[slot].qr = null;
      sessions[slot].me = sock.user;
      log.info({ slot, me: sock.user?.id }, '✅ Conectado');
    } else if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      log.warn({ slot, code }, '❌ Desconectado, reintentando…');
      if (code !== DisconnectReason.loggedOut) startSlot(slot);
      else sessions[slot].status = 'logged_out';
    } else if (connection) {
      sessions[slot].status = connection;
      log.info({ slot, connection }, 'ℹ️ Estado conexión');
    }
  });

  // Mensajes en vivo
  sock.ev.on('messages.upsert', ({ messages }) => {
    if (!messages?.length) return;
    log.info({ slot, count: messages.length }, '📨 upsert');
    for (const m of messages) {
      const remoteJid   = m?.key?.remoteJid;
      const participant = m?.key?.participant; // para grupos
      if (!remoteJid && !participant) continue;

      const tel  = toTel(remoteJid) || toTel(participant);
      if (!tel) continue;

      const fromMe = !!m?.key?.fromMe;
      const row = {
        slot,
        jid: remoteJid || participant,
        from_number: tel,
        ts: (m.messageTimestamp || m.timestamp || Math.floor(Date.now()/1000)) * 1000,
        type: fromMe ? 'out' : 'in',
        text: extractText(m?.message)
      };
      saveRowSafe(row);
    }
  });

  // Lote histórico (al conectar)
  sock.ev.on('messages.set', ({ messages, isLatest }) => {
    if (!messages?.length) return;
    log.info({ slot, count: messages.length, isLatest }, '🗃️ messages.set (historial)');
    for (const m of messages) {
      const remoteJid   = m?.key?.remoteJid;
      const participant = m?.key?.participant;
      if (!remoteJid && !participant) continue;

      const tel  = toTel(remoteJid) || toTel(participant);
      if (!tel) continue;

      const fromMe = !!m?.key?.fromMe;
      const row = {
        slot,
        jid: remoteJid || participant,
        from_number: tel,
        ts: (m.messageTimestamp || m.timestamp || Math.floor(Date.now()/1000)) * 1000,
        type: fromMe ? 'out' : 'in',
        text: extractText(m?.message)
      };
      saveRowSafe(row);
    }
  });
}

// Levanta los slots configurados
for (const s of SLOTS) startSlot(s);

/* ==== Endpoints ==== */

// QR (PNG)
app.get('/qr/:slot', async (req, res) => {
  const slot = req.params.slot;
  const sess = sessions[slot];
  if (!sess)   return res.status(404).json({ error: 'slot no existe' });
  if (!sess.qr) return res.status(204).end(); // sin QR pendiente
  const png = await QRCode.toBuffer(sess.qr, { margin: 1, scale: 6 });
  res.setHeader('Content-Type', 'image/png');
  res.send(png);
});

// Estado de sesiones
app.get('/status', (req, res) => {
  const out = {};
  for (const s of SLOTS) {
    const st = sessions[s] || {};
    out[s] = { status: st.status || 'unknown', me: st.me?.id || null, need_qr: !!st.qr };
  }
  res.json(out);
});

// Últimos mensajes (rango YYYY-MM-DD)
app.get('/last', (req, res) => {
  const { slot, start, end, limit = 200 } = req.query;
  const from = start ? new Date(start + 'T00:00:00Z').getTime() : 0;
  const to   = end   ? new Date(end   + 'T23:59:59Z').getTime() : Date.now();
  const rows = selLast.all(slot || null, slot || null, from, to, Math.min(Number(limit), 1000));
  res.json(rows);
});

// Último mensaje por contacto (para las 3 columnas)
app.get('/threads', (req, res) => {
  const { slot, start, end } = req.query;
  const from = start ? new Date(start + 'T00:00:00Z').getTime() : 0;
  const to   = end   ? new Date(end   + 'T23:59:59Z').getTime() : Date.now();

  // latest per (slot, from_number) en rango
  const stmt = db.prepare(`
    SELECT m.slot, m.jid, m.from_number, m.ts, m.type, m.text
    FROM messages m
    JOIN (
      SELECT slot, from_number, MAX(ts) AS max_ts
      FROM messages
      WHERE ts BETWEEN ? AND ?
      GROUP BY slot, from_number
    ) t
      ON t.slot = m.slot AND t.from_number = m.from_number AND t.max_ts = m.ts
    WHERE (? IS NULL OR m.slot = ?)
    ORDER BY m.slot, m.ts DESC
  `);
  const rows = stmt.all(from, to, slot || null, slot || null);
  res.json(rows);
});

// Stats simples por periodo
app.get('/stats', (req, res) => {
  const { range = 'month', slot = 'all' } = req.query;
  const now = new Date();
  let start;
  if (range === 'week')      start = new Date(now.getTime() - 6 * 864e5);
  else if (range === 'fortnight') start = new Date(now.getTime() - 14 * 864e5);
  else                      start = new Date(now.getTime() - 30 * 864e5);
  start.setHours(0,0,0,0);
  const end = new Date(); end.setHours(23,59,59,999);

  const stmt = db.prepare(`
    SELECT slot, COUNT(*) as messages, COUNT(DISTINCT from_number) as unique_clients
    FROM messages
    WHERE ts BETWEEN ? AND ? AND (?='all' OR slot=?)
    GROUP BY slot
  `);
  const rows = stmt.all(start.getTime(), end.getTime(), slot, slot);

  const totals = rows.reduce((a, r) => ({
    messages: a.messages + r.messages,
    unique_clients: a.unique_clients + r.unique_clients
  }), { messages: 0, unique_clients: 0 });

  res.json({ range, slot, totals, per_slot: rows });
});

// Etiquetar potencial
app.post('/tag', (req, res) => {
  const { from_number, tag = 'potential' } = req.body || {};
  if (!from_number) return res.status(400).json({ error: 'from_number requerido' });
  db.prepare(`INSERT INTO tags (from_number, tag, created_at) VALUES (?,?,?)`)
    .run(from_number, tag, Date.now());
  res.json({ ok: true });
});

// Healthcheck
app.get('/health', (_, res) => res.json({ ok: true }));

// (Opcional) Dummy para probar columnas si /threads diera vacío
app.get('/chats', (_req, res) => {
  res.json([
    { slot: 'slot1', from_number: '59811111111', ts: Date.now(), type: 'in',  text: 'Hola' },
    { slot: 'slot2', from_number: '59822222222', ts: Date.now(), type: 'out', text: '¿Qué tal?' },
    { slot: 'slot3', from_number: '59833333333', ts: Date.now(), type: 'in',  text: 'Consulta' }
  ]);
});

app.listen(PORT, () => log.info(`🚀 API espejo en :${PORT} (CORS origin: ${ORIGIN})`));
