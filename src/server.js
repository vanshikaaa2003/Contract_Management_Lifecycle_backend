// server.js — backend for AccordWise + ONLYOFFICE — UPDATED for LIVE DEPLOYMENT
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

// Supabase service client
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

const ONLYOFFICE_BASE = 'http://24.144.90.236';
const JWT_SECRET = process.env.JWT_SECRET || '90622eb052254ec9a1592d118d81b6c7'; // Use env variable

const app = express();
const PORT = process.env.PORT || 3000;

// CORS setup for frontend and ONLYOFFICE server
app.use(cors({
  origin: [
    'http://accordwise-frontend.z2wjeuucks-xlm41xrvw6dy.p.temp-site.link',
    'http://24.144.90.236' // Allow ONLYOFFICE server
  ],
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));

// Add CORS headers to all static responses
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

// Static docs directory
const STATIC_DIR = path.join(__dirname, '..', 'static');
const BLANK_PATH = path.join(STATIC_DIR, 'blank.docx');

app.get('/blank.docx', (req, res) => {
  if (!fs.existsSync(BLANK_PATH)) {
    console.error('[blank.docx] Missing at', BLANK_PATH);
    return res.status(404).send('blank.docx not found');
  }
  res.type('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  fs.createReadStream(BLANK_PATH).pipe(res);
});

app.use('/static', express.static(STATIC_DIR, {
  setHeaders: (res) => res.setHeader('Access-Control-Allow-Origin', '*')
}));

// File copy route for initial template creation
app.post('/copy-template-doc', async (req, res) => {
  const { sourcePath, destinationPath } = req.body;
  try {
    const { data, error: downloadErr } = await supaSrv.storage.from(BUCKET).download(sourcePath);
    if (downloadErr) return res.status(500).json({ error: downloadErr.message });

    const { error: uploadErr } = await supaSrv.storage.from(BUCKET).upload(destinationPath, data, {
      upsert: true,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    });

    if (uploadErr) return res.status(500).json({ error: uploadErr.message });

    res.json({ message: 'File copied successfully', destinationPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Token middleware
function verifyToken(req, res, next) {
  const token = (req.headers.authorization || '').split(' ')[1] || req.query.token;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.decoded = decoded;
    next();
  });
}

// Upload to Supabase
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
}).single('file');

app.post('/upload', upload, async (req, res) => {
  try {
    const relPath = req.body.path;
    if (!relPath || !req.file) return res.status(400).json({ error: 'Missing file or path' });
    const { error } = await uploadBuffer(relPath, req.file.buffer, req.file.mimetype, true);
    if (error) throw error;
    res.json({ message: 'File uploaded', storagePath: toBucketPath(relPath) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Signed URL generation
app.get('/signed-url', async (req, res) => {
  try {
    const { bucketPath, expires } = req.query;
    if (!bucketPath) {
      return res.status(400).json({ error: 'Missing bucketPath' });
    }

    const key = bucketPath.replace(/^accordwise-files\//, '');
    const { data, error } = await supaSrv
      .storage
      .from('accordwise-files')
      .createSignedUrl(key, Number(expires) || 1800);

    if (error) {
      if (error.message.includes('Object not found')) {
        return res.status(200).json({ signedUrl: null, isNew: true });
      }
      return res.status(500).json({ error: error.message });
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({ signedUrl: data.signedUrl, isNew: false });
  } catch (err) {
    console.error('Signed URL error:', err);
    res.status(500).json({ error: 'Unexpected server error' });
  }
});

// ONLYOFFICE Save Callback Handler
app.post('/onlyoffice-callback', async (req, res) => {
  try {
    const body = req.body;
    console.log('📩 ONLYOFFICE callback received:', JSON.stringify(body, null, 2));

    // Verify JWT token if present
    if (body.token) {
      try {
        jwt.verify(body.token, JWT_SECRET);
        console.log('✅ JWT token verified');
      } catch (err) {
        console.error('❌ JWT verification failed:', err.message);
        return res.status(400).json({ error: 'Invalid JWT token' });
      }
    }

    // Relax validation for debugging
    if (!body || !body.status) {
      console.error('❌ Invalid payload: missing status');
      return res.status(400).json({ error: 'Invalid ONLYOFFICE callback payload: missing status' });
    }

    // Handle status 2 (document saved) or status 6 (error)
    if (body.status === 2) {
      if (!body.url || !body.key) {
        console.error('❌ Invalid payload: missing url or key');
        return res.status(400).json({ error: 'Invalid ONLYOFFICE callback payload: missing url or key' });
      }

      // Get storagePath from editorConfig.custom.storagePath
      const storagePath = body?.editorConfig?.custom?.storagePath || body?.custom_storagePath;
      if (!storagePath) {
        console.error('❌ Missing storagePath in callback');
        return res.status(400).json({ error: 'Missing storagePath in callback' });
      }

      // Fetch the updated document
      console.log('📥 Fetching document from:', body.url);
      const documentResponse = await fetch(body.url, {
        headers: { 'Accept': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
      });
      if (!documentResponse.ok) {
        console.error('❌ Failed to fetch document:', documentResponse.statusText);
        return res.status(500).json({ error: 'Failed to fetch updated document from ONLYOFFICE' });
      }

      const buffer = await documentResponse.buffer();

      // Upload to Supabase
      console.log('📤 Uploading to Supabase at:', storagePath);
      const { error: uploadError } = await uploadBuffer(
        storagePath.replace(/^accordwise-files\//, ''),
        buffer,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        true
      );
      if (uploadError) {
        console.error('❌ Supabase upload error:', uploadError.message);
        return res.status(500).json({ error: uploadError.message });
      }

      console.log(`✅ Document saved to Supabase at ${storagePath}`);
      return res.status(200).json({ error: 0 });
    } else if (body.status === 6) {
      console.error('❌ Editor error:', body);
      return res.status(200).json({ error: 0 }); // Still return success to avoid retries
    } else {
      console.log('ℹ️ Unhandled status:', body.status);
      return res.status(200).json({ error: 0 });
    }
  } catch (err) {
    console.error('⚠️ Error in /onlyoffice-callback:', err.message, err.stack);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/health', (req, res) => {
  res.status(200).send('Backend is healthy');
});

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

  const token = jwt.sign(config, JWT_SECRET);
  res.json({ token, config });
});

app.use((err, _req, res, _next) => {
  console.error('Unhandled', err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => console.log(`✓ Server live: http://localhost:${PORT}`));