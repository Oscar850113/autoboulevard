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

/* ===================== Config ===================== */
const PORT   = process.env.PORT || 3000;
const ORIGIN = process.env.ALLOW_ORIGIN || '*';
const SLOTS  = (process.env.SLOTS || 'slot1,slot2,slot3').split(',').map(s=>s.trim());

fs.mkdirSync('data', { recursive: true });
const log = pino({ level: 'info' });

/* ===================== DB ===================== */
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
CREATE INDEX  IF NOT EXISTS idx_ts              ON messages(ts);
CREATE INDEX  IF NOT EXISTS idx_slot_from_ts    ON messages(slot, from_number, ts);
/* índice único para evitar duplicados por backfill + upsert */
CREATE UNIQUE INDEX IF NOT EXISTS uq_msg ON messages(slot, jid, ts, type, text);

CREATE TABLE IF NOT EXISTS tags(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_number TEXT NOT NULL,
  tag TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);
const insMsg = db.prepare(`
  INSERT OR IGNORE INTO messages (slot, jid, from_number, ts, type, text)
  VALUES (@slot, @jid, @from_number, @ts, @type, @text)
`);
const selLast = db.prepare(`
  SELECT slot, jid, from_number, ts, type, text
  FROM messages
  WHERE (? IS NULL OR slot = ?) AND ts BETWEEN ? AND ?
  ORDER BY ts DESC LIMIT ?
`);
const selThreads = db.prepare(`
  SELECT m1.slot, m1.jid, m1.from_number, m1.ts AS last_ts, m1.type AS last_type, m1.text AS last_text
  FROM messages m1
  JOIN (
    SELECT slot, from_number, MAX(ts) AS max_ts
    FROM messages
    GROUP BY slot, from_number
  ) x ON x.slot = m1.slot AND x.from_number = m1.from_number AND x.max_ts = m1.ts
  ORDER BY last_ts DESC
  LIMIT ?
`);
const selHistoryAsc = db.prepare(`
  SELECT slot, jid, from_number, ts, type, text
  FROM messages
  WHERE slot = ? AND from_number = ? AND (? IS NULL OR ts < ?)
  ORDER BY ts ASC
  LIMIT ?
`);

/* ===================== Helpers ===================== */
const toTel = (jid) => (jid || '').replace(/@.*/, '');
const txtOf = (m) => {
  const msg = m || {};
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
};

/* ===================== Express ===================== */
const app = express();
app.use(cors({
  origin: ORIGIN,
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type']
}));
app.options('*', cors());
app.use(express.json());

/* ===================== WA sessions ===================== */
const sessions = {}; // slot -> { sock, store, qr, status, me, isBackfilled }

