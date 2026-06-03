/**
 * ════════════════════════════════════════════════════════════════════════════
 * UTI MÉDICA – Hospital dos Pescadores
 * Code.gs (Google Apps Script)
 * ────────────────────────────────────────────────────────────────────────────
 * Rotas disponíveis via doPost:
 *   1. Busca de culturas por paciente     (action: 'culturas')
 *   2. Busca agregada CCIH institucional  (action: 'culturas_agregado')
 *   3. Sugestão de CID-10 via Groq        (action: 'cid')
 *   4. Backup JSON no Drive               (action: 'backup_json')
 *   5. Criar usuário no Firebase Auth     (action: 'criar_usuario')
 *   6. Excluir usuário do Firebase Auth   (action: 'excluir_usuario')
 *
 * PROPRIEDADES DO SCRIPT (⚙ → Propriedades do script → Adicionar):
 *   GROQ_API_KEY          → chave da API Groq (llama) para CID e antibiograma
 *   FIREBASE_API_KEY      → API Key do Firebase (fallback: FIREBASE_API_KEY_FALLBACK abaixo)
 *   SERVICE_ACCOUNT_JSON  → JSON da service account Firebase (para excluir usuários)
 *
 * PUBLICAR: Implantar → Nova implantação → App da Web → Executar como: você →
 *           Acesso: qualquer pessoa. Cole a URL em APPS_SCRIPT_URL no index.html.
 * ════════════════════════════════════════════════════════════════════════════
 */

// ── CONFIGURAÇÃO ─────────────────────────────────────────────────────────────
var FIREBASE_PROJECT_ID       = 'utihospesc-3ebf4';   // ex: 'uti-medica-pescadores'
var FIREBASE_API_KEY_FALLBACK = 'AIzaSyDryRL7zbTfO2T4xpzIiug4YVjP04ZoJ3k';   // API Key do Firebase (fallback)
var PASTA_BACKUPS             = 'UTI Médica – Backups';

