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

/* ---------- Config ---------- */
const PORT   = process.env.PORT || 3000;
const ORIGIN = process.env.ALLOW_ORIGIN || '*';
const SLOTS  = (process.env.SLOTS || 'slot1,slot2,slot3').split(',').map(s=>s.trim());

const MAX_PER_CHAT   = Number(process.env.MAX_PER_CHAT   || 1000); // subilo si querés traer más
const PAGE_SIZE      = Number(process.env.PAGE_SIZE      || 80);   // por “scroll”
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 3);    // chats en paralelo

fs.mkdirSync('data', { recursive: true });
const log = pino({ level: process.env.LOG_LEVEL || 'info' });

/* ---------- App ---------- */
const app = express();
app.use(cors({ origin: ORIGIN }));
app.use(express.json());

/* ---------- DB ---------- */
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
CREATE UNIQUE INDEX IF NOT EXISTS uniq_msg ON messages(slot, jid, ts, type, text);
CREATE INDEX  IF NOT EXISTS idx_ts    ON messages(ts);
CREATE INDEX  IF NOT EXISTS idx_slot  ON messages(slot);
CREATE INDEX  IF NOT EXISTS idx_from  ON messages(from_number);
`);
const insMsg = db.prepare(`
  INSERT OR IGNORE INTO messages (slot, jid, from_number, ts, type, text)
  VALUES (@slot, @jid, @from_number, @ts, @type, @text)
`);
const selInbox = db.prepare(`
  SELECT m.*
  FROM messages m
  JOIN (
    SELECT slot, from_number, MAX(ts) AS mts
    FROM messages
    WHERE from_number IS NOT NULL AND from_number <> ''
    GROUP BY slot, from_number
  ) t ON t.slot=m.slot AND t.from_number=m.from_number AND t.mts=m.ts
  ORDER BY m.ts DESC
  LIMIT ?
`);
const selHistory = db.prepare(`
  SELECT slot, jid, from_number, ts, type, text
  FROM messages
  WHERE slot=? AND from_number=? AND (? IS NULL OR ts < ?)
  ORDER BY ts DESC
  LIMIT ?
`);
const selLastRange = db.prepare(`
  SELECT slot, jid, from_number, ts, type, text
  FROM messages
  WHERE (? IS NULL OR slot = ?) AND ts BETWEEN ? AND ?
  ORDER BY ts DESC
  LIMIT ?
