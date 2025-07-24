require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');
const https = require('https');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

// Create HTTPS agent to bypass self-signed certificate
const agent = new https.Agent({ rejectUnauthorized: false });

// Supabase service client
const supaSrv = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE,
  { auth: { persistSession: false } }
);

const BUCKET = 'accordwise-files';
const toBucketPath = (relPath) => relPath.replace(/^\/+/, '');

async function uploadBuffer(relPath, buffer, mime, upsert = true) {
  const key = relPath.replace(/^\/+/, '');
  return supaSrv.storage.from(BUCKET).upload(key, buffer, { contentType: mime, upsert });
}

async function signedUrl(relPath, expires = 60 * 30) {
  const key = relPath.replace(/^\/+/, '');
  return supaSrv.storage.from(BUCKET).createSignedUrl(key, expires);
}

const ONLYOFFICE_BASE = 'https://24.144.90.236';
const JWT_SECRET = 'xbchclj7arCvsS4vjkYr7TDPsRENyw98'; // Matches local.json secret.inbox/outbox.string

// Store recent callbacks for verification
const recentCallbacks = [];

const app = express();
const PORT = process.env.PORT || 3000;

// CORS setup
app.use(cors({
  origin: [
    'http://accordwise-frontend.z2wjeuucks-xlm41xrvw6dy.p.temp-site.link',
    'http://24.144.90.236:8080',
    'https://*.ngrok.io',
    'https://webhook.site'
  ],
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));

// Log all incoming requests
app.use((req, res, next) => {
  console.log(`📡 Incoming request: ${req.method} ${req.url} at ${new Date().toISOString()}`);
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('Body:', JSON.stringify(req.body, null, 2));
  next();
});

// File copy route
app.post('/copy-template-doc', async (req, res) => {
  const { sourcePath, destinationPath } = req.body;
  try {
    const { data, error: downloadErr } = await supaSrv.storage.from(BUCKET).download(sourcePath);
    if (downloadErr) {
      console.error('❌ Download error:', downloadErr.message);
      return res.status(500).json({ error: downloadErr.message });
    }

    const { error: uploadErr } = await supaSrv.storage.from(BUCKET).upload(destinationPath, data, {
      upsert: true,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    });

    if (uploadErr) {
      console.error('❌ Upload error:', uploadErr.message);
      return res.status(500).json({ error: uploadErr.message });
    }

    res.json({ message: 'File copied successfully', destinationPath });
  } catch (err) {
    console.error('❌ Copy template error:', err.message, err.stack);
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
    if (error) {
      console.error('❌ Supabase upload error:', error.message);
      throw error;
    }
    res.json({ message: 'File uploaded', storagePath: relPath });
  } catch (err) {
    console.error('❌ Upload error:', err.message, err.stack);
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
      console.error('❌ Signed URL error:', error.message);
      return res.status(500).json({ error: error.message });
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({ signedUrl: data.signedUrl, isNew: false });
  } catch (err) {
    console.error('❌ Signed URL error:', err.message, err.stack);
    res.status(500).json({ error: 'Unexpected server error' });
  }
});

// ONLYOFFICE Save Callback Handler
app.post('/onlyoffice-callback', async (req, res) => {
  try {
    const body = req.body;
    console.log('📩 ONLYOFFICE callback received at', new Date().toISOString(), ':', JSON.stringify(body, null, 2));
    console.log('📩 Request headers:', JSON.stringify(req.headers, null, 2));

    recentCallbacks.push({
      timestamp: Date.now(),
      key: body.key,
      status: body.status,
      storagePath: body?.editorConfig?.custom?.storagePath || body?.custom_storagePath
    });
    if (recentCallbacks.length > 10) recentCallbacks.shift();

    if (body.token) {
      try {
        const decoded = jwt.verify(body.token, JWT_SECRET);
        console.log('✅ JWT token verified:', JSON.stringify(decoded, null, 2));
      } catch (err) {
        console.error('❌ JWT verification failed:', err.message, err.stack);
        return res.status(400).json({ error: 'Invalid JWT token' });
      }
    }

    if (!body || !body.status) {
      console.error('❌ Invalid payload: missing status');
      return res.status(400).json({ error: 'Invalid ONLYOFFICE callback payload: missing status' });
    }

    if (body.status === 2) {
      if (!body.url || !body.key) {
        console.error('❌ Invalid payload: missing url or key', { url: body.url, key: body.key });
        return res.status(400).json({ error: 'Invalid ONLYOFFICE callback payload: missing url or key' });
      }

      const storagePath = body?.editorConfig?.custom?.storagePath || body?.custom_storagePath;
      if (!storagePath) {
        console.error('❌ Missing storagePath in callback');
        return res.status(400).json({ error: 'Missing storagePath in callback' });
      }

      console.log('📥 Fetching document from:', body.url);
      try {
        const documentResponse = await fetch(body.url, {
          agent, // Bypass self-signed certificate
          headers: { 'Accept': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
        });
        if (!documentResponse.ok) {
          console.error('❌ Failed to fetch document:', documentResponse.status, documentResponse.statusText);
          return res.status(500).json({ error: `Failed to fetch updated document from ONLYOFFICE: ${documentResponse.statusText}` });
        }

        const buffer = await documentResponse.buffer();
        console.log('📤 Uploading to Supabase at:', storagePath);
        const uploadPath = storagePath.replace(/^accordwise-files\//, '');
        const { error: uploadError } = await uploadBuffer(
          uploadPath,
          buffer,
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          true
        );
        if (uploadError) {
          console.error('❌ Supabase upload error:', uploadError.message);
          return res.status(500).json({ error: `Supabase upload failed: ${uploadError.message}` });
        }

        console.log(`✅ Document saved to Supabase at ${storagePath}`);
        return res.status(200).json({ error: 0 });
      } catch (fetchErr) {
        console.error('❌ Fetch error:', fetchErr.message, fetchErr.stack);
        return res.status(500).json({ error: `Failed to fetch updated document: ${fetchErr.message}` });
      }
    } else if (body.status === 6) {
      console.error('❌ Editor error:', body);
      return res.status(200).json({ error: 0 });
    } else {
      console.log('ℹ️ Unhandled status:', body.status);
      return res.status(200).json({ error: 0 });
    }
  } catch (err) {
    console.error('⚠️ Error in /onlyoffice-callback:', err.message, err.stack);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Check recent callbacks
app.get('/check-callback', async (req, res) => {
  const { key } = req.query;
  if (!key) {
    return res.status(400).json({ error: 'Missing document key' });
  }
  const callback = recentCallbacks.find(cb => cb.key === key && cb.status === 2);
  if (callback) {
    return res.status(200).json({ received: true, storagePath: callback.storagePath, timestamp: callback.timestamp });
  }
  return res.status(200).json({ received: false });
});

// Test ONLYOFFICE callback
app.post('/test-onlyoffice-callback', async (req, res) => {
  try {
    const { bucketPath } = req.body;
    if (!bucketPath) {
      return res.status(400).json({ error: 'Missing bucketPath' });
    }

    const key = bucketPath.replace(/^accordwise-files\//, '');
    const { data, error } = await supaSrv.storage.from(BUCKET).createSignedUrl(key, 1800);
    if (error) {
      console.error('❌ Signed URL error:', error.message);
      return res.status(500).json({ error: `Failed to generate signed URL: ${error.message}` });
    }

    const testPayload = {
      status: 2,
      url: data.signedUrl,
      key: `test_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      editorConfig: {
        custom: {
          storagePath: bucketPath
        }
      }
    };

    console.log('📩 Simulating callback with payload:', JSON.stringify(testPayload, null, 2));

    const documentResponse = await fetch(testPayload.url, {
      agent, // Bypass self-signed certificate
      headers: { 'Accept': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
    });
    if (!documentResponse.ok) {
      console.error('❌ Failed to fetch document:', documentResponse.statusText);
      return res.status(500).json({ error: `Failed to fetch document: ${documentResponse.statusText}` });
    }

    const buffer = await documentResponse.buffer();
    const uploadPath = testPayload.editorConfig.custom.storagePath.replace(/^accordwise-files\//, '');
    const { error: uploadError } = await uploadBuffer(
      uploadPath,
      buffer,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      true
    );
    if (uploadError) {
      console.error('❌ Supabase upload error:', uploadError.message);
      return res.status(500).json({ error: `Supabase upload failed: ${uploadError.message}` });
    }

    console.log(`✅ Test document saved to Supabase at ${testPayload.editorConfig.custom.storagePath}`);
    return res.status(200).json({ error: 0, message: 'Test callback successful' });
  } catch (err) {
    console.error('⚠️ Error in /test-onlyoffice-callback:', err.message, err.stack);
    return res.status(500).json({ error: `Test callback failed: ${err.message}` });
  }
});

// Test ONLYOFFICE connectivity
app.get('/test-onlyoffice', async (req, res) => {
  try {
    console.log(`Testing ONLYOFFICE connectivity to ${ONLYOFFICE_BASE}/web-apps/apps/api/documents/api.js at ${new Date().toISOString()}`);
    const httpResponse = await fetch(`${ONLYOFFICE_BASE}/web-apps/apps/api/documents/api.js`, {
      method: 'HEAD',
      agent, // Bypass self-signed certificate
      timeout: 5000
    });
    if (!httpResponse.ok) {
      console.error('❌ ONLYOFFICE server not reachable:', httpResponse.status, httpResponse.statusText);
      return res.status(500).json({
        error: `ONLYOFFICE server not reachable: HTTP ${httpResponse.status} ${httpResponse.statusText}`,
        status: 'unreachable'
      });
    }
    console.log('✅ ONLYOFFICE server reachable at', ONLYOFFICE_BASE, 'Status:', httpResponse.status);
    return res.status(200).json({
      status: 'reachable',
      details: `HTTP Status ${httpResponse.status}`
    });
  } catch (err) {
    console.error('❌ ONLYOFFICE server test failed:', err.message, err.stack);
    return res.status(500).json({
      error: `Failed to reach ONLYOFFICE server: ${err.message}`,
      status: 'unreachable'
    });
  }
});

// Proxy document fetch to bypass browser certificate issues
app.get('/proxy-document', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url || !url.startsWith('https://24.144.90.236/docs/')) {
      console.error('❌ Invalid proxy URL:', url);
      return res.status(400).json({ error: 'Invalid URL' });
    }
    console.log('📥 Proxy fetching document from:', url);
    const response = await fetch(url, {
      agent, // Bypass self-signed certificate
      headers: { 'Accept': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
    });
    if (!response.ok) {
      console.error('❌ Proxy fetch failed:', response.status, response.statusText);
      return res.status(response.status).json({ error: response.statusText });
    }
    const buffer = await response.buffer();
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.set('Access-Control-Allow-Origin', '*');
    console.log('✅ Proxy fetch successful for:', url);
    res.send(buffer);
  } catch (err) {
    console.error('❌ Proxy fetch error:', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'Backend is healthy' });
});

app.post('/generate-doc-token', async (req, res) => {
  const { bucketPath, config } = req.body;
  if (!bucketPath || !config) return res.status(400).json({ error: 'Missing bucketPath or config' });

  try {
    const key = bucketPath.replace(`${BUCKET}/`, '');
    const { data, error } = await signedUrl(key, 1800);
    if (error && !error.message.includes('Object not found')) {
      console.error('❌ Generate doc token error:', error.message);
      return res.status(500).json({ error: error.message });
    }

    // Use the provided config.document.url (proxied URL) or signed URL
    if (!data?.signedUrl) {
      console.log('ℹ️ No signed URL for bucketPath, using provided config.document.url:', config.document.url);
    } else {
      config.document.url = data.signedUrl;
      console.log('✅ Using signed URL for bucketPath:', config.document.url);
    }
    config.document.key = `${Date.now()}_${Math.random().toString(36).slice(2)}`;

    // Ensure editorConfig exists, provide default callbackUrl
    const editorConfig = config.editorConfig || {};
    editorConfig.callbackUrl = editorConfig.callbackUrl || 'http://accordwise-backend.z2wjeuucks-xlm41xrvw6dy.p.temp-site.link/onlyoffice-callback';

    // Structure payload per OnlyOffice JWT requirements
    const payload = {
      document: {
        fileType: config.document.fileType,
        key: config.document.key,
        title: config.document.title,
        url: config.document.url,
        permissions: config.document.permissions
      },
      documentType: config.documentType,
      editorConfig: {
        callbackUrl: editorConfig.callbackUrl,
        lang: editorConfig.lang,
        mode: editorConfig.mode,
        user: editorConfig.user,
        customization: editorConfig.customization,
        custom: editorConfig.custom
      }
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET || 'your_jwt_secret', {
      expiresIn: '3h',
      header: { alg: 'HS256', typ: 'JWT' }
    });
    console.log('✅ Generated JWT token:', token);
    console.log('JWT payload:', JSON.stringify(payload, null, 2));
    res.json({ token, config: payload });
  } catch (err) {
    console.error('❌ Generate doc token error:', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err.message, err.stack);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => console.log(`✓ Server live: http://localhost:${PORT}`));