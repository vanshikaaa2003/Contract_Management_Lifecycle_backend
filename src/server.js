const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');
const { PDFDocument, rgb } = require('pdf-lib');
const libre = require('libreoffice-convert');
const multer = require('multer');
const bodyParser = require('body-parser');
const busboy = require('busboy');
const mammoth = require('mammoth'); // Added dependency


const app = express();
const port = 3000;

app.use('/api/convert-docx', express.raw({ type: '*/*', limit: '50mb' }));

app.use(express.json({ limit: '80mb' }));
app.use(cors({ origin: ['http://localhost:8080', 'http://localhost', 'http://192.168.121.37:3000'], methods: ['POST', 'OPTIONS', 'GET'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.static(path.join(__dirname)));

const secret = 'cgXqlssiSUBIw4imAhbQNRBWr41kaivr';

const nodemailer = require('nodemailer');
const Brevo = require('@getbrevo/brevo');
const { Packer, Document, Paragraph, TextRun, HeadingLevel } = require('docx');

const BREVO_API_KEY = '***REMOVED***';

const storage = multer.diskStorage({
    destination: async function (req, file, cb) {
        const fullPath = req.body.path;
        console.log('Destination path from body (multer):', fullPath);
        if (!fullPath) return cb(new Error('Path is required'), null);
        const dir = path.join(__dirname, fullPath.split('/').slice(0, -1).join('/'));
        try { await fs.access(dir); } catch { await fs.mkdir(dir, { recursive: true }); }
        cb(null, __dirname);
    },
    filename: function (req, file, cb) {
        const fullPath = req.body.path;
        console.log('Filename path from body (multer):', fullPath);
        if (!fullPath) return cb(new Error('Path is required'), null);
        cb(null, path.basename(fullPath));
    }
});
const upload = multer({
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024, timeout: 180000 }
}).any();

// Busboy-based upload endpoint
app.post('/upload', (req, res) => {
    const bb = busboy({ headers: req.headers, limits: { fileSize: 50 * 1024 * 1024 } });
    let fileBuffer = Buffer.from([]);
    let fileName, filePath;

    bb.on('file', (name, file, info) => {
        console.log('File received (busboy):', info.filename);
        file.on('data', data => {
            console.log('File chunk received (busboy):', data.length);
            fileBuffer = Buffer.concat([fileBuffer, data]);
        }).on('end', () => {
            fileName = info.filename;
            console.log('File end (busboy), total length:', fileBuffer.length);
        });
    });

    bb.on('field', (name, value) => {
        console.log('Field received (busboy):', name, value);
        if (name === 'path') filePath = value;
    });

    bb.on('finish', async () => {
        console.log('Finish event (busboy), path:', filePath, 'filename:', fileName);
        if (!filePath || !fileBuffer.length) {
            return res.status(400).json({ error: 'No file or path provided' });
        }
        const dir = path.join(__dirname, filePath.split('/').slice(0, -1).join('/'));
        try { await fs.access(dir); } catch { await fs.mkdir(dir, { recursive: true }); }
        const savePath = path.join(__dirname, filePath);
        await fs.writeFile(savePath, fileBuffer);
        console.log('File saved to:', savePath);
        res.status(200).json({ message: 'File uploaded successfully', path: filePath });
    });

    bb.on('error', (err) => {
        console.error('Busboy error:', err.message, err.stack);
        res.status(500).send(`<pre>Error: ${err.message}<br>Stack: ${err.stack}</pre>`);
    });

    req.pipe(bb);
});

// Multer fallback (commented out for now)
// app.post('/upload', upload, async (req, res) => {
//     await new Promise(resolve => setTimeout(resolve, 2000)); // 2-second delay
//     console.log('Received body (multer):', req.body);
//     console.log('Received files (multer):', req.files);
//     if (!req.files || !req.files.length || !req.body.path) {
//         return res.status(400).json({ error: 'No file or path provided' });
//     }
//     console.log('File uploaded to (multer):', req.files[0].path, 'with path:', req.body.path);
//     res.status(200).json({ message: 'File uploaded successfully', path: req.body.path });
// });

// Raw endpoint for testing
app.post('/upload-raw', (req, res) => {
    console.log('Raw body from /upload-raw (length):', req.body.length);
    console.log('Raw body from /upload-raw (string):', req.body.toString('utf8', 0, 100));
    res.status(200).json({ message: 'Raw data received', length: req.body.length });
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('Uncaught error:', { message: err.message, stack: err.stack, body: req.body, headers: req.headers });
    res.status(500).send(`<pre>Uncaught Error: ${err.message}<br>Stack: ${err.stack}</pre>`);
});

// ... (other existing endpoints like /onlyoffice/callback and /downloadfile remain unchanged) ...
app.post('/dispatch-email', async (req, res) => {
    const { to, sender, subject, htmlContent } = req.body;
    const apiInstance = new Brevo.TransactionalEmailsApi();
    apiInstance.setApiKey(Brevo.TransactionalEmailsApiApiKeys.apiKey, BREVO_API_KEY);
    const sendSmtpEmail = { sender, to: [{ email: to }], subject, htmlContent };
    try {
        await apiInstance.sendTransacEmail(sendSmtpEmail);
        res.status(200).json({ message: 'Email sent successfully' });
    } catch (error) {
        console.error('Error sending email:', error);
        res.status(500).json({ error: 'Failed to send email', details: error.message });
    }
});

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: 'accordwise@gmail.com', pass: 'dqcyqdgqfffinsfy' }
});

