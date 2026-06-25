const express = require('express');
const cors = require('cors');
const axios = require('axios');
const AdmZip = require('adm-zip');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*', credentials: false }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

let runtimeConfig = {
  vfiscoApiKey: process.env.VFISCO_API_KEY || '',
  vfiscoBaseUrl: process.env.VFISCO_BASE_URL || '',
  acessoriasApiKey: process.env.ACESSORIAS_API_KEY || '',
  acessoriasBaseUrl: process.env.ACESSORIAS_BASE_URL || ''
};

app.get('/api/config', (req, res) => {
  res.json({
    hasVfiscoKey: !!runtimeConfig.vfiscoApiKey,
    hasAcessoriasKey: !!runtimeConfig.acessoriasApiKey,
    vfiscoBaseUrl: runtimeConfig.vfiscoBaseUrl,
    acessoriasBaseUrl: runtimeConfig.acessoriasBaseUrl
  });
});

app.post('/api/config', (req, res) => {
  const { vfiscoApiKey, vfiscoBaseUrl, acessoriasApiKey, acessoriasBaseUrl } = req.body;
  if (vfiscoApiKey !== undefined && vfiscoApiKey !== '') runtimeConfig.vfiscoApiKey = vfiscoApiKey;
  if (vfiscoBaseUrl !== undefined && vfiscoBaseUrl !== '') runtimeConfig.vfiscoBaseUrl = vfiscoBaseUrl;
  if (acessoriasApiKey !== undefined && acessoriasApiKey !== '') runtimeConfig.acessoriasApiKey = acessoriasApiKey;
  if (acessoriasBaseUrl !== undefined && acessoriasBaseUrl !== '') runtimeConfig.acessoriasBaseUrl = acessoriasBaseUrl;
  res.json({ success: true });
});

// ============================================================
// VFisco / Vistax - Download NF-e XMLs
// Endpoint: POST {baseUrl}/nfe/download
// Auth: X-Api-Key header
// date_issued format: "YYYY-MM" (no day)
// ============================================================
app.post('/api/vfisco-rapido/buscar', async (req, res) => {
  try {
    const { apiKey, baseUrl, documentoEmissor, mesIni, mesFim } = req.body;

    const key = apiKey || runtimeConfig.vfiscoApiKey;
    const base = (baseUrl || runtimeConfig.vfiscoBaseUrl || '').replace(/\/$/, '');

    if (!key) return res.status(400).json({ erro: 'API Key do VFisco nao configurada' });
    if (!base) return res.status(400).json({ erro: 'URL base do VFisco nao configurada' });

    // date_issued format: "YYYY-MM" (no day) e.g. "2026-05"
    const dateIssued = mesIni || mesFim || new Date().toISOString().slice(0, 7);

    // Build date range for invoice_date_from / invoice_date_to
    const startMonth = mesIni || dateIssued;
    const endMonth = mesFim || dateIssued;
    const invoice_date_from = startMonth + '-01T00:00:00-03:00';
    const [endYear, endMonthNum] = endMonth.split('-').map(Number);
    const lastDay = new Date(endYear, endMonthNum, 0).getDate();
    const invoice_date_to = endMonth + '-' + String(lastDay).padStart(2, '0') + 'T23:59:59-03:00';

    // issuer_document: format "CNPJ#12345678000190"
    const issuerDoc = documentoEmissor ? ('CNPJ#' + documentoEmissor.replace(/\D/g, '')) : '';

    const payload = {
      date_issued: dateIssued,
      invoice_date_from,
      invoice_date_to,
      index: 0,
      invoice_xml: true,
      invoice_events: false,
      invoice_pdf: false,
      ignore_canceled: false,
      issuer_document: issuerDoc,
      payer_document: '',
      dispatcher_document: '',
      persona_document: '',
      autxml_document: '',
      invoice_key: '',
      invoice_number: '',
      invoice_status: ''
    };

    const url = base + '/nfe/download';
    console.log('[VFisco] POST', url);
    console.log('[VFisco] date_issued:', dateIssued, '| issuer:', issuerDoc);

    const response = await axios.post(url, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/zip',
        'X-Api-Key': key
      },
      responseType: 'arraybuffer',
      timeout: 60000
    });

    console.log('[VFisco] status:', response.status);
    const nextIndex = response.headers['x-next-index'] || '-1';
    console.log('[VFisco] X-Next-Index:', nextIndex);

    const zipBuffer = Buffer.from(response.data);
    const xmlFiles = [];

    // Try to parse as raw binary ZIP first
    let parsed = false;
    try {
      const zip = new AdmZip(zipBuffer);
      const entries = zip.getEntries();
      console.log('[VFisco] ZIP entries:', entries.length);
      for (const entry of entries) {
        if (!entry.isDirectory) {
          xmlFiles.push({ nome: entry.entryName, conteudo: entry.getData().toString('utf8') });
        }
      }
      parsed = true;
    } catch (e1) {
      console.log('[VFisco] Raw ZIP parse failed:', e1.message, '- trying base64...');
    }

    // Try base64-decoded ZIP
    if (!parsed) {
      try {
        const decoded = Buffer.from(response.data.toString(), 'base64');
        const zip2 = new AdmZip(decoded);
        const entries2 = zip2.getEntries();
        console.log('[VFisco] base64 ZIP entries:', entries2.length);
        for (const entry of entries2) {
          if (!entry.isDirectory) {
            xmlFiles.push({ nome: entry.entryName, conteudo: entry.getData().toString('utf8') });
          }
        }
        parsed = true;
      } catch (e2) {
        console.error('[VFisco] base64 ZIP parse failed:', e2.message);
        return res.status(500).json({ erro: 'Erro ao processar ZIP: ' + e2.message });
      }
    }

    console.log('[VFisco] XMLs encontrados:', xmlFiles.length);
    res.json({ xmls: xmlFiles, total: xmlFiles.length, nextIndex });

  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    let errorMsg = '';
    if (data) {
      try {
        errorMsg = Buffer.isBuffer(data) ? data.toString('utf8') : (typeof data === 'string' ? data : JSON.stringify(data));
      } catch { errorMsg = String(data); }
    }
    console.error('[VFisco] Erro status:', status);
    console.error('[VFisco] Erro body:', errorMsg);
    res.status(500).json({ erro: 'Erro VFisco: ' + (err.message || 'desconhecido'), status, detalhe: errorMsg });
  }
});

