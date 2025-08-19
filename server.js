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
  DisconnectReason,
  makeInMemoryStore
} from '@whiskeysockets/baileys';

const PORT   = process.env.PORT || 3000;
const ORIGIN = process.env.ALLOW_ORIGIN || '*';
const SLOTS  = (process.env.SLOTS || 'slot1,slot2,slot3').split(',').map(s => s.trim());

fs.mkdirSync('data', { recursive: true });
const log = pino({ level: process.env.LOG_LEVEL || 'info' });

/* ====== APP ====== */
const app = express();
app.use(cors({ origin: ORIGIN }));
app.use(express.json());

/* ====== DB ====== */
const db = new Database('data/wa.db');
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot TEXT NOT NULL,
  jid  TEXT NOT NULL,
  from_number TEXT,
  ts   INTEGER NOT NULL,
  type TEXT,
  text TEXT
);
CREATE INDEX IF NOT EXISTS idx_ts    ON messages(ts);
CREATE INDEX IF NOT EXISTS idx_slot  ON messages(slot);
CREATE INDEX IF NOT EXISTS idx_from  ON messages(from_number);

-- Evitar duplicados “casi idénticos”
CREATE UNIQUE INDEX IF NOT EXISTS uniq_msg
ON messages(slot, jid, ts, type, text);
`);

const insMsg = db.prepare(`
  INSERT OR IGNORE INTO messages (slot, jid, from_number, ts, type, text)
  VALUES (@slot, @jid, @from_number, @ts, @type, @text)
`);

const selLastRange = db.prepare(`
  SELECT slot, jid, from_number, ts, type, text
  FROM messages
  WHERE (? IS NULL OR slot = ?) AND ts BETWEEN ? AND ?
  ORDER BY ts DESC
  LIMIT ?
`);

const selInbox = db.prepare(`
  -- último mensaje por contacto y slot
  SELECT m.*
  FROM messages m
  JOIN (
    SELECT slot, from_number, MAX(ts) AS max_ts
    FROM messages
    WHERE from_number IS NOT NULL AND from_number <> ''
    GROUP BY slot, from_number
  ) t
  ON m.slot = t.slot AND m.from_number = t.from_number AND m.ts = t.max_ts
  ORDER BY m.ts DESC
  LIMIT ?
`);

const selHistory = db.prepare(`
  SELECT slot, jid, from_number, ts, type, text
  FROM messages
  WHERE slot = ? AND from_number = ?
    AND (? IS NULL OR ts < ?)
  ORDER BY ts DESC
  LIMIT ?
