// server.js  —  backend for AccordWise + ONLYOFFICE  ⟨v2025‑07‑02⟩
// -----------------------------------------------------------------------------
//  npm i express cors jsonwebtoken node-fetch@2 @supabase/supabase-js dotenv multer
//  .env  →  SUPABASE_URL=…   SUPABASE_SERVICE_ROLE=…   PORT=3000 (optional)
//
//  Supabase bucket name: accordwise-files
// -----------------------------------------------------------------------------

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const jwt      = require('jsonwebtoken');
const fetch    = require('node-fetch');
const multer   = require('multer');
const { createClient } = require('@supabase/supabase-js');

// ─────────────────────────────────────────────────────────────────────────────
// 1.  Supabase service‑role client (full R/W – keep on the server only)
// ─────────────────────────────────────────────────────────────────────────────
const supaSrv = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE,
  { auth: { persistSession: false } }
);

const BUCKET = 'accordwise-files';
const toBucketPath = (relPath) => `${BUCKET}/${relPath.replace(/^\/+/, '')}`;

async function uploadBuffer(relPath, buffer, mime, upsert = true) {
  const key = relPath.replace(/^\/+/, '');
  return supaSrv.storage.from(BUCKET).upload(key, buffer, { contentType: mime, upsert });
}

async function signedUrl(relPath, expires = 60 * 30) {
  const key = relPath.replace(/^\/+/, '');
  return supaSrv.storage.from(BUCKET).createSignedUrl(key, expires);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2.  ONLYOFFICE settings  (←‑‑‑ UPDATED)
// ─────────────────────────────────────────────────────────────────────────────
const ONLYOFFICE_BASE        = 'https://53a5fb97.docs.onlyoffice.com';


// ─────────────────────────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));


const { Document, Packer } = require('docx');      // ← make sure this import exists

const path = require('path');                  // make sure this is required once

app.get('/blank.docx', async (_req, res) => {
  /**
   * If you prefer *generating* a file each time (no physical file on disk)
   * keep this block ↓.  Otherwise comment it out and see Option‑B below.
   */
  const emptyDoc = new Document();                     // 0‑page document
  const buffer   = await Packer.toBuffer(emptyDoc);

  res
    .setHeader('Access-Control-Allow-Origin', '*')     // CORS ✔
    .type(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    )
    .send(buffer);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3.  JWT‑guard for our own API (unchanged)
// ─────────────────────────────────────────────────────────────────────────────
function verifyToken(req, res, next) {
  const token = (req.headers.authorization || '').split(' ')[1] || req.query.token;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.decoded = decoded;
    next();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 4.  File upload  ➜  Supabase Storage
// ─────────────────────────────────────────────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } }).single('file');

app.post('/upload', upload, async (req, res) => {
  try {
    const relPath = req.body.path;
    if (!relPath || !req.file) return res.status(400).json({ error: 'Missing file or path' });

    const { error } = await uploadBuffer(relPath, req.file.buffer, req.file.mimetype, true);
    if (error) throw error;

    res.json({ message: 'File uploaded', storagePath: toBucketPath(relPath) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5.  Signed URL helper
// ─────────────────────────────────────────────────────────────────────────────
app.get('/signed-url', verifyToken, async (req, res) => {
  const { bucketPath, expires } = req.query;
  if (!bucketPath) return res.status(400).json({ error: 'Missing bucketPath' });
  const key = bucketPath.replace(`${BUCKET}/`, '');
  const { data, error } = await signedUrl(key, Number(expires) || 1800);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ signedUrl: data.signedUrl });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6.  ONLYOFFICE callback  (absolute‑URL fix retained)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/onlyoffice-callback', async (req, res) => {
  try {
    const { status, url, storagePath } = req.body;
    if (status !== 2) return res.sendStatus(200);          // save only on “ReadyForSave”

    const absoluteUrl = /^https?:\/\//i.test(url)
      ? url
      : ONLYOFFICE_BASE.replace(/\/$/, '') + url;          // add host if missing

    const buffer = await fetch(absoluteUrl).then(r => r.buffer());
    const key    = storagePath.replace(`${BUCKET}/`, '');

    const { error } = await supaSrv.storage.from(BUCKET).upload(key, buffer, {
      upsert: true,
      contentType: 'application/octet-stream'
    });
    if (error) throw error;

    res.sendStatus(200);
  } catch (err) {
    console.error('[ONLYOFFICE callback] ', err);
    res.status(500).end();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 7.  Helper route – generate editor config + signed JWT  (for testing)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/generate-doc-token', async (req, res) => {
  const { bucketPath, userEmail } = req.query;
  if (!bucketPath) return res.status(400).json({ error: 'bucketPath missing' });

  const key = bucketPath.replace(`${BUCKET}/`, '');
  const { data, error } = await signedUrl(key, 1800);
  if (error) return res.status(500).json({ error: error.message });

  const config = {
    document: {
      fileType: 'docx',
      title: key.split('/').pop(),
      url: data.signedUrl,
      key: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
      permissions: { edit: false, download: true }
    },
    editorConfig: {
      user: { id: userEmail || 'anon', name: userEmail || 'Viewer' },
      mode: 'view'
    }
  };

  const token = jwt.sign(config, process.env.JWT_SECRET);
  res.json({ token, config });
});

// ─────────────────────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('Unhandled', err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => console.log(`✓ Server ready  →  http://localhost:${PORT}`));
