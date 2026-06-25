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

// Config em memoria (carrega das env vars, pode ser sobrescrito via POST /api/config)
let runtimeConfig = {
  vfiscoApiKey: process.env.VFISCO_API_KEY || '',
  vfiscoBaseUrl: process.env.VFISCO_BASE_URL || '',
  acessoriasApiKey: process.env.ACESSORIAS_API_KEY || '',
  acessoriasBaseUrl: process.env.ACESSORIAS_BASE_URL || ''
};

// GET /api/config - retorna status das chaves
app.get('/api/config', (req, res) => {
  res.json({
    hasVfiscoKey: !!runtimeConfig.vfiscoApiKey,
    hasAcessoriasKey: !!runtimeConfig.acessoriasApiKey,
    vfiscoBaseUrl: runtimeConfig.vfiscoBaseUrl,
    acessoriasBaseUrl: runtimeConfig.acessoriasBaseUrl
  });
});

// POST /api/config - salva chaves em runtime
app.post('/api/config', (req, res) => {
  const { vfiscoApiKey, vfiscoBaseUrl, acessoriasApiKey, acessoriasBaseUrl } = req.body;
  if (vfiscoApiKey !== undefined && vfiscoApiKey !== '') runtimeConfig.vfiscoApiKey = vfiscoApiKey;
  if (vfiscoBaseUrl !== undefined && vfiscoBaseUrl !== '') runtimeConfig.vfiscoBaseUrl = vfiscoBaseUrl;
  if (acessoriasApiKey !== undefined && acessoriasApiKey !== '') runtimeConfig.acessoriasApiKey = acessoriasApiKey;
  if (acessoriasBaseUrl !== undefined && acessoriasBaseUrl !== '') runtimeConfig.acessoriasBaseUrl = acessoriasBaseUrl;
  console.log('Config atualizada via POST /api/config');
  res.json({ success: true, message: 'Configuracoes salvas com sucesso' });
});

