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
const ORIGIN = process.env.ALLOW_ORIGIN || '*';
const SLOTS  = (process.env.SLOTS || 'slot1,slot2,slot3').split(',').map(s=>s.trim());

fs.mkdirSync('data', { recursive: true });
const log = pino({ level: 'info' });

const app = express();
app.use(cors({ origin: ORIGIN }));
app.use(express.json());

/* ==== DB ==== */
const db = new Database('data/wa.db');
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
CREATE INDEX IF NOT EXISTS idx_ts   ON messages(ts);
CREATE INDEX IF NOT EXISTS idx_slot ON messages(slot);
CREATE INDEX IF NOT EXISTS idx_pair ON messages(slot, from_number, ts DESC);
`);
const insMsg = db.prepare(`
  INSERT INTO messages (slot, jid, from_number, ts, type, text)
  VALUES (@slot, @jid, @from_number, @ts, @type, @text)
`);
const selLastRange = db.prepare(`
  SELECT slot, jid, from_number, ts, type, text
  FROM messages
  WHERE (? IS NULL OR slot = ?) AND ts BETWEEN ? AND ?
  ORDER BY ts DESC LIMIT ?
`);
const selChats = db.prepare(`
  SELECT m.slot,
         m.from_number,
         MAX(m.ts)                             AS last_ts,
         (SELECT text FROM messages x
           WHERE x.slot=m.slot AND x.from_number=m.from_number
           ORDER BY ts DESC LIMIT 1)           AS last_text,
         (SELECT type FROM messages x
           WHERE x.slot=m.slot AND x.from_number=m.from_number
           ORDER BY ts DESC LIMIT 1)           AS last_type
  FROM messages m
  WHERE (?='all' OR m.slot=?)
  GROUP BY m.slot, m.from_number
  ORDER BY last_ts DESC
  LIMIT ?
`);
const selHistoryDesc = db.prepare(`
  SELECT slot, jid, from_number, ts, type, text
  FROM messages
  WHERE slot = ? AND from_number = ?
    AND (? IS NULL OR ts < ?)
  ORDER BY ts DESC
  LIMIT ?
`);

const sessions = {}; // slot -> { sock, qr, status, me }
const toTel = (jid) => (jid||'').replace(/@.*/, '');

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
    '' // vacío si no hay texto legible
  );
}

async function persistMessages(slot, list = []) {
  const rows = [];
  for (const m of list) {
    const remoteJid  = m?.key?.remoteJid;
    const participant = m?.key?.participant; // en grupos
    if (!remoteJid && !participant) continue;

    const tel  = toTel(remoteJid) || toTel(participant);
    const fromMe = !!m?.key?.fromMe;
    const text = extractText(m.message || {});
    const tsMs = Number(m.messageTimestamp || m.timestamp || Math.floor(Date.now()/1000)) * 1000;

    rows.push({
      slot,
      jid: remoteJid || participant,
      from_number: tel,
      ts: tsMs,
      type: fromMe ? 'out' : 'in',
      text
    });
  }
  const tx = db.transaction((items)=>{ for (const r of items) insMsg.run(r); });
  tx(rows);
  if (rows.length) log.info({ slot, saved: rows.length }, 'guardados');
}

async function startSlot(slot) {
  const { state, saveCreds } = await useMultiFileAuthState(`data/auth_${slot}`);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['Mirror Dashboard','Chrome','1.0'],
    emitOwnEvents: true,
    // ⚠️ esto pide el historial inicial (history sync)
    syncFullHistory: true
  });

  sessions[slot] = { sock, qr: null, status: 'starting', me: null };
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, qr, lastDisconnect }) => {
    if (qr) sessions[slot].qr = qr;
    if (connection === 'open') {
      sessions[slot].status = 'connected';
      sessions[slot].qr = null;
      sessions[slot].me = sock.user;
      log.info({ slot }, 'Conectado');
    } else if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      log.warn({ slot, code }, 'Desconectado, reintentando…');
      if (code !== DisconnectReason.loggedOut) startSlot(slot);
      else sessions[slot].status = 'logged_out';
    } else if (connection) {
      sessions[slot].status = connection;
    }
  });

  // 🔹 history sync inicial: Baileys manda “messages.set”
  sock.ev.on('messages.set', async ({ messages, isLatest }) => {
    log.info({ slot, count: messages?.length || 0, isLatest }, 'messages.set');
    if (messages?.length) await persistMessages(slot, messages);
  });

  // 🔹 mensajes nuevos / cambios
  sock.ev.on('messages.upsert', async ({ type, messages }) => {
    log.info({ slot, type, count: messages?.length || 0 }, 'messages.upsert');
    if (messages?.length) await persistMessages(slot, messages);
  });

  // 🔹 utilitario: cargar más historial de un chat bajo demanda
  sock.loadMoreFor = async (remoteJid, cursorId, count = 100) => {
    const cursor = cursorId
      ? { id: cursorId, fromMe: false, remoteJid }
      : undefined;
    const page = await sock.loadMessages(remoteJid, count, cursor);
    await persistMessages(slot, page);
    return page;
  };
}

// levantar sesiones
for (const s of SLOTS) startSlot(s);

/* ==== API ==== */

// QR (PNG)
app.get('/qr/:slot', async (req, res) => {
  const slot = req.params.slot;
  const sess = sessions[slot];
  if (!sess) return res.status(404).json({ error: 'slot no existe' });
  if (!sess.qr) return res.status(204).end();
  const png = await QRCode.toBuffer(sess.qr, { margin: 1, scale: 6 });
  res.setHeader('Content-Type', 'image/png');
  res.send(png);
});

// Estado
app.get('/status', (req, res) => {
  const out = {};
  for (const s of SLOTS) {
    const st = sessions[s] || {};
    out[s] = { status: st.status || 'unknown', me: st.me?.id || null, need_qr: !!st.qr };
  }
  res.json(out);
});

// Últimos (rango)
app.get('/last', (req, res) => {
  const { slot, start, end, limit = 500 } = req.query;
  const from = start ? new Date(start + 'T00:00:00Z').getTime() : 0;
  const to   = end   ? new Date(end   + 'T23:59:59Z').getTime() : Date.now();
  const rows = selLastRange.all(slot || null, slot || null, from, to, Math.min(Number(limit), 2000));
  res.json(rows);
});

// Bandeja (conversaciones)
app.get('/chats', (req, res) => {
  const slot  = (req.query.slot || 'all').toString().toLowerCase();
  const limit = Math.min(Number(req.query.limit || 500), 2000);
  const rows  = selChats.all(slot, slot, limit).map(r => ({
    slot: r.slot,
    from_number: r.from_number,
    last_ts: r.last_ts,
    last_text: r.last_text || '',
    last_type: r.last_type || 'in'
  }));
  res.json(rows);
});

// Historial por conversación (paginado)
app.get('/history', (req, res) => {
  const slot  = (req.query.slot || '').toString().toLowerCase();
  const from  = (req.query.from || '').toString();
  const before = req.query.before ? Number(req.query.before) : null;
  const limit = Math.min(Number(req.query.limit || 200), 500);

  if (!slot || !from) return res.status(400).json({ error: 'slot y from requeridos' });

  const desc = selHistoryDesc.all(slot, from, before, before, limit);
  // devolvemos ascendente para pintar burbujas en orden
  const asc = desc.slice().reverse();
  res.json(asc);
});

// Healthcheck
app.get('/health', (_, res)=>res.json({ ok:true }));

app.listen(PORT, () => log.info(`API espejo en :${PORT}`));