// ── ROTEADOR ─────────────────────────────────────────────────────────────────
function doPost(e) {
  try {
    var body = null;
    try { body = JSON.parse(e.postData.contents); } catch(_) {}

    if (body && body.action === 'culturas')          return buscarCulturas_(body);
    if (body && body.action === 'culturas_agregado') return buscarCulturasAgregado_(body);
    if (body && body.action === 'cid')               return sugerirCID_(body);
    if (body && body.action === 'backup_json')       return salvarBackupJson_(body);
    if (body && body.action === 'criar_usuario')     return criarUsuario_(body);
    if (body && body.action === 'excluir_usuario')   return excluirUsuario_(body);

    return _resposta({ status: 'erro', msg: 'Ação desconhecida: ' + (body&&body.action||'(sem action)') });
  } catch (err) {
    return _resposta({ status: 'erro', msg: err.toString() });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ROTA 1: BUSCA DE CULTURAS POR PACIENTE
// ─ Mesma lógica do sistema de enfermagem: normalização de acentos,
//   extração de antibiograma dos PDFs via OCR + Groq, retorna positivas
//   ordenadas primeiro.
// ════════════════════════════════════════════════════════════════════════════
function buscarCulturas_(body) {
  var paciente = (body.paciente || '').toString().trim().toUpperCase();
  var leito    = parseInt(body.leito || 0);
  var sheetId  = (body.sheetId  || '').toString().trim();

  if (!paciente) return _resposta({ error: 'Nome do paciente não informado.' });
  if (!sheetId)  return _resposta({ error: 'ID da planilha não informado.' });

  var ss;
  try { ss = SpreadsheetApp.openById(sheetId); }
  catch(e) { return _resposta({ error: 'Planilha não encontrada: ' + e.toString() }); }

  var ABA_MODELO = 'MODELO';
  var abas = ss.getSheets()
    .filter(function(s){ return s.getName() !== ABA_MODELO; })
    .reverse();

  var STOPWORDS = ['DA','DE','DO','DOS','DAS','E'];
  function _tokens(nome) {
    if (!nome) return [];
    var norm = nome.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().trim();
    return norm.split(/\s+/).filter(function(t){
      return t.length > 1 && STOPWORDS.indexOf(t) < 0;
    });
  }

  var tokensPac    = _tokens(paciente);
  if (tokensPac.length < 2) return _resposta({ error: 'Nome muito curto. Informe nome completo.' });
  var primeiroPac  = tokensPac[0];
  var ultimoPac    = tokensPac[tokensPac.length - 1];

  var resultados = [], pacienteEncontrado = '', encontrados = 0;

  for (var ai = 0; ai < Math.min(abas.length, 6); ai++) {
    var aba = abas[ai], dados = aba.getDataRange().getValues(), totalRows = dados.length;
    for (var ri = 2; ri < totalRows; ri++) {
      var row = dados[ri];
      var nomePlan = (row[12] || '').toString().trim();
      if (!nomePlan) continue;
      var tokensPlan = _tokens(nomePlan);
      if (tokensPlan.length < 2) continue;
      var primeiroPlan = tokensPlan[0], ultimoPlan = tokensPlan[tokensPlan.length - 1];
      var match = (primeiroPac === primeiroPlan) && (ultimoPac === ultimoPlan);
      if (!match) {
        var normPlan = nomePlan.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().trim();
        match = tokensPac.every(function(t){ return normPlan.indexOf(t) >= 0; });
      }
      if (!match) continue;
      if (!pacienteEncontrado) pacienteEncontrado = nomePlan;

      var resultado = (row[16] || '').toString().trim();
      var sensib    = (row[18] || '').toString().trim().replace(/=IFERROR[^)]+\)\)/g,'').replace(/^[,\s]+/,'').trim();
      var cultura   = (row[14] || '').toString().trim();
      var dataRec   = row[9]  ? Utilities.formatDate(new Date(row[9]),  'America/Fortaleza','dd/MM/yyyy') : '';
      var dataRes   = row[10] ? Utilities.formatDate(new Date(row[10]), 'America/Fortaleza','dd/MM/yyyy') : '';
      if (!resultado) continue;

      var isNeg    = /negativ|contaminad|pendente/i.test(resultado);
      var microorg = isNeg ? '' : resultado.split(/\n/)[0].trim();
      var nomeAba_ = aba.getName();
      var urlPDF   = _extrairUrlPDFLinha_(sheetId, nomeAba_, ri, totalRows, (dados[ri][11]||'').toString().trim());

      resultados.push({
        aba: nomeAba_, dataRecebimento: dataRec, dataResultado: dataRes,
        cultura: cultura, resultado: resultado, microorg: microorg,
        sensibilidade: sensib, urlPDF: urlPDF
      });
      encontrados++;
      if (encontrados >= 20) break;
    }
    if (encontrados >= 20) break;
  }

  // Positivas primeiro, depois por data
  resultados.sort(function(a,b){
    var aN = /negativ|contaminad|pendente/i.test(a.resultado);
    var bN = /negativ|contaminad|pendente/i.test(b.resultado);
    if (aN !== bN) return aN ? 1 : -1;
    return b.dataResultado.localeCompare(a.dataResultado);
  });

  // Extrai antibiograma dos PDFs das positivas (máx. 5)
  var apiKey = PropertiesService.getScriptProperties().getProperty('GROQ_API_KEY');
  if (apiKey) {
    var tentados = 0;
    for (var pi = 0; pi < resultados.length && tentados < 5; pi++) {
      var r = resultados[pi];
      if (/negativ|contaminad|pendente/i.test(r.resultado) || !r.urlPDF) continue;
      try {
        var atb = _lerAntibiogramaPDF_(r.urlPDF, apiKey);
        if (atb && atb.length) {
          r.antibiograma = atb;
          var rR = atb.filter(function(a){ return a.resultado==='RESISTENTE'; }).map(function(a){ return 'R:'+a.atb; }).join('; ');
          var rS = atb.filter(function(a){ return a.resultado==='SENSÍVEL';   }).slice(0,3).map(function(a){ return 'S:'+a.atb; }).join('; ');
          r.sensibilidade = [rR,rS].filter(Boolean).join(' | ') || r.sensibilidade;
        }
      } catch(ePDF) { Logger.log('[PDF] '+pi+': '+ePDF); }
      tentados++;
    }
  }

  return _resposta({ pacienteEncontrado: pacienteEncontrado, resultados: resultados });
}