// POST /api/vfisco-rapido/buscar
// O frontend envia: { apiKey, baseUrl, documentoEmissor, mesIni, mesFim }
// O servidor usa apiKey/baseUrl do body SE enviados, senao usa das env vars
// Depois faz proxy para a API Vistax
app.post('/api/vfisco-rapido/buscar', async (req, res) => {
  try {
    console.log('Recebido /api/vfisco-rapido/buscar:', JSON.stringify(req.body));
    
    const apiKey = req.body.apiKey || runtimeConfig.vfiscoApiKey;
    const baseUrl = (req.body.baseUrl || runtimeConfig.vfiscoBaseUrl || '').replace(/\/+$/, '');
    const documentoEmissor = req.body.documentoEmissor || req.body.cnpj || '';
    const mesIni = req.body.mesIni || req.body.dataInicio || '';
    const mesFim = req.body.mesFim || req.body.dataFim || '';

    if (!apiKey) {
      return res.status(400).json({ error: 'Chave API VFisco nao configurada' });
    }
    if (!baseUrl) {
      return res.status(400).json({ error: 'URL base VFisco nao configurada' });
    }

    // Tenta diferentes endpoints conhecidos da Vistax/VFisco
    // Primeiro tenta o endpoint principal
    const payload = {
      documentoEmissor,
      mesIni,
      mesFim
    };
    
    const headers = {
      'x-api-key': apiKey,
      'Content-Type': 'application/json'
    };

    console.log('Chamando VFisco:', baseUrl + '/nfse/download-xml');
    console.log('Headers:', JSON.stringify({ 'x-api-key': apiKey.substring(0, 8) + '...' }));
    console.log('Payload:', JSON.stringify(payload));

    let response;
    try {
      response = await axios.post(baseUrl + '/nfse/download-xml', payload, {
        headers,
        responseType: 'arraybuffer',
        timeout: 120000
      });
    } catch (e1) {
      console.log('Endpoint /nfse/download-xml falhou:', e1.message, e1.response?.status);
      // Tenta endpoint alternativo
      try {
        response = await axios.post(baseUrl + '/nfse/download', payload, {
          headers,
          responseType: 'arraybuffer',
          timeout: 120000
        });
      } catch (e2) {
        console.log('Endpoint /nfse/download falhou:', e2.message, e2.response?.status);
        // Tenta como GET
        try {
          response = await axios.get(baseUrl + '/nfse', {
            headers,
            params: payload,
            timeout: 120000
          });
        } catch (e3) {
          throw e2; // lanca o erro do segundo endpoint
        }
      }
    }

    const contentType = response.headers['content-type'] || '';
    console.log('Resposta VFisco content-type:', contentType, 'size:', response.data?.length);

    if (contentType.includes('zip') || contentType.includes('octet-stream') || response.data instanceof Buffer) {
      try {
        const zip = new AdmZip(Buffer.from(response.data));
        const entries = zip.getEntries();
        const xmlFiles = [];
        entries.forEach(entry => {
          if (entry.entryName.toLowerCase().endsWith('.xml')) {
            xmlFiles.push({ name: entry.entryName, content: entry.getData().toString('utf8') });
          }
        });
        return res.json({ success: true, xmlFiles, total: xmlFiles.length });
      } catch (zipErr) {
        // Nao era ZIP, tenta como JSON
        console.log('Nao era ZIP, tentando JSON');
      }
    }

    // Tenta parsear como JSON
    try {
      const jsonData = JSON.parse(Buffer.from(response.data).toString('utf8'));
      return res.json({ success: true, data: jsonData });
    } catch (e) {
      // Retorna raw
      return res.json({ success: true, raw: Buffer.from(response.data).toString('utf8').substring(0, 1000) });
    }

  } catch (error) {
    console.error('Erro VFisco:', error.message);
    if (error.response) {
      let errorData = '';
      try {
        errorData = Buffer.from(error.response.data).toString('utf8');
      } catch(e) {
        errorData = String(error.response.data);
      }
      console.error('Erro VFisco response data:', errorData.substring(0, 500));
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
// O frontend envia: {} (sem body, usa as chaves configuradas)
app.post('/api/acessorias/empresas', async (req, res) => {
  try {
    console.log('Recebido /api/acessorias/empresas:', JSON.stringify(req.body));
    
    const apiKey = req.body.apiKey || runtimeConfig.acessoriasApiKey;
    const baseUrl = (req.body.baseUrl || runtimeConfig.acessoriasBaseUrl || '').replace(/\/+$/, '');

    if (!apiKey) {
      return res.status(400).json({ error: 'Chave API Acessorias nao configurada' });
    }
    if (!baseUrl) {
      return res.status(400).json({ error: 'URL base Acessorias nao configurada' });
    }

    const headers = {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json'
    };

    console.log('Chamando Acessorias:', baseUrl + '/clientes');

    let response;
    try {
      response = await axios.get(baseUrl + '/clientes', { headers, timeout: 30000 });
    } catch (e1) {
      console.log('Endpoint /clientes falhou:', e1.message, e1.response?.status);
      try {
        response = await axios.get(baseUrl + '/empresas', { headers, timeout: 30000 });
      } catch (e2) {
        console.log('Endpoint /empresas falhou:', e2.message, e2.response?.status);
        throw e2;
      }
    }

    console.log('Resposta Acessorias status:', response.status);
    return res.json({ success: true, empresas: response.data });

  } catch (error) {
    console.error('Erro Acessorias:', error.message);
    if (error.response) {
      let errorData = '';
      try { errorData = typeof error.response.data === 'string' ? error.response.data : JSON.stringify(error.response.data); } catch(e) {}
      console.error('Erro Acessorias response:', errorData.substring(0, 500));
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
  console.log('Servidor NFS-e rodando na porta ' + PORT);
  console.log('VFisco configurado: ' + !!runtimeConfig.vfiscoApiKey);
  console.log('VFisco baseUrl: ' + runtimeConfig.vfiscoBaseUrl);
  console.log('Acessorias configurado: ' + !!runtimeConfig.acessoriasApiKey);
  console.log('Acessorias baseUrl: ' + runtimeConfig.acessoriasBaseUrl);
});

module.exports = app;
