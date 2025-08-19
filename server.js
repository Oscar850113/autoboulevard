import fs from 'fs';
import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import QRCode from 'qrcode';
import pino from 'pino';
import makeDebug from 'debug';
import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  makeInMemoryStore
} from '@whiskeysockets/baileys';

const debug = makeDebug('mirror');

const PORT   = process.env.PORT || 3000;
const ORIGIN = process.env.ALLOW_ORIGIN || '*';
const SLOTS  = (process.env.SLOTS || 'slot1,slot2,slot3').split(',').map(s=>s.trim());

fs.mkdirSync('data', { recursive: true });
const log = pino({ level: 'info' });

const app = express();
app.use(cors({ origin: ORIGIN }));
app.use(express.json());

/* ============ DB ============ */
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
CREATE INDEX IF NOT EXISTS idx_ts ON messages(ts);
CREATE INDEX IF NOT EXISTS idx_slot ON messages(slot);
CREATE INDEX IF NOT EXISTS idx_slot_from ON messages(slot, from_number);

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
  WHERE (? IS NULL OR slot = ?) AND ts BETWEEN ? AND ?
  ORDER BY ts DESC
  LIMIT ?
`);

/* último mensaje por contacto (bandeja) */
const selThreads = db.prepare(`
  SELECT 
    m.slot,
    m.from_number,
    MAX(m.ts) AS ts,
    /* últimos text/type mediante subconsulta */
    (SELECT text FROM messages 
      WHERE slot=m.slot AND from_number=m.from_number 
      ORDER BY ts DESC LIMIT 1) AS text,
    (SELECT type FROM messages 
      WHERE slot=m.slot AND from_number=m.from_number 
      ORDER BY ts DESC LIMIT 1) AS type
  FROM messages m
  WHERE m.from_number IS NOT NULL AND m.from_number <> ''
  GROUP BY m.slot, m.from_number
  ORDER BY ts DESC
  LIMIT @limit
`);

/* historia de un contacto */
const selHistory = db.prepare(`
  SELECT slot, from_number, ts, type, text
  FROM messages
  WHERE slot=@slot AND from_number=@from
    AND (@before IS NULL OR ts < @before)
  ORDER BY ts DESC
  LIMIT @limit
`);

/* ============ WA SESSIONS ============ */
const sessions = {}; // slot -> { sock, qr, status, me, store }

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

function insertMany(slot, arr) {
  const tx = db.transaction(rows => { rows.forEach(r => insMsg.run(r)); });
  tx(arr);
}

async function startSlot(slot) {
  const { state, saveCreds } = await useMultiFileAuthState(`data/auth_${slot}`);
  const { version } = await fetchLatestBaileysVersion();
  const store = makeInMemoryStore({ logger: log });

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['AutoBoulevard Dashboard', 'Chrome', '1.0'],
    emitOwnEvents: true,     // incluir mensajes propios
    syncFullHistory: true,   // sincroniza historial al conectar
    markOnlineOnConnect: false
  });

  store.bind(sock.ev);

  sessions[slot] = { sock, store, qr: null, status: 'starting', me: null };

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

  // set de mensajes inicial (historial)
  sock.ev.on('messages.set', (payload) => {
    const { messages = [], isLatest } = payload || {};
    if (!messages.length) return;
    const rows = [];
    for (const m of messages) {
      const remoteJid = m?.key?.remoteJid;
      if (!remoteJid) continue;
      const fromMe = !!m?.key?.fromMe;
      const participant = m?.key?.participant;
      const tel = toTel(remoteJid) || toTel(participant);
      const msg = m.message || {};
      rows.push({
        slot,
        jid: remoteJid,
        from_number: tel,
        ts: (m.messageTimestamp || m.timestamp || Math.floor(Date.now()/1000))*1000,
        type: fromMe ? 'out' : 'in',
        text: extractText(msg)
      });
    }
    if (rows.length) {
      debug('messages.set', slot, rows.length, 'isLatest:', !!isLatest);
      insertMany(slot, rows);
    }
  });

  // upserts (novedades en tiempo real)
  sock.ev.on('messages.upsert', ({ messages = [] }) => {
    if (!messages.length) return;
    const rows = [];
    for (const m of messages) {
      const remoteJid = m?.key?.remoteJid;
      if (!remoteJid) continue;
      const fromMe = !!m?.key?.fromMe;
      const participant = m?.key?.participant;
      const tel = toTel(remoteJid) || toTel(participant);
      const msg = m.message || {};
      rows.push({
        slot,
        jid: remoteJid,
        from_number: tel,
        ts: (m.messageTimestamp || m.timestamp || Math.floor(Date.now()/1000))*1000,
        type: fromMe ? 'out' : 'in',
        text: extractText(msg)
      });
    }
    if (rows.length) {
      debug('messages.upsert', slot, rows.length);
      insertMany(slot, rows);
    }
  });
}

// arrancar las sesiones configuradas
for (const s of SLOTS) startSlot(s);

/* ============ API ============ */

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

// Estado de sesiones
app.get('/status', (req, res) => {
  const out = {};
  for (const s of SLOTS) {
    const st = sessions[s] || {};
    out[s] = { status: st.status || 'unknown', me: st.me?.id || null, need_qr: !!st.qr };
  }
  res.json(out);
});

// Últimos mensajes (rango)
app.get('/last', (req, res) => {
  const { slot, start, end, limit = 100 } = req.query;
  const from = start ? new Date(start + 'T00:00:00Z').getTime() : 0;
  const to   = end   ? new Date(end   + 'T23:59:59Z').getTime() : Date.now();
  const rows = selLast.all(slot || null, slot || null, from, to, Math.min(Number(limit), 1000));
  res.json(rows);
});

/* BANDEJA: último mensaje por contacto */
app.get('/chats', (req, res) => {
  const limit = Math.min(Number(req.query.limit || 500), 2000);
  const rows = selThreads.all({ limit });
  res.json(rows.map(r => ({
    slot: r.slot,
    from_number: r.from_number,
    ts: r.ts,
    lastText: r.text || '',
    lastType: r.type || 'in'
  })));
});

/* HISTORIA DE UN CONTACTO (paginable) */
app.get('/history', (req, res) => {
  const slot = (req.query.slot || '').toLowerCase();
  const from = req.query.from || '';
  if (!slot || !from) return res.status(400).json({ error: 'slot y from son requeridos' });

  const limit = Math.min(Number(req.query.limit || 200), 2000);
  const before = req.query.before ? Number(req.query.before) : null;

  const rows = selHistory.all({ slot, from, limit, before });
  // devolvemos ascendente para pintar el chat en orden natural
  res.json(rows.slice().reverse());
});

// Stats simples
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
    SELECT slot, COUNT(*) AS messages, COUNT(DISTINCT from_number) AS unique_clients
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

// Etiquetas
app.post('/tag', (req, res) => {
  const { from_number, tag = 'potential' } = req.body || {};
  if (!from_number) return res.status(400).json({ error: 'from_number requerido' });
  db.prepare(`INSERT INTO tags (from_number, tag, created_at) VALUES (?,?,?)`)
    .run(from_number, tag, Date.now());
  res.json({ ok: true });
});

// Health
app.get('/health', (_, res)=>res.json({ ok:true }));

app.listen(PORT, () => log.info(`API espejo en :${PORT}`));