// ════════════════════════════════════════════════════════════════════════════
// ROTA 2: BUSCA AGREGADA — PANORAMA CCIH INSTITUCIONAL
// ─ Varre todas as abas recentes da planilha, retorna todas as culturas com
//   antibiogramas extraídos dos PDFs. Usado nos indicadores CCIH.
// ════════════════════════════════════════════════════════════════════════════
function buscarCulturasAgregado_(body) {
  var sheetId = (body.sheetId || '').toString().trim();
  var maxAbas = parseInt(body.maxAbas || 3);
  var maxPDFs = parseInt(body.maxPDFs || 20);
  if (!sheetId) return _resposta({ error: 'ID da planilha não informado.' });

  var ss;
  try { ss = SpreadsheetApp.openById(sheetId); }
  catch(e) { return _resposta({ error: 'Planilha não encontrada: ' + e.toString() }); }

  var abas = ss.getSheets()
    .filter(function(s){ return s.getName() !== 'MODELO'; })
    .reverse()
    .slice(0, maxAbas === 99 ? 999 : maxAbas);

  var todasCulturas = [];
  for (var ai = 0; ai < abas.length; ai++) {
    var aba = abas[ai], dados = aba.getDataRange().getValues(), totalRows = dados.length;
    for (var ri = 2; ri < totalRows; ri++) {
      var row  = dados[ri];
      var nome = (row[12] || '').toString().trim();
      if (!nome) continue;
      var resultado = (row[16] || '').toString().trim();
      if (!resultado) continue;
      var isNeg    = /negativ|contaminad|pendente/i.test(resultado);
      var microorg = isNeg ? '' : resultado.split(/\n/)[0].trim();
      var cultura  = (row[14] || '').toString().trim();
      var sensib   = (row[18] || '').toString().trim().replace(/=IFERROR[^)]+\)\)/g,'').replace(/^[,\s]+/,'').trim();
      var dataRes  = row[10] ? Utilities.formatDate(new Date(row[10]),'America/Fortaleza','dd/MM/yyyy') : '';
      var urlPDF   = _extrairUrlPDFLinha_(sheetId, aba.getName(), ri, totalRows, (dados[ri][11]||'').toString().trim());
      todasCulturas.push({ paciente:nome, aba:aba.getName(), dataResultado:dataRes,
        cultura:cultura, resultado:resultado, microorg:microorg, sensibilidade:sensib,
        urlPDF:urlPDF, negativa:isNeg });
    }
  }

  // Extrai antibiogramas dos PDFs das positivas
  var apiKey = PropertiesService.getScriptProperties().getProperty('GROQ_API_KEY');
  var tentados = 0, extraidos = 0;
  for (var pi = 0; pi < todasCulturas.length && tentados < maxPDFs; pi++) {
    var c = todasCulturas[pi];
    if (c.negativa || !c.urlPDF) continue;
    try {
      var atb = _lerAntibiogramaPDF_(c.urlPDF, apiKey);
      if (atb && atb.length) { c.antibiograma = atb; extraidos++; }
    } catch(e) { Logger.log('[PDF agregado] '+e); }
    tentados++;
  }
  Logger.log('[Agregado] '+tentados+' tentativas, '+extraidos+' extrações OK');

  var pacSet={}, pacPosSet={};
  todasCulturas.forEach(function(c){ pacSet[c.paciente]=true; if(!c.negativa) pacPosSet[c.paciente]=true; });

  return _resposta({
    status:'ok', totalCulturas:todasCulturas.length,
    pacientesAnalisados:Object.keys(pacSet).length,
    pacientesPositivos:Object.keys(pacPosSet).length,
    pdfsExtraidos:extraidos, culturas:todasCulturas
  });
}

