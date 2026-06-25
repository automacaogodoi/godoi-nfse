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
  res.json({ success: true, message: 'Configuracoes salvas com sucesso' });
});

// POST /api/vfisco-rapido/buscar
// Frontend envia: { apiKey, baseUrl, documentoEmissor, mesIni, mesFim }
// Vistax espera: { date_issued, cnpj } (campo date_issued obrigatorio)
app.post('/api/vfisco-rapido/buscar', async (req, res) => {
  try {
    const body = req.body;
    console.log('=== VFisco request ===', JSON.stringify(body));
    
    const apiKey = body.apiKey || runtimeConfig.vfiscoApiKey;
    const baseUrl = (body.baseUrl || runtimeConfig.vfiscoBaseUrl || '').replace(/\/+$/, '');
    const documentoEmissor = body.documentoEmissor || body.cnpj || '';
    const mesIni = body.mesIni || body.dataInicio || '';
    const mesFim = body.mesFim || body.dataFim || '';

    if (!apiKey) return res.status(400).json({ error: 'Chave API VFisco nao configurada' });
    if (!baseUrl) return res.status(400).json({ error: 'URL base VFisco nao configurada' });

    const headers = {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json, application/zip, application/octet-stream'
    };

    // A Vistax exige 'date_issued' - converter mesIni (YYYY-MM) para date_issued
    // Tenta varios formatos possiveis para date_issued
    // Format: "2026-05" -> "2026-05-01" ou "05/2026"
    
    let vistaxPayload = {};
    
    if (documentoEmissor) {
      vistaxPayload.cnpj = documentoEmissor.replace(/\D/g, '');
      vistaxPayload.document = documentoEmissor.replace(/\D/g, '');
    }
    
    if (mesIni) {
      // Tenta varios formatos de data
      const parts = mesIni.split('-');
      if (parts.length === 2) {
        vistaxPayload.date_issued = mesIni + '-01';
        vistaxPayload.start_date = mesIni + '-01';
        vistaxPayload.data_inicio = mesIni + '-01';
        vistaxPayload.mes = mesIni;
        vistaxPayload.month = mesIni;
        vistaxPayload.competence = mesIni;
        vistaxPayload.period = mesIni;
        vistaxPayload.reference_month = mesIni;
      }
    }
    
    if (mesFim) {
      // Ultimo dia do mes
      const parts = mesFim.split('-');
      if (parts.length === 2) {
        const lastDay = new Date(parseInt(parts[0]), parseInt(parts[1]), 0).getDate();
        vistaxPayload.end_date = mesFim + '-' + String(lastDay).padStart(2, '0');
        vistaxPayload.data_fim = vistaxPayload.end_date;
        vistaxPayload.date_issued_end = vistaxPayload.end_date;
      }
    }
    
    // Tambem passa os campos originais
    vistaxPayload.documentoEmissor = documentoEmissor;
    vistaxPayload.mesIni = mesIni;
    vistaxPayload.mesFim = mesFim;

    console.log('Payload para Vistax:', JSON.stringify(vistaxPayload));
    console.log('URL:', baseUrl + '/nfse/download-xml');

    let response;
    let lastError;
    
    // Lista de endpoints para tentar
    const endpoints = [
      '/nfse/download-xml',
      '/nfse/download',
      '/nfse',
      '/v1/nfse/download-xml',
      '/v1/nfse/download',
    ];
    
    for (const endpoint of endpoints) {
      try {
        console.log('Tentando endpoint:', baseUrl + endpoint);
        response = await axios.post(baseUrl + endpoint, vistaxPayload, {
          headers,
          responseType: 'arraybuffer',
          timeout: 120000
        });
        console.log('Sucesso no endpoint:', endpoint, 'status:', response.status);
        break;
      } catch (e) {
        lastError = e;
        const errData = e.response?.data ? 
          (() => { try { return Buffer.from(e.response.data).toString('utf8'); } catch(x) { return String(e.response.data); } })()
          : e.message;
        console.log('Endpoint', endpoint, 'falhou:', e.response?.status, errData.substring(0, 200));
        if (e.response?.status === 401 || e.response?.status === 403) {
          // Problema de auth - nao adianta tentar outros endpoints
          throw e;
        }
      }
    }
    
    if (!response) throw lastError;

    const contentType = response.headers['content-type'] || '';
    console.log('Response content-type:', contentType, 'size:', response.data?.length);

    // Tenta como ZIP
    try {
      const zip = new AdmZip(Buffer.from(response.data));
      const entries = zip.getEntries();
      const xmlFiles = [];
      entries.forEach(entry => {
        if (entry.entryName.toLowerCase().endsWith('.xml') || entry.entryName.toLowerCase().endsWith('.xml')) {
          xmlFiles.push({ name: entry.entryName, content: entry.getData().toString('utf8') });
        }
      });
      if (xmlFiles.length > 0) {
        console.log('ZIP com', xmlFiles.length, 'XMLs');
        return res.json({ success: true, xmlFiles, total: xmlFiles.length });
      }
    } catch (zipErr) {
      console.log('Nao era ZIP:', zipErr.message);
    }

    // Tenta como JSON
    try {
      const text = Buffer.from(response.data).toString('utf8');
      const jsonData = JSON.parse(text);
      return res.json({ success: true, data: jsonData });
    } catch (e) {
      const raw = Buffer.from(response.data).toString('utf8').substring(0, 2000);
      console.log('Raw response:', raw.substring(0, 200));
      return res.json({ success: true, raw });
    }

  } catch (error) {
    console.error('=== Erro VFisco ===', error.message);
    if (error.response) {
      let errorData = '';
      try { errorData = Buffer.from(error.response.data).toString('utf8'); } catch(e) { errorData = String(error.response.data); }
      console.error('Response data:', errorData.substring(0, 500));
      return res.status(error.response.status).json({
        error: 'Erro na API VFisco',
        message: errorData || error.message,
        status: error.response.status
      });
    }
    return res.status(500).json({ error: 'Erro ao conectar com API VFisco', message: error.message });
  }
});

