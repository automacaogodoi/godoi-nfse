const express = require('express');
const cors = require('cors');
const axios = require('axios');
const AdmZip = require('adm-zip');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*', credentials: false }));
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));

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

function parseZipBuffer(data) {
  try {
    const zip = new AdmZip(Buffer.from(data));
    const result = [];
    for (const entry of zip.getEntries()) {
      if (!entry.isDirectory) {
        result.push({ nome: entry.entryName, conteudo: entry.getData().toString('utf8') });
      }
    }
    return result;
  } catch (e1) {}
  try {
    const decoded = Buffer.from(data.toString(), 'base64');
    const zip = new AdmZip(decoded);
    const result = [];
    for (const entry of zip.getEntries()) {
      if (!entry.isDirectory) {
        result.push({ nome: entry.entryName, conteudo: entry.getData().toString('utf8') });
      }
    }
    return result;
  } catch (e2) {
    throw new Error('Nao foi possivel parsear o ZIP: ' + e2.message);
  }
}

// VFisco - busca paginada completa
// Retorna { notas: [{nome, conteudo}], total, paginas }
// O frontend chama processarArquivo(nome, conteudo) em cada item de notas
app.post('/api/vfisco-rapido/buscar', async (req, res) => {
  try {
    const { apiKey, baseUrl, documentoEmissor, mesIni, mesFim } = req.body;
    const key = apiKey || runtimeConfig.vfiscoApiKey;
    const base = (baseUrl || runtimeConfig.vfiscoBaseUrl || '').replace(/\/$/, '');
    if (!key) return res.status(400).json({ erro: 'API Key do VFisco nao configurada' });
    if (!base) return res.status(400).json({ erro: 'URL base do VFisco nao configurada' });

    const dateIssued = mesIni || mesFim || new Date().toISOString().slice(0, 7);
    const startMonth = mesIni || dateIssued;
    const endMonth = mesFim || dateIssued;
    const invoice_date_from = startMonth + '-01T00:00:00-03:00';
    const [endYear, endMonthNum] = endMonth.split('-').map(Number);
    const lastDay = new Date(endYear, endMonthNum, 0).getDate();
    const invoice_date_to = endMonth + '-' + String(lastDay).padStart(2, '0') + 'T23:59:59-03:00';
    const issuerDoc = documentoEmissor ? ('CNPJ#' + documentoEmissor.replace(/\D/g, '')) : '';

    const url = base + '/nfe/download';
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/zip', 'X-Api-Key': key };

    const allNotas = [];
    let currentIndex = 0;
    let pageNum = 0;
    const MAX_PAGES = 100;

    console.log('[VFisco] Iniciando busca. date_issued:', dateIssued, '| issuer:', issuerDoc || '(todos)');

    while (currentIndex !== -1 && pageNum < MAX_PAGES) {
      const payload = {
        date_issued: dateIssued,
        invoice_date_from,
        invoice_date_to,
        index: currentIndex,
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

      console.log('[VFisco] Pagina', pageNum + 1, '| index:', currentIndex);
      const response = await axios.post(url, payload, { headers, responseType: 'arraybuffer', timeout: 120000 });
      const nextIndex = parseInt(response.headers['x-next-index'] || '-1', 10);
      console.log('[VFisco] status:', response.status, '| X-Next-Index:', nextIndex);

      const pageNotas = parseZipBuffer(response.data);
      console.log('[VFisco] Pagina', pageNum + 1, '| XMLs:', pageNotas.length, '| Acumulado:', allNotas.length + pageNotas.length);
      allNotas.push(...pageNotas);

      if (nextIndex === -1 || isNaN(nextIndex)) break;
      currentIndex = nextIndex;
      pageNum++;
    }

    console.log('[VFisco] Concluido. Total notas:', allNotas.length, '| Paginas:', pageNum + 1);
    // Retorna 'notas' (array de {nome, conteudo}) â formato esperado pelo frontend
    res.json({ notas: allNotas, total: allNotas.length, paginas: pageNum + 1 });

  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    let errorMsg = '';
    if (data) {
      try { errorMsg = Buffer.isBuffer(data) ? data.toString('utf8') : (typeof data === 'string' ? data : JSON.stringify(data)); } catch { errorMsg = String(data); }
    }
    console.error('[VFisco] Erro status:', status);
    console.error('[VFisco] Erro body:', errorMsg);
    res.status(500).json({ erro: 'Erro VFisco: ' + (err.message || 'desconhecido'), status, detalhe: errorMsg });
  }
});

// Acessorias - lista todas as empresas paginadas
app.post('/api/acessorias/empresas', async (req, res) => {
  try {
    const key = runtimeConfig.acessoriasApiKey;
    let base = (runtimeConfig.acessoriasBaseUrl || '').replace(/\/$/, '');
    base = base.replace(/\/documentation.*$/i, '').replace(/\/docs.*$/i, '').replace(/\/swagger.*$/i, '');
    if (!key) return res.status(400).json({ erro: 'API Key das Acessorias nao configurada' });
    if (!base) return res.status(400).json({ erro: 'URL base das Acessorias nao configurada' });

    const allEmpresas = [];
    let pagina = 1;
    const MAX_PAGES = 50;
    console.log('[Acessorias] Iniciando busca. Base:', base);

    while (pagina <= MAX_PAGES) {
      const url = base + '/companies/ListAll?Pagina=' + pagina;
      console.log('[Acessorias] GET', url);
      const response = await axios.get(url, { headers: { 'Authorization': 'Bearer ' + key }, timeout: 30000 });
      const pageItems = Array.isArray(response.data) ? response.data : (response.data ? [response.data] : []);
      console.log('[Acessorias] Pagina', pagina, '| empresas:', pageItems.length);
      if (pageItems.length === 0) break;
      allEmpresas.push(...pageItems);
      pagina++;
    }

    console.log('[Acessorias] Total empresas:', allEmpresas.length);
    // Normaliza campos das empresas para o frontend (Acessorias usa PascalCase)
    const empresasNormalizadas = allEmpresas.map(function(e) {
      return Object.assign({}, e, {
        cnpj: e.Identificador || e.cnpj || '',
        razao: e.Razao || e.razao || '',
        fantasia: e.Fantasia || e.fantasia || '',
        id: e.ID || e.id || '',
        identificador: e.Identificador || e.identificador || '',
        status: e.Status || e.status || '',
        uf: e.UF || e.uf || '',
        analista: e.analista || ''
      });
    });
    res.json({ empresas: empresasNormalizadas });

  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    let errorMsg = '';
    if (data) { try { errorMsg = typeof data === 'string' ? data : JSON.stringify(data); } catch { errorMsg = String(data); } }
    console.error('[Acessorias] Erro status:', status);
    console.error('[Acessorias] Erro body:', errorMsg);
    res.status(500).json({ erro: 'Erro Acessorias: ' + (err.message || 'desconhecido'), status, detalhe: errorMsg });
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'analisador.html'));
});

app.listen(PORT, () => {
  console.log('Servidor rodando na porta', PORT);
  console.log('VFisco URL:', runtimeConfig.vfiscoBaseUrl || '(via env)');
  console.log('Acessorias URL:', runtimeConfig.acessoriasBaseUrl || '(via env)');
});