// ════════════════════════════════════════════════════════════════════════════
// EXTRAÇÃO DE ANTIBIOGRAMA: PDF → OCR (Drive) → regex → Groq fallback
// ════════════════════════════════════════════════════════════════════════════
function _lerAntibiogramaPDF_(urlPDF, apiKey) {
  if (!urlPDF || !apiKey) return null;
  var pdfBytes = null;
  try {
    var m = urlPDF.match(/\/d\/([a-zA-Z0-9_-]{20,})/) || urlPDF.match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
    if (m) {
      var fileId = m[1], token = ScriptApp.getOAuthToken();
      var dl = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/'+fileId+'?alt=media',
        { headers:{ Authorization:'Bearer '+token }, muteHttpExceptions:true });
      if (dl.getResponseCode() === 200) pdfBytes = dl.getContent();
    }
    if (!pdfBytes) {
      var r = UrlFetchApp.fetch(urlPDF,{ muteHttpExceptions:true });
      if (r.getResponseCode() === 200) pdfBytes = r.getContent();
    }
  } catch(e) { Logger.log('[PDF dl] '+e); return null; }
  if (!pdfBytes || !pdfBytes.length) return null;

  // OCR via Drive API
  var texto = '', docId = null;
  try {
    var blob = Utilities.newBlob(pdfBytes,'application/pdf','laudo.pdf');
    try {
      var cr = Drive.Files.create({name:'ocr_med_'+Date.now(),mimeType:MimeType.GOOGLE_DOCS},blob,{ocr:true});
      docId = cr.id;
    } catch(ev3) {
      try {
        var ins = Drive.Files.insert({title:'ocr_med_'+Date.now(),mimeType:MimeType.GOOGLE_DOCS},blob,{convert:true,ocr:true});
        docId = ins.id;
      } catch(ev2) { Logger.log('[OCR] v2+v3 falhou: '+ev2); }
    }
    if (docId) texto = DocumentApp.openById(docId).getBody().getText();
  } catch(e) { Logger.log('[OCR] '+e); }
  finally { if(docId) try{ DriveApp.getFileById(docId).setTrashed(true); }catch(_){} }

  if (!texto || texto.length < 50) {
    try { texto = Utilities.newBlob(pdfBytes,'application/pdf').getDataAsString(); } catch(e) { return null; }
  }
  if (!texto || texto.length < 50) return null;
  if (/negativ|contaminad|ausência de germe|sem crescimento/i.test(texto) &&
      !/SENSÍVEL|RESISTENTE|INTERMEDIÁRIO|antibiograma/i.test(texto)) return null;

  // Parser regex (rápido, sem tokens)
  var linhas = texto.split(/\r?\n/), arr = [], dentroTabela = false;
  for (var li = 0; li < linhas.length; li++) {
    var linha = linhas[li].trim();
    if (!linha) continue;
    if (/antibiótico|antibiotic/i.test(linha) && /mic|sensib/i.test(linha)) { dentroTabela = true; continue; }
    if (/^legenda|^assinado|este laborat|portaria|brcast|eucast/i.test(linha)) dentroTabela = false;
    if (!dentroTabela) continue;
    var mRes = linha.match(/(SENSÍVEL|RESISTENTE|INTERMEDIÁRIO|SENSIVEL|INTERMEDIARIO)\s*$/i);
    if (!mRes) continue;
    var resultado = mRes[1].toUpperCase().replace('SENSIVEL','SENSÍVEL').replace('INTERMEDIARIO','INTERMEDIÁRIO');
    var semRes = linha.slice(0, linha.lastIndexOf(mRes[1])).trim();
    var mMIC = semRes.match(/([<>]=?[\d,\.]+|\d[\d,\.]*)$/);
    var mic = '', nomeAtb = semRes;
    if (mMIC) { mic = mMIC[1].replace(',','.'); nomeAtb = semRes.slice(0,semRes.lastIndexOf(mMIC[1])).trim(); }
    if (nomeAtb) arr.push({ atb:nomeAtb, mic:mic, resultado:resultado });
  }
  if (arr.length > 0) return arr;

  // Groq como fallback
  if (!apiKey) return null;
  try {
    var prompt = 'Extraia a tabela de antibiograma deste laudo. JSON apenas:\n'+
      '{"antibiograma":[{"atb":"nome","mic":"valor","resultado":"SENSÍVEL|RESISTENTE|INTERMEDIÁRIO"}]}\n\n'+
      'LAUDO:\n'+texto.substring(0,3000);
    var gr = UrlFetchApp.fetch('https://api.groq.com/openai/v1/chat/completions',{
      method:'post',contentType:'application/json',
      headers:{'Authorization':'Bearer '+apiKey},
      payload:JSON.stringify({model:'llama-3.1-8b-instant',
        messages:[{role:'system',content:'Extrator de antibiogramas. Apenas JSON.'},
                  {role:'user',content:prompt}],
        temperature:0.0,max_tokens:1200,response_format:{type:'json_object'}}),
      muteHttpExceptions:true
    });
    if (gr.getResponseCode()!==200) return null;
    var gd=JSON.parse(gr.getContentText()), txt=gd.choices[0].message.content;
    var parsed=JSON.parse(txt);
    arr=(parsed.antibiograma||[]).filter(function(i){ return i&&i.atb&&i.resultado; })
      .map(function(i){
        var res=(i.resultado||'').toUpperCase();
        if(res.indexOf('SENS')>=0) res='SENSÍVEL';
        else if(res.indexOf('RES')>=0) res='RESISTENTE';
        else if(res.indexOf('INT')>=0) res='INTERMEDIÁRIO';
        return { atb:i.atb.trim(), mic:(i.mic||'').toString(), resultado:res };
      });
    return arr.length ? arr : null;
  } catch(eGroq) { Logger.log('[Groq ATB] '+eGroq); return null; }
}