// ============================================================
// Acessorias - Listar Empresas
// Endpoint: GET {baseUrl}/companies/ListAll?Pagina=1
// Auth: Authorization: Bearer <key>
// ============================================================
app.post('/api/acessorias/empresas', async (req, res) => {
  try {
    const key = runtimeConfig.acessoriasApiKey;
    // Strip documentation/docs/swagger suffixes from base URL
    let base = (runtimeConfig.acessoriasBaseUrl || '').replace(/\/$/, '');
    base = base.replace(/\/documentation.*$/i, '');
    base = base.replace(/\/docs.*$/i, '');
    base = base.replace(/\/swagger.*$/i, '');

    if (!key) return res.status(400).json({ erro: 'API Key das Acessorias nao configurada' });
    if (!base) return res.status(400).json({ erro: 'URL base das Acessorias nao configurada' });

    const url = base + '/companies/ListAll?Pagina=1';
    console.log('[Acessorias] GET', url);

    const response = await axios.get(url, {
      headers: { 'Authorization': 'Bearer ' + key },
      timeout: 30000
    });

    console.log('[Acessorias] status:', response.status);
    const data = response.data;
    const empresas = Array.isArray(data) ? data : (data ? [data] : []);
    console.log('[Acessorias] empresas:', empresas.length);

    res.json({ empresas });

  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    let errorMsg = '';
    if (data) {
      try { errorMsg = typeof data === 'string' ? data : JSON.stringify(data); } catch { errorMsg = String(data); }
    }
    console.error('[Acessorias] Erro status:', status);
    console.error('[Acessorias] Erro body:', errorMsg);
    res.status(500).json({ erro: 'Erro Acessorias: ' + (err.message || 'desconhecido'), status, detalhe: errorMsg });
  }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'analisador.html'));
});

app.listen(PORT, () => {
  console.log('Servidor rodando na porta', PORT);
  console.log('VFisco URL:', runtimeConfig.vfiscoBaseUrl || '(via env VFISCO_BASE_URL)');
  console.log('Acessorias URL:', runtimeConfig.acessoriasBaseUrl || '(via env ACESSORIAS_BASE_URL)');
});