app.post('/send-email', async (req, res) => {
    const { toEmail, username, password } = req.body;
    if (!toEmail || !username || !password) return res.status(400).send('Missing required fields');
    const mailOptions = {
        from: 'accordwise@gmail.com',
        to: toEmail,
        subject: 'Your Accordwise Admin Credentials',
        text: `Hello,\n\nYour admin account has been created.\nUsername: ${username}\nPassword: ${password}\n\nRegards,\nAccordwise Team`
    };
    try {
        await transporter.sendMail(mailOptions);
        res.status(200).send('Email sent successfully');
    } catch (error) {
        console.error('Error sending email:', error);
        res.status(500).send('Failed to send email: ' + error.message);
    }
});

function verifyToken(req, res, next) {
    let token = req.headers['authorization']?.split(' ')[1];
    if (!token) {
        token = req.query.token;
    }
    if (!token) {
        console.error('No token provided in Authorization header or query');
        return res.status(401).json({ error: 'Unauthorized' });
    }
    jwt.verify(token, secret, (err, decoded) => {
        if (err) {
            console.error('Token verification failed:', err);
            return res.status(403).json({ error: 'Invalid token' });
        }
        req.decoded = decoded;
        next();
    });
}
// New endpoint for sending external review emails
app.post('/send-external-review-email', async (req, res) => {
    const { toEmail, reviewUrl } = req.body;

    if (!toEmail || !reviewUrl) {
        return res.status(400).json({ error: 'Missing required fields: toEmail and reviewUrl are required' });
    }

    const apiInstance = new Brevo.TransactionalEmailsApi();
    apiInstance.setApiKey(Brevo.TransactionalEmailsApiApiKeys.apiKey, BREVO_API_KEY);

    const sender = { name: 'Contract Review Team', email: 'vanshika.aggarwal@bytewisetl.com' };
    const sendSmtpEmail = {
        sender,
        to: [{ email: toEmail, name: 'External Reviewer' }],
        subject: 'Review Contract Document',
        htmlContent: `<p>Please review the document here: <a href="${reviewUrl}">${reviewUrl}</a></p>`,
    };

    try {
        const response = await apiInstance.sendTransacEmail(sendSmtpEmail);
        console.log('External review email sent to:', toEmail, 'Response:', response);
        res.status(200).json({ message: 'External review email sent successfully' });
    } catch (error) {
        console.error('Error sending external review email:', {
            message: error.message,
            status: error.status || 'Unknown',
            response: error.response ? error.response.body : 'No response body',
            stack: error.stack,
        });
        res.status(500).json({ error: 'Failed to send external review email', details: error.message });
    }
});
app.post('/generate-review-token', (req, res) => {
    const { contractData, email } = req.body;
    const baseUrl = 'http://192.168.121.37:3000';
    const jwtSecret = 'cgXqlssiSUBIw4imAhbQNRBWr41kaivr';
    const fileUrl = `${baseUrl}${contractData.storage_path}`;

    const config = {
        document: {
            fileType: 'docx',
            title: `${contractData.title}.docx`,
            url: fileUrl,
            key: `${contractData.cid}_${Date.now()}`,
            permissions: { edit: false, comment: true, download: true }
        },
        documentType: 'word',
        editorConfig: {
            mode: 'view',
            user: { id: email, name: 'External Reviewer' },
            lang: 'en'
        },
        height: '100%',
        width: '100%'
    };

    const token = jwt.sign(config, jwtSecret);
    res.json({ token });
});
app.post('/generate-pdf-token', (req, res) => {
    const { contractData, email } = req.body;
    const baseUrl = 'http://192.168.121.37:3000';
    const jwtSecret = 'cgXqlssiSUBIw4imAhbQNRBWr41kaivr';
    const fileUrl = `${baseUrl}/files${contractData.storage_path}`; // Adjusted to use /files prefix

    const config = {
        document: {
            fileType: 'pdf',
            title: `${contractData.title}.pdf`,
            url: fileUrl,
            key: `${contractData.cid}_${Date.now()}`,
            permissions: { edit: true, download: true }
        },
        documentType: 'pdf',
        editorConfig: {
            mode: 'edit',
            user: { id: email, name: email },
            lang: 'en'
        },
        height: '100%',
        width: '100%'
    };

    const token = jwt.sign(config, jwtSecret);
    res.json({ token });
});
app.get('/generate-token', (req, res) => {
    const fileKey = req.query.key || '266cfc46251a13c7a33e_' + Date.now();
    const payload = {
        "document": {
            "fileType": "docx",
            "key": fileKey,
            "title": "Test Document.docx",
            "url": "http://192.168.121.37:3000/test.docx"
        },
        "editorConfig": {
            "callbackUrl": "http://192.168.121.37:3000/save-template",
            "lang": "en",
            "mode": "edit",
            "user": {
                "id": "user1",
                "name": "Test User"
            }
        }
    };
    const token = jwt.sign(payload, secret, { expiresIn: '1h' });
    console.log('Generated token for key:', fileKey);
    res.json({ token });
});