// ════════════════════════════════════════════════════════════════════════════
// EXTRAÇÃO DE URLs DE PDFs (Smart Chips + RichText + Hyperlink + Drive)
// ════════════════════════════════════════════════════════════════════════════
var _cacheChipsPorAba = {};

function _preCarregarChipsDaAba_(sheetId, nomeAba, totalLinhas) {
  if (!sheetId || !nomeAba || _cacheChipsPorAba[nomeAba] !== undefined) return;
  _cacheChipsPorAba[nomeAba] = {};
  try {
    var rng    = encodeURIComponent("'"+nomeAba+"'!L1:L"+totalLinhas);
    var fields = encodeURIComponent('sheets(data(rowData(values(chipRuns(chip(richLinkProperties(uri)))))))');
    var url    = 'https://sheets.googleapis.com/v4/spreadsheets/'+sheetId+'?ranges='+rng+'&fields='+fields;
    var resp   = UrlFetchApp.fetch(url,{ headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()}, muteHttpExceptions:true });
    if (resp.getResponseCode() !== 200) return;
    var data = JSON.parse(resp.getContentText()), rowData = [];
    try { rowData = data.sheets[0].data[0].rowData || []; } catch(e) {}
    rowData.forEach(function(row,ri){
      if (!row || !row.values) return;
      (row.values||[]).forEach(function(cell){
        if (!cell || !cell.chipRuns) return;
        cell.chipRuns.forEach(function(cr){
          var uri = cr&&cr.chip&&cr.chip.richLinkProperties&&cr.chip.richLinkProperties.uri;
          if (uri && !_cacheChipsPorAba[nomeAba][ri]) _cacheChipsPorAba[nomeAba][ri] = uri;
        });
      });
    });
    Logger.log('[Chips] "'+nomeAba+'": '+Object.keys(_cacheChipsPorAba[nomeAba]).length+' URIs');
  } catch(e) { Logger.log('[Chips] erro "'+nomeAba+'": '+e); }
}