`);

/* ---------- Utils ---------- */
const toTel  = jid => (jid||'').replace(/@.*/, '');
const stamp  = m => (m.messageTimestamp || m.timestamp || Math.floor(Date.now()/1000))*1000;
const isEmpty = v => v === null || v === undefined || v === '';

function textFrom(message = {}) {
  return (
    message.conversation ??
    message.extendedTextMessage?.text ??
    message.imageMessage?.caption ??
    message.videoMessage?.caption ??
    message.documentMessage?.caption ??
    message.buttonsResponseMessage?.selectedDisplayText ??
    message.templateButtonReplyMessage?.selectedDisplayText ??
    message.listResponseMessage?.title ??
    (message.contactMessage ? '[contacto]' : null) ??
    (message.locationMessage ? '[ubicación]' : null) ??
    (message.reactionMessage ? `:${message.reactionMessage.text}:` : null) ??
    '[sin texto]'
  );
}

function storeOne(slot, jid, fromMe, msg, tsOverride) {
  const ts = tsOverride ?? stamp(msg);
  const row = {
    slot,
    jid,
    from_number: toTel(jid),
    ts,
    type: fromMe ? 'out' : 'in',
    text: textFrom(msg.message || {})
  };
  insMsg.run(row);
}

/* ---------- Sessions ---------- */
const sessions = {}; // slot -> { sock, store, qr, status, me, backfilled }

/* --- Carga paginada de un chat (como “scroll” hacia arriba) --- */
async function drainChat(slot, sock, jid, max = MAX_PER_CHAT) {
  let fetched = 0;
  let cursor  = null;

  while (fetched < max) {
    let batch = [];
    try {
      // firma común en v6: loadMessages(jid, count, cursor)
      // con cursor.before = { id, fromMe, remoteJid }
      if (typeof sock.loadMessages === 'function') {
        batch = await sock.loadMessages(jid, Math.min(PAGE_SIZE, max - fetched), cursor);
      } else if (typeof sock.fetchMessagesFromWA === 'function') {
        batch = await sock.fetchMessagesFromWA(jid, Math.min(PAGE_SIZE, max - fetched), cursor);
      } else {
        break;
      }
    } catch (e) {
      log.warn({ slot, jid, err: String(e) }, 'drainChat error');
      break;
    }

    if (!batch || batch.length === 0) break;

    // Ordenamos ascendente para construir el cursor
    batch.sort((a,b) => stamp(a) - stamp(b));

    for (const m of batch) {
      const k = m?.key;
      if (!k?.remoteJid) continue;
      storeOne(slot, k.remoteJid, !!k.fromMe, m);
    }

    fetched += batch.length;

    // cursor hacia atrás: primer msg del batch
    const first = batch[0];
    const k = first?.key;
    if (!k?.id) break;
    cursor = { before: { id: k.id, fromMe: !!k.fromMe, remoteJid: jid } };
  }

  return fetched;
}

/* --- Backfill masivo (todas las conversaciones del slot) --- */
async function backfillAll(slot) {
  const sess = sessions[slot];
  if (!sess?.sock || !sess?.store) return;
  if (sess.backfilled) return;

  const { sock, store } = sess;
  const chats = store.chats?.all() || [];
  const jids  = chats
    .map(c => c?.id)
    .filter(j => j && !j.endsWith('@broadcast'));

  log.info({ slot, chats: jids.length }, 'CLONE: backfill start');

  // Pequeño scheduler en paralelo controlado
  let idx = 0, active = 0, total = 0;
  const runNext = () => new Promise(resolve => {
    const step = async () => {
      if (idx >= jids.length) return resolve();
      const jid = jids[idx++]; active++;
      try {
        const n = await drainChat(slot, sock, jid, MAX_PER_CHAT);
        total += n;
        if (n) log.info({ slot, jid, n }, 'CLONE: drained');
      } catch (e) {
        log.warn({ slot, jid, err: String(e) }, 'CLONE: drain error');
      } finally {
        active--; stepOrNext();
      }
    };
    const stepOrNext = () => {
      while (active < MAX_CONCURRENT && idx < jids.length) step();
      if (active === 0 && idx >= jids.length) resolve();
    };
    stepOrNext();
  });

  await runNext();
  sess.backfilled = true;
  log.info({ slot, total }, 'CLONE: backfill done');
}

/* --- Arranque de un slot --- */
async function startSlot(slot) {
  const { state, saveCreds } = await useMultiFileAuthState(`data/auth_${slot}`);
  const { version } = await fetchLatestBaileysVersion();

  const store = makeInMemoryStore({ logger: log });
  store.readFromFile(`data/store_${slot}.json`);
  setInterval(() => { try { store.writeToFile(`data/store_${slot}.json`); } catch {} }, 15000);

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['AutoBoulevard Dashboard','Chrome','1.0'],
    emitOwnEvents: true,
    syncFullHistory: true,   // importante para recibir history sync
    markOnlineOnConnect: false
  });
  store.bind(sock.ev);
  sessions[slot] = { sock, store, qr: null, status: 'starting', me: null, backfilled: false };

  sock.ev.on('creds.update', saveCreds);

  // 1) conexiones
  sock.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
    if (qr) sessions[slot].qr = qr;
    if (connection === 'open') {
      sessions[slot].status = 'connected';
      sessions[slot].qr = null;
      sessions[slot].me = sock.user;
      log.info({ slot }, 'Conectado');

      // 2) backfill masivo (después del history sync)
      // le damos un tiempito a que llegue el historial inicial
      setTimeout(() => backfillAll(slot).catch(() => {}), 4000);
    } else if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      log.warn({ slot, code }, 'Desconectado, reintentando…');
      if (code !== DisconnectReason.loggedOut) startSlot(slot);
      else sessions[slot].status = 'logged_out';
    } else if (connection) {
      sessions[slot].status = connection;
    }
  });

  // 3) history sync inicial (CLAVE)
  sock.ev.on('messaging-history.set', (ev) => {
    // ev: { chats, contacts, messages, isLatest, syncType }
    const arr = ev?.messages || [];
    if (arr.length) {
      for (const m of arr) {
        const k = m?.key; if (!k?.remoteJid) continue;
        storeOne(slot, k.remoteJid, !!k.fromMe, m);
      }
      log.info({ slot, n: arr.length, syncType: ev?.syncType }, 'history.set guardado');
    }
  });

  // 4) mensajes nuevos en vivo
  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const m of (messages || [])) {
      const k = m?.key; if (!k?.remoteJid) continue;
      storeOne(slot, k.remoteJid, !!k.fromMe, m);
    }
  });
}

/* arrancar todos */
for (const s of SLOTS) startSlot(s);

/* ---------- Endpoints ---------- */

// QR
app.get('/qr/:slot', async (req,res) => {
  const { slot } = req.params;
  const sess = sessions[slot];
  if (!sess) return res.status(404).json({ error: 'slot no existe' });
  if (!sess.qr) return res.status(204).end();
  const png = await QRCode.toBuffer(sess.qr, { margin:1, scale:6 });
  res.setHeader('Content-Type','image/png');
  res.send(png);
});

// Estado
app.get('/status', (req,res) => {
  const out = {};
  for (const s of SLOTS) {
    const st = sessions[s] || {};
    out[s] = { status: st.status || 'unknown', me: st.me?.id || null, need_qr: !!st.qr };
  }
  res.json(out);
});

// Bandeja (último por contacto)
app.get('/chats', (req,res) => {
  const limit = Math.min(Number(req.query.limit) || 2000, 5000);
  const rows = selInbox.all(limit).map(r => ({
    slot: r.slot, from_number: r.from_number, jid: r.jid,
    ts: r.ts, lastType: r.type, lastText: r.text
  }));
  res.json(rows);
});

// Historial por contacto (paginable hacia atrás)
app.get('/history', (req,res) => {
  const { slot, from, before, limit = 200 } = req.query;
  if (!slot || !from) return res.status(400).json({ error: 'slot y from requeridos' });
  const rows = selHistory.all(
    String(slot), String(from),
    before ? Number(before) : null,
    before ? Number(before) : null,
    Math.min(Number(limit), 1000)
  );
  rows.sort((a,b)=>a.ts-b.ts);
  res.json(rows);
});

// /last (compat)
app.get('/last', (req,res) => {
  const { slot, start, end, limit = 200 } = req.query;
  const from = start ? new Date(start+'T00:00:00Z').getTime() : 0;
  const to   = end   ? new Date(end  +'T23:59:59Z').getTime() : Date.now();
  res.json(selLastRange.all(slot || null, slot || null, from, to, Math.min(Number(limit), 5000)));
});

// Health
app.get('/health', (_req,res) => res.json({ ok:true }));

app.listen(PORT, () => log.info(`Mirror/CLONE API listening on :${PORT}`));