app.get('/test.docx', verifyToken, (req, res) => {
    const filePath = path.join(__dirname, 'test.docx');
    console.log('Serving test.docx from:', filePath);
    res.sendFile(filePath, (err) => {
        if (err) {
            console.error('Error sending file:', err);
            res.status(500).send('File not found');
        } else {
            console.log('File served: test.docx');
        }
    });
});

app.get('/:orgcode/templates/:filename', verifyToken, (req, res) => {
    const orgcode = req.params.orgcode;
    const fileName = req.params.filename;
    const filePath = path.join(__dirname, orgcode, 'templates', fileName);
    console.log('Request received for:', { url: req.url, orgcode, fileName });
    console.log('Serving file from:', filePath);
    fs.access(filePath, fs.constants.F_OK)
        .then(() => {
            res.sendFile(filePath, (err) => {
                if (err) {
                    console.error('Error sending file:', err);
                    res.status(500).send('File not found');
                } else {
                    console.log('File served:', fileName, 'for orgcode:', orgcode);
                }
            });
        })
        .catch(err => {
            console.error('File does not exist at:', filePath, 'Error:', err);
            res.status(404).send('File not found on server');
        });
});

// New endpoint to serve contract files
app.get('/:orgcode/contracts/:username/:filename', verifyToken, (req, res) => {
    const orgcode = req.params.orgcode;
    const username = req.params.username;
    const fileName = req.params.filename;
    const filePath = path.join(__dirname, orgcode, 'contracts', username, fileName);
    console.log('Request received for:', { url: req.url, orgcode, username, fileName });
    console.log('Serving file from:', filePath);
    fs.access(filePath, fs.constants.F_OK)
        .then(() => {
            res.sendFile(filePath, (err) => {
                if (err) {
                    console.error('Error sending file:', err);
                    res.status(500).send('File not found');
                } else {
                    console.log('File served:', fileName, 'for orgcode:', orgcode, 'username:', username);
                }
            });
        })
        .catch(err => {
            console.error('File does not exist at:', filePath, 'Error:', err);
            res.status(404).send('File not found on server');
        });
});

app.post('/save-file', verifyToken, async (req, res) => {
    console.log('Received OnlyOffice save-file callback:', req.body);
    res.status(200).json({ error: 0 });
});

// Existing endpoint for saving templates (unchanged)
app.post('/save-template', async (req, res) => {
    console.log('Received ONLYOFFICE save-template callback:', req.body);
    console.log('Query parameters received:', req.query);

    const body = req.body;
    if (!body.status || !body.url || !req.query.tableName || !req.query.templateId || !req.query.templateName || !req.query.version || !req.query.orgcode) {
        console.error('Missing required fields in save-template request');
        return res.status(400).json({ error: 1, message: 'Missing required fields' });
    }

    if (body.status === 2) {
        const downloadUrl = body.url;
        const key = body.key;
        const tableName = req.query.tableName;
        const templateId = req.query.templateId;
        const templateName = decodeURIComponent(req.query.templateName);
        const version = req.query.version;
        const orgcode = req.query.orgcode;

        console.log('Processing save with:', { orgcode, tableName, templateId, templateName, version, downloadUrl });

        try {
            const response = await fetch(downloadUrl);
            if (!response.ok) throw new Error(`Failed to fetch document from ${downloadUrl}: ${response.statusText}`);
            const buffer = await response.buffer();

            const folderPath = path.join(__dirname, orgcode, 'templates');
            console.log('Resolved folder path:', folderPath);
            console.log('Creating folder at:', folderPath);
            await fs.mkdir(folderPath, { recursive: true });

            const fileName = `${templateId}_${templateName}_${version}.docx`;
            const filePath = path.join(folderPath, fileName);
            console.log('Resolved file path:', filePath);
            console.log('Saving file to:', filePath);
            await fs.writeFile(filePath, buffer);
            console.log(`Template saved successfully to: ${filePath}`);

            const storagePath = `/${orgcode}/templates/${fileName}`;
            console.log('Returning storagePath to client:', storagePath);

            res.status(200).json({ error: 0, storagePath: storagePath });
        } catch (error) {
            console.error('Error saving template:', error);
            res.status(500).json({ error: 1, message: error.message });
        }
    } else {
        console.log(`Received status ${body.status}, no action required`);
        res.status(200).json({ error: 0 });
    }
});