async function startSlot(slot) {
  const { state, saveCreds } = await useMultiFileAuthState(`data/auth_${slot}`);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['AutoBoulevard Dashboard', 'Chrome', '1.0'],
    emitOwnEvents: true,
    // intentamos clonar cuanto se pueda
    syncFullHistory: true
  });

  const store = makeInMemoryStore({ logger: log });
  store.bind(sock.ev);

  sessions[slot] = { sock, store, qr: null, status: 'starting', me: null, isBackfilled: false };
  sock.ev.on('creds.update', saveCreds);

  /* conexión */
  sock.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
    if (qr) sessions[slot].qr = qr;

    if (connection === 'open') {
      sessions[slot].status = 'connected';
      sessions[slot].qr = null;
      sessions[slot].me = sock.user;
      log.info({ slot }, 'Conectado');

      // Backfill 1 sola vez al abrir
      if (!sessions[slot].isBackfilled) {
        try {
          await backfillAllChats(slot);
          sessions[slot].isBackfilled = true;
        } catch (e) {
          log.error({ slot, err: String(e) }, 'backfill fallo');
        }
      }
    } else if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      log.warn({ slot, code }, 'Desconectado, reintentando…');
      if (code !== DisconnectReason.loggedOut) {
        setTimeout(()=>startSlot(slot), 1500);
      } else {
        sessions[slot].status = 'logged_out';
      }
    } else if (connection) {
      sessions[slot].status = connection;
    }
  });

  /* historial inicial de WA */
  sock.ev.on('messaging-history.set', ({ messages, isLatest }) => {
    const list = messages || [];
    log.info({ slot, count: list.length, isLatest }, 'history.set');
    for (const m of list) {
      const remoteJid = m?.key?.remoteJid;
      if (!remoteJid) continue;
      const fromMe = !!m?.key?.fromMe;
      const row = {
        slot,
        jid: remoteJid,
        from_number: toTel(remoteJid) || toTel(m?.key?.participant),
        ts: (m.messageTimestamp || m.timestamp || Math.floor(Date.now()/1000)) * 1000,
        type: fromMe ? 'out' : 'in',
        text: txtOf(m.message)
      };
      if (!row.from_number) continue;
      insMsg.run(row);
    }
  });

  /* mensajes en tiempo real */
  sock.ev.on('messages.upsert', ({ messages }) => {
    log.info({ slot, count: messages.length }, 'messages.upsert');
    for (const m of messages) {
      const remoteJid = m?.key?.remoteJid;
      if (!remoteJid) continue;
      const fromMe = !!m?.key?.fromMe;
      const row = {
        slot,
        jid: remoteJid,
        from_number: toTel(remoteJid) || toTel(m?.key?.participant),
        ts: (m.messageTimestamp || m.timestamp || Math.floor(Date.now()/1000)) * 1000,
        type: fromMe ? 'out' : 'in',
        text: txtOf(m.message || {})
      };
      if (!row.from_number) continue;
      insMsg.run(row);
    }
  });

  /* snapshot de store (opcional debug) */
  const storePath = `data/store_${slot}.json`;
  setInterval(() => {
    try {
      const snapshot = { chats: store.chats.all() };
      fs.writeFileSync(storePath, JSON.stringify(snapshot));
    } catch {}
  }, 30000);
}

/* ========= Backfill (clon de chats) ========= */
async function backfillChat(slot, jid, maxBatches = 200, batchSize = 50) {
  const sess = sessions[slot];
  if (!sess) return;
  const sock = sess.sock;
  const load = sock.loadMessages || sock.fetchMessageHistory; // distintas versiones
  if (!load) return;

  let cursor = null;
  for (let i = 0; i < maxBatches; i++) {
    // algunas versiones devuelven array, otras { messages: [...] }
    const page = await load.call(sock, jid, batchSize, cursor);
    const msgs = Array.isArray(page) ? page : (page?.messages || []);
    if (!msgs.length) break;

    for (const m of msgs) {
      const remoteJid = m?.key?.remoteJid;
      if (!remoteJid) continue;
      const fromMe = !!m?.key?.fromMe;
      const row = {
        slot,
        jid: remoteJid,
        from_number: toTel(remoteJid) || toTel(m?.key?.participant),
        ts: (m.messageTimestamp || m.timestamp || Math.floor(Date.now()/1000)) * 1000,
        type: fromMe ? 'out' : 'in',
        text: txtOf(m.message || {})
      };
      if (!row.from_number) continue;
      insMsg.run(row);
    }

    const last = msgs[msgs.length - 1];
    if (!last?.key?.id) break;
    cursor = { id: last.key.id, fromMe: last.key.fromMe, remoteJid: jid };
    if (msgs.length < batchSize) break;
  }
}

async function backfillAllChats(slot) {
  const sess = sessions[slot];
  if (!sess) return;
  const store = sess.store;

  // espera a que lleguen los chats
  for (let i = 0; i < 20 && store.chats.all().length === 0; i++) {
    await new Promise(r => setTimeout(r, 1000));
  }

  const chats = store.chats.all();
  log.info({ slot, count: chats.length }, 'CLONE backfill start');
  for (const c of chats) {
    try {
      await backfillChat(slot, c.id);
    } catch (e) {
      log.warn({ slot, jid: c.id, err: String(e) }, 'backfill chat error');
    }
  }
  log.info({ slot }, 'CLONE backfill done');
}