// POST /api/acessorias/empresas
app.post('/api/acessorias/empresas', async (req, res) => {
  try {
    console.log('=== Acessorias request ===', JSON.stringify(req.body));
    
    const apiKey = req.body.apiKey || runtimeConfig.acessoriasApiKey;
    const baseUrl = (req.body.baseUrl || runtimeConfig.acessoriasBaseUrl || '').replace(/\/+$/, '');

    if (!apiKey) return res.status(400).json({ error: 'Chave API Acessorias nao configurada' });
    if (!baseUrl) return res.status(400).json({ error: 'URL base Acessorias nao configurada' });

    const headers = {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json'
    };

    let response;
    let lastError;
    
    const endpoints = ['/clientes', '/empresas', '/v1/clientes', '/v1/empresas', '/clients'];
    
    for (const endpoint of endpoints) {
      try {
        console.log('Tentando Acessorias:', baseUrl + endpoint);
        response = await axios.get(baseUrl + endpoint, { headers, timeout: 30000 });
        console.log('Acessorias OK:', endpoint, response.status);
        break;
      } catch (e) {
        lastError = e;
        const errMsg = e.response?.status || e.message;
        console.log('Acessorias', endpoint, 'falhou:', errMsg);
        try {
          const errData = e.response?.data ? (typeof e.response.data === 'object' ? JSON.stringify(e.response.data) : String(e.response.data)) : '';
          console.log('Acessorias error data:', errData.substring(0, 200));
        } catch(x) {}
        if (e.response?.status === 401 || e.response?.status === 403) break;
      }
    }
    
    if (!response) throw lastError;
    
    return res.json({ success: true, empresas: response.data });

  } catch (error) {
    console.error('=== Erro Acessorias ===', error.message);
    if (error.response) {
      let errorData = '';
      try { errorData = typeof error.response.data === 'string' ? error.response.data : JSON.stringify(error.response.data); } catch(e) {}
      console.error('Acessorias response:', errorData.substring(0, 500));
      return res.status(error.response.status).json({
        error: 'Erro na API Acessorias',
        message: errorData || error.message,
        status: error.response.status
      });
    }
    return res.status(500).json({ error: 'Erro ao conectar com API Acessorias', message: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'analisador.html');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.send('<h1>Analisador NFS-e</h1><p>Frontend nao encontrado.</p>');
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log('Servidor NFS-e na porta ' + PORT);
  console.log('VFisco configurado: ' + !!runtimeConfig.vfiscoApiKey);
  console.log('VFisco baseUrl: ' + runtimeConfig.vfiscoBaseUrl);
  console.log('Acessorias configurado: ' + !!runtimeConfig.acessoriasApiKey);
  console.log('Acessorias baseUrl: ' + runtimeConfig.acessoriasBaseUrl);
});

module.exports = app;