// New endpoint for saving contracts
app.post('/save-contract', async (req, res) => {
    console.log('Received ONLYOFFICE save-contract callback:', req.body);
    console.log('Query parameters received:', req.query);

    const body = req.body;
    if (!body.status || !body.url || !req.query.tableName || !req.query.contractId || !req.query.contractTitle || !req.query.orgcode || !req.query.username) {
        console.error('Missing required fields in save-contract request');
        return res.status(400).json({ error: 1, message: 'Missing required fields' });
    }

    if (body.status === 2) { // Status 2 means the document is ready to be saved
        const downloadUrl = body.url;
        const key = body.key;
        const tableName = req.query.tableName;
        const contractId = req.query.contractId; // cid
        const contractTitle = decodeURIComponent(req.query.contractTitle);
        const orgcode = req.query.orgcode;
        const username = req.query.username;

        console.log('Processing contract save with:', { orgcode, username, tableName, contractId, contractTitle, downloadUrl });

        try {
            const response = await fetch(downloadUrl);
            if (!response.ok) throw new Error(`Failed to fetch document from ${downloadUrl}: ${response.statusText}`);
            const buffer = await response.buffer();

            const folderPath = path.join(__dirname, orgcode, 'contracts', username);
            console.log('Resolved folder path:', folderPath);
            console.log('Creating folder at:', folderPath);
            await fs.mkdir(folderPath, { recursive: true });

            const fileName = `${contractId}_${contractTitle}.docx`;
            const filePath = path.join(folderPath, fileName);
            console.log('Resolved file path:', filePath);
            console.log('Saving contract to:', filePath);
            await fs.writeFile(filePath, buffer);
            console.log(`Contract saved successfully to: ${filePath}`);

            const storagePath = `/${orgcode}/contracts/${username}/${fileName}`;
            console.log('Returning storagePath to client:', storagePath);

            res.status(200).json({ error: 0, storagePath: storagePath });
        } catch (error) {
            console.error('Error saving contract:', error);
            res.status(500).json({ error: 1, message: error.message });
        }
    } else {
        console.log(`Received status ${body.status}, no action required`);
        res.status(200).json({ error: 0 });
    }
});
app.post('/save-signed-contract', async (req, res) => {
    console.log('Received save-signed-contract callback:', {
        body: req.body,
        query: req.query
    });

    const body = req.body;
    const { tableName, contractId, contractTitle, orgcode, username } = req.query;

    // Validate required fields
    const missingFields = [];
    if (!body.status) missingFields.push('status');
    if (!body.url && body.status === 2) missingFields.push('url'); // Only require url for status 2
    if (!tableName) missingFields.push('tableName');
    if (!contractId) missingFields.push('contractId');

    // Log optional fields
    if (!contractTitle) console.warn('Optional: contractTitle missing');
    if (!orgcode) console.warn('Optional: orgcode missing');
    if (!username) console.warn('Optional: username missing');

    if (missingFields.length > 0) {
        console.error('Missing required fields:', missingFields);
        return res.status(400).json({ error: 1, message: `Missing required fields: ${missingFields.join(', ')}` });
    }

    if (body.status === 2) {
        const downloadUrl = body.url;
        const key = body.key || 'unknown_key';
        const decodedTitle = contractTitle ? decodeURIComponent(contractTitle) : 'Signed_Contract';
        const safeOrgcode = orgcode || 'default_org';
        const safeUsername = username || 'default_user';

        console.log('Processing signed contract save:', {
            tableName,
            contractId,
            decodedTitle,
            safeOrgcode,
            safeUsername,
            downloadUrl
        });

        try {
            // Download document
            const response = await fetch(downloadUrl);
            if (!response.ok) {
                console.error('Fetch error:', response.statusText);
                throw new Error(`Failed to fetch document: ${response.statusText}`);
            }
            const buffer = await response.buffer();

            // Save file
            const folderPath = path.join(__dirname, safeOrgcode, 'contracts', safeUsername);
            console.log('Creating folder:', folderPath);
            await fs.mkdir(folderPath, { recursive: true });

            const fileName = `${contractId}_${decodedTitle.replace(/[^a-zA-Z0-9]/g, '_')}.docx`;
            const filePath = path.join(folderPath, fileName);
            console.log('Saving to:', filePath);
            await fs.writeFile(filePath, buffer);
            console.log('File saved');

            const storagePath = `/${safeOrgcode}/contracts/${safeUsername}/${fileName}`;
            console.log('Storage path:', storagePath);

            // Update Supabase
            const { error } = await supabase
                .from(tableName)
                .update({
                    storage_path: storagePath,
                    updatedon: new Date().toISOString()
                })
                .eq('cid', contractId);
            if (error) {
                console.error('Supabase error:', error);
                throw new Error(`Supabase update failed: ${error.message}`);
            }

            console.log('Save complete');
            res.status(200).json({ error: 0, storagePath });
        } catch (error) {
            console.error('Save-signed-contract error:', error);
            res.status(500).json({ error: 1, message: error.message });
        }
    } else {
        console.log(`Status ${body.status}, no action required`);
        res.status(200).json({ error: 0 });
    }
});
app.post('/sync-draft', verifyToken, async (req, res) => {
    console.log('Received ONLYOFFICE sync-draft callback:', JSON.stringify(req.body, null, 2));
    console.log('Query parameters:', req.query);

    const { tableName, contractId, contractTitle, orgcode, username } = req.query;
    const body = req.body;

    if (!tableName || !contractId || !contractTitle || !orgcode || !username) {
        console.error('Missing required query parameters');
        return res.status(400).json({ error: 1, message: 'Missing required fields' });
    }

    const storagePath = path.join(__dirname, orgcode, 'contracts', username, `${contractId}_${decodeURIComponent(contractTitle)}.docx`);
    console.log('Target storage path:', storagePath);

    await fs.mkdir(path.dirname(storagePath), { recursive: true });

    switch (body.status) {
        case 1: // Document opened
            console.log('Document opened by user');
            res.json({ error: 0 });
            break;
        case 2: // Document changed
            console.log('Document changed, fetching from:', body.url);
            try {
                const response = await fetch(body.url);
                if (!response.ok) throw new Error(`Fetch failed: ${response.statusText}`);
                const buffer = await response.buffer();
                await fs.writeFile(storagePath, buffer);
                console.log('File updated at:', storagePath);

                // Update database
                const supabaseClient = require('@supabase/supabase-js').createClient(
                    '***REMOVED***',
                    '***REMOVED***'
                );
                const { error: dbError } = await supabaseClient
                    .from(tableName)
                    .update({ updatedon: new Date().toISOString() })
                    .eq('cid', contractId);
                if (dbError) console.error('Database update failed:', dbError);

                res.json({ error: 0 });
            } catch (err) {
                console.error('Error saving changes:', err);
                res.status(500).json({ error: 1, message: err.message });
            }
            break;
        case 6: // Forcesave
            console.log('Forcesave requested, fetching from:', body.url);
            try {
                const response = await fetch(body.url);
                if (!response.ok) throw new Error(`Fetch failed: ${response.statusText}`);
                const buffer = await response.buffer();
                await fs.writeFile(storagePath, buffer);
                console.log('Forcesave completed at:', storagePath);
                res.json({ error: 0 });
            } catch (err) {
                console.error('Error during forcesave:', err);
                res.status(500).json({ error: 1, message: err.message });
            }
            break;
        default:
            console.log(`Unhandled status: ${body.status}`);
            res.json({ error: 0 });
    }
});
app.get('/files/*', async (req, res) => {
    try {
        const filePath = path.join(__dirname, req.path.replace('/files', ''));
        await fs.access(filePath);
        res.sendFile(filePath);
    } catch (err) {
        res.status(404).json({ error: 'File not found', details: err.message });
    }
});
app.post('/convert-to-pdf', async (req, res) => {
    try {
      const { docxPath } = req.body;
      if (!docxPath) {
        return res.status(400).json({ error: 'Missing docxPath', details: 'docxPath is required in request body' });
      }
  
      const normalizedDocxPath = docxPath.replace(/^\/|^\\/, '').replace(/\//g, path.sep);
      const fullDocxPath = path.join(__dirname, normalizedDocxPath);
      const pdfPath = fullDocxPath.replace(/\.docx$/, '.pdf');
      console.log(`Attempting to read .docx file: ${fullDocxPath}`);
  
      try {
        await fs.access(fullDocxPath);
      } catch (err) {
        console.error(`File not found: ${fullDocxPath}`);
        return res.status(404).json({ error: 'File not found', details: `No file at ${fullDocxPath}` });
      }
  
      const docxBuf = await fs.readFile(fullDocxPath);
      console.log(`Read .docx file: ${fullDocxPath}`);
  
      libre.convert(docxBuf, '.pdf', undefined, async (err, pdfBuf) => {
        if (err) {
          console.error(`Conversion error: ${err.message}`);
          return res.status(500).json({ error: 'Failed to convert to PDF', details: err.message });
        }
  
        try {
          await fs.writeFile(pdfPath, pdfBuf);
          console.log(`Wrote .pdf file: ${pdfPath}`);
          res.json({ pdfPath: docxPath.replace(/\.docx$/, '.pdf') });
        } catch (writeErr) {
          console.error(`Write error: ${writeErr.message}`);
          res.status(500).json({ error: 'Failed to save PDF', details: writeErr.message });
        }
      });
    } catch (err) {
      console.error(`Server error: ${err.message}`);
      res.status(500).json({ error: 'Server error', details: err.message });
    }
  });

  app.post('/annotate-pdf', async (req, res) => {
    try {
        const { pdfPath, annotations } = req.body;
        if (!pdfPath || !annotations || !annotations.objects) {
            return res.status(400).json({ error: 'Missing parameters', details: 'pdfPath and annotations.objects are required' });
        }

        const normalizedPdfPath = pdfPath.replace(/^\/|^\\/, '').replace(/\//g, path.sep);
        const fullPdfPath = path.join(__dirname, normalizedPdfPath);
        console.log(`Annotating PDF at: ${fullPdfPath}`);

        // Load existing PDF
        const pdfBytes = await fs.readFile(fullPdfPath);
        const pdfDoc = await PDFDocument.load(pdfBytes);
        const page = pdfDoc.getPage(0); // First page
        const pageHeight = page.getHeight();

        // Add annotations
        annotations.objects.forEach(obj => {
            if (obj.name === 'signature') {
                // Draw rectangle for signature
                page.drawRectangle({
                    x: obj.left,
                    y: pageHeight - obj.top - obj.height, // Flip Y-axis
                    width: obj.width,
                    height: obj.height,
                    borderColor: rgb(0, 0, 0), // Black border
                    borderWidth: obj.strokeWidth || 2
                });

                // Add email text on top of the rectangle
                const email = obj.email || (obj.metadata && obj.metadata.email) || 'Unknown';
                page.drawText(email, {
                    x: obj.left + (obj.width / 2), // Center horizontally
                    y: pageHeight - obj.top + 5, // Position just above the rectangle
                    size: 10,
                    color: rgb(0, 0, 0), // Black text
                    maxWidth: obj.width - 10 // Ensure text fits within the rectangle's width
                });
            } else if (obj.name === 'text') {
                page.drawText(obj.text, {
                    x: obj.left,
                    y: pageHeight - obj.top - obj.fontSize,
                    size: obj.fontSize,
                    color: rgb(0, 0, 0)
                });
            }
        });

        // Save updated PDF
        const updatedPdfBytes = await pdfDoc.save();
        await fs.writeFile(fullPdfPath, updatedPdfBytes);
        console.log(`Saved annotated PDF at: ${fullPdfPath}`);

        res.json({ updatedPdfPath: pdfPath });
    } catch (err) {
        console.error(`Annotation error: ${err.message}`, err.stack);
        res.status(500).json({ error: 'Failed to annotate PDF', details: err.message });
    }
});

app.post('/downloadfile/:fileKey', (req, res) => {
    const fileKey = req.params.fileKey;
    const filePath = `/path/to/storage/${fileKey}.pdf`; // Adjust based on your storage
    res.download(filePath, (err) => {
        if (err) {
            console.error('Download error:', err);
            res.status(403).send('Forbidden or file not found');
        }
    });
});
// New endpoint to convert .docx to text
app.post('/api/convert-docx', async (req, res) => {
    try {
        console.log('Received /api/convert-docx request, body length:', req.body?.length);
        const buffer = req.body; // req.body is a Buffer
        if (!buffer || buffer.length === 0) {
            console.error('No document data provided');
            return res.status(400).json({ error: 'No document data provided' });
        }
        console.log('Converting .docx to text, buffer length:', buffer.length);
        const { value: text } = await mammoth.extractRawText({ buffer });
        console.log('Converted .docx to text, length:', text.length, 'first 500 chars:', text.substring(0, 500));
        res.send(text);
    } catch (err) {
        console.error('Conversion error:', err.message, err.stack);
        res.status(500).json({ error: 'Failed to convert document', details: err.message });
    }
});
app.post('/upload-cancellation', verifyToken, (req, res) => {
    const bb = busboy({ headers: req.headers, limits: { fileSize: 50 * 1024 * 1024 } });
    let fileBuffer = Buffer.from([]);
    const fields = {};

    bb.on('file', (name, file, info) => {
        console.log('File received (busboy):', info.filename);
        file.on('data', data => {
            console.log('File chunk received (busboy):', data.length);
            fileBuffer = Buffer.concat([fileBuffer, data]);
        }).on('end', () => {
            console.log('File end (busboy), total length:', fileBuffer.length);
        });
    });

    bb.on('field', (name, value) => {
        console.log('Field received (busboy):', name, value);
        fields[name] = value;
    });

    bb.on('finish', async () => {
        const { orgCode, cid, title, fileName } = fields;
        console.log('Finish event (busboy), fields:', { orgCode, cid, title, fileName });

        if (!fileBuffer.length || !orgCode || !cid || !title || !fileName) {
            console.error('Missing required fields or file');
            return res.status(400).json({ error: 1, message: 'Missing file or required fields (orgCode, cid, title, fileName)' });
        }

        // Sanitize filename to ensure it’s safe
        const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9_.-]/g, '_');
        const storagePath = path.join(orgCode, 'Uploads', sanitizedFileName);
        const savePath = path.join(__dirname, storagePath);
        const dir = path.dirname(savePath);

        try {
            await fs.mkdir(dir, { recursive: true });
            await fs.writeFile(savePath, fileBuffer);
            console.log('File saved to:', savePath);
            res.status(200).json({ error: 0, storagePath: `/${storagePath}` });
        } catch (err) {
            console.error('Error saving file:', err);
            res.status(500).json({ error: 1, message: `Failed to save file: ${err.message}` });
        }
    });

    bb.on('error', (err) => {
        console.error('Busboy error:', err.message, err.stack);
        res.status(500).json({ error: 1, message: `Busboy error: ${err.message}` });
    });

    req.pipe(bb);
});

