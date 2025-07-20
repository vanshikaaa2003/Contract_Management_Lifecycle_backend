const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');
const AWS = require('aws-sdk');
const cors = require('cors');
const FormData = require('form-data');

const app = express();
app.use(express.json());
app.use(cors());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION
});

const ONLYOFFICE_JWT_SECRET = 'xbchclj7arCvsS4vjkYr7TDPsRENyw98';

app.post('/generate-doc-token', async (req, res) => {
  const { bucketPath, config } = req.body;
  console.log('📝 Generating JWT token for bucketPath:', bucketPath);

  try {
    const token = jwt.sign(config, ONLYOFFICE_JWT_SECRET, { expiresIn: '24h' });
    console.log('✅ JWT token generated');
    res.json({ token });
  } catch (error) {
    console.error('❌ Error generating JWT token:', error.message, error.stack);
    res.status(500).json({ error: 'Failed to generate token' });
  }
});

app.get('/signed-url', async (req, res) => {
  const { bucketPath } = req.query;
  console.log('📝 Generating signed URL for bucketPath:', bucketPath);

  const params = {
    Bucket: 'accordwise-files',
    Key: bucketPath,
    Expires: 3600
  };

  try {
    const signedUrl = await s3.getSignedUrlPromise('getObject', params);
    console.log('✅ Signed URL generated:', signedUrl);
    res.json({ signedUrl, isNew: false });
  } catch (error) {
    console.error('❌ Error generating signed URL:', error.message, error.stack);
    res.json({ signedUrl: null, isNew: true });
  }
});

app.get('/test-onlyoffice', async (req, res) => {
  console.log('🧪 Testing ONLYOFFICE connectivity');
  try {
    const response = await fetch('https://24.144.90.236/healthcheck', { method: 'GET' });
    if (!response.ok) {
      console.error('❌ ONLYOFFICE healthcheck failed:', response.status, response.statusText);
      return res.status(response.status).json({ status: 'unreachable', error: response.statusText });
    }
    console.log('✅ ONLYOFFICE healthcheck successful');
    res.json({ status: 'reachable', details: `HTTP Status ${response.status}` });
  } catch (error) {
    console.error('❌ ONLYOFFICE connectivity test failed:', error.message, error.stack);
    res.status(500).json({ status: 'unreachable', error: error.message });
  }
});

app.get('/proxy-document', async (req, res) => {
  const { url } = req.query;
  console.log('📥 Proxy fetching document from:', url);

  try {
    const response = await fetch(url, { method: 'GET' });
    if (!response.ok) {
      console.error('❌ Proxy fetch failed:', response.status, response.statusText);
      return res.status(response.status).send(response.statusText);
    }

    const buffer = await response.buffer();
    console.log('✅ Proxy fetch successful for:', url);
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.send(buffer);
  } catch (error) {
    console.error('❌ Proxy fetch error:', error.message, error.stack);
    res.status(500).send(error.message);
  }
});

app.post('/upload', async (req, res) => {
  const { path } = req.body;
  console.log('📤 Uploading file to:', path);

  try {
    const fileContent = req.files.file.data;
    const params = {
      Bucket: 'accordwise-files',
      Key: path,
      Body: fileContent,
      ContentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    };

    await s3.upload(params).promise();
    console.log('✅ File uploaded to:', path);
    res.json({ success: true, path });
  } catch (error) {
    console.error('❌ Upload error:', error.message, error.stack);
    res.status(500).json({ error: 'Upload failed' });
  }
});

app.post('/onlyoffice-callback', async (req, res) => {
  console.log('📩 ONLYOFFICE callback received at', new Date().toISOString(), 'Body:', JSON.stringify(req.body, null, 2));

  try {
    const { status, url, key, editorConfig } = req.body;
    if (status === 2) {
      const storagePath = editorConfig?.custom?.storagePath;
      if (!storagePath) {
        console.error('❌ No storagePath in callback');
        return res.json({ error: 1 });
      }

      console.log('📥 Fetching document from:', url);
      const response = await fetch(url);
      if (!response.ok) {
        console.error('❌ Failed to fetch document:', response.status, response.statusText);
        return res.json({ error: 1 });
      }

      const buffer = await response.buffer();
      const params = {
        Bucket: 'accordwise-files',
        Key: storagePath,
        Body: buffer,
        ContentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      };

      await s3.upload(params).promise();
      console.log('✅ Document saved to Supabase at:', storagePath);
      res.json({ error: 0 });
    } else {
      console.log('ℹ️ Callback status:', status, 'No action required');
      res.json({ error: 0 });
    }
  } catch (error) {
    console.error('❌ Callback error:', error.message, error.stack);
    res.json({ error: 1 });
  }
});

app.listen(3000, () => {
  console.log('🚀 Server running on port 3000');
});