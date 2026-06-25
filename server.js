const express = require('express');
const cors = require('cors');
const axios = require('axios');
const AdmZip = require('adm-zip');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;

const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(s => s.trim())
  : ['http://localhost:3000', 'http://localhost:3001'];

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    return callback(null, true);
  },
  credentials: true
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

let runtimeConfig = {
  vfiscoApiKey: process.env.VFISCO_API_KEY || '',
  vfiscoBaseUrl: process.env.VFISCO_BASE_URL || 'https://api.vfisco.com.br',
  acessoriasApiKey: process.env.ACESSORIAS_API_KEY || '',
  acessoriasBaseUrl: process.env.ACESSORIAS_BASE_URL || 'https://api.acessorias.com.br'
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
  if (vfiscoApiKey !== undefined) runtimeConfig.vfiscoApiKey = vfiscoApiKey;
  if (vfiscoBaseUrl !== undefined) runtimeConfig.vfiscoBaseUrl = vfiscoBaseUrl;
  if (acessoriasApiKey !== undefined) runtimeConfig.acessoriasApiKey = acessoriasApiKey;
  if (acessoriasBaseUrl !== undefined) runtimeConfig.acessoriasBaseUrl = acessoriasBaseUrl;
  res.json({ success: true, message: 'Configuracoes salvas com sucesso' });
});

app.post('/api/vfisco-rapido/buscar', async (req, res) => {
  try {
    const { cnpj, dataInicio, dataFim, tipo } = req.body;
    if (!runtimeConfig.vfiscoApiKey) {
      return res.status(400).json({ error: 'Chave API VFisco nao configurada' });
    }
    const baseUrl = runtimeConfig.vfiscoBaseUrl;
    const apiKey = runtimeConfig.vfiscoApiKey;
    const response = await axios.post(`${baseUrl}/nfse/download`, {
      cnpj, dataInicio, dataFim, tipo: tipo || 'T'
    }, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      responseType: 'arraybuffer',
      timeout: 120000
    });
    const contentType = response.headers['content-type'] || '';
    if (contentType.includes('zip') || contentType.includes('octet-stream')) {
      const zip = new AdmZip(Buffer.from(response.data));
      const entries = zip.getEntries();
      const xmlFiles = [];
      entries.forEach(entry => {
        if (entry.entryName.toLowerCase().endsWith('.xml')) {
          xmlFiles.push({ name: entry.entryName, content: entry.getData().toString('utf8') });
        }
      });
      return res.json({ success: true, xmlFiles, total: xmlFiles.length });
    }
    const jsonData = JSON.parse(Buffer.from(response.data).toString('utf8'));
    return res.json({ success: true, data: jsonData });
  } catch (error) {
    console.error('Erro VFisco:', error.message);
    if (error.response) {
      return res.status(error.response.status).json({
        error: 'Erro na API VFisco',
        message: error.response.data ? JSON.stringify(error.response.data) : error.message,
        status: error.response.status
      });
    }
    return res.status(500).json({ error: 'Erro ao conectar com API VFisco', message: error.message });
  }
});

app.post('/api/acessorias/empresas', async (req, res) => {
  try {
    if (!runtimeConfig.acessoriasApiKey) {
      return res.status(400).json({ error: 'Chave API Acessorias nao configurada' });
    }
    const baseUrl = runtimeConfig.acessoriasBaseUrl;
    const apiKey = runtimeConfig.acessoriasApiKey;
    const response = await axios.get(`${baseUrl}/empresas`, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      params: req.body,
      timeout: 30000
    });
    return res.json({ success: true, empresas: response.data });
  } catch (error) {
    console.error('Erro Acessorias:', error.message);
    if (error.response) {
      return res.status(error.response.status).json({
        error: 'Erro na API Acessorias',
        message: error.response.data ? JSON.stringify(error.response.data) : error.message,
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
  console.log('Servidor NFS-e rodando na porta ' + PORT);
  console.log('VFisco configurado: ' + !!runtimeConfig.vfiscoApiKey);
  console.log('Acessorias configurado: ' + !!runtimeConfig.acessoriasApiKey);
});

module.exports = app;