app.post('/send-cancellation-email', verifyToken, async (req, res) => {
    const { to, cc, subject, body, storagePath, organisationName } = req.body;

    console.log('Received /send-cancellation-email request:', {
        to,
        cc,
        subject,
        bodyLength: body?.length,
        storagePath,
        organisationName,
        headers: req.headers,
        timestamp: new Date().toISOString()
    });

    // Validate required fields
    const missingFields = [];
    if (!to || !Array.isArray(to) || to.length === 0) missingFields.push('to');
    if (!cc || !Array.isArray(cc)) missingFields.push('cc');
    if (!subject) missingFields.push('subject');
    if (!body) missingFields.push('body');
    if (!storagePath) missingFields.push('storagePath');
    if (!organisationName) missingFields.push('organisationName');

    if (missingFields.length > 0) {
        console.error('Validation failed, missing fields:', missingFields);
        return res.status(400).json({ 
            error: 1, 
            message: `Missing required fields: ${missingFields.join(', ')}`
        });
    }

    console.log('Input validation passed, processing attachment');

    try {
        // Normalize and read attachment file
        const normalizedPath = storagePath.replace(/^\/|^\\/, '').replace(/\//g, path.sep);
        const filePath = path.join(__dirname, normalizedPath);
        console.log('Attempting to read attachment:', { filePath, storagePath });

        let attachment = null;
        try {
            await fs.access(filePath);
            const fileContent = await fs.readFile(filePath);
            const fileName = path.basename(filePath);
            console.log('Attachment read successfully:', {
                fileName,
                fileSize: fileContent.length,
                filePath
            });
            attachment = [{
                content: fileContent.toString('base64'),
                name: fileName
            }];
        } catch (fileErr) {
            console.error('Attachment read error:', {
                message: fileErr.message,
                stack: fileErr.stack,
                filePath
            });
            throw new Error(`Failed to read attachment: ${fileErr.message}`);
        }

        // Initialize Brevo client
        console.log('Initializing Brevo client');
        const apiInstance = new Brevo.TransactionalEmailsApi();
        const apiKey = process.env.BREVO_API_KEY || '***REMOVED***';
        apiInstance.setApiKey(Brevo.TransactionalEmailsApiApiKeys.apiKey, apiKey);
        console.log('Brevo API key set, preparing email');

        // Prepare email
        const sendSmtpEmail = {
            sender: { 
                name: organisationName || 'Contract Management', 
                email: 'vanshika.aggarwal@bytewisetl.com' 
            },
            to: to.map(email => ({ email })),
            cc: cc.map(email => ({ email })),
            subject,
            htmlContent: body,
            attachment
        };

        console.log('Email payload prepared:', {
            to: to.join(', '),
            cc: cc.join(', '),
            subject,
            attachmentName: attachment?.[0]?.name,
            bodyLength: body?.length
        });

        // Send email
        console.log('Sending email via Brevo');
        const result = await apiInstance.sendTransacEmail(sendSmtpEmail);
        console.log('Email sent successfully:', {
            result,
            messageId: result?.messageId,
            timestamp: new Date().toISOString()
        });

        res.status(200).json({ 
            error: 0, 
            message: 'Cancellation email sent successfully',
            messageId: result?.messageId
        });
    } catch (err) {
        console.error('Error in /send-cancellation-email:', {
            message: err.message,
            stack: err.stack,
            requestBody: req.body,
            timestamp: new Date().toISOString()
        });
        res.status(500).json({ 
            error: 1, 
            message: `Failed to send cancellation email: ${err.message}`
        });
    }
});
app.post('/save-as', verifyToken, async (req, res) => {
    console.log('Received /save-as request:', {
        body: req.body,
        query: req.query
    });
    const { url, title } = req.body;
    const { newPath } = req.query;
    if (!url || !title || !newPath) {
        console.error('Missing required fields in /save-as request:', { url, title, newPath });
        return res.status(400).json({ error: 1, message: 'Missing required fields: url, title, newPath' });
    }
    try {
        // Download the document from the provided URL
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch document from ${url}: ${response.statusText}`);
        }
        const buffer = await response.buffer();
        // Normalize and save to newPath
        const normalizedPath = newPath.replace(/^\/|^\\/, '').replace(/\//g, path.sep);
        const filePath = path.join(__dirname, normalizedPath);
        const folderPath = path.dirname(filePath);
        console.log('Creating folder:', folderPath);
        await fs.mkdir(folderPath, { recursive: true });
        console.log('Saving to:', filePath);
        await fs.writeFile(filePath, buffer);
        console.log('File saved:', filePath);
        const storagePath = `/${normalizedPath.replace(path.sep, '/')}`;
        console.log('Returning storagePath:', storagePath);
        res.status(200).json({ error: 0, storagePath });
    } catch (error) {
        console.error('Error in /save-as:', error);
        res.status(500).json({ error: 1, message: `Failed to save document: ${error.message}` });
    }
});

// Add these endpoints before app.listen()

// Endpoint to upload profile photo
app.post('/upload-profile-photo', verifyToken, (req, res) => {
    const bb = busboy({ headers: req.headers, limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB limit
    let fileBuffer = Buffer.from([]);
    let filePath;

    bb.on('file', (name, file, info) => {
        console.log('File received (busboy):', info.filename);
        file.on('data', data => {
            fileBuffer = Buffer.concat([fileBuffer, data]);
        }).on('end', () => {
            console.log('File end (busboy), total length:', fileBuffer.length);
        });
    });

    bb.on('field', (name, value) => {
        if (name === 'path') filePath = value;
    });

    bb.on('finish', async () => {
        console.log('Finish event (busboy), path:', filePath);
        if (!filePath || !fileBuffer.length) {
            return res.status(400).json({ error: 'No file or path provided' });
        }
        const normalizedPath = filePath.replace(/^\/|^\\/, '').replace(/\//g, path.sep);
        const savePath = path.join(__dirname, normalizedPath);
        const dir = path.dirname(savePath);
        try {
            await fs.mkdir(dir, { recursive: true });
            await fs.writeFile(savePath, fileBuffer);
            console.log('Profile photo saved to:', savePath);
            res.status(200).json({ message: 'Profile photo uploaded successfully', path: filePath });
        } catch (err) {
            console.error('Error saving profile photo:', err);
            res.status(500).json({ error: 'Failed to save profile photo', message: err.message });
        }
    });

    bb.on('error', (err) => {
        console.error('Busboy error:', err);
        res.status(500).json({ error: 'Busboy error', message: err.message });
    });

    req.pipe(bb);
});

// Endpoint to serve profile photos
app.get('/:orgcode/Profile/:filename', verifyToken, (req, res) => {
    const orgcode = req.params.orgcode;
    const fileName = req.params.filename;
    const filePath = path.join(__dirname, orgcode, 'Profile', fileName);
    console.log('Serving profile photo from:', filePath);
    fs.access(filePath, fs.constants.F_OK)
        .then(() => {
            res.sendFile(filePath, (err) => {
                if (err) {
                    console.error('Error sending profile photo:', err);
                    res.status(500).send('Profile photo not found');
                } else {
                    console.log('Profile photo served:', fileName, 'for orgcode:', orgcode);
                }
            });
        })
        .catch(err => {
            console.error('Profile photo does not exist at:', filePath, 'Error:', err);
            res.status(404).send('Profile photo not found on server');
        });
});

app.post('/initiate-password-reset', async (req, res) => {
    const { username, email, two_step_verification } = req.body;
    console.log('Received /initiate-password-reset request:', { username, email, two_step_verification });

    const missingFields = [];
    if (!username) missingFields.push('username');
    if (!email) missingFields.push('email');
    if (!two_step_verification) missingFields.push('two_step_verification');

    if (missingFields.length > 0) {
        console.error('Missing fields:', missingFields);
        return res.status(400).json({ error: 1, message: `Missing required fields: ${missingFields.join(', ')}` });
    }

    try {
        // Generate reset token
        const token = jwt.sign({ username, email, two_step_verification }, secret, { expiresIn: '1h' });
        const resetUrl = `http://localhost:${port}/reset-password.html?token=${token}`;

        // Send email via Brevo
        const apiInstance = new Brevo.TransactionalEmailsApi();
        apiInstance.setApiKey(Brevo.TransactionalEmailsApiApiKeys.apiKey, BREVO_API_KEY);
        const sendSmtpEmail = {
            sender: { name: 'Accordwise Team', email: 'vanshika.aggarwal@bytewisetl.com' },
            to: [{ email }],
            subject: 'Reset Your Accordwise Password',
            htmlContent: `
                <p>Hello,</p>
                <p>You requested to reset your Accordwise password. Click the link below to proceed:</p>
                <p><a href="${resetUrl}">${resetUrl}</a></p>
                <p>This link expires in 1 hour.</p>
                <p>If you did not request this, ignore this email.</p>
                <p>Regards,<br>Accordwise Team</p>
            `
        };

        const result = await apiInstance.sendTransacEmail(sendSmtpEmail);
        console.log('Password reset email sent:', { email, messageId: result.messageId });

        res.status(200).json({ error: 0, message: 'Password reset email sent' });
    } catch (err) {
        console.error('Error in /initiate-password-reset:', err);
        res.status(500).json({ error: 1, message: `Failed to initiate password reset: ${err.message}` });
    }
});


// Modified: Reset password (no OTP verification)
app.post('/reset-password', async (req, res) => {
    const { token, newPassword } = req.body;
    console.log('Received /reset-password request:', { token: token?.slice(0, 20) + '...', newPassword: '****' });

    if (!token || !newPassword) {
        return res.status(400).json({ error: 1, message: 'Missing token or newPassword' });
    }

    try {
        // Verify token
        const decoded = jwt.verify(token, secret);
        const { username } = decoded;
        console.log('Token verified:', { username });

        // Update password in Supabase
        const { error } = await supabase
            .from('users')
            .update({ password: newPassword, updatedon: new Date().toISOString() })
            .eq('username', username);
        if (error) {
            console.error('Supabase update error:', error);
            throw new Error(`Failed to update password: ${error.message}`);
        }

        console.log('Password updated for:', username);
        res.status(200).json({ error: 0, message: 'Password reset successfully' });
    } catch (err) {
        console.error('Error in /reset-password:', err);
        res.status(500).json({ error: 1, message: `Failed to reset password: ${err.message}` });
    }
});

// Serve reset password page
app.get('/reset-password.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'reset-password.html'));
});


app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
    console.log('Server version: Integrated with OnlyOffice');
});

