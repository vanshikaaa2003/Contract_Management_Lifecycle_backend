// Updated server.js – Supabase Storage, ONLYOFFICE callback, JWT auth
// ---------------------------------------------------------------
// Prerequisites
// 1.  npm i express cors jsonwebtoken node-fetch@2 @supabase/supabase-js dotenv multer
// 2.  Create a .env file (NOT committed) with:
//     SUPABASE_URL=...                       // from Supabase Settings → API
//     SUPABASE_SERVICE_ROLE=...              // service‑role key (keep secret!)
//     JWT_SECRET=cgXqlssiSUBIw4imAhbQNRBWr41kaivr
// 3.  Create a private bucket in Supabase called `accordwise-files`

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const jwt      = require('jsonwebtoken');
const fetch    = require('node-fetch');
const multer   = require('multer');          // for raw uploads
const { createClient } = require('@supabase/supabase-js');

// ---------------------------------------------------------------------------
// Supabase service‑role client (full read/write, NEVER expose to frontend)
// ---------------------------------------------------------------------------
const supaSrv = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE,
  { auth: { persistSession: false } }
);

// Helpers to keep bucket/key logic in one place
const BUCKET = 'accordwise-files';
const toBucketPath = (relPath) => `${BUCKET}/${relPath.replace(/^\/+/, '')}`;

async function uploadBuffer(relPath, buffer, mime, upsert = true) {
  const key = relPath.replace(/^\/+/, '');
  return supaSrv.storage.from(BUCKET).upload(key, buffer, { contentType: mime, upsert });
}

async function signedUrl(relPath, expires = 60 * 30) {   // default 30 min
  const key = relPath.replace(/^\/+/, '');
  return supaSrv.storage.from(BUCKET).createSignedUrl(key, expires);
}

// ---------------------------------------------------------------------------
// Express setup
// ---------------------------------------------------------------------------
const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ---------------------------------------------------------------------------
// JWT helper
// ---------------------------------------------------------------------------
function verifyToken(req, res, next) {
  const token = (req.headers.authorization || '').split(' ')[1] || req.query.token;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.decoded = decoded;
    return next();
  });
}

// ---------------------------------------------------------------------------
// 1. Raw upload endpoint – replaces local‑disk /upload
// Frontend posts FormData with:  file=<binary>,  path=<org/templates/my.docx>
// ---------------------------------------------------------------------------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } }).single('file');

app.post('/upload', upload, async (req, res) => {
  try {
    const relPath = req.body.path;           // e.g. org123/templates/temp123.docx
    if (!relPath || !req.file) return res.status(400).json({ error: 'Missing file or path' });

    const { error } = await uploadBuffer(relPath, req.file.buffer, req.file.mimetype, true);
    if (error) throw error;

    return res.json({ message: 'File uploaded', storagePath: toBucketPath(relPath) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 2. Signed URL endpoint – frontend fetches before downloading or viewing
// ---------------------------------------------------------------------------
app.get('/signed-url', verifyToken, async (req, res) => {
  const { bucketPath, expires } = req.query;   // bucketPath = accordwise-files/org/...
  if (!bucketPath) return res.status(400).json({ error: 'Missing bucketPath' });
  const key = bucketPath.replace(`${BUCKET}/`, '');
  const { data, error } = await signedUrl(key, Number(expires) || 1800);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ signedUrl: data.signedUrl });
});

// ---------------------------------------------------------------------------
// 3. ONLYOFFICE callback – receives updated file & overwrites in Storage
// ---------------------------------------------------------------------------
app.post('/onlyoffice-callback', express.json({ limit: '50mb' }), async (req, res) => {
  try {
    const { status, url, storagePath } = req.body;
    if (status !== 2) return res.sendStatus(200);  // only save when ready

    const buffer = await fetch(url).then(r => r.buffer());
    const key = storagePath.replace(`${BUCKET}/`, '');

    const { error } = await supaSrv.storage.from(BUCKET).upload(key, buffer, {
      upsert: true,
      contentType: 'application/octet-stream'
    });
    if (error) throw error;
    return res.sendStatus(200);
  } catch (err) {
    console.error('ONLYOFFICE callback error', err);
    return res.status(500).end();
  }
});

// ---------------------------------------------------------------------------
// 4. Demo route to generate a token & give signedUrl to frontend
// ---------------------------------------------------------------------------
app.get('/generate-doc-token', (req, res) => {
  const { bucketPath, userEmail } = req.query;   // minimal example
  if (!bucketPath) return res.status(400).json({ error: 'bucketPath missing' });
  const key = bucketPath.replace(`${BUCKET}/`, '');

  supaSrv.storage.from(BUCKET).createSignedUrl(key, 30 * 60).then(({ data, error }) => {
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
});

// ---------------------------------------------------------------------------
// Catch‑all error middleware
// ---------------------------------------------------------------------------
app.use((err, _req, res, _next) => {
  console.error('Unhandled', err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));

/*
====================================================================
Key Changes vs. original server.js
--------------------------------------------------------------------
1. Added dotenv and @supabase/supabase-js; removed fs/local‑disk writes.
2. /upload now streams file into Supabase Storage (memory upload via multer).
3. /signed-url returns time‑limited link so the frontend & ONLYOFFICE can read private files.
4. /onlyoffice-callback replaces local overwrite with Storage upsert via service‑role.
5. Added helper functions uploadBuffer & signedUrl for DRY code.
6. All file paths in DB/front‑end should now be bucket paths: `accordwise-files/org/...`.  
====================================================================*/