function _extrairUrlPDFLinha_(sheetId, nomeAba, ri, totalLinhas, valorCelula) {
  _preCarregarChipsDaAba_(sheetId, nomeAba, totalLinhas);
  var uri = _cacheChipsPorAba[nomeAba] && _cacheChipsPorAba[nomeAba][ri];
  if (uri) return uri;
  try {
    var aba = SpreadsheetApp.openById(sheetId).getSheetByName(nomeAba);
    if (aba) {
      var cell = aba.getRange(ri+1,12), rt = cell.getRichTextValue();
      if (rt) {
        var lk = rt.getLinkUrl(); if (lk) return lk;
        var runs = rt.getRuns();
        for (var k=0;k<runs.length;k++) { var rl=runs[k].getLinkUrl(); if(rl) return rl; }
      }
      var f = cell.getFormula();
      if (f) { var mf=f.match(/HYPERLINK\s*\(\s*["']([^"']+)["']/i); if(mf) return mf[1]; }
    }
  } catch(e2) {}
  return '';
}

// ════════════════════════════════════════════════════════════════════════════
// ROTA 3: SUGESTÃO DE CID-10 via Groq
// ════════════════════════════════════════════════════════════════════════════
function sugerirCID_(body) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('GROQ_API_KEY');
  if (!apiKey) return _resposta({ error: 'GROQ_API_KEY não configurada.' });
  var diag = (body.diagnostico || '').trim();
  if (!diag) return _resposta({ error: 'Diagnóstico vazio.' });

  var expandido = _expandirAbreviacoes_(diag);
  var resultado = _chamarGroqCID_(apiKey, diag, expandido);
  if (resultado.error) return _resposta(resultado);

  // Recusa Z00 para diagnósticos clínicos
  if (_cidSuspeito_(resultado.cid, diag)) {
    resultado = _chamarGroqCID_(apiKey, diag, expandido, true);
    if (resultado.error) return _resposta(resultado);
    if (_cidSuspeito_(resultado.cid, diag))
      return _resposta({ error:'A IA insistiu em Z00 para diagnóstico clínico. Preencha o CID manualmente.', cidRecusado:resultado.cid });
  }
  return _resposta(resultado);
}