/* ========= Reset / Logout ========= */
async function resetSlot(slot) {
  const sess = sessions[slot];

  try { await sess?.sock?.logout?.(); } catch (e) { log.warn({ slot, e: String(e) }, 'logout falló'); }
  try { sess?.sock?.end?.(); } catch (_) {}
  try { sess?.sock?.ws?.close?.(); } catch (_) {}
  try { sess?.sock?.ev?.removeAllListeners?.(); } catch (_) {}

  delete sessions[slot];
  try { fs.rmSync(`data/auth_${slot}`, { recursive: true, force: true }); } catch (_) {}

  await startSlot(slot); // reinicia: pedirá QR
}

/* ===== arrancar slots ===== */
for (const s of SLOTS) startSlot(s);

/* ===================== Endpoints ===================== */

/* QR (PNG) */
app.get('/qr/:slot', async (req, res) => {
  const slot = req.params.slot;
  const sess = sessions[slot];
  if (!sess) return res.status(404).json({ error: 'slot no existe' });
  if (!sess.qr) return res.status(204).end();
  const png = await QRCode.toBuffer(sess.qr, { margin: 1, scale: 6 });
  res.setHeader('Content-Type', 'image/png');
  res.send(png);
});

/* estado */
app.get('/status', (req, res) => {
  const out = {};
  for (const s of SLOTS) {
    const st = sessions[s] || {};
    out[s] = { status: st.status || 'unknown', me: st.me?.id || null, need_qr: !!st.qr };
  }
  res.json(out);
});

/* últimos mensajes (KPIs / tabla) */
app.get('/last', (req, res) => {
  const { slot, start, end, limit = 500 } = req.query;
  const from = start ? new Date(start + 'T00:00:00Z').getTime() : 0;
  const to   = end   ? new Date(end   + 'T23:59:59Z').getTime() : Date.now();
  const rows = selLast.all(slot || null, slot || null, from, to, Math.min(Number(limit), 2000));
  res.json(rows);
});

/* lista de hilos (bandeja) */
app.get('/chats', (req, res) => {
  const limit = Math.min(Number(req.query.limit || 1000), 5000);
  const rows = selThreads.all(limit).map(r => ({
    slot: r.slot,
    jid: r.jid,
    from_number: r.from_number,
    ts: r.last_ts,
    lastType: r.last_type,
    lastText: r.last_text
  }));
  res.json(rows);
});

/* historial por contacto (ascendente) */
app.get('/history', (req, res) => {
  const { slot, from, before, limit = 200 } = req.query;
  if (!slot || !from) return res.status(400).json({ error: 'slot y from requeridos' });
  const b = before ? Number(before) : null;
  const rows = selHistoryAsc.all(slot, from, b, b, Math.min(Number(limit), 1000));
  res.json(rows);
});

/* logout (desconexión forzada) */
app.post('/logout/:slot', async (req, res) => {
  const slot = (req.params.slot || '').trim();
  if (!slot || !SLOTS.includes(slot)) {
    return res.status(400).json({ ok:false, error:'invalid_slot' });
  }
  try {
    await resetSlot(slot);
    res.json({ ok:true, slot, restarted:true });
  } catch (err) {
    log.error({ slot, err: String(err) }, 'logout_failed');
    res.status(500).json({ ok:false, error:'logout_failed' });
  }
});

/* tags / health */
app.post('/tag', (req, res) => {
  const { from_number, tag = 'potential' } = req.body || {};
  if (!from_number) return res.status(400).json({ error: 'from_number requerido' });
  db.prepare(`INSERT INTO tags (from_number, tag, created_at) VALUES (?,?,?)`)
    .run(from_number, tag, Date.now());
  res.json({ ok: true });
});

app.get('/health', (_, res)=>res.json({ ok:true }));

app.listen(PORT, () => log.info(`API espejo en :${PORT}`));
