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


const PORT = process.env.PORT || 3000;
const ORIGIN = process.env.ALLOW_ORIGIN || '*'; // luego lo fijamos a tu Pages
const SLOTS = (process.env.SLOTS || 'slot1,slot2,slot3').split(',').map(s=>s.trim());

fs.mkdirSync('data', { recursive: true });
const log = pino({ level: 'info' });

const app = express();
app.use(cors({ origin: ORIGIN }));
app.use(express.json());

/* ==== DB (SQLite local) ==== */
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
CREATE INDEX IF NOT EXISTS idx_ts ON messages(ts);
CREATE INDEX IF NOT EXISTS idx_slot ON messages(slot);

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
  SELECT slot, from_number, ts, type, text
  FROM messages
  WHERE (? IS NULL OR slot = ?) AND ts BETWEEN ? AND ?
  ORDER BY ts DESC LIMIT ?
`);

const sessions = {}; // slot -> { sock, qr, status, me }
const toTel = (jid) => (jid||'').replace(/@.*/, '');

async function startSlot(slot) {
  const { state, saveCreds } = await useMultiFileAuthState(`data/auth_${slot}`);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['AutoBoulevard Dashboard', 'Chrome', '1.0'],
    syncFullHistory: false
  });

  sessions[slot] = { sock, qr: null, status: 'starting', me: null };
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, qr, lastDisconnect }) => {
    if (qr) sessions[slot].qr = qr;
    if (connection === 'open') {
      sessions[slot].status = 'connected';
      sessions[slot].qr = null;
      sessions[slot].me = sock.user;
      log.info({ slot }, '✅ Conectado');
    } else if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      log.warn({ slot, code }, '⚠️ Desconectado, reintentando…');
      if (code !== DisconnectReason.loggedOut) startSlot(slot);
      else sessions[slot].status = 'logged_out';
    } else if (connection) {
      sessions[slot].status = connection;
    }
  });

  sock.ev.on('messages.upsert', ({ messages }) => {
    console.log(`🟢 ${messages.length} mensaje(s) recibidos para ${slot}`);
    for (const m of messages) {
      const remoteJid = m.key.remoteJid;
      if (!remoteJid || !toTel(remoteJid)) {
        console.warn(`⚠️ remoteJid inválido`, m);
        continue;
      }

      const fromMe = m.key.fromMe;
      const msg = m.message || {};

let text = '';

if (msg.conversation) text = msg.conversation;
else if (msg.extendedTextMessage?.text) text = msg.extendedTextMessage.text;
else if (msg.imageMessage?.caption) text = msg.imageMessage.caption;
else if (msg.videoMessage?.caption) text = msg.videoMessage.caption;
else if (msg.documentMessage?.caption) text = msg.documentMessage.caption;
else if (msg.buttonsResponseMessage?.selectedButtonId) text = msg.buttonsResponseMessage.selectedButtonId;
else if (msg.listResponseMessage?.title) text = msg.listResponseMessage.title;
else if (msg.listResponseMessage?.singleSelectReply?.selectedRowId) text = msg.listResponseMessage.singleSelectReply.selectedRowId;
else if (msg.templateButtonReplyMessage?.selectedId) text = msg.templateButtonReplyMessage.selectedId;
else if (msg.messageContextInfo?.quotedMessage?.conversation) text = msg.messageContextInfo.quotedMessage.conversation;
else if (msg.reactionMessage?.text) text = `Reaccionó: ${msg.reactionMessage.text}`;
else if (msg.audioMessage) text = '[audio]';
else if (msg.stickerMessage) text = '[sticker]';
else if (msg.contactMessage) text = '[contacto]';
else if (msg.locationMessage) text = '[ubicación]';
else if (msg.documentMessage) text = '[documento]';
else text = '[mensaje no soportado]';


      const row = {
        slot,
        jid: remoteJid,
        from_number: toTel(remoteJid),
        ts: (m.messageTimestamp || m.timestamp || Math.floor(Date.now() / 1000)) * 1000,
        type: fromMe ? 'out' : 'in',
        text
      };

      console.log(`💬 Guardando mensaje`, row);
      insMsg.run(row);
    }
  });
}


// arranca las 3 sesiones
for (const s of SLOTS) startSlot(s);

/* ==== Endpoints ==== */

// QR (PNG) para vincular cada slot
app.get('/qr/:slot', async (req, res) => {
  const slot = req.params.slot;
  const sess = sessions[slot];
  if (!sess) return res.status(404).json({ error: 'slot no existe' });
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
  const { slot, start, end, limit = 100 } = req.query;
  const from = start ? new Date(start + 'T00:00:00Z').getTime() : 0;
  const to   = end   ? new Date(end   + 'T23:59:59Z').getTime() : Date.now();
  const rows = selLast.all(slot || null, slot || null, from, to, Math.min(Number(limit), 500));
  res.json(rows);
});

// Stats simples por periodo
app.get('/stats', (req, res) => {
  const { range = 'month', slot = 'all' } = req.query;
  const now = new Date();
  let start;
  if (range === 'week') start = new Date(now.getTime() - 6*864e5);
  else if (range === 'fortnight') start = new Date(now.getTime() - 14*864e5);
  else start = new Date(now.getTime() - 30*864e5);
  start.setHours(0,0,0,0);
  const end = new Date(); end.setHours(23,59,59,999);

  const stmt = db.prepare(`
    SELECT slot, COUNT(*) as messages, COUNT(DISTINCT from_number) as unique_clients
    FROM messages
    WHERE ts BETWEEN ? AND ? AND (?='all' OR slot=?)
    GROUP BY slot
  `);
  const rows = stmt.all(start.getTime(), end.getTime(), slot, slot);

  const totals = rows.reduce((a,r)=>({
    messages: a.messages + r.messages,
    unique_clients: a.unique_clients + r.unique_clients
  }), { messages:0, unique_clients:0 });

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
app.get('/health', (_, res)=>res.json({ ok:true }));

// Dummy chats (para pruebas)
app.get('/chats', (req, res) => {
  res.json([
    {
      name: "Cliente X",
      lastMessage: "Hola",
      timeAgo: "2m",
      slot: "slot1",
      initials: "CX"
    },
    {
      name: "Cliente Y",
      lastMessage: "Consulta",
      timeAgo: "5m",
      slot: "slot2",
      initials: "CY"
    }
  ]);
});

app.listen(PORT, () => log.info(`API espejo en :${PORT}`));