function _expandirAbreviacoes_(texto) {
  var dic = {
    'IC':'Insuficiência Cardíaca','ICC':'Insuficiência Cardíaca Congestiva','EAP':'Edema Agudo de Pulmão',
    'IAM':'Infarto Agudo do Miocárdio','SCA':'Síndrome Coronariana Aguda','HAS':'Hipertensão Arterial Sistêmica',
    'FA':'Fibrilação Atrial','TEP':'Tromboembolismo Pulmonar','TVP':'Trombose Venosa Profunda',
    'SDRA':'Síndrome do Desconforto Respiratório Agudo','IRA':'Insuficiência Respiratória Aguda',
    'DPOC':'Doença Pulmonar Obstrutiva Crônica','PAC':'Pneumonia Adquirida na Comunidade',
    'AVC':'Acidente Vascular Cerebral','AVCi':'Acidente Vascular Cerebral Isquêmico',
    'TCE':'Traumatismo Cranioencefálico','HSA':'Hemorragia Subaracnoidea',
    'IRC':'Insuficiência Renal Crônica','DRC':'Doença Renal Crônica','LRA':'Lesão Renal Aguda',
    'DM':'Diabetes Mellitus','CAD':'Cetoacidose Diabética','ITU':'Infecção do Trato Urinário',
    'SIRS':'Síndrome da Resposta Inflamatória Sistêmica','VMI':'Ventilação Mecânica Invasiva',
    'FAAR':'Fibrilação Atrial de Alta Resposta','HP':'Hipertensão Pulmonar'
  };
  var saida = texto;
  Object.keys(dic).forEach(function(sigla){
    var re = new RegExp('\\b'+sigla.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b','gi');
    saida = saida.replace(re, dic[sigla]+' ('+sigla+')');
  });
  return saida;
}

function _chamarGroqCID_(apiKey, original, expandido, retentativa) {
  var systemMsg = 'Especialista em CID-10, contexto UTI adulta. Retorne JSON {"cid":"X00.0","descricao":"..."}. '+
    'NUNCA use Z00/Z01/Z76 para diagnósticos clínicos. IC perfil B = I50.9. Apenas código no campo cid. Sem markdown.';
  var exemplos = 'Exemplos:\n"IC descompensada" → I50.9\n"EAP" → I50.1\n"AVC isquêmico" → I63.9\n'+
    '"Sepse" → A41.9\n"DPOC exacerbada" → J44.1\n"HAS" → I10\n"LRA" → N17.9\n"Pneumonia" → J18.9\n'+
    '"FAAR" → I48.0\n"Hipertensão Pulmonar" → I27.0';
  var userPrompt = exemplos+'\n\nMapeie: "'+original+'"'+
    (expandido!==original?'\n(expandido: "'+expandido+'")':'')+'\nResponda só com o JSON.';
  var messages = [{role:'system',content:systemMsg},{role:'user',content:userPrompt}];
  if (retentativa) messages.push({role:'system',content:'Sua resposta foi Z00. Errado. Retorne código clínico.'});

  var resp = UrlFetchApp.fetch('https://api.groq.com/openai/v1/chat/completions',{
    method:'post',contentType:'application/json',
    headers:{'Authorization':'Bearer '+apiKey},
    payload:JSON.stringify({model:'llama-3.1-8b-instant',messages:messages,
      temperature:0.05,max_tokens:120,response_format:{type:'json_object'}}),
    muteHttpExceptions:true
  });
  if (resp.getResponseCode()!==200) {
    if (resp.getResponseCode()===429) return {error:'rate_limit',msg:'Limite Groq atingido. Preencha o CID manualmente.'};
    return {error:'Groq erro '+resp.getResponseCode()};
  }
  var data = JSON.parse(resp.getContentText());
  var texto = (data.choices&&data.choices[0]&&data.choices[0].message&&data.choices[0].message.content)||'';
  var parsed;
  try { parsed = JSON.parse(texto); } catch(e) {
    var jm = texto.match(/\{[\s\S]*\}/);
    if (jm) try { parsed = JSON.parse(jm[0]); } catch(e2) { return {error:'JSON inválido',raw:texto.substring(0,200)}; }
    else return {error:'JSON inválido',raw:texto.substring(0,200)};
  }
  if (!parsed.cid) return {error:'Sem campo cid',raw:texto.substring(0,200)};
  var cm = parsed.cid.match(/[A-Z]\d{2}(?:\.\d+)?/);
  if (cm) parsed.cid = cm[0].toUpperCase();
  return parsed;
}

function _cidSuspeito_(cid,texto) {
  if (!cid) return false;
  if (!/^Z00|^Z01|^Z76/.test(cid.toUpperCase().trim())) return false;
  return !/rotina|check|preventiv/i.test(texto);
}

// ════════════════════════════════════════════════════════════════════════════
// ROTA 4: BACKUP JSON NO DRIVE
// ════════════════════════════════════════════════════════════════════════════
function salvarBackupJson_(payload) {
  var titulo = (payload.titulo || 'backup_uti_med_'+new Date().getTime()).toString();
  var json   = (payload.json || '').toString();
  if (!json) return _resposta({ status:'erro', msg:'JSON ausente.' });
  var pasta = _acharOuCriarPasta(DriveApp.getRootFolder(), PASTA_BACKUPS);
  var blob  = Utilities.newBlob(json,'application/json',titulo+'.json');
  var arq   = pasta.createFile(blob);
  return _resposta({ status:'ok', arquivo:arq.getName(), url:arq.getUrl() });
}

// ════════════════════════════════════════════════════════════════════════════
// ROTA 5: CRIAR USUÁRIO (Firebase Auth via Identity Toolkit)
// ════════════════════════════════════════════════════════════════════════════
function criarUsuario_(body) {
  var email = (body.email||'').toString().trim().toLowerCase();
  var senha = (body.senha||'').toString();
  if (!email||!senha) return _resposta({status:'erro',msg:'E-mail e senha obrigatórios.'});
  if (senha.length<6) return _resposta({status:'erro',msg:'Senha precisa de ao menos 6 caracteres.'});
  var apiKey = PropertiesService.getScriptProperties().getProperty('FIREBASE_API_KEY')||FIREBASE_API_KEY_FALLBACK;
  var resp = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:signUp?key='+apiKey,{
    method:'post',contentType:'application/json',
    payload:JSON.stringify({email:email,password:senha,returnSecureToken:false}),
    muteHttpExceptions:true
  });
  var code = resp.getResponseCode(), data = {};
  try { data = JSON.parse(resp.getContentText()); } catch(_) {}
  if (code===200&&data.localId) return _resposta({status:'ok',uid:data.localId,email:email});
  var msg = (data.error&&data.error.message)||('HTTP '+code);
  if (/EMAIL_EXISTS/i.test(msg)) return _resposta({status:'ok',jaExiste:true,email:email});
  return _resposta({status:'erro',msg:'Erro ao criar: '+msg});
}