`);

/* ====== UTILS ====== */
const toTel = (jid) => (jid || '').replace(/@.*/, '');
const normTs = (m) => (m.messageTimestamp || m.timestamp || Math.floor(Date.now()/1000)) * 1000;
const extractText = (message = {}) =>
  message.conversation ??
  message.extendedTextMessage?.text ??
  message.imageMessage?.caption ??
  message.videoMessage?.caption ??
  message.buttonsResponseMessage?.selectedDisplayText ??
  message.templateButtonReplyMessage?.selectedDisplayText ??
  message.listResponseMessage?.title ??
  message.reactionMessage?.text ??
  '[sin texto]';

/* ====== SESSIONS ====== */
const sessions = {}; // slot -> { sock, store, qr, status, me, backfilled }

/**
 * Guarda 1 mensaje en SQLite (con normalización segura).
 */
function saveRow(slot, jid, fromMe, msgNode, ts) {
  const text = extractText(msgNode) || '';
  const row = {
    slot,
    jid,
    from_number: toTel(jid) || null,
    ts: ts || Date.now(),
    type: fromMe ? 'out' : 'in',
    text
  };
  insMsg.run(row);
}

/**
 * Descarga historial para un jid.
 * Intenta con loadMessages (v6+) y con fetchMessagesFromWA (fallback).
 */
async function pullHistoryForJid(slot, sock, jid, max = 200) {
  let fetched = 0;
  let cursor  = null;

  while (fetched < max) {
    let batch = [];
    try {
      if (typeof sock.loadMessages === 'function') {
        batch = await sock.loadMessages(jid, Math.min(50, max - fetched), cursor);
      } else if (typeof sock.fetchMessagesFromWA === 'function') {
        batch = await sock.fetchMessagesFromWA(jid, Math.min(50, max - fetched), cursor);
      } else {
        break; // no API disponible
      }
    } catch (e) {
      log.warn({ slot, jid, err: String(e) }, 'loadMessages error');
      break;
    }

    if (!batch || batch.length === 0) break;

    // WhatsApp envía DESC a veces; ordenamos ASC para cursor “before”
    batch.sort((a, b) => normTs(a) - normTs(b));

    for (const m of batch) {
      const jidRemote = m?.key?.remoteJid;
      if (!jidRemote) continue;
      const fromMe = !!m?.key?.fromMe;
      const ts = normTs(m);
      const node = m.message || {};
      saveRow(slot, jidRemote, fromMe, node, ts);
    }

    fetched += batch.length;
    // cursor “before” = primer mensaje del lote
    const first = batch[0];
    cursor = { before: first?.key, limit: 50 };
  }

  return fetched;
}

/**
 * Backfill de TODO el slot: itera chats del store y trae historial reciente.
 */
async function backfillSlot(slot) {
  const sess = sessions[slot];
  if (!sess?.sock || !sess?.store) return;
  if (sess.backfilled) return; // correr una sola vez por arranque

  const { sock, store } = sess;

  const chats = store.chats?.all() || [];
  log.info({ slot, chats: chats.length }, 'Backfill: inicio');

  let totalFetched = 0;
  for (const chat of chats) {
    const jid = chat?.id;
    if (!jid || jid.endsWith('@broadcast')) continue;
    try {
      const n = await pullHistoryForJid(slot, sock, jid, 200); // ← podés subir a 500/1000
      totalFetched += n;
      if (n > 0) log.info({ slot, jid, n }, 'Backfill: cargado');
    } catch (e) {
      log.warn({ slot, jid, err: String(e) }, 'Backfill: error jid');
    }
  }

  sess.backfilled = true;
  log.info({ slot, totalFetched }, 'Backfill: fin');
}

/**
 * Arranca un slot (sesión).
 */
async function startSlot(slot) {
  const { state, saveCreds } = await useMultiFileAuthState(`data/auth_${slot}`);
  const { version } = await fetchLatestBaileysVersion();

  const store = makeInMemoryStore({ logger: log });
  store.readFromFile(`data/store_${slot}.json`);
  setInterval(() => {
    try { store.writeToFile(`data/store_${slot}.json`); } catch {}
  }, 10_000);

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['AutoBoulevard Dashboard', 'Chrome', '1.0'],
    emitOwnEvents: true,
    syncFullHistory: true, // importante para chats e historial
    markOnlineOnConnect: false
  });

  store.bind(sock.ev);
  sessions[slot] = { sock, store, qr: null, status: 'starting', me: null, backfilled: false };

  sock.ev.on('creds.update', saveCreds);

  // Conexión / QR
  sock.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
    if (qr) sessions[slot].qr = qr;
    if (connection === 'open') {
      sessions[slot].status = 'connected';
      sessions[slot].qr = null;
      sessions[slot].me = sock.user;
      log.info({ slot }, 'Conectado');
      // en “open” lanzamos el backfill
      backfillSlot(slot).catch(() => {});
    } else if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      log.warn({ slot, code }, 'Desconectado, reintentando…');
      if (code !== DisconnectReason.loggedOut) startSlot(slot);
      else sessions[slot].status = 'logged_out';
    } else if (connection) {
      sessions[slot].status = connection;
    }
  });

  // Mensajes NUEVOS en vivo
  sock.ev.on('messages.upsert', ({ messages }) => {
    log.debug({ slot, count: messages?.length || 0 }, 'messages.upsert');
    for (const m of (messages || [])) {
      const jid = m?.key?.remoteJid;
      if (!jid) continue;
      const fromMe = !!m?.key?.fromMe;
      saveRow(slot, jid, fromMe, m.message || {}, normTs(m));
    }
  });
}

// Inicia todas las sesiones
for (const s of SLOTS) startSlot(s);

/* ====== ENDPOINTS ====== */

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

// Bandeja (último mensaje por contacto, todos los slots)
app.get('/chats', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 1000, 5000);
  const rows = selInbox.all(limit).map(r => ({
    slot: r.slot,
    from_number: r.from_number,
    jid: r.jid,
    ts: r.ts,
    lastType: r.type,
    lastText: r.text
  }));
  res.json(rows);
});

// Historial por contacto
// GET /history?slot=slot1&from=5989...&before=ts&limit=200
app.get('/history', (req, res) => {
  const { slot, from, before, limit = 200 } = req.query;
  if (!slot || !from) return res.status(400).json({ error: 'slot y from requeridos' });

  const rows = selHistory.all(
    String(slot),
    String(from),
    before ? Number(before) : null,
    before ? Number(before) : null,
    Math.min(Number(limit) || 200, 1000)
  );

  // Devolvemos ASC para pintar burbujas
  rows.sort((a, b) => a.ts - b.ts);
  res.json(rows);
});

// /last (sólo por compatibilidad)
app.get('/last', (req, res) => {
  const { slot, start, end, limit = 100 } = req.query;
  const from = start ? new Date(start + 'T00:00:00Z').getTime() : 0;
  const to   = end   ? new Date(end   + 'T23:59:59Z').getTime() : Date.now();
  const rows = selLastRange.all(slot || null, slot || null, from, to, Math.min(Number(limit), 5000));
  res.json(rows);
});

// Health
app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => log.info(`API espejo escuchando en :${PORT}`));
