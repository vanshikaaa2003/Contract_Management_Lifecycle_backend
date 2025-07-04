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
const path     = require('path');                                   /*  A */
const fs       = require('fs');                                     /*  A */
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
// 2.  ONLYOFFICE settings
// ─────────────────────────────────────────────────────────────────────────────
const ONLYOFFICE_BASE = 'https://53a5fb97.docs.onlyoffice.com';

// ─────────────────────────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ========== A. Send CORS header for *every* static download ================
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

// ========== B. STATIC DIR & blank.docx helper =============================
const STATIC_DIR  = path.join(__dirname, '..', 'static');           // backend/static
const BLANK_PATH  = path.join(STATIC_DIR, 'blank.docx');

// individual route (needed by the front‑end upload placeholder)
app.get('/blank.docx', (req, res) => {
  if (!fs.existsSync(BLANK_PATH)) {
    console.error('[blank.docx] file missing at', BLANK_PATH);
    return res.status(404).end('blank.docx not found on server');
  }

  res.type('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  fs.createReadStream(BLANK_PATH)
    .on('error', (err) => {
      console.error('[blank.docx] stream error:', err);
      res.status(500).end();
    })
    .pipe(res);
});


// optional convenience: expose everything inside backend/static at /static/*
app.use(
  '/static',
  express.static(STATIC_DIR, {
    setHeaders: (res) => res.setHeader('Access-Control-Allow-Origin', '*')
  })
);

app.post('/copy-template-doc', async (req, res) => {
  const { sourcePath, destinationPath } = req.body;

  try {
    const { data: fileData, error: downloadErr } = await supaSrv
      .storage
      .from(BUCKET)
      .download(sourcePath);

    if (downloadErr) {
      console.error('Error downloading from storage:', downloadErr);
      return res.status(500).json({ error: downloadErr.message });
    }

    const { error: uploadErr } = await supaSrv
      .storage
      .from(BUCKET)
      .upload(destinationPath, fileData, {
        upsert: true,
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      });

    if (uploadErr) {
      console.error('Error uploading to storage:', uploadErr);
      return res.status(500).json({ error: uploadErr.message });
    }

    res.json({ message: 'File copied successfully', destinationPath });
  } catch (err) {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: err.message });
  }
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
const upload = multer({
  storage: multer.memoryStorage(),
  limits : { fileSize: 50 * 1024 * 1024 }
}).single('file');

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
  if (error) {
    if (error.message.includes('Object not found')) {
      return res.status(200).json({ signedUrl: null, isNew: true });
    }
    return res.status(500).json({ error: error.message });
  }
  res.json({ signedUrl: data.signedUrl, isNew: false });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6.  ONLYOFFICE callback
// ─────────────────────────────────────────────────────────────────────────────
app.post('/onlyoffice-callback', async (req, res) => {
  try {
    console.log('[onlyoffice-callback] Received:', JSON.stringify(req.body, null, 2));
    const { status, url } = req.body;
    if (status !== 2) {
      console.log('[onlyoffice-callback] Ignored, status not 2:', { status });
      return res.sendStatus(200);
    }

    let storagePath = req.body.storagePath;
    if (!storagePath && req.body.editorConfig?.custom?.storagePath) {
      storagePath = req.body.editorConfig.custom.storagePath;
    }
    if (!storagePath) {
      console.error('[onlyoffice-callback] No storagePath provided!');
      return res.status(400).json({ error: 'Missing storagePath' });
    }

    const absoluteUrl = /^https?:\/\//i.test(url)
      ? url
      : ONLYOFFICE_BASE.replace(/\/$/, '') + url;
    console.log('[onlyoffice-callback] Fetching document:', { absoluteUrl, storagePath });

    const response = await fetch(absoluteUrl);
    if (!response.ok) {
      console.error('[onlyoffice-callback] Fetch failed:', { status: response.status, statusText: response.statusText });
      throw new Error(`Failed to fetch document: ${response.statusText}`);
    }
    const buffer = await response.buffer();
    const key = storagePath.replace(`${BUCKET}/`, '');

    console.log('[onlyoffice-callback] Uploading to Supabase:', { key });
    const { error } = await supaSrv.storage.from(BUCKET).upload(key, buffer, {
      upsert: true,
      contentType: 'application/octet-stream'
    });

    if (error) {
      console.error('[onlyoffice-callback] Upload error:', error);
      throw error;
    }

    console.log('[onlyoffice-callback] Document saved successfully:', { storagePath });
    res.sendStatus(200);
  } catch (err) {
    console.error('[onlyoffice-callback] Error:', err);
    res.status(500).json({ error: err.message });
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
      fileType   : 'docx',
      title      : key.split('/').pop(),
      url        : data.signedUrl,
      key        : `${Date.now()}_${Math.random().toString(36).slice(2)}`,
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