// ════════════════════════════════════════════════════════════════════════════
// ROTA 6: EXCLUIR USUÁRIO (requer Service Account)
// ════════════════════════════════════════════════════════════════════════════
function excluirUsuario_(body) {
  var email = (body.email||'').toString().trim().toLowerCase();
  if (!email) return _resposta({status:'erro',msg:'E-mail não informado.'});
  var token = _getServiceAccountToken_();
  if (!token) return _resposta({status:'erro',msg:'Service Account não configurada. Cole a chave em SERVICE_ACCOUNT_JSON nas Propriedades do script.'});
  var lookup = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/projects/'+FIREBASE_PROJECT_ID+'/accounts:query',{
    method:'post',contentType:'application/json',
    headers:{Authorization:'Bearer '+token},
    payload:JSON.stringify({expression:[{email:[email]}]}),
    muteHttpExceptions:true
  });
  var uid = null;
  try { var lk=JSON.parse(lookup.getContentText()); if(lk.userInfo&&lk.userInfo.length) uid=lk.userInfo[0].localId; } catch(_) {}
  if (!uid) return _resposta({status:'ok',naoExiste:true,msg:'Conta não encontrada.'});
  var del = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/projects/'+FIREBASE_PROJECT_ID+'/accounts:delete',{
    method:'post',contentType:'application/json',
    headers:{Authorization:'Bearer '+token},
    payload:JSON.stringify({localId:uid}),
    muteHttpExceptions:true
  });
  return del.getResponseCode()===200
    ? _resposta({status:'ok',email:email,uid:uid})
    : _resposta({status:'erro',msg:'Erro ao excluir: '+del.getContentText().substring(0,200)});
}

function _getServiceAccountToken_() {
  var raw = PropertiesService.getScriptProperties().getProperty('SERVICE_ACCOUNT_JSON');
  if (!raw) return null;
  var sa; try { sa=JSON.parse(raw); } catch(e) { return null; }
  if (!sa.client_email||!sa.private_key) return null;
  var now=Math.floor(Date.now()/1000);
  var scope='https://www.googleapis.com/auth/identitytoolkit https://www.googleapis.com/auth/firebase';
  var header=Utilities.base64EncodeWebSafe(JSON.stringify({alg:'RS256',typ:'JWT'}));
  var claim=Utilities.base64EncodeWebSafe(JSON.stringify({iss:sa.client_email,scope:scope,
    aud:'https://oauth2.googleapis.com/token',exp:now+3600,iat:now}));
  var sig=Utilities.base64EncodeWebSafe(Utilities.computeRsaSha256Signature(header+'.'+claim,sa.private_key));
  var jwt=header+'.'+claim+'.'+sig;
  var tr=UrlFetchApp.fetch('https://oauth2.googleapis.com/token',{method:'post',
    payload:{grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:jwt},muteHttpExceptions:true});
  try { var td=JSON.parse(tr.getContentText()); return td.access_token||null; } catch(e) { return null; }
}

// ── UTILITÁRIOS ───────────────────────────────────────────────────────────────
function _acharOuCriarPasta(pai,nome){
  var it=pai.getFoldersByName(nome); if(it.hasNext()) return it.next(); return pai.createFolder(nome);
}
function _resposta(obj){
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ── DIAGNÓSTICOS / TESTES (rode no editor do Apps Script) ────────────────────
function _testarServiceAccount(){ var t=_getServiceAccountToken_(); Logger.log(t?'SA OK ('+t.length+' chars)':'FALHOU'); }
function _testarToken(){
  var sheetId = ''; // cole o ID da planilha aqui
  var token   = ScriptApp.getOAuthToken();
  var r = UrlFetchApp.fetch('https://sheets.googleapis.com/v4/spreadsheets/'+sheetId+'?fields=properties.title',
    {headers:{Authorization:'Bearer '+token},muteHttpExceptions:true});
  Logger.log('Sheets API: '+r.getResponseCode()+' → '+r.getContentText().substring(0,200));
}
function _testarCulturas(){
  var fake={postData:{contents:JSON.stringify({action:'culturas',
    paciente:'FRANCISCA DAS CHAGAS DANTAS DE OLIVEIRA',leito:1,
    sheetId:'' // cole o ID da planilha CCIH aqui
  })}};
  Logger.log(doPost(fake).getContent().substring(0,500));
}
