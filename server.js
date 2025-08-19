// server.js (CommonJS)
const express = require('express');
const cors = require('cors');
const path = require('path');
const fetch = require('node-fetch');

const app = express();

// ===== Config =====
const PORT = process.env.PORT || 3000;
// API de backend real (Railway); puedes sobreescribir por env var
const API_BASE = process.env.API_BASE || 'https://mirror-api-production.up.railway.app';

// CORS (permite front en otro dominio)
app.use(cors());
app.use(express.json());

// ===== Static =====
// Sirve los archivos de /pages (index.html, assets/, script.js, etc.)
const pub = path.join(__dirname, 'pages');
app.use(express.static(pub));

// ===== Proxy endpoints =====
// Estado general
app.get('/status', async (req, res) => {
  try {
    const r = await fetch(`${API_BASE}/status`, { headers: { 'cache-control': 'no-cache' } });
    const json = await r.json();
    res.set('cache-control', 'no-store');
    res.json(json);
  } catch (e) {
    res.status(502).json({ error: 'status proxy failed', details: String(e) });
  }
});

// Últimos mensajes
app.get('/last', async (req, res) => {
  try {
    const qs = new URLSearchParams(req.query).toString();
    const r = await fetch(`${API_BASE}/last?${qs}`, { headers: { 'cache-control': 'no-cache' } });
    res.set('cache-control', 'no-store');
    res.status(r.status);
    res.set('content-type', r.headers.get('content-type') || 'application/json');
    res.send(await r.text());
  } catch (e) {
    res.status(502).json({ error: 'last proxy failed', details: String(e) });
  }
});

// Stats
app.get('/stats', async (req, res) => {
  try {
    const qs = new URLSearchParams(req.query).toString();
    const r = await fetch(`${API_BASE}/stats?${qs}`, { headers: { 'cache-control': 'no-cache' } });
    res.set('cache-control', 'no-store');
    res.status(r.status);
    res.set('content-type', r.headers.get('content-type') || 'application/json');
    res.send(await r.text());
  } catch (e) {
    res.status(502).json({ error: 'stats proxy failed', details: String(e) });
  }
});

// QR (imagen o stream)
app.get('/qr/:slot', async (req, res) => {
  try {
    const r = await fetch(`${API_BASE}/qr/${encodeURIComponent(req.params.slot)}?t=${Date.now()}`, {
      headers: { 'cache-control': 'no-cache' }
    });
    res.status(r.status);
    res.set('cache-control', 'no-store');
    res.set('content-type', r.headers.get('content-type') || 'image/png');
    r.body.pipe(res);
  } catch (e) {
    res.status(502).json({ error: 'qr proxy failed', details: String(e) });
  }
});

// Fallback SPA
app.get('*', (_req, res) => {
  res.sendFile(path.join(pub, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Frontend + proxy on http://localhost:${PORT}`);
  console.log(`Proxy target: ${API_BASE}`);
});
