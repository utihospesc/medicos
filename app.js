/* ════════════════════════════════════════════════════════════════════════════
   UTI MÉDICA – Hospital dos Pescadores
   app.js  ·  Sistema de evolução médica
   ────────────────────────────────────────────────────────────────────────────
   Estrutura de dados (Firestore — compatível com o sistema de enfermagem):
     uti_leitos                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M3 8h10"/><path d="M9.5 4.5L13 8l-3.5 3.5"/></svg> mapa de leitos (objeto único)
     uti_med_ev_<leito>_<turno>_<data>   <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M3 8h10"/><path d="M9.5 4.5L13 8l-3.5 3.5"/></svg> evolução médica de um turno
     uti_med_adm_log_<...>     <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M3 8h10"/><path d="M9.5 4.5L13 8l-3.5 3.5"/></svg> log de admissões (para indicadores)
     uti_med_alta_log_<...>    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M3 8h10"/><path d="M9.5 4.5L13 8l-3.5 3.5"/></svg> log de altas
     usuarios_med (coleção)    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M3 8h10"/><path d="M9.5 4.5L13 8l-3.5 3.5"/></svg> perfis dos médicos
   Obs.: prefixo "uti_med_" isola os dados médicos dos de enfermagem mesmo que
   compartilhem o mesmo projeto Firebase.
   ════════════════════════════════════════════════════════════════════════════ */

'use strict';

/* ── CONSTANTES GERAIS ────────────────────────────────────────────────────── */
const TOTAL_LEITOS = 10;
const ADMIN_EMAILS = ['admin@pescadores.natal.br']; // ajuste conforme necessário
const PERFIS_SEED  = {}; // ex: {'medico@x.br':{nome:'DR. FULANO',crm:'RN12345'}}
const APPS_SCRIPT_URL  = window.APPS_SCRIPT_URL  || '';
const CULTURAS_SHEET_ID = window.CULTURAS_SHEET_ID || '';
const CARTAO_SUS_FOLDER_ID = window.CARTAO_SUS_FOLDER_ID || '';
let _cartaoSUSPDF = null;
let _cartaoSUSStatus = '';

let db = null, auth = null;
let usuarioEmail = null, perfilUsuario = null;
let turnoAtual = null;        // 'DIURNO' | 'NOTURNO'
let leitoAtual = null;        // número do leito aberto no formulário
let modalLeito = null;        // leito do modal de admissão
let leitoParaAlta = null;
let _culturasForm = [];       // chips de cultura do formulário atual
let _labLinhas = [];          // exames laboratoriais (array de {data, valores})
let _itensSAPS = {};          // itens de admissão do SAPS preenchidos manualmente
let _labChart = null;         // instância Chart.js
let _labCampoAtivo = null;    // campo do gráfico de exames selecionado
let _modoOffline = false;

/* ── HELPERS BÁSICOS ──────────────────────────────────────────────────────── */
const $  = id => document.getElementById(id);
const gf = id => { const e = $(id); return e ? (e.value||'') : ''; };
const sf = (id,v) => { const e=$(id); if(!e) return; e.value=(v==null?'':v); if(e.tagName==='TEXTAREA'&&!e.hasAttribute('readonly')){e.style.height='auto';e.style.height=e.scrollHeight+'px';} };
const pad = n => String(n).padStart(2,'0');
function hoje(){ const d=new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function ontem(){ const d=new Date(); d.setDate(d.getDate()-1); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function agoraHora(){ const d=new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }

// Turno: DIURNO 07:00–18:59 | NOTURNO 19:00–06:59. Entre 00h–06h59 o noturno
// pertence à data do dia anterior (mesma regra do sistema de enfermagem).
function dataDoTurno(turno){
  const h = new Date().getHours();
  if(turno==='NOTURNO' && h>=0 && h<7) return ontem();
  return hoje();
}
function _normalizarNome(s){
  if(!s) return '';
  // Remove acentos/diacríticos antes de normalizar (João ↔ Joao, etc.)
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/\s+/g,' ').trim();
}
function _isAdmin(){ return usuarioEmail && ADMIN_EMAILS.includes(usuarioEmail.toLowerCase()); }

const DIARISTA_EMAIL = 'diaristauti@hospesc.com';
function _isDiarista(){ return usuarioEmail && usuarioEmail.toLowerCase() === DIARISTA_EMAIL; }

// ── EVOLUÇÃO DIARISTA — modal estruturado ────────────────────────────────────
// Chave: uti_med_diarista_<leito>_<data>
// Só diaristauti@hospesc.com edita; demais veem dropdown read-only na evolução.
// NÃO entra em coletarDados() nem na impressão.

function _chaveDiarista(leito, data){ return `uti_med_diarista_${leito}_${data}`; }

const _DEV_CHECKS = [
  'dc-dor','dc-sed','dc-vm-desm','dc-vm-prev',
  'dc-nut','dc-prof','dc-disp','dc-atb','dc-cult','dc-novinf',
  'dc-riscos','dc-med','dc-mob','dc-plano'
];

async function abrirModalDiaristaEv(leito){
  if(!_isDiarista()){ toast('Acesso exclusivo do médico diarista.', true); return; }
  if(leito) leitoAtual = leito;
  const ld = await _getLeitos();
  const L  = ld[leitoAtual] || {};
  const data = hoje();
  sf('dev-leito', pad(leitoAtual));
  sf('dev-pac',   L.pac || '—');
  sf('dev-data',  _fmtDataCurta(data));
  const dado = await dbGet(_chaveDiarista(leitoAtual, data));
  sf('dev-diag',  dado?.diag  || '');
  sf('dev-cid',   dado?.cid   || '');
  sf('dev-livre', dado?.livre || '');
  _DEV_CHECKS.forEach(id => { const el=$(id); if(el) el.checked = !!(dado?.checklist?.[id]); });
  document.querySelectorAll('#dev-metas-grid input[type=checkbox]').forEach(cb => {
    cb.checked = !!(dado?.metas?.includes(cb.value));
  });
  $('modal-diarista-ev').classList.add('show');
}

function fecharModalDiaristaEv(){ $('modal-diarista-ev').classList.remove('show'); }

async function salvarEvolucaoDiaristaModal(){
  if(!_isDiarista()){ toast('Sem permissão.', true); return; }
  const data = hoje();
  const checklist = {};
  _DEV_CHECKS.forEach(id => { const el=$(id); if(el) checklist[id] = el.checked; });
  const metas = [];
  document.querySelectorAll('#dev-metas-grid input[type=checkbox]:checked')
    .forEach(cb => metas.push(cb.value));
  const ld = await _getLeitos();
  const payload = {
    leito: leitoAtual, data,
    paciente: ld[leitoAtual]?.pac || '',
    diag:    (gf('dev-diag') || '').trim(),
    cid:     (gf('dev-cid')  || '').trim().toUpperCase(),
    checklist, metas,
    livre:   (gf('dev-livre') || '').trim(),
    autor:   usuarioEmail,
    autorNome: perfilUsuario ? perfilUsuario.nome : usuarioEmail,
    registradoEm: new Date().toISOString()
  };
  try{
    showLoading('Salvando evolução diarista...');
    await dbSet(_chaveDiarista(leitoAtual, data), payload);
    hideLoading();
    fecharModalDiaristaEv();
    toast('<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M2.5 8.5l3.5 3.5 7.5-7.5"/></svg> Evolução diarista salva');
    await _carregarDiarista(leitoAtual, data);
  } catch(e){
    hideLoading();
    toast('Erro ao salvar: ' + (e.message||e), true);
  }
}

async function _carregarDiarista(leito, data){
  const painel = $('secao-diarista-dropdown');
  const metaEl = $('diarista-dropdown-meta');
  if(!painel) return;
  const dado = await dbGet(_chaveDiarista(leito, data));
  if(!dado || (!dado.diag && !dado.livre && !dado.metas?.length &&
      !Object.values(dado.checklist||{}).some(Boolean))){
    painel.style.display = 'none'; return;
  }
  painel.style.display = '';
  if(metaEl){
    const dt = dado.registradoEm ? new Date(dado.registradoEm) : null;
    const fmt = dt ? dt.toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}) : '';
    metaEl.textContent = `${dado.autorNome||'Diarista'} — ${fmt}`;
  }
  const body = $('diarista-dropdown-body');
  if(body && body.style.display !== 'none') _renderDiaristaDropdown(dado);
}

function _toggleDiaristaDropdown(){
  const body = $('diarista-dropdown-body');
  const chev = $('diarista-dropdown-chev');
  if(!body) return;
  const aberto = body.style.display !== 'none';
  if(aberto){ body.style.display='none'; if(chev) chev.classList.remove('open'); }
  else {
    body.style.display = '';
    if(chev) chev.classList.add('open');
    const dataT = $('f-data') ? $('f-data').value : hoje();
    dbGet(_chaveDiarista(leitoAtual, dataT)).then(dado => { if(dado) _renderDiaristaDropdown(dado); });
  }
}

function _renderDiaristaDropdown(d){
  const body = $('diarista-dropdown-body');
  if(!body || !d) return;
  const GRUPOS = [
    { titulo:'Neurologia e Analgesia', cls:'neuro', itens:[
      {id:'dc-dor', txt:'Dor e delirium avaliados e tratados'},
      {id:'dc-sed', txt:'Sedação avaliada, com redução ou interrupção se elegível'},
    ]},
    { titulo:'Ventilação Mecânica', cls:'vent', itens:[
      {id:'dc-vm-desm', txt:'Avaliação de possibilidade de desmame e ajuste para VM protetora'},
      {id:'dc-vm-prev', txt:'Medidas preventivas aplicadas: cabeceira elevada e higiene oral'},
    ]},
    { titulo:'Nutrição e Profilaxias', cls:'nut', itens:[
      {id:'dc-nut',  txt:'Nutrição avaliada e otimizada'},
      {id:'dc-prof', txt:'Profilaxias revisadas (TVP e HDA)'},
    ]},
    { titulo:'Manejo Infeccioso', cls:'inf', itens:[
      {id:'dc-disp',   txt:'Necessidade de manutenção dos dispositivos reavaliada'},
      {id:'dc-atb',    txt:'Antibioticoterapia em uso avaliada (ajuste ou suspensão)'},
      {id:'dc-cult',   txt:'Culturas avaliadas'},
      {id:'dc-novinf', txt:'Novo quadro infeccioso grave — protocolo de 1h aplicado'},
    ]},
    { titulo:'Plano Multidisciplinar', cls:'multi', itens:[
      {id:'dc-riscos', txt:'Identificação correta e riscos mapeados'},
      {id:'dc-med',    txt:'Revisão e conciliação de medicações realizadas'},
      {id:'dc-mob',    txt:'Mobilização e fisioterapia ativa avaliadas'},
      {id:'dc-plano',  txt:'Plano terapêutico definido e discutido com equipe'},
    ]},
  ];
  const cl = d.checklist || {};
  let h = '';
  if(d.diag || d.cid){
    h += `<div class="dev-ro-section"><div class="dev-ro-sec-title">Diagnósticos</div>`;
    if(d.diag) h += `<div class="dev-ro-diag">${d.diag}</div>`;
    if(d.cid)  h += `<span class="dev-ro-cid">${d.cid}</span>`;
    h += `</div>`;
  }
  const algumCheck = Object.values(cl).some(Boolean);
  if(algumCheck){
    h += `<div class="dev-ro-section"><div class="dev-ro-sec-title">Check-List</div>`;
    GRUPOS.forEach(g => {
      const marcados = g.itens.filter(i => cl[i.id]);
      if(!marcados.length) return;
      h += `<div class="dev-ro-check-group"><div class="dev-ro-check-grp-title dev-ro-chk-hdr-${g.cls}">${g.titulo}</div>`;
      g.itens.forEach(i => {
        h += `<div class="dev-ro-item ${cl[i.id]?'dev-ro-item-ok':'dev-ro-item-no'}">${i.txt}</div>`;
      });
      h += `</div>`;
    });
    h += `</div>`;
  }
  if(d.metas && d.metas.length){
    h += `<div class="dev-ro-section"><div class="dev-ro-sec-title">Metas do Dia</div>
      <div class="dev-ro-metas">${d.metas.map(m=>`<span class="dev-ro-meta-chip">${m}</span>`).join('')}</div></div>`;
  }
  if(d.livre){
    h += `<div class="dev-ro-section"><div class="dev-ro-sec-title">Campo Livre</div>
      <div class="dev-ro-livre">${d.livre}</div></div>`;
  }
  if(d.autorNome && d.registradoEm){
    const dt = new Date(d.registradoEm);
    const fmt = dt.toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
    h += `<div class="dev-ro-author">Registrado por ${d.autorNome} em ${fmt}</div>`;
  }
  body.innerHTML = h;
}

function _aplicarModoDiarista(){ /* sem-op — agora é modal */ }
async function salvarEvolucaoDiarista(){ await salvarEvolucaoDiaristaModal(); }

// ── GESTÃO DO LEITO: ALTA / ÓBITO / TRANSFERÊNCIA ─────────────────────────
// Prefixos de chaves vinculadas a um leito (para mover na transferência interna)
const _PREFIXOS_LEITO = [
  'uti_med_ev_',           // evoluções
  'uti_med_rx_',           // prescrição
  'uti_med_imgs_',         // imagens de exame
  'uti_med_atb_ficha_',    // fichas ATB
  'uti_med_hemo_ficha_',   // fichas hemoterapia
  'uti_med_sol_exam_',     // solicitações de exame
  'uti_med_sol_cult_',     // solicitações de cultura
  'uti_med_parecer_',       // pareceres
  'uti_med_trilogy_',       // plano terapêutico trilogy
  'uti_med_me_',            // termo morte encefálica
  'uti_med_diarista_',     // evoluções diarista
  'uti_med_termo_',        // termos/consentimentos
  'uti_med_huol_',         // solicitação de vaga HUOL/NIR
  'uti_med_adm_log_',      // log de admissão
];

let _gestaoLeito = null;       // leito sendo gerenciado
let _gestaoTipo  = null;       // 'alta_hosp' | 'alta_uti' | 'obito' | 'transf_ext' | 'transf_int'

async function abrirGestaoLeito(leito){
  _gestaoLeito = leito;
  _gestaoTipo = null;
  const ld = await _getLeitos();
  const L = ld[leito];
  if(!L || !L.ocupado){
    toast('Este leito está vazio.', true);
    return;
  }
  const info = $('gestao-info');
  if(info){
    info.innerHTML = `<strong>Leito ${pad(leito)}</strong> — ${L.pac||'(sem nome)'} ` +
      (L.adm ? ` · Admitido em ${_fmtDataCurta(L.adm)}` : '') +
      (L.diag ? `<br><span style="color:var(--muted);font-size:.78rem;">${L.diag}</span>` : '');
  }
  $('gestao-menu').style.display = '';
  $('gestao-form-saida').style.display = 'none';
  $('gestao-form-transf').style.display = 'none';
  $('gestao-titulo').textContent = 'Gerenciar leito ' + pad(leito);
  $('modal-gestao-leito').classList.add('show');
}

function fecharGestaoLeito(){
  $('modal-gestao-leito').classList.remove('show');
  _gestaoLeito = null; _gestaoTipo = null;
}

function _gestaoVoltar(){
  $('gestao-menu').style.display = '';
  $('gestao-form-saida').style.display = 'none';
  $('gestao-form-transf').style.display = 'none';
  _gestaoTipo = null;
}

async function _gestaoEscolher(tipo){
  _gestaoTipo = tipo;
  $('gestao-menu').style.display = 'none';

  if(tipo === 'transf_int'){
    await _gestaoMontarTransfInterna();
    $('gestao-form-transf').style.display = '';
    return;
  }

  // Formulário de saída (alta/óbito/transf. externa)
  $('gestao-form-saida').style.display = '';
  const agora = new Date();
  sf('g-saida-data', hoje());
  sf('g-saida-hora', agora.getHours().toString().padStart(2,'0')+':'+agora.getMinutes().toString().padStart(2,'0'));
  sf('g-saida-obs','');
  sf('g-saida-destino','');
  sf('g-obito-causa','');

  const destWrap = $('g-saida-destino-wrap');
  const destLbl  = $('g-saida-destino-lbl');
  const obitoW   = $('g-obito-causa-wrap');
  const btn      = $('g-btn-confirmar');

  if(tipo === 'alta_hosp'){
    destWrap.style.display = 'none';
    obitoW.style.display = 'none';
    btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M2.5 8.5l3.5 3.5 7.5-7.5"/></svg> Confirmar alta hospitalar';
    btn.style.background = '#0a6b3a';
  } else if(tipo === 'alta_uti'){
    destWrap.style.display = '';
    destLbl.textContent = 'Unidade/setor de destino';
    sf('g-saida-destino','ENFERMARIA');
    obitoW.style.display = 'none';
    btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M2.5 8.5l3.5 3.5 7.5-7.5"/></svg> Confirmar alta da UTI';
    btn.style.background = '';
  } else if(tipo === 'obito'){
    destWrap.style.display = 'none';
    obitoW.style.display = '';
    btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M2.5 8.5l3.5 3.5 7.5-7.5"/></svg> Registrar óbito';
    btn.style.background = '#7a1020';
  } else if(tipo === 'transf_ext'){
    destWrap.style.display = '';
    destLbl.textContent = 'Hospital de destino';
    obitoW.style.display = 'none';
    btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M2.5 8.5l3.5 3.5 7.5-7.5"/></svg> Confirmar transferência';
    btn.style.background = '';
  }
}

async function _gestaoMontarTransfInterna(){
  const ld = await _getLeitos();
  const sel = $('g-transf-destino');
  sel.innerHTML = '<option value="">— Selecione —</option>';
  for(let i=1;i<=TOTAL_LEITOS;i++){
    if(i === _gestaoLeito) continue;
    const ocupado = ld[i] && ld[i].ocupado;
    const o = document.createElement('option');
    o.value = i;
    o.disabled = !!ocupado;
    o.textContent = `Leito ${pad(i)}` + (ocupado ? ` — OCUPADO (${(ld[i].pac||'').slice(0,30)})` : ' — Vazio');
    sel.appendChild(o);
  }
  sf('g-transf-motivo','');
}

async function confirmarSaidaLeito(){
  if(!_gestaoLeito || !_gestaoTipo) return;
  const tipo = _gestaoTipo;
  const leito = _gestaoLeito;
  const data = gf('g-saida-data') || hoje();
  const hora = gf('g-saida-hora') || '';
  const obs  = gf('g-saida-obs');
  const dest = gf('g-saida-destino');
  const causa= gf('g-obito-causa');

  if(tipo === 'obito' && !causa.trim()){
    toast('Informe a causa do óbito.', true); return;
  }
  if((tipo === 'alta_uti' || tipo === 'transf_ext') && !dest.trim()){
    toast('Informe o destino.', true); return;
  }

  const tipoLabel = {
    alta_hosp:'Alta hospitalar',
    alta_uti :'Alta da UTI para enfermaria/setor',
    obito    :'Óbito',
    transf_ext:'Transferência para outro hospital'
  }[tipo];

  if(!confirm(`Confirma ${tipoLabel} do paciente no Leito ${pad(leito)}?\n\nO leito ficará vazio e o histórico ficará disponível nos indicadores.`)) return;

  showLoading('Registrando saída...');
  try{
    const ld = await _getLeitos();
    const L = ld[leito] || {};
    const dataHora = data + (hora ? ('T'+hora) : '');

    // Log de saída — usado pelos indicadores
    const logKey = `uti_med_alta_log_${leito}_${data}`;
    await dbSet(logKey, {
      leito, tipo, tipoLabel,
      paciente: L.pac||'', dn: L.dn||'', sexo: L.sexo||'', cns: L.cns||'',
      diagnostico: L.diag||'', cid: L.cid||'',
      admUTI: L.adm||'', admHosp: L.admHosp||'',
      saida: data, saidaHora: hora, saidaDataHora: dataHora,
      destino: dest||'', observacoes: obs||'',
      causaObito: tipo === 'obito' ? causa : '',
      saps3: L.saps3||null,
      autor: usuarioEmail||'', autorNome: (perfilUsuario && perfilUsuario.nome) || usuarioEmail || '',
      registradoEm: new Date().toISOString()
    });

    // Libera o leito
    ld[leito] = { ocupado:false };
    await dbSet('uti_leitos', ld);

    // Apaga todos os dados clínicos do leito (prescrições, evoluções, guias, etc.)
    // Os logs de admissão e alta ficam preservados para os indicadores.
    try {
      const prefixosParaApagar = _PREFIXOS_LEITO.filter(p => p !== 'uti_med_adm_log_');
      const batchDel = [];
      for (const prefixo of prefixosParaApagar) {
        const chavePref = `${prefixo}${leito}_`;
        const regs = await dbListByPrefix(chavePref);
        for (const ch of Object.keys(regs)) batchDel.push(dbDelete(ch).catch(()=>{}));
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const k = localStorage.key(i);
          if (k && k.startsWith(chavePref)) localStorage.removeItem(k);
        }
      }
      await Promise.all(batchDel);
      // Zera variáveis em memória
      if (typeof _rxItens !== 'undefined') _rxItens = [];
      if (typeof _labLinhas !== 'undefined') _labLinhas = [];
      if (typeof _itensSAPS !== 'undefined') _itensSAPS = {};
      if (typeof _culturasForm !== 'undefined') _culturasForm = [];
      console.log('[Alta] Leito ' + leito + ': dados clínicos apagados (' + batchDel.length + ' chaves).');
    } catch(e){ console.warn('[Alta] limpeza de dados clínicos:', e); }

    hideLoading();
    fecharGestaoLeito();
    await renderLeitos();
    toast('<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M2.5 8.5l3.5 3.5 7.5-7.5"/></svg> '+tipoLabel+' registrada para o Leito '+pad(leito));
  } catch(e){
    hideLoading();
    console.error('confirmarSaidaLeito:', e);
    toast('Erro ao registrar: '+(e.message||e), true);
  }
}

async function confirmarTransferenciaInterna(){
  if(!_gestaoLeito) return;
  const origem = _gestaoLeito;
  const destino = parseInt(gf('g-transf-destino')||'0');
  const motivo = gf('g-transf-motivo');

  if(!destino){ toast('Selecione o leito de destino.', true); return; }
  if(destino === origem){ toast('Destino igual à origem.', true); return; }

  const ld = await _getLeitos();
  if(ld[destino] && ld[destino].ocupado){
    toast('Leito de destino já está ocupado.', true); return;
  }

  if(!confirm(`Transferir paciente do Leito ${pad(origem)} <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M3 8h10"/><path d="M9.5 4.5L13 8l-3.5 3.5"/></svg> Leito ${pad(destino)}?\n\nTodas as evoluções, prescrições, exames e imagens serão movidos.`)) return;

  showLoading('Transferindo paciente...');
  try{
    // 1. Move o registro do leito
    ld[destino] = Object.assign({}, ld[origem]);
    ld[origem] = { ocupado:false };
    await dbSet('uti_leitos', ld);

    // 2. Move todas as chaves prefixadas: substitui _<origem>_ por _<destino>_
    let movidas = 0;
    for(const prefixo of _PREFIXOS_LEITO){
      const chavePrefOrigem = `${prefixo}${origem}_`;
      const registros = await dbListByPrefix(chavePrefOrigem);
      for(const chaveOrig of Object.keys(registros)){
        const sufixo = chaveOrig.substring(chavePrefOrigem.length);
        const chaveDest = `${prefixo}${destino}_${sufixo}`;
        const valor = registros[chaveOrig];
        // Atualiza referência interna ao leito, se presente
        if(valor && typeof valor === 'object'){
          if('leito' in valor) valor.leito = destino;
        }
        await dbSet(chaveDest, valor);
        await dbDelete(chaveOrig);
        movidas++;
      }
    }

    // 3. Registra a transferência em log próprio
    const logKey = `uti_med_transf_log_${destino}_${hoje()}_${Date.now()}`;
    await dbSet(logKey, {
      origem, destino,
      paciente: (ld[destino] && ld[destino].pac) || '',
      motivo: motivo||'',
      chavesMovidas: movidas,
      data: hoje(),
      autor: usuarioEmail||'',
      autorNome: (perfilUsuario && perfilUsuario.nome) || usuarioEmail || '',
      registradoEm: new Date().toISOString()
    });

    hideLoading();
    fecharGestaoLeito();
    await renderLeitos();
    toast(`<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M2.5 8.5l3.5 3.5 7.5-7.5"/></svg> Paciente transferido: Leito ${pad(origem)} <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M3 8h10"/><path d="M9.5 4.5L13 8l-3.5 3.5"/></svg> Leito ${pad(destino)} (${movidas} registros movidos)`);
  } catch(e){
    hideLoading();
    console.error('confirmarTransferenciaInterna:', e);
    toast('Erro na transferência: '+(e.message||e), true);
  }
}

// ── IMAGENS DE EXAME ─────────────────────────────────────────────────────────
// Chave: uti_med_imgs_<leito>_<data>  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M3 8h10"/><path d="M9.5 4.5L13 8l-3.5 3.5"/></svg>  { imgs: [{b64, legenda, ts}] }
let _imgExameBuffer = [];
function _chaveImgs(leito, data){ return `uti_med_imgs_${leito}_${data}`; }

function _imgParaBase64(file, maxPx=1200, qualidade=0.75){
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onerror = rej;
    reader.onload = ev => {
      const img = new Image();
      img.onerror = rej;
      img.onload = () => {
        let w = img.width, h = img.height;
        if(w > maxPx || h > maxPx){
          if(w >= h){ h = Math.round(h * maxPx / w); w = maxPx; }
          else      { w = Math.round(w * maxPx / h); h = maxPx; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        res(canvas.toDataURL('image/jpeg', qualidade));
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function _renderImgGrid(){
  const grid = $('img-exame-grid');
  if(!grid) return;
  const addBtn = grid.querySelector('.img-exame-add');
  grid.innerHTML = '';
  _imgExameBuffer.forEach((item, idx) => {
    const temLaudo = !!(item.laudo && item.laudo.nome);
    const div = document.createElement('div');
    div.className = 'img-exame-item';
    div.title = item.legenda || '';
    div.innerHTML = `
      <img src="${item.b64}" alt="exame">
      <button class="img-exame-del" onclick="_imgExameRemover(${idx})" title="Remover">×</button>
      <button class="img-exame-laudo${temLaudo?' tem-laudo':''}" onclick="abrirModalLaudo(${idx})" title="${temLaudo?'Ver laudo anexado':'Anexar laudo'}">
        <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="2" width="10" height="12" rx="1"/><line x1="5.5" y1="5.5" x2="10.5" y2="5.5"/><line x1="5.5" y1="8" x2="10.5" y2="8"/><line x1="5.5" y1="10.5" x2="8.5" y2="10.5"/></svg>
        ${temLaudo?'Laudo ✓':'Laudo'}
      </button>`;
    div.querySelector('img').addEventListener('click', () => _abrirLightbox(item.b64));
    grid.appendChild(div);
  });
  if(addBtn) grid.appendChild(addBtn);
}

function _abrirLightbox(src){
  const lb = $('lightbox');
  if(!lb) return;
  $('lightbox-img').src = src;
  lb.classList.add('show');
}

async function _imgExameAdicionar(input){
  const files = (input && input.files) ? Array.from(input.files) : [];
  if(!files.length) return;
  await _imgExameProcessarArquivos(files);
  if(input) input.value = '';
}

async function _imgExameProcessarArquivos(files){
  const status = $('img-exame-status');
  if(status){ status.textContent = 'Processando imagens...'; status.style.display=''; }
  for(const file of files){
    if(!file.type || !file.type.startsWith('image/')) continue;
    try{
      const b64 = await _imgParaBase64(file);
      _imgExameBuffer.push({ b64, legenda: file.name, ts: new Date().toISOString() });
    } catch(e){ toast('Erro ao processar ' + file.name, true); }
  }
  _renderImgGrid();
  if(status){ status.textContent = `${_imgExameBuffer.length} imagem(ns) anexada(s) — serão salvas com a evolução`; }
}

function _imgExameRemover(idx){
  _imgExameBuffer.splice(idx, 1);
  _renderImgGrid();
  const status = $('img-exame-status');
  if(status && _imgExameBuffer.length === 0){ status.style.display='none'; }
  else if(status){ status.textContent = `${_imgExameBuffer.length} imagem(ns) anexada(s)`; }
}

// Habilita drag & drop na grade (PC)
function _imgExameAtivarDragDrop(){
  const grid = $('img-exame-grid');
  const add  = grid ? grid.querySelector('.img-exame-add') : null;
  if(!grid || !add || grid.dataset.ddBound) return;
  grid.dataset.ddBound = '1';
  const stop = e => { e.preventDefault(); e.stopPropagation(); };
  ['dragenter','dragover'].forEach(ev => grid.addEventListener(ev, e => { stop(e); add.classList.add('drag-over'); }));
  ['dragleave','drop'].forEach(ev => grid.addEventListener(ev, e => { stop(e); add.classList.remove('drag-over'); }));
  grid.addEventListener('drop', async e => {
    const files = Array.from(e.dataTransfer.files || []);
    if(files.length) await _imgExameProcessarArquivos(files);
  });
}

async function _carregarImgsExame(leito, data){
  _imgExameBuffer = [];
  const chave = _chaveImgs(leito, data);
  try{
    const dado = await dbGet(chave);
    if(dado && Array.isArray(dado.imgs)) _imgExameBuffer = dado.imgs;
  } catch(e){ console.warn('_carregarImgsExame:', e); }
  _renderImgGrid();
  _imgExameAtivarDragDrop();
  const status = $('img-exame-status');
  if(status){
    if(_imgExameBuffer.length) { status.textContent = `${_imgExameBuffer.length} imagem(ns) salva(s)`; status.style.display=''; }
    else { status.style.display='none'; }
  }
}

async function _salvarImgsExame(leito, data){
  if(!_imgExameBuffer.length) return;
  const chave = _chaveImgs(leito, data);
  await dbSet(chave, { imgs: _imgExameBuffer, leito, data, atualizadoEm: new Date().toISOString() });
}

/* ============================================================================
   LAUDOS — IndexedDB local (binário) + metadados no Firestore (nome/data)
   Chave IDB:  laudo_<leito>_<data>_<idx>
   Metadado:   salvo dentro de _imgExameBuffer[idx].laudo  →  Firestore
   ============================================================================ */

/* — IndexedDB: abre / cria banco —————————————————————————————————————————— */
let _idbPromise = null;
function _idbAbrir(){
  if(_idbPromise) return _idbPromise;
  _idbPromise = new Promise((res, rej) => {
    const req = indexedDB.open('hospesc_laudos', 1);
    req.onupgradeneeded = e => { e.target.result.createObjectStore('laudos'); };
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
  return _idbPromise;
}
async function _idbSalvar(chave, blob){
  const db = await _idbAbrir();
  return new Promise((res, rej) => {
    const tx = db.transaction('laudos', 'readwrite');
    tx.objectStore('laudos').put(blob, chave);
    tx.oncomplete = () => res(true);
    tx.onerror    = e  => rej(e.target.error);
  });
}
async function _idbLer(chave){
  const db = await _idbAbrir();
  return new Promise((res, rej) => {
    const tx = db.transaction('laudos', 'readonly');
    const req = tx.objectStore('laudos').get(chave);
    req.onsuccess = e => res(e.target.result || null);
    req.onerror   = e => rej(e.target.error);
  });
}
async function _idbRemover(chave){
  const db = await _idbAbrir();
  return new Promise((res, rej) => {
    const tx = db.transaction('laudos', 'readwrite');
    tx.objectStore('laudos').delete(chave);
    tx.oncomplete = () => res(true);
    tx.onerror    = e  => rej(e.target.error);
  });
}

function _chaveLaudo(leito, data, idx){ return `laudo_${leito}_${data}_${idx}`; }

/* — Estado do modal ———————————————————————————————————————————————————————— */
let _laudoIdxAtual   = null;
let _laudoLeitoAtual = null;
let _laudoDataAtual  = null;

/* — Abre modal de laudo ———————————————————————————————————————————————————— */
async function abrirModalLaudo(idx){
  _laudoIdxAtual   = idx;
  _laudoLeitoAtual = gf('f-leito') || leitoAtual;
  _laudoDataAtual  = gf('f-data')  || hoje();

  const item = _imgExameBuffer[idx] || {};
  const meta  = item.laudo || null;

  const elTit = $('laudo-titulo');
  if(elTit) elTit.textContent = 'Laudo — ' + (item.legenda || `Imagem ${idx+1}`);

  const elMeta = $('laudo-meta');
  if(elMeta){
    if(meta){
      const dt = meta.dataAnexo ? new Date(meta.dataAnexo).toLocaleString('pt-BR') : '—';
      const sz = meta.tamanho ? (meta.tamanho/1024).toFixed(0)+' KB' : '';
      elMeta.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.12em;"><path d="M2.5 8.5l3.5 3.5 7.5-7.5" stroke="#2e7d32"/></svg> <b>${meta.nome||'Laudo'}</b> \xb7 ${sz} \xb7 anexado em ${dt}`;
      elMeta.style.color = '#2e7d32';
    } else {
      elMeta.textContent = 'Nenhum laudo anexado ainda.';
      elMeta.style.color = 'var(--muted)';
    }
  }

  await _laudoCarregarVisualizacao();
  $('modal-laudo').classList.add('show');
}

/* — Carrega binário do IDB e exibe no iframe ——————————————————————————————— */
async function _laudoCarregarVisualizacao(){
  const chave     = _chaveLaudo(_laudoLeitoAtual, _laudoDataAtual, _laudoIdxAtual);
  const elViewer  = $('laudo-viewer');
  const elAviso   = $('laudo-aviso-local');
  const elBtnDl   = $('laudo-btn-download');
  const elBtnRem  = $('laudo-btn-remover');
  const item = _imgExameBuffer[_laudoIdxAtual] || {};
  const meta  = item.laudo || null;

  if(elViewer) { elViewer.src = 'about:blank'; elViewer.style.display='none'; }
  if(elAviso)  elAviso.style.display = 'none';
  if(elBtnDl)  elBtnDl.style.display = 'none';
  if(elBtnRem) elBtnRem.style.display = 'none';

  try {
    const blob = await _idbLer(chave);
    if(blob){
      const url = URL.createObjectURL(blob);
      if(elViewer){ elViewer.src = url; elViewer.style.display = ''; }
      if(elBtnDl){
        elBtnDl.style.display = '';
        elBtnDl.onclick = () => {
          const a = document.createElement('a');
          a.href = url; a.download = (meta && meta.nome) || 'laudo.pdf'; a.click();
        };
      }
      if(elBtnRem) elBtnRem.style.display = '';
    } else if(meta){
      if(elAviso){
        elAviso.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg>
          Laudo <b>${meta.nome||''}</b> foi anexado em outro computador. O arquivo n\xe3o est\xe1 dispon\xedvel neste navegador.`;
        elAviso.style.display = '';
      }
    }
  } catch(e){ console.warn('_laudoCarregarVisualizacao:', e); }
}

/* — Upload do laudo ———————————————————————————————————————————————————————— */
async function _laudoUpload(input){
  const file = input && input.files && input.files[0];
  if(!file) return;
  const permitidos = ['application/pdf','image/jpeg','image/png','image/tiff','image/webp'];
  if(!permitidos.includes(file.type)){ toast('Formato n\xe3o suportado. Use PDF, JPG, PNG ou TIFF.', true); return; }
  if(file.size > 20*1024*1024){ toast('Arquivo muito grande (m\xe1ximo 20 MB).', true); return; }

  showLoading('Salvando laudo...');
  try {
    const chave = _chaveLaudo(_laudoLeitoAtual, _laudoDataAtual, _laudoIdxAtual);
    await _idbSalvar(chave, file);

    if(_imgExameBuffer[_laudoIdxAtual]){
      _imgExameBuffer[_laudoIdxAtual].laudo = {
        nome: file.name, tamanho: file.size, tipo: file.type,
        dataAnexo: new Date().toISOString()
      };
    }
    await _salvarImgsExame(_laudoLeitoAtual, _laudoDataAtual);

    hideLoading();
    toast('\u2713 Laudo salvo localmente.');
    if(input) input.value = '';
    await _laudoCarregarVisualizacao();
    _renderImgGrid();

    const meta = (_imgExameBuffer[_laudoIdxAtual]||{}).laudo;
    const elMeta = $('laudo-meta');
    if(elMeta && meta){
      const dt = new Date(meta.dataAnexo).toLocaleString('pt-BR');
      const sz = (meta.tamanho/1024).toFixed(0)+' KB';
      elMeta.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.12em;"><path d="M2.5 8.5l3.5 3.5 7.5-7.5" stroke="#2e7d32"/></svg> <b>${meta.nome}</b> \xb7 ${sz} \xb7 anexado em ${dt}`;
      elMeta.style.color = '#2e7d32';
    }
  } catch(e){
    hideLoading(); console.error('_laudoUpload:', e);
    toast('Erro ao salvar laudo: '+e.message, true);
  }
}

/* — Remove laudo ——————————————————————————————————————————————————————————— */
async function _laudoRemover(){
  if(!confirm('Remover o laudo deste exame? O arquivo ser\xe1 apagado deste navegador.')) return;
  showLoading('Removendo laudo...');
  try {
    const chave = _chaveLaudo(_laudoLeitoAtual, _laudoDataAtual, _laudoIdxAtual);
    await _idbRemover(chave);
    if(_imgExameBuffer[_laudoIdxAtual]) delete _imgExameBuffer[_laudoIdxAtual].laudo;
    await _salvarImgsExame(_laudoLeitoAtual, _laudoDataAtual);
    hideLoading();
    toast('Laudo removido.');
    await _laudoCarregarVisualizacao();
    _renderImgGrid();
    const elMeta = $('laudo-meta');
    if(elMeta){ elMeta.textContent = 'Nenhum laudo anexado ainda.'; elMeta.style.color = 'var(--muted)'; }
  } catch(e){
    hideLoading(); toast('Erro ao remover: '+e.message, true);
  }
}

function fecharModalLaudo(){
  $('modal-laudo').classList.remove('show');
  const v = $('laudo-viewer');
  if(v){ URL.revokeObjectURL(v.src); v.src='about:blank'; }
  _laudoIdxAtual = null;
}

/* ════════════════════════════════════════════════════════════════════════════
   LAUDO AVULSO — independente de imagem, vinculado ao leito+data
   IDB key: laudo_avulso_<leito>_<data>
   Metadado: uti_med_laudoavulso_<leito>_<data>  (Firestore — só metadado)
   ════════════════════════════════════════════════════════════════════════════ */
function _chaveLaudoAvulso(leito, data){ return `laudo_avulso_${leito}_${data}`; }

function abrirLaudoAvulso(){
  $('laudo-avulso-input').value = '';
  $('laudo-avulso-input').click();
}

async function _laudoAvulsoUpload(input){
  const file = input && input.files && input.files[0];
  if(!file) return;
  const permitidos = ['application/pdf','image/jpeg','image/png','image/tiff','image/webp'];
  if(!permitidos.includes(file.type)){ toast('Formato não suportado. Use PDF, JPG ou PNG.', true); return; }
  if(file.size > 20*1024*1024){ toast('Arquivo muito grande (máximo 20 MB).', true); return; }

  const leito = leitoAtual;
  const data  = gf('f-data') || hoje();
  showLoading('Salvando laudo...');
  try{
    const chave = _chaveLaudoAvulso(leito, data);
    await _idbSalvar(chave, file);
    const meta = { nome: file.name, tamanho: file.size, tipo: file.type, dataAnexo: new Date().toISOString() };
    await dbSet(`uti_med_laudoavulso_${leito}_${data}`, meta);
    hideLoading();
    toast('✓ Laudo salvo.');
    _laudoAvulsoAtualizarUI(meta);
    if(input) input.value = '';
  }catch(e){ hideLoading(); toast('Erro ao salvar laudo: '+e.message, true); }
}

async function _laudoAvulsoCarregar(leito, data){
  try{
    const meta = await dbGet(`uti_med_laudoavulso_${leito}_${data}`);
    _laudoAvulsoAtualizarUI(meta || null);
  }catch(e){ _laudoAvulsoAtualizarUI(null); }
}

function _laudoAvulsoAtualizarUI(meta){
  const btnRem  = $('btn-laudo-avulso-rem');
  const elMeta  = $('laudo-avulso-meta');
  const btnAnex = $('btn-laudo-avulso');
  if(!elMeta || !btnRem || !btnAnex) return;
  if(meta && meta.nome){
    const sz  = (meta.tamanho/1024).toFixed(0)+' KB';
    const dt  = meta.dataAnexo ? new Date(meta.dataAnexo).toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}) : '';
    elMeta.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="#15803d" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8.5l3.5 3.5 7.5-7.5"/></svg> <strong>${meta.nome}</strong> · ${sz} · ${dt}`;
    elMeta.style.color = '#15803d';
    elMeta.style.display = '';
    btnRem.style.display = '';
    btnAnex.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2h6l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z"/><path d="M10 2v4h4"/></svg> Laudo ✓ (ver / substituir)`;
    btnAnex.onclick = _laudoAvulsoVisualizar;
  } else {
    elMeta.style.display = 'none';
    btnRem.style.display = 'none';
    btnAnex.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2h6l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z"/><path d="M10 2v4h4"/></svg> Anexar laudo (PDF)`;
    btnAnex.onclick = abrirLaudoAvulso;
  }
}

async function _laudoAvulsoVisualizar(){
  const leito = leitoAtual;
  const data  = gf('f-data') || hoje();
  const chave = _chaveLaudoAvulso(leito, data);
  showLoading('Abrindo laudo...');
  try{
    const blob = await _idbLer(chave);
    hideLoading();
    if(!blob){ toast('Laudo não disponível neste navegador.', true); return; }
    const url = URL.createObjectURL(blob);
    // Reutiliza o modal de laudo existente em modo avulso
    $('laudo-titulo').textContent = 'Laudo do Exame';
    const meta = await dbGet(`uti_med_laudoavulso_${leito}_${data}`);
    const elMeta = $('laudo-meta');
    if(elMeta && meta){
      const sz = (meta.tamanho/1024).toFixed(0)+' KB';
      elMeta.innerHTML = `<strong>${meta.nome}</strong> · ${sz}`;
      elMeta.style.color = '#15803d';
    }
    const viewer = $('laudo-viewer');
    if(viewer){ viewer.src = url; viewer.style.display = ''; }
    const btnDl = $('laudo-btn-download');
    if(btnDl){ btnDl.style.display = ''; btnDl.onclick = ()=>{ const a=document.createElement('a'); a.href=url; a.download=(meta&&meta.nome)||'laudo.pdf'; a.click(); }; }
    // Oculta botão de remover do modal (usa o da seção)
    const btnRem = $('laudo-btn-remover');
    if(btnRem) btnRem.style.display = 'none';
    // Desabilita o "Anexar / Substituir laudo" do modal (não é por índice de imagem)
    const btnAnex = document.querySelector('#modal-laudo .btn-pri');
    if(btnAnex) btnAnex.style.display = 'none';
    $('laudo-aviso-local').style.display = 'none';
    $('modal-laudo').classList.add('show');
  }catch(e){ hideLoading(); toast('Erro ao abrir laudo: '+e.message, true); }
}

async function removerLaudoAvulso(){
  if(!confirm('Remover o laudo? O arquivo será apagado deste navegador.')) return;
  const leito = leitoAtual;
  const data  = gf('f-data') || hoje();
  showLoading('Removendo...');
  try{
    await _idbRemover(_chaveLaudoAvulso(leito, data));
    await dbSet(`uti_med_laudoavulso_${leito}_${data}`, null);
    hideLoading();
    toast('Laudo removido.');
    _laudoAvulsoAtualizarUI(null);
  }catch(e){ hideLoading(); toast('Erro: '+e.message, true); }
}

function mostrarTela(id){
  document.querySelectorAll('.tela').forEach(t=>{ t.classList.remove('ativa'); t.style.display='none'; });
  ['t-login','t-turno'].forEach(x=>{ const e=$(x); if(e) e.style.display='none'; });
  const el = $(id);
  if(el){ el.style.display='flex'; el.classList.add('ativa'); }
}
function showLoading(t){ const o=$('loading-overlay'); $('loading-txt').textContent=t||'Carregando...'; o.classList.add('show'); }
function hideLoading(){ $('loading-overlay').classList.remove('show'); }
function toast(msg,err=false){ const t=$('toast'); t.innerHTML=msg; t.className='toast'+(err?' err':''); t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),3200); }
function fecharModal(){ $('modal-adm').classList.remove('show'); }

/* ── LOGO — usa logo.png do repositório; cai no SVG se a imagem faltar ─── */
function _logoImg(size){
  const s = size||120;
  return `<img src="logo.png" alt="Hospital dos Pescadores" `+
    `style="max-width:${s}px;width:100%;height:auto;display:block;margin:0 auto;" `+
    `onerror="this.onerror=null;this.outerHTML=_logoSVG(${s});">`;
}
function _logoSVG(size){
  const s = size||120;
  // Apenas o ícone (cruz médica em quadrado azul) — o nome do hospital
  // já é renderizado pelo h1 abaixo na tela de login/turno.
  return `<svg width="${Math.round(s*0.5)}" height="${Math.round(s*0.5)}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" style="display:block;margin:0 auto;">
    <defs>
      <linearGradient id="hlg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#1e6bbf"/>
        <stop offset="100%" stop-color="#0a3d6b"/>
      </linearGradient>
    </defs>
    <rect x="2" y="2" width="96" height="96" rx="14" fill="url(#hlg)"/>
    <path d="M50 24 v52 M24 50 h52" stroke="#fff" stroke-width="10" stroke-linecap="round"/>
  </svg>`;
}

/* ════════════════════════════════════════════════════════════════════════════
   FIREBASE
   ════════════════════════════════════════════════════════════════════════════ */
function initFirebase(){
  const cfg = window.FIREBASE_CONFIG || {};
  if(!cfg.apiKey || !cfg.projectId){ return false; }
  try{
    if(!firebase.apps.length) firebase.initializeApp(cfg);
    db   = firebase.firestore();
    auth = firebase.auth();
    console.log('[Firebase] inicializado · UTI Médica');
    return true;
  }catch(e){ console.error('Firebase init falhou:',e); return false; }
}

// Acesso ao "documento único" (objetos como uti_leitos) e a docs por chave.
async function dbGet(key){
  if(_modoOffline || !db){ const v=localStorage.getItem(key); return v?JSON.parse(v):null; }
  try{
    const snap = await db.collection('uti_med_kv').doc(key).get();
    return snap.exists ? snap.data().value : null;
  }catch(e){ const v=localStorage.getItem(key); return v?JSON.parse(v):null; }
}
async function dbSet(key,value){
  localStorage.setItem(key, JSON.stringify(value)); // cache local sempre
  if(_modoOffline || !db) return;
  try{ await db.collection('uti_med_kv').doc(key).set({value, updatedAt:new Date().toISOString()}); }
  catch(e){ console.warn('dbSet falhou (mantido local):',key,e&&e.code); }
}
async function dbDelete(key){
  localStorage.removeItem(key);
  if(_modoOffline || !db) return;
  try{ await db.collection('uti_med_kv').doc(key).delete(); }catch(e){}
}
// Lista chaves por prefixo (Firestore + localStorage combinados).
async function dbListByPrefix(prefix){
  const out = {};
  // localStorage
  for(let i=0;i<localStorage.length;i++){
    const k=localStorage.key(i);
    if(k && k.startsWith(prefix)){ try{ out[k]=JSON.parse(localStorage.getItem(k)); }catch(_){} }
  }
  // Firestore
  if(!_modoOffline && db){
    try{
      const snap = await db.collection('uti_med_kv')
        .where(firebase.firestore.FieldPath.documentId(),'>=',prefix)
        .where(firebase.firestore.FieldPath.documentId(),'<',prefix+'\uf8ff').get();
      snap.forEach(d=>{ out[d.id]=d.data().value; });
    }catch(e){ console.warn('dbListByPrefix:',e&&e.code); }
  }
  return out;
}

/* ── PERFIS ───────────────────────────────────────────────────────────────── */
function _perfilSeed(email){
  const s = PERFIS_SEED[email];
  return { email, nome: s?s.nome:email.split('@')[0].toUpperCase(), crm: s?s.crm:'',
    role: ADMIN_EMAILS.includes(email)?'admin':'medico', ativo:true, senhaTrocada:true };
}
async function _carregarPerfil(email){
  email=(email||'').trim().toLowerCase();
  if(!email) return null;
  if(!db) return _perfilSeed(email);
  const comTimeout=(p,ms)=>Promise.race([p,new Promise((_,r)=>setTimeout(()=>r(new Error('timeout')),ms))]);
  try{
    const ref=db.collection('usuarios_med').doc(email);
    const snap=await comTimeout(ref.get(),8000);
    if(snap.exists) return {email,...snap.data()};
    const novo=_perfilSeed(email);
    ref.set({nome:novo.nome,crm:novo.crm,role:novo.role,ativo:true,senhaTrocada:true,criadoEm:new Date().toISOString()}).catch(()=>{});
    return novo;
  }catch(e){ return _perfilSeed(email); }
}
const _cachePerfis={};
function _registrarCachePerfil(p){ if(p&&p.email) _cachePerfis[p.email.toLowerCase()]={nome:p.nome,crm:p.crm}; }
function _atualizarBadgeUser(){
  const b=$('badge-turno-leitos'); if(b&&perfilUsuario) b.textContent=perfilUsuario.nome||usuarioEmail;
  const g=$('btn-gerenciar-usuarios'); if(g) g.style.display=_isAdmin()?'inline-block':'none';
}

/* ════════════════════════════════════════════════════════════════════════════
   SAPS 3 — MOTOR DE CÁLCULO
   ─ Tabela de pontos: Moreno RP et al., Intensive Care Med 2005;31:1345-1355.
   ─ Calibração: América Central/Sul (recomendada AMIB p/ Brasil) + equação global.
   ─ Itens fisiológicos: derivados da evolução. Itens de admissão: manuais.
   ════════════════════════════════════════════════════════════════════════════ */
const SAPS3 = {
  // BOX I — características prévias
  idade(a){ if(a==null) return 0; if(a<40) return 0; if(a<60) return 5; if(a<70) return 9; if(a<75) return 13; if(a<80) return 15; return 18; },
  // tempo de permanência hospitalar antes da UTI (dias)
  preInternacao(d){ if(d==null) return 0; if(d<14) return 0; if(d<28) return 6; return 7; },
  // local antes da UTI
  localPrevio(v){ return ({'enfermaria':8,'outros':8,'outra_uti':5,'emergencia':0,'centro_cirurgico':0,'sala_recup':0}[v])||0; },
  // comorbidades (somam)
  comorbidades(c){
    let p=0; c=c||{};
    if(c.cancerTerapia) p+=3;
    if(c.icc4) p+=6;            // IC NYHA IV
    if(c.cancerHemato) p+=6;    // câncer hematológico
    if(c.cirrose) p+=8;
    if(c.cancerMeta) p+=11;     // câncer metastático
    if(c.aids) p+=8;
    return p;
  },
  vasoativaPrevia(b){ return b?3:0; },
  // BOX II — circunstâncias da admissão
  admissaoTipo(v){ return ({'nao_planejada':3,'planejada':0})[v]||0; },
  motivoAdmissao(m){
    // pontos dos motivos (somam quando coexistem)
    let p=0; m=m||{};
    if(m.coma) p+=4;             // coma/torpor/obnubilação/estupor
    if(m.arritmia) p+=0;
    if(m.choqueHipovol) p+=3;
    if(m.choqueSeptico) p+=5;
    if(m.choqueAnafilatico||m.choqueMisto) p+=3;
    if(m.efeitoMassa) p+=10;     // efeito de massa cerebral
    if(m.convulsao) p+=(-4<0?0:0); // convulsão isolada: ver focal abaixo
    if(m.focalNeuro) p+=7;
    if(m.pancreatite) p+=0;
    return p;
  },
  cirurgia(v){ return ({'nao_cirurgico':5,'urgente':6,'programada':0})[v]||0; },
  localCirurgia(v){
    return ({'transplante':-8,'trauma':-8,'cardiaca':-6,'neuro_avc':5,'outras_cir':0})[v]||0;
  },
  infeccaoNoso(b){ return b?11:0; },
  infeccaoResp(b){ return b?5:0; },
  // BOX III — fisiologia aguda
  glasgow(g){ if(g==null) return 0; if(g>=13) return 0; if(g>=7&&g<=12) return 2; if(g===6) return 7; if(g===5) return 13; return 15; }, // 3-4
  pas(v){ if(v==null) return 0; if(v<40) return 11; if(v<70) return 8; if(v<120) return 3; return 0; }, // ≥120
  fc(v){ if(v==null) return 0; if(v<120) return 0; if(v<160) return 5; return 7; },
  temp(v){ if(v==null) return 0; return v<35 ? 7 : 0; }, // <35°C
  // oxigenação: se VMI usa PaO2/FiO2; senão usa PaO2 isolada
  oxigenacao(pao2,fio2,emVMI){
    if(emVMI){
      if(pao2==null||!fio2) return 0;
      const pf = pao2/fio2;
      return pf<100 ? 11 : 7; // <100 = 11 ; ≥100 (com VM) = 7
    } else {
      if(pao2==null) return 0;
      return pao2<60 ? 5 : 0;
    }
  },
  bilirrubina(v){ if(v==null) return 0; if(v<2) return 0; if(v<6) return 4; return 5; },
  creatinina(v){ if(v==null) return 0; if(v<1.2) return 0; if(v<2) return 2; if(v<3.5) return 7; return 8; },
  leucocitos(v){ if(v==null) return 0; return v<15 ? 0 : 2; }, // ×10³/mm³ ; <15000 = 0
  ph(v){ if(v==null) return 0; return v<=7.25 ? 3 : 0; },
  plaquetas(v){ if(v==null) return 0; if(v<20) return 13; if(v<50) return 8; if(v<100) return 5; return 0; }, // ×10³
};

// Idade a partir da data de nascimento
function _idadeDeDN(dn){
  if(!dn) return null;
  const d=new Date(dn); if(isNaN(d)) return null;
  const hj=new Date(); let a=hj.getFullYear()-d.getFullYear();
  const m=hj.getMonth()-d.getMonth();
  if(m<0||(m===0&&hj.getDate()<d.getDate())) a--;
  return a;
}

// Calcula o SAPS 3 a partir dos dados do formulário + itens de admissão manuais.
function calcularSAPS3(dados){
  const it = dados.itensSAPS || {};
  const idade = dados.idade!=null ? dados.idade : _idadeDeDN(dados.dn);
  const emVMI = dados.vent==='VMI';

  const partes = {
    'Idade': SAPS3.idade(idade),
    'Internação pré-UTI': SAPS3.preInternacao(it.preDias!=null?Number(it.preDias):null),
    'Local antes da UTI': SAPS3.localPrevio(it.localPrevio),
    'Comorbidades': SAPS3.comorbidades(it.comorb),
    'Vasoativa pré-UTI': SAPS3.vasoativaPrevia(!!it.vasoPrevia),
    'Tipo de admissão': SAPS3.admissaoTipo(it.admTipo),
    'Motivo de admissão': SAPS3.motivoAdmissao(it.motivo),
    'Status cirúrgico': SAPS3.cirurgia(it.cirurgia),
    'Local da cirurgia': SAPS3.localCirurgia(it.localCir),
    'Infecção nosocomial': SAPS3.infeccaoNoso(!!it.infNoso),
    'Infecção respiratória': SAPS3.infeccaoResp(!!it.infResp),
    'Glasgow': SAPS3.glasgow(dados.glasgow),
    'PA sistólica': SAPS3.pas(dados.pas),
    'Freq. cardíaca': SAPS3.fc(dados.fc),
    'Temperatura': SAPS3.temp(dados.tmax),
    'Oxigenação': SAPS3.oxigenacao(dados.pao2, dados.fio2, emVMI),
    'Bilirrubina': SAPS3.bilirrubina(dados.bilirrubina),
    'Creatinina': SAPS3.creatinina(dados.creatinina),
    'Leucócitos': SAPS3.leucocitos(dados.leucocitos),
    'pH arterial': SAPS3.ph(dados.ph),
    'Plaquetas': SAPS3.plaquetas(dados.plaquetas),
  };
  let soma = 0; Object.values(partes).forEach(v=>soma+=v);
  // offset de 16 pontos (evita escores negativos) — convenção SAPS 3
  const score = soma + 16;

  // Mortalidade prevista
  const mortGlobal = _mortSAPS(score, 'global');
  const mortCSA    = _mortSAPS(score, 'csa');

  return { score, partes, mortGlobal, mortCSA, temDados: _temDadosSAPS(dados,it) };
}

function _mortSAPS(score, eq){
  let logit;
  if(eq==='csa'){ // Central-South America (intercepto negativo)
    logit = -64.5990 + Math.log(score + 71.0599) * 13.2322;
  } else { // global / standard equation (Moreno 2005)
    logit = -32.6659 + Math.log(score + 20.5958) * 7.3068;
  }
  return Math.exp(logit) / (1 + Math.exp(logit));
}
function _temDadosSAPS(d,it){
  // Exige apenas a idade (DN) + ao menos 1 item preenchido (fisiológico OU admissão)
  const temIdade = d.idade!=null || !!d.dn;
  const temFisio = [d.glasgow,d.pas,d.fc,d.tmax,d.creatinina,d.plaquetas].some(x=>x!=null);
  const temAdmissao = it && Object.keys(it).some(k=>it[k]!=null&&it[k]!==''&&it[k]!==false&&!(Array.isArray(it[k])&&!it[k].length));
  return temIdade && (temFisio || temAdmissao);
}

// Recalcula e atualiza a UI do SAPS no formulário (chamado a cada input relevante)
function _recalcSAPS(){
  const dados = _coletarDadosSAPS();
  const r = calcularSAPS3(dados);
  $('saps-num').textContent = r.score;
  if(r.temDados){
    $('saps-mort').textContent = (r.mortCSA*100).toFixed(1)+'%';
    const temFisio=[_coletarDadosSAPS().glasgow,_coletarDadosSAPS().pas,_coletarDadosSAPS().fc].some(x=>x!=null);
    $('saps-mort-glob').innerHTML = 'Equação global: '+(r.mortGlobal*100).toFixed(1)+'%'+(temFisio?'':' <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> score parcial — preencha os dados fisiológicos para maior precisão');
  } else {
    $('saps-mort').textContent = '—';
    $('saps-mort-glob').textContent = 'Preencha a data de nascimento e ao menos um dado clínico.';
  }
  // breakdown
  let h='<div style="border:1px solid var(--borda);border-radius:8px;overflow:hidden;">';
  Object.entries(r.partes).forEach(([k,v])=>{
    if(v!==0) h+=`<div class="saps-bd-row"><span>${k}</span><span>${v>0?'+':''}${v}</span></div>`;
  });
  h+=`<div class="saps-bd-row" style="background:var(--vinho-claro);"><span>Offset base</span><span>+16</span></div>`;
  h+=`<div class="saps-bd-row" style="font-weight:800;"><span>TOTAL</span><span>${r.score}</span></div>`;
  h+='</div>';
  $('saps-breakdown').innerHTML=h;
  return r;
}

// Mostra/oculta campo de especificação de DVA conforme seleção
function _toggleDVAcampo(){
  const wrap = $('f-dva-campo-wrap');
  if(!wrap) return;
  const val = gf('f-dva');
  wrap.style.display = (val === 'SIM') ? '' : 'none';
  if(val !== 'SIM'){ sf('f-dva-qual',''); }
}

function _coletarDadosSAPS(){
  const num = id => { const v=gf(id); return v===''?null:Number(v); };
  // Fisiológicos da evolução (campos do formulário)
  const evol = {
    glasgow: num('f-glasgow'),
    pas:     num('f-pas'),
    fc:      num('f-fc'),
    tmax:    num('f-tmax'),
    pao2:    num('f-pao2'),
    fio2:    num('f-fio2'),
    ph:      num('f-ph'),
    vent:    gf('f-vent'),
  };
  // Fisiológicos do modal de admissão (fallback)
  const adm = _itensSAPS.fisiologicos || {};
  // Prefere a evolução; se vazio, usa o valor do modal
  const pick = (eKey, aKey) => evol[eKey] != null ? evol[eKey] : (adm[aKey||eKey] ?? null);
  return {
    dn:    gf('f-dn'),
    idade: _idadeDeDN(gf('f-dn')),
    glasgow: pick('glasgow'),
    pas:     pick('pas'),
    fc:      pick('fc'),
    tmax:    pick('tmax'),
    pao2:    pick('pao2'),
    fio2:    pick('fio2'),
    ph:      pick('ph'),
    vent:    (evol.vent && evol.vent!=='') ? evol.vent : (adm.vent || ''),
    // Laboratoriais: da última linha de exames, fallback para o modal
    ...(()=>{
      const labDeriv = _labDerivadosParaSAPS();
      return {
        bilirrubina: labDeriv.bilirrubina ?? adm.bilirrubina ?? null,
        creatinina:  labDeriv.creatinina  ?? adm.creatinina  ?? null,
        leucocitos:  labDeriv.leucocitos  ?? adm.leucocitos  ?? null,
        plaquetas:   labDeriv.plaquetas   ?? adm.plaquetas   ?? null,
      };
    })(),
    itensSAPS: _itensSAPS
  };
}

// Pega creatinina/bilirrubina/leucócitos/plaquetas da linha de exame mais recente
function _labDerivadosParaSAPS(){
  if(!_labLinhas.length) return {};
  const ordenadas = [..._labLinhas].sort((a,b)=>(a.data||'').localeCompare(b.data||''));
  const ult = ordenadas[ordenadas.length-1].valores||{};
  const n = v => (v===''||v==null)?null:Number(v);
  return {
    creatinina: n(ult.cr),
    bilirrubina: n(ult.bt),
    leucocitos: ult.leu!=null&&ult.leu!=='' ? Number(ult.leu)/1000 : null, // espera valor absoluto <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M3 8h10"/><path d="M9.5 4.5L13 8l-3.5 3.5"/></svg> ×10³
    plaquetas: ult.plaq!=null&&ult.plaq!=='' ? Number(ult.plaq) : null      // já em ×10³ (ex: 210 = 210mil)
  };
}

/* ════════════════════════════════════════════════════════════════════════════
   AUTENTICAÇÃO & LOGIN
   ════════════════════════════════════════════════════════════════════════════ */
async function fazerLogin(){
  const email=gf('li-email').trim().toLowerCase(), senha=gf('li-senha');
  const err=$('login-err'), btn=$('btn-entrar');
  err.textContent='';
  if(!email||!senha){ err.textContent='Preencha e-mail e senha.'; return; }
  if(!auth){ err.textContent='Firebase não configurado.'; return; }
  btn.disabled=true; btn.textContent='Entrando...';
  try{
    await auth.signInWithEmailAndPassword(email,senha);
    // onAuthStateChanged cuida do resto
  }catch(e){
    const map={'auth/invalid-credential':'E-mail ou senha incorretos.','auth/user-not-found':'Usuário não cadastrado.',
      'auth/wrong-password':'Senha incorreta.','auth/too-many-requests':'Muitas tentativas. Aguarde.','auth/invalid-email':'E-mail inválido.'};
    err.textContent=map[e.code]||('Erro: '+(e.message||e.code));
  }finally{ btn.disabled=false; btn.textContent='Entrar'; }
}
function fazerLogout(){
  if(auth) auth.signOut();
  sessionStorage.removeItem('uti_med_auth');
  usuarioEmail=null; perfilUsuario=null;
  mostrarTela('t-login'); $('t-login').classList.add('ativa');
}
function usarOffline(){
  _modoOffline=true;
  usuarioEmail='offline@local'; perfilUsuario={nome:'MODO LOCAL',crm:'',role:'medico'};
  irTurno();
  toast('Modo local ativado — dados salvos só neste dispositivo.');
}

/* ── TROCA DE SENHA ── */
async function salvarNovaSenha(){
  const nova=gf('ts-nova'), conf=gf('ts-conf'), err=$('ts-err');
  err.textContent='';
  if(nova.length<6){ err.textContent='Mínimo 6 caracteres.'; return; }
  if(nova!==conf){ err.textContent='As senhas não coincidem.'; return; }
  try{
    await auth.currentUser.updatePassword(nova);
    if(db && usuarioEmail){ try{ await db.collection('usuarios_med').doc(usuarioEmail).update({senhaTrocada:true}); }catch(_){} }
    if(perfilUsuario) perfilUsuario.senhaTrocada=true;
    toast('<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M2.5 8.5l3.5 3.5 7.5-7.5"/></svg> Senha atualizada.');
    irTurno();
  }catch(e){ err.textContent='Erro: '+(e.message||e.code); }
}
function abrirTrocaSenhaVoluntaria(){
  $('ts-titulo').textContent='Trocar minha senha';
  $('ts-sub').textContent='Defina uma nova senha pessoal.';
  sf('ts-nova',''); sf('ts-conf',''); $('ts-err').textContent='';
  mostrarTela('t-trocasenha');
}

/* ════════════════════════════════════════════════════════════════════════════
   NAVEGAÇÃO
   ════════════════════════════════════════════════════════════════════════════ */
function irTurno(){ mostrarTela('t-turno'); $('t-turno').style.display='flex'; _atualizarBadgeUser(); _checarSync(); }
function voltarTurno(){ irTurno(); }
function escolherTurno(t){ turnoAtual=t; $('badge-turno-leitos').innerHTML=(t==='DIURNO'?'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><circle cx="8" cy="8" r="3"/><line x1="8" y1="1.5" x2="8" y2="3"/><line x1="8" y1="13" x2="8" y2="14.5"/><line x1="1.5" y1="8" x2="3" y2="8"/><line x1="13" y1="8" x2="14.5" y2="8"/><line x1="3.5" y1="3.5" x2="4.5" y2="4.5"/><line x1="11.5" y1="11.5" x2="12.5" y2="12.5"/><line x1="12.5" y1="3.5" x2="11.5" y2="4.5"/><line x1="4.5" y1="11.5" x2="3.5" y2="12.5"/></svg> DIURNO':'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M9.5 2.5a6 6 0 100 11 6.5 6.5 0 01-2-5.5 6.5 6.5 0 012-5.5z"/></svg> NOTURNO'); renderLeitos(); mostrarTela('t-leitos'); }
function voltarLeitos(){ renderLeitos(); mostrarTela('t-leitos'); }

function _checarSync(){
  const dot=$('sync-dot'), txt=$('sync-txt');
  if(_modoOffline){ dot.className='sync-dot off'; txt.textContent='modo local (sem nuvem)'; return; }
  if(db){ dot.className='sync-dot on'; txt.textContent='conectado à nuvem'; }
  else { dot.className='sync-dot off'; txt.textContent='offline'; }
}

/* ════════════════════════════════════════════════════════════════════════════
   MAPA DE LEITOS
   ════════════════════════════════════════════════════════════════════════════ */
async function _getLeitos(){
  let ld = await dbGet('uti_leitos');
  if(!ld){ ld={}; }
  for(let i=1;i<=TOTAL_LEITOS;i++){ if(!ld[i]) ld[i]={ocupado:false}; }
  return ld;
}
async function renderLeitos(){
  const grid=$('leitos-grid'); grid.innerHTML='<div style="padding:1rem;color:var(--muted);">Carregando leitos...</div>';
  const ld=await _getLeitos();
  let h='';
  for(let i=1;i<=TOTAL_LEITOS;i++){
    const L=ld[i]||{ocupado:false};
    if(L.ocupado && L.pac){
      // tenta achar o SAPS salvo na admissão para exibir badge
      const sapsBadge = L.saps3 ? _sapsBadge(L.saps3) : '';
      const sapsCanto = L.saps3 ? `<div class="leito-saps">SAPS ${L.saps3}</div>` : '';
      const idadeNum = _idadeDeDN(L.dn);
      const idadeStr = idadeNum!=null ? `${idadeNum}a` : '';
      const sexoStr = L.sexo==='FEMININO' ? '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="16" viewBox="0 0 14 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><circle cx="8" cy="6" r="3.5"/><line x1="8" y1="9.5" x2="8" y2="14"/><line x1="6" y1="12" x2="10" y2="12"/></svg>' : L.sexo==='MASCULINO' ? '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><circle cx="6.5" cy="9.5" r="3.5"/><line x1="9.5" y1="6.5" x2="14" y2="2"/><polyline points="10,2 14,2 14,6"/></svg>' : '';
      const demogTag = (idadeStr||sexoStr) ? `<span class="leito-tag" style="font-weight:700;letter-spacing:.02em;">${[idadeStr,sexoStr].filter(Boolean).join(' ')}</span>` : '';
      h+=`<div class="leito-card ocupado" onclick="abrirFormulario(${i})">
        ${sapsCanto}
        <div class="leito-num">LEITO ${pad(i)}</div>
        <div class="leito-pac">${L.pac}</div>
        <div class="leito-diag">${L.diag||'—'}</div>
        <div class="leito-tags">${demogTag}${sapsBadge}${L.adm?`<span class="leito-tag">UTI ${_fmtDataCurta(L.adm)}</span>`:''}</div>
        <div class="leito-card-actions" style="margin-top:8px;display:flex;gap:4px;width:100%;z-index:10;" onclick="event.stopPropagation();">
          <button class="btn btn-sm" style="flex:1;font-size:0.65rem;padding:3px 6px;border-radius:4px;background:#f3f4f6;border:1px solid #9ca3af;color:#374151;" onclick="abrirGestaoLeito(${i})" title="Alta, óbito ou transferência"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><circle cx="8" cy="8" r="2.5"/><path d="M8 2.5V1M8 15v-1.5M2.5 8H1M15 8h-1.5M4.2 4.2L3.1 3.1M12.9 12.9l-1.1-1.1M4.2 11.8L3.1 12.9M12.9 3.1l-1.1 1.1"/></svg> Alta/Transf.</button>
          ${_isDiarista()?`<button class="btn btn-sm" style="flex:1;font-size:0.65rem;padding:3px 6px;border-radius:4px;background:#dcfce7;border:1px solid #86efac;color:#166534;font-weight:700;" onclick="abrirModalDiaristaEv(${i})" title="Preencher evolução diarista"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><circle cx="8" cy="5" r="2.5"/><path d="M4.5 13C4.5 10.5 6 9 8 9s3.5 1.5 3.5 4"/><path d="M10 11.5a2 2 0 004 0V10"/><circle cx="14" cy="9.5" r="1"/></svg> Diarista</button>`:''}
        </div>
      </div>`;
    } else {
      h+=`<div class="leito-card vazio" onclick="abrirModalAdmissaoNovo(${i})">
        <div class="leito-num">LEITO ${pad(i)}</div>
        <div class="leito-vazio-txt">＋ Admitir<br>paciente</div>
      </div>`;
    }
  }
  grid.innerHTML=h;
}
function _sapsBadge(score){
  const m=_mortSAPS(score,'csa')*100;
  const cls = m>=50?'saps-hi':(m>=20?'saps-md':'saps-lo');
  return `<span class="leito-tag ${cls}">${m.toFixed(0)}% óbito</span>`;
}
function _fmtDataCurta(d){ if(!d) return ''; const p=d.split('-'); return p.length===3?`${p[2]}/${p[1]}`:d; }


/* ════════════════════════════════════════════════════════════════════════════
   MODAL DE ADMISSÃO
   ─ Os campos de admissão (identificação, HDA, descrição de admissão, itens
     SAPS de admissão) são gravados no leito e HERDADOS por todas as evoluções.
   ════════════════════════════════════════════════════════════════════════════ */
function abrirModalAdmissaoNovo(leito){ modalLeito=leito; _itensSAPS={}; _renderModalAdm(leito,{}); }
async function abrirModalAdmissao(){
  // edição da admissão do leito já aberto no formulário
  modalLeito=leitoAtual;
  const ld=await _getLeitos(); const L=ld[leitoAtual]||{};
  _itensSAPS = L.itensSAPS || _itensSAPS || {};
  _renderModalAdm(leitoAtual, L);
}
function _renderModalAdm(leito, L){
  L=L||{};
  $('modal-adm-titulo').textContent=`Admissão – Leito ${pad(leito)}`;
  // auto-deriva itens SAPS possíveis (idade vem da DN no cálculo)
  _itensSAPS = _autoPreencherItensSAPS(L.itensSAPS || _itensSAPS || {});
  const it = _itensSAPS;
  const v = (x,d)=> (L[x]!=null?L[x]:(d||''));
  $('modal-adm-body').innerHTML=`
    <div class="tip i" style="margin-bottom:10px;">Dados preenchidos aqui ficam <strong>fixos e visíveis em todas as evoluções</strong> deste paciente.</div>
    <div class="grid2">
      <div class="fl"><label>Paciente</label><input type="text" id="m-pac" value="${v('pac')}"></div>
      <div class="fl"><label>DN</label><input type="date" id="m-dn" value="${v('dn')}" onchange="_calcIdadeDisplay('m-dn','m-idade')"><span id="m-idade" style="font-size:.7rem;color:var(--vinho);font-weight:700;"></span></div>
      <div class="fl"><label>Sexo</label><select id="m-sexo"><option value="">—</option><option ${v('sexo')==='FEMININO'?'selected':''}>FEMININO</option><option ${v('sexo')==='MASCULINO'?'selected':''}>MASCULINO</option></select></div>
      <div class="fl"><label>CNS</label><input type="text" id="m-cns" value="${v('cns')}"></div>
      <div class="fl"><label>Adm. UTI</label><input type="date" id="m-adm" value="${v('adm')}"></div>
      <div class="fl"><label>Adm. Hospitalar</label><input type="date" id="m-adm-hosp" value="${v('admHosp')}"></div>
    </div>
    <div class="fl"><label>Hipóteses Diagnósticas</label><input type="text" id="m-diag" value="${v('diag')}"></div>
    <div class="grid2">
      <div class="fl"><label>CID-10</label><input type="text" id="m-cid" value="${v('cid')}" style="font-family:monospace;font-weight:600;"></div>
      <div class="fl"><label>Alergias</label><input type="text" id="m-alergia" value="${v('alergia','NEGA')}"></div>
    </div>
    <div class="fl"><label>Comorbidades</label><input type="text" id="m-comor" value="${v('comor')}"></div>
    <div class="fl"><label>Medicamentos de uso contínuo</label><input type="text" id="m-medcont" value="${v('medcont')}"></div>
    <div class="grid2">
      <div class="fl"><label>Peso (kg)</label><input type="number" step="0.1" id="m-peso" value="${v('peso')}"></div>
      <div class="fl"><label>Altura (cm)</label><input type="number" id="m-altura" value="${v('altura')}"></div>
    </div>
    <div class="fl"><label>HDA (História da Doença Atual)</label><textarea id="m-hda" rows="5">${v('hda')}</textarea></div>
    <div class="fl"><label>Descrição da admissão na UTI</label><textarea id="m-adm-desc" rows="4">${v('admDesc')}</textarea></div>

    <div class="secao" style="margin-top:12px;">
      <div class="secao-t">SAPS 3 — Itens da admissão (não vêm da evolução)</div>
      <div class="secao-c">
        ${_htmlItensSAPS(it)}
      </div>
    </div>
  `;
  $('btn-alta-modal').style.display = L.ocupado ? 'inline-block' : 'none';
  $('modal-adm').classList.add('show');
  _calcIdadeDisplay('m-dn','m-idade');
  _ativarCaixaAlta();
}

function _htmlItensSAPS(it){
  it=it||{}; const c=it.comorb||{}, m=it.motivo||{}, A=it._auto||{};
  const fis=it.fisiologicos||{};
  const sel=(id,val,opts)=>`<select id="${id}">${opts.map(o=>`<option value="${o[0]}" ${val===o[0]?'selected':''}>${o[1]}</option>`).join('')}</select>`;
  const chk=(id,b,lbl,autoKey)=>{
    const auto = autoKey && A[autoKey];
    return `<label style="display:flex;align-items:center;gap:6px;font-size:.78rem;text-transform:none;letter-spacing:0;font-weight:500;${auto?'background:#fdf2dd;border-radius:6px;padding:2px 5px;':''}"><input type="checkbox" id="${id}" ${b?'checked':''} style="width:auto;"> ${lbl}${auto?' <span style="font-size:.6rem;color:var(--laranja);font-weight:700;"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 2v3M8 11v3M2 8h3M11 8h3"/><path d="M4.2 4.2l2 2M9.8 9.8l2 2M4.2 11.8l2-2M9.8 6.2l2-2"/><circle cx="8" cy="8" r="1.5"/></svg>auto</span>':''}</label>`;
  };
  const num=(id,val,ph)=>`<input type="number" id="${id}" step="any" value="${val!=null?val:''}" placeholder="${ph||''}">`;

  // Mostrar/ocultar localCir conforme cirurgia
  const temCirurgia = it.cirurgia && it.cirurgia!=='' && it.cirurgia!=='nao_cirurgico';
  return `
    <div class="grid2">
      <div class="fl"><label>Local antes da UTI</label>${sel('sa-local',it.localPrevio,[['','—'],['emergencia','Emergência'],['centro_cirurgico','Centro cirúrgico'],['sala_recup','Sala de recuperação'],['outra_uti','Outra UTI'],['enfermaria','Enfermaria/outros']])}</div>
      <div class="fl"><label>Dias de internação antes da UTI</label>${num('sa-predias',it.preDias,'0')}</div>
      <div class="fl"><label>Tipo de admissão</label>${sel('sa-admtipo',it.admTipo,[['','—'],['planejada','Planejada'],['nao_planejada','Não planejada']])}</div>
      <div class="fl"><label>Status cirúrgico</label>${sel('sa-cirurgia',it.cirurgia,[['','—'],['nao_cirurgico','Não cirúrgico (sem cirurgia)'],['programada','Cirurgia programada'],['urgente','Cirurgia de urgência']], )}
        <script>document.getElementById('sa-cirurgia').addEventListener('change',function(){document.getElementById('sa-localcir-wrap').style.display=this.value&&this.value!=='nao_cirurgico'?'':'none';});<\/script>
      </div>
      <div class="fl" id="sa-localcir-wrap" style="display:${temCirurgia?'':'none'};"><label>Local da cirurgia</label>${sel('sa-localcir',it.localCir,[['','—'],['transplante','Transplante'],['trauma','Trauma/politrauma'],['cardiaca','Cir. cardíaca'],['neuro_avc','Neurocirurgia/AVC'],['outras_cir','Outras cirurgias']])}</div>
    </div>

    <div style="margin:10px 0 4px;"><strong style="font-size:.74rem;color:var(--vinho);">Comorbidades</strong>
      <div class="grid2" style="margin-top:5px;">
        ${chk('sa-cancerTerapia',c.cancerTerapia,'Em tratamento oncológico','cancerTerapia')}
        ${chk('sa-icc4',c.icc4,'IC NYHA IV','icc4')}
        ${chk('sa-cancerHemato',c.cancerHemato,'Câncer hematológico','cancerHemato')}
        ${chk('sa-cirrose',c.cirrose,'Cirrose','cirrose')}
        ${chk('sa-cancerMeta',c.cancerMeta,'Câncer metastático','cancerMeta')}
        ${chk('sa-aids',c.aids,'SIDA/HIV','aids')}
        ${chk('sa-vasoPrevia',it.vasoPrevia,'Vasoativa antes da UTI','vasoPrevia')}
      </div>
    </div>

    <div style="margin:10px 0 4px;"><strong style="font-size:.74rem;color:var(--vinho);">Motivo de admissão</strong>
      <div class="grid2" style="margin-top:5px;">
        ${chk('sa-coma',m.coma,'Coma/torpor/agitação','coma')}
        ${chk('sa-focal',m.focalNeuro,'Focalidade neurológica','focalNeuro')}
        ${chk('sa-massa',m.efeitoMassa,'Efeito de massa cerebral','efeitoMassa')}
        ${chk('sa-choqueSep',m.choqueSeptico,'Choque séptico','choqueSeptico')}
        ${chk('sa-choqueHipo',m.choqueHipovol,'Choque hipovolêmico','choqueHipovol')}
        ${chk('sa-choqueAna',m.choqueAnafilatico,'Choque anafilático/misto','choqueAnafilatico')}
      </div>
    </div>

    <div style="margin:10px 0 4px;"><strong style="font-size:.74rem;color:var(--vinho);">Infecção na admissão</strong>
      <div class="grid2" style="margin-top:5px;">
        ${chk('sa-infNoso',it.infNoso,'Infecção nosocomial','infNoso')}
        ${chk('sa-infResp',it.infResp,'Infecção respiratória','infResp')}
      </div>
    </div>

    <div style="margin:10px 0 4px;"><strong style="font-size:.74rem;color:var(--vinho);">Dados Fisiológicos na admissão</strong>
      <div class="tip i" style="font-size:.72rem;margin:4px 0 8px;">Se preenchidos aqui, serão usados no SAPS 3. Você também pode preencher na evolução diária — o sistema usa o valor mais recente disponível.</div>
      <div class="grid2">
        <div class="fl"><label>Glasgow (3–15)</label>${num('sa-glasgow',fis.glasgow,'15')}</div>
        <div class="fl"><label>PA sistólica (mmHg)</label>${num('sa-pas',fis.pas,'120')}</div>
        <div class="fl"><label>Freq. cardíaca (bpm)</label>${num('sa-fc',fis.fc,'80')}</div>
        <div class="fl"><label>Temperatura (°C)</label>${num('sa-tmax',fis.tmax,'37')}</div>
        <div class="fl"><label>PaO₂ (mmHg)</label>${num('sa-pao2',fis.pao2,'')}</div>
        <div class="fl"><label>FiO₂ (0,21–1,0)</label>${num('sa-fio2',fis.fio2,'')}</div>
        <div class="fl"><label>pH arterial</label>${num('sa-ph',fis.ph,'')}</div>
        <div class="fl"><label>Ventilação</label>${sel('sa-vent',fis.vent,[['','—'],['VMI','VMI (ventilação mecânica invasiva)'],['VNI','VNI'],['O2','O₂ suplementar'],['AA','Ar ambiente']])}</div>
        <div class="fl"><label>Bilirrubina (mg/dL)</label>${num('sa-bili',fis.bilirrubina,'')}</div>
        <div class="fl"><label>Creatinina (mg/dL)</label>${num('sa-cr',fis.creatinina,'')}</div>
        <div class="fl"><label>Leucócitos (×10³/mm³)</label>${num('sa-leu',fis.leucocitos,'')}</div>
        <div class="fl"><label>Plaquetas (×10³/mm³)</label>${num('sa-plaq',fis.plaquetas,'')}</div>
      </div>
    </div>
  `;
}

function _coletarItensSAPSdoModal(){
  const chk=id=>{ const e=$(id); return e?e.checked:false; };
  const val=id=>{ const e=$(id); return e?e.value:''; };
  const num=id=>{ const e=$(id); return e&&e.value!==''?Number(e.value):null; };
  if(!$('sa-local')) return _itensSAPS; // modal não montado
  return {
    localPrevio: val('sa-local'),
    preDias: num('sa-predias'),
    admTipo: val('sa-admtipo'),
    cirurgia: val('sa-cirurgia'),
    localCir: val('sa-localcir'),
    vasoPrevia: chk('sa-vasoPrevia'),
    infNoso: chk('sa-infNoso'),
    infResp: chk('sa-infResp'),
    comorb: {
      cancerTerapia: chk('sa-cancerTerapia'), icc4: chk('sa-icc4'),
      cancerHemato: chk('sa-cancerHemato'), cirrose: chk('sa-cirrose'),
      cancerMeta: chk('sa-cancerMeta'), aids: chk('sa-aids')
    },
    motivo: {
      coma: chk('sa-coma'), focalNeuro: chk('sa-focal'), efeitoMassa: chk('sa-massa'),
      choqueSeptico: chk('sa-choqueSep'), choqueHipovol: chk('sa-choqueHipo'),
      choqueAnafilatico: chk('sa-choqueAna')
    },
    // Dados fisiológicos preenchidos no modal de admissão
    fisiologicos: {
      glasgow:  num('sa-glasgow'),
      pas:      num('sa-pas'),
      fc:       num('sa-fc'),
      tmax:     num('sa-tmax'),
      pao2:     num('sa-pao2'),
      fio2:     num('sa-fio2'),
      ph:       num('sa-ph'),
      vent:     val('sa-vent'),
      bilirrubina: num('sa-bili'),
      creatinina:  num('sa-cr'),
      leucocitos:  num('sa-leu'),
      plaquetas:   num('sa-plaq'),
    }
  };
}

async function salvarAdmissao(){
  try{
    const leito=modalLeito;
    const pac=gf('m-pac').trim();
    if(!pac){ toast('Informe o nome do paciente.',true); return; }
    showLoading('Salvando admissão...');
    _itensSAPS = _coletarItensSAPSdoModal();

    const ld=await _getLeitos();
    const jaExistia = ld[leito] && ld[leito].ocupado;

    // calcula SAPS 3 da admissão (com os fisiológicos atuais, se houver evolução aberta)
    const dadosSaps = { dn:gf('m-dn'), idade:_idadeDeDN(gf('m-dn')), itensSAPS:_itensSAPS,
      ..._fisioParaSAPSdoLeito(ld[leito]) };
    const rSaps = calcularSAPS3(dadosSaps);

    ld[leito] = {
      ocupado:true,
      pac:_normalizarNome(pac),
      dn:gf('m-dn'), sexo:gf('m-sexo'), cns:gf('m-cns'),
      adm:gf('m-adm'), admHosp:gf('m-adm-hosp'),
      diag:gf('m-diag').toUpperCase(), cid:gf('m-cid').toUpperCase(),
      alergia:gf('m-alergia'), comor:gf('m-comor'), medcont:gf('m-medcont'),
      peso:gf('m-peso'), altura:gf('m-altura'),
      hda:gf('m-hda'), admDesc:gf('m-adm-desc'),
      itensSAPS:_itensSAPS,
      saps3: rSaps.temDados ? rSaps.score : (ld[leito]&&ld[leito].saps3)||null
    };
    await dbSet('uti_leitos', ld);

    // log de admissão (para indicadores) — só na primeira vez
    if(!jaExistia){
      const key=`uti_med_adm_log_${leito}_${gf('m-adm')||hoje()}`;
      await dbSet(key,{ leito, paciente:_normalizarNome(pac), admUTI:gf('m-adm'), admHosp:gf('m-adm-hosp'),
        diagnostico:gf('m-diag').toUpperCase(), cid:gf('m-cid').toUpperCase(), sexo:gf('m-sexo'),
        dn:gf('m-dn'), saps3:rSaps.score, mortPrevista:rSaps.mortCSA,
        autor:usuarioEmail, registradoEm:new Date().toISOString() });
    }
    hideLoading(); fecharModal(); await renderLeitos();
    toast('Paciente admitido no leito '+pad(leito));
  }catch(e){ hideLoading(); console.error('salvarAdmissao:',e); toast('Erro ao salvar: '+(e.message||e),true); }
}

function _fisioParaSAPSdoLeito(L){
  // se o leito tem uma última evolução salva, usa seus fisiológicos
  if(!L||!L.ultEvol) return {};
  const e=L.ultEvol;
  return { glasgow:e.glasgow, pas:e.pas, fc:e.fc, tmax:e.tmax, pao2:e.pao2, fio2:e.fio2, ph:e.ph,
    vent:e.vent, creatinina:e.creatinina, bilirrubina:e.bilirrubina, leucocitos:e.leucocitos, plaquetas:e.plaquetas };
}

function darAlta(){ fecharModal(); abrirModalAlta(modalLeito); }
function abrirModalAlta(leito){ leitoParaAlta=leito; sf('alta-data',hoje()); sf('alta-obs',''); $('modal-alta').classList.add('show'); }
async function confirmarAltaFinal(){
  try{
    showLoading('Processando alta...');
    const leito=leitoParaAlta;
    const ld=await _getLeitos(); const L=ld[leito]||{};
    const key=`uti_med_alta_log_${leito}_${hoje()}_${Date.now()}`;
    await dbSet(key,{ leito, paciente:L.pac, diagnostico:L.diag, admUTI:L.adm,
      tipo:gf('alta-tipo'), dataAlta:gf('alta-data'), obs:gf('alta-obs'),
      saps3:L.saps3, autor:usuarioEmail, registradoEm:new Date().toISOString() });
    // libera o leito
    ld[leito]={ocupado:false};
    await dbSet('uti_leitos',ld);
    // Apaga dados clínicos do leito (prescrições, evoluções, guias, etc.)
    try {
      const _prefAlt = typeof _PREFIXOS_LEITO !== 'undefined'
        ? _PREFIXOS_LEITO.filter(p => p !== 'uti_med_adm_log_')
        : ['uti_med_ev_','uti_med_rx_','uti_med_imgs_','uti_med_atb_ficha_',
           'uti_med_hemo_ficha_','uti_med_sol_exam_','uti_med_sol_cult_',
           'uti_med_parecer_','uti_med_trilogy_','uti_med_me_',
           'uti_med_diarista_','uti_med_termo_'];
      const _balt = [];
      for (const prefixo of _prefAlt) {
        const chavePref = `${prefixo}${leito}_`;
        if (typeof dbListByPrefix === 'function') {
          const regs = await dbListByPrefix(chavePref);
          for (const ch of Object.keys(regs)) _balt.push(dbDelete(ch).catch(()=>{}));
        }
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const k = localStorage.key(i);
          if (k && k.startsWith(chavePref)) localStorage.removeItem(k);
        }
      }
      await Promise.all(_balt);
    } catch(e){ console.warn('[Alta simples] limpeza:', e); }
    hideLoading();
    $('modal-alta').classList.remove('show');
    await renderLeitos(); mostrarTela('t-leitos');
    toast('Alta registrada. Leito '+pad(leito)+' liberado.');
  }catch(e){ hideLoading(); toast('Erro na alta: '+(e.message||e),true); }
}


/* ════════════════════════════════════════════════════════════════════════════
   FORMULÁRIO DE EVOLUÇÃO
   ════════════════════════════════════════════════════════════════════════════ */
const LAB_CAMPOS = [
  {k:'hb',  l:'Hb'},      {k:'ht', l:'Ht'},   {k:'leu', l:'Leuco'},  {k:'seg', l:'Seg%'},
  {k:'plaq',l:'Plaq(mil)'},{k:'pcr',l:'PCR'},  {k:'ur',  l:'Ureia'},  {k:'cr',  l:'Creat'},
  {k:'na',  l:'Na'},      {k:'k',  l:'K'},     {k:'ca',  l:'Ca'},     {k:'mg',  l:'Mg'},
  {k:'tgo', l:'TGO'},     {k:'tgp',l:'TGP'},   {k:'ldh', l:'LDH'},    {k:'bt',  l:'BT'},
  {k:'bd',  l:'BD'},      {k:'tap', l:'TAP'},  {k:'inr',l:'INR'},   {k:'ttpa',l:'TTPa'},   {k:'gli', l:'Glic'},
  {k:'trop',l:'Tropon'},  {k:'alb',l:'Album'},
];

async function abrirFormulario(leito){
  leitoAtual=leito;
  showLoading('Abrindo evolução...');
  try{
    const ld=await _getLeitos(); const L=ld[leito]||{};
    const dataT=dataDoTurno(turnoAtual);
    $('form-titulo').textContent=`Evolução Médica – Leito ${pad(leito)}`;
    $('form-sub').innerHTML=`${turnoAtual==='DIURNO'?'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><circle cx="8" cy="8" r="3"/><line x1="8" y1="1.5" x2="8" y2="3"/><line x1="8" y1="13" x2="8" y2="14.5"/><line x1="1.5" y1="8" x2="3" y2="8"/><line x1="13" y1="8" x2="14.5" y2="8"/><line x1="3.5" y1="3.5" x2="4.5" y2="4.5"/><line x1="11.5" y1="11.5" x2="12.5" y2="12.5"/><line x1="12.5" y1="3.5" x2="11.5" y2="4.5"/><line x1="4.5" y1="11.5" x2="3.5" y2="12.5"/></svg> Diurno':'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M12.5 9A5.5 5.5 0 017 3.5a5.5 5.5 0 100 9A5.5 5.5 0 0112.5 9z"/></svg> Noturno'} · ${_fmtDataCurta(dataT)} · ${perfilUsuario?perfilUsuario.nome:''}`;
    $('badge-form').textContent=turnoAtual;

    // limpa tudo
    _limparFormulario();
    _itensSAPS = L.itensSAPS || {};

    // 1) herda dados de admissão (sempre visíveis)
    sf('f-pac',L.pac||''); sf('f-dn',L.dn||''); sf('f-sexo',L.sexo||''); sf('f-cns',L.cns||'');
    sf('f-adm',L.adm||''); sf('f-adm-hosp',L.admHosp||''); sf('f-diag',L.diag||''); sf('f-cid',L.cid||'');
    sf('f-alergia',L.alergia||''); sf('f-comor',L.comor||''); sf('f-medcont',L.medcont||'');
    sf('f-peso',L.peso||''); sf('f-altura',L.altura||'');
    sf('f-hda',L.hda||''); sf('f-adm-desc',L.admDesc||'');
    sf('f-leito',pad(leito)); sf('f-data',dataT);
    _calcIdadeDisplay('f-dn','f-idade');

    // 2) tenta carregar evolução já salva deste turno/data
    const evKey=`uti_med_ev_${leito}_${turnoAtual}_${dataT}`;
    let ev=await dbGet(evKey);
    let herdado=false;
    if(!ev){
      // herda a evolução mais recente (qualquer turno) para pré-preencher
      ev=await _ultimaEvolucao(leito);
      if(ev) herdado=true;
    }
    if(ev) _preencherEvolucao(ev, herdado);

    $('herd-tag').style.display = herdado ? 'inline-block' : 'none';
    $('cloud-tag').style.display = (db && !_modoOffline) ? 'inline-block' : 'none';

    _renderCulturasChips();
    _renderLabLinhas();
    _buscarCulturasAuto(L.pac, leito);
    _recalcSAPS();
    _ativarCaixaAlta();
    await _carregarPrescricao(leito);
    _atualizarPnavPac();
    _aplicarModoDiarista();
    await _carregarDiarista(leito, dataT);
    await _carregarImgsExame(leito, dataT);
    await _laudoAvulsoCarregar(leito, dataT);
    mudarAba('evolucao'); // sempre abre na aba de evolução
    hideLoading();
    mostrarTela('t-form');
    _resizeTodosTextareas();
  }catch(e){ hideLoading(); console.error('abrirFormulario:',e); toast('Erro ao abrir: '+(e.message||e),true); }
}

async function abrirFormularioDirect(leito, aba){
  await abrirFormulario(leito);
  mudarAba(aba);
}

function _limparFormulario(){
  ['f-pac','f-dn','f-sexo','f-cns','f-adm','f-adm-hosp','f-diag','f-cid','f-alergia','f-comor','f-medcont',
   'f-peso','f-altura',
   'f-hda','f-adm-desc','f-evol','f-atb','f-atb-prev','f-pam','f-pas','f-fc','f-fr','f-tmax','f-spo2',
   'f-diurese','f-bh','f-evac','f-hgt','f-ef-ecto','f-ef-neuro','f-glasgow','f-ef-pupilas','f-ef-acv',
   'f-ef-ar','f-ef-abd','f-ef-ext','f-ef-pele','f-ef-genital','f-acessos','f-dispositivos','f-sedacao',
   'f-transfusao','f-vent-param','f-pao2','f-fio2','f-ph','f-gaso','f-imagem','f-condutas','f-microorg']
   .forEach(id=>sf(id,''));
  sf('f-dieta',''); sf('f-dva','NAO'); sf('f-vent','AA');
  _culturasForm=[]; _labLinhas=[];
}

function _preencherEvolucao(ev, herdado){
  // campos do plantão — se herdado, mantém preenchido como rascunho
  sf('f-evol',ev.evol||''); sf('f-atb',ev.atb||''); sf('f-atb-prev',ev.atbPrev||'');
  // Auto-preenche ATBs das prescrições SOMENTE se não houver nada salvo nesses campos
  // (evita apagar/sobrescrever o que o usuário já digitou). Preenchimento manual
  // sempre disponível via botão "Auto".
  if(!(ev.atb||'').trim() && !(ev.atbPrev||'').trim()){
    setTimeout(_autoPreencherATBs, 300);
  }
  sf('f-pam',ev.pam||''); sf('f-pas',ev.pas||''); sf('f-fc',ev.fc||''); sf('f-fr',ev.fr||'');
  sf('f-tmax',ev.tmax||''); sf('f-spo2',ev.spo2||''); sf('f-diurese',ev.diurese||'');
  sf('f-bh',ev.bh||''); sf('f-evac',ev.evac||''); sf('f-hgt',ev.hgt||'');
  sf('f-ef-ecto',ev.ecto||''); sf('f-ef-neuro',ev.neuro||''); sf('f-glasgow',ev.glasgow||'');
  sf('f-ef-pupilas',ev.pupilas||''); sf('f-ef-acv',ev.acv||''); sf('f-ef-ar',ev.ar||'');
  sf('f-ef-abd',ev.abd||''); sf('f-ef-ext',ev.ext||''); sf('f-ef-pele',ev.pele||''); sf('f-ef-genital',ev.genital||'');
  sf('f-acessos',ev.acessos||''); sf('f-dispositivos',ev.dispositivos||''); sf('f-dieta',ev.dieta||'');
  sf('f-dva',ev.dva||'NAO'); sf('f-dva-qual',ev.dvaQual||''); _toggleDVAcampo();
  sf('f-sedacao',ev.sedacao||''); sf('f-transfusao',ev.transfusao||'');
  sf('f-vent',ev.vent||'AA'); sf('f-vent-param',ev.ventParam||''); sf('f-pao2',ev.pao2||'');
  sf('f-fio2',ev.fio2||''); sf('f-ph',ev.ph||''); sf('f-gaso',ev.gaso||'');
  sf('f-imagem',ev.imagem||''); sf('f-condutas',ev.condutas||'');
  _culturasForm = ev.culturas||[];
  _labLinhas = ev.labLinhas||[];
}

function coletarDados(){
  const n=id=>{ const v=gf(id); return v===''?null:Number(v); };
  _sincronizarMicroorg();
  return {
    leito:leitoAtual, turno:turnoAtual, data:gf('f-data'),
    pac:gf('f-pac'), dn:gf('f-dn'), sexo:gf('f-sexo'), cns:gf('f-cns'),
    adm:gf('f-adm'), admHosp:gf('f-adm-hosp'), diag:gf('f-diag'), cid:gf('f-cid'),
    alergia:gf('f-alergia'), comor:gf('f-comor'), medcont:gf('f-medcont'),
    peso:gf('f-peso'), altura:gf('f-altura'),
    hda:gf('f-hda'), admDesc:gf('f-adm-desc'),
    evol:gf('f-evol'), atb:gf('f-atb'), atbPrev:gf('f-atb-prev'),
    pam:gf('f-pam'), pas:n('f-pas'), fc:n('f-fc'), fr:gf('f-fr'), tmax:n('f-tmax'),
    spo2:gf('f-spo2'), diurese:gf('f-diurese'), bh:gf('f-bh'), evac:gf('f-evac'), hgt:gf('f-hgt'),
    ecto:gf('f-ef-ecto'), neuro:gf('f-ef-neuro'), glasgow:n('f-glasgow'), pupilas:gf('f-ef-pupilas'),
    acv:gf('f-ef-acv'), ar:gf('f-ef-ar'), abd:gf('f-ef-abd'), ext:gf('f-ef-ext'),
    pele:gf('f-ef-pele'), genital:gf('f-ef-genital'),
    acessos:gf('f-acessos'), dispositivos:gf('f-dispositivos'), dieta:gf('f-dieta'),
    dva:gf('f-dva'), dvaQual:gf('f-dva-qual'), sedacao:gf('f-sedacao'), transfusao:gf('f-transfusao'),
    vent:gf('f-vent'), ventParam:gf('f-vent-param'), pao2:n('f-pao2'), fio2:n('f-fio2'),
    ph:n('f-ph'), gaso:gf('f-gaso'), imagem:gf('f-imagem'), condutas:gf('f-condutas'),
    microorg:gf('f-microorg'), culturas:_culturasForm, labLinhas:_labLinhas,
    // fisiológicos para SAPS armazenados na evolução
    ..._labDerivadosParaSAPS(),
    autor:usuarioEmail, autorNome:perfilUsuario?perfilUsuario.nome:'', registradoEm:new Date().toISOString()
  };
}

async function salvarEvolucao(){
  // ── Validação dos campos obrigatórios ───────────────────────────────
  const _req = [
    { id:'f-pac',    label:'Paciente' },
    { id:'f-dn',     label:'Data de nascimento' },
    { id:'f-sexo',   label:'Sexo' },
    { id:'f-diag',   label:'Hipótese diagnóstica' },
    { id:'f-cid',    label:'CID-10' },
    { id:'f-comor',  label:'Comorbidades' },
    { id:'f-alergia',label:'Alergias' },
    { id:'f-medcont',label:'Medicamentos de uso contínuo' },
  ];
  _req.forEach(r=>{ const el=$(r.id); if(el&&el.closest('.fl')) el.closest('.fl').classList.remove('field-invalid'); });
  const vazios = _req.filter(r=>!gf(r.id).trim());
  if(vazios.length){
    vazios.forEach(r=>{ const el=$(r.id); if(el&&el.closest('.fl')) el.closest('.fl').classList.add('field-invalid'); });
    toast('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> Preencha: ' + vazios.map(r=>r.label).join(', '), true);
    const primeiro = $(vazios[0].id); if(primeiro) primeiro.scrollIntoView({behavior:'smooth',block:'center'});
    return;
  }
  // ────────────────────────────────────────────────────────────────────
  showLoading('Salvando evolução...');
  try{
    const d=coletarDados();
    const evKey=`uti_med_ev_${leitoAtual}_${turnoAtual}_${d.data}`;
    await dbSet(evKey,d);

    // atualiza dados de admissão herdados (caso editados aqui) + última evolução + SAPS
    const ld=await _getLeitos(); const L=ld[leitoAtual]||{ocupado:true};
    Object.assign(L,{ ocupado:true, pac:_normalizarNome(d.pac), dn:d.dn, sexo:d.sexo, cns:d.cns,
      adm:d.adm, admHosp:d.admHosp, diag:(d.diag||'').toUpperCase(), cid:(d.cid||'').toUpperCase(),
      alergia:d.alergia, comor:d.comor, medcont:d.medcont, hda:d.hda, admDesc:d.admDesc,
      itensSAPS:_itensSAPS,
      ultEvol:{ glasgow:d.glasgow, pas:d.pas, fc:d.fc, tmax:d.tmax, pao2:d.pao2, fio2:d.fio2, ph:d.ph,
        vent:d.vent, creatinina:d.creatinina, bilirrubina:d.bilirrubina, leucocitos:d.leucocitos, plaquetas:d.plaquetas }
    });
    const r=_recalcSAPS();
    if(r.temDados) L.saps3=r.score;
    ld[leitoAtual]=L;
    await dbSet('uti_leitos',ld);

    await _salvarImgsExame(leitoAtual, d.data);
    hideLoading();
    toast('<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M2.5 8.5l3.5 3.5 7.5-7.5"/></svg> Evolução salva.');
    $('herd-tag').style.display='none';
    _atualizarPnavPac();
  }catch(e){ hideLoading(); console.error('salvarEvolucao:',e); toast('Erro ao salvar: '+(e.message||e),true); }
}

async function _ultimaEvolucao(leito){
  const all=await dbListByPrefix(`uti_med_ev_${leito}_`);
  const arr=Object.entries(all).map(([k,v])=>({k,v})).filter(x=>x.v&&x.v.data);
  if(!arr.length) return null;
  arr.sort((a,b)=>(b.v.data||'').localeCompare(a.v.data||'') || (b.v.registradoEm||'').localeCompare(a.v.registradoEm||''));
  return arr[0].v;
}

/* ── IDADE ─────────────────────────────────────────────────────────────────── */
function _calcIdadeDisplay(idDN,idOut){
  const a=_idadeDeDN(gf(idDN)); const o=$(idOut);
  if(o) o.textContent = a!=null ? a+' anos' : '';
}


/* ════════════════════════════════════════════════════════════════════════════
   EXAMES LABORATORIAIS  (registro por data + gráfico de tendência)
   ════════════════════════════════════════════════════════════════════════════ */

// Conjunto de índices com accordion aberto
const _labAbertos = new Set();

function _labToggle(idx){
  if(_labAbertos.has(idx)) _labAbertos.delete(idx);
  else _labAbertos.add(idx);
  _renderLabLinhas();
}

function _renderLabLinhas(){
  const wrap=$('lab-linhas'); if(!wrap) return;
  if(!_labLinhas.length){
    wrap.innerHTML='<div style="font-size:.78rem;color:var(--muted);padding:.4rem;">Nenhuma data registrada. Clique em "+ Adicionar data de exames".</div>';
    return;
  }
  wrap.innerHTML = _labLinhas.map((lin,idx)=>{
    const aberto = _labAbertos.has(idx);
    // Resumo compacto: até 6 valores preenchidos
    const preenchidos = LAB_CAMPOS.filter(c=>lin.valores&&lin.valores[c.k]!=null&&lin.valores[c.k]!=='');
    const resumoChips = preenchidos.slice(0,6).map(c=>
      `<span class="lab-acc-chip"><span class="lab-acc-k">${c.l}</span>${lin.valores[c.k]}</span>`
    ).join('');
    const maisN = preenchidos.length > 6 ? `<span class="lab-acc-mais">+${preenchidos.length-6}</span>` : '';
    const semDados = preenchidos.length===0 && !(lin.outros||'').trim();
    // Grid de edição (só renderiza se aberto)
    const campos = aberto ? LAB_CAMPOS.map(c=>`
      <div class="fl"><label>${c.l}</label><input type="number" step="any" value="${(lin.valores&&lin.valores[c.k]!=null)?lin.valores[c.k]:''}" oninput="_setLabVal(${idx},'${c.k}',this.value)"></div>`).join('') : '';
    const outrosVal = (lin.outros||'').replace(/"/g,'&quot;');
    return `<div class="lab-linha lab-acc${aberto?' lab-acc-open':''}">
      <div class="lab-acc-head" onclick="_labToggle(${idx})">
        <span class="lab-acc-chev">${aberto?'▾':'▸'}</span>
        <input type="date" value="${lin.data||''}" onchange="event.stopPropagation();_setLabData(${idx},this.value)" onclick="event.stopPropagation()">
        <div class="lab-acc-resumo">
          ${semDados
            ? '<span style="font-size:.72rem;color:var(--muted);font-style:italic;">sem valores — clique para preencher</span>'
            : resumoChips + maisN
          }
        </div>
        <button class="lab-del" onclick="event.stopPropagation();_delLabLinha(${idx})" title="Remover"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,5 5,5 13,5"/><path d="M6 5V3.5A.5.5 0 016.5 3h3a.5.5 0 01.5.5V5"/><path d="M5 5l.7 8.5a.8.8 0 00.8.5h3a.8.8 0 00.8-.5L11 5"/></svg></button>
      </div>
      ${aberto ? `<div class="lab-acc-body">
        <div class="lab-grid">${campos}</div>
        <div style="margin-top:.4rem;">
          <div class="fl" style="margin:0;"><label style="font-size:.58rem;color:var(--muted);font-weight:700;letter-spacing:.04em;">OUTROS EXAMES (texto livre)</label>
            <input type="text" value="${outrosVal}"
              placeholder="Ex: Amilase 210, Lipase 380, Cortisol 18, TSH 0.9..."
              style="font-size:.78rem;font-family:var(--font-mono);"
              oninput="_setLabOutros(${idx},this.value)">
          </div>
        </div>
      </div>` : ''}
    </div>`;
  }).join('');
}
function addLinhaLab(){
  const idx = _labLinhas.length;
  _labLinhas.push({data:gf('f-data')||hoje(), valores:{}});
  _labAbertos.add(idx);
  _renderLabLinhas();
}
function _setLabData(i,v){ if(_labLinhas[i]) _labLinhas[i].data=v; }
function _setLabVal(i,k,v){
  if(_labLinhas[i]){
    _labLinhas[i].valores=_labLinhas[i].valores||{};
    _labLinhas[i].valores[k]= v===''?undefined:v;
    if(['cr','bt','leu','plaq'].includes(k)){ _recalcSAPS(); }
    if(k==='cr') _atualizarTFG();
  }
}
function _delLabLinha(i){ _labLinhas.splice(i,1); _renderLabLinhas(); }
function _setLabOutros(i,v){
  if(_labLinhas[i]) _labLinhas[i].outros = v;
}

/* ── Aba Solicitações: renderiza histórico de solicitações + exames read-only ── */
async function _renderAbasolicitacoes(){
  _renderLabReadOnly();
  await _renderHistoricoSolicitacoes();
}

// Exames registrados na evolução — somente leitura, sem inputs editáveis
function _renderLabReadOnly(){
  const wrap=$('lab-linhas-readonly'); if(!wrap) return;
  if(!_labLinhas||!_labLinhas.length){
    wrap.innerHTML='<div style="font-size:.8rem;color:var(--muted);padding:6px 0;">Nenhum resultado registrado. Alimente os exames na aba Evolução.</div>';
    return;
  }
  const campLbl = Object.fromEntries(LAB_CAMPOS.map(c=>[c.k,c.l]));
  wrap.innerHTML=_labLinhas.slice().reverse().map(lin=>{
    const vals=Object.entries(lin.valores||{})
      .filter(([,v])=>v!=null&&v!=='')
      .map(([k,v])=>`<span class="lab-ro-item"><b>${campLbl[k]||k}</b> ${v}</span>`)
      .join('');
    const outrosTag = lin.outros && lin.outros.trim()
      ? `<span class="lab-ro-item" style="color:#555;"><b>Outros</b> ${lin.outros}</span>` : '';
    const tudo = vals + outrosTag;
    return tudo ? `<div class="lab-ro-linha">
      <div class="lab-ro-data">${_fmtDataCurta(lin.data)||'?'}</div>
      <div class="lab-ro-vals">${tudo}</div>
    </div>` : '';
  }).filter(Boolean).join('') || '<div style="font-size:.8rem;color:var(--muted);">Nenhum valor registrado.</div>';
}

// Histórico de solicitações salvas no Firebase para este leito
async function _renderHistoricoSolicitacoes(){
  const wrap=$('sol-exames-historico'); if(!wrap) return;
  if(!leitoAtual){
    wrap.innerHTML='<div style="font-size:.8rem;color:var(--muted);">Abra o prontuário de um paciente para ver as solicitações.</div>';
    return;
  }
  wrap.innerHTML='<div style="font-size:.8rem;color:var(--muted);">Carregando...</div>';
  try{
    // Busca exames convencionais E culturas
    const [todasExam, todasCult, todasPar] = await Promise.all([
      dbListByPrefix(`uti_med_sol_exam_${leitoAtual}_`),
      dbListByPrefix(`uti_med_sol_cult_${leitoAtual}_`),
      dbListByPrefix(`uti_med_parecer_${leitoAtual}_`)
    ]);
    const arrExam = Object.entries(todasExam).map(([k,v])=>({key:k,...v,_tipo:'exam'})).filter(s=>s&&s.exames&&s.exames.length);
    const arrCult = Object.entries(todasCult).map(([k,v])=>({key:k,...v,_tipo:'cult'})).filter(s=>s&&s.pac);
    const arrPar  = Object.entries(todasPar).map(([k,v])=>({key:k,...v,_tipo:'parecer'})).filter(s=>s&&s.espec);
    const arr=[...arrExam,...arrCult,...arrPar].sort((a,b)=>(b.salvadoEm||'').localeCompare(a.salvadoEm||''));
    if(!arr.length){
      wrap.innerHTML='<div style="font-size:.8rem;color:var(--muted);padding:8px 0;">Nenhuma solicitação registrada para este paciente.</div>';
      return;
    }
    // Agrupa por data
    const porData={};
    arr.forEach(s=>{ const d=s.data||'?'; if(!porData[d]) porData[d]=[]; porData[d].push(s); });

    wrap.innerHTML=Object.entries(porData)
      .sort((a,b)=>b[0].localeCompare(a[0]))
      .map(([data,sols])=>{
        const cards=sols.map(s=>{
          if(s._tipo==='parecer'){
            return `<div class="sol-hist-card" style="border-left:3px solid #1a56db;">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                <span style="font-size:.7rem;font-weight:800;color:#1a56db;letter-spacing:.04em;"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><rect x="3.5" y="3" width="9" height="11" rx="1.2"/><path d="M6 3V2h4v1"/><line x1="6" y1="7" x2="10" y2="7"/><line x1="6" y1="9.5" x2="10" y2="9.5"/><line x1="6" y1="12" x2="9" y2="12"/></svg> PARECER</span>
                <span style="font-size:.75rem;font-weight:700;">${s.espec||'?'}</span>
              </div>
              ${s.motivo?`<div class="sol-hist-ind" style="font-size:.78rem;color:#1a56db;"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M2 3h12a1 1 0 011 1v6a1 1 0 01-1 1H9l-3 3V11H2a1 1 0 01-1-1V4a1 1 0 011-1z"/></svg> ${s.motivo.slice(0,120)}${s.motivo.length>120?'…':''}</div>`:''}
              <div class="sol-hist-meta">
                ${s.medNome||s.autor||'?'}
                <span style="margin-left:auto;">
                  <button class="btn btn-sm" style="font-size:.72rem;padding:3px 8px;" onclick="_imprimirParecerChave('${s.key}')"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><rect x="3" y="6" width="10" height="7" rx="1"/><path d="M5 6V3h6v3"/><rect x="5" y="9.5" width="6" height="2.5" rx=".4"/><line x1="5" y1="7.8" x2="11" y2="7.8"/></svg></button>
                </span>
              </div>
            </div>`;
          }
          if(s._tipo==='cult'){
            // Card de cultura — resumido
            const exames=_cultResumir(s);
            return `<div class="sol-hist-card sol-hist-card-cult">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                <span style="font-size:.7rem;font-weight:800;color:#8a2be2;letter-spacing:.04em;"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><circle cx="8" cy="8" r="4"/><circle cx="8" cy="8" r="1.5"/><line x1="8" y1="2" x2="8" y2="4"/><line x1="12.2" y1="3.8" x2="10.8" y2="5.2"/><line x1="14" y1="8" x2="12" y2="8"/><line x1="3.8" y1="3.8" x2="5.2" y2="5.2"/><line x1="2" y1="8" x2="4" y2="8"/><line x1="3.8" y1="12.2" x2="5.2" y2="10.8"/><line x1="12.2" y1="12.2" x2="10.8" y2="10.8"/></svg> CULTURA</span>
              </div>
              <div class="sol-hist-exames">${exames.map(e=>`<span class="sol-hist-chip sol-hist-chip-cult">${e}</span>`).join('')}</div>
              ${s.indicacao?`<div class="sol-hist-ind"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M10 2L14 6l-3 3-2-1-4 4-1-1 4-4-1-2z"/><line x1="3" y1="13" x2="7" y2="9"/></svg> ${s.indicacao}</div>`:''}
              <div class="sol-hist-meta">
                ${s.medNome||s.autor||'?'}
                <span style="margin-left:auto;">
                  <button class="btn btn-sm" style="font-size:.72rem;padding:3px 8px;" onclick="_imprimirCultChave('${s.key}')"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><rect x="3" y="6" width="10" height="7" rx="1"/><path d="M5 6V3h6v3"/><rect x="5" y="9.5" width="6" height="2.5" rx=".4"/><line x1="5" y1="7.8" x2="11" y2="7.8"/></svg></button>
                </span>
              </div>
            </div>`;
          }
          // Card de exames convencionais — rotinas ficam agrupadas
          const isRotina=_ehRotinaPadrao(s.exames);
          if(isRotina){
            return `<div class="sol-hist-card sol-hist-card-rotina">
              <details>
                <summary class="sol-hist-rotina-sum">
                  <span class="sol-hist-rotina-badge"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><polygon points="8,2 9.8,6.2 14.5,6.5 11,9.6 12.1,14.2 8,11.6 3.9,14.2 5,9.6 1.5,6.5 6.2,6.2"/></svg> Rotina</span>
                  <span style="font-size:.74rem;color:var(--muted);">${s.exames.length} exames${s.indicacao?' · '+s.indicacao:''}</span>
                  <span style="margin-left:auto;display:flex;gap:4px;" onclick="event.stopPropagation()">
                    <button class="btn btn-sm" style="font-size:.72rem;padding:3px 8px;" onclick="_imprimirSolChave('${s.key}')"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><rect x="3" y="6" width="10" height="7" rx="1"/><path d="M5 6V3h6v3"/><rect x="5" y="9.5" width="6" height="2.5" rx=".4"/><line x1="5" y1="7.8" x2="11" y2="7.8"/></svg></button>
                  </span>
                </summary>
                <div class="sol-hist-exames" style="margin-top:6px;">
                  ${s.exames.map(e=>`<span class="sol-hist-chip">${e}</span>`).join('')}
                </div>
                <div class="sol-hist-meta" style="margin-top:6px;">${s.medNome||s.autor||'?'}</div>
              </details>
            </div>`;
          }
          // Card de exames especiais — exibe normalmente
          return `<div class="sol-hist-card">
            <div class="sol-hist-exames">${s.exames.map(e=>`<span class="sol-hist-chip">${e}</span>`).join('')}</div>
            ${s.indicacao?`<div class="sol-hist-ind"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M10 2L14 6l-3 3-2-1-4 4-1-1 4-4-1-2z"/><line x1="3" y1="13" x2="7" y2="9"/></svg> ${s.indicacao}</div>`:''}
            <div class="sol-hist-meta">
              ${s.medNome||s.autor||'?'}
              <span style="margin-left:auto;">
                <button class="btn btn-sm" style="font-size:.72rem;padding:3px 8px;" onclick="_imprimirSolChave('${s.key}')"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><rect x="3" y="6" width="10" height="7" rx="1"/><path d="M5 6V3h6v3"/><rect x="5" y="9.5" width="6" height="2.5" rx=".4"/><line x1="5" y1="7.8" x2="11" y2="7.8"/></svg></button>
              </span>
            </div>
          </div>`;
        }).join('');

        return `<div class="sol-hist-data">
          <div class="sol-hist-data-lbl">${_fmtDataCurta(data)||data}</div>
          ${cards}
        </div>`;
      }).join('');
  }catch(e){
    wrap.innerHTML='<div style="font-size:.8rem;color:var(--vermelho);">Erro ao carregar solicitações.</div>';
  }
}

// Verifica se a lista de exames é a rotina padrão (subconjunto exato)
function _ehRotinaPadrao(exames){
  if(!exames||exames.length<3) return false;
  const s=new Set(exames.map(e=>e.toUpperCase()));
  const rotinaSet=new Set(SOL_ROTINA.map(e=>e.toUpperCase()));
  // Considera "rotina" se ≥70% dos exames são da lista padrão
  const intersect=[...s].filter(e=>rotinaSet.has(e)).length;
  return intersect/s.size>=0.7;
}


// Imprime solicitação diretamente pelo key Firebase
async function _imprimirSolChave(key){
  showLoading('Carregando...');
  try{
    const s=await dbGet(key); hideLoading();
    if(s) _imprimirSolicitacaoObj(s);
  }catch(e){ hideLoading(); toast('Erro: '+(e.message||e),true); }
}

function abrirGraficoLab(){
  if(!_labLinhas.length){ $('grafico-vazio').style.display='block'; }
  else { $('grafico-vazio').style.display='none'; }
  // seletor de campos (só os que têm ao menos 1 valor)
  const disponiveis = LAB_CAMPOS.filter(c=>_labLinhas.some(l=>l.valores&&l.valores[c.k]!=null&&l.valores[c.k]!==''));
  const sel=$('grafico-seletor');
  if(!disponiveis.length){ sel.innerHTML=''; $('modal-grafico').classList.add('show'); return; }
  if(!disponiveis.some(c=>c.k===_labCampoAtivo)) _labCampoAtivo=disponiveis[0].k;
  sel.innerHTML=disponiveis.map(c=>`<button class="${c.k===_labCampoAtivo?'ativo':''}" onclick="_plotLab('${c.k}')">${c.l}</button>`).join('');
  $('modal-grafico').classList.add('show');
  setTimeout(()=>_plotLab(_labCampoAtivo),60);
}
function _plotLab(k){
  _labCampoAtivo=k;
  document.querySelectorAll('#grafico-seletor button').forEach(b=>b.classList.toggle('ativo', b.textContent===(LAB_CAMPOS.find(c=>c.k===k)||{}).l));
  const ordenadas=[..._labLinhas].filter(l=>l.data).sort((a,b)=>a.data.localeCompare(b.data));
  const labels=ordenadas.map(l=>_fmtDataCurta(l.data));
  const dados=ordenadas.map(l=>{ const v=l.valores&&l.valores[k]; return (v===''||v==null)?null:Number(v); });
  const lbl=(LAB_CAMPOS.find(c=>c.k===k)||{}).l||k;
  const ctx=$('lab-chart').getContext('2d');
  if(_labChart) _labChart.destroy();
  _labChart=new Chart(ctx,{
    type:'line',
    data:{ labels, datasets:[{ label:lbl, data:dados, borderColor:'#7a1020', backgroundColor:'rgba(122,16,32,.12)',
      borderWidth:2.5, tension:.25, pointRadius:5, pointBackgroundColor:'#9c1b2e', spanGaps:true, fill:true }]},
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{display:true,labels:{font:{size:13,weight:'bold'},color:'#7a1020'}},
        tooltip:{callbacks:{label:c=>` ${lbl}: ${c.parsed.y}`}}},
      scales:{ y:{beginAtZero:false,grid:{color:'#eee'}}, x:{grid:{display:false}} } }
  });
}

/* ════════════════════════════════════════════════════════════════════════════
   CULTURAS — busca completa idêntica ao sistema de enfermagem
   ─ action:'culturas'         <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M3 8h10"/><path d="M9.5 4.5L13 8l-3.5 3.5"/></svg> por paciente (com antibiograma dos PDFs)
   ─ action:'culturas_agregado'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M3 8h10"/><path d="M9.5 4.5L13 8l-3.5 3.5"/></svg> panorama CCIH institucional
   ─ Classificação MDR/XDR/PDR (Magiorakos simplificado)
   ════════════════════════════════════════════════════════════════════════════ */

// Helper genérico para o Apps Script
async function _apsFetch(payload){
  if(!APPS_SCRIPT_URL) throw new Error('APPS_SCRIPT_URL não configurada.');
  const resp=await fetch(APPS_SCRIPT_URL,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify(payload)});
  const txt=await resp.text();
  try{ return JSON.parse(txt); }catch(e){ throw new Error('Resposta inválida do Apps Script: '+txt.slice(0,200)); }
}

// ── Chips de cultura no formulário ──────────────────────────────────────────
function _renderCulturasChips(){
  const wrap=$('culturas-chips'); if(!wrap) return;
  if(!_culturasForm.length){ wrap.innerHTML='<span style="font-size:.76rem;color:var(--muted);">Nenhuma cultura registrada.</span>'; _sincronizarMicroorg(); return; }
  wrap.innerHTML=_culturasForm.map((c,i)=>{
    const pos=c.micro&&!/negativ|contaminad|pendente|ausencia/i.test(c.resultado||c.sens||'');
    const cls=_cultChipCor(c.micro||'');
    const mdr=c.antibiograma?` · ${_cultClassificar(c.antibiograma)}`:'';
    const txt=`${c.micro||c.resultado||'?'}${c.sitio?' · '+c.sitio:''}${c.sens?' · '+c.sens.slice(0,40):''}${mdr}${c.data?' · '+_fmtDataCurta(c.data):''}`;
    return `<span class="cult-chip ${pos?'pos':''}" style="${cls}"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><circle cx="8" cy="8" r="4"/><circle cx="8" cy="8" r="1.5"/><line x1="8" y1="2" x2="8" y2="4"/><line x1="12.2" y1="3.8" x2="10.8" y2="5.2"/><line x1="14" y1="8" x2="12" y2="8"/><line x1="3.8" y1="3.8" x2="5.2" y2="5.2"/><line x1="2" y1="8" x2="4" y2="8"/><line x1="3.8" y1="12.2" x2="5.2" y2="10.8"/><line x1="12.2" y1="12.2" x2="10.8" y2="10.8"/></svg> ${txt}<span class="x" onclick="_removerCultura(${i})" title="Remover">×</span></span>`;
  }).join('');
  _sincronizarMicroorg();
}
function _removerCultura(i){ _culturasForm.splice(i,1); _renderCulturasChips(); }
function _adicionarCultura(sitio,micro,sens,data,fonte,antibiograma){
  if(_culturasForm.some(c=>c.micro===micro&&c.sitio===sitio&&c.data===data)) return;
  _culturasForm.push({sitio,micro,sens,data,fonte:fonte||'manual',antibiograma:antibiograma||null});
  _renderCulturasChips();
}
function _sincronizarMicroorg(){
  const s=_culturasForm.filter(c=>c.micro).map(c=>`${c.micro}${c.sitio?' ('+c.sitio+')':''}`).join('; ');
  const el=$('f-microorg'); if(el) el.value=s;
}
function _cultChipCor(nome){
  const n=(nome||'').toUpperCase();
  if(n.includes('KPC')||n.includes('NDM')) return 'border-color:#b71c1c;background:#fde8e6;color:#b71c1c;';
  if(n.includes('MRSA')||n.includes('VRE')||n.includes('ESBL')||n.includes('BAUMANNII')) return 'border-color:#e65100;background:#fff3e0;color:#e65100;';
  if(n.includes('KLEBSIELLA')||n.includes('PSEUDOMONAS')) return 'border-color:#1565c0;background:#e3f0ff;color:#1565c0;';
  if(n.includes('CANDIDA')||n.includes('ASPERGILLUS')) return 'border-color:#6a1b9a;background:#f3e5f5;color:#6a1b9a;';
  return '';
}

// ── Adição manual ────────────────────────────────────────────────────────────
function abrirAddCulturaManual(){ $('add-cultura-inline').style.display='block'; sf('ac-data',hoje()); }
function confirmarAddCulturaManual(){
  const micro=gf('ac-micro').trim();
  if(!micro){ toast('Informe o microrganismo.',true); return; }
  _adicionarCultura(gf('ac-sitio').trim(),micro,gf('ac-sens').trim(),gf('ac-data'),'manual',null);
  ['ac-sitio','ac-micro','ac-sens'].forEach(id=>sf(id,''));
  $('add-cultura-inline').style.display='none';
}

// ── Busca automática ao abrir o formulário (silenciosa) ──────────────────────
async function _buscarCulturasAuto(paciente,leito){
  const el=$('culturas-auto');
  if(!el||!paciente||!APPS_SCRIPT_URL||!CULTURAS_SHEET_ID) return;
  el.style.display='block';
  el.innerHTML='<span style="font-size:.72rem;color:var(--muted);"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><rect x="7" y="2" width="2.5" height="6" rx=".8" transform="rotate(30 8 5)"/><line x1="8" y1="10" x2="8" y2="13"/><line x1="5" y1="13" x2="11" y2="13"/><circle cx="8" cy="7" r="1.5"/></svg> Buscando culturas...</span>';
  try{
    const data=await _apsFetch({action:'culturas',paciente:_normalizarNome(paciente),leito,sheetId:CULTURAS_SHEET_ID});
    const positivos=(data.resultados||[]).filter(r=>r.microorg&&!/negativ|contaminad|pendente/i.test(r.resultado||''));
    if(!positivos.length){ el.innerHTML=''; el.style.display='none'; return; }
    positivos.forEach(r=>_adicionarCultura(r.cultura||'',r.microorg||'',r.sensibilidade||'',
      r.dataResultado||r.dataRecebimento||'','planilha',r.antibiograma||null));
    el.innerHTML=`<span style="font-size:.72rem;color:var(--verde);font-weight:600;"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M2.5 8.5l3.5 3.5 7.5-7.5"/></svg> ${positivos.length} cultura(s) positiva(s) importada(s) da planilha</span>`;
    setTimeout(()=>{ el.style.display='none'; },4000);
  }catch(e){ el.innerHTML=''; el.style.display='none'; console.warn('[Culturas auto]',e); }
}

// ── Modal completo de busca por paciente ─────────────────────────────────────
async function buscarCulturas(){
  if(!leitoAtual){ toast('Abra uma evolução primeiro.',true); return; }
  const pac=gf('f-pac').trim();
  if(!pac){ toast('Preencha o nome do paciente primeiro.',true); return; }
  if(!APPS_SCRIPT_URL||!CULTURAS_SHEET_ID){
    $('culturas-conteudo').innerHTML='<div class="tip w">Configure <code>APPS_SCRIPT_URL</code> e <code>CULTURAS_SHEET_ID</code> no index.html. Use "<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M11 2.5l2.5 2.5-7.5 7.5L3.5 15l2.5-2.5z"/><line x1="9.5" y1="4" x2="12" y2="6.5"/></svg>️ Adicionar manual" enquanto isso.</div>';
    $('modal-culturas').classList.add('show'); return;
  }
  const cont=$('culturas-conteudo');
  cont.innerHTML=`<div class="sae-loading"><div class="sae-spinner"></div><p>Buscando culturas de <strong>${pac}</strong>…<br><span style="font-size:.72rem;color:var(--muted);">Pode levar 30–60 s (extração de PDFs).</span></p></div>`;
  $('modal-culturas').classList.add('show');
  try{
    const data=await _apsFetch({action:'culturas',paciente:_normalizarNome(pac),leito:leitoAtual,sheetId:CULTURAS_SHEET_ID});
    if(data.error) throw new Error(data.error);
    cont.innerHTML=_renderCulturasModal(data.resultados||[],data.pacienteEncontrado||'');
  }catch(e){ cont.innerHTML=`<div class="tip d">Erro ao buscar: ${e.message||e}</div>`; }
}

function _renderCulturasModal(res,nomePlanilha){
  const pos=res.filter(r=>r.microorg&&!/negativ|contaminad|pendente/i.test(r.resultado||''));
  const neg=res.filter(r=>!pos.includes(r));
  let h='';
  if(nomePlanilha) h+=`<div style="font-size:.72rem;color:var(--muted);margin-bottom:8px;">Paciente na planilha: <strong>${nomePlanilha}</strong></div>`;
  if(!res.length){ h+='<div class="tip i">Nenhum resultado para este paciente na planilha.</div>'; return h; }
  if(pos.length){
    h+='<div class="ind-sec-titulo">Positivas</div>';
    h+=pos.map(r=>{
      const cls=_cultClassificar(r.antibiograma);
      const corBg=cls==='XDR'||cls==='PDR'?'#b71c1c':cls==='MDR'?'#e65100':'#555';
      let atbHtml='';
      if(r.antibiograma&&r.antibiograma.length){
        const R_=r.antibiograma.filter(a=>a.resultado==='RESISTENTE').slice(0,4);
        const S_=r.antibiograma.filter(a=>a.resultado==='SENSÍVEL').slice(0,4);
        if(R_.length||S_.length) atbHtml=`<div style="font-size:.7rem;margin-top:5px;display:flex;gap:6px;flex-wrap:wrap;">
          ${R_.map(a=>`<span style="background:#fde8e6;color:#b71c1c;padding:1px 6px;border-radius:6px;font-weight:600;">R: ${a.atb}</span>`).join('')}
          ${S_.map(a=>`<span style="background:#e6f4ec;color:var(--verde);padding:1px 6px;border-radius:6px;font-weight:600;">S: ${a.atb}</span>`).join('')}
        </div>`;
      }
      const antibjson=r.antibiograma?JSON.stringify(r.antibiograma):'null';
      return `<div style="border:1px solid #f3c2bd;background:#fde8e6;border-radius:9px;padding:8px 10px;margin-bottom:6px;">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:6px;">
          <strong style="color:var(--vermelho);"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><circle cx="8" cy="8" r="4"/><circle cx="8" cy="8" r="1.5"/><line x1="8" y1="2" x2="8" y2="4"/><line x1="12.2" y1="3.8" x2="10.8" y2="5.2"/><line x1="14" y1="8" x2="12" y2="8"/><line x1="3.8" y1="3.8" x2="5.2" y2="5.2"/><line x1="2" y1="8" x2="4" y2="8"/><line x1="3.8" y1="12.2" x2="5.2" y2="10.8"/><line x1="12.2" y1="12.2" x2="10.8" y2="10.8"/></svg> ${r.microorg}</strong>
          ${cls?`<span style="font-size:.62rem;font-weight:700;padding:2px 7px;border-radius:8px;background:${corBg};color:white;">${cls}</span>`:''}
        </div>
        <div style="font-size:.74rem;color:var(--muted);margin-top:2px;">${r.cultura||'?'}${r.dataResultado?' · '+r.dataResultado:''}</div>
        ${r.sensibilidade?`<div style="font-size:.72rem;margin-top:3px;">${r.sensibilidade.slice(0,120)}</div>`:''}
        ${atbHtml}
        <button class="btn btn-pri btn-sm" style="margin-top:6px;"
          onclick='_adicionarCulturaModal(${JSON.stringify(r.cultura||"")},${JSON.stringify(r.microorg||"")},${JSON.stringify(r.sensibilidade||"")},${JSON.stringify(r.dataResultado||r.dataRecebimento||"")},${antibjson})'>
          + Registrar na evolução
        </button>
      </div>`;
    }).join('');
  } else { h+='<div class="tip i">Nenhuma cultura positiva encontrada para este paciente.</div>'; }
  if(neg.length) h+=`<details style="margin-top:8px;"><summary style="cursor:pointer;font-size:.76rem;color:var(--muted);">Negativas/pendentes (${neg.length})</summary>`+
    neg.map(r=>`<div style="font-size:.74rem;padding:4px 0;border-bottom:1px solid var(--borda);">${r.cultura||'?'} · ${r.dataResultado||'—'} — ${r.resultado||'pendente'}</div>`).join('')+'</details>';
  return h;
}
function _adicionarCulturaModal(sitio,micro,sens,data,antibiograma){
  _adicionarCultura(sitio,micro,sens,data,'planilha',antibiograma);
  toast('Cultura registrada.');
}

// ── Classificação MDR/XDR/PDR (Magiorakos simplificado) ─────────────────────
const _CLASSES_ATB={
  'amoxicilina':'Penicilinas','ampicilina':'Penicilinas','oxacilina':'Penicilinas',
  'piperacilina-tazobactam':'Penicilinas+Inh','ampicilina-sulbactam':'Penicilinas+Inh','amoxicilina-clavulanato':'Penicilinas+Inh',
  'cefazolina':'Cefalosporinas1G','cefoxitina':'Cefalosporinas2G',
  'ceftriaxona':'Cefalosporinas3G','cefotaxima':'Cefalosporinas3G','ceftazidima':'Cefalosporinas3G',
  'cefepima':'Cefalosporinas4G','ceftazidima-avibactam':'Cefalosporinas+Inh','ceftolozana-tazobactam':'Cefalosporinas+Inh',
  'ertapenem':'Carbapenêmicos','imipenem':'Carbapenêmicos','meropenem':'Carbapenêmicos','doripenem':'Carbapenêmicos',
  'aztreonam':'Monobactâmicos',
  'ciprofloxacino':'Fluoroquinolonas','levofloxacino':'Fluoroquinolonas','moxifloxacino':'Fluoroquinolonas',
  'gentamicina':'Aminoglicosídeos','amicacina':'Aminoglicosídeos','tobramicina':'Aminoglicosídeos',
  'vancomicina':'Glicopeptídeos','teicoplanina':'Glicopeptídeos',
  'linezolida':'Oxazolidinona','daptomicina':'Lipopeptídeos',
  'tigeciclina':'Tetraciclinas','doxiciclina':'Tetraciclinas',
  'colistina':'Polimixinas','polimixina b':'Polimixinas',
  'sulfametoxazol-trimetoprima':'Sulfonamidas',
  'fluconazol':'Azóis','voriconazol':'Azóis','itraconazol':'Azóis',
  'anfotericina b':'Poliênicos','micafungina':'Equinocandinas','caspofungina':'Equinocandinas',
};
function _classeAtb(nome){
  const k=(nome||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();
  if(_CLASSES_ATB[k]) return _CLASSES_ATB[k];
  for(const ch in _CLASSES_ATB){ if(k.includes(ch)||ch.includes(k)) return _CLASSES_ATB[ch]; }
  return 'Outros';
}
function _cultClassificar(antibiograma){
  if(!antibiograma||!antibiograma.length) return '';
  const R=new Set(),T=new Set();
  antibiograma.forEach(a=>{ const c=_classeAtb(a.atb); T.add(c); if(a.resultado==='RESISTENTE') R.add(c); });
  const nR=R.size,nT=T.size;
  if(nR===0) return 'Sensível';
  if(nR>=nT&&nT>=3) return 'PDR';
  if(nR>=5) return 'XDR';
  if(nR>=3) return 'MDR';
  return 'Resistente';
}

// ── Panorama CCIH agregado (indicadores) ─────────────────────────────────────
let _culturasAgregadoCache=null;
async function _ccihCarregarAgregado(forcar,maxAbas){
  if(_culturasAgregadoCache&&!forcar){ renderIndicadores(); return; }
  if(!APPS_SCRIPT_URL||!CULTURAS_SHEET_ID){ toast('Configure APPS_SCRIPT_URL e CULTURAS_SHEET_ID para o panorama CCIH.',true); return; }
  const nAbas=maxAbas||3, nPDFs=nAbas<=3?20:nAbas<=6?35:50;
  const c=$('ind-conteudo');
  c.innerHTML=`<div style="text-align:center;padding:60px 20px;">
    <div class="sae-spinner" style="border-top-color:var(--vinho);margin:0 auto 16px;"></div>
    <div style="font-weight:700;color:var(--vinho);"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><rect x="2" y="4" width="12" height="10" rx="1"/><path d="M2 7h12"/><line x1="6" y1="10" x2="10" y2="10"/><line x1="8" y1="8" x2="8" y2="12"/><path d="M5 4V3h6v1"/></svg> Buscando panorama institucional CCIH...</div>
    <div style="font-size:.74rem;color:var(--muted);margin-top:6px;">${nAbas} meses · até ${nPDFs} antibiogramas. Aguarde ${nAbas<=3?'30–60':'60–120'} s.</div>
  </div>`;
  try{
    const data=await _apsFetch({action:'culturas_agregado',sheetId:CULTURAS_SHEET_ID,maxAbas:nAbas,maxPDFs:nPDFs});
    if(data.error) throw new Error(data.error);
    data._maxAbas=nAbas; _culturasAgregadoCache=data;
    renderIndicadores();
    toast(`<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M2.5 8.5l3.5 3.5 7.5-7.5"/></svg> ${data.totalCulturas} culturas · ${data.pdfsExtraidos} antibiogramas`);
  }catch(e){
    console.error('[CCIH agregado]',e);
    c.innerHTML=`<div class="tip d"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><circle cx="8" cy="8" r="6"/><line x1="5.5" y1="5.5" x2="10.5" y2="10.5"/><line x1="10.5" y1="5.5" x2="5.5" y2="10.5"/></svg> Erro: ${e.message}. <button onclick="_ccihCarregarAgregado(true)" class="btn btn-sm">Tentar novamente</button></div>`;
  }
}
function _ccihLimparAgregado(){ _culturasAgregadoCache=null; renderIndicadores(); }



/* ════════════════════════════════════════════════════════════════════════════
   SAPS — MODAL DE ITENS (atalho dentro do formulário)
   ════════════════════════════════════════════════════════════════════════════ */
function abrirModalSAPS(){
  // Auto-deriva itens possíveis a partir do quadro atual antes de exibir
  _itensSAPS = _autoPreencherItensSAPS(_itensSAPS);
  $('saps-modal-body').innerHTML = _htmlAvisoAuto() + _htmlItensSAPS(_itensSAPS);
  $('modal-saps').classList.add('show');
}

// Pré-marca o que é possível inferir do quadro. Não sobrescreve o que o médico
// já marcou manualmente (só preenche campos ainda vazios/não definidos).
function _autoPreencherItensSAPS(it){
  it = JSON.parse(JSON.stringify(it||{}));
  it.comorb = it.comorb || {};
  it.motivo = it.motivo || {};
  it._auto = {}; // registra o que foi auto-preenchido (para sinalizar na UI)

  // Lê do formulário de evolução OU do modal de admissão (o que estiver presente)
  const pick=(idForm,idModal)=>{ const m=$(idModal); if(m && m.value!=='') return m.value; return gf(idForm); };
  const dva  = pick('f-dva','m-dva') || gf('f-dva');
  const vent = gf('f-vent');                       // só existe no formulário
  const diag = (pick('f-diag','m-diag')||'').toUpperCase();
  const comor= (pick('f-comor','m-comor')||'').toUpperCase();
  const atb  = (gf('f-atb')||'').toUpperCase();
  const gVal = (function(){ const m=$('m-glasgow'); if(m&&m.value!=='') return m.value; return gf('f-glasgow'); })();

  // Vasoativa pré-UTI: se está em DVA agora e o campo nunca foi definido
  if(it.vasoPrevia===undefined && dva==='SIM'){ it.vasoPrevia=true; it._auto.vasoPrevia=1; }

  // Infecção respiratória na admissão: pista por ventilação invasiva + ATB, ou diagnóstico
  if(!it.infResp && /PNEUMONIA|PAC|PAV|RESPIRAT[ÓO]RI|SDRA|INSUF.*RESP/.test(diag)){ it.infResp=true; it._auto.infResp=1; }

  // Infecção nosocomial / choque séptico: pista por diagnóstico de sepse
  if(/SEPSE|SEPTIC|CHOQUE S[ÉE]PTICO/.test(diag)){
    if(!it.motivo.choqueSeptico && /CHOQUE S[ÉE]PTICO/.test(diag)){ it.motivo.choqueSeptico=true; it._auto.choqueSeptico=1; }
  }

  // Comorbidades: tenta inferir das comorbidades textuais da admissão
  if(!it.comorb.icc4 && /NYHA IV|IC.*CLASSE IV|INSUF.*CARD[ÍI]ACA.*IV/.test(comor)){ it.comorb.icc4=true; it._auto.icc4=1; }
  if(!it.comorb.cirrose && /CIRROSE/.test(comor)){ it.comorb.cirrose=true; it._auto.cirrose=1; }
  if(!it.comorb.cancerMeta && /METAST/.test(comor)){ it.comorb.cancerMeta=true; it._auto.cancerMeta=1; }
  if(!it.comorb.aids && /\b(SIDA|HIV|AIDS)\b/.test(comor)){ it.comorb.aids=true; it._auto.aids=1; }

  // Coma: pista por Glasgow baixo
  if(gVal!=='' && gVal!=null && Number(gVal)<10 && !it.motivo.coma){ it.motivo.coma=true; it._auto.coma=1; }

  return it;
}
function _htmlAvisoAuto(){
  const a=_itensSAPS._auto||{};
  const n=Object.keys(a).length;
  if(!n) return '<div class="tip i" style="margin-bottom:10px;">A <strong>idade</strong> já entra automaticamente no escore a partir da DN. Marque os demais itens conforme a admissão.</div>';
  return `<div class="tip w" style="margin-bottom:10px;"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 2v3M8 11v3M2 8h3M11 8h3"/><path d="M4.2 4.2l2 2M9.8 9.8l2 2M4.2 11.8l2-2M9.8 6.2l2-2"/><circle cx="8" cy="8" r="1.5"/></svg> <strong>${n} item(ns) pré-marcado(s) automaticamente</strong> a partir do quadro (DVA, ventilação, diagnóstico, Glasgow, comorbidades). <strong>Revise e ajuste</strong> — você é responsável pela conferência. A idade já entra pela DN.</div>`;
}
function salvarItensSAPS(){
  // os ids no modal SAPS são os mesmos (sa-*) — reusa o coletor
  const it=_coletarItensSAPSdoModal();
  if(it) _itensSAPS=it;
  $('modal-saps').classList.remove('show');
  _recalcSAPS();
  toast('Itens de admissão aplicados ao SAPS 3.');
}

/* ════════════════════════════════════════════════════════════════════════════
   CID-10 (sugestão via Apps Script/IA, se configurado)
   ════════════════════════════════════════════════════════════════════════════ */
async function _sugerirCID(idDiag,idCid){
  const diag=gf(idDiag).trim(); if(!diag||gf(idCid).trim()) return;
  if(!APPS_SCRIPT_URL) return;
  const st=$('f-cid-status'); if(st) st.textContent='…';
  // cache local
  try{
    const cache=JSON.parse(localStorage.getItem('uti_med_cid_cache')||'{}');
    const key=_normalizarNome(diag);
    if(cache[key]){ sf(idCid,cache[key]); if(st) st.innerHTML='<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M2.5 8.5l3.5 3.5 7.5-7.5"/></svg> cache'; return; }
    const resp=await fetch(APPS_SCRIPT_URL,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},
      body:JSON.stringify({action:'cid',diagnostico:diag})});
    const data=JSON.parse(await resp.text());
    if(data.codigo){ sf(idCid,data.codigo); cache[key]=data.codigo; localStorage.setItem('uti_med_cid_cache',JSON.stringify(cache)); if(st) st.innerHTML='<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M2.5 8.5l3.5 3.5 7.5-7.5"/></svg> IA'; }
    else if(st) st.textContent='';
  }catch(e){ if(st) st.textContent=''; }
}

/* ════════════════════════════════════════════════════════════════════════════
   RESUMO ESTRUTURADO (monta texto a partir dos campos — sem IA)
   ════════════════════════════════════════════════════════════════════════════ */
function _montarTextoEstruturado(d){
  const idade=_idadeDeDN(d.dn);
  const p=[];
  p.push(`Paciente ${d.pac}${idade!=null?', '+idade+' anos':''}${d.sexo?', '+d.sexo.toLowerCase():''}, em ${d.diag||'investigação diagnóstica'}.`);
  if(d.evol) p.push(d.evol);
  const sv=[];
  if(d.pam) sv.push(`PAM ${d.pam} mmHg`); if(d.fc) sv.push(`FC ${d.fc} bpm`);
  if(d.fr) sv.push(`FR ${d.fr} irpm`); if(d.tmax) sv.push(`Tmáx ${d.tmax}°C`);
  if(d.spo2) sv.push(`SpO₂ ${d.spo2}%`);
  if(sv.length) p.push('Controles 24h: '+sv.join(', ')+'.');
  if(d.bh||d.diurese) p.push(`Balanço hídrico ${d.bh||'—'}; diurese ${d.diurese||'—'}.`);
  const ef=[];
  if(d.neuro) ef.push('Neuro: '+d.neuro); if(d.acv) ef.push('ACV: '+d.acv);
  if(d.ar) ef.push('AR: '+d.ar); if(d.abd) ef.push('ABD: '+d.abd); if(d.ext) ef.push('EXT: '+d.ext);
  if(ef.length) p.push('Ao exame: '+ef.join('; ')+'.');
  if(d.vent && d.vent!=='AA') p.push(`Suporte ventilatório: ${_ventTexto(d.vent)}${d.ventParam?' ('+d.ventParam+')':''}.`);
  if(d.dva==='SIM') p.push('Em uso de droga vasoativa'+(d.dvaQual?' ('+d.dvaQual+')':'')+'.'); 
  if(d.atb && !/sem atb/i.test(d.atb)) p.push('Antibioticoterapia: '+d.atb+'.');
  if(d.microorg) p.push('Culturas: '+d.microorg+'.');
  if(d.condutas) p.push('Condutas: '+d.condutas);
  return p.join(' ');
}
function _ventTexto(v){ return ({AA:'ar ambiente',CN:'cateter nasal de O₂',CTNO2:'cateter de alto fluxo',VM:'máscara de O₂',VNI:'ventilação não invasiva',VMI:'ventilação mecânica invasiva'})[v]||v; }

/* ════════════════════════════════════════════════════════════════════════════
   PREVIEW & IMPRESSÃO
   ════════════════════════════════════════════════════════════════════════════ */
function abrirPreview(){
  const d=coletarDados();
  const r=_recalcSAPS();
  const idade=_idadeDeDN(d.dn);
  const assinatura = perfilUsuario ? `${perfilUsuario.nome}${perfilUsuario.crm?' · CRM '+perfilUsuario.crm:''}` : (usuarioEmail||'');
  const cult = d.culturas&&d.culturas.length ? d.culturas.map(c=>`${c.micro||c.resultado}${c.sitio?' ('+c.sitio+')':''}`).join('; ') : '—';
  const labTab = _labParaTabela(d.labLinhas);
  $('preview-conteudo').innerHTML=`
    <div style="text-align:center;margin-bottom:.4rem;"><img src="logo.png" alt="" style="max-height:64px;width:auto;" onerror="this.style.display='none'"></div>
    <h1>EVOLUÇÃO MÉDICA — UTI GERAL</h1>
    <div class="pv-sub">Hospital dos Pescadores · ${d.turno} · ${_fmtDataCurta(d.data)}</div>
    <table>
      <tr><th>Paciente</th><td>${d.pac||'—'}</td><th>Idade/DN</th><td>${idade!=null?idade+'a':''} ${d.dn?'· '+_fmtDataCurta(d.dn):''}</td></tr>
      <tr><th>Leito</th><td>${pad(d.leito)}</td><th>Adm. UTI</th><td>${_fmtDataCurta(d.adm)||'—'}</td></tr>
      <tr><th>Hipóteses</th><td colspan="3">${d.diag||'—'} ${d.cid?'('+d.cid+')':''}</td></tr>
      <tr><th>Comorbidades</th><td colspan="3">${d.comor||'—'}</td></tr>
      <tr><th>Alergias</th><td>${d.alergia||'—'}</td><th>ATB</th><td>${d.atb||'—'}</td></tr>
    </table>
    ${d.hda?`<div class="pv-secao">HDA</div><div>${d.hda}</div>`:''}
    ${d.admDesc?`<div class="pv-secao">Admissão na UTI</div><div>${d.admDesc}</div>`:''}
    <div class="pv-secao">Evolução do Plantão</div><div>${d.evol||'—'}</div>
    <div class="pv-secao">Controles 24h</div>
    <table>
      <tr><th>PAM</th><td>${d.pam||'—'}</td><th>FC</th><td>${d.fc||'—'}</td><th>FR</th><td>${d.fr||'—'}</td></tr>
      <tr><th>Tmáx</th><td>${d.tmax||'—'}</td><th>SpO₂</th><td>${d.spo2||'—'}</td><th>HGT</th><td>${d.hgt||'—'}</td></tr>
      <tr><th>BH 24h</th><td>${d.bh||'—'}</td><th>Diurese</th><td>${d.diurese||'—'}</td><th>Evac.</th><td>${d.evac||'—'}</td></tr>
    </table>
    <div class="pv-secao">Exame Físico</div>
    <div>${[['Ecto',d.ecto],['Neuro',d.neuro],['Pupilas',d.pupilas],['ACV',d.acv],['AR',d.ar],['ABD',d.abd],['EXT',d.ext],['Pele',d.pele]].filter(x=>x[1]).map(x=>`<strong>${x[0]}:</strong> ${x[1]}`).join(' · ')||'—'}</div>
    <div class="pv-secao">Dispositivos & Suporte</div>
    <div>Acessos: ${d.acessos||'—'} · Dispositivos: ${d.dispositivos||'—'} · Dieta: ${d.dieta||'—'} · DVA: ${d.dva==='SIM'?'Sim'+(d.dvaQual?' ('+d.dvaQual+')':''):'Não'} · Ventilação: ${_ventTexto(d.vent)}${d.ventParam?' ('+d.ventParam+')':''}</div>
    ${d.gaso?`<div class="pv-secao">Gasometria</div><div>${d.gaso}</div>`:''}
    <div class="pv-secao">Culturas</div><div>${cult}</div>
    ${labTab?`<div class="pv-secao">Exames Laboratoriais</div>${labTab}`:''}
    ${d.imagem?`<div class="pv-secao">Exames de Imagem</div><div>${d.imagem}</div>`:''}
    <div class="pv-secao">SAPS 3</div>
    <div>Escore: <strong>${r.score}</strong> pontos · Mortalidade prevista (Am. do Sul): <strong>${r.temDados?(r.mortCSA*100).toFixed(1)+'%':'—'}</strong>${r.temDados?' · global: '+(r.mortGlobal*100).toFixed(1)+'%':''}</div>
    <div class="pv-secao">Condutas</div><div>${d.condutas ? d.condutas.split('\n').map(l=>l.trim()).filter(Boolean).map(l=>`<div style="margin:2px 0;">${l}</div>`).join('') : '—'}</div>
    <div class="pv-assinatura" style="margin-top:2.5rem;"><div class="linha"></div>${assinatura}<br><span style="font-size:.68rem;color:#888;">Evolução médica · ${_fmtDataCurta(d.data)} ${agoraHora()}</span></div>
  `;
  $('modal-preview').classList.add('show');
}
function _labParaTabela(linhas){
  if(!linhas||!linhas.length) return '';
  const ord=[...linhas].filter(l=>l.data).sort((a,b)=>a.data.localeCompare(b.data));
  if(!ord.length) return '';
  const usados=LAB_CAMPOS.filter(c=>ord.some(l=>l.valores&&l.valores[c.k]!=null&&l.valores[c.k]!==''));
  const temOutros = ord.some(l=>l.outros&&l.outros.trim());
  if(!usados.length && !temOutros) return '';
  let h='<table><tr><th>Data</th>'+usados.map(c=>`<th>${c.l}</th>`).join('')+(temOutros?'<th>Outros</th>':'')+'</tr>';
  ord.forEach(l=>{
    h+=`<tr><td>${_fmtDataCurta(l.data)}</td>`
      +usados.map(c=>`<td>${(l.valores&&l.valores[c.k]!=null)?l.valores[c.k]:'—'}</td>`).join('')
      +(temOutros?`<td style="font-size:7.5pt;">${l.outros||'—'}</td>`:'')
      +'</tr>';
  });
  return h+'</table>';
}
function imprimirEvolucao(){
  // garante que o modal esteja visível e renderizado antes de imprimir
  const modal = $('modal-preview');
  if(modal && !modal.classList.contains('show')) modal.classList.add('show');
  // define um título amigável para o nome do PDF salvo
  const tituloOrig = document.title;
  const pac = (gf('f-pac')||'PACIENTE').trim();
  document.title = `Evolução ${pad(leitoAtual||0)} - ${pac} - ${_fmtDataCurta(gf('f-data')||hoje())}`;
  const restaurar = ()=>{ document.title = tituloOrig; window.removeEventListener('afterprint', restaurar); };
  window.addEventListener('afterprint', restaurar);
  // pequeno atraso para o navegador pintar o conteúdo do modal
  setTimeout(()=>{ window.print(); }, 120);
}

/* ── CAIXA ALTA AUTOMÁTICA (campos de texto, exceto data/número) ──────────── */
function _autoResizeTA(el){
  if(!el||el.tagName!=='TEXTAREA'||el.hasAttribute('readonly')) return;
  el.style.height='auto';
  el.style.height=el.scrollHeight+'px';
}

function _ativarCaixaAlta(){
  const sel='#t-form input[type=text], #t-form textarea, #modal-adm input[type=text], #modal-adm textarea, #modal-trilogy input[type=text], #modal-trilogy textarea, #modal-me textarea, #modal-termo input[type=text], #modal-termo textarea, #modal-parecer input[type=text], #modal-parecer textarea, #modal-diarista-ev textarea';
  document.querySelectorAll(sel).forEach(el=>{
    if(el.id==='f-evol-diarista') return;
    if(el.dataset.upperBound) return; el.dataset.upperBound='1';
    el.addEventListener('input',function(){
      const p=this.selectionStart; const up=this.value.toUpperCase();
      if(this.value!==up){ this.value=up; try{this.setSelectionRange(p,p);}catch(_){} }
      _autoResizeTA(this);
    });
  });
}

// Ajusta altura de TODOS os textareas visíveis do formulário após renderização
function _resizeTodosTextareas(){
  // Duplo rAF: primeiro garante que o DOM foi pintado,
  // segundo cobre casos de layout tardio (fontes, imagens inline)
  requestAnimationFrame(()=>{
    requestAnimationFrame(()=>{
      document.querySelectorAll('#t-form textarea, #modal-adm textarea, #modal-trilogy textarea, #modal-me textarea, #modal-termo textarea, #modal-parecer textarea, #modal-diarista-ev textarea').forEach(el=>{
        if(!el.hasAttribute('readonly')) _autoResizeTA(el);
      });
    });
  });
  // Fallback com delay para navegadores lentos
  setTimeout(()=>{
    document.querySelectorAll('#t-form textarea, #modal-adm textarea, #modal-trilogy textarea, #modal-me textarea, #modal-termo textarea, #modal-parecer textarea, #modal-diarista-ev textarea').forEach(el=>{
      if(!el.hasAttribute('readonly')) _autoResizeTA(el);
    });
  }, 200);
}

/* Resize todos os textareas dentro de um modal específico após abri-lo */
function _resizeModalTextareas(modalId){
  const modal = document.getElementById(modalId);
  if(!modal) return;
  const resize = () => modal.querySelectorAll('textarea').forEach(el=>{
    if(!el.hasAttribute('readonly')) _autoResizeTA(el);
  });
  requestAnimationFrame(()=>{ requestAnimationFrame(resize); });
  setTimeout(resize, 200);
  // Garante que inputs de caixa alta estão registrados neste modal
  _ativarCaixaAlta();
}


/* ════════════════════════════════════════════════════════════════════════════
   GESTÃO DE USUÁRIOS (admin)
   ════════════════════════════════════════════════════════════════════════════ */
async function abrirGerenciarUsuarios(){ if(!_isAdmin()){ toast('Acesso restrito.',true); return; } mostrarTela('t-usuarios'); await renderListaUsuarios(); }
async function renderListaUsuarios(){
  const wrap=$('usuarios-lista'); if(!wrap) return;
  wrap.innerHTML='<p style="color:var(--muted);padding:1rem;">Carregando...</p>';
  let usuarios=[];
  if(db){ try{ const snap=await db.collection('usuarios_med').get(); usuarios=snap.docs.map(d=>({email:d.id,...d.data()})); }catch(e){} }
  usuarios.forEach(_registrarCachePerfil);
  if(!usuarios.length){ wrap.innerHTML='<p style="color:var(--muted);padding:1rem;">Nenhum médico cadastrado.</p>'; return; }
  wrap.innerHTML=usuarios.map(u=>{
    const adm=ADMIN_EMAILS.includes(u.email);
    return `<div class="usuario-row">
      <div><strong>${u.nome||u.email}</strong>${adm?' <span class="leito-tag">ADMIN</span>':''}<br><span style="font-size:.74rem;color:var(--muted);">${u.email} ${u.crm?'· CRM '+u.crm:''}</span></div>
      ${adm?'':`<button class="btn btn-sm btn-danger" onclick="excluirUsuario('${u.email}')">Excluir</button>`}
    </div>`;
  }).join('');
}
async function adicionarUsuario(){
  const nome=gf('add-nome').trim(), email=gf('add-email').trim().toLowerCase(),
        crm=gf('add-crm').trim(), senha=gf('add-senha').trim(), err=$('add-err');
  err.textContent='';
  if(!nome||!email){ err.textContent='Preencha nome e e-mail.'; return; }
  if(!/\S+@\S+\.\S+/.test(email)){ err.textContent='E-mail inválido.'; return; }
  if(senha.length<6){ err.textContent='Senha provisória precisa de ao menos 6 caracteres.'; return; }
  if(!APPS_SCRIPT_URL){ err.textContent='Cadastro automático requer Apps Script. Cadastre o médico em Authentication no console Firebase e crie o perfil aqui depois.'; }
  try{
    if(APPS_SCRIPT_URL){
      const r=await fetch(APPS_SCRIPT_URL,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},
        body:JSON.stringify({action:'criar_usuario',email,senha})}).then(r=>r.json());
      if(r.status!=='ok'&&!r.jaExiste) throw new Error(r.msg||'Falha ao criar conta.');
    }
    if(db) await db.collection('usuarios_med').doc(email).set({nome:nome.toUpperCase(),crm,role:'medico',ativo:true,senhaTrocada:false,criadoEm:new Date().toISOString(),criadoPor:usuarioEmail});
    toast('<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M2.5 8.5l3.5 3.5 7.5-7.5"/></svg> Médico cadastrado.');
    ['add-nome','add-email','add-crm','add-senha'].forEach(id=>sf(id,''));
    await renderListaUsuarios();
  }catch(e){ err.textContent=e.message||'Erro.'; }
}
async function excluirUsuario(email){
  if(!confirm('Excluir o médico '+email+'?')) return;
  try{ if(db) await db.collection('usuarios_med').doc(email).delete(); delete _cachePerfis[email]; toast('Usuário removido.'); await renderListaUsuarios(); }
  catch(e){ toast('Erro: '+e.message,true); }
}

/* ════════════════════════════════════════════════════════════════════════════
   INDICADORES
   ════════════════════════════════════════════════════════════════════════════ */
const IND_CATS=[
  {id:'ocupacao',  l:'Ocupação'},
  {id:'gravidade', l:'Gravidade (SAPS 3)'},
  {id:'dispositivos',l:'Dispositivos'},
  {id:'culturas',  l:'Culturas / Microbiologia'},
  {id:'diagnosticos',l:'Diagnósticos (CID)'},
];
let _indCatAtiva='ocupacao';
let _indCache={evolucoes:[],admissoes:[],altas:[],leitos:{}};

async function irIndicadores(){
  mostrarTela('t-indicadores');
  $('ind-cats').innerHTML=IND_CATS.map(c=>`<button class="${c.id===_indCatAtiva?'ativo':''}" onclick="_setIndCat('${c.id}')">${c.l}</button>`).join('');
  await _carregarDadosIndicadores();
  renderIndicadores();
}
function _setIndCat(id){ _indCatAtiva=id; document.querySelectorAll('#ind-cats button').forEach(b=>b.classList.toggle('ativo',b.textContent===(IND_CATS.find(c=>c.id===id)||{}).l)); renderIndicadores(); }

async function _carregarDadosIndicadores(){
  showLoading('Carregando indicadores...');
  try{
    const evs=await dbListByPrefix('uti_med_ev_');
    const adm=await dbListByPrefix('uti_med_adm_log_');
    const alt=await dbListByPrefix('uti_med_alta_log_');
    _indCache.evolucoes=Object.values(evs).filter(v=>v&&v.data);
    _indCache.admissoes=Object.values(adm).filter(v=>v);
    _indCache.altas=Object.values(alt).filter(v=>v);
    _indCache.leitos=await _getLeitos();
  }catch(e){ console.warn('indicadores:',e); }
  hideLoading();
}

function _periodoSel(){ return $('ind-periodo-sel').value; }
function _dentroPeriodo(data,per){
  if(!data) return false;
  if(per==='tudo') return true;
  const d=new Date(data+'T00:00:00'), hj=new Date();
  if(per==='hoje') return data===hoje();
  if(per==='7d'){ const lim=new Date(); lim.setDate(lim.getDate()-7); return d>=lim; }
  if(per==='30d'){ const lim=new Date(); lim.setDate(lim.getDate()-30); return d>=lim; }
  if(per==='mesatual') return d.getMonth()===hj.getMonth()&&d.getFullYear()===hj.getFullYear();
  return true;
}

function renderIndicadores(){
  const c=$('ind-conteudo'); const per=_periodoSel();
  if(_indCatAtiva==='ocupacao') c.innerHTML=_indOcupacao(per);
  else if(_indCatAtiva==='gravidade') c.innerHTML=_indGravidade(per);
  else if(_indCatAtiva==='dispositivos') c.innerHTML=_indDispositivos(per);
  else if(_indCatAtiva==='culturas') c.innerHTML=_indCulturas(per);
  else if(_indCatAtiva==='diagnosticos') c.innerHTML=_indDiagnosticos(per);
}

function _card(t,v,s,cor){ return `<div class="ind-card ${cor||'vinho'}"><div class="t">${t}</div><div class="v">${v}</div>${s?`<div class="s">${s}</div>`:''}</div>`; }

function _indOcupacao(per){
  const L=_indCache.leitos; let ocup=0;
  for(let i=1;i<=TOTAL_LEITOS;i++) if(L[i]&&L[i].ocupado) ocup++;
  const taxa=Math.min(100,Math.round(ocup/TOTAL_LEITOS*100));
  // pacientes-dia = leito×dia (convenção ANVISA) a partir das evoluções do período
  const evPer=_indCache.evolucoes.filter(e=>_dentroPeriodo(e.data,per));
  const pacDia=new Set(evPer.map(e=>e.leito+'|'+e.data)).size;
  const admPer=_indCache.admissoes.filter(a=>_dentroPeriodo(a.admUTI,per)).length;
  const altPer=_indCache.altas.filter(a=>_dentroPeriodo(a.dataAlta,per));
  const obitos=altPer.filter(a=>/[óo]bito/i.test(a.tipo||'')).length;
  let h='<div class="ind-cards">';
  h+=_card('Ocupação atual',taxa+'%',`${ocup}/${TOTAL_LEITOS} leitos`, taxa>=90?'vermelho':taxa>=70?'laranja':'verde');
  h+=_card('Pacientes-dia',pacDia,'no período', 'vinho');
  h+=_card('Admissões',admPer,'no período','vinho');
  h+=_card('Altas',altPer.length,`${obitos} óbito(s)`, obitos>0?'laranja':'verde');
  h+='</div>';
  h+='<div class="ind-hint"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M10 2L14 6l-3 3-2-1-4 4-1-1 4-4-1-2z"/><line x1="3" y1="13" x2="7" y2="9"/></svg> Pacientes-dia = pares únicos (leito × dia) com evolução registrada no período (convenção ANVISA). A taxa de ocupação reflete o estado atual dos leitos.</div>';
  return h;
}

function _indGravidade(per){
  const adm=_indCache.admissoes.filter(a=>_dentroPeriodo(a.admUTI,per) && a.saps3!=null);
  if(!adm.length) return '<div class="ind-hint">Sem admissões com SAPS 3 calculado no período.</div>';
  const scores=adm.map(a=>a.saps3);
  const media=Math.round(scores.reduce((s,x)=>s+x,0)/scores.length);
  const mortMedia=adm.reduce((s,a)=>s+(a.mortPrevista||_mortSAPS(a.saps3,'csa')),0)/adm.length;
  // SMR = óbitos observados / óbitos esperados
  const altas=_indCache.altas.filter(a=>_dentroPeriodo(a.dataAlta,per));
  const obs=altas.filter(a=>/[óo]bito/i.test(a.tipo||'')).length;
  const esp=adm.reduce((s,a)=>s+(a.mortPrevista||_mortSAPS(a.saps3,'csa')),0);
  const smr=esp>0?(obs/esp):null;
  // distribuição por faixa de risco
  const faixas={'<20%':0,'20-40%':0,'40-60%':0,'60-80%':0,'>80%':0};
  adm.forEach(a=>{ const m=(a.mortPrevista||_mortSAPS(a.saps3,'csa'))*100;
    if(m<20)faixas['<20%']++; else if(m<40)faixas['20-40%']++; else if(m<60)faixas['40-60%']++; else if(m<80)faixas['60-80%']++; else faixas['>80%']++; });
  let h='<div class="ind-cards">';
  h+=_card('SAPS 3 médio',media,'pontos na admissão','vinho');
  h+=_card('Mortalidade prevista média',(mortMedia*100).toFixed(1)+'%','equação Am. do Sul','laranja');
  h+=_card('Óbitos observados',obs,'no período','vermelho');
  h+=_card('SMR',smr!=null?smr.toFixed(2):'—','observado/esperado', smr!=null&&smr>1.2?'vermelho':smr!=null&&smr<0.8?'verde':'vinho');
  h+='</div>';
  h+='<div class="ind-sec-titulo">Distribuição por faixa de risco (SAPS 3)</div><table class="ind-tabela"><tr><th>Faixa de mortalidade prevista</th><th>Pacientes</th></tr>';
  Object.entries(faixas).forEach(([k,v])=>{ h+=`<tr><td>${k}</td><td>${v}</td></tr>`; });
  h+='</table>';
  h+='<div class="ind-hint"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M10 2L14 6l-3 3-2-1-4 4-1-1 4-4-1-2z"/><line x1="3" y1="13" x2="7" y2="9"/></svg> SMR (Standardized Mortality Ratio) = óbitos observados ÷ soma das mortalidades previstas. SMR &lt; 1 sugere desempenho melhor que o previsto pelo escore; &gt; 1, pior. Interpretar com cautela em amostras pequenas.</div>';
  return h;
}

function _indDispositivos(per){
  const evPer=_indCache.evolucoes.filter(e=>_dentroPeriodo(e.data,per));
  const pacDia=new Set(evPer.map(e=>e.leito+'|'+e.data)).size;
  const dispDia=pred=>new Set(evPer.filter(e=>pred(e)).map(e=>e.leito+'|'+e.data)).size;
  const vmiDia=dispDia(e=>e.vent==='VMI');
  const dvaDia=dispDia(e=>e.dva==='SIM');
  const o2Dia=dispDia(e=>e.vent&&e.vent!=='AA');
  const taxa=(n)=>pacDia>0?Math.round(n/pacDia*100):0;
  let h='<div class="ind-cards">';
  h+=_card('Taxa de VMI',taxa(vmiDia)+'%',`${vmiDia}/${pacDia} pac.-dia`, taxa(vmiDia)>=60?'laranja':'vinho');
  h+=_card('Taxa de DVA',taxa(dvaDia)+'%',`${dvaDia}/${pacDia} pac.-dia`,'vinho');
  h+=_card('Suporte de O₂',taxa(o2Dia)+'%',`${o2Dia}/${pacDia} pac.-dia`,'vinho');
  h+=_card('Pacientes-dia',pacDia,'denominador','verde');
  h+='</div>';
  h+='<div class="ind-hint"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M10 2L14 6l-3 3-2-1-4 4-1-1 4-4-1-2z"/><line x1="3" y1="13" x2="7" y2="9"/></svg> Taxas = (dispositivo-dia ÷ pacientes-dia) × 100. Dispositivo-dia = pares únicos (leito × dia) com o suporte registrado na evolução.</div>';
  return h;
}

function _indCulturas(per){
  // Prefere o panorama agregado da planilha quando disponível
  if(_culturasAgregadoCache&&_culturasAgregadoCache.culturas) return _renderCCIHAgregado(_culturasAgregadoCache);
  return _renderCCIHLocal(per);
}

// ── Panorama CCIH local (a partir das evoluções salvas) ──────────────────────
function _renderCCIHLocal(per){
  const evPer=_indCache.evolucoes.filter(e=>_dentroPeriodo(e.data,per));
  const todas=[]; evPer.forEach(e=>(e.culturas||[]).forEach(c=>{ if(c.micro) todas.push(c); }));
  const btn=APPS_SCRIPT_URL&&CULTURAS_SHEET_ID
    ? `<div style="margin-bottom:10px;display:flex;gap:6px;flex-wrap:wrap;">
        <button class="btn btn-pri btn-sm" onclick="_ccihCarregarAgregado(false,3)"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><rect x="2" y="4" width="12" height="10" rx="1"/><path d="M2 7h12"/><line x1="6" y1="10" x2="10" y2="10"/><line x1="8" y1="8" x2="8" y2="12"/><path d="M5 4V3h6v1"/></svg> Panorama institucional (3 meses)</button>
        <button class="btn btn-sm" onclick="_ccihCarregarAgregado(false,6)">6 meses</button>
        <button class="btn btn-sm" onclick="_ccihCarregarAgregado(false,99)">Todas</button>
      </div>` : '<div class="tip i" style="margin-bottom:8px;">Configure <code>APPS_SCRIPT_URL</code> e <code>CULTURAS_SHEET_ID</code> para o panorama institucional completo com antibiogramas.</div>';
  if(!todas.length) return btn+'<div class="ind-hint">Nenhuma cultura positiva registrada nas evoluções do período.</div>';
  const freq={}; todas.forEach(c=>{ const m=(c.micro||'').toUpperCase().trim(); if(m) freq[m]=(freq[m]||0)+1; });
  const ord=Object.entries(freq).sort((a,b)=>b[1]-a[1]);
  const nMDR=todas.filter(c=>{ const cl=_cultClassificar(c.antibiograma); return cl==='MDR'||cl==='XDR'||cl==='PDR'; }).length;
  let h=btn+'<div class="ind-cards">';
  h+=_card('Culturas positivas',todas.length,'no período','vermelho');
  h+=_card('Microrganismos distintos',ord.length,'espécies','vinho');
  h+=_card('MDR/XDR/PDR',nMDR,`${todas.length>0?Math.round(nMDR/todas.length*100):0}% dos isolados`,nMDR>0?'vermelho':'verde');
  h+='</div>';
  h+='<div class="ind-sec-titulo">Microrganismos mais frequentes</div>';
  h+='<table class="ind-tabela"><tr><th>Microrganismo</th><th>Ocorrências</th><th>Classificação</th></tr>';
  todas.forEach(c=>{
    const cl=_cultClassificar(c.antibiograma);
    const cor=cl==='PDR'||cl==='XDR'?'color:#b71c1c;font-weight:700;':cl==='MDR'?'color:#e65100;font-weight:700;':'';
  });
  ord.forEach(([m,n])=>{
    const cls=todas.filter(c=>c.micro===m&&c.antibiograma).map(c=>_cultClassificar(c.antibiograma)).filter(Boolean);
    const pior=cls.includes('PDR')?'PDR':cls.includes('XDR')?'XDR':cls.includes('MDR')?'MDR':cls[0]||'';
    const cor=pior==='PDR'||pior==='XDR'?'color:#b71c1c;font-weight:700;':pior==='MDR'?'color:#e65100;font-weight:700;':'';
    h+=`<tr><td>${m}</td><td>${n}</td><td style="${cor}">${pior||'—'}</td></tr>`;
  });
  h+='</table>';
  h+='<div class="ind-hint"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M10 2L14 6l-3 3-2-1-4 4-1-1 4-4-1-2z"/><line x1="3" y1="13" x2="7" y2="9"/></svg> Baseado nas culturas registradas nas evoluções. Para o panorama completo com antibiograma de todos os pacientes da planilha CCIH, use o botão "Panorama institucional" acima.</div>';
  return h;
}

// ── Panorama CCIH agregado (dados da planilha via Apps Script) ───────────────
function _renderCCIHAgregado(dados){
  const culturas=dados.culturas||[];
  const positivas=culturas.filter(c=>!c.negativa&&c.microorg);
  const cls=positivas.map(c=>_cultClassificar(c.antibiograma));
  const nXDR=cls.filter(x=>x==='XDR').length, nMDR=cls.filter(x=>x==='MDR').length;
  const nPDR=cls.filter(x=>x==='PDR').length, nSusc=cls.filter(x=>x==='Sensível').length;
  const abas=dados._maxAbas||3;
  let h=`<div style="background:var(--vinho);color:white;padding:10px 14px;border-radius:8px;margin-bottom:10px;">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
      <div>
        <div style="font-weight:700;font-size:.86rem;"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><rect x="2" y="4" width="12" height="10" rx="1"/><path d="M2 7h12"/><line x1="6" y1="10" x2="10" y2="10"/><line x1="8" y1="8" x2="8" y2="12"/><path d="M5 4V3h6v1"/></svg> Panorama institucional CCIH</div>
        <div style="font-size:.72rem;opacity:.9;">${dados.totalCulturas||0} culturas · ${dados.pacientesAnalisados||0} pacientes · ${dados.pdfsExtraidos||0} antibiogramas · ${abas===99?'todas as abas':abas+(abas===1?' mês':' meses')}</div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <select onchange="_ccihCarregarAgregado(true,+this.value)" style="background:rgba(255,255,255,.15);color:white;border:1px solid rgba(255,255,255,.3);border-radius:6px;padding:4px 8px;font-size:.72rem;cursor:pointer;">
          <option value="1" ${abas===1?'selected':''}>1 mês</option><option value="3" ${abas===3?'selected':''}>3 meses</option>
          <option value="6" ${abas===6?'selected':''}>6 meses</option><option value="99" ${abas===99?'selected':''}>Todas</option>
        </select>
        <button class="btn btn-sm" style="background:rgba(255,255,255,.15);color:white;border-color:rgba(255,255,255,.3);" onclick="_ccihLimparAgregado()"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M13 8H3"/><path d="M6.5 4.5L3 8l3.5 3.5"/></svg> Local</button>
      </div>
    </div>
  </div>`;
  h+='<div class="ind-cards">';
  h+=_card('Pacientes analisados',dados.pacientesAnalisados||0,'','vinho');
  h+=_card('Isolados positivos',positivas.length,dados.totalCulturas+' total','vermelho');
  h+=_card('MDR',nMDR,`${positivas.length?Math.round(nMDR/positivas.length*100):0}%`,nMDR>0?'laranja':'verde');
  h+=_card('XDR/PDR',nXDR+nPDR,`${positivas.length?Math.round((nXDR+nPDR)/positivas.length*100):0}%`,nXDR+nPDR>0?'vermelho':'verde');
  h+='</div>';
  // Alerta antibiogramas
  const comAtb=positivas.filter(c=>c.antibiograma&&c.antibiograma.length).length;
  if(positivas.length>0&&comAtb===0)
    h+=`<div class="tip d" style="margin-top:8px;"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg>️ Nenhum antibiograma extraído dos PDFs. Verifique se a conta do Apps Script tem acesso aos arquivos no Drive. Rode <code>_testarColunaL</code> no editor do Apps Script.</div>`;
  else if(positivas.length>0&&comAtb<positivas.length)
    h+=`<div class="tip i" style="margin-top:8px;">ℹ️ ${comAtb} de ${positivas.length} isolados têm antibiograma extraído. Os demais não têm laudo PDF vinculado.</div>`;
  // Classificação
  if(cls.length){
    h+='<div class="ind-sec-titulo">Classificação de Resistência (Magiorakos simplificado)</div><div class="ind-cards">';
    h+=_card('PDR',nPDR,`${positivas.length?Math.round(nPDR/positivas.length*100):0}%`,nPDR>0?'vermelho':'verde');
    h+=_card('XDR',nXDR,`${positivas.length?Math.round(nXDR/positivas.length*100):0}%`,nXDR>0?'vermelho':'verde');
    h+=_card('MDR',nMDR,`${positivas.length?Math.round(nMDR/positivas.length*100):0}%`,nMDR>0?'laranja':'verde');
    h+=_card('Sensível',nSusc,`${positivas.length?Math.round(nSusc/positivas.length*100):0}%`,'verde');
    h+='</div>';
  }
  // Top microrganismos
  const freq={}; positivas.forEach(c=>{ const m=(c.microorg||'').toUpperCase().trim(); if(m) freq[m]=(freq[m]||0)+1; });
  const ord=Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,12);
  if(ord.length){
    h+='<div class="ind-sec-titulo">Microrganismos mais frequentes</div>';
    h+='<table class="ind-tabela"><tr><th>Microrganismo</th><th>Isolados</th><th>Classificação</th></tr>';
    ord.forEach(([m,n])=>{
      const isols=positivas.filter(c=>(c.microorg||'').toUpperCase().trim()===m&&c.antibiograma);
      const clss=isols.map(c=>_cultClassificar(c.antibiograma));
      const pior=clss.includes('PDR')?'PDR':clss.includes('XDR')?'XDR':clss.includes('MDR')?'MDR':clss[0]||'';
      const cor=pior==='PDR'||pior==='XDR'?'color:#b71c1c;font-weight:700;':pior==='MDR'?'color:#e65100;font-weight:700;':'';
      h+=`<tr><td>${m}</td><td>${n}</td><td style="${cor}">${pior||'—'}</td></tr>`;
    });
    h+='</table>';
  }
  h+='<div class="ind-hint" style="margin-top:8px;"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M10 2L14 6l-3 3-2-1-4 4-1-1 4-4-1-2z"/><line x1="3" y1="13" x2="7" y2="9"/></svg> PDR = Pan-resistente · XDR = Extensivamente resistente · MDR = Multirresistente (Magiorakos et al. 2012). Versão simplificada: conta classes de antibióticos com resistência.</div>';
  return h;
}

function _indDiagnosticos(per){
  const adm=_indCache.admissoes.filter(a=>_dentroPeriodo(a.admUTI,per));
  const lista=adm.filter(a=>a.cid||a.diagnostico);
  if(!lista.length) return '<div class="ind-hint">Sem diagnósticos registrados no período.</div>';
  const freqCID={}, freqCap={};
  const capNomes={A:'Infecciosas',B:'Infecciosas',C:'Neoplasias',D:'Sangue/Neoplasias',E:'Endócrino/Metab.',F:'Mentais',G:'Neurológicas',I:'Cardiovasculares',J:'Respiratórias',K:'Digestivas',N:'Geniturinárias',R:'Sintomas/Sinais',S:'Trauma',T:'Trauma/Intox.'};
  lista.forEach(a=>{ const cid=(a.cid||'').toUpperCase().trim();
    if(cid){ freqCID[cid]=(freqCID[cid]||0)+1; const cap=cid[0]; freqCap[cap]=(freqCap[cap]||0)+1; } });
  const ordCID=Object.entries(freqCID).sort((a,b)=>b[1]-a[1]).slice(0,15);
  const ordCap=Object.entries(freqCap).sort((a,b)=>b[1]-a[1]);
  let h='<div class="ind-cards">';
  h+=_card('Admissões',lista.length,'com diagnóstico','vinho');
  h+=_card('CIDs distintos',Object.keys(freqCID).length,'no período','vinho');
  h+='</div>';
  if(ordCap.length){ h+='<div class="ind-sec-titulo">Por capítulo CID-10</div><table class="ind-tabela"><tr><th>Capítulo</th><th>Casos</th></tr>';
    ordCap.forEach(([c,n])=>{ h+=`<tr><td>${c} — ${capNomes[c]||'Outros'}</td><td>${n}</td></tr>`; }); h+='</table>'; }
  if(ordCID.length){ h+='<div class="ind-sec-titulo">CIDs mais frequentes</div><table class="ind-tabela"><tr><th>CID</th><th>Casos</th></tr>';
    ordCID.forEach(([c,n])=>{ h+=`<tr><td>${c}</td><td>${n}</td></tr>`; }); h+='</table>'; }
  return h;
}

async function exportarIndicadoresPDF(){
  toast('Gerando PDF...');
  try{
    const el=$('ind-card');
    const canvas=await html2canvas(el,{scale:2,backgroundColor:'#fff'});
    const img=canvas.toDataURL('image/png');
    const {jsPDF}=window.jspdf; const pdf=new jsPDF('p','mm','a4');
    const w=190, h=canvas.height*w/canvas.width;
    pdf.setFontSize(13); pdf.setTextColor(122,16,32);
    pdf.text('Indicadores UTI Médica — Hospital dos Pescadores',10,12);
    pdf.setFontSize(9); pdf.setTextColor(120);
    pdf.text(`${(IND_CATS.find(c=>c.id===_indCatAtiva)||{}).l} · ${_periodoSel()} · ${hoje()}`,10,18);
    pdf.addImage(img,'PNG',10,24,w,Math.min(h,260));
    pdf.save(`indicadores_${_indCatAtiva}_${hoje()}.pdf`);
  }catch(e){ toast('Erro no PDF: '+e.message,true); }
}

/* ════════════════════════════════════════════════════════════════════════════
   INICIALIZAÇÃO
   ════════════════════════════════════════════════════════════════════════════ */
window.addEventListener('load',()=>{
  const ok=initFirebase();
  const tc=$('t-config'); if(tc) tc.style.display='none';
  try{ const ll=$('logo-login'); if(ll) ll.innerHTML=_logoImg(200); const lt=$('logo-turno'); if(lt) lt.innerHTML=_logoImg(240); }catch(_){}

  if(!ok||!auth){ mostrarTela('t-config'); $('t-config').style.display='flex'; return; }

  mostrarTela('t-login'); $('t-login').classList.add('ativa');
  auth.onAuthStateChanged(async user=>{
    if(user){
      try{
        try{ await Promise.race([auth.setPersistence(firebase.auth.Auth.Persistence.SESSION), new Promise(r=>setTimeout(r,2500))]); }catch(_){}
        usuarioEmail=user.email;
        showLoading('Carregando perfil...');
        perfilUsuario=await _carregarPerfil(user.email);
        _registrarCachePerfil(perfilUsuario);
        hideLoading();
        if(perfilUsuario&&perfilUsuario.ativo===false){ toast('Acesso desativado.',true); await auth.signOut(); mostrarTela('t-login'); return; }
        _atualizarBadgeUser();
        if(perfilUsuario&&perfilUsuario.senhaTrocada===false){ $('ts-titulo').textContent='Primeiro acesso'; $('ts-sub').textContent='Defina uma senha pessoal para continuar.'; mostrarTela('t-trocasenha'); return; }
        irTurno();
      }catch(e){ hideLoading(); console.error(e); irTurno(); }
    } else {
      mostrarTela('t-login'); $('t-login').classList.add('ativa');
    }
  });
});

/* ════════════════════════════════════════════════════════════════════════════
   NAVEGAÇÃO POR ABAS DO PRONTUÁRIO
   ════════════════════════════════════════════════════════════════════════════ */
function mudarAba(aba){
  ['evolucao','prescricao','laboratorio','guias'].forEach(id=>{
    const panel=$(`aba-${id}`), btn=$(`pnav-${id}`);
    if(panel) panel.style.display = id===aba ? '' : 'none';
    if(btn){ btn.classList.toggle('ativo', id===aba); }
  });
  if(aba==='prescricao') _renderPrescricao();
  if(aba==='laboratorio') _renderAbasolicitacoes();
  if(aba==='guias') _renderGuiasFichas();
}

// Atualiza o mini-resumo do paciente na sidebar
function _atualizarPnavPac(){
  const el=$('pnav-pac'); if(!el) return;
  const pac=gf('f-pac'), leito=gf('f-leito'), diag=gf('f-diag');
  el.innerHTML=`LEITO ${leito||'?'}<br>${(pac||'').split(' ').slice(0,2).join(' ')||'—'}${diag?'<br><span style="opacity:.7">'+diag.slice(0,30)+'</span>':''}`;
}

/* ════════════════════════════════════════════════════════════════════════════
   BANCO DE MEDICAMENTOS DA UTI
   ─ Você enviará a lista completa; por ora inclui os principais da UTI.
   ─ Cada item: { nome, dose, via, freq, horarios, categoria, obs }
   ════════════════════════════════════════════════════════════════════════════ */
/* ════════════════════════════════════════════════════════════════════════════
   BANCO DE MEDICAMENTOS — Hospital dos Pescadores · UTI
   ─ Ordem de categorias (prioridade de exibição na prescrição):
     1 Dieta   2 ATB   3 Hidratação EV   4 Droga Vasoativa
     5 Sedação/Analgesia   6 Medicações Gerais   7 Protocolo Insulina/HGT
     8 Cuidados
   ─ A função _rxOrdenar() reorganiza os itens da prescrição por essa ordem.
   ════════════════════════════════════════════════════════════════════════════ */

// Mapa de prioridade por categoria (menor = aparece primeiro)
const RX_PRIO = {
  'Dieta':1, 'ATB':2, 'Hidratação':3, 'Droga Vasoativa':4,
  'Sedação':5, 'Medicação Geral':6, 'Protocolo':7, 'Cuidados':8
};

const RX_BANCO = [
  {nome:'DIETA ORAL LIVRE', qtd:'', apres:'—', dose:'', diluicao:'', via:'VO', freq:'SND', hor:['SND'], cat:'Dieta', obs:''},
  {nome:'DIETA ORAL PASTOSA CONFORME ACEITAÇÃO', qtd:'', apres:'—', dose:'', diluicao:'', via:'VO', freq:'SND', hor:['SND'], cat:'Dieta', obs:''},
  {nome:'DIETA ORAL LIQUIDA-PASTOSA + RESTRIÇÃO HIDRICA 800ML/DIA', qtd:'', apres:'—', dose:'', diluicao:'', via:'VO', freq:'SND', hor:['SND'], cat:'Dieta', obs:''},
  {nome:'DIETA ORAL/SNE + RESTRIÇÃO HIDRICA 800ML/DIA / SEM ÁGUA LIVRE PELA SNE', qtd:'', apres:'—', dose:'', diluicao:'', via:'SNE', freq:'SND', hor:['SND'], cat:'Dieta', obs:''},
  {nome:'DIETA ORAL HAS E DM', qtd:'', apres:'—', dose:'', diluicao:'', via:'VO', freq:'SND', hor:['SND'], cat:'Dieta', obs:''},
  {nome:'DIETA ORAL ASSISTIDA', qtd:'', apres:'—', dose:'', diluicao:'', via:'VO', freq:'SND', hor:['SND'], cat:'Dieta', obs:''},
  {nome:'DIETA POR SNE', qtd:'', apres:'—', dose:'', diluicao:'', via:'SNE', freq:'SND', hor:['SND'], cat:'Dieta', obs:''},
  {nome:'DIETA ENTERAL', qtd:'', apres:'—', dose:'', diluicao:'', via:'SNE', freq:'SND', hor:['SND'], cat:'Dieta', obs:'volume conforme nutricionista'},
  {nome:'DIETA ENTERAL CONTÍNUA', qtd:'', apres:'—', dose:'', diluicao:'', via:'SNE', freq:'BIC ACM', hor:['BIC'], cat:'Dieta', obs:''},
  {nome:'DIETA ENTERAL + AGUA 200ML 4/4H', qtd:'', apres:'—', dose:'', diluicao:'', via:'SNE', freq:'SND', hor:['SND'], cat:'Dieta', obs:''},
  {nome:'DIETA PARA HAS E DRC VIA SNE + SUPLEMENTAÇÃO PROTEICA 2X/DIA', qtd:'', apres:'—', dose:'', diluicao:'', via:'SNE', freq:'SND', hor:['SND'], cat:'Dieta', obs:''},
  {nome:'DIETA ZERO ATÉ 2ª ORDEM', qtd:'', apres:'—', dose:'', diluicao:'', via:'—', freq:'—', hor:[], cat:'Dieta', obs:''},
  {nome:'JEJUM', qtd:'', apres:'—', dose:'', diluicao:'', via:'—', freq:'—', hor:[], cat:'Dieta', obs:''},
  {nome:'RESTRIÇÃO HÍDRICA 800ML/DIA', qtd:'', apres:'—', dose:'', diluicao:'', via:'—', freq:'24H', hor:[], cat:'Dieta', obs:''},
  {nome:'AAS 100MG', qtd:'1', apres:'COMP', dose:'100MG', diluicao:'', via:'VO', freq:'1X/DIA', hor:['08'], cat:'ATB', obs:'no almoço'},
  {nome:'AAS 100MG', qtd:'1', apres:'COMP', dose:'100MG', diluicao:'', via:'SNE', freq:'1X/DIA', hor:['08'], cat:'ATB', obs:''},
  {nome:'AMPICILINA + SULBACTAM 3G', qtd:'3', apres:'FA', dose:'3G', diluicao:'+ 250ML SF 0,9%', via:'EV', freq:'8/8H', hor:['08','16','24'], cat:'ATB', obs:''},
  {nome:'AMPICILINA 1G', qtd:'1', apres:'FA', dose:'1G', diluicao:'+ 100ML SF 0,9%', via:'EV', freq:'6/6H', hor:['06','12','18','24'], cat:'ATB', obs:''},
  {nome:'AMPICILINA 2G + SULBACTAM 1G', qtd:'1', apres:'FA', dose:'2G+1G', diluicao:'+ 100ML SF 0,9%', via:'EV', freq:'6/6H', hor:['06','12','18','24'], cat:'ATB', obs:''},
  {nome:'AMOXICILINA 1G + CLAVULANATO 0,2G', qtd:'1', apres:'FA', dose:'1G+0,2G', diluicao:'', via:'EV', freq:'8/8H', hor:['08','16','24'], cat:'ATB', obs:''},
  {nome:'AMOXICILINA 875MG + CLAVULANATO 125MG', qtd:'1', apres:'COMP', dose:'875MG+125MG', diluicao:'', via:'VO', freq:'12/12H', hor:['08','20'], cat:'ATB', obs:''},
  {nome:'AMOXICILINA + CLAVULANATO 50+12,5MG/ML SUSPENSÃO', qtd:'', apres:'ML', dose:'50+12,5MG/ML', diluicao:'', via:'VO', freq:'8/8H', hor:['08','16','24'], cat:'ATB', obs:''},
  {nome:'ACICLOVIR 250MG', qtd:'1', apres:'FA', dose:'250MG', diluicao:'+ 100ML SF 0,9%', via:'EV', freq:'8/8H', hor:['08','16','24'], cat:'ATB', obs:'infundir em 1h'},
  {nome:'AZITROMICINA 500MG', qtd:'1', apres:'FA', dose:'500MG', diluicao:'+ 250ML SF 0,9%', via:'EV', freq:'24/24H', hor:['08'], cat:'ATB', obs:'infundir em 1h'},
  {nome:'AZITROMICINA 500MG', qtd:'1', apres:'COMP', dose:'500MG', diluicao:'', via:'VO', freq:'24/24H', hor:['08'], cat:'ATB', obs:''},
  {nome:'AZITROMICINA 600MG PÓ', qtd:'', apres:'ML', dose:'600MG', diluicao:'', via:'VO', freq:'24/24H', hor:['08'], cat:'ATB', obs:''},
  {nome:'BENZILPENICILINA BENZATINA 1.200.000UI', qtd:'1', apres:'FA', dose:'1.200.000UI', diluicao:'', via:'IM', freq:'ACM', hor:['ACM'], cat:'ATB', obs:'dose única IM profunda'},
  {nome:'CEFALOTINA 1G', qtd:'1', apres:'FA', dose:'1G', diluicao:'+ 100ML SF 0,9%', via:'EV', freq:'6/6H', hor:['06','12','18','24'], cat:'ATB', obs:''},
  {nome:'CEFAZOLINA 1G', qtd:'1', apres:'FA', dose:'1G', diluicao:'+ 100ML SF 0,9%', via:'EV', freq:'8/8H', hor:['08','16','24'], cat:'ATB', obs:''},
  {nome:'CEFEPIMA 1G', qtd:'1', apres:'FA', dose:'1G', diluicao:'+ 100ML SF 0,9%', via:'EV', freq:'8/8H', hor:['08','16','24'], cat:'ATB', obs:''},
  {nome:'CEFOTAXIMA 500MG', qtd:'1', apres:'FA', dose:'500MG', diluicao:'+ 100ML SF 0,9%', via:'EV', freq:'6/6H', hor:['06','12','18','24'], cat:'ATB', obs:''},
  {nome:'CEFTAZIDIMA 1G', qtd:'1', apres:'FA', dose:'1G', diluicao:'+ 100ML SF 0,9%', via:'EV', freq:'8/8H', hor:['08','16','24'], cat:'ATB', obs:''},
  {nome:'CEFTRIAXONA 1G', qtd:'1', apres:'FA', dose:'1G', diluicao:'+ 100ML SF 0,9%', via:'EV', freq:'24/24H', hor:['08'], cat:'ATB', obs:''},
  {nome:'CEFTRIAXONA 1G', qtd:'1', apres:'FA', dose:'1G', diluicao:'+ 100ML SF 0,9%', via:'EV', freq:'12/12H', hor:['08','20'], cat:'ATB', obs:''},
  {nome:'CETOCONAZOL 200MG', qtd:'1', apres:'COMP', dose:'200MG', diluicao:'', via:'VO', freq:'24/24H', hor:['08'], cat:'ATB', obs:''},
  {nome:'CETOCONAZOL CREME 20MG/G', qtd:'', apres:'BISN', dose:'20MG/G', diluicao:'', via:'TD', freq:'SND', hor:['SND'], cat:'ATB', obs:'uso tópico'},
  {nome:'CIPROFLOXACINO 200MG/100ML', qtd:'1', apres:'BOLSA', dose:'200MG/100ML', diluicao:'', via:'EV', freq:'12/12H', hor:['08','20'], cat:'ATB', obs:'infundir em 60min'},
  {nome:'CIPROFLOXACINO 500MG', qtd:'1', apres:'COMP', dose:'500MG', diluicao:'', via:'VO', freq:'12/12H', hor:['08','20'], cat:'ATB', obs:''},
  {nome:'CLARITROMICINA 500MG', qtd:'1', apres:'COMP', dose:'500MG', diluicao:'', via:'VO', freq:'12/12H', hor:['08','20'], cat:'ATB', obs:''},
  {nome:'CLINDAMICINA 300MG', qtd:'1', apres:'CAP', dose:'300MG', diluicao:'', via:'VO', freq:'8/8H', hor:['08','16','24'], cat:'ATB', obs:''},
  {nome:'CLINDAMICINA 600MG/4ML', qtd:'1', apres:'AMP', dose:'600MG/4ML', diluicao:'+ 100ML SF 0,9%', via:'EV', freq:'8/8H', hor:['08','16','24'], cat:'ATB', obs:''},
  {nome:'CLORANFENICOL', qtd:'1', apres:'FA', dose:'1G', diluicao:'', via:'EV', freq:'6/6H', hor:['06','12','18','24'], cat:'ATB', obs:''},
  {nome:'COLISTINA 500.000UI', qtd:'', apres:'FA', dose:'500.000UI', diluicao:'+ 200ML SG 5%', via:'EV', freq:'12/12H', hor:['08','20'], cat:'ATB', obs:'ataque 5mg/kg'},
  {nome:'ERTAPENEM 1G', qtd:'1', apres:'FA', dose:'1G', diluicao:'+ 100ML SF 0,9%', via:'EV', freq:'24/24H', hor:['08'], cat:'ATB', obs:''},
  {nome:'FLUCONAZOL 200MG/100ML', qtd:'1', apres:'BOLSA', dose:'200MG/100ML', diluicao:'', via:'EV', freq:'24/24H', hor:['08'], cat:'ATB', obs:''},
  {nome:'GENTAMICINA 40MG/ML 2ML', qtd:'2', apres:'ML', dose:'40MG/ML', diluicao:'+ 100ML SF 0,9%', via:'EV', freq:'24/24H', hor:['08'], cat:'ATB', obs:'ajustar TFG — dosar nível'},
  {nome:'GENTAMICINA 40MG/ML 1ML', qtd:'1', apres:'ML', dose:'40MG/ML', diluicao:'+ 100ML SF 0,9%', via:'EV', freq:'24/24H', hor:['08'], cat:'ATB', obs:''},
  {nome:'IVERMECTINA 6MG', qtd:'', apres:'COMP', dose:'6MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'ATB', obs:'dose pelo peso'},
  {nome:'LEVOFLOXACINO 500MG/100ML', qtd:'1', apres:'BOLSA', dose:'500MG/100ML', diluicao:'', via:'EV', freq:'24/24H', hor:['08'], cat:'ATB', obs:'infundir em 60min'},
  {nome:'LINEZOLIDA 600MG/300ML', qtd:'1', apres:'BOLSA', dose:'600MG/300ML', diluicao:'', via:'EV', freq:'12/12H', hor:['08','20'], cat:'ATB', obs:''},
  {nome:'MEROPENEM 500MG', qtd:'1', apres:'FA', dose:'500MG', diluicao:'+ 100ML SF 0,9%', via:'EV', freq:'8/8H', hor:['08','16','24'], cat:'ATB', obs:''},
  {nome:'MEROPENEM 1G', qtd:'1', apres:'FA', dose:'1G', diluicao:'+ 100ML SF 0,9%', via:'EV', freq:'8/8H', hor:['08','16','24'], cat:'ATB', obs:''},
  {nome:'METRONIDAZOL 250MG', qtd:'1', apres:'COMP', dose:'250MG', diluicao:'', via:'VO', freq:'8/8H', hor:['08','16','24'], cat:'ATB', obs:''},
  {nome:'METRONIDAZOL 400MG', qtd:'1', apres:'COMP', dose:'400MG', diluicao:'', via:'VO', freq:'8/8H', hor:['08','16','24'], cat:'ATB', obs:''},
  {nome:'METRONIDAZOL 500MG/100ML', qtd:'1', apres:'BOLSA', dose:'500MG/100ML', diluicao:'', via:'EV', freq:'8/8H', hor:['08','16','24'], cat:'ATB', obs:''},
  {nome:'MICAFUNGINA 100MG', qtd:'1', apres:'FA', dose:'100MG', diluicao:'+ 100ML SF 0,9%', via:'EV', freq:'24/24H', hor:['08'], cat:'ATB', obs:''},
  {nome:'MOXIFLOXACINO 400MG/250ML', qtd:'1', apres:'BOLSA', dose:'400MG/250ML', diluicao:'', via:'EV', freq:'24/24H', hor:['08'], cat:'ATB', obs:'infundir em 60min'},
  {nome:'NEOMICINA + BACITRACINA POMADA', qtd:'', apres:'BISN', dose:'5MG+250UI/G', diluicao:'', via:'TD', freq:'SND', hor:['SND'], cat:'ATB', obs:'uso tópico'},
  {nome:'NISTATINA 100.000UI/ML 50ML', qtd:'5', apres:'ML', dose:'100.000UI/ML', diluicao:'', via:'VO', freq:'6/6H', hor:['06','12','18','24'], cat:'ATB', obs:'bochechar e engolir'},
  {nome:'OSELTAMIVIR 75MG', qtd:'1', apres:'CAP', dose:'75MG', diluicao:'', via:'VO', freq:'12/12H', hor:['08','20'], cat:'ATB', obs:'5 dias'},
  {nome:'OSELTAMIVIR 45MG', qtd:'1', apres:'CAP', dose:'45MG', diluicao:'', via:'VO', freq:'12/12H', hor:['08','20'], cat:'ATB', obs:''},
  {nome:'OSELTAMIVIR 30MG', qtd:'1', apres:'CAP', dose:'30MG', diluicao:'', via:'VO', freq:'12/12H', hor:['08','20'], cat:'ATB', obs:''},
  {nome:'OXACILINA 500MG', qtd:'1', apres:'FA', dose:'500MG', diluicao:'+ 100ML SF 0,9%', via:'EV', freq:'4/4H', hor:['04','08','12','16','20','24'], cat:'ATB', obs:''},
  {nome:'PIPERACILINA 4G + TAZOBACTAM 500MG', qtd:'1', apres:'FA', dose:'4G+0,5G', diluicao:'+ 100ML SF 0,9%', via:'EV', freq:'6/6H', hor:['06','12','18','24'], cat:'ATB', obs:'infundir em 4h'},
  {nome:'POLIMIXINA B 500.000UI', qtd:'', apres:'FA', dose:'500.000UI', diluicao:'+ 100ML SF 0,9%', via:'EV', freq:'12/12H', hor:['08','20'], cat:'ATB', obs:''},
  {nome:'RHZE/RIPE 150+75+400+275MG', qtd:'', apres:'COMP', dose:'150+75+400+275MG', diluicao:'', via:'VO', freq:'24/24H', hor:['08'], cat:'ATB', obs:'DOTS — em jejum'},
  {nome:'TEICOPLANINA 400MG', qtd:'1', apres:'FA', dose:'400MG', diluicao:'+ 100ML SF 0,9%', via:'EV', freq:'24/24H', hor:['08'], cat:'ATB', obs:'ataque 12/12h x3 doses'},
  {nome:'TIGECICLINA 50MG', qtd:'2', apres:'FA', dose:'50MG', diluicao:'+ 100ML SF 0,9%', via:'EV', freq:'12/12H', hor:['08','20'], cat:'ATB', obs:'ataque 100mg'},
  {nome:'VANCOMICINA 1G', qtd:'1', apres:'FA', dose:'1G', diluicao:'+ 100ML SF 0,9%', via:'EV', freq:'12/12H', hor:['08','20'], cat:'ATB', obs:'dosar nível'},
  {nome:'VANCOMICINA 500MG', qtd:'1', apres:'FA', dose:'500MG', diluicao:'+ 100ML SF 0,9%', via:'EV', freq:'6/6H', hor:['06','12','18','24'], cat:'ATB', obs:'dosar nível — ajustar TFG'},
  {nome:'AMICACINA 500MG', qtd:'1', apres:'FA', dose:'500MG', diluicao:'+ 100ML SF 0,9%', via:'EV', freq:'24/24H', hor:['08'], cat:'ATB', obs:'dosar nível'},
  {nome:'ALBENDAZOL 4MG/ML 10ML', qtd:'10', apres:'ML', dose:'4MG/ML', diluicao:'', via:'VO', freq:'12/12H', hor:['08','20'], cat:'ATB', obs:'junto à refeição'},
  {nome:'PERMETRINA 5% LOÇÃO 60ML', qtd:'', apres:'FR', dose:'5%', diluicao:'', via:'TD', freq:'ACM', hor:['ACM'], cat:'ATB', obs:'lavar após 8-14h'},
  {nome:'SF 0,9% EV EM BIC', qtd:'120', apres:'ML', dose:'0,9%', diluicao:'', via:'EV', freq:'BIC ACM', hor:['BIC'], cat:'Hidratação', obs:'', vazao:'5'},
  {nome:'SF 0,9% EV EM BIC', qtd:'250', apres:'ML', dose:'0,9%', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Hidratação', obs:'', vazao:''},
  {nome:'SF 0,9% EV EM BIC', qtd:'500', apres:'ML', dose:'0,9%', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Hidratação', obs:'', vazao:''},
  {nome:'SF 0,9% EV EM BIC', qtd:'1000', apres:'ML', dose:'0,9%', diluicao:'', via:'EV', freq:'BIC ACM', hor:['BIC'], cat:'Hidratação', obs:'', vazao:'42'},
  {nome:'SG 5% 420ML + BICARBONATO DE SÓDIO 8,4% 80ML', qtd:'500', apres:'ML', dose:'5%', diluicao:'+ 80ML BIC 8,4%', via:'EV', freq:'BIC ACM', hor:['BIC'], cat:'Hidratação', obs:'', vazao:'84'},
  {nome:'RINGER LACTATO ETAPA RÁPIDA', qtd:'500', apres:'ML', dose:'—', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Hidratação', obs:'', vazao:''},
  {nome:'RINGER LACTATO EV EM BIC', qtd:'1000', apres:'ML', dose:'—', diluicao:'', via:'EV', freq:'BIC ACM', hor:['BIC'], cat:'Hidratação', obs:'', vazao:'42'},
  {nome:'RINGER LACTATO EV EM BIC', qtd:'120', apres:'ML', dose:'—', diluicao:'', via:'EV', freq:'BIC ACM', hor:['BIC'], cat:'Hidratação', obs:'', vazao:'5'},
  {nome:'SORO FISIOLÓGICO 0,9% EV EM BIC', qtd:'', apres:'ML', dose:'0,9%', diluicao:'', via:'EV', freq:'BIC ACM', hor:['BIC'], cat:'Hidratação', obs:'', vazao:'4'},
  {nome:'JELCO HIDRATADO', qtd:'', apres:'—', dose:'', diluicao:'', via:'EV', freq:'—', hor:[], cat:'Hidratação', obs:'', vazao:''},
  {nome:'NORADRENALINA (NOREPINEFRINA) 4MG/4ML', qtd:'4', apres:'AMP', dose:'4MG/4ML', diluicao:'+ 234ML SF 0,9%', via:'EV', freq:'BIC ACM', hor:['BIC'], cat:'Droga Vasoativa', obs:'BIC — titular PAM'},
  {nome:'NOREPINEFRINA 2MG/ML', qtd:'16', apres:'ML', dose:'2MG/ML', diluicao:'+ 234ML SG 5%', via:'EV', freq:'BIC ACM', hor:['BIC'], cat:'Droga Vasoativa', obs:'BIC'},
  {nome:'DOBUTAMINA 50MG/20ML', qtd:'4', apres:'AMP', dose:'50MG/20ML', diluicao:'+ 170ML SF 0,9%', via:'EV', freq:'BIC ACM', hor:['BIC'], cat:'Droga Vasoativa', obs:'BIC'},
  {nome:'VASOPRESSINA 20UI/1ML', qtd:'1', apres:'ML', dose:'20UI/ML', diluicao:'+ 99ML SF 0,9%', via:'EV', freq:'BIC ACM', hor:['BIC'], cat:'Droga Vasoativa', obs:'BIC'},
  {nome:'NIPRIDE (NITROPRUSSIATO) 25MG/ML', qtd:'2', apres:'ML', dose:'25MG/ML', diluicao:'+ 248ML SG 5%', via:'EV', freq:'BIC ACM', hor:['BIC'], cat:'Droga Vasoativa', obs:'BIC — proteger da luz'},
  {nome:'NITROGLICERINA (TRIDIL) 50MG', qtd:'1', apres:'AMP', dose:'50MG', diluicao:'+ 240ML SG 5%', via:'EV', freq:'BIC ACM', hor:['BIC'], cat:'Droga Vasoativa', obs:'BIC'},
  {nome:'AMIODARONA 150MG/3ML', qtd:'1', apres:'AMP', dose:'150MG/3ML', diluicao:'+ 100ML SF 0,9%', via:'EV', freq:'ACM', hor:['ACM'], cat:'Droga Vasoativa', obs:'ACM'},
  {nome:'FENTANIL 50MCG/ML', qtd:'50', apres:'ML', dose:'50MCG/ML', diluicao:'+ 50ML SF 0,9%', via:'EV', freq:'BIC ACM', hor:['BIC'], cat:'Sedação', obs:'BIC'},
  {nome:'MIDAZOLAM 5MG/ML', qtd:'30', apres:'ML', dose:'5MG/ML', diluicao:'+ 120ML SF 0,9%', via:'EV', freq:'BIC ACM', hor:['BIC'], cat:'Sedação', obs:'BIC'},
  {nome:'PROPOFOL 1% (10MG/ML)', qtd:'100', apres:'ML', dose:'10MG/ML', diluicao:'', via:'EV', freq:'BIC ACM', hor:['BIC'], cat:'Sedação', obs:'BIC — puro'},
  {nome:'PROPOFOL 1% (10MG/ML)', qtd:'50', apres:'ML', dose:'10MG/ML', diluicao:'', via:'EV', freq:'BIC ACM', hor:['BIC'], cat:'Sedação', obs:'BIC'},
  {nome:'MORFINA 10MG/ML', qtd:'', apres:'AMP', dose:'2MG', diluicao:'', via:'EV', freq:'4/4H', hor:['04','08','12','16','20','24'], cat:'Sedação', obs:''},
  {nome:'TRAMADOL 50MG/ML', qtd:'', apres:'AMP', dose:'100MG', diluicao:'+ ABD', via:'EV', freq:'8/8H', hor:['08','16','24'], cat:'Sedação', obs:''},
  {nome:'DIPIRONA 1G', qtd:'1', apres:'AMP', dose:'1G', diluicao:'+ ABD', via:'EV', freq:'6/6H SN', hor:['SN'], cat:'Sedação', obs:'se dor ou febre'},
  {nome:'DIPIRONA 500MG/ML', qtd:'2', apres:'ML', dose:'500MG/ML', diluicao:'+ 8ML ABD', via:'EV', freq:'6/6H SN', hor:['SN'], cat:'Sedação', obs:'se necessário'},
  {nome:'DIPIRONA 500MG', qtd:'1', apres:'COMP', dose:'500MG', diluicao:'', via:'VO', freq:'6/6H SN', hor:['SN'], cat:'Sedação', obs:'se dor'},
  {nome:'DIPIRONA 500MG/ML', qtd:'40', apres:'GTS', dose:'500MG/ML', diluicao:'', via:'SNE', freq:'6/6H SN', hor:['SN'], cat:'Sedação', obs:''},
  {nome:'PARACETAMOL 200MG/ML', qtd:'40', apres:'GTS', dose:'200MG/ML', diluicao:'', via:'SNE', freq:'6/6H SN', hor:['SN'], cat:'Sedação', obs:''},
  {nome:'AEROLIM 100MCG', qtd:'4', apres:'PUFF', dose:'100MCG', diluicao:'', via:'IN', freq:'4/4H', hor:['04','08','12','16','20','24'], cat:'Medicação Geral', obs:''},
  {nome:'AEROLIN 100MCG/JATO', qtd:'6', apres:'JATO', dose:'100MCG', diluicao:'', via:'IN', freq:'6/6H', hor:['06','12','18','24'], cat:'Medicação Geral', obs:''},
  {nome:'AMIODARONA 200MG', qtd:'1', apres:'COMP', dose:'200MG', diluicao:'', via:'VO', freq:'12/12H', hor:['08','20'], cat:'Medicação Geral', obs:''},
  {nome:'ANLODIPINO 10MG', qtd:'1', apres:'COMP', dose:'10MG', diluicao:'', via:'VO', freq:'24/24H', hor:['08'], cat:'Medicação Geral', obs:''},
  {nome:'ANLODIPINO 10MG', qtd:'1', apres:'COMP', dose:'10MG', diluicao:'', via:'SNE', freq:'1X/DIA', hor:['08'], cat:'Medicação Geral', obs:''},
  {nome:'ATROPINA COLÍRIO 1%', qtd:'2', apres:'GTS', dose:'1%', diluicao:'', via:'ORAL', freq:'8/8H', hor:['08','16','24'], cat:'Medicação Geral', obs:'em cavidade oral'},
  {nome:'ATROVENT (IPRATRÓPIO)', qtd:'40', apres:'GTS', dose:'0,25MG/ML', diluicao:'', via:'IN', freq:'6/6H', hor:['06','12','18','24'], cat:'Medicação Geral', obs:'nebulização'},
  {nome:'BROMOPRIDA 5MG/ML', qtd:'2', apres:'ML', dose:'5MG/ML', diluicao:'+ 18ML ABD', via:'EV', freq:'8/8H', hor:['08','16','24'], cat:'Medicação Geral', obs:'fixo'},
  {nome:'BROMOPRIDA 5MG/ML', qtd:'2', apres:'ML', dose:'5MG/ML', diluicao:'+ 18ML ABD', via:'EV', freq:'8/8H SN', hor:['SN'], cat:'Medicação Geral', obs:'se necessário'},
  {nome:'CAPTOPRIL 25MG', qtd:'1', apres:'COMP', dose:'25MG', diluicao:'', via:'VO', freq:'8/8H', hor:['08','16','24'], cat:'Medicação Geral', obs:''},
  {nome:'CARVEDILOL 6,25MG', qtd:'1', apres:'COMP', dose:'6,25MG', diluicao:'', via:'VO', freq:'12/12H', hor:['08','20'], cat:'Medicação Geral', obs:''},
  {nome:'CLENIL HFA 200MCG/JATO', qtd:'2', apres:'JATO', dose:'200MCG', diluicao:'', via:'IN', freq:'12/12H', hor:['08','20'], cat:'Medicação Geral', obs:''},
  {nome:'CLONAZEPAM 2,5MG/ML', qtd:'10', apres:'GTS', dose:'2,5MG/ML', diluicao:'', via:'SNE', freq:'8/8H', hor:['08','16','24'], cat:'Medicação Geral', obs:''},
  {nome:'CLONAZEPAM GTS', qtd:'5', apres:'GTS', dose:'2,5MG/ML', diluicao:'', via:'SNE', freq:'12/12H', hor:['08','20'], cat:'Medicação Geral', obs:''},
  {nome:'DAPAGLIFLOZINA 10MG', qtd:'1', apres:'COMP', dose:'10MG', diluicao:'', via:'VO', freq:'24/24H', hor:['10'], cat:'Medicação Geral', obs:''},
  {nome:'DIAZEPAM 5MG', qtd:'1', apres:'COMP', dose:'5MG', diluicao:'', via:'VO', freq:'ACM NOITE', hor:['22'], cat:'Medicação Geral', obs:'à noite'},
  {nome:'DIAZEPAM 10MG', qtd:'1', apres:'COMP', dose:'10MG', diluicao:'', via:'SNE', freq:'12/12H', hor:['08','20'], cat:'Medicação Geral', obs:''},
  {nome:'DIGOXINA 0,25MG', qtd:'1', apres:'COMP', dose:'0,25MG', diluicao:'', via:'VO', freq:'24/24H', hor:['08'], cat:'Medicação Geral', obs:''},
  {nome:'ENALAPRIL 10MG', qtd:'1', apres:'COMP', dose:'10MG', diluicao:'', via:'VO', freq:'12/12H', hor:['08','20'], cat:'Medicação Geral', obs:''},
  {nome:'ENOXAPARINA 20MG', qtd:'1', apres:'SER', dose:'20MG', diluicao:'', via:'SC', freq:'24/24H', hor:['08'], cat:'Medicação Geral', obs:'profilática'},
  {nome:'ENOXAPARINA 40MG', qtd:'1', apres:'SER', dose:'40MG', diluicao:'', via:'SC', freq:'24/24H', hor:['08'], cat:'Medicação Geral', obs:'profilática'},
  {nome:'ENOXAPARINA 60MG', qtd:'1', apres:'SER', dose:'60MG', diluicao:'', via:'SC', freq:'12/12H', hor:['08','20'], cat:'Medicação Geral', obs:'terapêutica'},
  {nome:'ESOMEPRAZOL 20MG', qtd:'1', apres:'COMP', dose:'20MG', diluicao:'', via:'SNE', freq:'24/24H', hor:['08'], cat:'Medicação Geral', obs:'se falta de venoso'},
  {nome:'ESPIRONOLACTONA 25MG', qtd:'1', apres:'COMP', dose:'25MG', diluicao:'', via:'VO', freq:'24/24H', hor:['08'], cat:'Medicação Geral', obs:''},
  {nome:'FENITOÍNA 250MG/5ML', qtd:'2', apres:'ML', dose:'50MG/ML', diluicao:'+ 18ML ABD', via:'EV', freq:'8/8H', hor:['08','16','24'], cat:'Medicação Geral', obs:''},
  {nome:'FENITOÍNA 100MG', qtd:'1', apres:'COMP', dose:'100MG', diluicao:'', via:'VO', freq:'8/8H', hor:['08','16','24'], cat:'Medicação Geral', obs:''},
  {nome:'FUROSEMIDA 20MG', qtd:'2', apres:'AMP', dose:'20MG', diluicao:'', via:'EV', freq:'24/24H', hor:['16'], cat:'Medicação Geral', obs:''},
  {nome:'FUROSEMIDA 10MG/ML', qtd:'4', apres:'ML', dose:'10MG/ML', diluicao:'+ ABD', via:'EV', freq:'6/6H', hor:['06','12','18','24'], cat:'Medicação Geral', obs:'2 amp'},
  {nome:'FUROSEMIDA 40MG', qtd:'2', apres:'COMP', dose:'40MG', diluicao:'', via:'SNE', freq:'8/8H', hor:['08','16','24'], cat:'Medicação Geral', obs:''},
  {nome:'HALDOL 2MG/ML', qtd:'5', apres:'GTS', dose:'2MG/ML', diluicao:'', via:'SNE', freq:'12/12H', hor:['08','20'], cat:'Medicação Geral', obs:''},
  {nome:'HALDOL 2MG/ML', qtd:'15', apres:'GTS', dose:'2MG/ML', diluicao:'', via:'SNE', freq:'8/8H', hor:['08','16','24'], cat:'Medicação Geral', obs:''},
  {nome:'HALDOL 2MG/ML', qtd:'20', apres:'GTS', dose:'2MG/ML', diluicao:'', via:'SNE', freq:'6/6H', hor:['06','12','18','24'], cat:'Medicação Geral', obs:''},
  {nome:'HALDOL 5MG', qtd:'1', apres:'AMP', dose:'5MG', diluicao:'', via:'IM', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:''},
  {nome:'HALOPERIDOL 1MG/ML GTS', qtd:'20', apres:'GTS', dose:'1MG/ML', diluicao:'', via:'SNE', freq:'8/8H', hor:['08','16','24'], cat:'Medicação Geral', obs:''},
  {nome:'HEPARINA NÃO FRACIONADA (HNF) 5000UI', qtd:'0,25', apres:'ML', dose:'5000UI/0,25ML', diluicao:'', via:'SC', freq:'12/12H', hor:['08','20'], cat:'Medicação Geral', obs:''},
  {nome:'HIDRALAZINA 25MG', qtd:'3', apres:'COMP', dose:'25MG', diluicao:'', via:'SNE', freq:'8/8H', hor:['08','16','24'], cat:'Medicação Geral', obs:''},
  {nome:'HIDRALAZINA 50MG', qtd:'1', apres:'COMP', dose:'50MG', diluicao:'', via:'VO', freq:'8/8H', hor:['08','16','24'], cat:'Medicação Geral', obs:''},
  {nome:'HIDRALAZINA 20MG/ML', qtd:'1', apres:'AMP', dose:'20MG/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:''},
  {nome:'HIDROCORTISONA 100MG', qtd:'1', apres:'FA', dose:'100MG', diluicao:'+ 10ML ABD (fazer 5ML)', via:'EV', freq:'6/6H', hor:['06','12','18','24'], cat:'Medicação Geral', obs:''},
  {nome:'ISOSSORBIDA (MONOCORDIL) 40MG', qtd:'1', apres:'COMP', dose:'40MG', diluicao:'', via:'VO', freq:'8/8H', hor:['08','14','20'], cat:'Medicação Geral', obs:''},
  {nome:'ISOSSORBIDA 20MG', qtd:'1', apres:'COMP', dose:'20MG', diluicao:'', via:'VO', freq:'8/8H', hor:['08','16','24'], cat:'Medicação Geral', obs:''},
  {nome:'LEVETIRACETAM 500MG', qtd:'1', apres:'COMP', dose:'500MG', diluicao:'', via:'VO', freq:'12/12H', hor:['08','20'], cat:'Medicação Geral', obs:''},
  {nome:'LEVOTIROXINA 50MCG', qtd:'1', apres:'COMP', dose:'50MCG', diluicao:'', via:'VO', freq:'24/24H', hor:['06'], cat:'Medicação Geral', obs:'em jejum'},
  {nome:'LOSARTANA 50MG', qtd:'1', apres:'COMP', dose:'50MG', diluicao:'', via:'VO', freq:'12/12H', hor:['08','20'], cat:'Medicação Geral', obs:''},
  {nome:'LOSARTANA 50MG', qtd:'1', apres:'COMP', dose:'50MG', diluicao:'', via:'SNE', freq:'1X/DIA', hor:['08'], cat:'Medicação Geral', obs:''},
  {nome:'LUNERA COLÍRIO', qtd:'1', apres:'GTS', dose:'—', diluicao:'', via:'OF', freq:'8/8H', hor:['08','16','24'], cat:'Medicação Geral', obs:'cada olho'},
  {nome:'METILPREDNISOLONA 125MG', qtd:'', apres:'FA', dose:'125MG', diluicao:'+ ABD (1/2 FA)', via:'EV', freq:'24/24H', hor:['08'], cat:'Medicação Geral', obs:''},
  {nome:'METOCLOPRAMIDA 10MG', qtd:'1', apres:'COMP', dose:'10MG', diluicao:'', via:'SNE', freq:'8/8H SN', hor:['SN'], cat:'Medicação Geral', obs:''},
  {nome:'METOCLOPRAMIDA 5MG/ML', qtd:'2', apres:'ML', dose:'5MG/ML', diluicao:'+ ABD', via:'EV', freq:'8/8H SN', hor:['SN'], cat:'Medicação Geral', obs:''},
  {nome:'METOPROLOL 25MG', qtd:'1', apres:'COMP', dose:'25MG', diluicao:'', via:'VO', freq:'24/24H', hor:['08'], cat:'Medicação Geral', obs:''},
  {nome:'METOPROLOL 50MG', qtd:'1', apres:'COMP', dose:'50MG', diluicao:'', via:'VO', freq:'12/12H', hor:['08','20'], cat:'Medicação Geral', obs:''},
  {nome:'N-ACETILCISTEÍNA 600MG', qtd:'1', apres:'SACHE', dose:'600MG', diluicao:'+ ÁGUA', via:'SNE', freq:'1X/DIA', hor:['08'], cat:'Medicação Geral', obs:''},
  {nome:'NBZ SF 0,9% 3ML', qtd:'3', apres:'ML', dose:'0,9%', diluicao:'', via:'IN', freq:'4/4H', hor:['04','08','12','16','20','24'], cat:'Medicação Geral', obs:''},
  {nome:'NBZ SF 0,9% 3ML + ATROVENT 40GTS', qtd:'3', apres:'ML', dose:'0,9%+40GTS', diluicao:'', via:'IN', freq:'6/6H', hor:['06','12','18','24'], cat:'Medicação Geral', obs:''},
  {nome:'OMEPRAZOL 20MG', qtd:'1', apres:'COMP', dose:'20MG', diluicao:'', via:'SNE', freq:'24/24H', hor:['08'], cat:'Medicação Geral', obs:''},
  {nome:'OMEPRAZOL 40MG', qtd:'1', apres:'FA', dose:'40MG', diluicao:'+ ABD', via:'EV', freq:'24/24H', hor:['08'], cat:'Medicação Geral', obs:''},
  {nome:'ONDANSETRONA 4MG/ML', qtd:'2', apres:'ML', dose:'4MG/ML', diluicao:'+ ABD', via:'EV', freq:'8/8H SN', hor:['SN'], cat:'Medicação Geral', obs:'se náusea/vômito'},
  {nome:'ONDANSETRONA 2MG/ML', qtd:'1', apres:'AMP', dose:'2MG/ML', diluicao:'+ ABD', via:'EV', freq:'8/8H SN', hor:['SN'], cat:'Medicação Geral', obs:'se náusea/vômito'},
  {nome:'PANTOPRAZOL 40MG', qtd:'1', apres:'FA', dose:'40MG', diluicao:'+ DP', via:'EV', freq:'24/24H', hor:['08'], cat:'Medicação Geral', obs:''},
  {nome:'PANTOPRAZOL 40MG', qtd:'1', apres:'COMP', dose:'40MG', diluicao:'', via:'VO', freq:'1X/DIA', hor:['08'], cat:'Medicação Geral', obs:''},
  {nome:'PREDNISOLONA 3MG/ML', qtd:'7', apres:'ML', dose:'3MG/ML', diluicao:'', via:'SNE', freq:'1X/DIA', hor:['08'], cat:'Medicação Geral', obs:'informar D1'},
  {nome:'PREDNISONA 20MG', qtd:'1', apres:'COMP', dose:'20MG', diluicao:'', via:'VO', freq:'24/24H', hor:['08'], cat:'Medicação Geral', obs:''},
  {nome:'QUETIAPINA 25MG', qtd:'1', apres:'COMP', dose:'25MG', diluicao:'', via:'SNE', freq:'12/12H', hor:['08','22'], cat:'Medicação Geral', obs:''},
  {nome:'QUETIAPINA 25MG', qtd:'1', apres:'COMP', dose:'25MG', diluicao:'', via:'VO', freq:'24/24H', hor:['22'], cat:'Medicação Geral', obs:''},
  {nome:'RIVAROXABANA 10MG', qtd:'1', apres:'COMP', dose:'10MG', diluicao:'', via:'VO', freq:'24/24H', hor:['08'], cat:'Medicação Geral', obs:''},
  {nome:'RIVAROXABANA 20MG', qtd:'1', apres:'COMP', dose:'20MG', diluicao:'', via:'VO', freq:'24/24H', hor:['08'], cat:'Medicação Geral', obs:''},
  {nome:'ROSUVASTATINA 20MG', qtd:'1', apres:'COMP', dose:'20MG', diluicao:'', via:'VO', freq:'24/24H', hor:['22'], cat:'Medicação Geral', obs:'à noite'},
  {nome:'SALBUTAMOL 100MCG', qtd:'6', apres:'PUFF', dose:'100MCG', diluicao:'', via:'IN', freq:'4/4H', hor:['04','08','12','16','20','24'], cat:'Medicação Geral', obs:''},
  {nome:'SINVASTATINA 40MG', qtd:'1', apres:'COMP', dose:'40MG', diluicao:'', via:'VO', freq:'24/24H', hor:['22'], cat:'Medicação Geral', obs:'à noite'},
  {nome:'SORO FISIOLÓGICO NBZ', qtd:'5', apres:'ML', dose:'0,9%', diluicao:'', via:'IN', freq:'4/4H', hor:['04','08','12','16','20','24'], cat:'Medicação Geral', obs:''},
  {nome:'SPIRONOLACTONA 25MG', qtd:'1', apres:'COMP', dose:'25MG', diluicao:'', via:'VO', freq:'24/24H', hor:['08'], cat:'Medicação Geral', obs:''},
  {nome:'SULFATO DE MAGNÉSIO 10%', qtd:'20', apres:'ML', dose:'10%', diluicao:'+ 100ML SF 0,9%', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:''},
  {nome:'SUSTRATE (PROPATILNITRATO) 10MG', qtd:'2', apres:'COMP', dose:'10MG', diluicao:'', via:'VO', freq:'8/8H', hor:['08','16','24'], cat:'Medicação Geral', obs:''},
  {nome:'SYMBICORT 6+100MCG', qtd:'2', apres:'SPRAY', dose:'6+100MCG', diluicao:'', via:'IN', freq:'12/12H', hor:['08','20'], cat:'Medicação Geral', obs:''},
  {nome:'TERBUTALINA 0,5MG', qtd:'1', apres:'AMP', dose:'0,5MG', diluicao:'', via:'SC', freq:'8/8H ACM', hor:['ACM'], cat:'Medicação Geral', obs:''},
  {nome:'VARFARINA 5MG', qtd:'1', apres:'COMP', dose:'5MG', diluicao:'', via:'VO', freq:'24/24H', hor:['18'], cat:'Medicação Geral', obs:''},
  {nome:'CLORETO DE POTÁSSIO 10%', qtd:'', apres:'AMP', dose:'10MEQ', diluicao:'+ diluir', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'máx 20mEq/h'},
  {nome:'GLUCONATO DE CÁLCIO 10%', qtd:'1', apres:'AMP', dose:'1G', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:''},
  {nome:'AMPLICTIL 5MG/ML', qtd:'3', apres:'ML', dose:'5MG/ML', diluicao:'', via:'IM', freq:'8/8H', hor:['08','16','24'], cat:'Medicação Geral', obs:''},
  {nome:'ÁCIDO FÓLICO 5MG', qtd:'1', apres:'COMP', dose:'5MG', diluicao:'', via:'VO', freq:'24/24H', hor:['08'], cat:'Medicação Geral', obs:''},
  {nome:'ADESIVO DE NICOTINA 14MG', qtd:'1', apres:'ADESIVO', dose:'14MG', diluicao:'', via:'TD', freq:'24/24H', hor:['08'], cat:'Medicação Geral', obs:'trocar 24h'},
  {nome:'ADESIVO DE NICOTINA 21MG', qtd:'1', apres:'ADESIVO', dose:'21MG', diluicao:'', via:'TD', freq:'24/24H', hor:['08'], cat:'Medicação Geral', obs:'trocar 24h'},
  {nome:'CICLOBENZAPRINA 5MG', qtd:'1', apres:'COMP', dose:'5MG', diluicao:'', via:'VO', freq:'8/8H', hor:['08','16','24'], cat:'Medicação Geral', obs:''},
  {nome:'DEXAMETASONA CREME 1MG/G', qtd:'', apres:'BISN', dose:'1MG/G', diluicao:'', via:'TD', freq:'SND', hor:['SND'], cat:'Medicação Geral', obs:'tópico — crítico'},
  {nome:'GLIBENCLAMIDA 5MG', qtd:'1', apres:'COMP', dose:'5MG', diluicao:'', via:'VO', freq:'24/24H', hor:['08'], cat:'Medicação Geral', obs:'no almoço'},
  {nome:'LIDOCAÍNA 2% 5ML', qtd:'5', apres:'ML', dose:'2%', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'crítico'},
  {nome:'LIDOCAÍNA + EPINEFRINA 20MG/ML+0,005MG/ML', qtd:'', apres:'ML', dose:'20MG/ML+0,005MG/ML', diluicao:'', via:'INF', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'infiltrativo'},
  {nome:'LIDOCAÍNA GEL', qtd:'', apres:'BISN', dose:'2%', diluicao:'', via:'TD', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'crítico — 2 tubos'},
  {nome:'METFORMINA 850MG', qtd:'1', apres:'COMP', dose:'850MG', diluicao:'', via:'VO', freq:'12/12H', hor:['08','20'], cat:'Medicação Geral', obs:'crítico'},
  {nome:'METFORMINA 500MG', qtd:'1', apres:'COMP', dose:'500MG', diluicao:'', via:'VO', freq:'12/12H', hor:['08','20'], cat:'Medicação Geral', obs:''},
  {nome:'PERMETRINA 5% LOÇÃO CREMOSA', qtd:'', apres:'FR', dose:'5%', diluicao:'', via:'TD', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:''},
  {nome:'SIMETICONA 75MG/ML GTS', qtd:'1', apres:'ML', dose:'75MG/ML', diluicao:'', via:'VO', freq:'8/8H', hor:['08','16','24'], cat:'Medicação Geral', obs:'crítico — 20 gts'},
  {nome:'SULFATO FERROSO 125MG/ML GTS', qtd:'', apres:'GTS', dose:'125MG/ML', diluicao:'', via:'VO', freq:'24/24H', hor:['08'], cat:'Medicação Geral', obs:'em jejum'},
  {nome:'HGT 6/6H // INSULINA REGULAR SE HGT > 200', qtd:'', apres:'—', dose:'', diluicao:'', via:'—', freq:'6/6H', hor:['06','12','18','24'], cat:'Protocolo', obs:''},
  {nome:'HGT 6/6H // INSULINA REGULAR SE HGT > 250', qtd:'', apres:'—', dose:'', diluicao:'', via:'—', freq:'6/6H', hor:['06','12','18','24'], cat:'Protocolo', obs:''},
  {nome:'HGT 6/6H // INSULINA REGULAR CONFORME PROTOCOLO', qtd:'', apres:'—', dose:'', diluicao:'', via:'—', freq:'6/6H', hor:['06','12','18','24'], cat:'Protocolo', obs:''},
  {nome:'HGT 1/1H ENQUANTO BOMBA DE INSULINA', qtd:'', apres:'—', dose:'', diluicao:'', via:'—', freq:'1/1H', hor:['20','21','22','23','24','01','02','03','04','05','06','07','08','09','10','11','12','13','14','15','16','17','18','19'], cat:'Protocolo', obs:'controle glicêmico BIC'},
  {nome:'HGT ANTES CAFÉ/ALMOÇO/JANTAR/22H + INSULINA REG PROTOCOLO', qtd:'', apres:'—', dose:'', diluicao:'', via:'—', freq:'SND', hor:['SND'], cat:'Protocolo', obs:''},
  {nome:'HGT ANTES CAFÉ/ALMOÇO/JANTAR/22H // IR PROTOCOLO SE HGT > 250', qtd:'', apres:'—', dose:'', diluicao:'', via:'—', freq:'SND', hor:['SND'], cat:'Protocolo', obs:''},
  {nome:'GLICOSE 50% SE HGT < 70 | REPETIR HGT 30MIN', qtd:'40', apres:'ML', dose:'50%', diluicao:'', via:'EV', freq:'SN', hor:['SN'], cat:'Protocolo', obs:'se HGT < 70'},
  {nome:'GLICOSE 50% SE HGT < 70MG/DL', qtd:'30', apres:'ML', dose:'50%', diluicao:'', via:'EV', freq:'SN', hor:['SN'], cat:'Protocolo', obs:''},
  {nome:'GLICOSE 50% SE HGT < 70', qtd:'4', apres:'AMP', dose:'50%', diluicao:'', via:'EV', freq:'SN', hor:['SN'], cat:'Protocolo', obs:''},
  {nome:'INSULINA REGULAR CONFORME PROTOCOLO', qtd:'', apres:'UI', dose:'100UI/ML', diluicao:'', via:'SC', freq:'SN', hor:['SN'], cat:'Protocolo', obs:''},
  {nome:'INSULINA NPH 12UI ÀS 22H', qtd:'12', apres:'UI', dose:'100UI/ML', diluicao:'', via:'SC', freq:'24/24H', hor:['22'], cat:'Protocolo', obs:''},
  {nome:'INSULINA NPH 12UI ANTES CAFÉ/ALMOÇO/22H', qtd:'12', apres:'UI', dose:'100UI/ML', diluicao:'', via:'SC', freq:'8/8H', hor:['06','12','22'], cat:'Protocolo', obs:''},
  {nome:'INSULINA NPH 8UI 12/12H', qtd:'8', apres:'UI', dose:'100UI/ML', diluicao:'', via:'SC', freq:'12/12H', hor:['08','20'], cat:'Protocolo', obs:''},
  {nome:'INSULINA NPH 4UI 8/8H', qtd:'4', apres:'UI', dose:'100UI/ML', diluicao:'', via:'SC', freq:'8/8H', hor:['08','16','24'], cat:'Protocolo', obs:''},
  {nome:'INSULINA GLARGINA', qtd:'', apres:'UI', dose:'100UI/ML', diluicao:'', via:'SC', freq:'24/24H', hor:['22'], cat:'Protocolo', obs:''},
  {nome:'PNI + MCC + SAT DE PULSO CONTÍNUO', qtd:'', apres:'—', dose:'', diluicao:'', via:'—', freq:'BIC ACM', hor:['EM USO'], cat:'Cuidados', obs:''},
  {nome:'MCC + OP + PNI', qtd:'', apres:'—', dose:'', diluicao:'', via:'—', freq:'BIC ACM', hor:['EM USO'], cat:'Cuidados', obs:''},
  {nome:'OP (OXIMETRIA DE PULSO)', qtd:'', apres:'—', dose:'', diluicao:'', via:'—', freq:'BIC ACM', hor:['EM USO'], cat:'Cuidados', obs:''},
  {nome:'SSVV E CCGG DE 2/2 HORAS — ROTINA', qtd:'', apres:'—', dose:'', diluicao:'', via:'—', freq:'2/2H', hor:['SND'], cat:'Cuidados', obs:''},
  {nome:'SSVV + CCGG + MUDANÇA DE DECÚBITO 2/2H', qtd:'', apres:'—', dose:'', diluicao:'', via:'—', freq:'2/2H', hor:['SND'], cat:'Cuidados', obs:''},
  {nome:'CABECEIRA 30-45°', qtd:'', apres:'—', dose:'', diluicao:'', via:'—', freq:'BIC ACM', hor:['EM USO'], cat:'Cuidados', obs:''},
  {nome:'CABECEIRA 30-45° + MUDANÇA DE DECÚBITO 2/2H', qtd:'', apres:'—', dose:'', diluicao:'', via:'—', freq:'BIC ACM', hor:['EM USO'], cat:'Cuidados', obs:''},
  {nome:'CABECEIRA 30-45° + MANTER SVD E QUANTIFICAR DÉBITO', qtd:'', apres:'—', dose:'', diluicao:'', via:'—', freq:'BIC ACM', hor:['EM USO'], cat:'Cuidados', obs:''},
  {nome:'MANTER SVD + QUANTIFICAR DIURESE + FECHAR BH', qtd:'', apres:'—', dose:'', diluicao:'', via:'—', freq:'BIC ACM', hor:['EM USO'], cat:'Cuidados', obs:''},
  {nome:'QUANTIFICAR DIURESE + FECHAR BH', qtd:'', apres:'—', dose:'', diluicao:'', via:'—', freq:'BIC ACM', hor:['EM USO'], cat:'Cuidados', obs:''},
  {nome:'FISIOTERAPIA MOTORA E RESPIRATÓRIA', qtd:'', apres:'—', dose:'', diluicao:'', via:'—', freq:'SND', hor:['SND'], cat:'Cuidados', obs:''},
  {nome:'FISIOTERAPIA + AJUSTES DE VM + AVAS', qtd:'', apres:'—', dose:'', diluicao:'', via:'—', freq:'SND', hor:['SND'], cat:'Cuidados', obs:''},
  {nome:'SONDA VESICAL DRENAGEM (SVD)', qtd:'', apres:'—', dose:'', diluicao:'', via:'—', freq:'BIC ACM', hor:['EM USO'], cat:'Cuidados', obs:''},
  {nome:'CURATIVO', qtd:'', apres:'—', dose:'', diluicao:'', via:'—', freq:'SND', hor:['SND'], cat:'Cuidados', obs:''},
  {nome:'DECÚBITO LATERAL ALTERNADO 2/2H', qtd:'', apres:'—', dose:'', diluicao:'', via:'—', freq:'2/2H', hor:['SND'], cat:'Cuidados', obs:''},
  {nome:'POMADA PREVENÇÃO DE ASSADURA', qtd:'', apres:'BISN', dose:'—', diluicao:'', via:'TD', freq:'SND', hor:['SND'], cat:'Cuidados', obs:'crítico'},
  {nome:'ALBENDAZOL', qtd:'1', apres:'COMP', dose:'400MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'ATB', obs:'Antiparasitário'},
  {nome:'AMOXICILINA+CLAVULANATO', qtd:'1', apres:'FA', dose:'1G', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'ATB', obs:'Penicilina/β-lact'},
  {nome:'AMPICILINA+SULBACTAM', qtd:'1', apres:'FA', dose:'1,5G', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'ATB', obs:'Penicilina/β-lact'},
  {nome:'ANFOTERICINA B LIPOSSOMAL', qtd:'1', apres:'FA', dose:'50MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'ATB', obs:'Antifúngico'},
  {nome:'ANIDULAFUNGINA', qtd:'1', apres:'FA', dose:'100MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'ATB', obs:'Antifúngico'},
  {nome:'AZTREONAM', qtd:'1', apres:'FA', dose:'1G', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'ATB', obs:'Monobactâmico'},
  {nome:'CASPOFUNGINA', qtd:'1', apres:'FA', dose:'70MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'ATB', obs:'Antifúngico'},
  {nome:'CEFTAZIDIMA+AVIBACTAM', qtd:'1', apres:'FA', dose:'2500MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'ATB', obs:'Cefalosporina+inib'},
  {nome:'CEFUROXIMA', qtd:'1', apres:'FA', dose:'750MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'ATB', obs:'Cefalosporina 2G'},
  {nome:'CLARITROMICINA', qtd:'1', apres:'FA', dose:'500MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'ATB', obs:'Macrolídeo'},
  {nome:'DAPTOMICINA', qtd:'1', apres:'FA', dose:'500MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'ATB', obs:'Lipopeptídeo'},
  {nome:'FLUCONAZOL', qtd:'1', apres:'CAP', dose:'50MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'ATB', obs:'Antifúngico'},
  {nome:'GANCICLOVIR', qtd:'1', apres:'FA', dose:'500MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'ATB', obs:'Antiviral'},
  {nome:'IMIPENEM+CILASTATINA', qtd:'1', apres:'FA', dose:'500MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'ATB', obs:'Carbapenem'},
  {nome:'LEVOFLOXACINO', qtd:'1', apres:'COMP', dose:'500MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'ATB', obs:'Quinolona'},
  {nome:'MOXIFLOXACINO', qtd:'1', apres:'COMP', dose:'400MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'ATB', obs:'Quinolona'},
  {nome:'PENICILINA G CRISTALINA', qtd:'1', apres:'FA', dose:'5.000.000UI', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'ATB', obs:'Penicilina'},
  {nome:'PIPERACILINA+TAZOBACTAM', qtd:'1', apres:'FA', dose:'4,5G', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'ATB', obs:'Penicilina/β-lact'},
  {nome:'SULFADIAZINA DE PRATA', qtd:'1', apres:'BISN', dose:'', diluicao:'', via:'TD', freq:'ACM', hor:['ACM'], cat:'ATB', obs:'ATB tópico'},
  {nome:'SULFAMETOXAZOL+TRIMETOPRIMA', qtd:'1', apres:'AMP', dose:'', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'ATB', obs:'Sulfa'},
  {nome:'VORICONAZOL', qtd:'1', apres:'FA', dose:'200MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'ATB', obs:'Antifúngico'},
  {nome:'DOPAMINA', qtd:'1', apres:'AMP', dose:'50MG', diluicao:'', via:'EV', freq:'BIC ACM', hor:['BIC'], cat:'Droga Vasoativa', obs:'Amina Vasoativa · <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> MPP/ALTA VIGILÂNCIA'},
  {nome:'EFEDRINA', qtd:'1', apres:'AMP', dose:'5%', diluicao:'', via:'EV', freq:'BIC ACM', hor:['BIC'], cat:'Droga Vasoativa', obs:'Amina Vasoativa · <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> MPP/ALTA VIGILÂNCIA'},
  {nome:'EPINEFRINA', qtd:'1', apres:'AMP', dose:'1MG/ML', diluicao:'', via:'EV', freq:'BIC ACM', hor:['BIC'], cat:'Droga Vasoativa', obs:'Amina Vasoativa · <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> MPP/ALTA VIGILÂNCIA'},
  {nome:'ISOPRENALINA', qtd:'1', apres:'AMP', dose:'0,2MG/ML', diluicao:'', via:'EV', freq:'BIC ACM', hor:['BIC'], cat:'Droga Vasoativa', obs:'Amina Vasoativa · <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> MPP/ALTA VIGILÂNCIA'},
  {nome:'LEVOSIMENDANA', qtd:'1', apres:'FA', dose:'12,5MG', diluicao:'', via:'EV', freq:'BIC ACM', hor:['BIC'], cat:'Droga Vasoativa', obs:'Estimulante cardíaco'},
  {nome:'METARAMINOL', qtd:'1', apres:'AMP', dose:'10MG', diluicao:'', via:'EV', freq:'BIC ACM', hor:['BIC'], cat:'Droga Vasoativa', obs:'Amina Vasoativa · <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> MPP/ALTA VIGILÂNCIA'},
  {nome:'MILRINONE', qtd:'1', apres:'FA', dose:'1MG/ML', diluicao:'', via:'EV', freq:'BIC ACM', hor:['BIC'], cat:'Droga Vasoativa', obs:'Cardiotônico'},
  {nome:'CISATRACÚRIO', qtd:'1', apres:'AMP', dose:'2MG/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Bloq. Neuromuscular · <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> MPP/ALTA VIGILÂNCIA'},
  {nome:'CLONAZEPAM', qtd:'1', apres:'COMP', dose:'2MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Anticonvulsivante/BZD'},
  {nome:'CODEÍNA', qtd:'', apres:'ML', dose:'3MG/ML', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Analgésico Narcótico · <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> MPP/ALTA VIGILÂNCIA'},
  {nome:'DEXMEDETOMIDINA', qtd:'1', apres:'BOLSA', dose:'4MCG/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Sedativo'},
  {nome:'DIAZEPAM', qtd:'1', apres:'AMP', dose:'10MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'BZD/Anticonvulsivante'},
  {nome:'ETOMIDATO', qtd:'1', apres:'AMP', dose:'20MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Anestésico venoso'},
  {nome:'FENTANILA', qtd:'1', apres:'AMP', dose:'50MCG/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Analgésico Narcótico · <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> MPP/ALTA VIGILÂNCIA'},
  {nome:'FLUMAZENIL', qtd:'1', apres:'AMP', dose:'0,5MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Antídoto BZD'},
  {nome:'KETAMINA', qtd:'1', apres:'AMP', dose:'50MG/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Anestésico venoso'},
  {nome:'METADONA', qtd:'1', apres:'AMP', dose:'10MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Analgésico Narcótico · <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> MPP/ALTA VIGILÂNCIA'},
  {nome:'METADONA', qtd:'1', apres:'COMP', dose:'10MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Analgésico Narcótico · <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> MPP/ALTA VIGILÂNCIA'},
  {nome:'MORFINA', qtd:'1', apres:'BOLSA', dose:'1MG/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Analgésico Narcótico · <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> MPP/ALTA VIGILÂNCIA'},
  {nome:'NALBUFINA', qtd:'1', apres:'AMP', dose:'10MG/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Analgésico Narcótico · <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> MPP/ALTA VIGILÂNCIA'},
  {nome:'NEOSTIGMINA', qtd:'1', apres:'AMP', dose:'0,5MG/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Antídoto BNM'},
  {nome:'PROPOFOL', qtd:'1', apres:'FR', dose:'10MG/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Anestésico venoso'},
  {nome:'PROPOFOL', qtd:'1', apres:'AMP', dose:'10MG/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Anestésico venoso'},
  {nome:'REMIFENTANILA', qtd:'1', apres:'FA', dose:'2MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Analgésico Narcótico · <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> MPP/ALTA VIGILÂNCIA'},
  {nome:'ROCURÔNIO', qtd:'1', apres:'FA', dose:'50MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Bloq. Neuromuscular · <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> MPP/ALTA VIGILÂNCIA'},
  {nome:'SUFENTANILA', qtd:'1', apres:'AMP', dose:'5MCG/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Analgésico Narcótico · <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> MPP/ALTA VIGILÂNCIA'},
  {nome:'SUGAMADEX', qtd:'1', apres:'FA', dose:'100MG/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Antídoto BNM'},
  {nome:'SUXAMETÔNIO', qtd:'1', apres:'FA', dose:'100MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Bloq. Neuromuscular · <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> MPP/ALTA VIGILÂNCIA'},
  {nome:'TIOPENTAL', qtd:'1', apres:'FA', dose:'1G', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Anestésico venoso'},
  {nome:'TRAMADOL', qtd:'1', apres:'CAP', dose:'50MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Analgésico Narcótico · <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> MPP/ALTA VIGILÂNCIA'},
  {nome:'ALBUMINA HUMANA', qtd:'1', apres:'FR', dose:'20%', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Hidratação', obs:'Expansor volemico'},
  {nome:'CITRATO TRISSÓDICO 4%', qtd:'1', apres:'BOLSA', dose:'', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Hidratação', obs:'Solução diálise'},
  {nome:'CLORETO DE SÓDIO', qtd:'1', apres:'FR', dose:'0,9%', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Hidratação', obs:'Solução parenteral'},
  {nome:'GLICOSE', qtd:'1', apres:'FR', dose:'5%', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Hidratação', obs:'Solução parenteral'},
  {nome:'SOLUÇÃO DIÁLISE PERITONEAL 1,5%', qtd:'1', apres:'BOLSA', dose:'', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Hidratação', obs:'Solução diálise'},
  {nome:'ACETAZOLAMIDA', qtd:'1', apres:'COMP', dose:'250MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Diurético/Antiglaucoma'},
  {nome:'ADENOSINA', qtd:'1', apres:'AMP', dose:'3MG/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Antiarrítmico · <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> MPP/ALTA VIGILÂNCIA'},
  {nome:'ALTEPLASE', qtd:'1', apres:'FA', dose:'20MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Trombolítico'},
  {nome:'AMINOFILINA', qtd:'1', apres:'AMP', dose:'24MG/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Broncodilatador'},
  {nome:'APIXABANA', qtd:'1', apres:'COMP', dose:'2,5MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Anticoagulante · <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> MPP/ALTA VIGILÂNCIA'},
  {nome:'ATENOLOL', qtd:'1', apres:'COMP', dose:'25MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Beta-bloq.'},
  {nome:'ATROPINA', qtd:'1', apres:'AMP', dose:'0,25MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Anticolinérgico/Antídoto'},
  {nome:'BICARBONATO DE SÓDIO', qtd:'1', apres:'AMP', dose:'8,4%', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Eletrólito'},
  {nome:'BICARBONATO DE SÓDIO', qtd:'1', apres:'FR', dose:'8,4%', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Eletrólito'},
  {nome:'BISACODIL', qtd:'', apres:'—', dose:'DRÁGEA', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Laxante'},
  {nome:'BUDESONIDA', qtd:'', apres:'—', dose:'0,5MG/2MLNEBULIZAÇÃO', diluicao:'', via:'IN', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Corticosteroide inalatório'},
  {nome:'CARBAMAZEPINA', qtd:'1', apres:'COMP', dose:'200MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Anticonvulsivante'},
  {nome:'CETOPROFENO', qtd:'1', apres:'AMP', dose:'100MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'AINE'},
  {nome:'CETOROLACO', qtd:'1', apres:'AMP', dose:'30MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'AINE'},
  {nome:'CITRATO DE SÓDIO', qtd:'1', apres:'AMP', dose:'4%', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Anticoagulante regional · <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> MPP/ALTA VIGILÂNCIA'},
  {nome:'CLONIDINA', qtd:'1', apres:'AMP', dose:'150MCG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Anti-hipertensivo'},
  {nome:'CLOPIDOGREL', qtd:'1', apres:'COMP', dose:'75MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Antiagregante'},
  {nome:'CLORETO DE CÁLCIO', qtd:'1', apres:'AMP', dose:'10%', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Eletrólito'},
  {nome:'CLORETO DE POTÁSSIO', qtd:'', apres:'—', dose:'7GENV(HEMODIÁLISE)', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Eletrólito · <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> MPP/ALTA VIGILÂNCIA'},
  {nome:'CLORETO DE SÓDIO', qtd:'1', apres:'AMP', dose:'20%', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Eletrólito · <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> MPP/ALTA VIGILÂNCIA'},
  {nome:'COLAGENASE', qtd:'1', apres:'BISN', dose:'', diluicao:'', via:'TD', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Cicatrizante'},
  {nome:'DABIGATRANA', qtd:'1', apres:'CAP', dose:'150MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Anticoagulante · <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> MPP/ALTA VIGILÂNCIA'},
  {nome:'DESLANOSÍDEO', qtd:'1', apres:'AMP', dose:'0,4MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Glicosídeo cardíaco'},
  {nome:'DESMOPRESSINA', qtd:'1', apres:'AMP', dose:'4MCG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Hormônio antidiurético'},
  {nome:'DEXAMETASONA', qtd:'1', apres:'FA', dose:'4MG/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Corticosteroide'},
  {nome:'DILTIAZEM', qtd:'1', apres:'COMP', dose:'60MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'BCC/Antiarrítmico'},
  {nome:'ESMOLOL', qtd:'1', apres:'FA', dose:'2500MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Antiarrítmico · <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> MPP/ALTA VIGILÂNCIA'},
  {nome:'ESOMEPRAZOL', qtd:'1', apres:'FA', dose:'40MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'IBP'},
  {nome:'FATOR VII RECOMBINANTE', qtd:'1', apres:'FA', dose:'1MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Hemostático'},
  {nome:'FENOBARBITAL', qtd:'1', apres:'AMP', dose:'100MG/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Anticonvulsivante'},
  {nome:'FENOBARBITAL', qtd:'1', apres:'COMP', dose:'100MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Anticonvulsivante'},
  {nome:'FENOTEROL', qtd:'', apres:'GTS', dose:'5MG/ML', diluicao:'', via:'IN', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Beta2-agonista'},
  {nome:'FIBRINOGÊNIO', qtd:'1', apres:'FA', dose:'2G', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Hemostático'},
  {nome:'FILGRASTIM', qtd:'1', apres:'FA', dose:'300MCG', diluicao:'', via:'SC', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Fator de crescimento'},
  {nome:'FITOMENADIONA', qtd:'1', apres:'AMP', dose:'10MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Vitamina K'},
  {nome:'FOSFATO DIBÁSICO DE SÓDIO', qtd:'1', apres:'AMP', dose:'2MEQ/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Eletrólito'},
  {nome:'GLICEROFOSFATO DE SÓDIO', qtd:'1', apres:'FR', dose:'', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Eletrólito'},
  {nome:'GLUCAGON', qtd:'', apres:'—', dose:'1MGINJETÁVEL', diluicao:'', via:'IM', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Hormônio contra-regulador'},
  {nome:'HALOPERIDOL', qtd:'1', apres:'AMP', dose:'5MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Neuroléptico'},
  {nome:'HALOPERIDOL', qtd:'1', apres:'COMP', dose:'5MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Neuroléptico'},
  {nome:'HEPARINA', qtd:'1', apres:'FA', dose:'5000UI/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Anticoagulante · <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> MPP/ALTA VIGILÂNCIA'},
  {nome:'HEPARINA', qtd:'1', apres:'AMP', dose:'5000UI/0,25ML', diluicao:'', via:'SC', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Anticoagulante · <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> MPP/ALTA VIGILÂNCIA'},
  {nome:'HIDROCLOROTIAZIDA', qtd:'1', apres:'COMP', dose:'25MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Diurético'},
  {nome:'IDARUCIZUMABE', qtd:'1', apres:'FA', dose:'50MG/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Antídoto anticoag.'},
  {nome:'INSULINA ASPARTE', qtd:'', apres:'—', dose:'100UI/MLCARPULE', diluicao:'', via:'SC', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Insulina · <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> MPP/ALTA VIGILÂNCIA'},
  {nome:'INSULINA DEGLUDECA', qtd:'', apres:'—', dose:'100UI/MLCANETA', diluicao:'', via:'SC', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Insulina · <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> MPP/ALTA VIGILÂNCIA'},
  {nome:'INSULINA GLARGINA', qtd:'1', apres:'FA', dose:'100UI/ML', diluicao:'', via:'SC', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Insulina · <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> MPP/ALTA VIGILÂNCIA'},
  {nome:'INSULINA HUMANA REGULAR', qtd:'1', apres:'FA', dose:'100UI/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Insulina · <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> MPP/ALTA VIGILÂNCIA'},
  {nome:'INSULINA LISPRO', qtd:'1', apres:'FA', dose:'100UI/ML', diluicao:'', via:'SC', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Insulina · <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> MPP/ALTA VIGILÂNCIA'},
  {nome:'INSULINA NPH', qtd:'1', apres:'FA', dose:'100UI/ML', diluicao:'', via:'SC', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Insulina · <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> MPP/ALTA VIGILÂNCIA'},
  {nome:'IPRATRÓPIO', qtd:'', apres:'—', dose:'0,025%SOLUÇÃO', diluicao:'', via:'IN', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Broncodilatador'},
  {nome:'LACOSAMIDA', qtd:'1', apres:'FA', dose:'10MG/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Anticonvulsivante'},
  {nome:'LACOSAMIDA', qtd:'1', apres:'COMP', dose:'100MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Anticonvulsivante'},
  {nome:'LACTULOSE', qtd:'', apres:'ML', dose:'667MG/ML', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Laxante'},
  {nome:'LEVETIRACETAM', qtd:'1', apres:'FA', dose:'100MG/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Anticonvulsivante'},
  {nome:'LIDOCAÍNA', qtd:'1', apres:'AMP', dose:'2%', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Antiarrítmico/Anestésico local'},
  {nome:'MANITOL', qtd:'1', apres:'FR', dose:'20%', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Diurético osmótico'},
  {nome:'METOPROLOL', qtd:'1', apres:'AMP', dose:'5MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Beta-bloq.'},
  {nome:'NALOXONA', qtd:'1', apres:'AMP', dose:'0,4MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Antídoto opióide'},
  {nome:'NIMODIPINO', qtd:'1', apres:'CAP', dose:'30MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Vasodilatador cerebral'},
  {nome:'NITROGLICERINA', qtd:'1', apres:'FA', dose:'5MG/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Antianginoso'},
  {nome:'NITROPRUSSIATO', qtd:'1', apres:'AMP', dose:'50MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Anti-hipertensivo'},
  {nome:'OCTREOTIDA', qtd:'', apres:'—', dose:'SANDOSTATINLAR', diluicao:'', via:'IM', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Hormônio sistêmico'},
  {nome:'PARACETAMOL', qtd:'1', apres:'BOLSA', dose:'10MG/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Analgésico/Antipirético'},
  {nome:'PARACETAMOL', qtd:'1', apres:'COMP', dose:'750MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Analgésico/Antipirético'},
  {nome:'PREDNISOLONA', qtd:'1', apres:'COMP', dose:'20MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Corticosteroide'},
  {nome:'PROPAFENONA', qtd:'1', apres:'COMP', dose:'300MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Antiarrítmico · <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> MPP/ALTA VIGILÂNCIA'},
  {nome:'PROPRANOLOL', qtd:'1', apres:'COMP', dose:'40MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Beta-bloq.'},
  {nome:'PROTAMINA', qtd:'1', apres:'AMP', dose:'', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Antídoto anticoag.'},
  {nome:'RANITIDINA/CIMETIDINA', qtd:'1', apres:'AMP', dose:'150MG/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Anti-H2'},
  {nome:'SALBUTAMOL', qtd:'1', apres:'SPRAY', dose:'', diluicao:'', via:'IN', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Beta2-agonista'},
  {nome:'SOTALOL', qtd:'1', apres:'COMP', dose:'120MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Antiarrítmico · <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> MPP/ALTA VIGILÂNCIA'},
  {nome:'SUCRALFATO', qtd:'', apres:'—', dose:'2G/10MLFLACONETE', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Protetor gástrico'},
  {nome:'SULFATO DE MAGNÉSIO', qtd:'1', apres:'AMP', dose:'50%', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Anticonvulsivante/Eletrólito'},
  {nome:'TENECTEPLASE', qtd:'1', apres:'FA', dose:'50MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Trombolítico'},
  {nome:'TERLIPRESSINA', qtd:'1', apres:'FA', dose:'1MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Hormônio sistêmico'},
  {nome:'TICAGRELOR', qtd:'1', apres:'COMP', dose:'90MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Antiagregante'},
  {nome:'VALPROATO DE SÓDIO', qtd:'', apres:'—', dose:'50MG/MLSOLUÇÃO', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Anticonvulsivante'},
  {nome:'VERAPAMIL', qtd:'1', apres:'COMP', dose:'80MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Antiarrítmico · <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> MPP/ALTA VIGILÂNCIA'},
  {nome:'ÁCIDO AMINOCAPROICO', qtd:'1', apres:'FR', dose:'1G', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Antifibrinolítico'},
  {nome:'ÁCIDO TRANEXÂMICO', qtd:'1', apres:'AMP', dose:'250MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Antifibrinolítico'},
];


/* ════════════════════════════════════════════════════════════════════════════
   PRESCRIÇÃO — estado e funções
   ════════════════════════════════════════════════════════════════════════════ */
let _rxItens = [];   // array de itens da prescrição atual
let _rxAcTarget = null; // input do autocomplete ativo

const RX_HORAS = ['20','22','24','02','04','06','08','10','12','14','16','18'];

// Ordena horários conforme a ordem de validade da prescrição (20h <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M3 8h10"/><path d="M9.5 4.5L13 8l-3.5 3.5"/></svg> 18h do dia seguinte)
// Horários especiais (BIC, SND, SN, ACM, EM USO) ficam no final
function _ordenarHorarios(hor){
  if(!hor||!hor.length) return hor;
  const ORDEM = ['20','21','22','23','24','01','02','03','04','05','06','07','08','09','10','11','12','13','14','15','16','17','18','19'];
  const especiais = new Set(['BIC','SND','SN','ACM','EM USO']);
  const normais = hor.filter(h=>!especiais.has(h));
  const extras  = hor.filter(h=>especiais.has(h));
  normais.sort((a,b)=> ORDEM.indexOf(a) - ORDEM.indexOf(b));
  return [...normais, ...extras];
}
const RX_VIAS  = ['VO','EV','SC','IM','SL','IN','SNE','SNG','OF','ORAL','TD','INH','BIC','INF','—'];
const RX_FREQS = ['BIC ACM','24/24H','12/12H','8/8H','6/6H','4/4H','2/2H','1/1H','1X/DIA','SN','6/6H SN','8/8H SN','ACM','ACM NOITE','SND','—'];
const RX_APRES = ['—','COMP','CAP','FA','AMP','ML','GTS','PUFF','JATO','SPRAY','SACHE','ADESIVO','UI','BOLSA','SER','FR','BISN','MEQ'];

/* ════════════════════════════════════════════════════════════════════════════
   BANCO CLÍNICO — apoio à decisão
   ─ Doses por peso, ajuste para função renal, interações, classes terapêuticas
   ─ Não substitui julgamento clínico — gera alertas, nunca bloqueia salvar
   ════════════════════════════════════════════════════════════════════════════ */

// Doses calculadas por peso (mg/kg). Chave = nome simplificado do fármaco.
// Resultado: array de strings com sugestões clínicas.
const RX_DOSE_PESO = {
  'vancomicina':      { intervalo:'15-20 mg/kg', uso:'8-12/12h', nota:'dose ataque 25-30 mg/kg' },
  'gentamicina':      { intervalo:'5-7 mg/kg',    uso:'24/24h',  nota:'dose única diária preferencial' },
  'amicacina':        { intervalo:'15-20 mg/kg', uso:'24/24h',  nota:'dose única diária' },
  'meropenem':        { intervalo:'1g',           uso:'8/8h',     nota:'2g 8/8h se SNC/meningite' },
  'piperacilina':     { intervalo:'4,5g',         uso:'6/6h',     nota:'infundir em 4h (PK/PD)' },
  'cefepima':         { intervalo:'2g',           uso:'8/8h',     nota:'1g 12/12h se ITU não complicada' },
  'ceftriaxona':      { intervalo:'2g',           uso:'24/24h',   nota:'4g se meningite' },
  'ampicilina':       { intervalo:'2g',           uso:'4/4h',     nota:'meningite' },
  'oxacilina':        { intervalo:'2g',           uso:'4/4h',     nota:'endocardite/estafilo MS' },
  'ciprofloxacino':   { intervalo:'400mg',        uso:'8/8h',     nota:'EV grave; 12/12h em geral' },
  'linezolida':       { intervalo:'600mg',        uso:'12/12h',   nota:'não ajusta renal' },
  'colistina':        { intervalo:'2,5 mg/kg',    uso:'12/12h',   nota:'ataque 5 mg/kg' },
  'enoxaparina prof': { intervalo:'40mg',         uso:'24/24h SC',nota:'TVP profilática' },
  'enoxaparina ter':  { intervalo:'1 mg/kg',      uso:'12/12h SC',nota:'terapêutica' },
  'noradrenalina':    { intervalo:'0,05-2 mcg/kg/min', uso:'BIC', nota:'titular pela PAM' },
  'dobutamina':       { intervalo:'2,5-20 mcg/kg/min', uso:'BIC', nota:'titular pela perfusão' },
  'fentanil':         { intervalo:'0,5-3 mcg/kg/h',    uso:'BIC', nota:'analgesia contínua' },
  'midazolam':        { intervalo:'0,02-0,1 mg/kg/h',  uso:'BIC', nota:'reduzir em idosos' },
  'propofol':         { intervalo:'1-3 mg/kg/h',       uso:'BIC', nota:'cuidado triglicérides' },
};

// Ajustes para clearance de creatinina (ClCr em mL/min)
// Retorna obj { ajuste:'recomendado', dose:'...', nota:'...' } ou null
const RX_AJUSTE_RENAL = {
  'vancomicina':    [ {clMin:50, dose:'dose padrão',           nota:'monitorar nível'},
                      {clMin:20, dose:'15 mg/kg 12-24/24h',    nota:'individualizar'},
                      {clMin:0,  dose:'15 mg/kg após HD',       nota:'dosar nível'} ],
  'gentamicina':    [ {clMin:50, dose:'dose padrão',           nota:''},
                      {clMin:20, dose:'normal 24/24h',         nota:'dosar nível'},
                      {clMin:0,  dose:'evitar / individualizar',nota:'dosar nível'} ],
  'amicacina':      [ {clMin:50, dose:'15 mg/kg 24/24h',       nota:''},
                      {clMin:20, dose:'15 mg/kg 36-48/48h',    nota:''},
                      {clMin:0,  dose:'individualizar',         nota:'dosar nível'} ],
  'meropenem':      [ {clMin:50, dose:'1g 8/8h',                nota:''},
                      {clMin:25, dose:'1g 12/12h',              nota:''},
                      {clMin:10, dose:'500mg 12/12h',           nota:''},
                      {clMin:0,  dose:'500mg 24/24h',           nota:'após HD'} ],
  'piperacilina':   [ {clMin:40, dose:'4,5g 6/6h',              nota:''},
                      {clMin:20, dose:'3,375g 6/6h',            nota:''},
                      {clMin:0,  dose:'2,25g 6/6h',             nota:''} ],
  'cefepima':       [ {clMin:60, dose:'2g 8/8h',                nota:''},
                      {clMin:30, dose:'2g 12/12h',              nota:''},
                      {clMin:10, dose:'1g 24/24h',              nota:''},
                      {clMin:0,  dose:'500mg 24/24h',           nota:'após HD'} ],
  'ceftazidima':    [ {clMin:50, dose:'2g 8/8h',                nota:''},
                      {clMin:30, dose:'2g 12/12h',              nota:''},
                      {clMin:0,  dose:'1g 24/24h',              nota:''} ],
  'ertapenem':      [ {clMin:30, dose:'1g 24/24h',              nota:''},
                      {clMin:0,  dose:'500mg 24/24h',           nota:''} ],
  'ciprofloxacino': [ {clMin:50, dose:'400mg 8-12/12h',         nota:''},
                      {clMin:30, dose:'400mg 12/12h',           nota:''},
                      {clMin:0,  dose:'400mg 24/24h',           nota:''} ],
  'levofloxacino':  [ {clMin:50, dose:'750mg 24/24h',           nota:''},
                      {clMin:20, dose:'750mg primeira, 500mg 48/48h', nota:''},
                      {clMin:0,  dose:'750mg primeira, 500mg após HD',nota:''} ],
  'fluconazol':     [ {clMin:50, dose:'dose padrão',            nota:''},
                      {clMin:0,  dose:'reduzir 50%',            nota:''} ],
  'enoxaparina':    [ {clMin:30, dose:'dose padrão',            nota:''},
                      {clMin:0,  dose:'1 mg/kg 24/24h se terapêutica · 30mg 24/24h se profilática', nota:'ou trocar p/ HNF'} ],
  'metformina':     [ {clMin:45, dose:'dose padrão',            nota:''},
                      {clMin:30, dose:'500mg 24/24h',           nota:''},
                      {clMin:0,  dose:'contraindicada',         nota:'risco acidose láctica'} ],
  'dapagliflozina': [ {clMin:45, dose:'dose padrão',            nota:''},
                      {clMin:0,  dose:'contraindicada',         nota:''} ],
  'rivaroxabana':   [ {clMin:50, dose:'dose padrão',            nota:''},
                      {clMin:15, dose:'15mg 24/24h',            nota:''},
                      {clMin:0,  dose:'contraindicada',         nota:''} ],
  'aciclovir':      [ {clMin:50, dose:'10 mg/kg 8/8h',          nota:''},
                      {clMin:25, dose:'10 mg/kg 12/12h',        nota:''},
                      {clMin:10, dose:'10 mg/kg 24/24h',        nota:''},
                      {clMin:0,  dose:'5 mg/kg 24/24h após HD', nota:''} ],
  'colistina':      [ {clMin:50, dose:'2,5 mg/kg 12/12h',       nota:''},
                      {clMin:30, dose:'1,5 mg/kg 12/12h',       nota:''},
                      {clMin:10, dose:'1,5 mg/kg 24/24h',       nota:''},
                      {clMin:0,  dose:'1,5 mg/kg 36/36h',       nota:''} ],
};

// Interações medicamentosas críticas em UTI
// Cada par: [substring1, substring2, gravidade ('alta'|'media'), texto do alerta]
const RX_INTERACOES = [
  ['varfarina','aas',         'alta',  'Sangramento — AAS+varfarina aumenta muito o risco. Avaliar troca/redução.'],
  ['varfarina','clopidogrel', 'alta',  'Risco hemorrágico grave (terapia tripla?). Reavaliar indicação.'],
  ['varfarina','enoxaparina', 'alta',  'Anticoagulação dupla — confirmar transição/sobreposição.'],
  ['varfarina','heparina',    'alta',  'Anticoagulação dupla — apenas em transição (INR ≥ 2 por 24h).'],
  ['varfarina','dipirona',    'media', 'Possível aumento do INR — monitorar INR mais frequente.'],
  ['varfarina','amiodarona',  'media', 'Amiodarona ↑INR — reduzir dose da varfarina 30-50%.'],
  ['enoxaparina','aas',       'media', 'Sangramento — ponderar se ambos necessários.'],
  ['enoxaparina','clopidogrel','media','Sangramento — terapia dupla, monitorar.'],
  ['enoxaparina','heparina',  'alta',  'Anticoagulação dupla — não associar.'],
  ['aas','clopidogrel',       'media', 'DAPT — ok se indicada (SCA/stent). Senão, retirar AAS.'],
  ['ciprofloxacino','azitromicina','alta','Prolongamento de QT — risco de torsade. Trocar uma.'],
  ['levofloxacino','azitromicina','alta','Prolongamento de QT — risco de torsade.'],
  ['moxifloxacino','azitromicina','alta','Prolongamento de QT — não associar.'],
  ['amiodarona','azitromicina','alta', 'Prolongamento de QT — risco de torsade.'],
  ['amiodarona','ciprofloxacino','alta','Prolongamento de QT — monitorar ECG.'],
  ['amiodarona','levofloxacino','alta','Prolongamento de QT.'],
  ['amiodarona','haloperidol', 'alta', 'Prolongamento de QT — monitorar ECG.'],
  ['amiodarona','metoprolol',  'media','Bradicardia/BAV — monitorar FC e PR.'],
  ['amiodarona','digoxina',    'alta', 'Amiodarona ↑digoxina ~70% — reduzir digoxina 50%.'],
  ['captopril','espironolactona','media','Hipercalemia — monitorar K+ frequente.'],
  ['enalapril','espironolactona','media','Hipercalemia — monitorar K+.'],
  ['losartana','espironolactona','media','Hipercalemia — monitorar K+.'],
  ['captopril','losartana',    'media','IECA+BRA — evitar associação rotineira.'],
  ['enalapril','losartana',    'media','IECA+BRA — evitar associação rotineira.'],
  ['linezolida','fentanil',    'media','Risco de síndrome serotoninérgica — vigiar.'],
  ['linezolida','tramadol',    'alta', 'Síndrome serotoninérgica — não associar.'],
  ['haloperidol','quetiapina', 'media','Sedação aditiva e prolongamento de QT.'],
  ['fluconazol','varfarina',   'alta', 'Fluconazol ↑↑ varfarina — reduzir varfarina 50%.'],
  ['vancomicina','gentamicina','media','Nefrotoxicidade aditiva — monitorar Cr diariamente.'],
  ['vancomicina','amicacina',  'media','Nefrotoxicidade aditiva — monitorar Cr.'],
  ['vancomicina','furosemida', 'media','Nefrotoxicidade/ototoxicidade — monitorar.'],
  ['gentamicina','furosemida', 'media','Ototoxicidade aditiva — usar com cautela.'],
  ['metformina','contraste',   'alta', 'Suspender metformina 48h antes/depois de contraste iodado.'],
];

// Classes terapêuticas para detectar redundância
const RX_CLASSES = [
  { id:'IECA',           termos:['captopril','enalapril','lisinopril','ramipril'] },
  { id:'BRA',            termos:['losartana','valsartana','candesartana','olmesartana'] },
  { id:'Betabloq',       termos:['metoprolol','atenolol','propranolol','carvedilol','bisoprolol'] },
  { id:'IBP',            termos:['omeprazol','pantoprazol','esomeprazol','lansoprazol'] },
  { id:'Opioide fixo',   termos:['morfina','tramadol','fentanil 50mcg/ml']  /* fixos, não SOS */ },
  { id:'Benzodiazepínico',termos:['midazolam','diazepam','clonazepam'] },
  { id:'Antipsicótico',  termos:['haloperidol','quetiapina','olanzapina','risperidona','amplictil'] },
  { id:'Estatina',       termos:['sinvastatina','rosuvastatina','atorvastatina','pravastatina'] },
  { id:'Anticoag.',      termos:['varfarina','rivaroxabana','enoxaparina','heparina','apixabana'] },
  { id:'Antiagreg.',     termos:['aas','clopidogrel','ticagrelor','prasugrel'] },
  { id:'Diurético alça', termos:['furosemida','bumetanida'] },
  { id:'Cefalosporina 3G',termos:['ceftriaxona','cefotaxima','ceftazidima'] },
  { id:'Cefalosporina 4G',termos:['cefepima'] },
  { id:'Carbapenêmico',  termos:['meropenem','imipenem','ertapenem'] },
  { id:'Fluoroquinolona',termos:['ciprofloxacino','levofloxacino','moxifloxacino'] },
  { id:'Aminoglicosídeo',termos:['gentamicina','amicacina','tobramicina'] },
];

// Fármacos que precisam de ajuste renal (para alertar quando TFG baixa)
const RX_NEFRO_TOXICOS = ['vancomicina','gentamicina','amicacina','meropenem','piperacilina',
  'cefepima','ceftazidima','ertapenem','ciprofloxacino','levofloxacino','fluconazol',
  'enoxaparina','metformina','dapagliflozina','rivaroxabana','aciclovir','colistina','aas'];

// Profilaxias típicas em UTI — para validação de omissão
const RX_PROFILAXIAS_VMI = ['enoxaparina','heparina','omeprazol','pantoprazol','esomeprazol','ranitidina'];

/* ───────────────────────────────────────────────────────────────────────────
   GRUPOS DE ALERGIA — quando o paciente declara alergia a um item do grupo,
   todos os outros itens do mesmo grupo viram alertas (cross-reatividade).
   Cada grupo: { id, termos:[substrings normalizadas que disparam o grupo] }
   ─────────────────────────────────────────────────────────────────────── */
const RX_ALERGIA_GRUPOS = [
  { id:'Penicilinas (cross-reat. cefalosporinas ~5-10%)',
    termos:['penicilina','ampicilina','amoxicilina','oxacilina','piperacilina','tazobactam'],
    cruza:['cefalosporina','cefazolina','cefalotina','cefuroxima','cefoxitina','ceftriaxona','cefepima','ceftazidima','cefotaxima','cefalexina'] },
  { id:'Cefalosporinas',
    termos:['cefalosporina','cefazolina','cefalotina','cefuroxima','cefoxitina','ceftriaxona','cefepima','ceftazidima','cefotaxima','cefalexina'],
    cruza:['penicilina','ampicilina','amoxicilina','oxacilina'] },
  { id:'Sulfas',
    termos:['sulfa','sulfametoxazol','sulfadiazina','bactrim','dapsona'],
    cruza:['furosemida','hidroclorotiazida','tiazid','glibenclamida','sulfasalazina'] },
  { id:'AINE / dipirona / paracetamol',
    termos:['aas','aspirina','ibuprofeno','diclofenaco','cetoprofeno','naproxeno','nimesulida','tenoxicam','dipirona','paracetamol'],
    cruza:['aas','dipirona','paracetamol','ibuprofeno','diclofenaco','cetoprofeno','tenoxicam'] },
  { id:'Opioides',
    termos:['morfina','codeina','tramadol','fentanil','metadona','oxicodona','dimorf','nalbufina'],
    cruza:['morfina','codeina','tramadol','fentanil','nalbufina'] },
  { id:'Quinolonas',
    termos:['ciprofloxacino','levofloxacino','moxifloxacino','norfloxacino','quinolona'],
    cruza:['ciprofloxacino','levofloxacino','moxifloxacino'] },
  { id:'Macrolídeos',
    termos:['azitromicina','claritromicina','eritromicina','macrolid'],
    cruza:['azitromicina','claritromicina','eritromicina'] },
  { id:'Aminoglicosídeos',
    termos:['gentamicina','amicacina','tobramicina','neomicina','estreptomicina','aminoglic'],
    cruza:['gentamicina','amicacina','tobramicina'] },
  { id:'Iodo / contraste',
    termos:['iodo','contraste','iodado'],
    cruza:['amiodarona'] }, // amiodarona contém iodo
  { id:'Heparinas (cross-reat. HBPM se TIH)',
    termos:['heparina','enoxaparina','hbpm','tih','trombocitopenia heparina'],
    cruza:['heparina','enoxaparina','dalteparin','nadroparin'] },
];

/* ───────────────────────────────────────────────────────────────────────────
   FAIXAS DE DOSE PARA SANITY-CHECK (#7)
   Pega o número principal da string "dose" e checa contra max razoável.
   Se a unidade declarada na string conflitar com a expected, alerta.
   ─────────────────────────────────────────────────────────────────────── */
const RX_DOSE_FAIXAS = {
  // BICs vasoativas/sedativas — em mcg/kg/min ou mcg/kg/h normalmente
  'noradrenalina':  { maxBolus:0, maxBIC:2,   unidBIC:'mcg/kg/min', alerta:'Faixa típica 0,05–2 mcg/kg/min. Dose >2 é excepcional.' },
  'adrenalina':     { maxBolus:1, maxBIC:1,   unidBIC:'mcg/kg/min', alerta:'BIC 0,01–1 mcg/kg/min; bolus 1mg na PCR.' },
  'dobutamina':     { maxBolus:0, maxBIC:20,  unidBIC:'mcg/kg/min', alerta:'Faixa 2,5–20 mcg/kg/min.' },
  'dopamina':       { maxBolus:0, maxBIC:20,  unidBIC:'mcg/kg/min', alerta:'Faixa 2–20 mcg/kg/min.' },
  'nitroprussiato': { maxBolus:0, maxBIC:10,  unidBIC:'mcg/kg/min', alerta:'Faixa 0,5–10 mcg/kg/min.' },
  'fentanil':       { maxBolus:300, maxBIC:5, unidBIC:'mcg/kg/h',   alerta:'BIC 0,5–3 mcg/kg/h (até 5 em casos selecionados).' },
  'midazolam':      { maxBolus:10,  maxBIC:0.2, unidBIC:'mg/kg/h',  alerta:'BIC 0,02–0,1 mg/kg/h.' },
  'propofol':       { maxBolus:0,   maxBIC:4,   unidBIC:'mg/kg/h',  alerta:'BIC 1–3 mg/kg/h; >4 <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M3 8h10"/><path d="M9.5 4.5L13 8l-3.5 3.5"/></svg> risco de PRIS.' },
  // Antibióticos
  'meropenem':      { maxDose:2000, unid:'mg',  alerta:'Máx 2g por dose (SNC).' },
  'piperacilina':   { maxDose:4500, unid:'mg',  alerta:'Máx 4,5g por dose.' },
  'vancomicina':    { maxDose:2500, unid:'mg',  alerta:'Doses únicas >2,5g são incomuns (checar mg/kg).' },
  'ceftriaxona':    { maxDose:4000, unid:'mg',  alerta:'Máx 4g/dia (meningite); >4g por dose alerta.' },
  'cefepima':       { maxDose:2000, unid:'mg',  alerta:'Máx 2g por dose.' },
  'gentamicina':    { maxDose:700,  unid:'mg',  alerta:'Dose única diária ~5-7 mg/kg; >700mg geralmente é excessivo.' },
  'amicacina':      { maxDose:1500, unid:'mg',  alerta:'15-20 mg/kg/dia; >1,5g em dose única é alto.' },
  // Outros
  'dipirona':       { maxDose:2000, unid:'mg',  alerta:'Dose máxima por toma: 2g (1 amp).' },
  'paracetamol':    { maxDose:1000, unid:'mg',  alerta:'Máx 1g por dose, 4g/dia.' },
  'enoxaparina':    { maxDose:120,  unid:'mg',  alerta:'Profilática 40mg/dia; terapêutica 1mg/kg 12/12h.' },
  'furosemida':     { maxDose:500,  unid:'mg',  alerta:'Doses >500mg em bolus são excepcionais.' },
  'hidrocortisona': { maxDose:500,  unid:'mg',  alerta:'Choque séptico: 50mg 6/6h; >500mg em dose única alerta.' },
};



// Ordena os itens da prescrição pela prioridade de categoria
function _rxOrdenar(){
  _rxItens.sort((a,b)=>{
    const pa = RX_PRIO[a._cat||'Medicação Geral'] || 6;
    const pb = RX_PRIO[b._cat||'Medicação Geral'] || 6;
    return pa - pb;
  });
  _renderPrescricao();
  toast('Itens reordenados por prioridade clínica.');
}

function _rxNovoItem(tipo){
  return { id:Date.now()+Math.random(), farm:'', qtd:'', apres:'', dose:'', diluicao:'', via:'EV', freq:'24/24H', hor:[], obs:'', tipo:tipo||'normal', _cat:'Medicação Geral', ddInicio:'', vazao:'' };
}

/* ════════════════════════════════════════════════════════════════════════════
   MOTOR CLÍNICO — TFG, doses por peso, interações, redundância
   ════════════════════════════════════════════════════════════════════════════ */

// ── Função renal — Cockcroft-Gault e CKD-EPI 2021 ──
function _calcularTFG(){
  const peso=parseFloat(gf('f-peso'))||null;
  const dn=gf('f-dn');
  const sexo=(gf('f-sexo')||'').toUpperCase();
  const crInfo=_ultimaCreatininaComData();
  if(!crInfo||!dn) return null;
  const cr=crInfo.valor;
  const idade=_idadeDeDN(dn);
  if(!idade) return null;

  // Cockcroft-Gault: ((140-idade) × peso × (0.85 se F)) / (72 × Cr)
  let cg=null;
  if(peso){
    cg = ((140-idade)*peso*(sexo==='FEMININO'?0.85:1))/(72*cr);
  }

  // CKD-EPI 2021 (sem raça)
  const k = sexo==='FEMININO' ? 0.7 : 0.9;
  const a = sexo==='FEMININO' ? -0.241 : -0.302;
  const minR = Math.min(cr/k, 1);
  const maxR = Math.max(cr/k, 1);
  const ckdepi = 142 * Math.pow(minR, a) * Math.pow(maxR, -1.200) *
    Math.pow(0.9938, idade) * (sexo==='FEMININO' ? 1.012 : 1);

  // Idade da creatinina em dias (para alerta de exame antigo)
  let diasCr=null;
  if(crInfo.data){
    const hoje = new Date(); hoje.setHours(0,0,0,0);
    const dCr  = new Date(crInfo.data+'T00:00:00');
    diasCr = Math.floor((hoje - dCr) / 86400000);
  }

  // Equação preferida para ajuste de dose: CG quando há peso; senão CKD-EPI
  const equacaoPreferida = (cg!=null) ? 'CG' : 'CKD-EPI';
  const tfgPreferida     = (cg!=null) ? Math.round(cg) : Math.round(ckdepi);

  return {
    cg: cg!=null?Math.round(cg):null,
    ckdepi:Math.round(ckdepi),
    cr, dataCr:crInfo.data||null, diasCr,
    idade, peso, sexo,
    equacaoPreferida, tfgPreferida
  };
}
function _ultimaCreatininaComData(){
  if(_labLinhas&&_labLinhas.length){
    const ord=[..._labLinhas].filter(l=>l.data).sort((a,b)=>(a.data||'').localeCompare(b.data||''));
    for(let i=ord.length-1;i>=0;i--){
      const v=ord[i].valores&&ord[i].valores.cr;
      if(v!=null&&v!=='') return { valor:parseFloat(v), data:ord[i].data };
    }
  }
  return null;
}
// Mantém compat com chamadas antigas
function _ultimaCreatinina(){ const r=_ultimaCreatininaComData(); return r?r.valor:null; }
function _atualizarTFG(){
  // Se a aba de prescrição estiver aberta, re-renderiza o painel de apoio
  const aba=$('aba-prescricao');
  if(aba && aba.style.display!=='none') _renderApoioClinico();
}

// ── Identifica fármaco do banco a partir do nome digitado ──
// Retorna a chave (em minúsculas) ou null. Procura a chave mais longa que casa.
function _identificarFarmaco(nome, banco){
  if(!nome) return null;
  const n = nome.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  // Se um banco específico foi passado, procura nele; senão une os dois
  const chaves = banco ? Object.keys(banco) : Object.keys(RX_DOSE_PESO).concat(Object.keys(RX_AJUSTE_RENAL));
  // Ordena por tamanho decrescente para casar primeiro a chave mais específica
  const ordenadas = [...chaves].sort((a,b)=>b.length-a.length);
  for(const k of ordenadas){
    const kN = k.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    // Match por primeira palavra ou por nome completo da chave
    const primeira = kN.split(' ')[0];
    if(n.includes(primeira)) return k;
  }
  return null;
}

// ── Sugestão de dose por peso ──
function _sugerirDosePorPeso(item){
  const peso=parseFloat(gf('f-peso')); if(!peso) return null;
  const farm=_identificarFarmaco(item.farm, RX_DOSE_PESO);
  if(!farm||!RX_DOSE_PESO[farm]) return null;
  const d=RX_DOSE_PESO[farm];
  // Tenta calcular numérico se for mg/kg simples
  const m=d.intervalo.match(/^([\d,\.]+)(?:-([\d,\.]+))?\s*mg\/kg/);
  let calc='';
  if(m){
    const dMin=parseFloat(m[1].replace(',','.')), dMax=m[2]?parseFloat(m[2].replace(',','.')):dMin;
    const totMin=Math.round(dMin*peso), totMax=Math.round(dMax*peso);
    calc = ` <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M3 8h10"/><path d="M9.5 4.5L13 8l-3.5 3.5"/></svg> <b>${totMin===totMax?totMin:totMin+'-'+totMax} mg</b> p/ ${peso}kg`;
  }
  return { farm, intervalo:d.intervalo, uso:d.uso, nota:d.nota, calc };
}

// ── Ajuste para função renal ──
function _ajusteRenal(item, tfg){
  const farm=_identificarFarmaco(item.farm, RX_AJUSTE_RENAL);
  if(!farm||!RX_AJUSTE_RENAL[farm]||!tfg) return null;
  const faixas=RX_AJUSTE_RENAL[farm];
  let aj=null;
  for(const f of faixas){ if(tfg>=f.clMin){ aj=f; break; } }
  if(!aj) aj=faixas[faixas.length-1];
  return { farm, ...aj, tfg };
}

// ── Detecta interações entre itens da prescrição ──
function _detectarInteracoes(){
  const farms=_rxItens.map(it=>(it.farm||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,''));
  const achados=[];
  for(const [a,b,grav,texto] of RX_INTERACOES){
    const tA=farms.some(f=>f.includes(a));
    const tB=farms.some(f=>f.includes(b));
    if(tA&&tB) achados.push({a,b,grav,texto});
  }
  return achados;
}

// ── Detecta redundância de classe terapêutica ──
function _detectarRedundancia(){
  const farms=_rxItens.map(it=>(it.farm||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,''));
  const achados=[];
  for(const cls of RX_CLASSES){
    const matches=cls.termos.filter(t=>farms.some(f=>f.includes(t)));
    if(matches.length>=2) achados.push({classe:cls.id, itens:matches});
  }
  return achados;
}

// ── Detecta omissão de profilaxia em VMI ──
function _detectarOmissoes(){
  const dados=gf('f-vent');
  const farms=_rxItens.map(it=>(it.farm||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,''));
  const avisos=[];
  if(dados==='VMI'){
    const temTVP = farms.some(f=>/enoxaparina|heparina/.test(f));
    const temUlcera = farms.some(f=>/omeprazol|pantoprazol|esomeprazol|ranitidina/.test(f));
    if(!temTVP) avisos.push('Paciente em VMI sem profilaxia de TVP (enoxaparina/heparina).');
    if(!temUlcera) avisos.push('Paciente em VMI sem profilaxia de úlcera de estresse (IBP).');
  }
  return avisos;
}

/* ────────────────────────────────────────────────────────────────────────
   #1 ─ ALERGIA × PRESCRIÇÃO (cruzamento)
   ──────────────────────────────────────────────────────────────────────── */
function _normFarm(s){
  return (s||'').toString().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();
}
function _detectarAlergiasCruzadas(){
  const txt=(gf('f-alergia')||'').trim();
  if(!txt || /^(nega|nao|não|nenhuma|-|—)$/i.test(txt)) return [];
  const alergenos=txt.split(/[,;/]|\s+e\s+|\s*\+\s*/i)
    .map(s=>_normFarm(s)).filter(s=>s && s.length>=3 && !/^(sem|nega|não|nenhuma)$/.test(s));
  if(!alergenos.length) return [];
  const itens=_rxItens.map(it=>({raw:it.farm||'', n:_normFarm(it.farm)})).filter(o=>o.n);
  const achados=[]; const visto=new Set();
  alergenos.forEach(alg=>{
    itens.forEach(o=>{
      if(o.n.includes(alg) || (alg.length>=4 && alg.includes(o.n.split(' ')[0]))){
        const k=alg+'|'+o.n;
        if(!visto.has(k)){ visto.add(k);
          achados.push({alergeno:alg.toUpperCase(), farmaco:o.raw, motivo:'match direto', grupo:''}); }
      }
    });
    RX_ALERGIA_GRUPOS.forEach(g=>{
      const algNoGrupo = g.termos.some(t=>alg.includes(t)||t.includes(alg));
      if(!algNoGrupo) return;
      const universo = [...new Set([...g.termos, ...(g.cruza||[])])];
      itens.forEach(o=>{
        universo.forEach(termo=>{
          if(o.n.includes(termo)){
            if(o.n.includes(alg)) return;
            const k=alg+'|'+o.n+'|'+g.id;
            if(!visto.has(k)){ visto.add(k);
              achados.push({alergeno:alg.toUpperCase(), farmaco:o.raw, motivo:'cross-reatividade', grupo:g.id}); }
          }
        });
      });
    });
  });
  return achados;
}

/* ────────────────────────────────────────────────────────────────────────
   #2 ─ DUPLICATA DE ITEM (mesmo fármaco prescrito 2× na prescrição atual)
   ──────────────────────────────────────────────────────────────────────── */
function _detectarDuplicatasManual(){
  const norm=s=>_normFarm(s).split(/\s+/)[0]||'';
  const SKIP=new Set(['dieta','jejum','cuidado','cuidados','ssvv','curativo','sonda','sf','sg','ringer','soro','jelco','—','']);
  const map={};
  _rxItens.forEach((it,idx)=>{
    const base=norm(it.farm);
    if(!base || SKIP.has(base) || base.length<4) return;
    map[base]=map[base]||[];
    map[base].push({idx, nome:it.farm, dose:it.dose, freq:it.freq, via:it.via});
  });
  const dups=[];
  Object.entries(map).forEach(([base,arr])=>{
    if(arr.length<2) return;
    dups.push({base, itens:arr});
  });
  return dups;
}

/* ────────────────────────────────────────────────────────────────────────
   #7 ─ SANITY-CHECK DE DOSE (faixas absurdas / unidade errada)
   ──────────────────────────────────────────────────────────────────────── */
function _extrairDoseNumero(doseStr){
  if(!doseStr) return null;
  const m=String(doseStr).replace(',','.').match(/(\d+(?:\.\d+)?)\s*(mcg\/kg\/min|mcg\/kg\/h|mg\/kg\/h|mcg\/kg|mg\/kg|mcg\/min|ui\/min|mg|mcg|g|ml|ui|%)?/i);
  if(!m) return null;
  return { num:parseFloat(m[1]), unid:(m[2]||'').toLowerCase() };
}
function _detectarDosesAbsurdas(){
  const achados=[];
  _rxItens.forEach(it=>{
    const farm=_identificarFarmaco(it.farm, RX_DOSE_FAIXAS);
    if(!farm || !RX_DOSE_FAIXAS[farm]) return;
    const r=RX_DOSE_FAIXAS[farm];
    const d=_extrairDoseNumero(it.dose);
    if(!d || !isFinite(d.num)) return;
    const ehBIC = /BIC/i.test(it.freq||'');
    let val=d.num, unid=d.unid;
    if(unid==='g'){ val=val*1000; unid='mg'; }
    if(ehBIC && r.maxBIC){
      // Só alerta se a unidade é farmacológica (mcg/kg/min). "25MG/ML" é concentração, não dose.
      if(!_doseBICUnidCompativel(unid)) return;
      if(val > r.maxBIC*1.2)
        achados.push({nome:it.farm, dose:it.dose, motivo:`Dose ${val}${unid||''} excede faixa esperada (${r.unidBIC}). ${r.alerta}`});
    } else if(r.maxDose && unid==='mg'){
      if(val > r.maxDose*1.2)
        achados.push({nome:it.farm, dose:it.dose, motivo:`Dose ${val}mg acima do máximo esperado (${r.maxDose}mg). ${r.alerta}`});
    } else if(r.maxDose && unid==='mcg'){
      const mg=val/1000;
      if(mg > r.maxDose*1.2)
        achados.push({nome:it.farm, dose:it.dose, motivo:`Dose ${val}mcg (${mg.toFixed(1)}mg) acima do máximo. ${r.alerta}`});
    } else if(!unid && r.maxDose){
      if(val > r.maxDose*3)
        achados.push({nome:it.farm, dose:it.dose, motivo:`Dose "${it.dose}" sem unidade clara. Esperado em mg, máx ~${r.maxDose}mg.`});
    }
  });
  return achados;
}

/* ────────────────────────────────────────────────────────────────────────
   #4 ─ mL/h automático para BICs (peso × dose × diluição padrão)
   Mapeia fármacos do banco para BIC_DROGAS usando primeira palavra.
   Para cada item BIC com dose definida, calcula mL/h se houver peso.
   ──────────────────────────────────────────────────────────────────────── */
function _bicMatchDroga(nomeItem){
  const n=_normFarm(nomeItem);
  if(!n) return null;
  return BIC_DROGAS.find(d=>{
    const dn=_normFarm(d.nome).split(/\s+/)[0]; // 'noradrenalina', 'dobutamina'...
    return n.includes(dn);
  })||null;
}
function _calcularMLhBIC(d, dose, peso){
  if(!d || !isFinite(dose) || dose<=0) return null;
  if(d.unidade==='mcg/kg/min'){
    if(!peso) return null;
    return (dose*peso*60*d.vol)/d.totalMcg;
  }
  if(d.unidade==='mcg/min')   return (dose*60*d.vol)/d.totalMcg;
  if(d.unidade==='UI/min')    return (dose*60*d.vol)/d.totalUI;
  if(d.unidade==='mcg/kg/h'){ if(!peso) return null; return (dose*peso*d.vol)/d.totalMcg; }
  if(d.unidade==='mg/kg/h'){  if(!peso) return null; return (dose*peso*d.vol)/d.totalMg; }
  return null;
}
// Retorna true apenas quando a unidade extraída é farmacológica (mcg/kg/min, etc.)
// Concentrações como "25MG/ML" <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M3 8h10"/><path d="M9.5 4.5L13 8l-3.5 3.5"/></svg> unid='mg' <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M3 8h10"/><path d="M9.5 4.5L13 8l-3.5 3.5"/></svg> false (não é dose de infusão)
function _doseBICUnidCompativel(unidExtraida){
  const u = (unidExtraida||'').toLowerCase().replace(/\s+/g,'');
  const CONC = ['ml','mg','mcg','g','ui','%',''];
  return !CONC.includes(u);
}
function _calcularBICs(){
  const peso=parseFloat(gf('f-peso'))||null;
  const lista=[];
  _rxItens.forEach(it=>{
    if(!/BIC/i.test(it.freq||'')) return;
    const droga=_bicMatchDroga(it.farm);
    if(!droga) return;
    const d=_extrairDoseNumero(it.dose);
    if(!d) return;
    // Só calcula mL/h e fora-da-faixa quando a dose está em unidade farmacológica
    // (ex: mcg/kg/min). Concentrações como "25MG/ML" não são doses de infusão.
    const unidOK = _doseBICUnidCompativel(d.unid);
    const mlh = unidOK ? _calcularMLhBIC(droga, d.num, peso) : null;
    lista.push({
      nomeItem: it.farm,
      droga: droga.nome,
      diluicao: droga.diluicao,
      dose: it.dose,
      doseUnidade: droga.unidade,
      faixa: droga.faixa,
      mlh: (mlh!=null && isFinite(mlh)) ? mlh : null,
      semPeso: droga.porPeso && !peso && unidOK,
      foraFaixa: unidOK ? _doseForaFaixa(d.num, droga.faixa) : false,
    });
  });
  return lista;
}
function _doseForaFaixa(val, faixaStr){
  const m=String(faixaStr||'').match(/([\d.,]+)\s*[–-]\s*([\d.,]+)/);
  if(!m) return false;
  const lo=parseFloat(m[1].replace(',','.')), hi=parseFloat(m[2].replace(',','.'));
  return val<lo || val>hi;
}

/* ────────────────────────────────────────────────────────────────────────
   #9 ─ DIFF COM PRESCRIÇÃO DE ONTEM (novo, suspenso, alterado)
   Identifica por primeira palavra do nome. Retorna {novos, suspensos, alterados}.
   ──────────────────────────────────────────────────────────────────────── */
let _rxDiffOntem = null; // cache: { data:'2025-06-04', novos:[], suspensos:[], alterados:[] }

async function _calcularDiffOntem(){
  if(!leitoAtual) { _rxDiffOntem=null; return null; }
  try{
    const dataAtual=gf('f-data')||hoje();
    const all=await dbListByPrefix(`uti_med_rx_${leitoAtual}_`);
    const arr=Object.values(all).filter(rx=>rx&&rx.data&&rx.data<dataAtual);
    if(!arr.length){ _rxDiffOntem={data:null, novos:[], suspensos:[], alterados:[], semAnterior:true}; return _rxDiffOntem; }
    arr.sort((a,b)=>(b.data||'').localeCompare(a.data||''));
    const ontem=arr[0];

    const baseNome = it => _normFarm(it.farm).split(/\s+/)[0]||'';
    const mapHoje = {}, mapOntem = {};
    _rxItens.forEach(it=>{ const k=baseNome(it); if(k) mapHoje[k]=it; });
    (ontem.itens||[]).forEach(it=>{ const k=baseNome(it); if(k) mapOntem[k]=it; });

    const novos=[], suspensos=[], alterados=[];
    Object.keys(mapHoje).forEach(k=>{
      if(!mapOntem[k]) novos.push(mapHoje[k]);
      else {
        const a=mapOntem[k], b=mapHoje[k];
        const diffs=[];
        if((a.dose||'').toUpperCase()!==(b.dose||'').toUpperCase()) diffs.push(`dose ${a.dose||'?'} <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M3 8h10"/><path d="M9.5 4.5L13 8l-3.5 3.5"/></svg> ${b.dose||'?'}`);
        if((a.freq||'').toUpperCase()!==(b.freq||'').toUpperCase()) diffs.push(`freq ${a.freq||'?'} <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M3 8h10"/><path d="M9.5 4.5L13 8l-3.5 3.5"/></svg> ${b.freq||'?'}`);
        if((a.via ||'').toUpperCase()!==(b.via ||'').toUpperCase()) diffs.push(`via ${a.via||'?'} <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M3 8h10"/><path d="M9.5 4.5L13 8l-3.5 3.5"/></svg> ${b.via||'?'}`);
        if(diffs.length) alterados.push({item:b, diffs});
      }
    });
    Object.keys(mapOntem).forEach(k=>{
      if(!mapHoje[k]) suspensos.push(mapOntem[k]);
    });

    _rxDiffOntem = { data:ontem.data, novos, suspensos, alterados, semAnterior:false };
    return _rxDiffOntem;
  } catch(e){ console.warn('diff ontem:', e); _rxDiffOntem=null; return null; }
}

// ── Badge "D-X" para itens da categoria ATB ──
let _ddiaCache = {}; // mantido para compatibilidade com _renderApoioClinico
// Badge "D-X" para ATBs — usa it._ddia calculado por _rxAtualizarDdias
function _rxBadgeDdia(it){
  if(it._cat!=='ATB') return '';
  if(it._ddia===undefined||it._ddia===null) return '';
  const d=it._ddia;
  const cor = d>=10 ? '#b71c1c' : d>=7 ? '#e65100' : '#1565c0';
  return `<span class="rx-ddia" style="background:${cor};" title="D${d} — início em ${it.ddInicio||'?'}">D${d}</span>`;
}

async function _calcularDdiaATBs(){
  // Procura nas evoluções anteriores deste leito a primeira menção a cada ATB
  if(!leitoAtual) return {};
  const all=await dbListByPrefix(`uti_med_rx_${leitoAtual}_`);
  const datas={}; // {nomeATB simplificado: data primeira ocorrência}
  Object.values(all).forEach(rx=>{
    if(!rx||!rx.itens||!rx.data) return;
    rx.itens.forEach(it=>{
      if(it._cat!=='ATB') return;
      const k=(it.farm||'').toUpperCase().split(/\s+/).slice(0,2).join(' ').trim();
      if(!k) return;
      if(!datas[k] || rx.data<datas[k]) datas[k]=rx.data;
    });
  });
  const hojeDt=new Date(gf('f-data')||hoje()+'T00:00:00');
  const dias={};
  Object.entries(datas).forEach(([k,d])=>{
    const dt=new Date(d+'T00:00:00');
    const diff=Math.floor((hojeDt-dt)/(86400000));
    dias[k]=diff;
  });
  return dias;
}

// ── Renderiza o painel de apoio clínico (cards no topo da prescrição) ──
async function _renderApoioClinico(){
  const wrap=$('presc-apoio'); if(!wrap) return;
  const tfg=_calcularTFG();
  const alergias=_detectarAlergiasCruzadas();   // #1
  const duplicatas=_detectarDuplicatasManual(); // #2
  const interacoes=_detectarInteracoes();
  const redund=_detectarRedundancia();
  const omissoes=_detectarOmissoes();
  const dosesAbsurdas=_detectarDosesAbsurdas(); // #7
  const bics=_calcularBICs();                    // #4
  const diff=await _calcularDiffOntem();         // #9
  _ddiaCache = await _calcularDdiaATBs();

  let h='';

  // ── #1 ALERGIAS — TOPO, em vermelho intenso ─────────────────────────────
  if(alergias.length){
    h+=`<div class="apoio-card apoio-alerta" style="border-left:4px solid #b71c1c;background:#ffeae8;">
      <div class="apoio-titulo" style="color:#b71c1c;"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3a5 5 0 015 5v2H3V8a5 5 0 015-5z"/><rect x="3" y="10" width="10" height="2" rx=".5"/><line x1="8" y1="1" x2="8" y2="2.5"/><line x1="3" y1="3" x2="4" y2="4"/><line x1="13" y1="3" x2="12" y2="4"/></svg> ALERGIA × PRESCRIÇÃO (${alergias.length})</div>
      ${alergias.map(a=>`<div class="apoio-item apoio-alta">
        <b>${(a.farmaco||'').toUpperCase()}</b> conflita com alergia a <b>${a.alergeno}</b>${a.motivo==='cross-reatividade'?` <em>(cross-reatividade: ${a.grupo})</em>`:''}
      </div>`).join('')}
    </div>`;
  }

  // ── #2 DUPLICATAS MANUAIS ────────────────────────────────────────────────
  if(duplicatas.length){
    h+=`<div class="apoio-card apoio-warn">
      <div class="apoio-titulo"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> ITEM DUPLICADO (${duplicatas.length})</div>
      ${duplicatas.map(d=>`<div class="apoio-item">
        <b>${d.base.toUpperCase()}</b> prescrito ${d.itens.length}× —
        ${d.itens.map(x=>`<span>${(x.nome||'').toUpperCase()}${x.dose?' '+x.dose:''}${x.freq?' · '+x.freq:''}</span>`).join(' / ')}
      </div>`).join('')}
    </div>`;
  }

  // ── #5 + #6: TFG com equação preferida e idade da creatinina ────────────
  if(tfg){
    const corCG = tfg.cg && tfg.cg<30 ? 'var(--vermelho)' : tfg.cg && tfg.cg<60 ? 'var(--laranja)' : 'var(--verde)';
    const corCK = tfg.ckdepi<30 ? 'var(--vermelho)' : tfg.ckdepi<60 ? 'var(--laranja)' : 'var(--verde)';
    const dataCrTxt = tfg.dataCr ? _fmtDataCurta(tfg.dataCr) : 'data?';
    const crVelha   = (tfg.diasCr!=null && tfg.diasCr>2);
    const crAvisoCor = tfg.diasCr==null ? 'var(--muted)'
                       : tfg.diasCr>4 ? 'var(--vermelho)'
                       : tfg.diasCr>2 ? 'var(--laranja)' : 'var(--verde)';
    const crAvisoTxt = tfg.diasCr==null ? '' : (tfg.diasCr===0?'hoje':tfg.diasCr+'d');
    // Detalhes das fórmulas para o painel ⓘ
    const sexoFator = tfg.sexo==='FEMININO' ? '× 0,85 (sexo fem.)' : '';
    const cgFormula = tfg.cg!=null
      ? `CG = (140 − ${tfg.idade}a) × ${tfg.peso||'?'}kg / (72 × ${tfg.cr} mg/dL)${tfg.sexo==='FEMININO'?' × 0,85':''} = <b>${tfg.cg} mL/min</b>`
      : 'CG: peso não registrado (necessário para calcular)';
    const ckFormula = `CKD-EPI 2021 (sem raça): Cr ${tfg.cr} · ${tfg.idade}a · ${tfg.sexo==='FEMININO'?'<svg xmlns="http://www.w3.org/2000/svg" width="14" height="16" viewBox="0 0 14 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><circle cx="8" cy="6" r="3.5"/><line x1="8" y1="9.5" x2="8" y2="14"/><line x1="6" y1="12" x2="10" y2="12"/></svg> fem.':'<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><circle cx="6.5" cy="9.5" r="3.5"/><line x1="9.5" y1="6.5" x2="14" y2="2"/><polyline points="10,2 14,2 14,6"/></svg> masc.'} <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M3 8h10"/><path d="M9.5 4.5L13 8l-3.5 3.5"/></svg> <b>${tfg.ckdepi} mL/min/1,73m²</b>`;
    const estadios = [
      {min:90,label:'G1 — Normal ou aumentada (≥90)'},
      {min:60,label:'G2 — Levemente diminuída (60–89)'},
      {min:45,label:'G3a — Leve a moderadamente diminuída (45–59)'},
      {min:30,label:'G3b — Moderada a gravemente diminuída (30–44)'},
      {min:15,label:'G4 — Gravemente diminuída (15–29)'},
      {min:0, label:'G5 — Insuficiência renal (<15)'},
    ];
    const tfgRef = tfg.tfgPreferida;
    const estadio = estadios.find(e=>tfgRef>=e.min) || estadios[estadios.length-1];
    h+=`<div class="apoio-card apoio-tfg">
      <div class="apoio-titulo" style="display:flex;align-items:center;gap:6px;">
        <span><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><line x1="8" y1="2" x2="8" y2="14"/><line x1="5" y1="5" x2="11" y2="5"/><line x1="5" y1="11" x2="11" y2="11"/><ellipse cx="8" cy="8" rx="4.5" ry="6"/></svg> FUNÇÃO RENAL</span>
        <span style="font-weight:500;font-size:.78rem;color:var(--muted);">— equação p/ ajuste: <b>${tfg.equacaoPreferida}</b></span>
        <button onclick="_toggleTFGInfo()" title="Ver fórmulas e estadiamento"
          style="margin-left:auto;background:none;border:1.5px solid var(--muted);border-radius:50%;width:20px;height:20px;font-size:.72rem;font-weight:700;color:var(--muted);cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;flex-shrink:0;">ⓘ</button>
      </div>
      <div class="apoio-tfg-vals">
        ${tfg.cg!=null
          ? `<div><span class="tfg-num" style="color:${corCG}">${tfg.cg}</span><span class="tfg-unit">Cockcroft-Gault${tfg.equacaoPreferida==='CG'?' <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M2.5 8.5l3.5 3.5 7.5-7.5"/></svg>':''}</span></div>`
          : `<div><span class="tfg-num" style="color:#aaa">?</span><span class="tfg-unit">CG (sem peso)</span></div>`}
        <div><span class="tfg-num" style="color:${corCK}">${tfg.ckdepi}</span><span class="tfg-unit">CKD-EPI 2021${tfg.equacaoPreferida==='CKD-EPI'?' <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M2.5 8.5l3.5 3.5 7.5-7.5"/></svg>':''}</span></div>
      </div>
      <div class="apoio-sub">
        Cr <b>${tfg.cr}</b> de <b>${dataCrTxt}</b>
        <span style="color:${crAvisoCor};font-weight:600;">${crAvisoTxt?'· '+crAvisoTxt:''}</span>
        ${crVelha?' <span style="color:var(--vermelho);"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> creatinina &gt;48h — reavaliar exame antes de ajustar dose</span>':''}
        · ${tfg.idade}a · ${tfg.sexo==='FEMININO'?'<svg xmlns="http://www.w3.org/2000/svg" width="14" height="16" viewBox="0 0 14 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><circle cx="8" cy="6" r="3.5"/><line x1="8" y1="9.5" x2="8" y2="14"/><line x1="6" y1="12" x2="10" y2="12"/></svg>':'<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><circle cx="6.5" cy="9.5" r="3.5"/><line x1="9.5" y1="6.5" x2="14" y2="2"/><polyline points="10,2 14,2 14,6"/></svg>'}${tfg.peso?' · '+tfg.peso+'kg':' · sem peso'}
      </div>
      <div id="tfg-info-panel" style="display:none;margin-top:10px;padding:10px 12px;background:var(--bg2);border-radius:8px;border:1px solid var(--borda);font-size:.8rem;line-height:1.8;">
        <div style="font-weight:700;font-size:.76rem;color:var(--muted);text-transform:uppercase;margin-bottom:6px;"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M2 14L8 2l6 12H2z"/><line x1="5" y1="11" x2="8" y2="5"/></svg> Fórmulas utilizadas</div>
        <div style="margin-bottom:4px;"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><polygon points="8,3 12,8 8,13 4,8"/><polygon points="8,5 11,8 8,11 5,8" stroke="none" fill="currentColor" opacity=".35"/></svg> <b>Cockcroft-Gault (CG):</b><br>
          <span style="margin-left:14px;font-family:monospace;font-size:.78rem;">(140 − idade) × peso / (72 × Cr) ${tfg.sexo==='FEMININO'?'× 0,85 se <svg xmlns="http://www.w3.org/2000/svg" width="14" height="16" viewBox="0 0 14 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><circle cx="8" cy="6" r="3.5"/><line x1="8" y1="9.5" x2="8" y2="14"/><line x1="6" y1="12" x2="10" y2="12"/></svg>':''}</span><br>
          <span style="margin-left:14px;color:var(--muted);"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M3 8h10"/><path d="M9.5 4.5L13 8l-3.5 3.5"/></svg> ${cgFormula}</span>
        </div>
        <div style="margin-bottom:4px;"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><polygon points="8,3 12,8 8,13 4,8"/><polygon points="8,5 11,8 8,11 5,8" stroke="none" fill="currentColor" opacity=".35"/></svg> <b>CKD-EPI 2021 (sem raça):</b><br>
          <span style="margin-left:14px;font-size:.78rem;">142 × min(Cr/κ, 1)<sup>α</sup> × max(Cr/κ, 1)<sup>−1,200</sup> × 0,9938<sup>idade</sup> ${tfg.sexo==='FEMININO'?'× 1,012':''}<br><span style="color:var(--muted);">κ=0,7 (<svg xmlns="http://www.w3.org/2000/svg" width="14" height="16" viewBox="0 0 14 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><circle cx="8" cy="6" r="3.5"/><line x1="8" y1="9.5" x2="8" y2="14"/><line x1="6" y1="12" x2="10" y2="12"/></svg>) ou 0,9 (<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><circle cx="6.5" cy="9.5" r="3.5"/><line x1="9.5" y1="6.5" x2="14" y2="2"/><polyline points="10,2 14,2 14,6"/></svg>) · α=−0,241 (<svg xmlns="http://www.w3.org/2000/svg" width="14" height="16" viewBox="0 0 14 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><circle cx="8" cy="6" r="3.5"/><line x1="8" y1="9.5" x2="8" y2="14"/><line x1="6" y1="12" x2="10" y2="12"/></svg>) ou −0,302 (<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><circle cx="6.5" cy="9.5" r="3.5"/><line x1="9.5" y1="6.5" x2="14" y2="2"/><polyline points="10,2 14,2 14,6"/></svg>)</span></span><br>
          <span style="margin-left:14px;color:var(--muted);"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M3 8h10"/><path d="M9.5 4.5L13 8l-3.5 3.5"/></svg> ${ckFormula}</span>
        </div>
        <div style="margin-top:8px;font-weight:700;font-size:.76rem;color:var(--muted);text-transform:uppercase;margin-bottom:4px;"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M2 2h5l7 7a2 2 0 010 2.8L11 14.8a2 2 0 01-2.8 0L1 7.8V2z"/><circle cx="5" cy="5" r="1" fill="currentColor" stroke="none"/></svg> Estadiamento KDIGO (TFG preferida: ${tfgRef} mL/min)</div>
        ${estadios.map(e=>{
          const ativo = tfgRef>=e.min && (e===estadios[estadios.length-1] || tfgRef<estadios[estadios.indexOf(e)-1]?.min||Infinity);
          const isAtual = e===estadio;
          return `<div style="margin-left:6px;${isAtual?'font-weight:700;color:var(--vinho);':'color:var(--muted);'}">${isAtual?'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><polygon points="4,3 13,8 4,13"/></svg> ':''} ${e.label}</div>`;
        }).join('')}
        <div style="margin-top:8px;font-size:.74rem;color:var(--muted);">Equação preferida: <b>${tfg.equacaoPreferida}</b> — ${tfg.cg!=null?'CG usado quando há peso registrado.':'CKD-EPI usado (sem peso registrado).'}</div>
      </div>
    </div>`;
  }

  // ── Interações ───────────────────────────────────────────────────────────
  if(interacoes.length){
    h+=`<div class="apoio-card apoio-alerta">
      <div class="apoio-titulo"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> INTERAÇÕES (${interacoes.length})</div>
      ${interacoes.map(i=>`<div class="apoio-item apoio-${i.grav}">
        <b>${i.a.toUpperCase()} + ${i.b.toUpperCase()}</b><br>${i.texto}</div>`).join('')}
    </div>`;
  }

  // ── Redundância de classe ───────────────────────────────────────────────
  if(redund.length){
    h+=`<div class="apoio-card apoio-warn">
      <div class="apoio-titulo"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> REDUNDÂNCIA DE CLASSE</div>
      ${redund.map(r=>`<div class="apoio-item">
        <b>${r.classe}:</b> ${r.itens.join(' + ').toUpperCase()}</div>`).join('')}
    </div>`;
  }

  // ── Omissões ─────────────────────────────────────────────────────────────
  if(omissoes.length){
    h+=`<div class="apoio-card apoio-warn">
      <div class="apoio-titulo"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 2a5 5 0 013.5 8.5L11 12H5l-.5-1.5A5 5 0 018 2z"/><line x1="5.5" y1="13.5" x2="10.5" y2="13.5"/><line x1="6.5" y1="14.8" x2="9.5" y2="14.8"/></svg> OMISSÕES POSSÍVEIS</div>
      ${omissoes.map(o=>`<div class="apoio-item">${o}</div>`).join('')}
    </div>`;
  }

  // ── #7 SANITY-CHECK DE DOSE ─────────────────────────────────────────────
  if(dosesAbsurdas.length){
    h+=`<div class="apoio-card apoio-alerta">
      <div class="apoio-titulo"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> DOSE ALÉM DA FAIXA (${dosesAbsurdas.length})</div>
      ${dosesAbsurdas.map(d=>`<div class="apoio-item apoio-alta">
        <b>${(d.nome||'').toUpperCase()}:</b> ${d.dose||'?'} — ${d.motivo}</div>`).join('')}
    </div>`;
  }

  // ── #4 BICs e DOSE POR PESO <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M3 8h10"/><path d="M9.5 4.5L13 8l-3.5 3.5"/></svg> movidos para dentro da Calc BIC (abrirCalcBIC) ──
  // Estes painéis não aparecem mais no painel de apoio; acesse via botão <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M6 2h4M7 2v5L3.5 13.5A1 1 0 004.4 15h7.2a1 1 0 00.9-1.5L9 7V2"/><line x1="4" y1="11" x2="12" y2="11"/></svg> Calc BIC.

  // ── Ajustes renais (mantidos aqui pois dependem da TFG) ─────────────────
  const sugestoes=[], ajustes=[];
  _rxItens.forEach(it=>{
    const s=_sugerirDosePorPeso(it);
    if(s) sugestoes.push({nome:it.farm, ...s});
    if(tfg){
      const a=_ajusteRenal(it, tfg.tfgPreferida);
      if(a) ajustes.push({nome:it.farm, ...a, tfgUsar:tfg.tfgPreferida, equacao:tfg.equacaoPreferida});
    }
  });
  if(ajustes.length){
    h+=`<div class="apoio-card apoio-info">
      <div class="apoio-titulo"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M12.5 3a3 3 0 00-3.5 3.5L3.5 12A1.5 1.5 0 005.5 14l5.5-5.5A3 3 0 0012.5 3z"/><line x1="4" y1="12" x2="5.5" y2="13.5"/></svg> AJUSTE PARA FUNÇÃO RENAL <span style="font-weight:500;font-size:.78rem;">(TFG ${ajustes[0].tfgUsar} via ${ajustes[0].equacao})</span></div>
      ${ajustes.map(a=>`<div class="apoio-item">
        <b>${a.nome}:</b> ${a.dose}${a.nota?' — <em>'+a.nota+'</em>':''}</div>`).join('')}
    </div>`;
  }

  // ── #9 DIFF COM ONTEM ───────────────────────────────────────────────────
  if(diff && !diff.semAnterior && (diff.novos.length||diff.suspensos.length||diff.alterados.length)){
    const fmt = _fmtDataCurta(diff.data)||diff.data;
    h+=`<div class="apoio-card apoio-info" style="border-left-color:#6a1b9a;">
      <div class="apoio-titulo"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M2 9a6 6 0 0010.9 2.4"/><path d="M14 7A6 6 0 003.1 4.6"/><path d="M12.5 12L15 9.5l-2.5-2"/><path d="M3.5 4L1 6.5l2.5 2"/></svg> MUDANÇAS DESDE ${fmt.toUpperCase()}</div>
      ${diff.novos.length?`<div class="apoio-item">
        <b style="color:#0a6b3a;">+ NOVO${diff.novos.length>1?'S':''} (${diff.novos.length}):</b>
        ${diff.novos.map(it=>(it.farm||'').toUpperCase()).join(' · ')}</div>`:''}
      ${diff.suspensos.length?`<div class="apoio-item">
        <b style="color:#b71c1c;">− SUSPENSO${diff.suspensos.length>1?'S':''} (${diff.suspensos.length}):</b>
        ${diff.suspensos.map(it=>(it.farm||'').toUpperCase()).join(' · ')}</div>`:''}
      ${diff.alterados.length?`<div class="apoio-item">
        <b style="color:#a35200;">~ ALTERADO${diff.alterados.length>1?'S':''} (${diff.alterados.length}):</b>
        ${diff.alterados.map(a=>`<div style="margin-left:12px;font-size:.84rem;">${(a.item.farm||'').toUpperCase()}: ${a.diffs.join(' · ')}</div>`).join('')}</div>`:''}
    </div>`;
  }

  wrap.innerHTML=h;
  wrap.style.display=h ? '' : 'none';
}

// Alterna a visibilidade do painel de informações da TFG (ⓘ)
function _toggleTFGInfo(){
  const p=$('tfg-info-panel');
  if(!p) return;
  p.style.display = p.style.display==='none' ? '' : 'none';
}



/* ═══════════════════════════════════════════════════════════════════════════
   MODAL DE ADIÇÃO/EDIÇÃO DE ITEM DA PRESCRIÇÃO
   ═══════════════════════════════════════════════════════════════════════════ */
let _mrxEditId = null;     // id do item sendo editado (null = novo)
let _mrxHorSel = [];       // horários selecionados no modal
let _rxModoReordenando = false;  // modo drag-and-drop ativo
let _rxDragId = null;      // id do item sendo arrastado

// Abre o modal para novo item ou edição de existente
function abrirModalRxItem(id, tipo){
  _mrxEditId = id;
  // Popula selects
  $('mrx-via').innerHTML   = RX_VIAS.map(v=>`<option>${v}</option>`).join('');
  $('mrx-freq').innerHTML  = RX_FREQS.map(f=>`<option>${f}</option>`).join('');
  $('mrx-apres').innerHTML = RX_APRES.map(a=>`<option>${a}</option>`).join('');

  if(id){
    // EDIÇÃO: preenche com dados do item existente
    const it = _rxItens.find(i=>i.id===id);
    if(!it) return;
    $('modal-rx-titulo').textContent = 'Editar item';
    const lbl2=$('mrx-btn-label'); if(lbl2) lbl2.textContent='Salvar alterações'; $('modal-rx-titulo').textContent='Editar item';
    sf('mrx-farm', it.farm||'');
    sf('mrx-qtd',  it.qtd||'');
    sf('mrx-dose', it.dose||'');
    sf('mrx-dil',  it.diluicao||'');
    sf('mrx-obs',  it.obs||'');
    sf('mrx-vazao', it.vazao||'');
    $('mrx-via').value  = it.via||'EV';
    $('mrx-freq').value = it.freq||'24/24H';
    $('mrx-apres').value= it.apres||'—';
    $('mrx-cat').value  = it._cat||'Medicação Geral';
    _mrxHorSel = Array.isArray(it.hor) ? [...it.hor] : [];
  } else {
    // NOVO: defaults por tipo
    $('modal-rx-titulo').textContent = 'Adicionar item';
    const lbl1=$('mrx-btn-label'); if(lbl1) lbl1.textContent='Confirmar item'; $('modal-rx-titulo').textContent='Adicionar item';
    sf('mrx-farm',''); sf('mrx-qtd','1'); sf('mrx-dose','');
    sf('mrx-dil',''); sf('mrx-obs',''); sf('mrx-vazao','');
    const via  = tipo==='dieta'?'VO':tipo==='cuidados'?'—':'EV';
    const freq = tipo==='dieta'?'SND':tipo==='sn'?'SN':tipo==='cuidados'?'SND':'24/24H';
    $('mrx-via').value  = via;
    $('mrx-freq').value = freq;
    $('mrx-apres').value= '—';
    $('mrx-cat').value  = tipo==='dieta'?'Dieta':tipo==='cuidados'?'Cuidados':'Medicação Geral';
    _mrxHorSel = [];
    if(tipo==='dieta') _mrxHorSel=['SND'];
    if(tipo==='sn')    _mrxHorSel=['SN'];
  }
  _mrxViaChange();
  _mrxFreqChange();
  _mrxAtualizarBadgeCat();
  _mrxAtualizarCamposHidratacao();
  $('modal-rx-item').classList.add('show');
  setTimeout(()=>{ $('mrx-farm').focus(); $('mrx-farm').select(); }, 100);
}

function fecharModalRxItem(){
  $('modal-rx-item').classList.remove('show');
  _mrxAcFechar();
  _mrxEditId = null;
}

// Atualiza visibilidade do campo Diluente e badge de categoria
function _mrxViaChange(){
  const via = $('mrx-via').value;
  const mostraDil = RX_VIAS_DILUICAO.has(via.trim().toUpperCase());
  $('mrx-dil-wrap').style.display = mostraDil ? '' : 'none';
}

function _mrxCatChange(){
  _mrxAtualizarBadgeCat();
  _mrxAtualizarCamposHidratacao();
}

function _mrxAtualizarCamposHidratacao(){
  const cat = ($('mrx-cat')||{}).value || '';
  const isHidrat = cat === 'Hidratação';
  const wrapVazao = $('mrx-vazao-wrap');
  const wrapVol   = $('mrx-vol-wrap');
  if(wrapVazao) wrapVazao.style.display = isHidrat ? '' : 'none';
  if(wrapVol)   wrapVol.style.display   = isHidrat ? '' : 'none';
}

function _mrxSetVol(vol){
  sf('mrx-qtd', vol);
  const apresEl = $('mrx-apres');
  if(apresEl) apresEl.value = 'ML';
}

function _mrxFreqChange(){
  _mrxHorSel = _mrxHorSel.filter(h => h); // mantém seleção
  _mrxRenderHorarios();
}

// Renderiza chips de horário igual ao da tabela
function _mrxRenderHorarios(){
  const freq = $('mrx-freq').value;
  const wrap = $('mrx-horarios');
  if(!wrap) return;
  wrap.innerHTML = _rxHorariosHtmlPara(freq, _mrxHorSel, '_mrxToggleHor');
}

// Versão do _rxHorariosHtml que funciona com callback customizado
function _rxHorariosHtmlPara(freq, horSel, callbackFn){
  const CHIPS_HOR = ['06','07','08','10','12','14','16','18','20','22','24','02'];
  const CHIPS_ESP = ['BIC','SN','SND','ACM','ACM NOITE'];
  const especial  = ['BIC ACM','SN','SND','ACM','ACM NOITE','BIC','—'].includes(freq);
  let h = '';
  if(especial){
    const tag = freq==='BIC ACM'?'BIC':freq;
    h += `<span class="rx-hor-chip ${horSel.includes(tag)?'on':''} rx-hor-chip-snd"
      onclick="${callbackFn}('${tag}')">${tag}</span>`;
  } else {
    CHIPS_HOR.forEach(hr=>{
      h+=`<span class="rx-hor-chip ${horSel.includes(hr)?'on':''}"
        onclick="${callbackFn}('${hr}')">${hr}h</span>`;
    });
    CHIPS_ESP.forEach(e=>{
      const cls = e==='SND'?'rx-hor-chip-snd':e==='SN'||e==='ACM'?'rx-hor-chip-sn':'';
      h+=`<span class="rx-hor-chip ${horSel.includes(e)?'on':''} ${cls}"
        onclick="${callbackFn}('${e}')">${e}</span>`;
    });
  }
  return h;
}

function _mrxToggleHor(h){
  if(_mrxHorSel.includes(h)) _mrxHorSel=_mrxHorSel.filter(x=>x!==h);
  else _mrxHorSel.push(h);
  _mrxRenderHorarios();
}

function _mrxAtualizarBadgeCat(){
  const cat = ($('mrx-cat')||{}).value || 'Medicação Geral';
  const badge = $('mrx-cat-badge');
  if(badge) badge.textContent = cat;
}

// Salvar item do modal
function _mrxSalvar(){
  const farm = ($('mrx-farm').value||'').trim().toUpperCase();
  const dose = ($('mrx-dose').value||'').trim().toUpperCase();
  const via  = $('mrx-via').value;
  const freq = $('mrx-freq').value;
  if(!farm){ toast('Informe o nome do fármaco/item.', true); $('mrx-farm').focus(); return; }

  const dispensa = ['—','SND','SN','BIC ACM'].some(x=>via===x||farm.startsWith('DIETA')||farm.startsWith('CUIDADO'));
  if(!dispensa && !dose){ toast('Dose obrigatória.', true); $('mrx-dose').focus(); return; }

  if(_mrxEditId){
    // Atualiza item existente
    const it = _rxItens.find(i=>i.id===_mrxEditId);
    if(it){
      it.farm     = farm;
      it.qtd      = ($('mrx-qtd').value||'').trim();
      it.apres    = $('mrx-apres').value;
      it.dose     = dose;
      it.via      = via;
      it.diluicao = ($('mrx-dil').value||'').trim().toUpperCase();
      it.freq     = freq;
      it.hor      = [..._mrxHorSel];
      it.obs      = ($('mrx-obs').value||'').trim().toUpperCase();
      it._cat     = $('mrx-cat').value;
      it.vazao    = ($('mrx-vazao').value||'').trim().replace(/[^\d.,]/g,'');
    }
  } else {
    // Novo item
    const item = _rxNovoItem('normal');
    item.farm     = farm;
    item.qtd      = ($('mrx-qtd').value||'').trim();
    item.apres    = $('mrx-apres').value;
    item.dose     = dose;
    item.via      = via;
    item.diluicao = ($('mrx-dil').value||'').trim().toUpperCase();
    item.freq     = freq;
    item.hor      = [..._mrxHorSel];
    item.obs      = ($('mrx-obs').value||'').trim().toUpperCase();
    item._cat     = $('mrx-cat').value;
    item.vazao    = ($('mrx-vazao').value||'').trim().replace(/[^\d.,]/g,'');
    item.tipo     = 'normal';
    // Auto-ordena ao inserir (por prioridade de categoria)
    _rxItens.push(item);
    _rxItens.sort((a,b)=>(RX_PRIO[a._cat||'Medicação Geral']||6)-(RX_PRIO[b._cat||'Medicação Geral']||6));
  }

  fecharModalRxItem();
  _renderPrescricao();
  toast(_mrxEditId ? '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M2.5 8.5l3.5 3.5 7.5-7.5"/></svg> Item atualizado' : '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M2.5 8.5l3.5 3.5 7.5-7.5"/></svg> Item adicionado');
  // ── Trigger albumina: se o item prescrito é albumina humana, sugere ficha
  if(farm.includes('ALBUMINA')){
    setTimeout(()=>{
      if(confirm('Albumina prescrita.\n\nDeseja preencher a Solicitação de Albumina Endovenosa (impresso DLS) agora?')){
        abrirFichaAlbumina();
      }
    }, 350);
  }
}

/* ─── AUTOCOMPLETE DO MODAL ────────────────────────────────────────────── */
let _mrxAcRes=[], _mrxAcIdx=-1;

function _mrxAcInput(el){
  _mrxAcIdx=-1;
  const q=(el.value||'').trim().toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
  if(q.length<2){ _mrxAcFechar(); return; }
  _mrxAcRes=RX_BANCO.filter(m=>{
    const n=m.nome.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
    const c=(m.cat||'').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
    return n.includes(q)||c.includes(q);
  }).slice(0,14);
  const ac=$('mrx-ac');
  if(!_mrxAcRes.length){ _mrxAcFechar(); return; }
  const reQ=new RegExp('('+q.replace(/[.*+?^${}()|[\]\\]/g,'\$&')+')','gi');
  ac.innerHTML=_mrxAcRes.map((m,i)=>{
    const mark=m.nome.replace(reQ,'<span class="rx-ac-mark">$1</span>');
    const cor=_rxCatCor(m.cat);
    return `<div class="rx-ac-item" data-idx="${i}" onmousedown="_mrxAcEscolher(${i})">
      <div style="display:flex;align-items:center;gap:6px;">
        <div class="rx-ac-nome" style="flex:1;">${mark}</div>
        <span style="font-size:.6rem;font-weight:700;padding:1px 6px;border-radius:8px;${cor}">${m.cat||''}</span>
      </div>
      <div class="rx-ac-info">${m.dose||''}${m.via?' · '+m.via:''}${m.freq?' · '+m.freq:''}${m.diluicao?' · <em>'+m.diluicao+'</em>':''}</div>
    </div>`;
  }).join('');
  ac.style.display='block';
}

function _mrxAcFechar(){ const a=$('mrx-ac'); if(a) a.style.display='none'; _mrxAcIdx=-1; }

function _mrxAcEscolher(i){
  const m=_mrxAcRes[i]; if(!m) return;
  sf('mrx-farm', m.nome);
  sf('mrx-dose', m.dose||'');
  sf('mrx-qtd',  m.qtd||'1');
  sf('mrx-dil',  m.diluicao||'');
  sf('mrx-obs',  m.obs||'');
  if(m.via)  $('mrx-via').value  = m.via;
  if(m.freq) $('mrx-freq').value = m.freq;
  if(m.apres)$('mrx-apres').value= m.apres;
  // Categoria
  const catMap={'ATB':'ATB','Dieta':'Dieta','Droga Vasoativa':'Droga Vasoativa','Sedação':'Sedação','Hidratação':'Hidratação','Cuidados':'Cuidados','Protocolo':'Protocolo'};
  $('mrx-cat').value = catMap[m.cat] || 'Medicação Geral';
  // Horários pré-definidos
  _mrxHorSel = Array.isArray(m.hor) ? [...m.hor] : [];
  _mrxViaChange();
  _mrxFreqChange();
  _mrxAtualizarBadgeCat();
  _mrxAcFechar();
  setTimeout(()=>$('mrx-dose').focus(),80);
}

function _mrxAcKey(e){
  const ac=$('mrx-ac'); if(!ac||ac.style.display==='none') return;
  if(e.key==='ArrowDown'){ e.preventDefault(); _mrxAcIdx=Math.min(_mrxAcIdx+1,_mrxAcRes.length-1); _mrxAcHilight(); }
  else if(e.key==='ArrowUp'){ e.preventDefault(); _mrxAcIdx=Math.max(_mrxAcIdx-1,0); _mrxAcHilight(); }
  else if(e.key==='Enter'||e.key==='Tab'){ e.preventDefault(); if(_mrxAcIdx>=0) _mrxAcEscolher(_mrxAcIdx); else if(_mrxAcRes.length===1) _mrxAcEscolher(0); }
  else if(e.key==='Escape') _mrxAcFechar();
}
function _mrxAcHilight(){
  document.querySelectorAll('#mrx-ac .rx-ac-item').forEach((el,i)=>{
    el.classList.toggle('sel', i===_mrxAcIdx);
    if(i===_mrxAcIdx) el.scrollIntoView({block:'nearest'});
  });
}

/* ─── MODO REORDENAÇÃO DRAG-AND-DROP ────────────────────────────────────── */
function _rxModoReordenar(){ /* drag sempre ativo — sem toggle */ }

/* ─── DRAG & DROP — event delegation no tbody (persiste entre re-renders) ── */
function _rxIniciarDragDelegation(){
  const tbody = $('presc-tbody');
  if(!tbody || tbody.dataset.ddOk) return;
  tbody.dataset.ddOk = '1';

  tbody.addEventListener('dragstart', e => {
    const handle = e.target.closest('.rx-drag-handle');
    if(!handle) return;
    const tr = handle.closest('tr[data-rx-id]');
    if(!tr) return;
    _rxDragId = Number(tr.dataset.rxId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', _rxDragId);
    requestAnimationFrame(() => tr.classList.add('rx-dragging'));
  });

  tbody.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const overTr = e.target.closest('tr[data-rx-id]');
    tbody.querySelectorAll('tr').forEach(r => r.classList.remove('rx-drag-over'));
    if(overTr && Number(overTr.dataset.rxId) !== _rxDragId)
      overTr.classList.add('rx-drag-over');
  });

  tbody.addEventListener('dragleave', e => {
    if(!tbody.contains(e.relatedTarget))
      tbody.querySelectorAll('tr').forEach(r => r.classList.remove('rx-drag-over'));
  });

  tbody.addEventListener('drop', e => {
    e.preventDefault();
    const overTr = e.target.closest('tr[data-rx-id]');
    if(overTr && _rxDragId != null){
      const toId   = Number(overTr.dataset.rxId);
      const fromIdx = _rxItens.findIndex(i => i.id === _rxDragId);
      const toIdx   = _rxItens.findIndex(i => i.id === toId);
      if(fromIdx >= 0 && toIdx >= 0 && fromIdx !== toIdx){
        const [item] = _rxItens.splice(fromIdx, 1);
        _rxItens.splice(toIdx, 0, item);
      }
    }
    _rxDragLimpar();
    _renderPrescricao();
  });

  tbody.addEventListener('dragend', () => {
    _rxDragLimpar();
    _renderPrescricao();
  });
}

function _rxDragLimpar(){
  const tbody = $('presc-tbody');
  if(tbody) tbody.querySelectorAll('tr').forEach(r =>
    r.classList.remove('rx-dragging', 'rx-drag-over'));
  _rxDragId = null;
}

// Compatibilidade: chamada antiga (onmousedown inline) — agora sem uso real
function _rxDragStart(e, id){ /* substituído por delegation em _rxIniciarDragDelegation */ }

function addItemPrescricao(){ abrirModalRxItem(null,'normal'); }
function addItemPrescricaoEspecial(tipo){ abrirModalRxItem(null,tipo); }
function _rxFocusUltimo(){
  setTimeout(()=>{
    const inputs=document.querySelectorAll('#presc-tbody .rx-farm');
    if(inputs.length) inputs[inputs.length-1].focus();
  },60);
}

function _rxRemover(id){ _rxItens=_rxItens.filter(i=>i.id!==id); _renderPrescricao(); }

function _rxSetVol(id, vol){
  const it=_rxItens.find(i=>i.id===id); if(!it) return;
  it.qtd=vol; it.apres='ML';
  _renderPrescricao();
}

// Detecta categoria do medicamento digitado manualmente
function _rxDetectarCategoria(nome) {
  if (!nome) return 'Medicação Geral';
  const q = nome.trim().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // 1. Tenta correspondência com a primeira palavra no banco de medicamentos
  const match = RX_BANCO.find(m => {
    const n = m.nome.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const primeiraM = n.split(/\s+/)[0];
    const primeiraQ = q.split(/\s+/)[0];
    return primeiraQ === primeiraM;
  });
  if (match && match.cat) return match.cat;

  // 2. Fallbacks por termos comuns
  if (/(AMPICILINA|SULBACTAM|AMOXICILINA|CLAVULANATO|ACICLOVIR|AZITROMICINA|BENZILPENICILINA|CEFALOTINA|CEFAZOLINA|CEFEPIMA|CEFOTAXIMA|CEFTAZIDIMA|CEFTRIAXONA|CIPROFLOXACINO|CLARITROMICINA|CLINDAMICINA|CLORANFENICOL|COLISTINA|ERTAPENEM|FLUCONAZOL|GENTAMICINA|AMICACINA|IVERMECTINA|LEVOFLOXACINO|LINEZOLIDA|MEROPENEM|METRONIDAZOL|MICAFUNGINA|MOXIFLOXACINO|NISTATINA|OSELTAMIVIR|OXACILINA|PIPERACILINA|TAZOBACTAM|POLIMIXINA|TEICOPLANINA|TIGECICLINA|VANCOMICINA|ALBENDAZOL|ATB|TEICO|TENTIN|MERONEM|CEFTRAX)/.test(q)) {
    return 'ATB';
  }
  if (/(NORADRENALINA|NOREPINEFRINA|DOBUTAMINA|VASOPRESSINA|NIPRIDE|NITROPRUSSIATO|TRIDIL|NITROGLICERINA|AMIODARONA|DVA|NORA|DOBUTA)/.test(q)) {
    return 'Droga Vasoativa';
  }
  if (/(FENTANIL|MIDAZOLAM|PROPOFOL|DEXMEDETOMIDINA|KETAMINA|MORFINA|TRAMADOL|DIPIRONA|PARACETAMOL|SEDA|PRECEDEX|DORMIDID)/.test(q)) {
    return 'Sedação';
  }
  if (/(DIETA|JEJUM|RESTRIÇÃO)/.test(q)) {
    return 'Dieta';
  }
  if (/(INSULINA|HGT|GLICOSE)/.test(q)) {
    return 'Protocolo';
  }
  if (/(SSVV|CCGG|CABECEIRA|DECÚBITO|SVD|DIURESE|BH|FISIOTERAPIA|CURATIVO)/.test(q)) {
    return 'Cuidados';
  }
  if (/(SF 0,9%|SG 5%|RINGER|SORO|JELCO)/.test(q)) {
    return 'Hidratação';
  }

  return 'Medicação Geral';
}

function _rxDetectarTipo(cat) {
  if (cat === 'Dieta') return 'dieta';
  if (cat === 'Protocolo') return 'sn';
  if (cat === 'Cuidados') return 'cuidados';
  return 'normal';
}

function _rxSetField(id, campo, val) {
  const it = _rxItens.find(i => i.id === id);
  if (it) {
    it[campo] = val;
    // Re-renderiza ao mudar via (para mostrar/ocultar campo de diluente)
    if(campo === 'via'){ _renderPrescricao(); return; }
    if (campo === 'farm') {
      it._cat = _rxDetectarCategoria(val);
      it.tipo = _rxDetectarTipo(it._cat);
      if (it._cat === 'ATB' && !it.ddInicio) {
        it.ddInicio = gf('f-data') || hoje();
      }
    }
  }
}
function _rxToggleHor(id, hor){
  const it=_rxItens.find(i=>i.id===id); if(!it) return;
  const especiais=['SN','SND','ACM','EM USO'];
  if(especiais.includes(hor)){
    it.hor = it.hor.includes(hor) ? [] : [hor];
  } else {
    it.hor = it.hor.filter(h=>!especiais.includes(h));
    const idx=it.hor.indexOf(hor);
    if(idx>=0) it.hor.splice(idx,1); else it.hor.push(hor);
    it.hor.sort();
  }
  // re-renderiza só a célula de horários (sem remontar tudo)
  const cell=document.querySelector(`[data-rx-hor="${id}"]`);
  if(cell) cell.innerHTML=_rxHorariosHtml(it);
}

function _rxHorariosHtml(it){
  const especiais=['SN','SND','ACM','EM USO'];
  const ativos=it.hor||[];
  const horChips=RX_HORAS.map(h=>`<span class="rx-hor-chip ${ativos.includes(h)?'on':''}" onclick="_rxToggleHor(${it.id},'${h}')">${h}</span>`).join('');
  const espChips=especiais.map(e=>`<span class="rx-hor-chip rx-hor-chip-sn ${ativos.includes(e)?'on':''}" onclick="_rxToggleHor(${it.id},'${e}')">${e}</span>`).join('');
  return `<div class="rx-horarios">${horChips}${espChips}</div>`;
}

// Vias que exigem/mostram campo de diluente
const RX_VIAS_DILUICAO = new Set(['EV','EV (BIC)','EV (BIC ACM)','EV BIC','IM']);

function _rxMostrarDiluicao(it){
  // mostra se a via exige ou se já tem valor preenchido
  return RX_VIAS_DILUICAO.has((it.via||'').trim().toUpperCase()) || !!(it.diluicao && it.diluicao.trim());
}

function _renderPrescricao(){
  // atualiza meta do cabeçalho
  const pac=gf('f-pac'), leito=gf('f-leito'), data=gf('f-data'), alergia=gf('f-alergia');
  const meta=$('presc-meta');
  if(meta) meta.innerHTML=`<strong>${pac||'Paciente'}</strong> · Leito ${leito||'?'} · <strong>${_fmtDataCurta(data)||'—'}</strong>`;
  // alerta de alergias
  const alertaEl=$('presc-alerta-alergia');
  if(alertaEl){
    if(alergia && !/^nega$/i.test(alergia.trim())){
      alertaEl.style.display='flex';
      alertaEl.innerHTML=`<div class="presc-alerta"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg>️ <strong>ALERGIA:</strong> ${alergia.toUpperCase()}</div>`;
    } else { alertaEl.style.display='none'; }
  }
  // ── Painel de apoio clínico (TFG, alertas, omissões) ─────────
  _renderApoioClinico();
  // renderiza linhas
  const tbody=$('presc-tbody'); if(!tbody) return;
  if(!_rxItens.length){
    tbody.innerHTML=`<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--muted);font-size:.84rem;">
      Clique em "+ Adicionar item" para começar a prescrição.</td></tr>`;
    return;
  }
  tbody.innerHTML=_rxItens.map((it,i)=>{
    const rowCls = [
      it.tipo==='dieta'?'presc-dieta':it.tipo==='sn'?'presc-sn':it.tipo==='cuidados'?'presc-cuidado':'',
      _rxModoReordenando?'':'rx-editavel'
    ].filter(Boolean).join(' ');
    const viaOpts=RX_VIAS.map(v=>`<option ${it.via===v?'selected':''}>${v}</option>`).join('');
    const freqOpts=RX_FREQS.map(f=>`<option ${it.freq===f?'selected':''}>${f}</option>`).join('');
    const apresOpts=RX_APRES.map(a=>`<option ${it.apres===a?'selected':''}>${a}</option>`).join('');
    const dispensa=_rxDispensaDose(it);
    const dosePendente = !dispensa && (!it.dose || it.dose.trim()===''||it.dose==='—');
    const doseStyle = dosePendente ? 'border-color:#e53935!important;background:#fff5f5!important;' : '';
    return `<tr class="${rowCls}" data-rx-id="${it.id}" ondblclick="abrirModalRxItem(${it.id})">
      <td class="presc-td-drag"><span class="rx-drag-handle" draggable="true" title="Arraste para reordenar"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><circle cx="6" cy="5" r="1" fill="currentColor" stroke="none"/><circle cx="10" cy="5" r="1" fill="currentColor" stroke="none"/><circle cx="6" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="10" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="6" cy="11" r="1" fill="currentColor" stroke="none"/><circle cx="10" cy="11" r="1" fill="currentColor" stroke="none"/></svg></span></td>
      <td class="presc-num">${i+1}</td>
      <td class="td-farm">
        <div style="display:flex;align-items:center;gap:4px;">
          <input type="text" class="rx-farm" value="${it.farm||''}" placeholder="FÁRMACO / ITEM"
            style="text-transform:uppercase;flex:1;"
            oninput="_rxSetField(${it.id},'farm',this.value.toUpperCase());_rxAcInput(this,${it.id})"
            onblur="setTimeout(_rxAcFechar, 150)" onkeydown="_rxAcKey(event,${it.id})">
          ${_rxBadgeDdia(it)}
        </div>
        <div class="rx-apres-inline">
          <input type="text" class="rx-qtd-inline" value="${it.qtd||''}" placeholder="qtd"
            oninput="_rxSetField(${it.id},'qtd',this.value)">
          <select class="rx-apres-sel" onchange="_rxSetField(${it.id},'apres',this.value)">${apresOpts}</select>
        </div>
        ${it._cat==='Hidratação'?`<div class="rx-vol-quick">
          ${['100','250','500','1000'].map(v=>`<button type="button" class="rx-vol-btn${it.qtd===v?' rx-vol-btn-on':''}" onclick="_rxSetVol(${it.id},'${v}')">${v}</button>`).join('')}
        </div>`:''}
        ${_rxMostrarDiluicao(it)?`<div class="rx-dil-inline"><span class="rx-dil-label">DILUENTE:</span><input type="text" class="rx-dil-input" value="${it.diluicao||''}" placeholder="ex: + 100ML SF 0,9%" oninput="_rxSetField(${it.id},'diluicao',this.value.toUpperCase())" style="text-transform:uppercase;"></div>`:''}
        ${it._cat==='Hidratação'?`<div class="rx-vazao-inline"><span class="rx-vazao-label">VAZÃO:</span><input type="text" class="rx-vazao-input" value="${it.vazao||''}" placeholder="ml/h" oninput="_rxSetField(${it.id},'vazao',this.value.replace(/[^\\d.,]/g,''))"><span class="rx-vazao-unit">ml/h</span></div>`:''}
      </td>
      <td>
        <input type="text" value="${it.dose||''}" placeholder="DOSE *"
          style="text-transform:uppercase;${doseStyle}"
          oninput="_rxSetField(${it.id},'dose',this.value.toUpperCase());_rxValidarDose(${it.id},this)">
      </td>
      <td><select onchange="_rxSetField(${it.id},'via',this.value)">${viaOpts}</select></td>
      <td><select onchange="_rxSetField(${it.id},'freq',this.value)">${freqOpts}</select></td>
      <td data-rx-hor="${it.id}">${_rxHorariosHtml(it)}</td>
      <td class="td-obs">
        <textarea class="rx-obs-area" rows="2"
          placeholder="OBS."
          oninput="_rxSetField(${it.id},'obs',this.value.toUpperCase());this.style.height='auto';this.style.height=this.scrollHeight+'px'"
          style="text-transform:uppercase;">${it.obs||''}</textarea>
      </td>
      <td>
        <button class="presc-del" onclick="_rxRemover(${it.id})" title="Excluir item"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><polyline points="3,5 5,5 13,5"/><path d="M6 5V3.5A.5.5 0 016.5 3h3a.5.5 0 01.5.5V5"/><path d="M5 5l.7 8.5a.8.8 0 00.8.5h3a.8.8 0 00.8-.5L11 5"/><line x1="7" y1="8" x2="7" y2="12"/><line x1="9" y1="8" x2="9" y2="12"/></svg></button>
      </td>
    </tr>`;
  }).join('');
  _rxIniciarDragDelegation();
}

/* ════════════════════════════════════════════════════════════════════════════
   AUTOCOMPLETE DE MEDICAMENTOS
   ════════════════════════════════════════════════════════════════════════════ */
let _rxAcIdx=-1, _rxAcItId=null, _rxAcResultados=[];

function _rxAcInput(el, itId){
  _rxAcTarget=el; _rxAcItId=itId; _rxAcIdx=-1;
  const q=(el.value||'').trim().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  if(q.length<2){ _rxAcFechar(); return; }
  _rxAcResultados=RX_BANCO.filter(m=>{
    const n=m.nome.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    const c=(m.cat||'').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    return n.includes(q)||c.includes(q);
  }).slice(0,12);
  if(!_rxAcResultados.length){ _rxAcFechar(); return; }
  const rect=el.getBoundingClientRect();
  const ac=$('rx-autocomplete');
  ac.style.display='block';
  // O div está em position:fixed no body — rect já é relativo à viewport, sem somar scroll
  ac.style.top=(rect.bottom+2)+'px';
  ac.style.left=rect.left+'px';
  ac.style.minWidth=Math.max(rect.width,320)+'px';
  // Garante que não sai pela borda direita da tela
  const vw=window.innerWidth;
  const dropW=Math.max(rect.width,320);
  if(rect.left+dropW>vw) ac.style.left=Math.max(0,vw-dropW-8)+'px';
  const reQ=new RegExp('('+q.replace(/[.*+?^${}()|[\]\\\\]/g,'\\$&')+')','gi');
  ac.innerHTML=_rxAcResultados.map((m,i)=>{
    const nNorm=m.nome.normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    const mark=m.nome.replace(reQ,'<span class="rx-ac-mark">$1</span>');
    const badgeCor=_rxCatCor(m.cat);
    return `<div class="rx-ac-item" data-idx="${i}" onmousedown="_rxAcEscolher(${i})">
      <div style="display:flex;align-items:center;gap:6px;">
        <div class="rx-ac-nome" style="flex:1;">${mark}</div>
        <span style="font-size:.58rem;font-weight:700;padding:1px 6px;border-radius:8px;white-space:nowrap;${badgeCor}">${m.cat||''}</span>
      </div>
      <div class="rx-ac-info">${_rxResumoApres(m)}${m.via?' · '+m.via:''}${m.freq?' · '+m.freq:''}${m.diluicao?' · <em>'+m.diluicao+'</em>':''}${m.obs?' · <em>'+m.obs+'</em>':''}</div>
    </div>`;
  }).join('');
}

// Resumo "qtd apres dose" para exibição (ex: "1 COMP 200MG", "2 FA 1G", "40 GTS")
function _rxResumoApres(m){
  const partes=[];
  if(m.qtd) partes.push(m.qtd);
  if(m.apres&&m.apres!=='—') partes.push(m.apres);
  if(m.dose&&m.dose!=='—'&&m.dose!=='') partes.push(m.dose);
  return partes.join(' ')||'—';
}

// Cor do badge por categoria
function _rxCatCor(cat){
  const c={'Dieta':'background:#e6f4ec;color:#1a6b3a;',
    'ATB':'background:#fde8e6;color:#b71c1c;',
    'Hidratação':'background:#e3f0ff;color:#0d47a1;',
    'Droga Vasoativa':'background:#f3e5f5;color:#6a1b9a;',
    'Sedação':'background:#fff3e0;color:#e65100;',
    'Medicação Geral':'background:#f0f4ff;color:#1565c0;',
    'Protocolo':'background:#fdf2dd;color:#6b4a06;',
    'Cuidados':'background:#f5f5f5;color:#555;'};
  return c[cat]||'background:#eee;color:#333;';
}

function _rxAcEscolher(idx){
  const m=_rxAcResultados[idx]; if(!m||_rxAcItId===null) return;
  const it=_rxItens.find(i=>i.id===_rxAcItId); if(!it) return;
  it.farm=m.nome;
  it.qtd=m.qtd||''; it.apres=m.apres||''; it.dose=m.dose||'';
  it.diluicao=m.diluicao||''; it.via=m.via||'EV';
  it.freq=m.freq||'24/24H'; it.hor=[...(m.hor||[])];
  it.obs=m.obs||'';
  it.vazao=m.vazao||'';
  it._cat=m.cat||'Medicação Geral';
  // Marca D0 automaticamente se for ATB novo (sem ddInicio anterior)
  if(m.cat==='ATB' && !it.ddInicio){
    it.ddInicio=gf('f-data')||hoje();
  }
  // define tipo da linha pela categoria
  if(m.cat==='Dieta') it.tipo='dieta';
  else if(m.cat==='Protocolo') it.tipo='sn';
  else if(m.cat==='Cuidados') it.tipo='cuidados';
  else it.tipo='normal';
  _rxAcFechar();
  _renderPrescricao();
}

function _rxAcFechar(){
  const ac=$('rx-autocomplete'); if(ac) ac.style.display='none';
  _rxAcIdx=-1; _rxAcResultados=[];
}

function _rxAcKey(e, itId){
  const ac=$('rx-autocomplete');
  if(!ac||ac.style.display==='none') return;
  const items=ac.querySelectorAll('.rx-ac-item');
  if(e.key==='ArrowDown'){ e.preventDefault(); _rxAcIdx=Math.min(_rxAcIdx+1,items.length-1); _rxAcHighlight(items); }
  else if(e.key==='ArrowUp'){ e.preventDefault(); _rxAcIdx=Math.max(_rxAcIdx-1,0); _rxAcHighlight(items); }
  else if(e.key==='Enter'&&_rxAcIdx>=0){ e.preventDefault(); _rxAcEscolher(_rxAcIdx); }
  else if(e.key==='Escape'){ _rxAcFechar(); }
}
function _rxAcHighlight(items){
  items.forEach((el,i)=>el.classList.toggle('sel',i===_rxAcIdx));
  if(items[_rxAcIdx]) items[_rxAcIdx].scrollIntoView({block:'nearest'});
}

// Fecha autocomplete ao clicar fora
document.addEventListener('click', e=>{
  if(!e.target.closest('#rx-autocomplete')&&!e.target.classList.contains('rx-farm')) _rxAcFechar();
}, true);

/* ════════════════════════════════════════════════════════════════════════════
   SALVAR / CARREGAR PRESCRIÇÃO
   ════════════════════════════════════════════════════════════════════════════ */
// Valida dose em tempo real — pinta o campo de vermelho se vazio
function _rxValidarDose(id, el){
  const v=(el.value||'').trim();
  const vazio = !v||v==='—';
  el.style.borderColor = vazio ? '#e53935' : '';
  el.style.background  = vazio ? '#fff5f5' : '';
}

// Itens que não precisam de dose
// Estratégia: categoria e tipo são primários (robustos); o prefixo fica como fallback.
function _rxDispensaDose(it){
  if(!it) return false;
  // 1) Por categoria/tipo (fonte canônica)
  if(it.tipo==='cuidados' || it.tipo==='dieta' || it.tipo==='sn') return true;
  if(it._cat==='Cuidados' || it._cat==='Dieta' || it._cat==='Protocolo') return true;
  // 2) Via "—" ou dose explicitamente "—" indica ausência intencional
  if(it.via==='—' || it.via==='SND') return true;
  if((it.dose||'').trim()==='—') return true;
  // 3) Fallback para itens criados antes da padronização (prefixo do nome)
  const SEM_DOSE_PREFIX=['DIETA','JEJUM','RESTRIÇÃO','PNI','MCC','OP','SSVV','CABECEIRA','MANTER',
    'QUANTIFICAR','FISIOTERAPIA','SONDA','CURATIVO','DECÚBITO','HGT','JELCO','BALANÇO','PROTOCOLO',
    'CONTENÇÃO','HIGIENE','MUDANÇA DE DECÚBITO','PREVENÇÃO'];
  const farmU=(it.farm||'').toUpperCase();
  return SEM_DOSE_PREFIX.some(s=>farmU.startsWith(s));
}

/* ════════════════════════════════════════════════════════════════════════════
   COPIAR PRESCRIÇÃO DE ONTEM
   ════════════════════════════════════════════════════════════════════════════ */
async function importarPrescricaoOntem(){
  if(!leitoAtual){ toast('Abra o prontuário de um paciente.',true); return; }
  showLoading('Buscando prescrição anterior...');
  try{
    const dataAtual=gf('f-data')||hoje();
    // Lista todas as prescrições do leito e pega a mais recente anterior à atual
    const all=await dbListByPrefix(`uti_med_rx_${leitoAtual}_`);
    const arr=Object.values(all).filter(rx=>rx&&rx.data&&rx.data<dataAtual);
    arr.sort((a,b)=>(b.data||'').localeCompare(a.data||''));
    hideLoading();
    if(!arr.length){ toast('Nenhuma prescrição anterior encontrada.',true); return; }
    const ult=arr[0];
    if(_rxItens.length && !confirm(`Importar ${ult.itens.length} itens da prescrição de ${_fmtDataCurta(ult.data)}? Itens atuais serão substituídos.`)) return;
    // Clona com novos IDs para evitar conflito
    _rxItens = ult.itens.map(it=>({...it, id:Date.now()+Math.random()}));
    _renderPrescricao();
    toast(`<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M2.5 8.5l3.5 3.5 7.5-7.5"/></svg> ${_rxItens.length} itens importados de ${_fmtDataCurta(ult.data)}.`);
  }catch(e){ hideLoading(); toast('Erro: '+(e.message||e),true); }
}

/* ════════════════════════════════════════════════════════════════════════════
   MODAL — MEDICAMENTOS DE USO CONTÍNUO
   Armazena lista de itens em _medcontItens[]. Serializa para f-medcont como
   texto separado por ' | ' (compatível com importarUsoContinuo que divide por
   vírgula/ponto-e-vírgula — usamos ' | ' para não conflitar com vírgulas
   dentro dos nomes de medicamentos).
   ════════════════════════════════════════════════════════════════════════════ */
let _medcontItens = [];   // array de strings, cada uma = 1 medicamento

function abrirModalMedcont(){
  // Carrega itens atuais do campo oculto
  const txt = (gf('f-medcont')||'').trim();
  _medcontItens = txt ? txt.split(' | ').map(s=>s.trim()).filter(Boolean) : [];
  _medcontRenderLista();
  $('medcont-input').value = '';
  $('modal-medcont').classList.add('show');
  setTimeout(()=>$('medcont-input').focus(), 120);
}

function fecharModalMedcont(){
  $('modal-medcont').classList.remove('show');
}

function _medcontRenderLista(){
  const lista = $('medcont-lista');
  if(!lista) return;
  if(!_medcontItens.length){
    lista.innerHTML = '<div style="color:var(--muted);font-size:.8rem;padding:6px 2px;">Nenhum medicamento adicionado.</div>';
    return;
  }
  lista.innerHTML = _medcontItens.map((item,idx)=>`
    <div class="medcont-item">
      <span>${item}</span>
      <button class="mc-rm" onclick="_medcontRemover(${idx})" title="Remover"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><line x1="3.5" y1="3.5" x2="12.5" y2="12.5"/><line x1="12.5" y1="3.5" x2="3.5" y2="12.5"/></svg></button>
    </div>`).join('');
}

function _medcontAdicionar(){
  const inp = $('medcont-input');
  const val = (inp.value||'').trim();
  if(!val){ inp.focus(); return; }
  // Evitar duplicata exata
  if(_medcontItens.some(i=>i.toLowerCase()===val.toLowerCase())){
    toast('Item já adicionado.', true); inp.select(); return;
  }
  _medcontItens.push(val);
  inp.value = '';
  inp.focus();
  _medcontRenderLista();
}

function _medcontRemover(idx){
  _medcontItens.splice(idx,1);
  _medcontRenderLista();
}

function salvarModalMedcont(){
  const serializado = _medcontItens.join(' | ');
  sf('f-medcont', serializado);
  // remove marcação de inválido se já preenchido
  const el = $('f-medcont');
  if(el&&el.closest('.fl')) el.closest('.fl').classList.remove('field-invalid');
  fecharModalMedcont();
  toast('<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M2.5 8.5l3.5 3.5 7.5-7.5"/></svg> Medicamentos de uso contínuo atualizados.');
}

/* ════════════════════════════════════════════════════════════════════════════
   IMPORTAR MEDICAMENTOS DE USO CONTÍNUO
   ════════════════════════════════════════════════════════════════════════════ */
function importarUsoContinuo(){
  const txt=(gf('f-medcont')||'').trim();
  if(!txt){ toast('Não há medicamentos de uso contínuo registrados na admissão.',true); return; }
  // Divide por ' | ' (novo formato do modal) ou vírgula/ponto-e-vírgula (legado)
  const itens=txt.split(/\s*\|\s*|[,;]+/).map(s=>s.trim()).filter(Boolean);
  if(!itens.length){ toast('Sem itens identificáveis.',true); return; }
  // Para cada item, tenta achar no RX_BANCO; se não, cria genérico
  let adicionados=0;
  itens.forEach(nome=>{
    const nomeN=nome.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    const match=RX_BANCO.find(m=>{
      const mn=m.nome.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').split(/\s+/)[0];
      return nomeN.startsWith(mn) || nomeN.includes(mn);
    });
    const novo=_rxNovoItem('normal');
    if(match){
      novo.farm=match.nome; novo.qtd=match.qtd||''; novo.apres=match.apres||'';
      novo.dose=match.dose; novo.diluicao=match.diluicao||''; novo.via=match.via;
      novo.freq=match.freq; novo.hor=[...(match.hor||[])];
      novo.obs=[match.obs||'', match.diluicao||'', '(USO CONTÍNUO)'].filter(Boolean).join(' · ');
      novo._cat=match.cat;
    } else {
      novo.farm=nome.toUpperCase(); novo.obs='(USO CONTÍNUO — REVISAR DOSE)';
    }
    // Evita duplicata
    if(!_rxItens.some(i=>(i.farm||'').toUpperCase()===novo.farm.toUpperCase())){
      _rxItens.push(novo); adicionados++;
    }
  });
  if(adicionados){ _renderPrescricao(); toast(`<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M2.5 8.5l3.5 3.5 7.5-7.5"/></svg> ${adicionados} item(ns) de uso contínuo importado(s). Revise as doses.`); }
  else toast('Nenhum item novo (já estavam na prescrição).',true);
}

/* ════════════════════════════════════════════════════════════════════════════
   TEMPLATES COMPARTILHADOS DE PRESCRIÇÃO
   ─ Salvos em uti_med_tpl_<id> (visíveis a todos os médicos)
   ════════════════════════════════════════════════════════════════════════════ */
async function abrirTemplates(){
  $('modal-tpl').classList.add('show');
  sf('tpl-nome','');
  await _renderListaTemplates();
}

async function _renderListaTemplates(){
  const wrap=$('tpl-lista');
  wrap.innerHTML='<div style="color:var(--muted);font-size:.84rem;">Carregando...</div>';
  const all=await dbListByPrefix('uti_med_tpl_');
  const arr=Object.entries(all).map(([k,v])=>({key:k, ...v})).filter(t=>t.nome);
  arr.sort((a,b)=>(a.nome||'').localeCompare(b.nome||''));
  if(!arr.length){
    wrap.innerHTML='<div class="tip i">Nenhum template salvo ainda. Monte uma prescrição e clique em "Salvar atual como template".</div>';
    return;
  }
  wrap.innerHTML=arr.map(t=>`
    <div style="border:1px solid var(--borda);border-radius:9px;padding:10px 12px;margin-bottom:6px;background:var(--bg2);">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <div>
          <strong style="color:var(--vinho);">${t.nome}</strong><br>
          <span style="font-size:.72rem;color:var(--muted);">${(t.itens||[]).length} itens · criado por ${t.autorNome||t.autor||'?'} em ${t.criadoEm?_fmtDataCurta(t.criadoEm.substring(0,10)):'?'}</span>
        </div>
        <div style="display:flex;gap:4px;">
          <button class="btn btn-pri btn-sm" onclick="aplicarTemplate('${t.key}')">+ Aplicar</button>
          <button class="btn btn-sm" style="color:var(--vermelho);" onclick="excluirTemplate('${t.key}','${t.nome.replace(/'/g,'')}')"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><polyline points="3,5 5,5 13,5"/><path d="M6 5V3.5A.5.5 0 016.5 3h3a.5.5 0 01.5.5V5"/><path d="M5 5l.7 8.5a.8.8 0 00.8.5h3a.8.8 0 00.8-.5L11 5"/><line x1="7" y1="8" x2="7" y2="12"/><line x1="9" y1="8" x2="9" y2="12"/></svg></button>
        </div>
      </div>
    </div>
  `).join('');
}

async function salvarTemplateAtual(){
  const nome=gf('tpl-nome').trim();
  if(!nome){ toast('Informe um nome para o template.',true); return; }
  if(!_rxItens.length){ toast('Adicione itens à prescrição antes de salvar como template.',true); return; }
  showLoading('Salvando template...');
  try{
    const key=`uti_med_tpl_${Date.now()}`;
    // Salva sem IDs (vão ser gerados na aplicação)
    const itensSemId=_rxItens.map(it=>{ const c={...it}; delete c.id; return c; });
    await dbSet(key,{ nome, itens:itensSemId,
      autor:usuarioEmail, autorNome:perfilUsuario?perfilUsuario.nome:'',
      criadoEm:new Date().toISOString() });
    hideLoading(); toast('<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M2.5 8.5l3.5 3.5 7.5-7.5"/></svg> Template salvo e compartilhado.');
    sf('tpl-nome','');
    await _renderListaTemplates();
  }catch(e){ hideLoading(); toast('Erro: '+(e.message||e),true); }
}

async function aplicarTemplate(key){
  showLoading('Carregando template...');
  try{
    const tpl=await dbGet(key);
    hideLoading();
    if(!tpl||!tpl.itens){ toast('Template não encontrado.',true); return; }
    if(_rxItens.length && !confirm(`Adicionar ${tpl.itens.length} itens de "${tpl.nome}" à prescrição atual?`)){ return; }
    tpl.itens.forEach(it=>{
      const novo={...it, id:Date.now()+Math.random()};
      // evita duplicata por nome
      if(!_rxItens.some(i=>(i.farm||'').toUpperCase()===(novo.farm||'').toUpperCase())) _rxItens.push(novo);
    });
    $('modal-tpl').classList.remove('show');
    _renderPrescricao();
    toast(`<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M2.5 8.5l3.5 3.5 7.5-7.5"/></svg> Template "${tpl.nome}" aplicado.`);
  }catch(e){ hideLoading(); toast('Erro: '+(e.message||e),true); }
}

async function excluirTemplate(key, nome){
  if(!confirm(`Excluir o template "${nome}"? Isso afeta todos os médicos.`)) return;
  try{ await dbDelete(key); toast('Template excluído.'); await _renderListaTemplates(); }
  catch(e){ toast('Erro: '+(e.message||e),true); }
}

/* ════════════════════════════════════════════════════════════════════════════
   CALCULADORA DE DROGA VASOATIVA EM BIC (mL/h)
   ════════════════════════════════════════════════════════════════════════════ */
// Diluições padrão do hospital
const BIC_DROGAS = [
  { nome:'Noradrenalina (norepinefrina)', amp:'4mg/4mL', diluicao:'4 amp + 234mL SG 5%', vol:250, totalMcg:16000, unidade:'mcg/kg/min', faixa:'0,05–2', porPeso:true },
  { nome:'Dobutamina',                    amp:'250mg/20mL', diluicao:'4 amp + 170mL SF 0,9%', vol:250, totalMcg:1000000, unidade:'mcg/kg/min', faixa:'2,5–20', porPeso:true },
  { nome:'Vasopressina',                  amp:'20UI/1mL',   diluicao:'1mL + 99mL SF 0,9%',    vol:100, totalUI:20, unidade:'UI/min', faixa:'0,01–0,04', porPeso:false },
  { nome:'Nitroprussiato (Nipride)',      amp:'50mg/2mL',   diluicao:'2mL + 248mL SG 5%',     vol:250, totalMcg:50000, unidade:'mcg/kg/min', faixa:'0,5–10', porPeso:true },
  { nome:'Nitroglicerina (Tridil)',       amp:'50mg/10mL',  diluicao:'1 amp + 240mL SG 5%',   vol:250, totalMcg:50000, unidade:'mcg/min', faixa:'5–200', porPeso:false },
  { nome:'Fentanil',                      amp:'0,05mg/mL',  diluicao:'50mL + 50mL SF 0,9%',   vol:100, totalMcg:2500, unidade:'mcg/kg/h', faixa:'0,5–3', porPeso:true },
  { nome:'Midazolam',                     amp:'5mg/mL',     diluicao:'30mL + 120mL SF 0,9%',  vol:150, totalMg:150,   unidade:'mg/kg/h',  faixa:'0,02–0,1', porPeso:true },
  { nome:'Propofol',                      amp:'10mg/mL',    diluicao:'puro (100mL)',           vol:100, totalMg:1000,  unidade:'mg/kg/h',  faixa:'1–3', porPeso:true },
];

function abrirCalcBIC(){
  const peso=parseFloat(gf('f-peso'))||null;

  // ── Painel 1: BICs da prescrição atual com mL/h ──
  const bics=_calcularBICs();
  let bicsHtml='';
  if(bics.length){
    bicsHtml=`<div class="apoio-card apoio-info" style="margin-bottom:12px;">
      <div class="apoio-titulo"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 2C8 2 3 8 3 11a5 5 0 0010 0C13 8 8 2 8 2z"/></svg> BICs — mL/h calculado (prescrição atual)</div>
      ${bics.map(b=>{
        if(b.semPeso){
          return `<div class="apoio-item"><b>${(b.nomeItem||'').toUpperCase()}:</b>
            <span style="color:var(--vermelho);"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> dose por peso, sem peso registrado</span>
            <div style="font-size:.76rem;color:var(--muted);">${b.droga} · diluição: ${b.diluicao} · faixa ${b.faixa} ${b.doseUnidade}</div></div>`;
        }
        if(b.mlh==null){
          return `<div class="apoio-item"><b>${(b.nomeItem||'').toUpperCase()}:</b>
            <span style="color:var(--muted);">informe a dose para calcular</span></div>`;
        }
        const aviso = b.foraFaixa ? ` <span style="color:var(--laranja);font-weight:700;"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> fora da faixa típica ${b.faixa}</span>` : '';
        return `<div class="apoio-item"><b>${(b.nomeItem||'').toUpperCase()}:</b>
          <b style="color:var(--vinho);">${b.mlh.toFixed(2)} mL/h</b>${aviso}
          <div style="font-size:.76rem;color:var(--muted);">${b.droga} · dose ${b.dose} ${b.doseUnidade} · diluição: ${b.diluicao}</div></div>`;
      }).join('')}
    </div>`;
  }

  // ── Painel 2: Dose por peso (sugestões) ──
  const sugestoes=[];
  _rxItens.forEach(it=>{ const s=_sugerirDosePorPeso(it); if(s) sugestoes.push({nome:it.farm,...s}); });
  let dosesPesoHtml='';
  if(sugestoes.length){
    dosesPesoHtml=`<div class="apoio-card apoio-info" style="margin-bottom:12px;">
      <div class="apoio-titulo"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M2 14L8 2l6 12H2z"/><line x1="5" y1="11" x2="8" y2="5"/></svg> DOSE POR PESO (prescrição atual)</div>
      ${sugestoes.map(s=>`<div class="apoio-item">
        <b>${s.nome}:</b> ${s.intervalo} ${s.uso}${s.calc||''}${s.nota?' <em>('+s.nota+')</em>':''}</div>`).join('')}
    </div>`;
  }

  // ── Painel 3: Calculadora manual ──
  let h=bicsHtml+dosesPesoHtml+
    `<div class="apoio-card apoio-info" style="margin-bottom:0;">
      <div class="apoio-titulo"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M6 2h4M7 2v5L3.5 13.5A1 1 0 004.4 15h7.2a1 1 0 00.9-1.5L9 7V2"/><line x1="4" y1="11" x2="12" y2="11"/></svg> Calculadora manual de BIC</div>
      <div class="tip i" style="margin-bottom:10px;">
        Calcula mL/h conforme as diluições padrão da UTI. ${peso?'Peso atual: <b>'+peso+'kg</b>':'<b style="color:var(--vermelho);"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> Sem peso registrado</b> — preencha na evolução.'}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;">
        <div class="fl"><label>Droga</label>
          <select id="bic-droga" onchange="_bicCalc()">
            ${BIC_DROGAS.map((d,i)=>`<option value="${i}">${d.nome}</option>`).join('')}
          </select>
        </div>
        <div class="fl"><label>Dose desejada</label>
          <input type="number" step="0.01" id="bic-dose" placeholder="ex: 0.1" oninput="_bicCalc()">
          <span id="bic-unidade" style="font-size:.72rem;color:var(--muted);"></span>
        </div>
      </div>
      <div id="bic-resultado"></div>
    </div>`;
  $('bic-body').innerHTML=h;
  $('modal-bic').classList.add('show');
  _bicCalc();
}

function _bicCalc(){
  const idx=parseInt(gf('bic-droga'))||0;
  const d=BIC_DROGAS[idx];
  const peso=parseFloat(gf('f-peso'))||null;
  const dose=parseFloat(gf('bic-dose'))||null;
  $('bic-unidade').textContent=d.unidade+' (faixa típica: '+d.faixa+')';

  let html=`<div style="background:var(--bg2);border:1px solid var(--borda);border-radius:9px;padding:10px 14px;font-size:.86rem;line-height:1.7;">
    <strong>${d.nome}</strong> · ${d.amp}<br>
    <strong>Diluição padrão:</strong> ${d.diluicao} (volume final ${d.vol}mL)<br>`;
  if(d.porPeso && !peso) html+=`<span style="color:var(--vermelho);"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> Esta droga é dose por peso — registre o peso do paciente.</span>`;
  if(!dose) html+=`<span style="color:var(--muted);">Informe a dose desejada acima para calcular mL/h.</span>`;
  if(dose){
    // Calcula mL/h
    let mlh=null;
    if(d.unidade==='mcg/kg/min'){
      if(!peso) html+='<span style="color:var(--vermelho);">Peso necessário</span>';
      else { mlh = (dose*peso*60*d.vol)/d.totalMcg; }
    } else if(d.unidade==='mcg/min'){
      mlh = (dose*60*d.vol)/d.totalMcg;
    } else if(d.unidade==='UI/min'){
      mlh = (dose*60*d.vol)/d.totalUI;
    } else if(d.unidade==='mcg/kg/h'){
      if(!peso) html+='<span style="color:var(--vermelho);">Peso necessário</span>';
      else { mlh = (dose*peso*d.vol)/d.totalMcg; }
    } else if(d.unidade==='mg/kg/h'){
      if(!peso) html+='<span style="color:var(--vermelho);">Peso necessário</span>';
      else { mlh = (dose*peso*d.vol)/d.totalMg; }
    }
    if(mlh!=null && isFinite(mlh)){
      html+=`<div style="margin-top:10px;padding:10px 14px;background:var(--vinho);color:white;border-radius:9px;font-size:1.05rem;text-align:center;">
        <strong>Resultado: ${mlh.toFixed(2)} mL/h</strong><br>
        <span style="font-size:.78rem;opacity:.9;">${d.nome} ${dose} ${d.unidade}${peso?' para '+peso+'kg':''}</span>
      </div>`;
    }
  }
  html+='</div>';
  $('bic-resultado').innerHTML=html;
}


/* ════════════════════════════════════════════════════════════════════════════
   HISTÓRICO COMPACTO DE PRESCRIÇÕES
   Chave única por leito: uti_med_rxs_<leito>
   Estrutura: { dias: [ {d, autor, i:[{f,ds,v,fr,cat,d0}]}, ... ] }
   Máximo de 30 dias. Campos mínimos: f=farm ds=dose v=via fr=freq
   ════════════════════════════════════════════════════════════════════════════ */
const RX_HIST_MAX_DIAS = 30;
const _rxHistKey = (leito) => `uti_med_rxs_${leito}`;

function _rxCompactar(itens, data, autor){
  const iMin = (itens||[]).map(it=>({
    f: (it.farm||'').trim(), ds:(it.dose||'').trim(),
    v: (it.via||'').trim(),  fr:(it.freq||'').trim(),
    ...(it._cat ? {cat:it._cat} : {}),
    ...(it.d0   ? {d0:it.d0}   : {}),
  })).filter(it=>it.f);
  return { d: data, autor: autor||'', i: iMin };
}

async function _rxGravarHistorico(itens, data, autor){
  try{
    const key = _rxHistKey(leitoAtual);
    const atual = await dbGet(key) || {dias:[]};
    let dias = Array.isArray(atual.dias) ? atual.dias : [];
    dias = dias.filter(d => d.d !== data);
    dias.unshift(_rxCompactar(itens, data, autor));
    if(dias.length > RX_HIST_MAX_DIAS) dias = dias.slice(0, RX_HIST_MAX_DIAS);
    await dbSet(key, {dias, atualizadoEm: new Date().toISOString()});
  } catch(e){ console.warn('[rxHistórico]', e); }
}

async function _rxLerHistorico(){
  const doc = await dbGet(_rxHistKey(leitoAtual));
  return (doc && Array.isArray(doc.dias)) ? doc.dias : [];
}

// Abre modal do histórico de prescrições
async function abrirHistoricoRx(){
  const numEl = $('rxh-leito-num');
  if(numEl) numEl.textContent = leitoAtual ? String(leitoAtual).padStart(2,'0') : '—';
  $('modal-rx-historico').classList.add('show');
  await _rxHistoricoRenderizar();
}

// Mantido para compatibilidade com chamadas internas
async function _rxHistoricoInit(){ /* histórico agora é modal — sem-op */ }

async function _rxHistoricoRenderizar(){
  const body = $('rx-hist-conteudo');
  if(!body) return;
  body.innerHTML='<div class="rx-hist-empty" style="padding:8px;">Carregando...</div>';
  const dias = await _rxLerHistorico();
  const dataAtual = gf('f-data')||hoje();
  if(!dias.length){ body.innerHTML='<div class="rx-hist-empty">Nenhum histórico salvo.</div>'; return; }
  let h='';
  dias.forEach((dia,idx)=>{
    if(dia.d===dataAtual) return;
    const dtFmt = dia.d ? _fmtDataCurta(dia.d) : '—';
    const total = (dia.i||[]).length;
    const idBody = `rxh-body-${idx}`;
    h+=`<div class="rx-hist-dia">
      <div class="rx-hist-dia-hdr" onclick="_rxHistToggleDia('${idBody}')">
        <span><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><rect x="3.5" y="3" width="9" height="11" rx="1.2"/><path d="M6 3V2h4v1"/><line x1="6" y1="7" x2="10" y2="7"/><line x1="6" y1="9.5" x2="10" y2="9.5"/><line x1="6" y1="12" x2="9" y2="12"/></svg> ${dtFmt} <span style="font-weight:400;color:var(--muted);">(${total} item${total!==1?'s':''})</span></span>
        <span style="display:flex;gap:6px;align-items:center;">
          <button class="rx-hist-btn-usar" onclick="event.stopPropagation();_rxHistUsarDia('${dia.d}')">Usar esta</button>
          <span style="font-size:.7rem;color:var(--muted);"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M4 6l4 4 4-4"/></svg></span>
        </span>
      </div>
      <div class="rx-hist-dia-body" id="${idBody}" style="display:none;">`;
    if(!dia.i||!dia.i.length){
      h+='<div class="rx-hist-empty">Prescrição vazia.</div>';
    } else {
      dia.i.forEach((it,n)=>{
        const catCls = it.cat==='ATB'?'rx-hist-cat-atb':it.cat==='DIETA'?'rx-hist-cat-dieta':'';
        const det = [it.ds,it.v,it.fr].filter(Boolean).join(' · ');
        const dDia = it.d0 ? ` <span style="font-size:.64rem;background:#fef3c7;color:#92400e;padding:0 4px;border-radius:3px;">D${_calcDDia(it.d0,dia.d)}</span>` : '';
        h+=`<div class="rx-hist-item">
          <span class="rx-hist-num">${n+1}.</span>
          <span class="rx-hist-farm ${catCls}">${it.f}${dDia}</span>
          <span class="rx-hist-det">${det}</span>
        </div>`;
      });
    }
    h+='</div></div>';
  });
  body.innerHTML = h||'<div class="rx-hist-empty">Sem histórico de dias anteriores.</div>';
}

function _rxHistToggleDia(id){
  const el=$(id); if(!el) return;
  el.style.display = el.style.display!=='none' ? 'none' : '';
}

function _calcDDia(d0, dPrescript){
  try{ return Math.floor((new Date(dPrescript)-new Date(d0))/86400000)+1; }
  catch(_){ return '?'; }
}

async function _rxHistUsarDia(data){
  const dias = await _rxLerHistorico();
  const dia = dias.find(d=>d.d===data);
  if(!dia||!dia.i||!dia.i.length){ toast('Prescrição vazia.',true); return; }
  if(_rxItens.length && !confirm(`Substituir a prescrição atual pelos ${dia.i.length} itens de ${_fmtDataCurta(data)}?`)) return;
  _rxItens = dia.i.map(it=>({
    id: Date.now()+Math.random(),
    farm:it.f, dose:it.ds, via:it.v, freq:it.fr,
    _cat:it.cat||'normal', obs:'', d0:it.d0||null, mpp:false
  }));
  _renderPrescricao();
  toast(`<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M2.5 8.5l3.5 3.5 7.5-7.5"/></svg> ${_rxItens.length} itens carregados de ${_fmtDataCurta(data)}`);
}

async function _salvarPrescricaoCore(){
  if(!leitoAtual){ toast('Abra o prontuário de um paciente.',true); return; }
  // Valida: nenhum medicamento pode ter dose vazia
  const semDose=_rxItens.filter(it=>!_rxDispensaDose(it)&&(!it.dose||it.dose.trim()===''||it.dose.trim()==='—'));
  if(semDose.length){
    const nomes=semDose.map((it,i)=>`${i===0?'':'  '}${it.farm||'item '+(it.id)}`).join('\n');
    toast(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><circle cx="8" cy="8" r="6"/><line x1="5.5" y1="5.5" x2="10.5" y2="10.5"/><line x1="10.5" y1="5.5" x2="5.5" y2="10.5"/></svg> Dose obrigatória:\n${nomes}`,true);
    // Rola até o primeiro item sem dose
    setTimeout(()=>{
      const el=document.querySelector('#presc-tbody input[style*="fff5f5"]');
      if(el) el.scrollIntoView({behavior:'smooth',block:'center'});
    },100);
    return;
  }
  showLoading('Salvando prescrição...');
  try{
    const data=gf('f-data')||hoje();
    const key=`uti_med_rx_${leitoAtual}_${data}`;
    await dbSet(key,{ leito:leitoAtual, data, paciente:gf('f-pac'),
      itens:_rxItens, autor:usuarioEmail, autorNome:perfilUsuario?perfilUsuario.nome:'',
      salvadoEm:new Date().toISOString() });
    await _rxGravarHistorico(_rxItens, data, perfilUsuario?perfilUsuario.nome:usuarioEmail);
    hideLoading(); toast('<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M2.5 8.5l3.5 3.5 7.5-7.5"/></svg> Prescrição salva.');
    _rxHistoricoInit();
  }catch(e){ hideLoading(); toast('Erro: '+(e.message||e),true); }
}

async function salvarPrescricao(){
  const atbsNovos = _detectarATBsNovos();
  await _salvarPrescricaoCore();
  _snapshotRX();
  if(atbsNovos.length){
    await new Promise(r=>setTimeout(r,600));
    _mostrarModalATBNovos(atbsNovos);
  }
}

/* ════════════════════════════════════════════════════════════════════════════
   AUTO-PREENCHIMENTO DE ATBs — lê prescrições salvas do leito
   ─ "Em uso": ATBs na última prescrição com D-dia
   ─ "Anteriores": ATBs que já não constam na última prescrição (com período)
   ════════════════════════════════════════════════════════════════════════════ */
async function _autoPreencherATBs(){
  if(!leitoAtual) return;
  try{
    // Busca todas as prescrições salvas do leito
    const todas = await dbListByPrefix(`uti_med_rx_${leitoAtual}_`);
    const arr = Object.values(todas)
      .filter(rx=>rx&&rx.itens&&rx.data)
      .sort((a,b)=>(a.data||'').localeCompare(b.data||''));

    if(!arr.length){
      sf('f-atb','SEM ATB');
      sf('f-atb-prev','—');
      return;
    }

    const ultima = arr[arr.length-1];
    const dataHoje = gf('f-data')||hoje();

    // ── ATBs em uso (prescrição mais recente ou do dia atual) ──────────────
    // Usa a prescrição do dia atual se existir, senão a mais recente
    const prescricaoDoDia = arr.find(rx=>rx.data===dataHoje) || ultima;
    const atbsAtivos = (prescricaoDoDia.itens||[])
      .filter(it=>it._cat==='ATB' && it.farm && it.farm.trim());

    // Monta linha "Em uso": "MEROPENEM 1G (D3) · VANCOMICINA 1G (D1)"
    let textoAtual='';
    if(atbsAtivos.length){
      textoAtual = atbsAtivos.map(it=>{
        let d='';
        if(it.ddInicio){
          const diff=Math.floor(
            (new Date(dataHoje+'T00:00:00')-new Date(it.ddInicio+'T00:00:00'))/86400000
          );
          d=` (D${diff>=0?diff:0})`;
        }
        return it.farm.toUpperCase()+d;
      }).join(' · ');
    } else {
      textoAtual='SEM ATB';
    }

    // ── ATBs anteriores: estavam em alguma prescrição mas não na atual ─────
    // Mapeia por nome: {nomeFarm: {primeiraData, ultimaData}}
    const historicoMap={};
    arr.forEach(rx=>{
      (rx.itens||[]).filter(it=>it._cat==='ATB'&&it.farm).forEach(it=>{
        const k=it.farm.toUpperCase().trim();
        if(!historicoMap[k]) historicoMap[k]={inicio:rx.data, fim:rx.data};
        else { historicoMap[k].fim=rx.data; }
      });
    });

    // Nomes dos ATBs ativos agora
    const ativosNomes=new Set(atbsAtivos.map(it=>it.farm.toUpperCase().trim()));

    // ATBs que já apareceram mas não estão mais na prescrição atual
    const anteriores=Object.entries(historicoMap)
      .filter(([k])=>!ativosNomes.has(k))
      .sort((a,b)=>b[1].fim.localeCompare(a[1].fim)); // mais recente primeiro

    let textoAnterior='';
    if(anteriores.length){
      textoAnterior=anteriores.map(([nome,{inicio,fim}])=>{
        const di=_fmtDataCurta(inicio)||inicio;
        const df=_fmtDataCurta(fim)||fim;
        return nome+(di===df?` (${di})`:`(${di} a ${df})`);
      }).join(' · ');
    } else {
      textoAnterior='—';
    }

    sf('f-atb', textoAtual);
    sf('f-atb-prev', textoAnterior);

  }catch(e){
    console.warn('_autoPreencherATBs erro:', e);
    sf('f-atb','SEM ATB');
    sf('f-atb-prev','—');
  }
}

async function _carregarPrescricao(leito){
  const data = gf('f-data') || hoje();
  const key  = `uti_med_rx_${leito}_${data}`;
  let saved  = await dbGet(key);

  // Só herda a prescrição mais recente se NÃO houver registro salvo para hoje.
  // Importante: se já existe um documento salvo hoje com itens:[] (ex.: o médico
  // suspendeu todos os itens e salvou), isso é uma decisão clínica intencional —
  // NÃO deve herdar a prescrição antiga de volta.
  if(!saved){
    try{
      const todas = await dbListByPrefix(`uti_med_rx_${leito}_`);
      const ordenadas = Object.values(todas)
        .filter(rx => rx && rx.itens && rx.itens.length && rx.data && rx.data !== data)
        .sort((a,b) => b.data.localeCompare(a.data));
      if(ordenadas.length){
        saved = ordenadas[0];
        // Marca os itens como herdados para exibir aviso
        _rxItensHerdadosData = saved.data;
      } else {
        _rxItensHerdadosData = null;
      }
    } catch(e){ console.warn('_carregarPrescricao fallback:', e); }
  } else {
    _rxItensHerdadosData = null;
  }

  _rxItens = saved && saved.itens ? saved.itens.map(it=>({...it, id:it.id||Date.now()+Math.random()})) : [];
  _rxAtualizarDdias();
  _snapshotRX();
  _rxMostrarAvisoHeranca();
  _rxHistoricoInit();
}

// Variável global para data da prescrição herdada
let _rxItensHerdadosData = null;

function _rxMostrarAvisoHeranca(){
  // Exibe aviso discreto se a prescrição foi carregada de outro dia
  let av = $('rx-aviso-heranca');
  if(!av){
    av = document.createElement('div');
    av.id = 'rx-aviso-heranca';
    av.style.cssText = 'display:none;padding:5px 12px;background:#fff7ed;border:1px solid #fed7aa;' +
      'border-radius:6px;font-size:.78rem;color:#92400e;font-weight:600;margin-bottom:8px;';
    const apoio = $('presc-apoio');
    if(apoio && apoio.parentNode) apoio.parentNode.insertBefore(av, apoio);
  }
  if(_rxItensHerdadosData){
    av.style.display = '';
    av.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> Exibindo última prescrição salva (${_fmtDataCurta(_rxItensHerdadosData)}) — salve para registrar a de hoje.`;
  } else {
    av.style.display = 'none';
  }
}

/* ════════════════════════════════════════════════════════════════════════════
   IMPRESSÃO DA PRESCRIÇÃO (página dedicada)
   ════════════════════════════════════════════════════════════════════════════ */
function imprimirPrescricao(){
  const pac=(gf('f-pac')||'').toUpperCase();
  const leito=gf('f-leito');
  const data=gf('f-data');
  const alergia=(gf('f-alergia')||'').toUpperCase();
  const diag=(gf('f-diag')||'').toUpperCase();
  const adm=gf('f-adm');
  const medico=perfilUsuario?(perfilUsuario.nome||'')+(perfilUsuario.crm?' · CRM '+perfilUsuario.crm:''):'';
  const tituloOrig=document.title;
  document.title=`PRESCRICAO ${leito} - ${pac.split(' ').slice(0,2).join(' ')} - ${_fmtDataCurta(data)}`;

  const html=`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
  <title>${document.title}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;text-transform:uppercase;}
    @page{size:A4 landscape;margin:.4cm .7cm}
    body{font-family:'Arial Narrow',Arial,sans-serif;font-size:8pt;color:#111;}
    .cab{display:flex;align-items:center;gap:8px;border-bottom:2px solid #7a1020;padding-bottom:3px;margin-bottom:3px;}
    .cab img{height:32px;width:auto;}
    .cab-c{flex:1;text-align:center;line-height:1.1;}
    .cab-titulo{font-size:10.5pt;font-weight:800;color:#7a1020;letter-spacing:.04em;}
    .cab-sub{font-size:6.5pt;color:#666;}
    .cab-dir{font-size:7pt;color:#555;text-align:right;white-space:nowrap;line-height:1.5;}
    .meta{display:flex;gap:3px;margin-bottom:2px;flex-wrap:wrap;}
    .meta-box{border:1px solid #ccc;padding:1.5px 5px;border-radius:2px;font-size:7pt;flex:1;min-width:80px;}
    .meta-box strong{color:#7a1020;}
    .alerta{background:#fde8e6;border:1.5px solid #e57373;padding:1.5px 6px;border-radius:2px;font-size:7pt;color:#7a1020;font-weight:700;margin-bottom:2px;}
    table{width:100%;border-collapse:collapse;font-size:7.5pt;}
    thead tr{background:#7a1020;color:white;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
    th{padding:2.5px 4px;text-align:left;font-size:6.8pt;font-weight:700;border:1px solid #5c0a18;}
    td{border:1px solid #ccc;padding:2px 4px;vertical-align:middle;line-height:1.25;}
    tr:nth-child(even) td{background:#faf5f6;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
    .tr-dieta td{background:#e6f4ec!important;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
    .tr-sn td{background:#fdf2dd!important;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
    .tr-cuidado td{background:#f0f4ff!important;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
    .n{text-align:center;font-weight:700;color:#7a1020;width:16px;font-size:7pt;}
    .farm{font-weight:700;}
    .th-num{width:16px;}.th-farm{min-width:180px;}.th-dose{width:72px;}.th-via{width:34px;}
    .th-freq{width:62px;}.th-hor{width:140px;}.th-obs{min-width:75px;}
    .assin{margin-top:4px;display:flex;justify-content:flex-end;}
    .assin-box{border-top:1px solid #555;text-align:center;padding-top:2px;min-width:220px;font-size:7pt;}
    .rodape{margin-top:2px;font-size:6pt;color:#aaa;text-align:center;border-top:1px solid #eee;padding-top:1px;}
  </style></head><body>
  <div class="cab">
    <img src="logo.png" alt="" onerror="this.style.display='none'">
    <div class="cab-c">
      <div class="cab-titulo">PRESCRIÇÃO MÉDICA — UTI GERAL</div>
      <div class="cab-sub">HOSPITAL DOS PESCADORES · NATAL/RN</div>
    </div>
    <div class="cab-dir">DATA: ${_fmtDataCurta(data)||'—'}<br>LEITO: ${leito||'?'}</div>
  </div>
  <div class="meta">
    <div class="meta-box"><strong>PACIENTE:</strong> ${pac||'—'}</div>
    <div class="meta-box"><strong>LEITO:</strong> ${leito||'?'}</div>
    <div class="meta-box"><strong>DATA:</strong> ${_fmtDataCurta(data)||'—'}</div>
    <div class="meta-box"><strong>ADM UTI:</strong> ${_fmtDataCurta(adm)||'—'}</div>
    ${diag?`<div class="meta-box" style="flex:2;"><strong>DIAGNÓSTICO:</strong> ${diag}</div>`:''}
  </div>
  ${alergia&&!/^NEGA$/.test(alergia.trim())?`<div class="alerta"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> ALERGIA: ${alergia}</div>`:''}
  <table>
    <thead>
      <tr>
        <th class="th-num">#</th>
        <th class="th-farm">FÁRMACO / ITEM</th>
        <th class="th-dose">DOSE</th>
        <th class="th-via">VIA</th>
        <th class="th-freq">FREQUÊNCIA</th>
        <th class="th-hor">HORÁRIOS</th>
        <th class="th-obs">OBSERVAÇÕES</th>
      </tr>
    </thead>
    <tbody>
      ${_rxItens.map((it,i)=>{
        const rowCls=it.tipo==='dieta'?'tr-dieta':it.tipo==='sn'?'tr-sn':it.tipo==='cuidados'?'tr-cuidado':'';
        const hors=_ordenarHorarios(it.hor||[]).join(' · ')||'—';
        const doseImpressa=[it.qtd, (it.apres&&it.apres!=='—'?it.apres:''), (it.dose&&it.dose!=='—'?it.dose:'')]
          .filter(Boolean).join(' ')||'—';
        // D-dia ao lado do nome
        const dBadge=it._cat==='ATB'&&it._ddia!=null
          ? `<span style="background:${it._ddia>=10?'#b71c1c':it._ddia>=7?'#e65100':'#1565c0'};color:white;font-size:6.5pt;font-weight:800;padding:1px 5px;border-radius:4px;margin-left:5px;vertical-align:middle;">D${it._ddia}</span>`
          : '';
        // Diluição abaixo do nome (apenas EV com diluição)
        const dilHtml=it.diluicao
          ? `<div style="font-size:7pt;color:#1d4ed8;margin-top:1px;font-weight:600;">Diluente: ${it.diluicao.toUpperCase()}</div>`
          : '';
        return `<tr class="${rowCls}">
          <td class="n">${i+1}</td>
          <td class="farm"><span style="font-weight:700;">${(it.farm||'—').toUpperCase()}</span>${dBadge}${dilHtml}</td>
          <td>${doseImpressa.toUpperCase()}</td>
          <td>${(it.via||'—').toUpperCase()}</td>
          <td>${(it.freq||'—').toUpperCase()}</td>
          <td style="font-size:8.5pt;">${hors.toUpperCase()}</td>
          <td style="font-size:8.5pt;">${(it.obs||'').toUpperCase()}</td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>

  <div class="assin">
    <div class="assin-box">
      ${medico||'&nbsp;'}<br>
      <span style="font-size:7.5pt;color:#777;">PRESCRIÇÃO MÉDICA · ${_fmtDataCurta(data)} · ${agoraHora()}</span>
    </div>
  </div>
  <div class="rodape">DOCUMENTO GERADO ELETRONICAMENTE — HOSPITAL DOS PESCADORES · UTI GERAL</div>
  <script>window.onload=()=>{window.print();window.onafterprint=()=>window.close();}<\/script>
  </body></html>`;

  const w=window.open('','_blank','width=1000,height=700');
  if(w){ w.document.write(html); w.document.close(); }
  else{ toast('Popup bloqueado — permita popups para imprimir.',true); }
  setTimeout(()=>{ document.title=tituloOrig; },2000);
}


/* ════════════════════════════════════════════════════════════════════════════
   RECEITUÁRIO (Comum / Controle Especial)
   ─ Abre modal, permite importar itens da prescrição atual
   ─ Imprime sem salvar no Firestore
   ─ Após imprimir, pergunta se quer adicionar à prescrição atual
   ════════════════════════════════════════════════════════════════════════════ */
let _recTipo = 'comum';  // 'comum' | 'especial'

function abrirReceituario(tipo){
  if(!leitoAtual){ toast('Abra o prontuário de um paciente.', true); return; }
  _recTipo = tipo === 'especial' ? 'especial' : 'comum';
  // Título e badge
  const titulo = _recTipo === 'especial' ? 'Receituário de Controle Especial' : 'Receituário Comum';
  const badge  = _recTipo === 'especial' ? 'AZUL · 2 VIAS' : 'BRANCO';
  const badgeCor = _recTipo === 'especial'
    ? 'background:#e8f0fe;color:#1d4ed8;border:1px solid #1d4ed8;'
    : 'background:#fff;color:#333;border:1px solid #ccc;';
  sf('rec-titulo', '');  // sf não funciona para spans; usa textContent
  const elT = document.getElementById('rec-titulo');
  const elB = document.getElementById('rec-tipo-badge');
  if(elT) elT.textContent = titulo;
  if(elB){ elB.textContent = badge; elB.style.cssText = 'font-size:.68rem;padding:2px 8px;border-radius:4px;'+badgeCor; }

  // Pré-preenche dados do paciente
  sf('rec-pac',    (gf('f-pac')||'').toUpperCase());
  sf('rec-data',   gf('f-data') || hoje());
  sf('rec-end',    '');
  sf('rec-cidade', 'NATAL/RN');
  sf('rec-prescricao', '');

  // Médico do perfil
  if(perfilUsuario){
    sf('rec-medico', (perfilUsuario.nome||'').toUpperCase());
    sf('rec-crm',    perfilUsuario.crm || '');
    sf('rec-crm-uf', 'RN');
  }

  // Renderiza lista de importação da prescrição atual
  _recRenderImportarLista();

  $('modal-receituario').classList.add('show');
  setTimeout(()=>{ _autoResizeTA($('rec-prescricao')); }, 100);
}

function fecharReceituario(){
  $('modal-receituario').classList.remove('show');
}

function _recRenderImportarLista(){
  const w = $('rec-importar-lista'); if(!w) return;
  if(!_rxItens || !_rxItens.length){
    w.innerHTML = '<div style="font-size:.72rem;color:var(--muted);padding:8px;text-align:center;">Nenhuma medicação na prescrição atual.</div>';
    return;
  }
  w.innerHTML = _rxItens.map((it,i)=>{
    if(!it.farm) return '';
    const cat = it._cat==='ATB' ? '🦠' : it.tipo==='dieta' ? '🍽' : it.tipo==='sn' ? '⚠' : it.tipo==='cuidados' ? '✓' : '💊';
    const dose = [it.qtd, (it.apres&&it.apres!=='—'?it.apres:''), (it.dose&&it.dose!=='—'?it.dose:'')].filter(Boolean).join(' ');
    return `<label style="display:flex;gap:6px;align-items:flex-start;padding:6px 8px;background:white;border:1px solid var(--borda);border-radius:5px;cursor:pointer;">
      <input type="checkbox" class="rec-imp-chk" data-idx="${i}" style="margin-top:2px;flex-shrink:0;">
      <div style="flex:1;line-height:1.3;">
        <div style="font-weight:600;font-size:.76rem;">${cat} ${(it.farm||'').toUpperCase()}</div>
        <div style="font-size:.7rem;color:var(--muted);">${(dose||'').toUpperCase()} ${(it.via||'').toUpperCase()} ${(it.freq||'').toUpperCase()}</div>
      </div>
    </label>`;
  }).filter(Boolean).join('');
}

function _recMarcarTodos(marcar){
  document.querySelectorAll('.rec-imp-chk').forEach(c=>{ c.checked = !!marcar; });
}

function _recImportarSelecionados(){
  const ta = $('rec-prescricao'); if(!ta) return;
  const selecionados = Array.from(document.querySelectorAll('.rec-imp-chk:checked'))
    .map(c => parseInt(c.dataset.idx,10))
    .filter(i => !isNaN(i) && _rxItens[i]);
  if(!selecionados.length){ toast('Marque ao menos uma medicação.', true); return; }

  // Numera continuando da última linha "N-" existente
  const atual = ta.value || '';
  const ultNum = (atual.match(/^\s*(\d+)\s*-/gm)||[]).map(s=>parseInt(s,10)).reduce((a,b)=>Math.max(a,b),0);

  const linhas = selecionados.map((idx, k)=>{
    const it = _rxItens[idx];
    const n = ultNum + k + 1;
    const dose = [it.qtd, (it.apres&&it.apres!=='—'?it.apres:''), (it.dose&&it.dose!=='—'?it.dose:'')]
      .filter(Boolean).join(' ');
    const via = (it.via||'').toUpperCase();
    const freq = (it.freq||'').toUpperCase();
    const farm = (it.farm||'').toUpperCase();
    const linha1 = `${n}- ${farm} ${dose}`.trim().replace(/\s+/g,' ');
    const linha2 = `   ${via} ${freq}`.trim().replace(/\s+/g,' ');
    return linha1 + '\n' + linha2;
  });

  ta.value = (atual ? atual.replace(/\s+$/,'') + '\n\n' : '') + linhas.join('\n\n') + '\n';
  _autoResizeTA(ta);
  // Desmarca após importar
  _recMarcarTodos(false);
  toast(`✓ ${selecionados.length} item(ns) importado(s).`);
}

function imprimirReceituario(){
  const prescricao = (gf('rec-prescricao')||'').trim();
  if(!prescricao){ toast('Digite ao menos uma medicação.', true); return; }

  const pac    = (gf('rec-pac')||'').toUpperCase();
  const data   = gf('rec-data')||hoje();
  const end    = (gf('rec-end')||'').toUpperCase();
  const cidade = (gf('rec-cidade')||'NATAL/RN').toUpperCase();
  const medico = (gf('rec-medico')||'').toUpperCase();
  const crm    = (gf('rec-crm')||'').toUpperCase();
  const crmUf  = (gf('rec-crm-uf')||'RN').toUpperCase();

  const ehEspecial = _recTipo === 'especial';
  const titulo = ehEspecial ? 'RECEITUÁRIO CONTROLE ESPECIAL' : 'RECEITUÁRIO';
  const corTopo = '#7a1020';

  const tituloOrig = document.title;
  document.title = `${titulo} — ${pac.split(' ').slice(0,2).join(' ')} — ${_fmtDataCurta(data)}`;

  // CSS comum às duas versões
  const cssComum = `
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Times New Roman',Times,serif;font-size:11pt;color:#111;}
    .cab{display:flex;align-items:center;gap:8px;border-bottom:2px solid ${corTopo};padding-bottom:4px;margin-bottom:4px;}
    .cab img{height:38px;width:auto;}
    .cab-c{flex:1;line-height:1.15;}
    .cab-titulo{font-size:10.5pt;font-weight:800;color:${corTopo};}
    .cab-sub{font-size:7pt;color:#444;}
    .titulo-rec{text-align:center;font-size:12pt;font-weight:800;color:${corTopo};letter-spacing:.08em;border:2px solid ${corTopo};padding:3px 8px;border-radius:18px;margin:5px auto;display:inline-block;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
    .titulo-wrap{text-align:center;margin:4px 0 6px;}
    .box-id{border:1px solid #333;margin:5px 0;border-radius:2px;}
    .box-id-t{background:#eee;font-size:7.5pt;font-weight:700;text-align:center;padding:2px;border-bottom:1px solid #333;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
    .box-id-c{padding:4px 7px;font-size:8.5pt;line-height:1.5;}
    .dados{font-size:9.5pt;line-height:1.65;margin:5px 0;padding:0 3px;}
    .dados b{font-weight:700;}
    .prescricao-area{white-space:pre-wrap;font-family:'Courier New',Courier,monospace;font-size:9.5pt;line-height:1.55;padding:6px 5px;border-top:1px solid #ddd;border-bottom:1px solid #ddd;margin:4px 0;}
    .assin{margin-top:8px;display:flex;justify-content:center;}
    .assin-box{border-top:1px solid #333;text-align:center;padding-top:2px;min-width:240px;font-size:9pt;font-weight:700;}
    .box-comp{display:flex;gap:5px;margin-top:5px;}
    .box-comp-col{flex:1;border:1px solid #333;border-radius:2px;}
    .box-comp-t{background:#eee;font-size:7pt;font-weight:700;text-align:center;padding:2px;border-bottom:1px solid #333;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
    .box-comp-c{padding:4px 6px;font-size:8pt;line-height:1.65;}
    .rodape{text-align:center;font-size:6.5pt;color:#888;margin-top:6px;border-top:1px solid #eee;padding-top:2px;}
    .via-label{font-size:7pt;font-weight:700;text-align:right;color:${corTopo};border:1px dashed ${corTopo};padding:1px 5px;border-radius:3px;display:inline-block;float:right;}
  `;

  // HTML de UMA via (label = '1ª VIA · FARMÁCIA' ou '2ª VIA · PACIENTE')
  const umaVia = (label) => `
    <div class="via">
      <div class="cab">
        <img src="logo.png" alt="" onerror="this.style.display='none'">
        <div class="cab-c">
          <div class="cab-titulo">HOSPESC — HOSPITAL DOS PESCADORES</div>
          <div class="cab-sub">Rua São João de Deus, 80 — Rocas — Natal/RN · CEP 59010-775</div>
          <div class="cab-sub">Fone: (84) 3232-4592 · hospitaldospescadoresadm@gmail.com</div>
        </div>
        ${label ? `<span class="via-label">${label}</span>` : ''}
      </div>
      <div class="titulo-wrap"><span class="titulo-rec">${titulo}</span></div>

      ${ehEspecial ? `
      <div class="box-id">
        <div class="box-id-t">IDENTIFICAÇÃO DO EMITENTE</div>
        <div class="box-id-c">
          <div><b>Nome Completo:</b> ${medico||'________________________________'}</div>
          <div><b>CRM:</b> ${crm||'_______'} &nbsp; <b>UF:</b> ${crmUf||'__'}</div>
          <div><b>Endereço e Telefone:</b> Rua São João de Deus, 80 — Rocas — (84) 3232-4592</div>
          <div><b>Cidade:</b> Natal &nbsp; <b>UF:</b> RN</div>
        </div>
      </div>` : ''}

      <div class="dados">
        <div><b>Paciente:</b> ${pac||'_________________________________________'}</div>
        <div><b>Endereço:</b> ${end||'_________________________________________'}</div>
        <div><b>Cidade:</b> ${cidade||'______________________'} &nbsp;&nbsp; <b>Data:</b> ___/___/______</div>
        <div><b>Prescrição:</b></div>
      </div>

      <div class="prescricao-area">${_recEscapeHTML(prescricao)}</div>

      <div class="assin">
        <div class="assin-box">
          ${medico||'&nbsp;'}<br>
          <span style="font-size:8pt;color:#555;font-weight:400;">CRM ${crm||'____'}/${crmUf||'__'}</span>
        </div>
      </div>

      ${ehEspecial ? `
      <div class="box-comp">
        <div class="box-comp-col">
          <div class="box-comp-t">IDENTIFICAÇÃO DO COMPRADOR</div>
          <div class="box-comp-c">
            <div>Nome: ________________________________</div>
            <div>Ident.: ____________ Órg. Emissor: _____</div>
            <div>End.: _________________________________</div>
            <div>Cidade: ____________ UF: ___ Tel: ______</div>
          </div>
        </div>
        <div class="box-comp-col">
          <div class="box-comp-t">IDENTIFICAÇÃO DO FORNECEDOR</div>
          <div class="box-comp-c" style="min-height:72px;">
            <div style="margin-top:50px;border-top:1px solid #333;padding-top:2px;text-align:center;font-size:6.5pt;">
              ASSINATURA DO FARMACÊUTICO &nbsp; DATA: ___/___/______
            </div>
          </div>
        </div>
      </div>` : `<div class="rodape">Receituário Comum · Hospital dos Pescadores · UTI Geral</div>`}
    </div>
  `;

  // Layout: especial=paisagem 2 vias lado a lado; comum=retrato 1 via
  let html;
  if(ehEspecial){
    html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
    <title>${document.title}</title>
    <style>
      ${cssComum}
      @page{size:A4 landscape;margin:.5cm .6cm;}
      body{display:flex;flex-direction:row;gap:0;height:100%;}
      .via{flex:1;padding:5px 8px;overflow:hidden;}
      .separador{width:1px;background:repeating-linear-gradient(to bottom,#999 0,#999 6px,transparent 6px,transparent 10px);margin:0 4px;align-self:stretch;flex-shrink:0;}
      .prescricao-area{min-height:9cm;}
    </style></head><body>
    ${umaVia('1ª VIA · FARMÁCIA')}
    <div class="separador"></div>
    ${umaVia('2ª VIA · PACIENTE')}
    <script>window.onload=()=>{window.print();window.onafterprint=()=>window.close();}<\/script>
    </body></html>`;
  } else {
    html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
    <title>${document.title}</title>
    <style>
      ${cssComum}
      @page{size:A4 portrait;margin:.6cm;}
      .prescricao-area{min-height:16cm;}
    </style></head><body>
    ${umaVia('')}
    <script>window.onload=()=>{window.print();window.onafterprint=()=>window.close();}<\/script>
    </body></html>`;
  }

  const w = window.open('', '_blank', 'width=900,height=900');
  if(w){ w.document.write(html); w.document.close(); }
  else{ toast('Popup bloqueado — permita popups para imprimir.', true); return; }
  setTimeout(()=>{ document.title = tituloOrig; }, 2000);

  // Após imprimir, pergunta se quer adicionar à prescrição atual
  setTimeout(_recPerguntarAdicionar, 800);
}

function _recEscapeHTML(s){
  return (s||'').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
}

function _recPerguntarAdicionar(){
  const prescricao = (gf('rec-prescricao')||'').trim();
  if(!prescricao) return;
  // Parseia para mostrar quantos itens serão adicionados
  const itens = _recParsearMedicacoes(prescricao);
  if(!itens.length) return;

  const lista = itens.map((it,i)=>`${i+1}. ${it.farm}${it.posologia?' — '+it.posologia:''}`).join('\n');
  if(confirm(`Deseja adicionar as ${itens.length} medicação(ões) do receituário à prescrição atual?\n\n${lista}\n\nAs medicações serão adicionadas com a posologia indicada.`)){
    _recAdicionarNaPrescricao(itens);
  }
}

/**
 * Parseia o texto livre do receituário em itens estruturados.
 * Cada item começa com "N-" ou "N." e pode ter linhas seguintes com a posologia.
 * Retorna: [{farm, dose, freq, via, posologia}]
 */
function _recParsearMedicacoes(texto){
  if(!texto) return [];
  const linhas = texto.split('\n');
  const itens = [];
  let atual = null;
  const regexItem = /^\s*\d+\s*[-.)]\s*(.+)$/;

  linhas.forEach(linhaRaw => {
    const linha = linhaRaw.replace(/\s+$/,'');
    if(!linha.trim()) return;
    const m = linha.match(regexItem);
    if(m){
      // Novo item — fecha o anterior
      if(atual) itens.push(_recExtrairCampos(atual));
      atual = { farm: m[1].trim(), posologiaRaw: '' };
    } else if(atual){
      // Linha de posologia/continuação do item atual
      atual.posologiaRaw += (atual.posologiaRaw?' ':'') + linha.trim();
    }
  });
  if(atual) itens.push(_recExtrairCampos(atual));
  return itens;
}

/**
 * A partir de "1- DIPIRONA 500mg ____ 20 COMPRIMIDOS" + "TOMAR 1 COMPRIMIDO VO 6/6h"
 * extrai: farm, dose, via, freq, posologia (texto completo).
 */
function _recExtrairCampos(raw){
  // Primeira linha: nome + dose embutida tipo "DIPIRONA 500mg ____ 20 COMPRIMIDOS"
  // Pega tudo antes de "____" ou múltiplos espaços como o nome + dose principal
  const cabecalho = (raw.farm||'').replace(/_+/g,'').replace(/\s+/g,' ').trim();
  // Tenta extrair primeira palavra como nome do fármaco + número logo a seguir como dose
  const matchNomeDose = cabecalho.match(/^([A-ZÇÃÉÊÁÍÓÚÂÔÕa-zçãéêáíóúâôõ\s\-]+?)(\s+\d[\d.,]*\s*(?:mg|mcg|g|ml|UI|%)?)?(\s+.*)?$/);
  const farm = matchNomeDose ? (matchNomeDose[1]||cabecalho).trim().toUpperCase() : cabecalho.toUpperCase();
  const dose = matchNomeDose && matchNomeDose[2] ? matchNomeDose[2].trim() : '';

  // Posologia: junta o resto da primeira linha + linhas seguintes
  const restoCab = matchNomeDose && matchNomeDose[3] ? matchNomeDose[3].trim() : '';
  const posologia = [restoCab, raw.posologiaRaw].filter(Boolean).join(' · ').trim();

  // Tenta extrair via e freq da posologia
  const upper = posologia.toUpperCase();
  let via = '';
  const vias = ['EV','VO','SC','IM','IN','SL','SNE','SNG','TOP','OFT','OT','RET','VAG','INAL','NEB','NEBULIZAÇÃO'];
  for(const v of vias){ if(new RegExp('\\b'+v+'\\b').test(upper)){ via = v; break; } }

  let freq = '';
  const mFreq = upper.match(/\b(\d+\s*\/\s*\d+\s*(?:H|HORAS|HRS|HS))\b|\b(\d+X\s*(?:AO\s*DIA|\/DIA|D)?)\b|\bAGORA\b|\b(?:SOS|S\.O\.S\.|SE\s+DOR|SE\s+NECESS[ÁA]RIO)\b|\b1\s*VEZ\s*(?:AO\s*)?DIA\b/);
  if(mFreq) freq = mFreq[0].replace(/\s+/g,'').toUpperCase();
  if(/AGORA/.test(upper)) freq = 'AGORA';

  return { farm, dose, via, freq, posologia };
}

/**
 * Adiciona os itens parseados ao _rxItens (prescrição atual em memória)
 * e re-renderiza a tabela. Não salva no Firestore — usuário precisa clicar "Salvar".
 */
function _recAdicionarNaPrescricao(itens){
  if(!itens || !itens.length) return;
  let novoId = (_rxItens||[]).reduce((m,it)=>Math.max(m, it.id||0), 0);
  itens.forEach(it => {
    novoId++;
    _rxItens.push({
      id: novoId,
      farm: it.farm || '',
      qtd: '',
      apres: '',
      dose: it.dose || '',
      via: it.via || 'VO',
      freq: it.freq || '',
      hor: [],
      obs: it.posologia || '',
      _cat: '',
      tipo: ''
    });
  });
  _renderPrescricao();
  toast(`✓ ${itens.length} item(ns) adicionado(s) à prescrição. Lembre-se de salvar.`);
  fecharReceituario();
}


/* ════════════════════════════════════════════════════════════════════════════
   FICHA DE ANTIMICROBIANO
   ─ Estado, abertura, preenchimento automático, save/load, impressão
   ════════════════════════════════════════════════════════════════════════════ */
let _fichaATBLinhas = []; // [{atb, via, posologia, ddInicio, dias}]
let _fichaATBKey = null;  // chave do Firebase da ficha atual

// Abre o modal pré-preenchido com dados do paciente
function abrirFichaATB(atbPresel){
  // Preenche dados do paciente
  sf('fatb-pac',   gf('f-pac')||'');
  sf('fatb-dn',    gf('f-dn')||'');
  sf('fatb-leito', gf('f-leito')||'');
  sf('fatb-data',  gf('f-data')||hoje());
  // Se não tem linhas, cria uma
  if(!_fichaATBLinhas.length) _fichaATBLinhas=[_fatbNovaLinha(atbPresel||'')];
  _fatbRenderLinhas();
  _fatbRenderCCIH();
  // Auto-detecta diagnóstico pela evolução
  _fatbAutoDetectarDiag();
  // Auto-detecta exame micro pelas culturas
  _fatbAutoDetectarMicro();
  $('modal-atb-ficha').classList.add('show');
}

function fecharFichaATB(){ $('modal-atb-ficha').classList.remove('show'); }

function _fatbNovaLinha(atb){
  return { atb:atb||'', via:'EV', posologia:'', ddInicio:gf('f-data')||hoje(), dias:'7' };
}
function _fatbAddLinha(){ _fichaATBLinhas.push(_fatbNovaLinha('')); _fatbRenderLinhas(); }

function _fatbRenderLinhas(){
  const w=$('fatb-atbs-wrap'); if(!w) return;
  w.innerHTML=_fichaATBLinhas.map((l,i)=>`
    <div class="fatb-linha-atb">
      <div class="fl" style="flex:2"><label>Antimicrobiano ${i+1}</label>
        <input type="text" value="${l.atb||''}" style="text-transform:uppercase;"
          oninput="_fichaATBLinhas[${i}].atb=this.value.toUpperCase()">
      </div>
      <div class="fl"><label>Via</label>
        <select onchange="_fichaATBLinhas[${i}].via=this.value">
          ${['EV','VO','SC','IM','IN','SNE'].map(v=>`<option ${l.via===v?'selected':''}>${v}</option>`).join('')}
        </select>
      </div>
      <div class="fl" style="flex:2"><label>Posologia / Frequência</label>
        <input type="text" value="${l.posologia||''}" style="text-transform:uppercase;"
          oninput="_fichaATBLinhas[${i}].posologia=this.value.toUpperCase()">
      </div>
      <div class="fl"><label>D0 (início)</label>
        <input type="date" value="${l.ddInicio||hoje()}"
          oninput="_fichaATBLinhas[${i}].ddInicio=this.value">
      </div>
      <div class="fl"><label>Dias previstos</label>
        <input type="number" value="${l.dias||7}" min="1" max="90" style="width:70px;"
          oninput="_fichaATBLinhas[${i}].dias=this.value">
      </div>
      ${_fichaATBLinhas.length>1?`<button class="presc-del" onclick="_fichaATBLinhas.splice(${i},1);_fatbRenderLinhas()" title="Remover"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><polyline points="3,5 5,5 13,5"/><path d="M6 5V3.5A.5.5 0 016.5 3h3a.5.5 0 01.5.5V5"/><path d="M5 5l.7 8.5a.8.8 0 00.8.5h3a.8.8 0 00.8-.5L11 5"/><line x1="7" y1="8" x2="7" y2="12"/><line x1="9" y1="8" x2="9" y2="12"/></svg></button>`:''}
    </div>
  `).join('<hr style="border:none;border-top:1px dashed var(--borda);margin:6px 0;">');
}

function _fatbRenderCCIH(){
  const w=$('fatb-ccih-linhas'); if(!w) return;
  w.innerHTML=_fichaATBLinhas.map((l,i)=>`
    <div style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr 2fr 1fr;gap:6px;align-items:center;font-size:.8rem;padding:4px 0;border-bottom:1px dashed #e0cc99;">
      <span style="font-weight:700;">${l.atb||('ATB '+(i+1))}</span>
      <span>Autorização:
        <label><input type="radio" name="ccih-aut-${i}" value="sim"> S</label>
        <label><input type="radio" name="ccih-aut-${i}" value="nao" checked> N</label>
      </span>
      <span>Alteração:
        <label><input type="radio" name="ccih-alt-${i}" value="sim"> S</label>
        <label><input type="radio" name="ccih-alt-${i}" value="nao" checked> N</label>
      </span>
      <input type="text" placeholder="Via sugerida" style="font-size:.76rem;padding:3px 6px;border:1px solid var(--borda);border-radius:5px;">
      <input type="text" placeholder="Posologia sugerida" style="font-size:.76rem;padding:3px 6px;border:1px solid var(--borda);border-radius:5px;">
      <input type="text" placeholder="Duração" style="font-size:.76rem;padding:3px 6px;border:1px solid var(--borda);border-radius:5px;">
    </div>
  `).join('');
}

// Autodetectar diagnóstico infeccioso pela evolução/diagnóstico
function _fatbAutoDetectarDiag(){
  const diag=(gf('f-diag')||'').toUpperCase();
  const evol=(gf('f-evol')||'').toUpperCase();
  const txt=diag+' '+evol;
  const mapa=[
    ['fatb-d-pneumo', /PNEUMONIA|PAC|PAVM|PAV/],
    ['fatb-d-itu',    /ITU|URIN|UROCULT|CISTITE|PIELONE/],
    ['fatb-d-sepse',  /SEPSE|SEPSIS/],
    ['fatb-d-bact',   /BACTEREMIA|HEMOCULTURA/],
    ['fatb-d-cateter',/CATETER|CDL|IPCS/],
    ['fatb-d-digest', /ABDOMIN|PERITONITE|COLANGITE|COLECISTITE|DIGESTIV/],
    ['fatb-d-cirurg', /CIRURG|FERIDA|ISC/],
  ];
  mapa.forEach(([id, re])=>{ const el=$(id); if(el) el.checked=re.test(txt); });
}

// Autodetectar exame micro pelas culturas do formulário
function _fatbAutoDetectarMicro(){
  if(!_culturasForm||!_culturasForm.length) return;
  const pos=_culturasForm.filter(c=>c.micro);
  if(!pos.length) return;
  const ult=pos[pos.length-1];
  sf('fatb-micro-data', ult.data||'');
  sf('fatb-micro-mat',  ult.sitio||'');
  sf('fatb-micro-sens', ult.sens||ult.micro||'');
  // Inicializa painel de histórico
  _rxHistoricoInit();
}

// Salvar ficha no Firebase
async function salvarFichaATB(){
  if(!leitoAtual){ toast('Abra o prontuário de um paciente.',true); return; }
  showLoading('Salvando ficha...');
  try{
    const ficha=_coletarFichaATB();
    const key=`uti_med_atb_ficha_${leitoAtual}_${ficha.data}_${Date.now()}`;
    await dbSet(key, ficha);
    _fichaATBKey=key;
    hideLoading();
    toast('<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M2.5 8.5l3.5 3.5 7.5-7.5"/></svg> Ficha salva.');
    _renderGuiasFichas();
  }catch(e){ hideLoading(); toast('Erro: '+(e.message||e),true); }
}

function _coletarFichaATB(){
  const origem = document.querySelector('input[name="fatb-origem"]:checked');
  const uso    = document.querySelector('input[name="fatb-uso"]:checked');
  const hdia   = document.querySelector('input[name="fatb-hdia"]:checked');
  const diags  = ['bact','cateter','neutro','itu','pneumo','pele','cirurg','sepse','digest']
    .filter(d=>$('fatb-d-'+d)&&$('fatb-d-'+d).checked);
  if($('fatb-d-outro')&&$('fatb-d-outro').checked) diags.push(gf('fatb-d-outro-txt')||'Outro');
  return {
    pac:gf('fatb-pac'), dn:gf('fatb-dn'), leito:gf('fatb-leito'),
    data:gf('fatb-data'), hospitalDia:hdia?hdia.value:'nao',
    origem:origem?origem.value:'', uso:uso?uso.value:'terapeutico',
    diagnosticos:diags,
    microData:gf('fatb-micro-data'), microMat:gf('fatb-micro-mat'), microSens:gf('fatb-micro-sens'),
    atbs:_fichaATBLinhas.map(l=>({...l})),
    ccihSug:gf('fatb-ccih-sug'), ccihMed:gf('fatb-ccih-med'),
    autor:usuarioEmail, autorNome:perfilUsuario?perfilUsuario.nome:'',
    salvadoEm:new Date().toISOString()
  };
}

// Listar fichas salvas na aba Guias (ATB + Hemoterápicos)
async function _renderGuiasFichas(){
  const w=$('guias-fichas-lista'); if(!w) return;
  w.innerHTML='<span style="font-size:.8rem;color:var(--muted);">Carregando...</span>';
  try{
    const atbs     = await dbListByPrefix(`uti_med_atb_ficha_${leitoAtual}_`);
    const hemos    = await dbListByPrefix(`uti_med_hemo_ficha_${leitoAtual}_`);
    const termos   = await dbListByPrefix(`uti_med_termo_${leitoAtual}_`);
    const trilogys = await dbListByPrefix(`uti_med_trilogy_${leitoAtual}_`);
    const mes      = await dbListByPrefix(`uti_med_me_${leitoAtual}_`);
    const albuminas= await dbListByPrefix(`uti_med_albumina_${leitoAtual}_`);
    const huols    = await dbListByPrefix(`uti_med_huol_${leitoAtual}_`);
    const arr=[
      ...Object.entries(atbs).map(([k,v])=>({key:k,...v, _tipo:'atb'})),
      ...Object.entries(hemos).map(([k,v])=>({key:k,...v, _tipo:'hemo'})),
      ...Object.entries(termos).map(([k,v])=>({key:k,...v, _tipo:'termo'})),
      ...Object.entries(trilogys).map(([k,v])=>({key:k,...v, _tipo:'trilogy'})),
      ...Object.entries(mes).map(([k,v])=>({key:k,...v, _tipo:'me'})),
      ...Object.entries(albuminas).map(([k,v])=>({key:k,...v, _tipo:'albumina'})),
      ...Object.entries(huols).map(([k,v])=>({key:k,...v, _tipo:'huol'}))
    ].filter(x=>x.pac||x.nome||x.resp).sort((a,b)=>(b.salvadoEm||'').localeCompare(a.salvadoEm||''));
    if(!arr.length){ w.innerHTML='<span style="font-size:.8rem;color:var(--muted);">Nenhuma ficha salva.</span>'; return; }
    w.innerHTML=arr.map(f=>{
      let icon, titulo, edit, impr;
      if(f._tipo==='huol'){
        icon='<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>';
        titulo=`Vaga HUOL: ${(f.nome||'').split(' ').slice(0,2).join(' ')||'—'}`;
        edit=`_abrirHUOLExistente('${f.key}')`;
        impr=`_imprimirHUOLChave('${f.key}')`;
      } else if(f._tipo==='albumina'){
        icon='<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><ellipse cx="12" cy="12" rx="8" ry="5"/><path d="M4 12c0 3 3.6 5.5 8 5.5s8-2.5 8-5.5"/><path d="M4 12V8c0-3 3.6-5.5 8-5.5S20 5 20 8v4"/></svg>';
        titulo=`Albumina: ${(f.pac||'').split(' ').slice(0,2).join(' ')||'—'}`;
        edit=`_abrirAlbuminaExistente('${f.key}')`;
        impr=`_imprimirAlbuminaChave('${f.key}')`;
      } else if(f._tipo==='me'){
        icon='<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 13.5C8 13.5 3 12 3 8a5 5 0 0110 0c0 4-5 5.5-5 5.5z"/><path d="M8 13.5V6"/><path d="M8 9c0 0-2-1-2-3"/><path d="M8 7.5c0 0 2-1 2-3"/><circle cx="6" cy="4.5" r="1.2"/><circle cx="10" cy="4" r="1.2"/></svg>';
        titulo=`Morte Encefálica: ${(f.pac||'').split(' ').slice(0,2).join(' ')||'—'}`;
        edit=`_abrirMEExistente('${f.key}')`;
        impr=`_imprimirMEChave('${f.key}')`;
      } else if(f._tipo==='trilogy'){
        icon='<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 2v8"/><path d="M8 6C8 6 5 6 4 8s-1.5 4-1 5 2 1.5 3 1c1-.5 2-2 2-4"/><path d="M8 6c0 0 3 0 4 2s1.5 4 1 5-2 1.5-3 1-2-2-2-4"/></svg>';
        titulo=`Plano Terapêutico (Trilogy): ${(f.pac||'').split(' ').slice(0,2).join(' ')||'—'}`;
        edit=`_abrirTrilogyExistente('${f.key}')`;
        impr=`_imprimirTrilogyChave('${f.key}')`;
      } else if(f._tipo==='hemo'){
        icon='<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;color:#b91c1c;"><path d="M8 2C8 2 4 7.5 4 10a4 4 0 008 0C12 7.5 8 2 8 2z"/><path d="M6 10.5a2 2 0 002 1.5"/></svg>';
        titulo=`Hemoterápicos: ${(f.pedidos||[]).filter(p=>p.selecionado).map(p=>p.label.split(' ').slice(0,2).join(' ')).join(', ')||'—'}`;
        edit=`_abrirHemoExistente('${f.key}')`;
        impr=`_imprimirHemoChave('${f.key}')`;
      } else if(f._tipo==='termo'){
        icon='<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><rect x="3.5" y="3" width="9" height="11" rx="1.2"/><path d="M6 3V2h4v1"/><line x1="6" y1="7" x2="10" y2="7"/><line x1="6" y1="9.5" x2="10" y2="9.5"/><line x1="6" y1="12" x2="9" y2="12"/></svg>';
        const nomeTermo = f.tipo==='paliativo'?'Cuidados Paliativos':f.tipo==='traqueo'?'Autorização de Traqueostomia':'Termo';
        titulo=`Termo: ${nomeTermo}`;
        edit=`_abrirTermoExistente('${f.key}')`;
        impr=`_imprimirTermoChave('${f.key}')`;
      } else {
        icon='<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><circle cx="8" cy="8" r="4"/><circle cx="8" cy="8" r="1.5"/><line x1="8" y1="2" x2="8" y2="4"/><line x1="12.2" y1="3.8" x2="10.8" y2="5.2"/><line x1="14" y1="8" x2="12" y2="8"/><line x1="3.8" y1="3.8" x2="5.2" y2="5.2"/><line x1="2" y1="8" x2="4" y2="8"/><line x1="3.8" y1="12.2" x2="5.2" y2="10.8"/><line x1="12.2" y1="12.2" x2="10.8" y2="10.8"/></svg>';
        titulo=`ATB: ${(f.atbs||[]).map(a=>a.atb).filter(Boolean).join(', ')||'—'}`;
        edit=`_abrirFichaExistente('${f.key}')`;
        impr=`_imprimirFichaChave('${f.key}')`;
      }
      const dataf = _fmtDataCurta(f.data)||'?';
      return `<div style="border:1px solid var(--borda);border-radius:9px;padding:10px 12px;margin-bottom:6px;background:var(--bg2);display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <div style="flex:1;">
          <strong style="color:var(--vinho);">${icon} ${titulo}</strong><br>
          <span style="font-size:.74rem;color:var(--muted);">${dataf} · ${f.autorNome||f.autor||'?'}</span>
        </div>
        <div style="display:flex;gap:4px;">
          <button class="btn btn-sm" onclick="${edit}"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M11 2.5l2.5 2.5-7.5 7.5L3.5 15l2.5-2.5z"/><line x1="9.5" y1="4" x2="12" y2="6.5"/></svg> Editar</button>
          <button class="btn btn-sm" onclick="${impr}"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><rect x="3" y="6" width="10" height="7" rx="1"/><path d="M5 6V3h6v3"/><rect x="5" y="9.5" width="6" height="2.5" rx=".4"/><line x1="5" y1="7.8" x2="11" y2="7.8"/></svg> Imprimir</button>
        </div>
      </div>`;
    }).join('');
  }catch(e){ w.innerHTML='<span style="font-size:.8rem;color:var(--vermelho);">Erro ao carregar fichas.</span>'; }
}

async function _abrirFichaExistente(key){
  showLoading('Carregando ficha...');
  try{
    const f=await dbGet(key);
    hideLoading();
    if(!f){ toast('Ficha não encontrada.',true); return; }
    _fichaATBKey=key;
    _fichaATBLinhas=f.atbs||[_fatbNovaLinha('')];
    // Preenche campos
    ['pac','dn','leito','data'].forEach(c=>sf('fatb-'+c,f[c]||''));
    sf('fatb-micro-data',f.microData||''); sf('fatb-micro-mat',f.microMat||'');
    sf('fatb-micro-sens',f.microSens||''); sf('fatb-ccih-sug',f.ccihSug||'');
    sf('fatb-ccih-med',f.ccihMed||'');
    // Radios
    if(f.origem){ const r=document.querySelector(`input[name="fatb-origem"][value="${f.origem}"]`); if(r) r.checked=true; }
    if(f.uso){    const r=document.querySelector(`input[name="fatb-uso"][value="${f.uso}"]`);    if(r) r.checked=true; }
    // Checkboxes diagnósticos
    const map={bact:'bacteremia',cateter:'cateter',neutro:'neutro',itu:'itu',pneumo:'pneumo',pele:'pele',cirurg:'cirurg',sepse:'sepse',digest:'digest'};
    Object.keys(map).forEach(k=>{ const el=$('fatb-d-'+k); if(el) el.checked=(f.diagnosticos||[]).some(d=>d.toLowerCase().includes(k)); });
    _fatbRenderLinhas(); _fatbRenderCCIH();
    $('modal-atb-ficha').classList.add('show');
  }catch(e){ hideLoading(); toast('Erro: '+(e.message||e),true); }
}

/* ── Detecta ATBs novos ou com dose/freq alterada ao salvar prescrição ──── */
let _rxItensPrevios = []; // snapshot antes das edições
function _snapshotRX(){ _rxItensPrevios=_rxItens.map(i=>({farm:i.farm,dose:i.dose,freq:i.freq,_cat:i._cat,ddInicio:i.ddInicio})); }

function _detectarATBsNovos(){
  const novos=[];
  _rxItens.forEach(it=>{
    if(it._cat!=='ATB'||!it.farm) return;
    const prev=_rxItensPrevios.find(p=>p.farm===it.farm);
    if(!prev) { novos.push({...it, motivo:'novo'}); return; }
    if(prev.dose!==it.dose||prev.freq!==it.freq) novos.push({...it, motivo:'alterado'});
  });
  return novos;
}

/* ── Detecção de ATBs novos/alterados — chamada dentro de salvarPrescricao ── */

function _mostrarModalATBNovos(atbs){
  const nomes=atbs.map(a=>`${a.motivo==='novo'?'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><rect x="1.5" y="4" width="13" height="8" rx="1.5"/><path d="M5 11V5l2.5 4L10 5v6"/><line x1="6" y1="8" x2="8.5" y2="8"/></svg>':'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M11 2.5l2.5 2.5-7.5 7.5L3.5 15l2.5-2.5z"/><line x1="9.5" y1="4" x2="12" y2="6.5"/></svg>️'} ${a.farm}`).join('<br>');
  // Guarda os ATBs num campo global para evitar problemas com aspas no onclick
  window._atbsPendentes = atbs.map(a=>a.farm);
  const el=document.createElement('div');
  el.className='modal show'; el.id='modal-atb-prompt';
  el.innerHTML=`<div class="modal-box" style="max-width:480px;">
    <div class="modal-head"><h3><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><circle cx="8" cy="8" r="4"/><circle cx="8" cy="8" r="1.5"/><line x1="8" y1="2" x2="8" y2="4"/><line x1="12.2" y1="3.8" x2="10.8" y2="5.2"/><line x1="14" y1="8" x2="12" y2="8"/><line x1="3.8" y1="3.8" x2="5.2" y2="5.2"/><line x1="2" y1="8" x2="4" y2="8"/><line x1="3.8" y1="12.2" x2="5.2" y2="10.8"/><line x1="12.2" y1="12.2" x2="10.8" y2="10.8"/></svg> Ficha de Antimicrobiano</h3></div>
    <div class="modal-body">
      <div class="tip i" style="margin-bottom:12px;">
        ${atbs.length===1?'Um antimicrobiano foi':'Antimicrobianos foram'}
        ${atbs[0].motivo==='novo'?'adicionado(s)':'alterado(s)'} na prescrição:<br>
        <strong style="margin-top:6px;display:block;">${nomes}</strong>
      </div>
      <p style="font-size:.86rem;margin-bottom:14px;">Deseja preencher a ficha de solicitação de antimicrobiano agora?</p>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button class="btn btn-pri" onclick="document.getElementById('modal-atb-prompt').remove();abrirFichaATBComATBs(window._atbsPendentes||[])"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M2.5 8.5l3.5 3.5 7.5-7.5"/></svg> Sim, preencher ficha</button>
        <button class="btn" onclick="document.getElementById('modal-atb-prompt').remove()">Agora não</button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(el);
}

function abrirFichaATBComATBs(farms){
  if(!_fichaATBLinhas.length||!_fichaATBLinhas[0].atb){
    _fichaATBLinhas=farms.map(f=>_fatbNovaLinha(f));
  } else {
    // Adiciona apenas os que ainda não estão
    farms.forEach(f=>{ if(!_fichaATBLinhas.some(l=>l.atb===f)) _fichaATBLinhas.push(_fatbNovaLinha(f)); });
  }
  abrirFichaATB();
}

/* ── Impressão da ficha ─────────────────────────────────────────────── */
function imprimirFichaATB(){ _imprimirFichaObj(_coletarFichaATB()); }
async function _imprimirFichaChave(key){
  showLoading('Carregando ficha...');
  try{ const f=await dbGet(key); hideLoading(); if(f) _imprimirFichaObj(f); }
  catch(e){ hideLoading(); toast('Erro: '+(e.message||e),true); }
}

function _imprimirFichaObj(f){
  const DIAG_MAP={bact:'Bacteremia primária sem foco',cateter:'Infecção associada à cateter',neutro:'Neutropenia febril',itu:'ITU',pneumo:'Pneumonia',pele:'Pele / partes moles',cirurg:'Infecção de sítio cirúrgico',sepse:'Sepse',digest:'Trato digestivo'};
  const diagTxt=(f.diagnosticos||[]).map(d=>DIAG_MAP[d]||d).join(', ')||'—';
  const atbsHtml=(f.atbs||[]).map((a,i)=>`
    <tr>
      <td style="font-weight:700;">${(a.atb||'—').toUpperCase()}</td>
      <td>${a.via||'—'}</td>
      <td>${(a.posologia||'—').toUpperCase()}</td>
      <td>${a.ddInicio?_fmtDataCurta(a.ddInicio):'—'}</td>
      <td>${a.dias||'—'} dias</td>
    </tr>`).join('');
  const ccihHtml=(f.atbs||[]).map((a,i)=>`
    <tr>
      <td style="font-weight:700;">${(a.atb||'').toUpperCase()}</td>
      <td style="white-space:nowrap;"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><rect x="3" y="3" width="10" height="10" rx="1.5"/></svg> SIM &nbsp; <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><rect x="3" y="3" width="10" height="10" rx="1.5"/></svg> NÃO</td>
      <td style="white-space:nowrap;"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><rect x="3" y="3" width="10" height="10" rx="1.5"/></svg> SIM &nbsp; <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><rect x="3" y="3" width="10" height="10" rx="1.5"/></svg> NÃO</td>
      <td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td>
    </tr>`).join('');

  const html=`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
  <title>Ficha ATB — ${f.pac||''}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;font-family:'Arial Narrow',Arial,sans-serif;}
    @page{size:A4 portrait;margin:0.9cm 1.1cm}
    html,body{font-size:8.8pt;color:#111;padding:0;max-height:100%;overflow:hidden;}
    .logo-wrap{text-align:center;border-bottom:2px solid #7a1020;padding-bottom:5px;margin-bottom:6px;}
    .logo-wrap h1{font-size:12pt;color:#7a1020;font-weight:800;}
    .logo-wrap h2{font-size:9.5pt;font-weight:700;letter-spacing:.04em;margin-top:1px;}
    .logo-wrap p{font-size:7.5pt;color:#555;}
    .secao{margin-bottom:5px;border:1px solid #ccc;border-radius:3px;overflow:hidden;page-break-inside:avoid;}
    .secao-titulo{background:#7a1020;color:white;padding:2px 8px;font-size:7.5pt;font-weight:700;letter-spacing:.08em;text-transform:uppercase;}
    .secao-corpo{padding:5px 8px;font-size:8.5pt;line-height:1.4;}
    .grid2{display:grid;grid-template-columns:1fr 1fr;gap:5px;}
    .grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;}
    .campo{margin-bottom:2px;}
    .campo label{font-size:7pt;font-weight:700;color:#7a1020;display:block;margin-bottom:1px;text-transform:uppercase;}
    .campo .val{border-bottom:1px solid #aaa;min-height:14px;font-size:8.5pt;padding:0;}
    .diag-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:2px 8px;font-size:8pt;}
    .check-item{display:flex;align-items:center;gap:4px;}
    table{width:100%;border-collapse:collapse;font-size:8pt;}
    th{background:#7a1020;color:white;padding:2px 5px;text-align:left;font-size:7pt;font-weight:700;text-transform:uppercase;}
    td{border:1px solid #ddd;padding:2px 5px;vertical-align:middle;}
    .secao-ccih{border-color:#d0a020;}
    .secao-ccih .secao-titulo{background:#8a6a10;}
    .secao-farm{border-color:#336;}
    .secao-farm .secao-titulo{background:#223;}
    .assin{border-top:1px solid #555;margin-top:14px;text-align:center;padding-top:2px;font-size:7.5pt;color:#555;width:200px;display:inline-block;}
    .assin-wrap{margin-top:6px;text-align:right;}
    @media print{body{padding:0;}*{-webkit-print-color-adjust:exact;print-color-adjust:exact;}}
  </style></head><body>
  <div class="logo-wrap">
    <p>PREFEITURA DO NATAL · SECRETARIA MUNICIPAL DE SAÚDE</p>
    <h1>HOSPITAL DOS PESCADORES</h1>
    <h2>FICHA DE SOLICITAÇÃO DE ANTIMICROBIANO</h2>
  </div>
  <div class="secao">
    <div class="secao-titulo">Identificação</div>
    <div class="secao-corpo">
      <div class="grid2">
        <div class="campo"><label>Paciente</label><div class="val">${(f.pac||'').toUpperCase()}</div></div>
        <div class="campo"><label>Data de Nascimento</label><div class="val">${f.dn?_fmtDataCurta(f.dn):'—'}</div></div>
      </div>
      <div class="grid3">
        <div class="campo"><label>Leito</label><div class="val">${f.leito||'—'}</div></div>
        <div class="campo"><label>Data da Solicitação</label><div class="val">${f.data?_fmtDataCurta(f.data):'—'}</div></div>
        <div class="campo"><label>Hospital Dia</label><div class="val">${f.hospitalDia==='sim'?'SIM':'NÃO'}</div></div>
      </div>
    </div>
  </div>
  <div class="secao">
    <div class="secao-titulo">Infecção</div>
    <div class="secao-corpo">
      <div class="grid2" style="margin-bottom:8px;">
        <div class="campo"><label>Origem</label><div class="val">${f.origem==='comunitaria'?'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><rect x="3" y="3" width="10" height="10" rx="1.5"/><path d="M5.5 8l2 2 3-3"/></svg> Comunitária  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><rect x="3" y="3" width="10" height="10" rx="1.5"/></svg> Hospitalar':'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><rect x="3" y="3" width="10" height="10" rx="1.5"/></svg> Comunitária  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><rect x="3" y="3" width="10" height="10" rx="1.5"/><path d="M5.5 8l2 2 3-3"/></svg> Hospitalar'}</div></div>
        <div class="campo"><label>Uso</label><div class="val">${f.uso==='profilatico'?'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><rect x="3" y="3" width="10" height="10" rx="1.5"/><path d="M5.5 8l2 2 3-3"/></svg> Profilático  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><rect x="3" y="3" width="10" height="10" rx="1.5"/></svg> Terapêutico':'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><rect x="3" y="3" width="10" height="10" rx="1.5"/></svg> Profilático  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><rect x="3" y="3" width="10" height="10" rx="1.5"/><path d="M5.5 8l2 2 3-3"/></svg> Terapêutico'}</div></div>
      </div>
      <div class="campo"><label>Diagnóstico infeccioso provável</label>
        <div class="val" style="min-height:20px;">${diagTxt.toUpperCase()}</div>
      </div>
    </div>
  </div>
  <div class="secao">
    <div class="secao-titulo">Exame Microbiológico</div>
    <div class="secao-corpo">
      <div class="grid2">
        <div class="campo"><label>Data</label><div class="val">${f.microData?_fmtDataCurta(f.microData):'—'}</div></div>
        <div class="campo"><label>Material</label><div class="val">${(f.microMat||'—').toUpperCase()}</div></div>
      </div>
      <div class="campo"><label>Sensibilidade / Resultado</label><div class="val">${(f.microSens||'—').toUpperCase()}</div></div>
    </div>
  </div>
  <div class="secao">
    <div class="secao-titulo">Antimicrobiano Solicitado</div>
    <div class="secao-corpo">
      <table>
        <tr><th>Antimicrobiano</th><th>Via</th><th>Posologia</th><th>D0</th><th>Duração</th></tr>
        ${atbsHtml}
      </table>
    </div>
  </div>
  <div class="assin-wrap"><div class="assin">___________________________<br>Médico prescritor<br>${perfilUsuario&&perfilUsuario.crm?'CRM '+perfilUsuario.crm:''}</div></div>
  <div style="height:6px;"></div>
  <div class="secao secao-ccih">
    <div class="secao-titulo">Uso exclusivo da CCIH</div>
    <div class="secao-corpo">
      <table>
        <tr><th>Antimicrobiano</th><th>Autorização</th><th>Alteração</th><th>Via</th><th>Posologia sugerida</th><th>Duração</th></tr>
        ${ccihHtml}
      </table>
      <div class="campo" style="margin-top:8px;"><label>Sugestão</label><div class="val" style="min-height:20px;">${f.ccihSug||''}</div></div>
      <div class="assin-wrap"><div class="assin">___________________________<br>Médico(a) — assinatura/carimbo</div></div>
    </div>
  </div>
  <div class="secao secao-farm">
    <div class="secao-titulo">Uso pelo Farmacêutico</div>
    <div class="secao-corpo">
      <table>
        <tr><th>Antimicrobiano</th><th>Quantidade necessária</th><th>Dose/posologia sugerida</th><th>Ajuste dose renal</th></tr>
        ${(f.atbs||[]).map(a=>`<tr>
          <td style="font-weight:700;">${(a.atb||'').toUpperCase()}</td>
          <td>&nbsp;<br>&nbsp;</td><td>&nbsp;</td>
          <td><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><rect x="3" y="3" width="10" height="10" rx="1.5"/></svg> SIM  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><rect x="3" y="3" width="10" height="10" rx="1.5"/></svg> NÃO</td>
        </tr>`).join('')}
      </table>
      <div style="margin-top:10px;display:flex;justify-content:space-between;align-items:flex-end;">
        <div class="campo"><label>Recebido na farmácia</label><div class="val" style="min-width:120px;">&nbsp;</div></div>
        <div class="assin">___________________________<br>Farmacêutico(a) — assinatura/carimbo<br>Data: ___/___/______</div>
      </div>
    </div>
  </div>
  <script>window.onload=()=>{window.print();window.onafterprint=()=>window.close();}<\/script>
  </body></html>`;

  const w=window.open('','_blank','width=820,height=900');
  if(w){ w.document.write(html); w.document.close(); }
  else toast('Popup bloqueado — permita popups para imprimir.',true);
}

// D-dia automático — calcula dias desde ddInicio e guarda em it._ddia
// NÃO modifica a obs — o D aparece como badge na tela e na coluna da impressão
function _rxAtualizarDdias(){
  const hoje_ = gf('f-data')||hoje();
  _rxItens.forEach(it=>{
    if(it._cat!=='ATB') return;
    // Se ddInicio não está setado, usa a data da evolução atual
    if(!it.ddInicio) it.ddInicio = hoje_;
    const diff=Math.floor(
      (new Date(hoje_+'T00:00:00') - new Date(it.ddInicio+'T00:00:00')) / 86400000
    );
    it._ddia = diff >= 0 ? diff : 0;
  });
}


/* ════════════════════════════════════════════════════════════════════════════
   SOLICITAÇÃO DE HEMOTERÁPICOS — HEMONORTE
   Replica o modelo oficial do Hospital dos Pescadores
   ════════════════════════════════════════════════════════════════════════════ */

// IDs dos campos de hemocomponentes (id, labelImpressão)
const HEMO_COMPS = [
  ['ch',      'CONC. HEMÁCIAS'],
  ['chpl',    'CONC. HEMÁCIAS POBRE EM LEUCÓCITOS'],
  ['chl',     'CONC. HEMÁCIAS LEUCOTIZADO'],
  ['chlav',   'CONC. HEMÁCIAS LAVADAS'],
  ['plaqconv','CONCENTRADO DE PLAQUETAS CONVENCIONAIS (1UI/10KG)'],
  ['pool',    'POOL DE PLAQUETAS'],
  ['plaqaf',  'CONC. PLAQUETAS DE AFÉRESE'],
  ['pfc',     'PLASMA FRESCO CONGELADO'],
  ['crio',    'CRIOPRECIPITADO'],
  ['fat',     'CONCENTRADO DE FATOR VIII / IX'],
];

function abrirFichaHemo(){
  // Preenche dados do paciente automaticamente
  const peso = parseFloat(gf('f-peso'))||null;
  sf('fhemo-nome',  (gf('f-pac')||'').toUpperCase());
  sf('fhemo-dn',    gf('f-dn')||'');
  sf('fhemo-leito', gf('f-leito')||'');
  sf('fhemo-cns',   gf('f-cns')||'');
  sf('fhemo-data',  gf('f-data')||hoje());
  // Hora atual
  const agora = new Date();
  sf('fhemo-hora',  agora.getHours().toString().padStart(2,'0')+':'+agora.getMinutes().toString().padStart(2,'0'));
  // Diagnóstico e CID da evolução
  sf('fhemo-diag',  (gf('f-diag')||'').toUpperCase());
  sf('fhemo-cid',   (gf('f-cid')||'').toUpperCase());
  // Sexo
  const sexoEl = $('fhemo-sexo');
  if(sexoEl){
    const s=(gf('f-sexo')||'').toUpperCase();
    sexoEl.value = s.includes('FEM')?'FEMININO':s.includes('MAS')?'MASCULINO':'';
  }
  // Médico prescritor
  if(perfilUsuario){
    sf('fhemo-med', (perfilUsuario.nome||'').toUpperCase());
    sf('fhemo-crm', perfilUsuario.crm||'');
  }
  // Exames da última linha lab
  _hemoAutoExames();
  // Sugestão de plaquetas por peso
  if(peso){
    const ui = Math.round(peso/10);
    sf('fhemo-plaqconv-qtd', ui+' UNIDADES');
  }
  $('modal-hemo-ficha').classList.add('show');
  _buscarCartaoSUSAuto();
}

/* ────────────────────────────────────────────────────────────────────────────
   CARTÃO SUS — busca automática no Drive (subpasta do paciente) e extrai
   dados (nome da mãe, endereço, CNS, DN, sexo, naturalidade) para a ficha
   de hemoterápicos. O PDF é guardado em base64 para mesclar na impressão.
   ──────────────────────────────────────────────────────────────────────── */
function _normalizarNome(s){
  return (s||'').toString().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/\s+/g,' ').trim();
}

async function _buscarCartaoSUSAuto(){
  _cartaoSUSPDF = null;
  _cartaoSUSStatus = '';
  _atualizarStatusCartaoSUS('');
  if(!APPS_SCRIPT_URL || !CARTAO_SUS_FOLDER_ID) return;
  const nome = (gf('fhemo-nome')||gf('f-pac')||'').trim();
  const cns  = (gf('fhemo-cns') ||gf('f-cns') ||'').replace(/\D/g,'');
  if(!nome && !cns) return;
  _atualizarStatusCartaoSUS('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M4 2h8M4 14h8"/><path d="M5 2v3l3 3-3 3v3"/><path d="M11 2v3L8 8l3 3v3"/></svg> Buscando cartão SUS no Drive...');
  try{
    const r = await _apsFetch({
      action: 'cartao_sus',
      pacienteNome: _normalizarNome(nome),
      cns,
      folderId: CARTAO_SUS_FOLDER_ID
    });
    if(r.status === 'ok' && r.dados){
      const d = r.dados;
      const fill = (id,val) => { const el=$(id); if(el && val && !el.value) el.value = String(val).toUpperCase(); };
      fill('fhemo-mae',  d.mae);
      fill('fhemo-end',  d.end);
      fill('fhemo-cns',  d.cns);
      fill('fhemo-natur',d.natur);
      const dnEl = $('fhemo-dn');     if(dnEl && d.dn && !dnEl.value) dnEl.value = d.dn;
      const sxEl = $('fhemo-sexo');
      if(sxEl && d.sexo && !sxEl.value){
        sxEl.value = d.sexo === 'F' ? 'FEMININO' : d.sexo === 'M' ? 'MASCULINO' : '';
      }
      _cartaoSUSPDF = r.pdfBase64 || null;
      _cartaoSUSStatus = 'ok';
      _atualizarStatusCartaoSUS('<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M2.5 8.5l3.5 3.5 7.5-7.5"/></svg> Cartão SUS encontrado — será impresso junto');
    } else if(r.status === 'nao_encontrado'){
      _cartaoSUSStatus = 'sem_pasta';
      _atualizarStatusCartaoSUS('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> Subpasta do paciente não encontrada no Drive');
    } else if(r.status === 'nao_encontrado_cartao'){
      _cartaoSUSStatus = 'sem_cartao';
      _atualizarStatusCartaoSUS('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> Pasta encontrada, mas sem PDF do Cartão SUS');
    } else {
      _cartaoSUSStatus = 'erro';
      _atualizarStatusCartaoSUS('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> ' + (r.msg||'Erro ao buscar cartão SUS'));
    }
  } catch(e){
    console.warn('[Cartão SUS]', e);
    _atualizarStatusCartaoSUS('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M8 3L1.5 13.5h13L8 3z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/></svg> Falha na busca (sem conexão?)');
  }
}

function _atualizarStatusCartaoSUS(msg){
  const el = $('hemo-cartao-status');
  if(!el) return;
  if(!msg){ el.style.display='none'; el.innerHTML=''; return; }
  el.style.display=''; el.innerHTML = msg;
  // Cor baseada no status: verde=encontrado, cinza=buscando, laranja=aviso/erro
  const txt = el.textContent || '';
  el.style.color = txt.includes('encontrado') ? '#0a6b3a'
                 : txt.includes('Buscando')   ? '#666'
                 : '#a35200';
}

/* ════════════════════════════════════════════════════════════════════════════
   SOLICITAÇÃO DE ALBUMINA ENDOVENOSA
   SMS · Departamento de Logística e Suporte Imediato aos Serviços de Saúde
   ════════════════════════════════════════════════════════════════════════════ */

function abrirFichaAlbumina(dadosExistentes){
  const f = dadosExistentes || {};
  // Dados do paciente
  sf('falb-pac',      f.pac  || (gf('f-pac')||'').toUpperCase());
  sf('falb-leito',    f.leito|| (gf('f-leito')||'').toUpperCase());
  sf('falb-diag',     f.diag || (gf('f-diag')||'').toUpperCase());
  sf('falb-data',     f.data || hoje());
  // Idade calculada da DN
  const dnStr = f.dn || gf('f-dn') || '';
  if(dnStr){
    const dn = new Date(dnStr+'T00:00:00');
    const anos = Math.floor((new Date() - dn) / (365.25*24*3600*1000));
    sf('falb-idade', f.idade || (anos>0?anos+' anos':''));
  } else {
    sf('falb-idade', f.idade||'');
  }
  const peso = f.peso || gf('f-peso') || '';
  sf('falb-peso', peso ? peso+' kg' : '');
  // Posologia — pré-preenche se veio da prescrição
  sf('falb-posologia', f.posologia||'');
  sf('falb-tempo',     f.tempo||'');
  sf('falb-dosagem',   f.dosagem||'ALBUMINA HUMANA 20%');
  sf('falb-qtd',       f.qtd||'');
  // Indicações
  $('falb-ind-ascite').checked      = !!(f.indAscite);
  $('falb-ind-plasmaferese').checked= !!(f.indPlasmaferese);
  $('falb-ind-shr').checked         = !!(f.indSHR);
  $('falb-ind-outra').checked       = !!(f.indOutra);
  sf('falb-ind-outra-txt', f.indOutraTxt||'');
  sf('falb-justif', f.justif||'');
  $('modal-albumina-ficha')._chaveEditar = f._chave||null;
  $('modal-albumina-ficha').classList.add('show');
}

function fecharFichaAlbumina(){
  $('modal-albumina-ficha').classList.remove('show');
}

function _coletarFichaAlbumina(){
  return {
    pac:       (gf('falb-pac')||'').toUpperCase(),
    leito:     (gf('falb-leito')||'').toUpperCase(),
    diag:      (gf('falb-diag')||'').toUpperCase(),
    idade:     gf('falb-idade')||'',
    peso:      gf('falb-peso')||'',
    data:      gf('falb-data')||'',
    posologia: (gf('falb-posologia')||'').toUpperCase(),
    tempo:     (gf('falb-tempo')||'').toUpperCase(),
    dosagem:   (gf('falb-dosagem')||'').toUpperCase(),
    qtd:       (gf('falb-qtd')||'').toUpperCase(),
    indAscite:       $('falb-ind-ascite').checked,
    indPlasmaferese: $('falb-ind-plasmaferese').checked,
    indSHR:          $('falb-ind-shr').checked,
    indOutra:        $('falb-ind-outra').checked,
    indOutraTxt:     (gf('falb-ind-outra-txt')||'').toUpperCase(),
    justif:    (gf('falb-justif')||'').toUpperCase(),
    autor:     usuarioEmail,
    autorNome: perfilUsuario?perfilUsuario.nome:'',
    salvadoEm: new Date().toISOString(),
    tipo:      'albumina'
  };
}

async function salvarFichaAlbumina(){
  if(!leitoAtual){ toast('Abra o prontuário de um paciente.',true); return; }
  const f = _coletarFichaAlbumina();
  if(!f.pac){ toast('Informe o nome do paciente.',true); return; }
  showLoading('Salvando ficha...');
  try{
    const chave = $('modal-albumina-ficha')._chaveEditar
      || `uti_med_albumina_${leitoAtual}_${f.data}_${Date.now()}`;
    await dbSet(chave, f);
    hideLoading();
    toast('✓ Ficha de albumina salva.');
  }catch(e){ hideLoading(); toast('Erro: '+(e.message||e),true); }
}

async function _abrirAlbuminaExistente(key){
  showLoading('Carregando ficha...');
  try{
    const f = await dbGet(key);
    hideLoading();
    if(!f){ toast('Ficha não encontrada.',true); return; }
    f._chave = key;
    abrirFichaAlbumina(f);
  }catch(e){ hideLoading(); toast('Erro: '+(e.message||e),true); }
}

async function _imprimirAlbuminaChave(key){
  showLoading('Carregando ficha...');
  try{
    const f = await dbGet(key);
    hideLoading();
    if(!f){ toast('Ficha não encontrada.',true); return; }
    _imprimirAlbuminaHTML(f);
  }catch(e){ hideLoading(); toast('Erro: '+(e.message||e),true); }
}

function imprimirFichaAlbumina(){
  _imprimirAlbuminaHTML(_coletarFichaAlbumina());
}

function _imprimirAlbuminaHTML(f){
  const chk = (v) => v ? '(X)' : '( )';
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <title>Solicitação de Albumina</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:Arial,Helvetica,sans-serif;font-size:9.5pt;color:#000;padding:12mm 14mm;}
    .cabecalho{text-align:center;border-bottom:2px solid #000;padding-bottom:8px;margin-bottom:12px;}
    .inst{font-size:7.5pt;text-transform:uppercase;letter-spacing:.04em;}
    .titulo{font-size:11pt;font-weight:800;margin:4px 0 2px;}
    table.grade{width:100%;border-collapse:collapse;margin-bottom:10px;}
    table.grade td{border:1px solid #000;padding:4px 6px;font-size:8.5pt;vertical-align:top;}
    .label{font-weight:700;font-size:7.5pt;}
    .secao-t{font-size:8pt;font-weight:800;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #000;margin:10px 0 6px;padding-bottom:2px;}
    .indicacoes{border:1px solid #000;padding:8px 10px;margin-bottom:10px;}
    .ind-item{margin-bottom:5px;font-size:9pt;}
    .justif-box{border:1px solid #000;min-height:60px;padding:6px 8px;font-size:9pt;margin-bottom:10px;white-space:pre-wrap;}
    .assin{border-top:1px solid #000;width:220px;text-align:center;padding-top:3px;font-size:8pt;display:inline-block;margin-top:20px;}
    .assin-wrap{display:flex;gap:40px;justify-content:flex-start;margin-top:14px;}
    @media print{body{margin:0;padding:10mm 12mm;}}
  </style></head><body>
  <div class="cabecalho">
    <div class="inst">Secretaria Municipal de Saúde · Departamento de Logística e Suporte Imediato aos Serviços de Saúde – DLS</div>
    <div class="titulo">IMPRESSO DE SOLICITAÇÃO DE ALBUMINA ENDOVENOSA</div>
  </div>
  <table class="grade">
    <tr>
      <td colspan="3"><span class="label">PACIENTE: </span>${f.pac||''}</td>
      <td><span class="label">IDADE: </span>${f.idade||''}</td>
      <td><span class="label">PESO: </span>${f.peso||''}</td>
      <td><span class="label">SETOR/LEITO: </span>${f.leito||''}</td>
    </tr>
    <tr><td colspan="6"><span class="label">DIAGNÓSTICO: </span>${f.diag||''}</td></tr>
    <tr>
      <td colspan="2"><span class="label">POSOLOGIA: </span>${f.posologia||'........................................'}</td>
      <td colspan="2"><span class="label">TEMPO DE TRATAMENTO: </span>${f.tempo||'.........................'}</td>
      <td><span class="label">DOSAGEM: </span>${f.dosagem||'.....................'}</td>
      <td><span class="label">DATA: </span>${f.data?_fmtDataCurta(f.data):''}</td>
    </tr>
    <tr><td colspan="6"><span class="label">QUANTIDADE: </span>${f.qtd||'........................................'}</td></tr>
  </table>
  <div class="secao-t">Indicação para uso de albumina</div>
  <div class="indicacoes">
    <div class="ind-item">${chk(f.indAscite)} Tratamento da ascite volumosa com paracenteses repetidas</div>
    <div class="ind-item">${chk(f.indPlasmaferese)} Reposição volêmica em plasmaferese</div>
    <div class="ind-item">${chk(f.indSHR)} Síndrome hepatorrenal</div>
    <div class="ind-item">${chk(f.indOutra)} Outra: ${f.indOutraTxt||'...........................................................................'}</div>
  </div>
  <div class="secao-t">Justificativa</div>
  <div class="justif-box">${f.justif||'\n\n\n'}</div>
  <div class="assin-wrap">
    <div><div class="assin">Assinatura e carimbo do Médico solicitante</div></div>
    <div><div class="assin">Assinatura e carimbo do Farmacêutico</div></div>
    <div><div class="assin">Assinatura e carimbo do Auditor/Fornecedor</div></div>
  </div>
  <script>window.onload=()=>{ window.print(); }<\/script>
  </body></html>`;
  const w = window.open('','_blank','width=860,height=700');
  if(w){ w.document.write(html); w.document.close(); }
  else toast('Popup bloqueado — permita popups para imprimir.',true);
}

/* ════════════════════════════════════════════════════════════════════════════
   FICHA: SOLICITAÇÃO DE VAGA — HUOL (NIR)
   ─ Auto-preenche com dados já registrados no prontuário; sinais vitais e
     campos de avaliação livre (motivo, procedimento, exames) ficam em branco
     para preenchimento manual no momento da solicitação.
   ════════════════════════════════════════════════════════════════════════════ */
function _huolMontarEvolucaoAtual(){
  const partes=[];
  const evol=(gf('f-evol')||'').trim();
  if(evol) partes.push(evol);
  const vent=$('f-vent')?$('f-vent').value:'';
  const ventLabel={
    AA:'Ar ambiente', CN:'Cateter nasal de O₂', CTNO2:'Cateter de alto fluxo (CTNO2)',
    VM:'Máscara de O₂/Venturi', VNI:'VNI (BiPAP/CPAP)', VMI:'Ventilação mecânica invasiva (TOT/TQT)'
  }[vent]||'';
  const ventParam=(gf('f-vent-param')||'').trim();
  if(ventLabel && vent!=='AA') partes.push(`Suporte ventilatório: ${ventLabel}${ventParam?' ('+ventParam+')':''}.`);
  const acessos=(gf('f-acessos')||'').trim();
  if(acessos) partes.push(`Acessos: ${acessos}.`);
  const disp=(gf('f-dispositivos')||'').trim();
  if(disp) partes.push(`Dispositivos: ${disp}.`);
  const dva=$('f-dva')?$('f-dva').value:'';
  const dvaQual=(gf('f-dva-qual')||'').trim();
  if(dva && dva!=='NAO') partes.push(`Droga vasoativa: ${dvaQual||'sim'}.`);
  return partes.join(' ');
}

function _huolMontarCulturas(){
  if(!_culturasForm||!_culturasForm.length) return '';
  return _culturasForm
    .filter(c=>c.micro||c.resultado)
    .map(c=>{
      const nome=c.micro||c.resultado||'?';
      const sitio=c.sitio?` (${c.sitio})`:'';
      const dataf=c.data?' — '+_fmtDataCurta(c.data):'';
      const sens=c.sens?`: ${c.sens.slice(0,80)}`:'';
      return `${nome}${sitio}${dataf}${sens}`;
    }).join('\n');
}

function abrirFichaHUOL(dadosExistentes){
  const f = dadosExistentes || {};
  sf('fhuol-nome',  f.nome  || (gf('f-pac')||'').toUpperCase());
  // Idade calculada da DN
  const dnStr = f.dn || gf('f-dn') || '';
  if(dnStr){
    const a=_idadeDeDN(dnStr);
    sf('fhuol-idade', f.idade || (a!=null? a+' anos':''));
  } else {
    sf('fhuol-idade', f.idade||'');
  }
  sf('fhuol-cpf',        f.cpf||'');
  sf('fhuol-data-entr',  f.dataEntr || gf('f-adm') || '');
  sf('fhuol-unid-solic', f.unidSolic || 'HOSPESC — UTI ADULTO');
  sf('fhuol-tel-unid',   f.telUnid   || '');
  sf('fhuol-especialidade', f.especialidade || 'UTI ADULTO / INTENSIVISTA');
  const diagAtual=(gf('f-diag')||'').trim();
  const cidAtual=(gf('f-cid')||'').trim();
  sf('fhuol-suspeita', f.suspeita || (diagAtual?diagAtual+(cidAtual?' (CID '+cidAtual+')':''):''));
  sf('fhuol-procedimento', f.procedimento||'');
  sf('fhuol-motivo',       f.motivo||'');
  sf('fhuol-resumo',       f.resumo || (gf('f-hda')||''));
  sf('fhuol-evolucao',     f.evolucao || (dadosExistentes? (f.evolucao||'') : _huolMontarEvolucaoAtual()));
  // Sinais vitais — sempre em branco para preenchimento manual no momento da solicitação
  sf('fhuol-pa',   f.pa||'');
  sf('fhuol-fc',   f.fc||'');
  sf('fhuol-temp', f.temp||'');
  sf('fhuol-fr',   f.fr||'');
  sf('fhuol-spo2', f.spo2||'');
  sf('fhuol-glasgow', f.glasgow||'');
  sf('fhuol-hgt',  f.hgt||'');
  sf('fhuol-exames', f.exames||'');
  sf('fhuol-tratamento', f.tratamento||'');
  sf('fhuol-atb', f.atb || (gf('f-atb')||''));
  const isol = f.isolamento||'';
  document.querySelectorAll('input[name="fhuol-isol"]').forEach(r=>r.checked=(r.value===isol));
  sf('fhuol-isol-tipo', f.isolTipo||'');
  sf('fhuol-culturas', f.culturas || (dadosExistentes? (f.culturas||'') : _huolMontarCulturas()));
  sf('fhuol-medico', f.medico || (perfilUsuario?perfilUsuario.nome:'') || '');
  $('modal-huol-ficha')._chaveEditar = f._chave||null;
  $('modal-huol-ficha').classList.add('show');
  _resizeModalTextareas('modal-huol-ficha');
  _ativarAutoResizeHUOL();
}

// Ajusta a altura dos textareas da ficha HUOL conforme o conteúdo digitado
// (sem forçar caixa alta — alguns campos do HUOL mantêm digitação livre).
function _ativarAutoResizeHUOL(){
  document.querySelectorAll('#modal-huol-ficha textarea').forEach(el=>{
    if(el.dataset.autoResizeBound) return;
    el.dataset.autoResizeBound='1';
    el.addEventListener('input',()=>_autoResizeTA(el));
  });
}

function fecharFichaHUOL(){
  $('modal-huol-ficha').classList.remove('show');
}

function _huolReautoPreencher(){
  sf('fhuol-evolucao', _huolMontarEvolucaoAtual());
  sf('fhuol-culturas', _huolMontarCulturas());
  sf('fhuol-atb', gf('f-atb')||'');
  sf('fhuol-resumo', gf('f-hda')||'');
  toast('✓ Campos atualizados a partir do prontuário.');
}

function _coletarFichaHUOL(){
  const isolEl=document.querySelector('input[name="fhuol-isol"]:checked');
  return {
    nome:        (gf('fhuol-nome')||'').toUpperCase(),
    idade:       gf('fhuol-idade')||'',
    cpf:         gf('fhuol-cpf')||'',
    dataEntr:    gf('fhuol-data-entr')||'',
    unidSolic:   (gf('fhuol-unid-solic')||'').toUpperCase(),
    telUnid:     gf('fhuol-tel-unid')||'',
    especialidade: (gf('fhuol-especialidade')||'').toUpperCase(),
    suspeita:    (gf('fhuol-suspeita')||'').toUpperCase(),
    procedimento:(gf('fhuol-procedimento')||'').toUpperCase(),
    motivo:      (gf('fhuol-motivo')||'').toUpperCase(),
    resumo:      gf('fhuol-resumo')||'',
    evolucao:    gf('fhuol-evolucao')||'',
    pa:    gf('fhuol-pa')||'',
    fc:    gf('fhuol-fc')||'',
    temp:  gf('fhuol-temp')||'',
    fr:    gf('fhuol-fr')||'',
    spo2:  gf('fhuol-spo2')||'',
    glasgow: gf('fhuol-glasgow')||'',
    hgt:   gf('fhuol-hgt')||'',
    exames:      gf('fhuol-exames')||'',
    tratamento:  gf('fhuol-tratamento')||'',
    atb:         (gf('fhuol-atb')||'').toUpperCase(),
    isolamento:  isolEl?isolEl.value:'',
    isolTipo:    (gf('fhuol-isol-tipo')||'').toUpperCase(),
    culturas:    gf('fhuol-culturas')||'',
    medico:      (gf('fhuol-medico')||'').toUpperCase(),
    data:        hoje(),
    autor:usuarioEmail, autorNome:perfilUsuario?perfilUsuario.nome:'',
    salvadoEm: new Date().toISOString(),
    tipo:'huol'
  };
}

async function salvarFichaHUOL(){
  if(!leitoAtual){ toast('Abra o prontuário de um paciente.',true); return; }
  const f=_coletarFichaHUOL();
  if(!f.nome){ toast('Informe o nome do paciente.',true); return; }
  showLoading('Salvando ficha...');
  try{
    const chave = $('modal-huol-ficha')._chaveEditar
      || `uti_med_huol_${leitoAtual}_${f.data}_${Date.now()}`;
    await dbSet(chave, f);
    hideLoading();
    toast('✓ Solicitação de vaga HUOL salva.');
    _renderGuiasFichas();
  }catch(e){ hideLoading(); toast('Erro: '+(e.message||e),true); }
}

async function _abrirHUOLExistente(key){
  showLoading('Carregando ficha...');
  try{
    const f=await dbGet(key);
    hideLoading();
    if(!f){ toast('Ficha não encontrada.',true); return; }
    f._chave=key;
    abrirFichaHUOL(f);
  }catch(e){ hideLoading(); toast('Erro: '+(e.message||e),true); }
}

async function _imprimirHUOLChave(key){
  showLoading('Carregando ficha...');
  try{
    const f=await dbGet(key);
    hideLoading();
    if(!f){ toast('Ficha não encontrada.',true); return; }
    _imprimirHUOLHTML(f);
  }catch(e){ hideLoading(); toast('Erro: '+(e.message||e),true); }
}

function imprimirFichaHUOL(){
  _imprimirHUOLHTML(_coletarFichaHUOL());
}

function _imprimirHUOLHTML(f){
  const chk=(v,val)=> v===val ? '(X)' : '( )';
  const nl2br = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/\n/g,'<br>');
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <title>Solicitação de Vaga — HUOL</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:Arial,Helvetica,sans-serif;font-size:9pt;color:#000;padding:10mm 12mm;}
    .cabecalho{text-align:center;border-bottom:2px solid #000;padding-bottom:6px;margin-bottom:10px;}
    .inst{font-size:8pt;font-weight:700;}
    .inst2{font-size:7.5pt;}
    .titulo{font-size:10.5pt;font-weight:800;margin:5px 0 2px;text-transform:uppercase;}
    .contato{font-size:7pt;color:#333;margin-top:2px;}
    table.grade{width:100%;border-collapse:collapse;margin-bottom:8px;}
    table.grade td{border:1px solid #000;padding:3px 6px;font-size:8.5pt;vertical-align:top;}
    .label{font-weight:700;font-size:7.3pt;display:block;}
    .secao-t{font-size:7.8pt;font-weight:800;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid #000;margin:8px 0 4px;padding-bottom:2px;}
    .box{border:1px solid #000;min-height:34px;padding:5px 7px;font-size:8.8pt;margin-bottom:8px;white-space:pre-wrap;}
    .box-sm{min-height:18px;}
    .vitais td{text-align:center;}
    .assin{border-top:1px solid #000;width:260px;text-align:center;padding-top:3px;font-size:8pt;display:inline-block;margin-top:24px;}
    @media print{body{margin:0;padding:8mm 10mm;}}
  </style></head><body>
  <div class="cabecalho">
    <div class="inst">EMPRESA BRASILEIRA DE SERVIÇOS HOSPITALARES</div>
    <div class="inst">HOSPITAL UNIVERSITÁRIO ONOFRE LOPES</div>
    <div class="inst2">SETOR DE REGULAÇÃO E AVALIAÇÃO EM SAÚDE — NÚCLEO INTERNO DE REGULAÇÃO</div>
    <div class="titulo">Solicitação de Vaga para Internamento no HUOL</div>
    <div class="contato">E-mail NIR/HUOL: nir.huol@ebserh.gov.br &nbsp;·&nbsp; Telefone NIR/HUOL: (84) 3342-5144</div>
  </div>

  <table class="grade">
    <tr>
      <td colspan="3"><span class="label">NOME</span>${f.nome||''}</td>
      <td><span class="label">IDADE</span>${f.idade||''}</td>
    </tr>
    <tr>
      <td colspan="2"><span class="label">CPF</span>${f.cpf||''}</td>
      <td colspan="2"><span class="label">DATA DE ENTRADA</span>${f.dataEntr?_fmtDataCurta(f.dataEntr):''}</td>
    </tr>
    <tr>
      <td colspan="2"><span class="label">UNIDADE SOLICITANTE</span>${f.unidSolic||''}</td>
      <td colspan="2"><span class="label">TELEFONE UNIDADE</span>${f.telUnid||''}</td>
    </tr>
    <tr><td colspan="4"><span class="label">ESPECIALIDADE</span>${f.especialidade||''}</td></tr>
  </table>

  <div class="secao-t">Suspeita diagnóstica</div>
  <div class="box box-sm">${nl2br(f.suspeita)}</div>

  <div class="secao-t">Procedimento/tratamento pretendido</div>
  <div class="box box-sm">${nl2br(f.procedimento)}</div>

  <div class="secao-t">Motivo da solicitação de transferência</div>
  <div class="box box-sm">${nl2br(f.motivo)}</div>

  <div class="secao-t">Resumo do quadro clínico / histórico</div>
  <div class="box">${nl2br(f.resumo)}</div>

  <div class="secao-t">Evolução clínica atual</div>
  <div class="box">${nl2br(f.evolucao)}</div>

  <table class="grade vitais">
    <tr>
      <td><span class="label">PA</span>${f.pa||''}</td>
      <td><span class="label">FC</span>${f.fc||''}</td>
      <td><span class="label">T (°C)</span>${f.temp||''}</td>
      <td><span class="label">FR</span>${f.fr||''}</td>
      <td><span class="label">SpO₂</span>${f.spo2||''}</td>
      <td><span class="label">Glasgow</span>${f.glasgow||''}</td>
      <td><span class="label">HGT</span>${f.hgt||''}</td>
    </tr>
  </table>

  <div class="secao-t">Exames realizados (laboratoriais/imagem — anexar resultado)</div>
  <div class="box box-sm">${nl2br(f.exames)}</div>

  <div class="secao-t">Tratamento realizado</div>
  <div class="box box-sm">${nl2br(f.tratamento)}</div>

  <table class="grade">
    <tr><td><span class="label">ANTIBIÓTICOS EM USO</span>${f.atb||''}</td></tr>
  </table>

  <table class="grade">
    <tr>
      <td style="width:55%;"><span class="label">NECESSITA DE ISOLAMENTO?</span>${chk(f.isolamento,'sim')} Sim &nbsp;&nbsp; ${chk(f.isolamento,'nao')} Não</td>
      <td><span class="label">Tipo</span>${f.isolTipo||''}</td>
    </tr>
  </table>

  <div class="secao-t">Resultado de culturas (anexar resultado)</div>
  <div class="box">${nl2br(f.culturas)}</div>

  <div style="margin-top:18px;">
    <div class="assin">Médico responsável pela solicitação${f.medico?' — '+f.medico:''}</div>
  </div>
  <script>window.onload=()=>{ window.print(); }<\/script>
  </body></html>`;
  const w = window.open('','_blank','width=860,height=760');
  if(w){ w.document.write(html); w.document.close(); }
  else toast('Popup bloqueado — permita popups para imprimir.',true);
}

async function rebuscarCartaoSUS(){ await _buscarCartaoSUSAuto(); }

function fecharFichaHemo(){ $('modal-hemo-ficha').classList.remove('show'); }

// Preenche Hb, Ht e plaquetas do último lab
function _hemoAutoExames(){
  if(!_labLinhas||!_labLinhas.length) return;
  const ord=[..._labLinhas].filter(l=>l.data).sort((a,b)=>(a.data||'').localeCompare(b.data||''));
  const ult = ord[ord.length-1];
  if(!ult||!ult.valores) return;
  if(ult.valores.hb)  sf('fhemo-hb',  ult.valores.hb);
  if(ult.valores.ht)  sf('fhemo-htc', ult.valores.ht);
  if(ult.valores.plaq) sf('fhemo-plaq', ult.valores.plaq);
}

function _coletarFichaHemo(){
  const prio = document.querySelector('input[name="fhemo-prio"]:checked');
  const transf = document.querySelector('input[name="fhemo-transf"]:checked');
  const reac   = document.querySelector('input[name="fhemo-reac"]:checked');
  const pedidos = HEMO_COMPS.map(([id, label])=>({
    id, label,
    selecionado: $('fhemo-'+id)&&$('fhemo-'+id).checked,
    qtd: gf('fhemo-'+id+'-qtd')||''
  }));
  const outrosSel = $('fhemo-outros')&&$('fhemo-outros').checked;
  if(outrosSel) pedidos.push({id:'outros', label:'OUTROS', selecionado:true, qtd:gf('fhemo-outros-txt')||''});
  return {
    nome:gf('fhemo-nome'), sexo:gf('fhemo-sexo'), mae:gf('fhemo-mae'),
    dn:gf('fhemo-dn'), cns:gf('fhemo-cns'), natur:gf('fhemo-natur'),
    end:gf('fhemo-end'), hosp:gf('fhemo-hosp'), diag:gf('fhemo-diag'),
    cid:gf('fhemo-cid'), reg:gf('fhemo-reg'), conv:gf('fhemo-conv'),
    leito:gf('fhemo-leito'), grupo:gf('fhemo-grupo'), rh:gf('fhemo-rh'),
    jaTransfundido:transf?transf.value:'nao', houvReacao:reac?reac.value:'nao',
    hb:gf('fhemo-hb'), htc:gf('fhemo-htc'), plaq:gf('fhemo-plaq'),
    outrosExam:gf('fhemo-outros-exam'),
    prioridade:prio?prio.value:'urgencia', preop:$('fhemo-preop')&&$('fhemo-preop').checked,
    justif:gf('fhemo-justif'),
    pedidos, data:gf('fhemo-data'), hora:gf('fhemo-hora'),
    med:gf('fhemo-med'), crm:gf('fhemo-crm'),
    autor:usuarioEmail, autorNome:perfilUsuario?perfilUsuario.nome:'',
    salvadoEm:new Date().toISOString(), tipo:'hemo'
  };
}

async function salvarFichaHemo(){
  if(!leitoAtual){ toast('Abra o prontuário de um paciente.',true); return; }
  showLoading('Salvando ficha...');
  try{
    const f=_coletarFichaHemo();
    const key=`uti_med_hemo_ficha_${leitoAtual}_${f.data}_${Date.now()}`;
    await dbSet(key,f);
    hideLoading(); toast('<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M2.5 8.5l3.5 3.5 7.5-7.5"/></svg> Ficha de hemoterápicos salva.');
    _renderGuiasFichas();
  }catch(e){ hideLoading(); toast('Erro: '+(e.message||e),true); }
}

function imprimirFichaHemo(){ _imprimirFichaHemoObj(_coletarFichaHemo()); }

function _imprimirFichaHemoObj(f){
  const prio = f.prioridade==='emergencia'?'EMERGÊNCIA':f.prioridade==='rotina'?'ROTINA':'URGÊNCIA';
  const prioMarca = {
    urgencia:   ['(X)','( )','( )'],
    emergencia: ['( )','(X)','( )'],
    rotina:     ['( )','( )','(X)'],
  }[f.prioridade]||['(X)','( )','( )'];

  const pedidosHtml = HEMO_COMPS.map(([id, label])=>{
    const p=f.pedidos.find(x=>x.id===id)||{};
    const marca = p.selecionado ? '( X )' : '(  )';
    return `<tr>
      <td style="padding:3px 6px;">${marca} ${label}</td>
      <td style="padding:3px 6px;font-weight:700;text-align:right;">${p.selecionado&&p.qtd?p.qtd.toUpperCase():''}</td>
    </tr>`;
  }).join('');
  const outro=f.pedidos.find(x=>x.id==='outros');
  const outroHtml=`<tr>
    <td style="padding:3px 6px;">${outro&&outro.selecionado?'( X )':'(  )'} OUTROS${outro&&outro.qtd?' — '+outro.qtd:''}</td>
    <td></td>
  </tr>`;

  const plaqconv = f.pedidos.find(x=>x.id==='plaqconv')||{};
  const pfc      = f.pedidos.find(x=>x.id==='pfc')||{};
  const crio     = f.pedidos.find(x=>x.id==='crio')||{};
  const ch       = f.pedidos.find(x=>x.id==='ch')||{};

  const html=`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
  <title>Solicitação Hemoterápicos — ${f.nome||''}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;font-family:'Arial Narrow',Arial,sans-serif;font-size:9pt;}
    @page{size:A4 portrait;margin:1cm 1.2cm}
    body{color:#000;}
    .topo{display:flex;justify-content:space-between;align-items:center;border:1.5px solid #000;padding:6px 10px;margin-bottom:0;}
    .topo-logo{display:flex;align-items:center;gap:8px;}
    .topo-logo .sangue{font-size:1.6rem;color:#c00;}
    .topo-logo .hemo{font-size:11pt;font-weight:800;color:#c00;letter-spacing:.04em;}
    table.principal{width:100%;border-collapse:collapse;border:1.5px solid #000;}
    table.principal td, table.principal th{border:1px solid #000;padding:3px 6px;vertical-align:middle;}
    .titulo-central{text-align:center;font-weight:800;font-size:11pt;letter-spacing:.06em;padding:6px!important;}
    .label-cel{font-weight:700;font-size:7.5pt;color:#000;}
    .val-cel{font-size:9pt;font-weight:700;}
    .pedido-table{width:100%;border-collapse:collapse;}
    .pedido-table td{border:1px solid #000;vertical-align:top;}
    .th-pedido{background:#000;color:white;text-align:center;font-weight:800;font-size:9pt;padding:3px 6px;}
    .nota-final{font-size:7pt;padding:4px 6px;border:1px solid #000;border-top:none;font-style:italic;}
    .sep{border-top:3px dashed #000;margin:10px 0;}
    .comp-titulo{text-align:center;font-weight:800;font-size:10pt;padding:5px;border:1.5px solid #000;border-bottom:none;}
    .assin-linha{border-top:1px solid #000;display:inline-block;min-width:200px;text-align:center;padding-top:2px;font-size:8pt;}
    @media print{body{margin:0;}}
  </style></head><body>

  <!-- CABEÇALHO HEMONORTE -->
  <div class="topo">
    <div class="topo-logo">
      <div class="sangue"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;color:#b91c1c;"><path d="M8 2C8 2 4 7.5 4 10a4 4 0 008 0C12 7.5 8 2 8 2z"/><path d="M6 10.5a2 2 0 002 1.5"/></svg></div>
      <div><div class="hemo">HEMONORTE</div><div style="font-size:7pt;color:#555;">Centro de Hematologia e Hemoterapia do RN</div></div>
    </div>
    <div style="text-align:right;font-size:8pt;"></div>
  </div>

  <!-- TABELA PRINCIPAL -->
  <table class="principal">
    <tr><td colspan="6" class="titulo-central">SOLICITAÇÃO DE HEMOTERÁPICOS</td></tr>
    <tr>
      <td colspan="4"><span class="label-cel">NOME: </span><span class="val-cel">${(f.nome||'').toUpperCase()}</span></td>
      <td colspan="2"><span class="label-cel">SEXO: </span>${(f.sexo||'').toUpperCase()}</td>
    </tr>
    <tr>
      <td colspan="6"><span class="label-cel">NOME DA MÃE: </span>${(f.mae||'').toUpperCase()}</td>
    </tr>
    <tr>
      <td colspan="2"><span class="label-cel">DATA DE NASC: </span>${f.dn?_fmtDataCurta(f.dn):'________'}</td>
      <td colspan="2"><span class="label-cel">Nº CARTÃO SUS: </span><strong>${f.cns||''}</strong></td>
      <td colspan="2"><span class="label-cel">NATURALIDADE: </span>${(f.natur||'NATAL - RN').toUpperCase()}</td>
    </tr>
    <tr>
      <td colspan="6"><span class="label-cel">ENDEREÇO DO PACIENTE: </span>${(f.end||'').toUpperCase()}</td>
    </tr>
    <tr>
      <td colspan="2"><span class="label-cel">HOSPITAL: </span>${(f.hosp||'HOSPESC').toUpperCase()}</td>
      <td colspan="3"><span class="label-cel">DIAGNÓSTICO: </span>${(f.diag||'').toUpperCase()}</td>
      <td><span class="label-cel">CID: </span>${f.cid||''}</td>
    </tr>
    <tr>
      <td><span class="label-cel">REGISTRO: </span>${f.reg||''}</td>
      <td colspan="2"><span class="label-cel">CONVÊNIO: </span>${(f.conv||'SUS').toUpperCase()}</td>
      <td colspan="3"><span class="label-cel">LEITO: </span>${f.leito||''}</td>
    </tr>
    <tr>
      <td colspan="2"><span class="label-cel">GRUPO SANGUÍNEO: </span>${f.grupo||'(OPCIONAL)'} ${f.rh||''}</td>
      <td colspan="4"><span class="label-cel">JÁ RECEBEU TRANSFUSÃO? </span>
        ${f.jaTransfundido==='sim'?'(X)':'( )'} SIM &nbsp; ${f.jaTransfundido!=='sim'?'(X)':'( )'} NÃO &nbsp;&nbsp;&nbsp;
        <span class="label-cel">HOUVE REAÇÃO?</span>
        ${f.houvReacao==='sim'?'(X)':'( )'} SIM &nbsp; ${f.houvReacao!=='sim'?'(X)':'( )'} NÃO
      </td>
    </tr>
    <tr>
      <td colspan="2" style="font-size:8pt;"><span class="label-cel">Resultados de Exames:</span></td>
      <td><span class="label-cel">Hb (g/dL): </span>${f.hb||'___'}</td>
      <td><span class="label-cel">Ht (%): </span>${f.htc||'___'}</td>
      <td><span class="label-cel">Plaquetas (/mm³): </span>${f.plaq?Number(f.plaq).toLocaleString('pt-BR'):'___'}</td>
      <td><span class="label-cel">Outros: </span>${f.outrosExam||''}</td>
    </tr>
    <tr>
      <td colspan="2"><span class="label-cel">URGÊNCIA </span>${prioMarca[0]}&nbsp;
        <span class="label-cel">EMERGÊNCIA </span>${prioMarca[1]}&nbsp;
        <span class="label-cel">ROTINA </span>${prioMarca[2]}&nbsp; Deverá ser atendida em 24h
      </td>
      <td colspan="2"><span class="label-cel">PRÉ-OPERATÓRIO </span>${f.preop?'(X)':'( )'}&nbsp;</td>
      <td colspan="2"><span class="label-cel">Data: </span>${f.data?_fmtDataCurta(f.data):''}</td>
    </tr>
    ${f.justif?`<tr><td colspan="6" style="font-size:8.5pt;font-style:italic;">${f.justif.toUpperCase()}</td></tr>`:''}
  </table>

  <!-- PEDIDO -->
  <table class="pedido-table" style="margin-top:-1px;">
    <tr>
      <td class="th-pedido" style="width:75%;">PEDIDO</td>
      <td class="th-pedido" style="width:25%;text-align:right;">QUANTIDADE</td>
    </tr>
    ${pedidosHtml}
    ${outroHtml}
    <tr>
      <td colspan="2" style="padding:4px 6px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:6px;margin-top:2px;">
          <div><span class="label-cel">DATA: </span>${f.data?_fmtDataCurta(f.data):''} &nbsp;&nbsp;
               <span class="label-cel">HORA: </span>${f.hora||''} &nbsp;&nbsp;
               <span class="label-cel">MÉDICO: </span><strong>${(f.med||'').toUpperCase()}</strong> &nbsp;&nbsp;
               <span class="label-cel">CRM: </span>${f.crm||''}</div>
        </div>
        <div style="margin-top:4px;"><span class="label-cel">CONVÊNIO: </span>${(f.conv||'SUS').toUpperCase()}</div>
        <div style="margin-top:8px;display:flex;justify-content:space-between;font-size:8pt;">
          <div>Responsável pelo recebimento: _________________________ Data: ________ Hora: ________</div>
        </div>
        <div style="margin-top:6px;font-size:8pt;">Assinatura do cliente ou responsável: _____________________________________________</div>
        <div style="margin-top:6px;display:flex;justify-content:space-between;font-size:8pt;">
          <div>Auditoria do convênio &nbsp; Assinatura e carimbo do Auditor: ________________________</div>
          <div>( ) Autorizado &nbsp;&nbsp; ( ) Não Autorizado</div>
        </div>
      </td>
    </tr>
  </table>
  <div class="nota-final">
    QUALQUER ANORMALIDADE VERIFICADA NA INFUSÃO DESTE PRODUTO COMUNICAR IMEDIATAMENTE AO HEMONORTE, DEVOLVENDO A BOLSA,
    JUNTAMENTE COM 1 AMOSTRA DE SANGUE DO PACIENTE (5ml sem AC) E RELATÓRIO DA INTERCORRÊNCIA.
  </div>

  <!-- SEPARADOR -->
  <div class="sep"></div>

  <!-- COMPROVANTE DE ENTREGA -->
  <div class="comp-titulo">COMPROVANTE DE ENTREGA (PREENCHIMENTO OBRIGATÓRIO PELA UNIDADE REQUISITANTE)</div>
  <table class="principal">
    <tr>
      <td colspan="4"><span class="label-cel">Hospital: </span>HOSPITAL DOS PESCADORES</td>
      <td colspan="2"><span class="label-cel">Data: </span>${f.data?_fmtDataCurta(f.data):''} &nbsp; <span class="label-cel">HORA: </span>${f.hora||''}</td>
    </tr>
    <tr>
      <td colspan="4"><span class="label-cel">Paciente (legível): </span><strong>${(f.nome||'').toUpperCase()}</strong></td>
      <td colspan="2"><span class="label-cel">Data Nasc.: </span>${f.dn?_fmtDataCurta(f.dn):''}</td>
    </tr>
    <tr>
      <td class="th-pedido" style="width:28%;">Produto</td>
      <td class="th-pedido" style="width:22%;">Nº unidades ou volume (ml)</td>
      <td class="th-pedido" colspan="4">Processo de modificação a ser realizado no hemocomponente</td>
    </tr>
    <tr>
      <td>${ch.selecionado?'(X)':'( )'} CONCENTRADO DE HEMÁCIAS</td>
      <td>${ch.selecionado?ch.qtd||'':''}</td>
      <td colspan="2">( ) Aliquotagem &nbsp; ( ) Irradiação &nbsp; ( ) Lavagem</td>
      <td colspan="2"></td>
    </tr>
    <tr>
      <td>${pfc.selecionado?'(X)':'( )'} PLASMA FRESCO</td>
      <td>${pfc.selecionado?pfc.qtd||'':''}</td>
      <td colspan="2">( ) Aliquotagem</td>
      <td colspan="2"></td>
    </tr>
    <tr>
      <td>${plaqconv.selecionado?'(X)':'( )'} CONCENTRADO DE PLAQUETAS</td>
      <td>${plaqconv.selecionado?plaqconv.qtd||'':''}</td>
      <td>( ) Aliquotagem</td>
      <td>( ) Irradiação</td>
      <td colspan="2" style="text-align:center;font-weight:700;font-size:8pt;background:#eee;">Campo destinado ao Hemocentro</td>
    </tr>
    <tr>
      <td>${crio.selecionado?'(X)':'( )'} CRIOPRECIPITADO</td>
      <td>${crio.selecionado?crio.qtd||'':''}</td>
      <td colspan="2"></td>
      <td colspan="2" style="background:#eee;"></td>
    </tr>
    <tr>
      <td colspan="2" style="font-size:8pt;">Responsável pelo preenchimento: ${(f.med||'').toUpperCase()}</td>
      <td style="font-size:8pt;">Resp. Rec.</td>
      <td style="font-size:8pt;">Data:</td>
      <td style="font-size:8pt;">Hora:</td>
      <td style="font-size:8pt;"></td>
    </tr>
  </table>

  <script>window.onload=()=>{window.print();window.onafterprint=()=>window.close();}<\/script>
  </body></html>`;

  // PDF unificado: pág. 1 = ficha (1 A4 forçado), pág. 2 = Cartão SUS + 1 etiqueta prova cruzada
  if(window.PDFLib && window.html2canvas && window.jspdf){
    _gerarHemoCompleto(html, f).catch(e=>{
      console.warn('[HemoCompleto] falhou, abrindo HTML separado:', e);
      const w=window.open('','_blank','width=850,height=950');
      if(w){ w.document.write(html); w.document.close(); }
      else toast('Popup bloqueado — permita popups para imprimir.',true);
    });
    return;
  }
  // Fallback sem PDF-lib: comportamento anterior
  const w=window.open('','_blank','width=850,height=950');
  if(w){ w.document.write(html); w.document.close(); }
  else toast('Popup bloqueado — permita popups para imprimir.',true);
  _emitirEtiquetasHemo(f);
}

async function _emitirEtiquetasHemo(f){
  if(!window.PDFLib){ toast('PDF-lib não carregado — etiquetas não geradas.',true); return; }
  const dadosPac = {
    pac:   f.nome||gf('f-pac')||'',
    dn:    f.dn||gf('f-dn')||'',
    leito: f.leito||gf('f-leito')||'',
  };
  const pac = dadosPac.pac;
  const cns = f.cns||gf('f-cns')||'';
  const cartaoB64 = _cartaoSUSPDF || await _buscarCartaoSUSGenerico(pac, cns);
  await _gerarEtiquetasComCartao(cartaoB64, dadosPac, 'hemo', []);
}

/* ════════════════════════════════════════════════════════════════════════════
   ETIQUETAS DE IDENTIFICAÇÃO — sobrepostas no espaço em branco do Cartão SUS
   ─ Cultura: inclui campo MATERIAL com os materiais selecionados
   ─ Hemocomponentes: sem campo MATERIAL
   ─ Fonte Times Roman 6pt, alinhadas à margem esquerda do cartão SUS
   ════════════════════════════════════════════════════════════════════════════ */

// Busca cartão SUS usando apenas nome/CNS (sem depender dos campos fhemo-*)
async function _buscarCartaoSUSGenerico(pac, cns){
  if(!APPS_SCRIPT_URL || !CARTAO_SUS_FOLDER_ID) return null;
  const nome = (pac||'').trim();
  const cnsLimpo = (cns||'').replace(/\D/g,'');
  if(!nome && !cnsLimpo) return null;
  try{
    const r = await _apsFetch({
      action: 'cartao_sus',
      pacienteNome: _normalizarNome(nome),
      cns: cnsLimpo,
      folderId: CARTAO_SUS_FOLDER_ID
    });
    if(r.status === 'ok' && r.pdfBase64) return r.pdfBase64;
  } catch(e){ console.warn('[Cartão SUS etiqueta]', e); }
  return null;
}

// Formata DN de yyyy-mm-dd para dd/mm/yyyy
function _fmtDNEtiq(dn){
  if(!dn) return '';
  const p = dn.split('-');
  if(p.length === 3) return `${p[2]}/${p[1]}/${p[0]}`;
  return dn;
}

/* Gera PDF das etiquetas sobrepostas no espaço em branco do cartão SUS.
   Se cartaoBase64 for null, gera página avulsa com as etiquetas.
   tipo = 'cultura' | 'hemo'
   materiais = array de strings (só para cultura) */
async function _gerarEtiquetasComCartao(cartaoBase64, dadosPac, tipo, materiais){
  showLoading('Gerando etiquetas...');
  try{
    const PDFDocument = window.PDFLib.PDFDocument;
    const StandardFonts = window.PDFLib.StandardFonts;
    const rgb = window.PDFLib.rgb;

    const leito  = (dadosPac.leito||'').toString().padStart(2,'0');
    const nome   = (dadosPac.pac||dadosPac.nome||'').toUpperCase();
    const dn     = _fmtDNEtiq(dadosPac.dn||'');
    const matStr = (materiais||[]).join(' / ').toUpperCase();

    // Linhas de cada etiqueta (arrays de strings)
    // Cada etiqueta tem borda simples tracejada no topo para separação visual
    function _linhasEtiqueta(){
      const linhas = [
        `HOSPITAL DOS PESCADORES - UTI (L-${leito})`,
        `NOME: ${nome}`,
        `DN: ${dn}`,
        `DATA COLETA: ___/___/______`,
      ];
      if(tipo === 'cultura' && matStr){
        linhas.push(`MATERIAL: ${matStr}`);
      }
      linhas.push(`COLETADO POR: ________________________`);
      return linhas;
    }

    // ── Monta o PDF final ──────────────────────────────────────────────────
    let pdfDoc;
    let cartaoPage = null;   // página do cartão onde vamos sobrescrever
    let cartaoPageH = 0;     // altura da página do cartão (pts PDF)
    let cartaoPageW = 0;

    if(cartaoBase64 && window.PDFLib){
      const bin = atob(cartaoBase64);
      const bytes = new Uint8Array(bin.length);
      for(let i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
      pdfDoc = await PDFDocument.load(bytes);
      // Trabalhamos na ÚLTIMA página do cartão (ou única)
      const idx = pdfDoc.getPageCount() - 1;
      cartaoPage = pdfDoc.getPage(idx);
      const sz = cartaoPage.getSize();
      cartaoPageW = sz.width;
      cartaoPageH = sz.height;
    } else {
      // Sem cartão — cria página A4 avulsa
      pdfDoc = await PDFDocument.create();
      cartaoPage = pdfDoc.addPage([595.28, 841.89]); // A4
      cartaoPageW = 595.28;
      cartaoPageH = 841.89;
    }

    // Embed Times Roman (Times New Roman equivalente no PDF-lib)
    const font = await pdfDoc.embedFont(StandardFonts.TimesRoman);
    const fontBold = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);

    // Tamanho 6pt conforme solicitado
    const FS = 6;
    // Altura de linha = 1.4 * FS
    const LH = FS * 1.4;
    // Largura de cada etiqueta (mm<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M3 8h10"/><path d="M9.5 4.5L13 8l-3.5 3.5"/></svg>pts: 88mm × 2.835 ≈ 249 pts)
    // Mas vamos usar um terço da largura da página para caber 2 lado a lado
    const etiqW = (cartaoPageW - 40) / 2;  // 2 colunas com margem
    const etiqH = _linhasEtiqueta().length * LH + 8; // altura com padding

    // Posicionamento: parte inferior da página do cartão
    // Cartões SUS normalmente têm conteúdo na metade superior (~A5 = 420pts)
    // Deixamos margem de 4pts do fundo
    const MARGEM_INF = 4;
    const MARGEM_ESQ = 20;
    const linhas = _linhasEtiqueta();

    // Número de etiquetas: 4 (suficiente para frascos de coleta)
    const N_ETIQ = 4;
    const COLS = 2;
    const ROWS = Math.ceil(N_ETIQ / COLS);

    // Calcular área disponível: do fundo até 55% da altura da página
    const areaTop = cartaoPageH * 0.52;  // começa a ~52% da página
    const areaBot = MARGEM_INF;
    const areaH   = areaTop - areaBot;

    // Altura real de bloco por etiqueta dentro da área
    const blocoH = areaH / ROWS;

    for(let i = 0; i < N_ETIQ; i++){
      const col = i % COLS;
      const row = Math.floor(i / COLS);

      const xBase = MARGEM_ESQ + col * (etiqW + 10);
      // PDF-lib: y=0 é o FUNDO; areaTop é o topo da área de etiquetas
      // Linha superior do bloco desta etiqueta
      const yBloco = areaTop - row * blocoH;

      // Borda tracejada (linha horizontal separadora no topo de cada etiqueta)
      if(i < 2){
        // linha tracejada no topo da área
        cartaoPage.drawLine({
          start: { x: MARGEM_ESQ - 2, y: areaTop },
          end:   { x: cartaoPageW - MARGEM_ESQ + 2, y: areaTop },
          thickness: 0.3,
          color: rgb(0.4, 0.4, 0.4),
          dashArray: [3, 2],
        });
      }
      if(row > 0 && col === 0){
        // separador horizontal entre linhas
        cartaoPage.drawLine({
          start: { x: MARGEM_ESQ - 2, y: yBloco },
          end:   { x: cartaoPageW - MARGEM_ESQ + 2, y: yBloco },
          thickness: 0.3,
          color: rgb(0.5, 0.5, 0.5),
          dashArray: [3, 2],
        });
      }

      // Textos da etiqueta
      linhas.forEach((txt, li) => {
        const y = yBloco - LH * (li + 1);
        if(y < areaBot) return; // não sai da área
        const isBold = li === 0; // primeira linha em negrito
        cartaoPage.drawText(txt, {
          x: xBase,
          y,
          size: FS,
          font: isBold ? fontBold : font,
          color: rgb(0, 0, 0),
          maxWidth: etiqW - 4,
        });
      });
    }

    // Salva e abre
    const bytes = await pdfDoc.save();
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    hideLoading();
    const w = window.open(url, '_blank');
    if(w){ setTimeout(()=>{ try{ w.focus(); w.print(); }catch(_){} }, 1200); }
    else toast('Popup bloqueado — permita popups para imprimir.', true);
    setTimeout(() => URL.revokeObjectURL(url), 180000);
  } catch(e){
    hideLoading();
    console.error('[Etiquetas]', e);
    toast('Erro ao gerar etiquetas: ' + (e.message||e), true);
  }
}

/* Mescla a ficha HEMONORTE (HTML) com o PDF do Cartão SUS em um único PDF. */
async function _gerarPDFMescladoHemo(htmlFicha, cartaoBase64){
  showLoading('Gerando PDF combinado...');
  const container = document.createElement('div');
  container.style.cssText = 'position:fixed;left:-99999px;top:0;width:794px;background:#fff;color:#000;';
  try{
    const parser = new DOMParser();
    const docHtml = parser.parseFromString(htmlFicha, 'text/html');
    const styleEl = docHtml.querySelector('style');
    if(styleEl){
      const s = document.createElement('style');
      s.textContent = styleEl.textContent;
      container.appendChild(s);
    }
    const inner = document.createElement('div');
    inner.innerHTML = docHtml.body.innerHTML;
    inner.style.cssText = 'padding:10mm 12mm;background:#fff;';
    container.appendChild(inner);
    document.body.appendChild(container);

    await new Promise(r => setTimeout(r, 300));

    const canvas = await html2canvas(container, { scale: 2, backgroundColor: '#ffffff', useCORS: true });

    const { jsPDF } = window.jspdf;
    const pdfFicha = new jsPDF('p', 'mm', 'a4');
    const pdfW = pdfFicha.internal.pageSize.getWidth();
    const pdfH = pdfFicha.internal.pageSize.getHeight();
    const imgH = canvas.height * pdfW / canvas.width;
    const dataURL = canvas.toDataURL('image/jpeg', 0.92);
    if(imgH <= pdfH){
      pdfFicha.addImage(dataURL, 'JPEG', 0, 0, pdfW, imgH);
    } else {
      let restante = imgH; let yOffset = 0;
      while(restante > 0){
        pdfFicha.addImage(dataURL, 'JPEG', 0, yOffset === 0 ? 0 : -yOffset, pdfW, imgH);
        restante -= pdfH; yOffset += pdfH;
        if(restante > 0) pdfFicha.addPage();
      }
    }

    const fichaBytes = pdfFicha.output('arraybuffer');

    const PDFDocument = window.PDFLib.PDFDocument;
    const fichaDoc = await PDFDocument.load(fichaBytes);

    const bin = atob(cartaoBase64);
    const cartaoBytes = new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) cartaoBytes[i] = bin.charCodeAt(i);
    const cartaoDoc = await PDFDocument.load(cartaoBytes);

    const merged = await PDFDocument.create();
    const fichaPages  = await merged.copyPages(fichaDoc,  fichaDoc.getPageIndices());
    const cartaoPages = await merged.copyPages(cartaoDoc, cartaoDoc.getPageIndices());
    fichaPages.forEach(p => merged.addPage(p));
    cartaoPages.forEach(p => merged.addPage(p));

    const mergedBytes = await merged.save();
    const blob = new Blob([mergedBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);

    hideLoading();

    const w = window.open(url, '_blank');
    if(w){
      setTimeout(()=>{ try{ w.focus(); w.print(); }catch(_){ } }, 1200);
    } else {
      toast('Popup bloqueado — permita popups para imprimir.', true);
    }
    setTimeout(() => URL.revokeObjectURL(url), 180000);
  } finally {
    if(container.parentNode) container.parentNode.removeChild(container);
  }
}

/* ════════════════════════════════════════════════════════════════════════════
   PDF UNIFICADO DE HEMOTERÁPICOS
   Pág. 1 — Ficha HEMONORTE forçada em 1 A4 (comprime levemente se necessário)
   Pág. 2 — Cartão SUS (pág. 0 do PDF do Drive) + 1 etiqueta de prova cruzada
            centrada no espaço em branco (metade inferior do cartão)
   ════════════════════════════════════════════════════════════════════════════ */
async function _gerarHemoCompleto(htmlFicha, f){
  showLoading('Gerando PDF unificado...');
  const container = document.createElement('div');
  container.style.cssText = 'position:fixed;left:-99999px;top:0;width:794px;background:#fff;color:#000;';
  try{
    // ── 1. Renderiza o HTML da ficha em canvas ─────────────────────────────────
    const parser  = new DOMParser();
    const docHtml = parser.parseFromString(htmlFicha, 'text/html');
    const styleEl = docHtml.querySelector('style');
    if(styleEl){ const s=document.createElement('style'); s.textContent=styleEl.textContent; container.appendChild(s); }
    const inner = document.createElement('div');
    inner.innerHTML = docHtml.body.innerHTML.replace(/<script[\s\S]*?<\/script>/gi,'');
    inner.style.cssText = 'padding:8mm 10mm;background:#fff;';
    container.appendChild(inner);
    document.body.appendChild(container);
    await new Promise(r => setTimeout(r, 300));

    const canvas = await html2canvas(container, { scale:2, backgroundColor:'#ffffff', useCORS:true });

    // ── 2. Ficha <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M3 8h10"/><path d="M9.5 4.5L13 8l-3.5 3.5"/></svg> jsPDF <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M3 8h10"/><path d="M9.5 4.5L13 8l-3.5 3.5"/></svg> forçada em exatamente 1 A4 ─────────────────────────
    const { jsPDF } = window.jspdf;
    const fichaJsPDF = new jsPDF('p','mm','a4');
    const pdfW = fichaJsPDF.internal.pageSize.getWidth();  // 210 mm
    const pdfH = fichaJsPDF.internal.pageSize.getHeight(); // 297 mm
    const dataURL = canvas.toDataURL('image/jpeg', 0.93);
    fichaJsPDF.addImage(dataURL, 'JPEG', 0, 0, pdfW, pdfH); // força 1 página
    const fichaBytes = fichaJsPDF.output('arraybuffer');

    // ── 3. Monta PDF final com pdf-lib ─────────────────────────────────────────
    const PDFDocument  = window.PDFLib.PDFDocument;
    const StandardFonts = window.PDFLib.StandardFonts;
    const rgb          = window.PDFLib.rgb;

    const merged   = await PDFDocument.create();

    // Pág. 1 — ficha
    const fichaDoc  = await PDFDocument.load(fichaBytes);
    const [fichaPg] = await merged.copyPages(fichaDoc, [0]);
    merged.addPage(fichaPg);

    // Pág. 2 — Cartão SUS (pág. 0) ou A4 em branco como fallback
    let cartaoPage, pgW, pgH;
    if(_cartaoSUSPDF){
      const bin  = atob(_cartaoSUSPDF);
      const cbytes = new Uint8Array(bin.length);
      for(let i=0;i<bin.length;i++) cbytes[i] = bin.charCodeAt(i);
      const cartaoDoc = await PDFDocument.load(cbytes);
      // Sempre usa pág. 0 (a que contém os dados do paciente)
      const [cpg] = await merged.copyPages(cartaoDoc, [0]);
      merged.addPage(cpg);
      cartaoPage = merged.getPage(1);
    } else {
      cartaoPage = merged.addPage([595.28, 841.89]);
    }
    const sz = cartaoPage.getSize();
    pgW = sz.width; pgH = sz.height;   // pts  (A4 ≈ 595 × 842)

    // ── 4. Etiqueta de prova cruzada centrada no espaço em branco ─────────────
    //   O Cartão SUS ocupa visualmente a metade SUPERIOR da página.
    //   Em pdf-lib y=0 é o FUNDO <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M3 8h10"/><path d="M9.5 4.5L13 8l-3.5 3.5"/></svg> espaço em branco fica em y ∈ [0, pgH*0.48]
    const font     = await merged.embedFont(StandardFonts.TimesRoman);
    const fontBold = await merged.embedFont(StandardFonts.TimesRomanBold);
    const FS = 8;          // 8pt — legibilidade em 1 etiqueta
    const LH = FS * 1.55;  // altura de linha

    const leito = (f.leito || gf('f-leito') || '').toString().padStart(2,'0');
    const nome  = (f.nome  || gf('f-pac')  || '').toUpperCase();
    const dn    = _fmtDNEtiq(f.dn || gf('f-dn') || '');

    const linhas = [
      `HOSPITAL DOS PESCADORES - UTI (L-${leito})`,
      `NOME: ${nome}`,
      `DN: ${dn}`,
      `PROVA CRUZADA`,
      `DATA COLETA: ___/___/______`,
      `COLETADO POR: ________________________`,
    ];

    const PAD    = 6;                          // padding interno (pts)
    const etiqW  = pgW * 0.65;                 // 65% da largura
    const etiqH  = linhas.length * LH + PAD*2; // altura total da caixa
    const etiqX  = (pgW - etiqW) / 2;          // centrado horizontalmente

    // Centro vertical do espaço em branco (y=0 fundo, pgH*0.48 = limite superior)
    const blankMid = pgH * 0.24;              // ~¼ da página a partir do fundo
    const boxY  = blankMid - etiqH / 2;       // y do canto inferior da caixa

    // Caixa com borda
    cartaoPage.drawRectangle({
      x: etiqX - PAD, y: boxY,
      width: etiqW + PAD*2, height: etiqH,
      borderColor: rgb(0,0,0), borderWidth: 0.7,
      color: rgb(1,1,1),
    });

    // Textos (de cima para baixo dentro da caixa)
    linhas.forEach((txt, li) => {
      const isBold = li === 0 || li === 3; // cabeçalho e "PROVA CRUZADA" em negrito
      cartaoPage.drawText(txt, {
        x: etiqX,
        y: boxY + etiqH - PAD - LH*(li+1) + FS*0.3,
        size: FS,
        font: isBold ? fontBold : font,
        color: rgb(0,0,0),
        maxWidth: etiqW - 2,
      });
    });

    // ── 5. Salva e abre para impressão ────────────────────────────────────────
    const finalBytes = await merged.save();
    const blob = new Blob([finalBytes], { type:'application/pdf' });
    const url  = URL.createObjectURL(blob);
    hideLoading();
    const w = window.open(url, '_blank');
    if(w){ setTimeout(()=>{ try{ w.focus(); w.print(); }catch(_){} }, 1200); }
    else toast('Popup bloqueado — permita popups para imprimir.', true);
    setTimeout(() => URL.revokeObjectURL(url), 180000);

  } finally {
    if(container.parentNode) container.parentNode.removeChild(container);
    hideLoading();
  }
}

// _renderGuiasFichas já unificada acima (ATB + Hemoterápicos)

async function _abrirHemoExistente(key){
  showLoading('Carregando ficha...');
  try{
    const f=await dbGet(key); hideLoading();
    if(!f){ toast('Ficha não encontrada.',true); return; }
    // Preenche todos os campos do modal
    ['nome','sexo','mae','dn','cns','natur','end','hosp','diag','cid','reg','conv','leito',
     'grupo','rh','hb','htc','plaq','outros-exam','justif','data','hora','med','crm'].forEach(c=>{
      const el=$('fhemo-'+c);
      if(el) el.value=f[c.replace('-','_')]||f[c]||'';
    });
    // Radios
    ['transf','reac','prio'].forEach(r=>{
      const val = r==='prio'?f.prioridade:r==='transf'?f.jaTransfundido:f.houvReacao;
      const el=document.querySelector(`input[name="fhemo-${r}"][value="${val}"]`);
      if(el) el.checked=true;
    });
    if($('fhemo-preop')) $('fhemo-preop').checked=!!f.preop;
    // Checkboxes de componentes
    (f.pedidos||[]).forEach(p=>{
      const cb=$('fhemo-'+p.id); const qtd=$('fhemo-'+p.id+'-qtd');
      if(cb) cb.checked=!!p.selecionado;
      if(qtd) qtd.value=p.qtd||'';
    });
    $('modal-hemo-ficha').classList.add('show');
  }catch(e){ hideLoading(); toast('Erro: '+(e.message||e),true); }
}

async function _imprimirHemoChave(key){
  showLoading('Carregando ficha...');
  try{ const f=await dbGet(key); hideLoading(); if(f) _imprimirFichaHemoObj(f); }
  catch(e){ hideLoading(); toast('Erro: '+(e.message||e),true); }
}

/* ════════════════════════════════════════════════════════════════════════════
   TERMOS DE CONSENTIMENTO (TCLE)
   ─ Cuidados Paliativos e Autorização de Traqueostomia
   ────────────────────────────────────────────────────────────────────────── */

function abrirTermos(tipo){
  // Preenche dados do paciente
  sf('termo-pac',   gf('f-pac')||'');
  sf('termo-dn',    gf('f-dn')||'');
  sf('termo-leito', gf('f-leito')||'');
  sf('termo-data',  hoje());
  if(tipo){ sf('termo-tipo', tipo); _termoMudar(); }
  $('modal-termo').classList.add('show');
  _resizeModalTextareas('modal-termo');
}

function fecharTermo(){ $('modal-termo').classList.remove('show'); }

function _termoMudar(){
  const t=gf('termo-tipo');
  // Testemunhas só aparecem para paliativo
  $('termo-testemunhas').style.display = (t==='paliativo') ? '' : 'none';
}

function _coletarTermo(){
  return {
    tipo:gf('termo-tipo'),
    pac:gf('termo-pac'), dn:gf('termo-dn'), leito:gf('termo-leito'),
    data:gf('termo-data'),
    resp:gf('termo-resp'), cpf:gf('termo-cpf'),
    vinculo:gf('termo-vinculo'), tel:gf('termo-tel'),
    t1Nome:gf('termo-t1-nome'), t1Cpf:gf('termo-t1-cpf'),
    t2Nome:gf('termo-t2-nome'), t2Cpf:gf('termo-t2-cpf'),
    autor:usuarioEmail, autorNome:perfilUsuario?perfilUsuario.nome:'',
    medCrm:perfilUsuario?perfilUsuario.crm:'',
    salvadoEm:new Date().toISOString()
  };
}

async function salvarTermo(){
  if(!leitoAtual){ toast('Abra o prontuário de um paciente.',true); return; }
  if(!gf('termo-tipo')){ toast('Selecione o tipo de termo.',true); return; }
  if(!gf('termo-resp')){ toast('Informe o nome do responsável.',true); return; }
  showLoading('Salvando termo...');
  try{
    const t=_coletarTermo();
    const key=`uti_med_termo_${leitoAtual}_${t.data}_${Date.now()}`;
    await dbSet(key,t);
    hideLoading(); toast('<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M2.5 8.5l3.5 3.5 7.5-7.5"/></svg> Termo salvo.');
    _renderGuiasFichas();
  }catch(e){ hideLoading(); toast('Erro: '+(e.message||e),true); }
}

function imprimirTermo(){
  const t=_coletarTermo();
  if(!t.tipo){ toast('Selecione o tipo de termo.',true); return; }
  if(t.tipo==='paliativo') _imprimirTermoPaliativo(t);
  else if(t.tipo==='traqueo') _imprimirTermoTraqueostomia(t);
}

async function _imprimirTermoChave(key){
  showLoading('Carregando termo...');
  try{
    const t=await dbGet(key); hideLoading();
    if(!t){ toast('Termo não encontrado.',true); return; }
    if(t.tipo==='paliativo') _imprimirTermoPaliativo(t);
    else if(t.tipo==='traqueo') _imprimirTermoTraqueostomia(t);
  }catch(e){ hideLoading(); toast('Erro: '+(e.message||e),true); }
}

async function _abrirTermoExistente(key){
  showLoading('Carregando termo...');
  try{
    const t=await dbGet(key); hideLoading();
    if(!t){ toast('Termo não encontrado.',true); return; }
    sf('termo-tipo',t.tipo||''); _termoMudar();
    sf('termo-pac',t.pac||''); sf('termo-dn',t.dn||''); sf('termo-leito',t.leito||'');
    sf('termo-data',t.data||hoje());
    sf('termo-resp',t.resp||''); sf('termo-cpf',t.cpf||'');
    sf('termo-vinculo',t.vinculo||''); sf('termo-tel',t.tel||'');
    sf('termo-t1-nome',t.t1Nome||''); sf('termo-t1-cpf',t.t1Cpf||'');
    sf('termo-t2-nome',t.t2Nome||''); sf('termo-t2-cpf',t.t2Cpf||'');
    $('modal-termo').classList.add('show');
    _resizeModalTextareas('modal-termo');
  }catch(e){ hideLoading(); toast('Erro: '+(e.message||e),true); }
}

/* ── Cabeçalho institucional comum aos termos ─────────────────────────── */
function _termoCabecalho(){
  return `<div class="cab">
    <p style="font-size:8pt;color:#555;">SECRETARIA MUNICIPAL DE SAÚDE</p>
    <h1 style="font-size:13pt;color:#7a1020;font-weight:800;margin-top:2px;">HOSPITAL DOS PESCADORES</h1>
  </div>`;
}

function _termoEstilos(){
  return `<style>
    *{box-sizing:border-box;margin:0;padding:0;font-family:'Arial',sans-serif;}
    @page{size:A4 portrait;margin:0.7cm 1.2cm}
    body{font-size:8.5pt;color:#000;line-height:1.35;text-align:justify;}
    .cab{text-align:center;border-bottom:2px solid #7a1020;padding-bottom:4px;margin-bottom:6px;}
    h2.titulo{text-align:center;font-size:9.5pt;font-weight:800;margin:6px 0 5px;text-transform:uppercase;letter-spacing:.04em;}
    p{margin-bottom:4px;}
    .item{margin-bottom:3px;text-align:justify;}
    .item b{display:inline-block;min-width:18px;}
    .linha-dados{margin:5px 0;line-height:1.7;}
    .campo{display:inline-block;border-bottom:1px solid #555;padding:0 4px;min-width:120px;}
    .campo-grande{display:inline-block;border-bottom:1px solid #555;padding:0 4px;min-width:260px;}
    .assin{margin-top:8px;text-align:center;}
    .assin .linha{border-top:1px solid #555;display:inline-block;min-width:260px;padding-top:3px;font-size:8pt;}
    .duas-assin{display:flex;justify-content:space-between;gap:20px;margin-top:8px;}
    .duas-assin > div{flex:1;text-align:center;}
    .duas-assin .linha{border-top:1px solid #555;padding-top:3px;font-size:8pt;}
    @media print{body{margin:0;}}
  </style>`;
}

function _imprimirTermoPaliativo(t){
  const dia=t.data?_fmtDataCurta(t.data):'____';
  // Quebra a data em dia/mês/ano
  let d='____', m='____________', y='____';
  if(t.data){
    const dt=new Date(t.data+'T00:00:00');
    d=dt.getDate().toString().padStart(2,'0');
    m=['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'][dt.getMonth()];
    y=dt.getFullYear();
  }

  const html=`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
  <title>TCLE Cuidados Paliativos — ${t.pac||''}</title>
  ${_termoEstilos()}</head><body>
  ${_termoCabecalho()}
  <h2 class="titulo">TERMO DE CONSENTIMENTO LIVRE E ESCLARECIDO PARA ADOÇÃO DE MEDIDAS DE CUIDADOS PALIATIVOS</h2>

  <p style="font-size:9.5pt;"><b>Definição:</b> Segundo a Organização Mundial de Saúde "cuidados paliativos consistem na assistência promovida por uma equipe multidisciplinar, que objetiva a melhoria da qualidade de vida do paciente e seus familiares, diante de uma doença que ameace a vida, por meio da prevenção e alívio do sofrimento, da identificação precoce, avaliação impecável e tratamento de dor e demais sintomas físicos, sociais, psicológicos e espirituais."</p>

  <p style="margin-top:10px;"><b>Declaro que:</b></p>

  <div class="item"><b>1.</b> Fui esclarecido(a) que no suporte de Cuidados Paliativos há a oferta de uma estrutura assistencial especialmente destinada aos pacientes que se encontram em situações clínicas irreversíveis e terminais.</div>
  <div class="item"><b>2.</b> Estou ciente que nas medidas/assistência de Cuidados Paliativos o paciente receberá cuidados clínicos integrados aos aspectos psicológicos, sociais e espirituais. Neste tipo de assistência não há suporte de Terapia Intensiva, nem a realização de procedimentos invasivos e tratamentos que sejam desnecessários, sob a ótica médica, no estágio em que se encontra a doença.</div>
  <div class="item"><b>3.</b> Fui esclarecido(a) que a assistência ocorrerá de forma coordenada e por uma equipe multidisciplinar, composta de médicos, enfermeiros, psicólogo ou assistente social, além de outros profissionais, que sejam importantes para a promoção do conforto, alívio da dor e qualidade de vida do paciente.</div>
  <div class="item"><b>4.</b> Confirmo que recebi todas as informações necessárias quanto aos riscos, benefícios de não realizar nenhuma atitude terapêutica diante da natureza da(s) enfermidade(s) diagnosticada(s), bem como, que será respeitada a autonomia e desejo do paciente ou seu representante legal, nas decisões sobre os tratamentos, procedimentos e plano de cuidados.</div>
  <div class="item"><b>5.</b> Fui esclarecido(a) que a adesão às medidas de Cuidados Paliativos é voluntária e, que o paciente pode, a qualquer momento, sair deste modelo assistencial ou mesmo recusar um determinado tratamento ou serviço, sem que implique em prejuízo ao tratamento convencional.</div>
  <div class="item"><b>6.</b> Foram observadas todas as orientações necessárias para o procedimento/tratamento, bem como foram fornecidas as informações sobre o estado de saúde do paciente, incluindo doenças, medicações, alergias, medicações em uso contínuo ou eventual.</div>
  <div class="item"><b>7.</b> Tive a oportunidade de fazer perguntas, que foram respondidas de maneira satisfatória, incluindo o direito de revogação do consentimento dado, desde que seja feito antes do início da realização do procedimento/tratamento.</div>

  <p style="margin-top:10px;">Desta forma, diante da compreensão do alcance dos benefícios, riscos, alternativas e pleno conhecimento do inteiro teor deste termo, <b>AUTORIZO</b> a adoção de medidas de cuidados paliativos para o(a) paciente <b>${(t.pac||'').toUpperCase()}</b>${t.dn?', nascido(a) em '+_fmtDataCurta(t.dn):''}${t.leito?', leito '+t.leito:''}.</p>

  <div class="linha-dados">
    NATAL-RN, <span class="campo">${d}</span> de <span class="campo">${m}</span> de <span class="campo">${y}</span>.
  </div>

  <h3 style="font-size:9pt;margin-top:8px;text-decoration:underline;">Preenchimento Obrigatório pelo Paciente ou Representante Legal</h3>
  <div class="linha-dados">
    Nome legível: <span class="campo-grande">${(t.resp||'').toUpperCase()}</span><br>
    Grau de parentesco/vínculo: <span class="campo-grande">${(t.vinculo||'').toUpperCase()}</span><br>
    CPF: <span class="campo">${t.cpf||''}</span> &nbsp;&nbsp; Telefone: <span class="campo">${t.tel||''}</span><br>
    Assinatura: <span class="campo-grande">&nbsp;</span>
  </div>

  <h3 style="font-size:9pt;margin-top:8px;text-decoration:underline;">Preenchimento Obrigatório pela Equipe Médica</h3>
  <p style="font-size:9.5pt;">Expliquei o procedimento ao qual o paciente acima referido está sujeito, ao próprio paciente ou seu representante legal, sobre os benefícios, riscos e alternativas, tendo respondido às perguntas formuladas. De acordo com o meu entendimento, o paciente e/ou seu representante legal, está em condições de compreender o que lhes foi informado.</p>

  <div class="assin">
    <div class="linha">${(t.autorNome||'').toUpperCase()}<br>Assinatura e carimbo do Médico${t.medCrm?' — CRM '+t.medCrm:''}</div>
  </div>

  <h3 style="font-size:9pt;margin-top:8px;text-decoration:underline;">Testemunhas</h3>
  <div class="duas-assin">
    <div>
      Nome: <span class="campo-grande">${(t.t1Nome||'').toUpperCase()}</span><br>
      CPF: <span class="campo">${t.t1Cpf||''}</span><br>
      <div class="linha" style="margin-top:14px;">Assinatura</div>
    </div>
    <div>
      Nome: <span class="campo-grande">${(t.t2Nome||'').toUpperCase()}</span><br>
      CPF: <span class="campo">${t.t2Cpf||''}</span><br>
      <div class="linha" style="margin-top:14px;">Assinatura</div>
    </div>
  </div>

  <div style="margin-top:8px;font-size:8.5pt;">
    Revogação: <span class="campo">________________</span>, <span class="campo">____</span> de <span class="campo">________________</span> de <span class="campo">______</span><br>
    <div class="assin" style="margin-top:8px;"><div class="linha">Paciente ou Representante Legal</div></div>
  </div>

  <script>window.onload=()=>{window.print();window.onafterprint=()=>window.close();}<\/script>
  </body></html>`;

  const w=window.open('','_blank','width=820,height=950');
  if(w){ w.document.write(html); w.document.close(); }
  else toast('Popup bloqueado — permita popups para imprimir.',true);
}

function _imprimirTermoTraqueostomia(t){
  let d='____', m='____', y='____';
  if(t.data){
    const dt=new Date(t.data+'T00:00:00');
    d=dt.getDate().toString().padStart(2,'0');
    m=(dt.getMonth()+1).toString().padStart(2,'0');
    y=dt.getFullYear().toString().slice(-2);
  }

  const html=`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
  <title>Termo Traqueostomia — ${t.pac||''}</title>
  ${_termoEstilos()}</head><body>
  ${_termoCabecalho()}
  <h2 class="titulo">TERMO DE CONSENTIMENTO INFORMADO<br>AUTORIZAÇÃO PARA TRAQUEOSTOMIA</h2>

  <p style="margin-top:14px;line-height:2;">
    EU, <span class="campo-grande">${(t.resp||'').toUpperCase()}</span>, RG/CPF <span class="campo">${t.cpf||''}</span>,<br>
    GRAU DE PARENTESCO <span class="campo">${(t.vinculo||'').toUpperCase()}</span>,<br>
    DA(O) PACIENTE <span class="campo-grande">${(t.pac||'').toUpperCase()}</span>, DN: <span class="campo">${t.dn?_fmtDataCurta(t.dn):''}</span>,<br>
    INTERNADA(O) NA UTI-HOSPESC, LEITO <span class="campo">${t.leito||''}</span>, <b>AUTORIZO A REALIZAÇÃO DA TRAQUEOSTOMIA</b> ESTANDO CIENTE DAS POSSÍVEIS COMPLICAÇÕES E SUAS INDICAÇÕES.
  </p>

  <p style="margin-top:14px;text-align:justify;">
    É compreendido que durante o transcurso do procedimento, operação, exame e/ou tratamento pode ser necessário o uso de equipamentos / instrumentos invasivos. Foram explicados em detalhes os riscos e benefícios associados com esse tipo de monitoramento.
  </p>
  <p style="text-align:justify;">
    Está claro e entendido que os medicamentos/materiais associados ao procedimento podem ocasionar complicações e provocar reações diversas, inclusive adversas no organismo do(a) paciente. Está claro que durante o procedimento podem surgir certas condições que requeiram a modificação ou extensão deste consentimento. Pode ser necessária a mudança da técnica cirúrgica proposta no presente termo, ou até a suspensão da cirurgia em razão de variantes surgidas no pré ou no transprocedimento, variantes essas que podem não ser detectadas na avaliação prévia, como, por exemplo, febre, jejum inadequado, complicações anestésicas, variações anatômicas, etc. Neste ato são autorizadas as modificações ou extensões a este consentimento segundo o juízo profissional do médico assistente, de acordo com as circunstâncias e as necessidades.
  </p>

  <div style="text-align:right;margin-top:24px;">
    Natal-RN, <span class="campo">${d}</span>/<span class="campo">${m}</span>/<span class="campo">${y}</span> de 20<span class="campo">${y}</span>.
  </div>

  <div class="assin" style="margin-top:50px;">
    <div class="linha">${(t.resp||'').toUpperCase()}<br>Assinatura do responsável</div>
  </div>

  <div class="assin" style="margin-top:30px;">
    <div class="linha">${(t.autorNome||'').toUpperCase()}<br>Assinatura e carimbo do Médico${t.medCrm?' — CRM '+t.medCrm:''}</div>
  </div>

  <script>window.onload=()=>{window.print();window.onafterprint=()=>window.close();}<\/script>
  </body></html>`;

  const w=window.open('','_blank','width=820,height=950');
  if(w){ w.document.write(html); w.document.close(); }
  else toast('Popup bloqueado — permita popups para imprimir.',true);
}

/* ════════════════════════════════════════════════════════════════════════════
   SOLICITAÇÃO DE EXAMES LABORATORIAIS
   ════════════════════════════════════════════════════════════════════════════ */

// Exames de rotina UTI (conforme modelo da imagem)
const SOL_ROTINA = [
  'HEMOGRAMA','PCR','UREIA','CREATININA',
  'SÓDIO','POTÁSSIO','CÁLCIO','MAGNÉSIO','TAP/TTPA/INR'
];

// Estado da solicitação atual
let _solLinhas = []; // [{exame:'', indicacao:''}]
let _solSalvas = []; // solicitações salvas do dia (para imprimir todas)

function abrirSolicitacaoExames(){
  sf('sol-pac',   (gf('f-pac')||'').toUpperCase());
  sf('sol-leito', gf('f-leito')||'');
  sf('sol-data',  gf('f-data')||hoje());
  sf('sol-indicacao','');
  if(!_solLinhas.length) _solLinhas=[{exame:''}];
  _solRender();
  $('modal-sol-exames').classList.add('show');
}

function fecharSolicitacaoExames(){ $('modal-sol-exames').classList.remove('show'); }

function _solRender(){
  const w=$('sol-exames-lista'); if(!w) return;
  w.innerHTML=_solLinhas.map((l,i)=>`
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">
      <input type="text" value="${l.exame||''}" placeholder="Nome do exame"
        style="flex:1;text-transform:uppercase;padding:7px 10px;border:1.5px solid var(--borda);border-radius:8px;font-size:.9rem;"
        oninput="_solLinhas[${i}].exame=this.value.toUpperCase()">
      ${_solLinhas.length>1?`<button class="presc-del" onclick="_solLinhas.splice(${i},1);_solRender()" title="Remover"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><polyline points="3,5 5,5 13,5"/><path d="M6 5V3.5A.5.5 0 016.5 3h3a.5.5 0 01.5.5V5"/><path d="M5 5l.7 8.5a.8.8 0 00.8.5h3a.8.8 0 00.8-.5L11 5"/><line x1="7" y1="8" x2="7" y2="12"/><line x1="9" y1="8" x2="9" y2="12"/></svg></button>`:''}
    </div>`).join('');
}

function _solAddLinha(){
  _solLinhas.push({exame:''});
  _solRender();
}

function _solLimpar(){
  _solLinhas=[{exame:''}];
  _solRender();
  sf('sol-indicacao','');
}

function _solRotina(){
  _solLinhas=SOL_ROTINA.map(e=>({exame:e}));
  _solRender();
  if(!gf('sol-indicacao')) sf('sol-indicacao','EXAMES DE ROTINA UTI');
}

function _coletarSolicitacao(){
  return {
    pac:gf('sol-pac'), leito:gf('sol-leito'), data:gf('sol-data'),
    indicacao:gf('sol-indicacao'),
    exames:_solLinhas.map(l=>l.exame).filter(Boolean),
    medNome:perfilUsuario?perfilUsuario.nome:'',
    medCrm:perfilUsuario?perfilUsuario.crm:'',
    salvadoEm:new Date().toISOString()
  };
}

async function salvarSolicitacaoExames(){
  if(!leitoAtual){ toast('Abra o prontuário de um paciente.',true); return; }
  const s=_coletarSolicitacao();
  if(!s.exames.length){ toast('Adicione ao menos um exame.',true); return; }
  showLoading('Salvando solicitação...');
  try{
    const key=`uti_med_sol_exam_${leitoAtual}_${s.data}_${Date.now()}`;
    await dbSet(key, s);
    // Adiciona à lista local para impressão futura
    _solSalvas.push({key,...s});
    hideLoading();
    toast('<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M2.5 8.5l3.5 3.5 7.5-7.5"/></svg> Solicitação salva. Clique em <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><rect x="3" y="6" width="10" height="7" rx="1"/><path d="M5 6V3h6v3"/><rect x="5" y="9.5" width="6" height="2.5" rx=".4"/><line x1="5" y1="7.8" x2="11" y2="7.8"/></svg> Imprimir para gerar o documento.');
    _solLinhas=[{exame:''}];
    _solRender();
    sf('sol-indicacao','');
  }catch(e){ hideLoading(); toast('Erro: '+(e.message||e),true); }
}

// Salva E imprime na mesma ação — coleta os dados antes de limpar o formulário
async function salvarEImprimirSolicitacao(){
  if(!leitoAtual){ toast('Abra o prontuário de um paciente.',true); return; }
  const s=_coletarSolicitacao();
  if(!s.exames.length){ toast('Adicione ao menos um exame.',true); return; }
  showLoading('Salvando solicitação...');
  try{
    const key=`uti_med_sol_exam_${leitoAtual}_${s.data}_${Date.now()}`;
    await dbSet(key, s);
    _solSalvas.push({key,...s});
    hideLoading();
    _imprimirSolicitacaoObj(s);   // imprime com os dados já coletados
    _solLinhas=[{exame:''}];      // só limpa depois de imprimir
    _solRender();
    sf('sol-indicacao','');
  }catch(e){ hideLoading(); toast('Erro: '+(e.message||e),true); }
}

function imprimirSolicitacaoAtual(){
  const s=_coletarSolicitacao();
  if(!s.exames.length){ toast('Adicione ao menos um exame.',true); return; }
  _imprimirSolicitacaoObj(s);
}

// Imprime TODAS as solicitações salvas do leito+data atual
async function imprimirSolicitacoesExames(){
  if(!leitoAtual){ toast('Abra o prontuário de um paciente.',true); return; }
  showLoading('Buscando solicitações...');
  try{
    const data=gf('f-data')||hoje();
    const todas=await dbListByPrefix(`uti_med_sol_exam_${leitoAtual}_${data}`);
    const arr=Object.values(todas).filter(s=>s&&s.exames&&s.exames.length);
    hideLoading();
    if(!arr.length){ toast('Nenhuma solicitação de exame salva para hoje.',true); return; }
    // Imprime uma por página
    arr.sort((a,b)=>(a.salvadoEm||'').localeCompare(b.salvadoEm||''));
    const htmlPages=arr.map(s=>_htmlSolicitacao(s)).join('<div style="page-break-after:always;"></div>');
    _abrirJanelaBranca(htmlPages, 'Solicitações de Exames');
  }catch(e){ hideLoading(); toast('Erro: '+(e.message||e),true); }
}

function _imprimirSolicitacaoObj(s){ _abrirJanelaBranca(_htmlSolicitacao(s), 'Solicitação de Exames'); }

function _htmlSolicitacao(s){
  const itens=(s.exames||[]).map(e=>`<li style="padding:4px 0;font-size:11pt;letter-spacing:.02em;">${e.toUpperCase()}</li>`).join('');
  return `
  <div style="font-family:'Arial',sans-serif;max-width:800px;margin:0 auto;padding:0 10px;">
    <!-- Cabeçalho -->
    <div style="display:flex;align-items:center;gap:16px;border-bottom:3px solid #c00;padding-bottom:10px;margin-bottom:0;">
      <img src="logo.png" alt="HOSPESC" style="height:60px;width:auto;" onerror="this.style.display='none'">
      <div>
        <div style="font-size:8pt;color:#555;text-transform:uppercase;letter-spacing:.06em;">Secretaria Municipal de Saúde</div>
        <div style="font-size:14pt;font-weight:800;color:#003080;letter-spacing:.04em;">HOSPITAL DOS PESCADORES</div>
        <div style="font-size:8pt;color:#555;">UTI Geral</div>
      </div>
    </div>
    <!-- Dados do paciente -->
    <table style="width:100%;border-collapse:collapse;margin-top:0;border:2px solid #000;">
      <tr>
        <td style="border:1px solid #000;padding:6px 10px;width:80px;font-weight:800;font-size:10pt;">NOME:</td>
        <td style="border:1px solid #000;padding:6px 10px;font-size:11pt;font-weight:700;">${(s.pac||'').toUpperCase()}</td>
      </tr>
      <tr>
        <td style="border:1px solid #000;padding:6px 10px;font-weight:800;font-size:10pt;">DATA&nbsp;${s.data?_fmtDataCurta(s.data).replace(/\//g,'/').slice(0,8):'____/____/____'}</td>
        <td style="border:1px solid #000;padding:6px 10px;font-size:10pt;font-weight:700;text-align:right;">LEITO:&nbsp;${s.leito||'__'}</td>
      </tr>
    </table>
    <!-- Corpo -->
    <div style="margin-top:28px;">
      <div style="font-weight:800;font-size:12pt;margin-bottom:16px;">SOLICITO:</div>
      <ul style="list-style:none;padding:0;margin:0 0 0 20px;">
        ${itens}
      </ul>
    </div>
    ${s.indicacao?`<div style="margin-top:20px;font-size:9.5pt;"><strong>Indicação:</strong> ${s.indicacao.toUpperCase()}</div>`:''}
    <!-- Assinatura -->
    <div style="margin-top:50px;display:flex;justify-content:flex-end;">
      <div style="text-align:center;">
        <div style="border-top:1px solid #555;width:260px;padding-top:5px;font-size:9pt;">
          ${s.medNome?s.medNome.toUpperCase()+'<br>':''}${s.medCrm?'CRM '+s.medCrm:'Médico Responsável'}
        </div>
      </div>
    </div>
  </div>`;
}

/* ════════════════════════════════════════════════════════════════════════════
   IMPRESSÃO GERAL (exames + prescrição 2 vias + evolução)
   ════════════════════════════════════════════════════════════════════════════ */

// Abre janela de impressão com HTML passado
function _abrirJanelaBranca(conteudo, titulo){
  const estilo=`<style>
    *{box-sizing:border-box;margin:0;padding:0;}
    @page{size:A4 portrait;margin:1.2cm}
    body{font-family:'Arial',sans-serif;font-size:10pt;color:#000;background:white;}
    li{list-style-type:'- ';margin-left:20px;}
    @media print{.no-print{display:none;}}
  </style>`;
  const w=window.open('','_blank','width=860,height:980');
  if(!w){ toast('Popup bloqueado — permita popups para imprimir.',true); return; }
  w.document.write(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
    <title>${titulo}</title>${estilo}</head><body>${conteudo}
    <script>window.onload=()=>{window.print();window.onafterprint=()=>window.close();}<\/script>
    </body></html>`);
  w.document.close();
}

// Prescrição em 2 vias (A4, lado a lado ou página dupla)
function imprimirPrescricaoDuasVias(){
  if(!_rxItens.length){ toast('Nenhum item na prescrição.',true); return; }
  const via=_gerarHtmlPrescricao();
  // Duas vias separadas por page-break
  _abrirJanelaBranca(via+'<div style="page-break-after:always;"></div>'+via, 'Prescrição — 2 vias');
}

// Gera HTML da prescrição (reutilizável)
function _gerarHtmlPrescricao(){
  const pac=gf('f-pac'), leito=gf('f-leito'), data=gf('f-data');
  const med=perfilUsuario?perfilUsuario.nome:'', crm=perfilUsuario?perfilUsuario.crm||'':'';
  const linhas=_rxItens.map((it,i)=>{
    const isHidrat = it._cat === 'Hidratação';
    const dosePartes = isHidrat
      ? [it.qtd ? it.qtd+'ML' : '', it.dose&&it.dose!=='—'?it.dose:''].filter(Boolean)
      : [it.qtd,(it.apres&&it.apres!=='—'?it.apres:''),(it.dose&&it.dose!=='—'?it.dose:'')].filter(Boolean);
    const dose = dosePartes.join(' ') || '—';
    const vazaoHtml = isHidrat && it.vazao
      ? `<div style="font-size:7pt;color:#0d47a1;font-weight:700;margin-top:1px;">Vazão: ${it.vazao} ml/h</div>`
      : '';
    const hors=_ordenarHorarios(it.hor||[]).join(' · ')||'—';
    const bg = it.tipo==='dieta'?'#f0f7f0':it.tipo==='sn'?'#fffde7':it.tipo==='cuidados'?'#f5f5f5':'white';
    const dBadge=it._cat==='ATB'&&it._ddia!=null
      ? `<span style="background:${it._ddia>=10?'#b71c1c':it._ddia>=7?'#e65100':'#1565c0'};color:white;font-size:6pt;font-weight:800;padding:1px 5px;border-radius:4px;margin-left:5px;vertical-align:middle;">D${it._ddia}</span>`
      : '';
    const dilHtml=it.diluicao
      ? `<div style="font-size:7pt;color:#1d4ed8;margin-top:1px;font-weight:600;">Diluente: ${it.diluicao.toUpperCase()}</div>`
      : '';
    return `<tr style="background:${bg};">
      <td style="padding:4px 6px;border:1px solid #ccc;width:24px;color:#888;font-size:8pt;">${i+1}</td>
      <td style="padding:4px 6px;border:1px solid #ccc;font-weight:600;">${(it.farm||'—').toUpperCase()}${dBadge}${dilHtml}</td>
      <td style="padding:4px 6px;border:1px solid #ccc;">${dose.toUpperCase()}${vazaoHtml}</td>
      <td style="padding:4px 6px;border:1px solid #ccc;">${(it.via||'—').toUpperCase()}</td>
      <td style="padding:4px 6px;border:1px solid #ccc;">${(it.freq||'—').toUpperCase()}</td>
      <td style="padding:4px 6px;border:1px solid #ccc;font-size:8pt;">${hors}</td>
      <td style="padding:4px 6px;border:1px solid #ccc;font-size:8pt;">${(it.obs||'').toUpperCase()}</td>
    </tr>`;
  }).join('');

  return `
  <div style="font-family:'Arial Narrow',Arial,sans-serif;font-size:9pt;padding:0 4px;">
    <!-- Cabeçalho -->
    <div style="display:flex;align-items:center;justify-content:space-between;border-bottom:2px solid #7a1020;padding-bottom:8px;margin-bottom:8px;">
      <div style="display:flex;align-items:center;gap:10px;">
        <img src="logo.png" alt="" style="height:48px;width:auto;" onerror="this.style.display='none'">
        <div>
          <div style="font-weight:800;color:#7a1020;font-size:12pt;">PRESCRIÇÃO MÉDICA — UTI GERAL</div>
          <div style="font-size:8pt;color:#555;">HOSPITAL DOS PESCADORES · NATAL/RN</div>
        </div>
      </div>
      <div style="text-align:right;font-size:8.5pt;color:#444;">
        <strong>DATA:</strong> ${_fmtDataCurta(data)||'—'}&nbsp;&nbsp;<strong>LEITO:</strong> ${leito||'?'}
      </div>
    </div>
    <!-- Paciente -->
    <div style="margin-bottom:8px;font-size:9.5pt;">
      <strong>Paciente:</strong> ${(pac||'').toUpperCase()}
    </div>
    <!-- Tabela -->
    <table style="width:100%;border-collapse:collapse;font-size:8.5pt;">
      <thead>
        <tr style="background:#7a1020;color:white;">
          <th style="padding:5px 6px;text-align:left;font-size:7.5pt;">#</th>
          <th style="padding:5px 6px;text-align:left;font-size:7.5pt;">FÁRMACO / ITEM</th>
          <th style="padding:5px 6px;text-align:left;font-size:7.5pt;">DOSE/APRES</th>
          <th style="padding:5px 6px;text-align:left;font-size:7.5pt;">VIA</th>
          <th style="padding:5px 6px;text-align:left;font-size:7.5pt;">FREQ</th>
          <th style="padding:5px 6px;text-align:left;font-size:7.5pt;">HORÁRIOS</th>
          <th style="padding:5px 6px;text-align:left;font-size:7.5pt;">OBS</th>
        </tr>
      </thead>
      <tbody>${linhas}</tbody>
    </table>
    <!-- Assinatura -->
    <div style="margin-top:30px;display:flex;justify-content:flex-end;">
      <div style="text-align:center;">
        <div style="border-top:1px solid #555;width:240px;padding-top:4px;font-size:8.5pt;">
          ${med?med.toUpperCase()+'<br>':''}${crm?'CRM '+crm:'Médico Responsável'}
        </div>
      </div>
    </div>
  </div>`;
}

// Imprime evolução em 1 via (reutiliza imprimirEvolucao mas com wrapper)
function imprimirTudo(){
  if(!leitoAtual){ toast('Abra o prontuário de um paciente.',true); return; }
  // Abre as três impressões em sequência com delay
  setTimeout(()=>imprimirSolicitacoesExames(), 0);
  setTimeout(()=>imprimirPrescricaoDuasVias(), 800);
  setTimeout(()=>imprimirEvolucao(), 1600);
}


/* ════════════════════════════════════════════════════════════════════════════
   ROTINA DE EXAMES — TODOS OS LEITOS
   Modal com checkboxes + exames editáveis + impressão 4 por folha A4 paisagem
   ════════════════════════════════════════════════════════════════════════════ */

// Estado do modal de rotina
let _rotinaLeitos = []; // [{num, pac, diag, selecionado, exames:[]}]

async function abrirRotinaExames(){
  showLoading('Carregando leitos...');
  try{
    const ld = await _getLeitos();
    const data = hoje();
    sf('rotina-data', data);

    // Monta array de leitos ocupados, pré-marcados com rotina
    _rotinaLeitos = [];
    for(let i=1; i<=TOTAL_LEITOS; i++){
      const L = ld[i]||{};
      if(!L.ocupado || !L.pac) continue;
      _rotinaLeitos.push({
        num: i,
        pac: L.pac||'',
        diag: L.diag||'',
        selecionado: true,
        exames: [...SOL_ROTINA] // cópia da rotina padrão
      });
    }
    hideLoading();
    if(!_rotinaLeitos.length){ toast('Nenhum leito ocupado no momento.',true); return; }
    _rotinaRenderGrid();
    $('modal-rotina-exames').classList.add('show');
  }catch(e){ hideLoading(); toast('Erro: '+(e.message||e),true); }
}

function fecharRotinaExames(){ $('modal-rotina-exames').classList.remove('show'); }

function _rotinaMarcarTodos(v){
  _rotinaLeitos.forEach(l=>l.selecionado=v);
  _rotinaRenderGrid();
}

function _rotinaResetarExames(){
  _rotinaLeitos.forEach(l=>l.exames=[...SOL_ROTINA]);
  _rotinaRenderGrid();
}

function _rotinaRenderGrid(){
  const wrap=$('rotina-leitos-grid'); if(!wrap) return;
  wrap.innerHTML=_rotinaLeitos.map((l,idx)=>`
    <div class="rotina-leito-card ${l.selecionado?'selecionado':'desmarcado'}">
      <div class="rotina-leito-header">
        <label class="rotina-check-label">
          <input type="checkbox" ${l.selecionado?'checked':''}
            onchange="_rotinaLeitos[${idx}].selecionado=this.checked;this.closest('.rotina-leito-card').className='rotina-leito-card '+(this.checked?'selecionado':'desmarcado')">
          <span class="rotina-leito-num">Leito ${pad(l.num)}</span>
        </label>
        <span class="rotina-leito-pac" title="${l.pac}">${l.pac}</span>
      </div>
      ${l.diag?`<div class="rotina-leito-diag">${l.diag}</div>`:''}
      <div class="rotina-exames-lista" id="rotina-lista-${idx}">
        ${l.exames.map((e,ei)=>`
          <div class="rotina-exame-item">
            <span class="rotina-exame-txt">${e}</span>
            <button class="rotina-exame-del" onclick="_rotinaRemoverExame(${idx},${ei})" title="Remover">×</button>
          </div>`).join('')}
      </div>
      <div style="display:flex;gap:4px;margin-top:6px;">
        <input type="text" class="rotina-add-input" id="rotina-add-${idx}"
          placeholder="+ exame adicional" style="text-transform:uppercase;"
          onkeydown="if(event.key==='Enter'){_rotinaAddExame(${idx});event.preventDefault();}">
        <button class="btn btn-sm" style="padding:3px 8px;font-size:.72rem;" onclick="_rotinaAddExame(${idx})">+</button>
      </div>
    </div>
  `).join('');
}

function _rotinaRemoverExame(lIdx, eIdx){
  _rotinaLeitos[lIdx].exames.splice(eIdx,1);
  // Re-renderiza só o card afetado
  const wrap=$(`rotina-lista-${lIdx}`); if(!wrap) return;
  wrap.innerHTML=_rotinaLeitos[lIdx].exames.map((e,ei)=>`
    <div class="rotina-exame-item">
      <span class="rotina-exame-txt">${e}</span>
      <button class="rotina-exame-del" onclick="_rotinaRemoverExame(${lIdx},${ei})" title="Remover">×</button>
    </div>`).join('');
}

function _rotinaAddExame(lIdx){
  const inp=$(`rotina-add-${lIdx}`); if(!inp) return;
  const v=(inp.value||'').trim().toUpperCase();
  if(!v) return;
  _rotinaLeitos[lIdx].exames.push(v);
  inp.value='';
  const wrap=$(`rotina-lista-${lIdx}`); if(!wrap) return;
  wrap.innerHTML=_rotinaLeitos[lIdx].exames.map((e,ei)=>`
    <div class="rotina-exame-item">
      <span class="rotina-exame-txt">${e}</span>
      <button class="rotina-exame-del" onclick="_rotinaRemoverExame(${lIdx},${ei})" title="Remover">×</button>
    </div>`).join('');
  inp.focus();
}

// Salva no Firebase e depois imprime
async function salvarESimprimirRotina(){
  const data=gf('rotina-data')||hoje();
  const selecionados=_rotinaLeitos.filter(l=>l.selecionado&&l.exames.length);
  if(!selecionados.length){ toast('Selecione ao menos um leito.',true); return; }
  showLoading('Salvando...');
  try{
    const med=perfilUsuario?perfilUsuario.nome:'';
    const crm=perfilUsuario?perfilUsuario.crm||'':'';
    await Promise.all(selecionados.map(l=>{
      const key=`uti_med_sol_exam_${l.num}_${data}_${Date.now()}_${l.num}`;
      return dbSet(key,{
        pac:l.pac, leito:pad(l.num), data,
        exames:l.exames, indicacao:'EXAMES DE ROTINA UTI',
        medNome:med, medCrm:crm,
        salvadoEm:new Date().toISOString()
      });
    }));
    hideLoading();
    toast(`<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M2.5 8.5l3.5 3.5 7.5-7.5"/></svg> ${selecionados.length} solicitações salvas.`);
    imprimirRotinaExames();
  }catch(e){ hideLoading(); toast('Erro: '+(e.message||e),true); }
}

// Imprime A4 paisagem, 4 leitos por folha (2×2)
function imprimirRotinaExames(){
  const data=gf('rotina-data')||hoje();
  const selecionados=_rotinaLeitos.filter(l=>l.selecionado&&l.exames.length);
  if(!selecionados.length){ toast('Selecione ao menos um leito.',true); return; }
  const med=(perfilUsuario?perfilUsuario.nome:'').toUpperCase();
  const crm=perfilUsuario?perfilUsuario.crm||'':'';
  const dataFmt=_fmtDataCurta(data)||data;

  // Gera um bloco HTML para cada leito
  function blocoLeito(l){
    const itens=l.exames.map(e=>`<li>${e}</li>`).join('');
    return `
      <div class="bloco">
        <div class="bloco-cab">
          <div class="bloco-logo-wrap">
            <img src="logo.png" class="bloco-logo" alt="" onerror="this.style.display='none'">
          </div>
          <div class="bloco-id">
            <table class="id-table">
              <tr>
                <td class="id-lbl">NOME:</td>
                <td class="id-val"><strong>${l.pac.toUpperCase()}</strong></td>
              </tr>
              <tr>
                <td class="id-lbl">DATA&nbsp;${dataFmt}</td>
                <td class="id-val" style="text-align:right;"><strong>LEITO: ${pad(l.num)}</strong></td>
              </tr>
            </table>
          </div>
        </div>
        <div class="bloco-body">
          <div class="solicito">SOLICITO:</div>
          <ul class="exames-ul">${itens}</ul>
        </div>
        <div class="bloco-assin">
          <div class="assin-linha">${med}${crm?' — CRM '+crm:''}</div>
        </div>
      </div>`;
  }

  // Agrupa em páginas de 4 (2×2)
  const paginas=[];
  for(let i=0;i<selecionados.length;i+=4) paginas.push(selecionados.slice(i,i+4));

  const paginasHtml=paginas.map((grupo,pi)=>{
    // Sempre 4 células (preenche com vazio se precisar)
    const celulas=Array.from({length:4},(_, ci)=>
      ci<grupo.length ? blocoLeito(grupo[ci]) : '<div class="bloco bloco-vazio"></div>'
    );
    const pageBreak=pi<paginas.length-1?'page-break-after:always;':'';
    return `<div class="pagina" style="${pageBreak}">
      <div class="grid2x2">
        ${celulas[0]}${celulas[1]}
        ${celulas[2]}${celulas[3]}
      </div>
    </div>`;
  }).join('');

  const html=`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
  <title>Rotina de Exames — ${dataFmt}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    @page{size:A4 landscape;margin:.7cm}
    body{font-family:'Arial Narrow',Arial,sans-serif;font-size:9pt;background:white;color:#000;}
    .pagina{width:100%;height:100%;}
    .grid2x2{
      display:grid;
      grid-template-columns:1fr 1fr;
      grid-template-rows:1fr 1fr;
      gap:6px;
      width:100%; height:100%;
    }
    .bloco{
      border:1.5px solid #000;
      display:flex; flex-direction:column;
      padding:6px 8px; overflow:hidden;
      min-height:0;
    }
    .bloco-vazio{ border:1.5px dashed #ccc; }
    /* Cabeçalho do bloco */
    .bloco-cab{
      display:flex; align-items:flex-start; gap:8px;
      border-bottom:2px solid #c00; padding-bottom:5px; margin-bottom:5px;
    }
    .bloco-logo-wrap{ flex-shrink:0; }
    .bloco-logo{ height:36px; width:auto; }
    .bloco-id{ flex:1; }
    .id-table{ width:100%; border-collapse:collapse; }
    .id-table td{ padding:2px 3px; }
    .id-lbl{ font-weight:800; font-size:8pt; width:50px; }
    .id-val{ font-size:9pt; border-left:1px solid #999; padding-left:5px; }
    /* Corpo */
    .bloco-body{ flex:1; padding:4px 0; overflow:hidden; }
    .solicito{ font-weight:800; font-size:9pt; margin-bottom:4px; }
    .exames-ul{
      list-style:none; padding:0; margin:0 0 0 8px;
      columns:2; column-gap:12px;
    }
    .exames-ul li{
      font-size:9pt; padding:1px 0; break-inside:avoid;
      display:flex; align-items:baseline; gap:4px;
    }
    .exames-ul li::before{ content:"—"; color:#555; flex-shrink:0; }
    /* Assinatura */
    .bloco-assin{
      border-top:1px solid #999; margin-top:4px; padding-top:3px;
      text-align:right; font-size:7.5pt; color:#555;
    }
    .assin-linha{ display:inline-block; }
    @media print{
      .pagina{ page-break-after:always; }
      .pagina:last-child{ page-break-after:avoid; }
    }
  </style></head><body>
  ${paginasHtml}
  <script>window.onload=()=>{window.print();window.onafterprint=()=>window.close();}<\/script>
  </body></html>`;

  const w=window.open('','_blank','width=1100,height=800');
  if(w){ w.document.write(html); w.document.close(); }
  else toast('Popup bloqueado — permita popups para imprimir.',true);
}

/* ════════════════════════════════════════════════════════════════════════════
   REQUISIÇÃO DE EXAMES MICROBIOLÓGICOS (CULTURAS)
   ════════════════════════════════════════════════════════════════════════════ */

function _cultToggleSub(cb, subId){
  const el=$(subId); if(el) el.style.display=cb.checked?'':'none';
}

function abrirSolicitacaoCultura(){
  // Auto-preenche dados do paciente
  sf('cult-nome',  (gf('f-pac')||'').toUpperCase());
  sf('cult-leito', gf('f-leito')||'');
  // Idade calculada
  const dn=gf('f-dn');
  if(dn){ const a=Math.floor((new Date()-new Date(dn+'T00:00:00'))/31557600000); sf('cult-idade',a); }
  // Sexo
  const s=(gf('f-sexo')||'').toUpperCase();
  const sel=$('cult-sexo');
  if(sel) sel.value=s.includes('FEM')?'F':s.includes('MAS')?'M':'';
  // Data/hora coleta
  // Data/hora coleta — deixados em branco para preenchimento manual na coleta
  sf('cult-data-coleta', '');
  sf('cult-hora-coleta', '');
  // Indicação clínica do diagnóstico
  sf('cult-indicacao', (gf('f-diag')||'').toUpperCase());
  // Limpar checkboxes
  ['cult-uro','cult-copro','cult-hemo','cult-cateter','cult-sec','cult-liq',
   'cult-frag','cult-bk','cult-fungos','cult-vig','cult-bordet','cult-virus',
   'cult-fresco','cult-gram','cult-ziehl',
   'cult-sec-traq','cult-sec-fo','cult-sec-up','cult-sec-abs','cult-sec-out',
   'cult-liq-liquor','cult-liq-pleural','cult-liq-sinov','cult-liq-ascit',
   'cult-vig-nasal','cult-vig-retal'].forEach(id=>{const e=$(id); if(e) e.checked=false;});
  ['cult-uro-opts','cult-sec-opts','cult-liq-opts','cult-vig-opts','cult-atb-quais-wrap']
    .forEach(id=>{const e=$(id); if(e) e.style.display='none';});
  sf('cult-obs',''); sf('cult-reg',''); sf('cult-virus-txt','');
  sf('cult-sec-out-txt',''); sf('cult-liq-out-txt',''); sf('cult-vig-out-txt',''); sf('cult-atb-quais','');
  $('modal-cultura').classList.add('show');
}

function fecharSolicitacaoCultura(){ $('modal-cultura').classList.remove('show'); }

function _coletarCultura(){
  const intern=document.querySelector('input[name="cult-intern"]:checked');
  const atb=document.querySelector('input[name="cult-atb"]:checked');
  const transf=document.querySelector('input[name="cult-transf"]:checked');
  const tipoInf=document.querySelector('input[name="cult-tipo-inf"]:checked');
  const uroTp=document.querySelector('input[name="cult-uro-tp"]:checked');
  const chk=id=>$(id)&&$(id).checked;
  return {
    pac:gf('cult-nome'), leito:gf('cult-leito'), registro:gf('cult-reg'),
    idade:gf('cult-idade'), sexo:gf('cult-sexo')?.toUpperCase(),
    ward:gf('cult-ward'), indicacao:gf('cult-indicacao'),
    internado72h:intern?intern.value:'N',
    atbUltimos10:atb?atb.value:'N', atbQuais:gf('cult-atb-quais'),
    transferido:transf?transf.value:'N',
    tipoInfeccao:tipoInf?tipoInf.value:'H',
    dataColeta:gf('cult-data-coleta'), horaColeta:gf('cult-hora-coleta'),
    obs:gf('cult-obs'),
    // Exames selecionados
    uro:chk('cult-uro'), uroTp:uroTp?uroTp.value:'',
    copro:chk('cult-copro'), hemo:chk('cult-hemo'), hemoN:parseInt(gf('cult-hemo-n'))||1, cateter:chk('cult-cateter'),
    sec:chk('cult-sec'),
    secSubs:['traq','fo','up','abs'].filter(t=>chk('cult-sec-'+t)),
    secOutros:gf('cult-sec-out-txt'),
    liq:chk('cult-liq'),
    liqSubs:['liquor','pleural','sinov','ascit'].filter(t=>chk('cult-liq-'+t)),
    liqOutros:gf('cult-liq-out-txt'),
    frag:chk('cult-frag'), bk:chk('cult-bk'), fungos:chk('cult-fungos'),
    vig:chk('cult-vig'),
    vigSubs:['nasal','retal'].filter(t=>chk('cult-vig-'+t)),
    vigOutros:gf('cult-vig-out-txt'),
    bordet:chk('cult-bordet'), virus:chk('cult-virus'), virusTxt:gf('cult-virus-txt'),
    fresco:chk('cult-fresco'), gram:chk('cult-gram'), ziehl:chk('cult-ziehl'),
    medNome:perfilUsuario?perfilUsuario.nome:'', medCrm:perfilUsuario?perfilUsuario.crm||'':'',
    data:gf('cult-data-coleta')||hoje(), autor:usuarioEmail,
    salvadoEm:new Date().toISOString()
  };
}

// Resumo para o card do histórico
// Retorna array de strings, cada uma = 1 etiqueta individual.
// Ex: Hemo 2 pares <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M3 8h10"/><path d="M9.5 4.5L13 8l-3.5 3.5"/></svg> ['HEMOCULTURA 1ª AMOSTRA','HEMOCULTURA 2ª AMOSTRA']
function _cultResumir(c){
  const lista=[];

  // Urocultura
  if(c.uro){
    const tp = c.uroTp==='svd'?'SVD':c.uroTp==='jato'?'JATO MÉDIO':c.uroTp==='aliv'?'SONDA DE ALÍVIO':'';
    lista.push('UROCULTURA'+(tp?' ('+tp+')':''));
  }

  // Coprocultura
  if(c.copro) lista.push('COPROCULTURA');

  // Hemocultura — 1 etiqueta por amostra (par)
  if(c.hemo){
    const n = Math.max(1, parseInt(c.hemoN)||1);
    const ord = ['1ª','2ª','3ª','4ª'];
    for(let i=0;i<n;i++)
      lista.push('HEMOCULTURA '+(ord[i]||`${i+1}ª`)+' AMOSTRA');
  }

  // Ponta de cateter
  if(c.cateter) lista.push('PONTA DE CATETER');

  // Secreção — 1 etiqueta por sítio
  if(c.sec){
    const MAP_SEC={traq:'SECREÇÃO TRAQUEAL',fo:'SECREÇÃO / FERIDA OPERATÓRIA',up:'SECREÇÃO / ÚLCERA DE PRESSÃO',abs:'SECREÇÃO / ABSCESSO'};
    const subs=c.secSubs||[];
    if(subs.length) subs.forEach(t=>lista.push(MAP_SEC[t]||'SECREÇÃO ('+t.toUpperCase()+')'));
    else lista.push('SECREÇÃO');
    if(c.secOutros&&c.secOutros.trim()) lista.push('SECREÇÃO / '+c.secOutros.trim().toUpperCase());
  }

  // Líquidos cavitários — 1 etiqueta por tipo
  if(c.liq){
    const MAP_LIQ={liquor:'LÍQUOR',pleural:'LÍQUIDO PLEURAL',sinov:'LÍQUIDO SINOVIAL',ascit:'LÍQUIDO ASCÍTICO'};
    const subs=c.liqSubs||[];
    if(subs.length) subs.forEach(t=>lista.push(MAP_LIQ[t]||'LÍQ. CAVITÁRIO ('+t.toUpperCase()+')'));
    else lista.push('LÍQ. CAVITÁRIO');
    if(c.liqOutros&&c.liqOutros.trim()) lista.push('LÍQ. CAVITÁRIO / '+c.liqOutros.trim().toUpperCase());
  }

  // Fragmento, BK, Fungos
  if(c.frag) lista.push('FRAGMENTO DE TECIDO');
  if(c.bk)   lista.push('BK (MYCOBACTERIUM)');
  if(c.fungos) lista.push('FUNGOS');

  // Vigilância — 1 etiqueta por swab
  if(c.vig){
    const MAP_VIG={nasal:'SWAB NASAL',retal:'SWAB RETAL'};
    const subs=c.vigSubs||[];
    if(subs.length) subs.forEach(t=>lista.push('VIGILÂNCIA / '+(MAP_VIG[t]||t.toUpperCase())));
    else lista.push('VIGILÂNCIA');
    if(c.vigOutros&&c.vigOutros.trim()) lista.push('VIGILÂNCIA / '+c.vigOutros.trim().toUpperCase());
  }

  // Outros exames
  if(c.bordet) lista.push('BORDETELLA PERTUSSIS');
  if(c.virus)  lista.push('VÍRUS RESP.'+(c.virusTxt?' ('+c.virusTxt.trim().toUpperCase()+')':''));
  if(c.gram)   lista.push('MICROSCOPIA GRAM');
  if(c.fresco) lista.push('MICROSCOPIA A FRESCO');
  if(c.ziehl)  lista.push('ZIEHL-NEELSEN');

  return lista.length?lista:['CULTURA'];
}

/* ════════════════════════════════════════════════════════════════════════════
   REQUISIÇÃO DE PARECER
   ════════════════════════════════════════════════════════════════════════════ */

// Especialidades com filtros de medicações relevantes para cada uma
const _PARECER_MEDS_FILTROS = {
  'Nefrologia':        /furosemida|hidroclorotiazida|espironolactona|torasemida|diuret|nefro|tacrolimo|ciclosporina|vancomicina|amicacina|gentamicina|anfotericina|polimixina|contraste|aciclovir|metformina|ieca|sartan|losartana|enalapril|captopril|sódio|potássio|bicarbonato/i,
  'Infectologia':      /antibio|atb|meropenem|imipenem|piperacilina|vancomicina|polimixina|tigeciclin|colistin|ceftriaxona|cefepime|ceftazidima|amicacina|gentamicina|metronidazol|fluconazol|voriconazol|anidulafungin|aciclovir|ganciclovir|oseltamivir|clindamicina|azitromicina|linezolida|daptomicin|ertapenem/i,
  'Cardiologia':       /noradrenalina|adrenalina|dopamina|dobutamina|vasopressin|nora|amiodarona|lidocaina|adenosina|metoprolol|atenolol|carvedilol|bisoprolol|digoxin|furosemida|captopril|enalapril|losartana|hidralazina|nitroprussiato|nitroglicerina|heparina|enoxaparina|varfarina|aspirina|clopidogrel|estatina|sinvastatina|atorvastatina/i,
  'Pneumologia':       /salbutamol|fenoterol|ipratropio|budesonida|fluticasona|beclometasona|teofilina|aminofilina|acetilcisteina|dornase|sildenafila|bosentan|prostaciclin|surfactante/i,
  'Endocrinologia':    /insulina|metformina|glibenclamida|sitagliptina|empagliflozina|dexametasona|hidrocortisona|metilprednisolona|prednisolona|prednisona|levotiroxina|amiodarona|glucagon|ocreotida/i,
  'Gastroenterologia': /omeprazol|pantoprazol|esomeprazol|ranitidina|metoclopramida|domperidona|ondansetrona|lactulose|neomicina|rifaximina|octreotida|somatostatina|sucralfato/i,
  'Hematologia':       /heparina|enoxaparina|varfarina|rivaroxabana|apixabana|acido tranexamico|vitamina k|desmopressin|filgrastim|eritropoetina|hidroxiureia|vincristina|rituximabe/i,
  'Neurologia':        /fenitoina|acido valproico|levetiracetam|carbamazepina|midazolam|propofol|fentanil|morfina|tramadol|gabapentina|pregabalina|amitriptilina|haloperidol|quetiapina|clonazepam|nimodipina/i,
  'default':           /noradrenalina|adrenalina|dopamina|dobutamina|vasopressin|nora|furosemida|heparina|enoxaparina|vancomicina|meropenem|imipenem|piperacilina|ceftriaxona|cefepime|amicacina|gentamicina|polimixina|metronidazol|fluconazol|insulina|hidrocortisona|omeprazol|pantoprazol/i
};

// Categorias sempre relevantes (independente da especialidade)
const _PARECER_CATS_SEMPRE = ['ATB','Droga Vasoativa'];

function _parEspecChange(){
  const sel = $('par-espec');
  const outra = $('par-espec-outra');
  if(!sel || !outra) return;
  if(sel.value === '__outra__'){
    outra.style.display = '';
    outra.focus();
  } else {
    outra.style.display = 'none';
    outra.value = '';
  }
  // Atualiza medicações relevantes ao trocar especialidade
  _parPreencherMeds();
}

async function abrirModalParecer(){
  if(!leitoAtual){ toast('Abra o prontuário de um paciente.',true); return; }

  // Dados básicos do paciente
  const pac    = gf('f-pac') || '';
  const dn     = gf('f-dn')  || '';
  const leito  = gf('f-leito') || pad(leitoAtual);
  const adm    = gf('f-adm')  || '';
  const diag   = gf('f-diag') || '';
  const alergia= gf('f-alergia') || '';
  const comor  = gf('f-comor') || '';
  const hda    = gf('f-hda')  || '';
  const admDesc= gf('f-adm-desc') || '';
  const evol   = gf('f-evol') || '';
  const condutas=gf('f-condutas') || '';

  // Idade
  const idadeNum = _idadeDeDN(dn);
  const idadeStr = idadeNum != null ? `${idadeNum} ANOS` : '';

  // Popula cabeçalho somente leitura
  sf('par-nome',    pac.toUpperCase());
  sf('par-leito',   'UTI ' + leito);
  sf('par-idade',   idadeStr);
  sf('par-adm',     adm ? _fmtDataCurta(adm) : '');
  sf('par-diag',    diag.toUpperCase());
  sf('par-alergia', alergia.toUpperCase());
  sf('par-comor',   comor.toUpperCase());
  sf('par-data',    gf('f-data') || hoje());

  // Médico
  if(perfilUsuario){
    sf('par-med', (perfilUsuario.nome||'').toUpperCase());
    sf('par-crm', perfilUsuario.crm||'');
  }

  // Monta resumo clínico automático
  const admDataFmt = adm ? _fmtDataCurta(adm) : '?';
  let resumo = '';
  if(admDesc && admDesc.trim()) resumo += `ADMISSÃO NA UTI (${admDataFmt}):\n${admDesc.trim()}\n\n`;
  else if(hda && hda.trim())    resumo += `HISTÓRIA DA DOENÇA ATUAL:\n${hda.trim()}\n\n`;
  if(evol && evol.trim())       resumo += `EVOLUÇÃO ATUAL:\n${evol.trim()}\n\n`;
  if(condutas && condutas.trim()) resumo += `CONDUTA:\n${condutas.trim()}`;
  sf('par-resumo', resumo.trim());

  // Exames laboratoriais
  _parRecarregarLab();

  // Especialidade — limpa seleção anterior
  const selEspec = $('par-espec');
  if(selEspec) selEspec.value = '';
  const outraInp = $('par-espec-outra');
  if(outraInp){ outraInp.style.display = 'none'; outraInp.value = ''; }

  // Limpa motivo
  sf('par-motivo', '');

  // Medicações (carrega as default por ora; atualiza quando escolher especialidade)
  await _parPreencherMeds();

  $('modal-parecer').classList.add('show');
  _resizeModalTextareas('modal-parecer');
}

function fecharModalParecer(){ $('modal-parecer').classList.remove('show'); }

// Monta string de exames laboratoriais a partir de _labLinhas
function _parRecarregarLab(){
  if(!_labLinhas || !_labLinhas.length){ sf('par-lab',''); return; }
  const campLbl = Object.fromEntries(LAB_CAMPOS.map(c=>[c.k,c.l]));
  const sorted = _labLinhas.slice().sort((a,b)=>(b.data||'').localeCompare(a.data||''));
  const txt = sorted.map(lin=>{
    const vals = Object.entries(lin.valores||{})
      .filter(([,v])=>v!=null&&v!=='')
      .map(([k,v])=>`${campLbl[k]||k}: ${v}`)
      .join('  |  ');
    return vals ? `${_fmtDataCurta(lin.data)||'?'}: ${vals}` : null;
  }).filter(Boolean).join('\n');
  sf('par-lab', txt);
}

// Filtra medicações relevantes para a especialidade selecionada
async function _parPreencherMeds(){
  // Tenta usar _rxItens (já carregados); se vazio, busca do Firebase
  let itens = _rxItens && _rxItens.length ? _rxItens : [];
  if(!itens.length && leitoAtual){
    try{
      const data = gf('f-data') || hoje();
      const key = `uti_med_rx_${leitoAtual}_${data}`;
      let saved = await dbGet(key);
      if(!saved || !saved.itens || !saved.itens.length){
        const todas = await dbListByPrefix(`uti_med_rx_${leitoAtual}_`);
        const ord = Object.values(todas).filter(r=>r&&r.itens&&r.itens.length).sort((a,b)=>b.data.localeCompare(a.data));
        saved = ord[0] || null;
      }
      itens = saved && saved.itens ? saved.itens : [];
    } catch(e){ itens = []; }
  }

  // Medicamentos de uso contínuo (do campo f-medcont)
  const medcont = (gf('f-medcont')||'').split(/\s*\|\s*|[,;]+/).map(s=>s.trim()).filter(Boolean);

  // Determina regex do filtro conforme especialidade
  const espec = ($('par-espec')||{}).value || '';
  const especNome = espec === '__outra__' ? ($('par-espec-outra')||{}).value||'' : espec;
  const re = _PARECER_MEDS_FILTROS[especNome] || _PARECER_MEDS_FILTROS['default'];

  // Filtra: categorias sempre relevantes OU bate no regex da especialidade
  const selecionados = itens.filter(it=>{
    if(!it.farm) return false;
    if(_PARECER_CATS_SEMPRE.includes(it._cat)) return true;
    return re.test(it.farm);
  });

  // Formata cada medicação: "FARMACO DOSE via FREQ (CAT)"
  const linhas = selecionados.map(it=>{
    const parts = [it.farm.toUpperCase()];
    if(it.dose)  parts.push(it.dose.toUpperCase());
    if(it.via)   parts.push(it.via);
    if(it.freq)  parts.push(it.freq);
    if(it._cat && it._cat !== 'Medicação Geral') parts.push(`(${it._cat.toUpperCase()})`);
    // Dias de ATB se houver
    if(it.ddInicio){
      const dias = Math.round((new Date()-new Date(it.ddInicio+'T00:00:00'))/86400000);
      if(dias>=0) parts.push(`D${dias+1}`);
    }
    return '• ' + parts.join(' ');
  });

  // Adiciona uso contínuo não sobreposto
  medcont.forEach(m=>{
    const mUp = m.toUpperCase();
    const jatem = linhas.some(l=>l.toUpperCase().includes(mUp.split(/\s+/)[0]));
    if(!jatem && re.test(m)) linhas.push('• ' + mUp + ' (USO CONTÍNUO)');
  });

  sf('par-meds', linhas.join('\n'));
}

// Coleta todos os dados do modal
function _coletarParecer(){
  const espec = ($('par-espec')||{}).value || '';
  const especNome = espec === '__outra__'
    ? (($('par-espec-outra')||{}).value||'').toUpperCase()
    : espec.toUpperCase();
  return {
    espec:    especNome,
    pac:      gf('par-nome'),
    leito:    gf('par-leito'),
    idade:    gf('par-idade'),
    adm:      gf('par-adm'),
    diag:     gf('par-diag'),
    alergia:  gf('par-alergia'),
    comor:    gf('par-comor'),
    resumo:   gf('par-resumo'),
    lab:      gf('par-lab'),
    meds:     gf('par-meds'),
    motivo:   gf('par-motivo'),
    data:     gf('par-data') || hoje(),
    medNome:  gf('par-med'),
    medCrm:   gf('par-crm'),
    autor:    usuarioEmail,
    salvadoEm: new Date().toISOString(),
  };
}

async function salvarParecer(){
  const p = _coletarParecer();
  if(!p.espec){ toast('Selecione a especialidade.',true); return; }
  if(!p.motivo.trim()){ toast('Preencha o motivo da solicitação.',true); return; }
  if(!leitoAtual){ toast('Abra o prontuário.',true); return; }
  showLoading('Salvando parecer...');
  try{
    const key = `uti_med_parecer_${leitoAtual}_${p.data}_${Date.now()}`;
    await dbSet(key, p);
    hideLoading();
    toast('<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M2.5 8.5l3.5 3.5 7.5-7.5"/></svg> Parecer salvo.');
    _renderHistoricoSolicitacoes();
  } catch(e){ hideLoading(); toast('Erro: '+(e.message||e),true); }
}

function imprimirParecer(){ _imprimirParecerObj(_coletarParecer()); }

async function _imprimirParecerChave(key){
  showLoading('Carregando...');
  try{ const p=await dbGet(key); hideLoading(); if(p) _imprimirParecerObj(p); }
  catch(e){ hideLoading(); toast('Erro: '+(e.message||e),true); }
}

function _imprimirParecerObj(p){
  if(!p.espec){ toast('Selecione a especialidade antes de imprimir.',true); return; }
  const dataFmt = p.data ? _fmtDataCurta(p.data) : '___/___/______';
  const admFmt  = p.adm  || '___/___/______';

  // Serviço: HOSPESC – UNIDADE DE TERAPIA INTENSIVA
  // Formata o resumo preservando quebras de linha
  const _esc  = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const _nl2br= s => _esc(s).replace(/\n/g,'<br>');

  const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
  <title>Requisição de Parecer — ${p.pac||''}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Times New Roman',Times,serif;font-size:9pt;color:#000;background:#fff;}
    @page{size:A4 portrait;margin:0.7cm 1.2cm 0.7cm 1.2cm;}
    html,body{height:auto;overflow:visible;}
    .cab{text-align:center;border-bottom:2px solid #000;padding-bottom:4px;margin-bottom:6px;}
    .cab-inst{font-size:7.5pt;font-weight:700;letter-spacing:.04em;}
    .cab-titulo{font-size:10.5pt;font-weight:800;margin:2px 0;letter-spacing:.06em;text-transform:uppercase;}
    .cab-sub{font-size:8.5pt;font-weight:700;text-decoration:underline;letter-spacing:.04em;}
    table.ident{width:100%;border-collapse:collapse;margin-bottom:0;}
    table.ident td{border:1.5px solid #000;padding:2px 6px;font-size:8.5pt;vertical-align:top;}
    .lbl{font-size:6.5pt;font-weight:700;display:block;margin-bottom:1px;letter-spacing:.04em;}
    .val{font-size:9pt;font-weight:700;}
    .bloco{border:1.5px solid #000;border-top:none;width:100%;}
    .bloco-inner{padding:3px 8px;min-height:16px;font-size:8.5pt;line-height:1.4;}
    .bloco-lbl{background:#000;color:#fff;font-size:7pt;font-weight:800;padding:2px 8px;letter-spacing:.06em;text-transform:uppercase;}
    .rodape{margin-top:7px;display:flex;justify-content:space-between;align-items:flex-end;}
    .assin{text-align:center;}
    .assin-linha{border-top:1.5px solid #000;padding-top:3px;font-size:7.5pt;min-width:180px;margin-top:20px;}
    .parecer-box{border:1.5px solid #000;border-top:none;min-height:50px;padding:6px 8px;}
    @media print{body{margin:0;}*{-webkit-print-color-adjust:exact;print-color-adjust:exact;}}
  </style></head><body>

  <!-- Cabeçalho institucional -->
  <div class="cab">
    <div class="cab-inst">SECRETARIA MUNICIPAL DE SAÚDE · HOSPITAL DOS PESCADORES · NÚCLEO INTERNO DE REGULAÇÃO – NIR</div>
    <div class="cab-titulo">Requisição de Parecer</div>
  </div>

  <!-- Identificação -->
  <table class="ident">
    <tr>
      <td style="width:70%;">
        <span class="lbl">NOME</span>
        <span class="val">${_esc(p.pac||'')}</span>
      </td>
      <td style="width:30%;">
        <span class="lbl">IDADE</span>
        <span class="val">${_esc(p.idade||'')}</span>
      </td>
    </tr>
    <tr>
      <td>
        <span class="lbl">SERVIÇO</span>
        <span class="val">HOSPESC – UNIDADE DE TERAPIA INTENSIVA</span>
      </td>
      <td>
        <span class="lbl">LEITO</span>
        <span class="val">${_esc(p.leito||'')}</span>
      </td>
    </tr>
    <tr>
      <td colspan="2">
        <span class="lbl">AO SERVIÇO DE</span>
        <span class="val">${_esc(p.espec||'')}</span>
      </td>
    </tr>
  </table>

  <!-- Bloco de anamnese unificado -->
  <div style="border:1.5px solid #000;border-top:none;">
    <div class="bloco-lbl">ADMISSÃO NA UTI HOSPESC: ${admFmt} &nbsp;|&nbsp; HIPÓTESE DIAGNÓSTICA: ${_esc((p.diag||'').toUpperCase())}</div>
    <div style="padding:3px 10px 4px;font-size:9pt;border-bottom:1px solid #ccc;">
      <strong>ALERGIAS:</strong> ${_esc(p.alergia||'NEGA')} &nbsp;&nbsp;
      <strong>COMORBIDADES:</strong> ${_esc(p.comor||'')}
    </div>
    ${p.meds && p.meds.trim() ? `
    <div style="padding:3px 10px 4px;font-size:9pt;border-bottom:1px solid #ccc;">
      <strong>EM USO (MEDICAÇÕES RELEVANTES):</strong><br>
      <span style="white-space:pre-wrap;font-size:9pt;">${_esc(p.meds)}</span>
    </div>` : ''}
    <div class="bloco-inner" style="white-space:pre-wrap;">${_nl2br(p.resumo||'')}</div>
    ${p.lab && p.lab.trim() ? `
    <div style="border-top:1px solid #ccc;">
      <div style="background:#f0f0f0;font-size:7.5pt;font-weight:800;padding:2px 10px;letter-spacing:.04em;">EXAMES LABORATORIAIS</div>
      <div style="padding:4px 10px;font-family:monospace;font-size:8.5pt;white-space:pre-wrap;line-height:1.5;">${_esc(p.lab)}</div>
    </div>` : ''}
    ${p.motivo && p.motivo.trim() ? `
    <div style="border-top:1px solid #000;">
      <div class="bloco-lbl">MOTIVO DA SOLICITAÇÃO</div>
      <div class="bloco-inner" style="white-space:pre-wrap;">${_nl2br(p.motivo)}</div>
    </div>` : ''}
  </div>

  <!-- Data e assinatura -->
  <div class="rodape">
    <div style="font-size:9pt;">Data: ${dataFmt}</div>
    <div class="assin">
      <div class="assin-linha">
        ${_esc((p.medNome||'').toUpperCase())}${p.medCrm?' &nbsp;|&nbsp; CRM '+_esc(p.medCrm):''}<br>
        Médico Solicitante
      </div>
    </div>
  </div>

  <!-- Espaço para o Parecer -->
  <div style="margin-top:10px;">
    <div class="bloco-lbl" style="border:1.5px solid #000;border-bottom:none;">PARECER</div>
    <div class="parecer-box"></div>
  </div>

  <script>window.onload=()=>{window.print();window.onafterprint=()=>window.close();}<\/script>
  </body></html>`;

  const w = window.open('', '_blank', 'width=850,height=1000');
  if(w){ w.document.write(html); w.document.close(); }
  else toast('Popup bloqueado — permita popups para imprimir.', true);
}

/* ════════════════════════════════════════════════════════════════════════════
   PLANO TERAPÊUTICO — SOLICITAÇÃO DE VENTILADOR (TRILOGY)
   ════════════════════════════════════════════════════════════════════════════ */

const _TRILOGY_CIDS_PADRAO =
`J96 – Insuficiência respiratória
I50 – Insuficiência cardíaca congestiva
J44 – Doença pulmonar obstrutiva crônica
N18 – Doença renal crônica
R57.0 – Choque cardiogênico`;

function abrirModalTrilogy(){
  if(!leitoAtual){ toast('Abra o prontuário de um paciente.',true); return; }

  const pac    = gf('f-pac') || '';
  const cns    = gf('f-cns') || '';
  const dn     = gf('f-dn')  || '';
  const adm    = gf('f-adm') || '';
  const comor  = gf('f-comor') || '';
  const diag   = gf('f-diag') || '';
  const cid    = gf('f-cid')  || '';
  const evol   = gf('f-evol') || '';
  const hda    = gf('f-hda')  || '';
  const admDesc= gf('f-adm-desc') || '';
  const vent   = gf('f-vent') || '';
  const ventParam = gf('f-vent-param') || '';
  const fio2   = gf('f-fio2') || '';
  const leito  = gf('f-leito') || pad(leitoAtual);

  const idadeNum = _idadeDeDN(dn);
  const idadeStr = idadeNum != null ? `${idadeNum} anos de idade` : '';

  sf('tri-pac',   pac.toUpperCase());
  sf('tri-cns',   cns);
  sf('tri-idade', idadeStr);
  sf('tri-adm',   adm);
  sf('tri-data',  gf('f-data') || hoje());

  // Diagnóstico principal — usa diag do formulário
  sf('tri-diag-princ', diag ? diag.toLowerCase() : '');

  // Comorbidades
  sf('tri-comor', comor ? comor.toLowerCase() : '');

  // Evolução clínica — combina HDA + admDesc + evolução atual
  let evolTxt = '';
  if(admDesc && admDesc.trim()) evolTxt += admDesc.trim();
  if(evol && evol.trim()){
    if(evolTxt) evolTxt += '\n\n';
    evolTxt += evol.trim();
  } else if(hda && hda.trim() && !evolTxt){
    evolTxt = hda.trim();
  }
  sf('tri-evol', evolTxt);

  // Estado atual — extraído da ventilação atual
  let atualTxt = 'Atualmente encontra-se ';
  if(vent === 'VMI') atualTxt += 'dependente de ventilação mecânica invasiva';
  else if(vent === 'VNI') atualTxt += 'em ventilação não invasiva (VNI)';
  else if(vent === 'AA') atualTxt += 'em ar ambiente';
  else atualTxt += 'em suporte ventilatório';
  if(ventParam) atualTxt += `, com os seguintes parâmetros: ${ventParam}`;
  atualTxt += ', apresentando dificuldade no desmame ventilatório e necessidade de continuidade do suporte para possibilitar alta da UTI e seguimento da reabilitação.';
  sf('tri-atual', atualTxt);

  // Parâmetros ventilatórios — tenta extrair do ventParam e fio2
  sf('tri-modo', vent === 'VMI' ? 'PSV' : vent === 'VNI' ? 'CPAP/PSV' : '');
  sf('tri-fio2', fio2 ? Math.round(parseFloat(fio2)*100).toString() : '');
  sf('tri-peep', '');
  sf('tri-ps', '');
  sf('tri-fr', '');
  // Via
  const viaEl = $('tri-via');
  if(viaEl) viaEl.value = 'traqueostomia';

  // Obs técnicas
  sf('tri-obs-tec',
    'Modo espontâneo com ciclagem a tempo\n' +
    'Backup de frequência respiratória de segurança\n' +
    'Necessidade de adaptação para traqueostomia\n' +
    'Suporte de oxigenioterapia conforme necessidade clínica');

  // CIDs — usa o CID do paciente mais os padrão
  let cidsBase = _TRILOGY_CIDS_PADRAO;
  if(cid && !cidsBase.includes(cid.toUpperCase())){
    cidsBase = `${cid.toUpperCase()} – ${diag||'Ver prontuário'}\n` + cidsBase;
  }
  sf('tri-cids', cidsBase);

  // Médico
  if(perfilUsuario){
    sf('tri-med', (perfilUsuario.nome||'').toUpperCase());
    sf('tri-crm', perfilUsuario.crm||'');
  }

  $('modal-trilogy').classList.add('show');
  _resizeModalTextareas('modal-trilogy');
}

function fecharModalTrilogy(){ $('modal-trilogy').classList.remove('show'); }

function _coletarTrilogy(){
  const via = ($('tri-via')||{}).value || 'traqueostomia';
  const viaMap = { traqueostomia:'traqueostomia', tracheo_nasal:'máscara nasal',
                   facial:'máscara facial', nasal_pillow:'nasal pillow' };
  const modo = gf('tri-modo') || '';
  const ps   = gf('tri-ps')   || '';
  const peep = gf('tri-peep') || '';
  const fio2 = gf('tri-fio2') || '';
  const fr   = gf('tri-fr')   || '';
  // Monta string de parâmetros
  const params = [
    modo  ? `Modo: ${modo}` : '',
    ps    ? `PS: ${ps} cmH₂O` : '',
    peep  ? `PEEP: ${peep} cmH₂O` : '',
    fio2  ? `FiO₂: ${fio2}%` : '',
    fr    ? `FR backup: ${fr}` : '',
  ].filter(Boolean).join(' · ');

  const adm = gf('tri-adm');

  return {
    pac:      gf('tri-pac'),
    cns:      gf('tri-cns'),
    idade:    gf('tri-idade'),
    adm,
    admFmt:   adm ? _fmtDataCurta(adm) : '',
    data:     gf('tri-data') || hoje(),
    diagPrinc:gf('tri-diag-princ'),
    comor:    gf('tri-comor'),
    evol:     gf('tri-evol'),
    atual:    gf('tri-atual'),
    params,
    via:      viaMap[via] || via,
    obsTec:   gf('tri-obs-tec'),
    cids:     gf('tri-cids'),
    medNome:  gf('tri-med'),
    medCrm:   gf('tri-crm'),
    autor:    usuarioEmail,
    autorNome: perfilUsuario ? perfilUsuario.nome : '',
    salvadoEm: new Date().toISOString(),
  };
}

async function salvarTrilogy(){
  const t = _coletarTrilogy();
  if(!t.pac.trim()){ toast('Informe o paciente.',true); return; }
  if(!t.diagPrinc.trim()){ toast('Informe o diagnóstico principal.',true); return; }
  if(!leitoAtual){ toast('Abra o prontuário.',true); return; }
  showLoading('Salvando...');
  try{
    const key = `uti_med_trilogy_${leitoAtual}_${t.data}_${Date.now()}`;
    await dbSet(key, t);
    hideLoading(); toast('<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M2.5 8.5l3.5 3.5 7.5-7.5"/></svg> Plano terapêutico salvo.');
    _renderGuiasFichas();
  }catch(e){ hideLoading(); toast('Erro: '+(e.message||e),true); }
}

function imprimirTrilogy(){ _imprimirTrilogyObj(_coletarTrilogy()); }

async function _imprimirTrilogyChave(key){
  showLoading('Carregando...');
  try{ const t=await dbGet(key); hideLoading(); if(t) _imprimirTrilogyObj(t); }
  catch(e){ hideLoading(); toast('Erro: '+(e.message||e),true); }
}

async function _abrirTrilogyExistente(key){
  showLoading('Carregando...');
  try{
    const t = await dbGet(key); hideLoading();
    if(!t){ toast('Registro não encontrado.',true); return; }
    sf('tri-pac', t.pac||''); sf('tri-cns', t.cns||'');
    sf('tri-idade', t.idade||''); sf('tri-adm', t.adm||''); sf('tri-data', t.data||hoje());
    sf('tri-diag-princ', t.diagPrinc||''); sf('tri-comor', t.comor||'');
    sf('tri-evol', t.evol||''); sf('tri-atual', t.atual||'');
    // Parâmetros — tenta desmontar a string params de volta
    sf('tri-cids', t.cids||_TRILOGY_CIDS_PADRAO);
    sf('tri-obs-tec', t.obsTec||'');
    sf('tri-med', t.medNome||''); sf('tri-crm', t.medCrm||'');
    $('modal-trilogy').classList.add('show');
    _resizeModalTextareas('modal-trilogy');
  }catch(e){ hideLoading(); toast('Erro: '+(e.message||e),true); }
}

function _imprimirTrilogyObj(t){
  if(!t.pac||!t.pac.trim()){ toast('Informe o paciente antes de imprimir.',true); return; }
  const _esc  = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const _nl2br= s => _esc(s).replace(/\n/g,'<br>');
  const _nl2p = s => (s||'').split('\n').filter(x=>x.trim()).map(l=>`<p>${_esc(l)}</p>`).join('');
  const _nl2li= s => (s||'').split('\n').filter(x=>x.trim())
    .map(l=>{ const t=l.replace(/^[•\-\*]\s*/,''); return `<li>${_esc(t)}</li>`; }).join('');

  const dataDoc = t.data ? _fmtDataCurta(t.data) : '___/___/______';
  const admFmt  = t.admFmt || (t.adm ? _fmtDataCurta(t.adm) : '___/___/______');

  const cidsLinhas = (t.cids||'').split('\n').filter(x=>x.trim())
    .map(l=>`<p style="margin:1px 0;">${_esc(l.trim())}</p>`).join('');

  const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
  <title>Plano Terapêutico — ${t.pac||''}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Times New Roman',Times,serif;font-size:9.5pt;color:#000;background:#fff;line-height:1.35;}
    @page{size:A4 portrait;margin:0.7cm 1.4cm;}
    .cab{display:flex;gap:10px;align-items:flex-start;border-bottom:2px solid #000;padding-bottom:5px;margin-bottom:7px;}
    .cab-logo{width:60px;flex-shrink:0;}
    .cab-logo img{width:100%;height:auto;}
    .cab-txt{text-align:center;flex:1;}
    .cab-txt .inst{font-size:8pt;font-weight:700;letter-spacing:.02em;}
    .cab-txt .end{font-size:7pt;margin-top:1px;}
    h1{text-align:center;font-size:11pt;font-weight:800;letter-spacing:.04em;margin:5px 0 2px;}
    h2{text-align:center;font-size:10pt;font-weight:700;text-decoration:underline;margin-bottom:7px;letter-spacing:.03em;}
    p{margin:0 0 4px;text-align:justify;font-size:9.5pt;}
    ul{margin:3px 0 6px 18px;}
    ul li{margin-bottom:1px;font-size:9.5pt;}
    .cids{margin:5px 0;font-size:9.5pt;}
    .cids p{margin:0;}
    .rodape{margin-top:12px;text-align:center;}
    .assin-linha{border-top:1.5px solid #000;width:240px;margin:20px auto 2px;padding-top:3px;font-size:9pt;}
    .info-box{margin-top:12px;border:1px solid #999;border-radius:4px;padding:5px 10px;font-size:8pt;background:#f9f9f9;line-height:1.4;}
    @media print{body{margin:0;}}
  </style></head><body>

  <!-- Cabeçalho institucional -->
  <div class="cab">
    <div class="cab-txt">
      <div class="inst">PREFEITURA MUNICIPAL DE NATAL &nbsp;·&nbsp; SECRETARIA MUNICIPAL DE SAÚDE</div>
      <div class="inst" style="font-size:11pt;margin:2px 0;">HOSPITAL DOS PESCADORES</div>
      <div class="end">CNPJ: 24.518.573/0001-70 &nbsp;·&nbsp; CNES: 3708926 &nbsp;·&nbsp; R. São João de Deus, 80, Rocas, Natal/RN – CEP: 59.010-775</div>
    </div>
  </div>

  <h1>PLANO TERAPÊUTICO</h1>
  <h2>SOLICITAÇÃO DE VENTILADOR MECÂNICO</h2>

  <p>
    Atesto para os devidos fins que o(a) Sr(a). <strong>${_esc(t.pac||'')}</strong>${t.cns?`, CNS nº ${_esc(t.cns)}`:''}, ${_esc(t.idade||'')},
    encontra-se internado(a) em leito de terapia intensiva desde <strong>${admFmt}</strong>, neste nosocômio,
    devido à <strong>${_esc(t.diagPrinc||'')}</strong>.
  </p>

  ${t.comor ? `<p>Paciente portador(a) de múltiplas comorbidades, incluindo <strong>${_esc(t.comor)}</strong>.</p>` : ''}

  ${t.evol  ? `<p>${_nl2br(t.evol)}</p>` : ''}

  ${t.atual  ? `<p>${_nl2br(t.atual)}</p>` : ''}

  <p>Necessidades do equipamento:</p>
  <ul>
    ${_nl2li(t.obsTec||'')}
    ${t.params ? `<li>Parâmetros atuais: ${_esc(t.params)}</li>` : ''}
    ${t.via    ? `<li>Necessidade de adaptação para ${_esc(t.via)}</li>` : ''}
    <li>Suporte de oxigenioterapia conforme necessidade clínica</li>
  </ul>

  <p>Hipótese diagnóstica classificada na CID-10:</p>
  <div class="cids">${cidsLinhas}</div>

  <p>Natal, ${dataDoc}.</p>

  <div class="rodape">
    <div class="assin-linha">
      <strong>${_esc((t.medNome||'').toUpperCase())}</strong>
      ${t.medCrm ? `<br>CRM: ${_esc(t.medCrm)}` : ''}
      <br><span style="font-size:9pt;">Médico Responsável</span>
    </div>
  </div>

  <div class="info-box">
    <strong>ORIENTAÇÕES PARA SOLICITAÇÃO DO VENTILADOR:</strong><br>
    Enviar este relatório (prescrição médica) por e-mail para <strong>oxigenoterapiarn@gmail.com</strong>.<br>
    Haverá troca de e-mails para completar o cadastro. Necessário documentação do familiar responsável.<br>
    A empresa (Oxi/White Martins) enviará ficha para preenchimento com dados do paciente e familiar responsável.<br>
    Enquanto internado, a entrega é feita no hospital. Em caso de alta, o equipamento acompanha o paciente.
  </div>

  <script>window.onload=()=>{window.print();window.onafterprint=()=>window.close();}<\/script>
  </body></html>`;

  const w = window.open('', '_blank', 'width=850,height=1050');
  if(w){ w.document.write(html); w.document.close(); }
  else toast('Popup bloqueado — permita popups para imprimir.', true);
}

/* ════════════════════════════════════════════════════════════════════════════
   IMPRIMIR TODAS AS PRESCRIÇÕES (tela de leitos)
   ════════════════════════════════════════════════════════════════════════════ */
async function imprimirTodasPrescricoes(){
  showLoading('Carregando prescrições...');
  try{
    const ld = await _getLeitos();
    const data = hoje();
    const htmls = [];
    for(let i=1; i<=TOTAL_LEITOS; i++){
      const L = ld[i]||{};
      if(!L.ocupado || !L.pac) continue;
      // Tenta prescrição de hoje; senão pega a mais recente
      let saved = await dbGet(`uti_med_rx_${i}_${data}`);
      if(!saved || !saved.itens || !saved.itens.length){
        const todas = await dbListByPrefix(`uti_med_rx_${i}_`);
        const ord = Object.values(todas).filter(r=>r&&r.itens&&r.itens.length)
          .sort((a,b)=>(b.data||'').localeCompare(a.data||''));
        saved = ord[0] || null;
      }
      if(!saved || !saved.itens || !saved.itens.length) continue;
      // Usa _gerarHtmlPrescricao mas com dados do leito i (não do formulário aberto)
      const itens = saved.itens;
      const pac   = L.pac || '';
      const leito = pad(i);
      const dataRx= saved.data || data;
      const med   = saved.medNome || '';
      const crm   = saved.medCrm  || '';
      const linhas = itens.map((it,idx)=>{
        const isHidrat = it._cat === 'Hidratação';
        const dosePartes = isHidrat
          ? [it.qtd ? it.qtd+'ML' : '', it.dose&&it.dose!=='—'?it.dose:''].filter(Boolean)
          : [it.qtd,(it.apres&&it.apres!=='—'?it.apres:''),(it.dose&&it.dose!=='—'?it.dose:'')].filter(Boolean);
        const dose = dosePartes.join(' ') || '—';
        const vazaoHtml = isHidrat && it.vazao
          ? `<div style="font-size:6pt;color:#0d47a1;font-weight:700;margin-top:1px;">Vazão: ${it.vazao} ml/h</div>` : '';
        const hors=_ordenarHorarios(it.hor||[]).join(' · ')||'—';
        const bg=it.tipo==='dieta'?'#f0f7f0':it.tipo==='sn'?'#fffde7':it.tipo==='cuidados'?'#f5f5f5':'white';
        const dBadge=it._cat==='ATB'&&it._ddia!=null
          ?`<span style="background:${it._ddia>=10?'#b71c1c':it._ddia>=7?'#e65100':'#1565c0'};color:white;font-size:6pt;font-weight:800;padding:1px 5px;border-radius:4px;margin-left:5px;">D${it._ddia}</span>`:''
        return `<tr style="background:${bg};"><td style="padding:4px 6px;border:1px solid #ccc;width:22px;color:#888;font-size:8pt;">${idx+1}</td>
          <td style="padding:4px 6px;border:1px solid #ccc;font-weight:600;">${(it.farm||'—').toUpperCase()}${dBadge}${it.diluicao?`<div style="font-size:7pt;color:#1d4ed8;font-weight:600;">Diluente: ${it.diluicao.toUpperCase()}</div>`:''}</td>
          <td style="padding:4px 6px;border:1px solid #ccc;">${dose.toUpperCase()}${vazaoHtml}</td>
          <td style="padding:4px 6px;border:1px solid #ccc;">${(it.via||'—').toUpperCase()}</td>
          <td style="padding:4px 6px;border:1px solid #ccc;">${(it.freq||'—').toUpperCase()}</td>
          <td style="padding:4px 6px;border:1px solid #ccc;font-size:8pt;">${hors}</td>
          <td style="padding:4px 6px;border:1px solid #ccc;font-size:8pt;">${(it.obs||'').toUpperCase()}</td></tr>`;
      }).join('');
      htmls.push(`
      <div style="font-family:'Arial Narrow',Arial,sans-serif;font-size:9pt;padding:0 4px;page-break-after:always;">
        <div style="display:flex;align-items:center;justify-content:space-between;border-bottom:2px solid #7a1020;padding-bottom:6px;margin-bottom:8px;">
          <div style="display:flex;align-items:center;gap:10px;">
            <img src="logo.png" alt="" style="height:44px;width:auto;" onerror="this.style.display='none'">
            <div><div style="font-weight:800;color:#7a1020;font-size:11pt;">PRESCRIÇÃO MÉDICA — UTI GERAL</div>
            <div style="font-size:7.5pt;color:#555;">HOSPITAL DOS PESCADORES · NATAL/RN</div></div>
          </div>
          <div style="text-align:right;font-size:8pt;color:#444;"><strong>DATA:</strong> ${_fmtDataCurta(dataRx)||'—'}&nbsp;&nbsp;<strong>LEITO:</strong> ${leito}</div>
        </div>
        <div style="margin-bottom:8px;font-size:9pt;"><strong>Paciente:</strong> ${pac.toUpperCase()}</div>
        <table style="width:100%;border-collapse:collapse;font-size:8.5pt;">
          <thead><tr style="background:#7a1020;color:white;">
            <th style="padding:4px 6px;text-align:left;font-size:7.5pt;">#</th>
            <th style="padding:4px 6px;text-align:left;font-size:7.5pt;">FÁRMACO / ITEM</th>
            <th style="padding:4px 6px;text-align:left;font-size:7.5pt;">DOSE/APRES</th>
            <th style="padding:4px 6px;text-align:left;font-size:7.5pt;">VIA</th>
            <th style="padding:4px 6px;text-align:left;font-size:7.5pt;">FREQ</th>
            <th style="padding:4px 6px;text-align:left;font-size:7.5pt;">HORÁRIOS</th>
            <th style="padding:4px 6px;text-align:left;font-size:7.5pt;">OBS</th>
          </tr></thead>
          <tbody>${linhas}</tbody>
        </table>
        <div style="margin-top:24px;display:flex;justify-content:flex-end;">
          <div style="text-align:center;">
            <div style="border-top:1px solid #555;width:220px;padding-top:4px;font-size:8pt;">
              ${med?med.toUpperCase()+'<br>':''}${crm?'CRM '+crm:'Médico Responsável'}
            </div>
          </div>
        </div>
      </div>`);
    }
    hideLoading();
    if(!htmls.length){ toast('Nenhum leito com prescrição encontrado.',true); return; }
    _abrirJanelaBranca(htmls.join(''), `Prescrições — ${_fmtDataCurta(data)} (${htmls.length} leitos)`);
  }catch(e){ hideLoading(); toast('Erro: '+(e.message||e),true); }
}

/* ════════════════════════════════════════════════════════════════════════════
   TERMO DE DECLARAÇÃO DE MORTE ENCEFÁLICA — CFM 2.173/2017
   ════════════════════════════════════════════════════════════════════════════ */

function abrirModalMorteEncefalica(){
  if(!leitoAtual){ toast('Abra o prontuário de um paciente.',true); return; }
  // Pré-preenche dados do paciente
  sf('me-pac',  (gf('f-pac')||'').toUpperCase());
  sf('me-dn',   gf('f-dn')||'');
  const sexoRaw = (gf('f-sexo')||'').toUpperCase();
  const sexoEl = $('me-sexo');
  if(sexoEl) sexoEl.value = sexoRaw.includes('FEM')?'FEM':sexoRaw.includes('MAS')?'MAS':'';
  sf('me-mae',  '');
  sf('me-diag1',(gf('f-diag')||'').toUpperCase());
  sf('me-cid1', (gf('f-cid') ||'').toUpperCase());
  sf('me-diag2','');
  sf('me-cid2', '');
  // Data padrão = hoje para os exames
  const hj = hoje();
  ['me-e1-data','me-e2-data','me-ap-data','me-ec-data'].forEach(id=>sf(id,hj));
  $('modal-me').classList.add('show');
  _resizeModalTextareas('modal-me');
}

function fecharModalME(){ $('modal-me').classList.remove('show'); }

function _gfMe(id){ const el=$(id); if(!el) return ''; return (el.value||'').trim(); }
function _chkMe(id){ const el=$(id); return el?el.checked:false; }

function _coletarME(){
  return {
    hosp: _gfMe('me-hosp'), cnes:_gfMe('me-cnes'), mun:_gfMe('me-mun'), uf:_gfMe('me-uf'),
    pac:  _gfMe('me-pac'),  dn:_gfMe('me-dn'), sexo:_gfMe('me-sexo'),
    mae:  _gfMe('me-mae'),  idTipo:_gfMe('me-id-tipo'), idNum:_gfMe('me-id-num'),
    diag1:_gfMe('me-diag1'),cid1:_gfMe('me-cid1'),
    diag2:_gfMe('me-diag2'),cid2:_gfMe('me-cid2'),
    confTC:_chkMe('me-conf-tc'),confRM:_chkMe('me-conf-rm'),confAngio:_chkMe('me-conf-angio'),
    confDTC:_chkMe('me-conf-dtc'),confLiquor:_chkMe('me-conf-liquor'),confEEG:_chkMe('me-conf-eeg'),
    confOutro:_gfMe('me-conf-outro'),
    pre1:_gfMe('me-pre1'),pre2:_gfMe('me-pre2'),pre3:_gfMe('me-pre3'),
    pre4:_gfMe('me-pre4'),pre5:_gfMe('me-pre5'),pre6:_gfMe('me-pre6'),
    e1Pa:_gfMe('me-e1-pa'),e1Temp:_gfMe('me-e1-temp'),e1Data:_gfMe('me-e1-data'),
    e1Hora:_gfMe('me-e1-hora'),e1Coma:_gfMe('me-e1-coma'),
    e1PupD:_gfMe('me-e1-pup-d'),e1PupE:_gfMe('me-e1-pup-e'),
    e1CorD:_gfMe('me-e1-cor-d'),e1CorE:_gfMe('me-e1-cor-e'),
    e1OcD:_gfMe('me-e1-oc-d'),e1OcE:_gfMe('me-e1-oc-e'),
    e1VestD:_gfMe('me-e1-vest-d'),e1VestE:_gfMe('me-e1-vest-e'),
    e1Tosse:_gfMe('me-e1-tosse'),e1Just:_gfMe('me-e1-just'),
    e1Med:_gfMe('me-e1-med'),e1Crm:_gfMe('me-e1-crm'),
    apPa:_gfMe('me-ap-pa'),apTemp:_gfMe('me-ap-temp'),apData:_gfMe('me-ap-data'),
    apHora:_gfMe('me-ap-hora'),apPco2i:_gfMe('me-ap-pco2i'),apPco2f:_gfMe('me-ap-pco2f'),
    apPo2i:_gfMe('me-ap-po2i'),apPo2f:_gfMe('me-ap-po2f'),apResp:_gfMe('me-ap-resp'),
    apMed:_gfMe('me-ap-med'),apCrm:_gfMe('me-ap-crm'),
    e2Pa:_gfMe('me-e2-pa'),e2Temp:_gfMe('me-e2-temp'),e2Data:_gfMe('me-e2-data'),
    e2Hora:_gfMe('me-e2-hora'),e2Coma:_gfMe('me-e2-coma'),
    e2PupD:_gfMe('me-e2-pup-d'),e2PupE:_gfMe('me-e2-pup-e'),
    e2CorD:_gfMe('me-e2-cor-d'),e2CorE:_gfMe('me-e2-cor-e'),
    e2OcD:_gfMe('me-e2-oc-d'),e2OcE:_gfMe('me-e2-oc-e'),
    e2VestD:_gfMe('me-e2-vest-d'),e2VestE:_gfMe('me-e2-vest-e'),
    e2Tosse:_gfMe('me-e2-tosse'),e2Just:_gfMe('me-e2-just'),
    e2Med:_gfMe('me-e2-med'),e2Crm:_gfMe('me-e2-crm'),
    ecPa:_gfMe('me-ec-pa'),ecTemp:_gfMe('me-ec-temp'),ecData:_gfMe('me-ec-data'),
    ecHora:_gfMe('me-ec-hora'),
    ecDTC:_chkMe('me-ec-dtc'),ecEEG:_chkMe('me-ec-eeg'),ecAngio:_chkMe('me-ec-angio'),
    ecCintilo:_chkMe('me-ec-cintilo'),ecOutro:_gfMe('me-ec-outro'),ecRes:_gfMe('me-ec-res'),
    ecMed:_gfMe('me-ec-med'),ecCrm:_gfMe('me-ec-crm'),
    autor:usuarioEmail, autorNome:perfilUsuario?perfilUsuario.nome:'',
    salvadoEm:new Date().toISOString(), data: hoje(),
  };
}

async function salvarME(){
  const m = _coletarME();
  if(!m.pac){ toast('Informe o paciente.',true); return; }
  if(!leitoAtual){ toast('Abra o prontuário.',true); return; }
  showLoading('Salvando...');
  try{
    const key = `uti_med_me_${leitoAtual}_${m.data}_${Date.now()}`;
    await dbSet(key, m);
    hideLoading(); toast('<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M2.5 8.5l3.5 3.5 7.5-7.5"/></svg> Termo de morte encefálica salvo.');
    _renderGuiasFichas();
  }catch(e){ hideLoading(); toast('Erro: '+(e.message||e),true); }
}

function imprimirME(){ _imprimirMEObj(_coletarME()); }

async function _imprimirMEChave(key){
  showLoading('Carregando...');
  try{ const m=await dbGet(key); hideLoading(); if(m) _imprimirMEObj(m); }
  catch(e){ hideLoading(); toast('Erro: '+(e.message||e),true); }
}

async function _abrirMEExistente(key){
  showLoading('Carregando...');
  try{
    const m=await dbGet(key); hideLoading();
    if(!m){toast('Não encontrado.',true);return;}
    const ids=['hosp','cnes','mun','uf','pac','dn','mae','id-tipo','id-num',
               'diag1','cid1','diag2','cid2',
               'pre1','pre2','pre3','pre4','pre5','pre6',
               'e1-pa','e1-temp','e1-data','e1-hora','e1-coma','e1-just','e1-med','e1-crm',
               'e1-pup-d','e1-pup-e','e1-cor-d','e1-cor-e','e1-oc-d','e1-oc-e',
               'e1-vest-d','e1-vest-e','e1-tosse',
               'ap-pa','ap-temp','ap-data','ap-hora','ap-pco2i','ap-pco2f','ap-po2i','ap-po2f','ap-resp','ap-med','ap-crm',
               'e2-pa','e2-temp','e2-data','e2-hora','e2-coma','e2-just','e2-med','e2-crm',
               'e2-pup-d','e2-pup-e','e2-cor-d','e2-cor-e','e2-oc-d','e2-oc-e',
               'e2-vest-d','e2-vest-e','e2-tosse',
               'ec-pa','ec-temp','ec-data','ec-hora','ec-res','ec-med','ec-crm','ec-outro'];
    ids.forEach(id=>{
      const camel=id.replace(/-([a-z0-9])/g,(_,c)=>c.toUpperCase());
      sf('me-'+id, m[camel]||'');
    });
    // sexo
    const sx=$('me-sexo'); if(sx) sx.value=m.sexo||'';
    // checkboxes conf
    const chkMap={
      'me-conf-tc':'confTC','me-conf-rm':'confRM','me-conf-angio':'confAngio',
      'me-conf-dtc':'confDTC','me-conf-liquor':'confLiquor','me-conf-eeg':'confEEG',
      'me-ec-dtc':'ecDTC','me-ec-eeg':'ecEEG','me-ec-angio':'ecAngio','me-ec-cintilo':'ecCintilo'
    };
    Object.entries(chkMap).forEach(([id,key])=>{ const el=$(id); if(el) el.checked=!!m[key]; });
    $('modal-me').classList.add('show');
    _resizeModalTextareas('modal-me');
  }catch(e){hideLoading();toast('Erro: '+(e.message||e),true);}
}

function _imprimirMEObj(m){
  if(!m.pac){ toast('Informe o paciente antes de imprimir.',true); return; }
  const _e = s=>(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const _dn= s=>{ if(!s) return ''; const p=s.split('-'); return p.length===3?`${p[2]}/${p[1]}/${p[0]}`:s; };
  const _dt= s=>{ if(!s) return '___/___/______'; const p=s.split('-'); return p.length===3?`${p[2]}/${p[1]}/${p[0]}`:s; };
  const _mk= v=>v?'(X)':'( )';
  const _sn= v=>v==='SIM'?'SIM(X) NÃO( )':v==='NAO'?'SIM( ) NÃO(X)':'SIM( ) NÃO( )';
  const _ref=(d,e,nt)=>{ // d=direito, e=esquerdo, nt=tem opção NT?
    const fmtD=nt?(d==='SIM'?'SIM(X)':d==='NAO'?'SIM( )':d==='NT'?'SIM( )':'SIM( )'):'';
    const fmtDN=nt?(d==='NAO'?'NÃO(X)':d==='NT'?'NÃO( )':'NÃO( )'):d==='NAO'?'NÃO(X)':'NÃO( )';
    const fmtDT=nt?(d==='NT'?'NT(X)':'NT( )'):'';
    const fmtE=nt?(e==='SIM'?'SIM(X)':'SIM( )'):(e==='SIM'?'SIM(X)':'SIM( )');
    const fmtEN=(e==='NAO'?'NÃO(X)':'NÃO( )');
    const fmtET=nt?(e==='NT'?'NT(X)':'NT( )'):'';
    return `${fmtD||'SIM( )'} ${fmtDN} ${fmtDT} | ${fmtE} ${fmtEN} ${fmtET}`;
  };

  const CSS_COMUM = `*{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:Arial,sans-serif;font-size:9pt;color:#000;background:#fff;}
    @page{size:A4 portrait;margin:1.2cm 1.4cm;}
    .cab{text-align:center;border-bottom:2px solid #000;padding-bottom:8px;margin-bottom:10px;}
    .cab-gov{font-size:8pt;font-weight:700;letter-spacing:.04em;}
    .cab-org{font-size:8.5pt;font-weight:700;margin:2px 0;}
    .cab-titulo{font-size:12pt;font-weight:900;text-decoration:underline;margin:6px 0 2px;}
    .cab-res{font-size:8pt;}
    .bloco{margin-bottom:8px;}
    .bloco-titulo{font-weight:800;font-size:9pt;border-bottom:1px solid #000;margin-bottom:4px;padding-bottom:2px;}
    .campo-linha{display:flex;align-items:baseline;gap:4px;margin-bottom:3px;flex-wrap:wrap;font-size:9pt;}
    .campo-lbl{font-weight:700;white-space:nowrap;}
    .campo-val{border-bottom:1px solid #555;flex:1;min-width:40px;padding:0 2px;}
    table.refl{width:100%;border-collapse:collapse;font-size:8.5pt;margin:4px 0;}
    table.refl th,table.refl td{border:1px solid #000;padding:3px 5px;vertical-align:middle;}
    table.refl th{background:#eee;font-weight:700;text-align:center;}
    .assin{margin-top:10px;font-size:8.5pt;}
    .assin-linha{display:inline-block;border-top:1px solid #000;min-width:200px;padding-top:2px;margin-top:8px;}
    .check-row{display:flex;gap:14px;flex-wrap:wrap;font-size:8.5pt;margin:3px 0;}
    @media print{body{margin:0;}}`;

  // ── FRENTE ─────────────────────────────────────────────────────────────
  const conf=[_mk(m.confTC),'TC',_mk(m.confRM),'RM',_mk(m.confAngio),'Angiografia',
    _mk(m.confDTC),'DTC',_mk(m.confLiquor),'Liquor',_mk(m.confEEG),'EEG',
    m.confOutro?`Outro: ${_e(m.confOutro)}`:''].filter(Boolean);
  const confStr = [_mk(m.confTC)+' TC',_mk(m.confRM)+' RM',_mk(m.confAngio)+' Angiografia',
    _mk(m.confDTC)+' DTC',_mk(m.confLiquor)+' Liquor',_mk(m.confEEG)+' EEG',
    m.confOutro?`Outro: ${_e(m.confOutro)}`:''].filter(Boolean).join('  ');

  const preReqRows = [
    ['Presença de lesão encefálica de causa conhecida, irreversível e capaz de causar a morte encefálica?',m.pre1],
    ['Ausência de causas tratáveis que possam confundir o diagnóstico de morte encefálica?',m.pre2],
    ['Tratamento e observação hospitalar ≥ 6 horas ou ≥ 24 horas em encefalopatia hipóxico-isquêmica?',m.pre3],
    ['Temperatura corporal > 35°C + SaO2 > 94% + PAS ≥ 100mmHg ou PA média ≥ 65mmHg (ou pela faixa etária <16 anos)?',m.pre4],
    ['Ausência de hipotermia?',m.pre5],
    ['Ausência de drogas depressoras do SNC ou de bloqueadores neuromusculares?',m.pre6],
  ].map(([q,v])=>`<tr><td style="padding:3px 6px;">${_e(q)}</td><td style="padding:3px 6px;text-align:center;white-space:nowrap;">${_sn(v)}</td></tr>`).join('');

  const frente = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Morte Encefálica — Frente</title>
  <style>${CSS_COMUM}</style></head><body>
  <div class="cab">
    <div class="cab-gov">GOVERNO DO ESTADO DO RIO GRANDE DO NORTE &nbsp;·&nbsp; SECRETARIA DE ESTADO DA SAÚDE PÚBLICA</div>
    <div class="cab-org">CENTRAL DE TRANSPLANTES DO RN</div>
    <div class="cab-titulo">TERMO DE DECLARAÇÃO DE MORTE ENCEFÁLICA</div>
    <div class="cab-res">Resolução. CFM nº 2.173 &nbsp; 15/12/2017</div>
  </div>

  <div style="display:flex;gap:20px;margin-bottom:8px;">
    <div style="flex:1;"><div class="bloco-titulo">HOSPITAL</div>
      <div class="campo-linha"><span class="campo-lbl">Nome:</span><span class="campo-val">${_e(m.hosp)}</span><span class="campo-lbl" style="margin-left:12px;">CNES:</span><span class="campo-val" style="max-width:80px;">${_e(m.cnes)}</span></div>
      <div class="campo-linha"><span class="campo-lbl">Município:</span><span class="campo-val">${_e(m.mun)}</span><span class="campo-lbl" style="margin-left:8px;">UF:</span><span class="campo-val" style="max-width:40px;">${_e(m.uf)}</span></div>
    </div>
  </div>

  <div class="bloco-titulo">PACIENTE</div>
  <div class="campo-linha"><span class="campo-lbl">Nome:</span><span class="campo-val">${_e(m.pac)}</span><span class="campo-lbl" style="margin-left:12px;">Nascimento:</span><span class="campo-val" style="max-width:90px;">${_dn(m.dn)}</span></div>
  <div class="campo-linha"><span class="campo-lbl">Mãe:</span><span class="campo-val">${_e(m.mae)}</span><span class="campo-lbl" style="margin-left:8px;">Sexo:</span><span>MAS${m.sexo==='MAS'?' (X)':'( )'} FEM${m.sexo==='FEM'?' (X)':'( )'}</span></div>
  <div class="campo-linha"><span class="campo-lbl">Identidade:</span><span>Tipo: <span class="campo-val" style="min-width:60px;">${_e(m.idTipo)}</span></span><span style="margin-left:8px;">Nº <span class="campo-val" style="min-width:80px;">${_e(m.idNum)}</span></span></div>

  <div class="bloco-titulo" style="margin-top:6px;">CAUSA DO COMA</div>
  <div class="campo-linha"><span class="campo-lbl">Diagnóstico principal:</span><span class="campo-val">${_e(m.diag1)}</span><span class="campo-lbl" style="margin-left:8px;">CID</span><span class="campo-val" style="max-width:60px;font-weight:700;">${_e(m.cid1)}</span></div>
  <div class="campo-linha"><span class="campo-lbl">Diagnóstico secundário:</span><span class="campo-val">${_e(m.diag2)}</span><span class="campo-lbl" style="margin-left:8px;">CID</span><span class="campo-val" style="max-width:60px;font-weight:700;">${_e(m.cid2)}</span></div>
  <div class="campo-linha"><span class="campo-lbl">Confirmação:</span><span style="font-size:8.5pt;">${confStr}</span></div>

  <div class="bloco-titulo" style="margin-top:6px;">PRÉ-REQUISITOS</div>
  <table style="width:100%;border-collapse:collapse;font-size:8.5pt;"><tbody>${preReqRows}</tbody></table>

  <div class="bloco-titulo" style="margin-top:8px;">1º EXAME CLÍNICO</div>
  <div class="campo-linha">
    <span class="campo-lbl">PA (mmHg):</span><span class="campo-val" style="max-width:80px;">${_e(m.e1Pa)}</span>
    <span class="campo-lbl" style="margin-left:8px;">TEMP (°C):</span><span class="campo-val" style="max-width:50px;">${_e(m.e1Temp)}</span>
    <span class="campo-lbl" style="margin-left:8px;">DATA:</span><span style="font-size:9pt;">${_dt(m.e1Data)}</span>
    <span class="campo-lbl" style="margin-left:8px;">HORA:</span><span>${m.e1Hora||'__:__'}</span>
  </div>
  <div style="font-size:9pt;margin-bottom:3px;">Coma não perceptivo? ${_sn(m.e1Coma)}</div>
  <div style="font-weight:700;font-size:8.5pt;margin-bottom:3px;">EXAME NEUROLÓGICO (exame dos reflexos):</div>
  <table class="refl"><thead><tr><th style="text-align:left;">Reflexo</th><th>Direito</th><th>Esquerdo</th></tr></thead><tbody>
    <tr><td>Pupila fixa e arreativa</td><td>${m.e1PupD==='SIM'?'SIM(X) NÃO( )':'SIM( ) NÃO(X)'}</td><td>${m.e1PupE==='SIM'?'SIM(X) NÃO( )':'SIM( ) NÃO(X)'}</td></tr>
    <tr><td>Ausência de reflexo córneo-palpebral</td><td>${_ref(m.e1CorD,null,true).split('|')[0]}</td><td>${_ref(null,m.e1CorE,true).split('|')[1]||''}</td></tr>
    <tr><td>Ausência de reflexo óculo-cefálico</td><td>${_ref(m.e1OcD,null,true).split('|')[0]}</td><td>${_ref(null,m.e1OcE,true).split('|')[1]||''}</td></tr>
    <tr><td>Ausência de reflexo vestíbulo-calórico</td><td>${_ref(m.e1VestD,null,true).split('|')[0]}</td><td>${_ref(null,m.e1VestE,true).split('|')[1]||''}</td></tr>
    <tr><td colspan="3">Ausência de reflexo da tosse: &nbsp; ${_sn(m.e1Tosse)}</td></tr>
  </tbody></table>
  <div class="campo-linha" style="margin-top:4px;"><span class="campo-lbl">Justificativa NT:</span><span class="campo-val">${_e(m.e1Just)}</span></div>
  <div class="assin"><div class="campo-linha"><span class="campo-lbl">Médico:</span><span class="campo-val">${_e(m.e1Med)}</span><span class="campo-lbl" style="margin-left:8px;">CRM:</span><span class="campo-val" style="max-width:80px;">${_e(m.e1Crm)}</span></div>
  <span class="assin-linha">Assinatura Identificada</span></div>

  <div class="bloco-titulo" style="margin-top:8px;">TESTE DE APNEIA (examinador 1 ou 2)</div>
  <div class="campo-linha">
    <span class="campo-lbl">PA (mmHg):</span><span class="campo-val" style="max-width:80px;">${_e(m.apPa)}</span>
    <span class="campo-lbl" style="margin-left:8px;">TEMP (°C):</span><span class="campo-val" style="max-width:50px;">${_e(m.apTemp)}</span>
    <span class="campo-lbl" style="margin-left:8px;">DATA:</span><span>${_dt(m.apData)}</span>
    <span class="campo-lbl" style="margin-left:8px;">HORA:</span><span>${m.apHora||'__:__'}</span>
  </div>
  <table style="width:100%;border-collapse:collapse;font-size:8.5pt;margin:4px 0;">
    <tr><td style="border:1px solid #000;padding:3px 6px;"></td>
        <td style="border:1px solid #000;padding:3px 6px;text-align:center;font-weight:700;">Inicial</td>
        <td style="border:1px solid #000;padding:3px 6px;text-align:center;font-weight:700;">Final</td>
        <td style="border:1px solid #000;padding:3px 6px;"></td>
        <td style="border:1px solid #000;padding:3px 6px;text-align:center;font-weight:700;">Inicial</td>
        <td style="border:1px solid #000;padding:3px 6px;text-align:center;font-weight:700;">Final</td></tr>
    <tr><td style="border:1px solid #000;padding:3px 6px;font-weight:700;">PaCO₂</td>
        <td style="border:1px solid #000;padding:3px 6px;text-align:center;">${_e(m.apPco2i)}</td>
        <td style="border:1px solid #000;padding:3px 6px;text-align:center;">${_e(m.apPco2f)}</td>
        <td style="border:1px solid #000;padding:3px 6px;font-weight:700;">PaO₂</td>
        <td style="border:1px solid #000;padding:3px 6px;text-align:center;">${_e(m.apPo2i)}</td>
        <td style="border:1px solid #000;padding:3px 6px;text-align:center;">${_e(m.apPo2f)}</td></tr>
  </table>
  <div style="font-size:9pt;margin-bottom:4px;">Ausência de movimentos respiratórios com PaCO₂ &gt; 55 mmHg? ${_sn(m.apResp)}</div>
  <div class="assin"><div class="campo-linha"><span class="campo-lbl">Médico:</span><span class="campo-val">${_e(m.apMed)}</span><span class="campo-lbl" style="margin-left:8px;">CRM:</span><span class="campo-val" style="max-width:80px;">${_e(m.apCrm)}</span></div>
  <span class="assin-linha">Assinatura Identificada</span></div>

  <script>window.onload=()=>{window.print();window.onafterprint=()=>window.close();}<\/script>
  </body></html>`;

  // ── VERSO ──────────────────────────────────────────────────────────────
  const ecTipos=[_mk(m.ecDTC)+' DTC',_mk(m.ecEEG)+' EEG',_mk(m.ecAngio)+' Angiografia',
    _mk(m.ecCintilo)+' Cintilografia',m.ecOutro?'Outro: '+_e(m.ecOutro):''].filter(Boolean).join('  ');

  const versoCorp = `
  <div class="cab">
    <div class="cab-gov">GOVERNO DO ESTADO DO RIO GRANDE DO NORTE &nbsp;·&nbsp; SECRETARIA DE ESTADO DA SAÚDE PÚBLICA</div>
    <div class="cab-org">CENTRAL DE TRANSPLANTES DO RN</div>
    <div class="cab-titulo">TERMO DE DECLARAÇÃO DE MORTE ENCEFÁLICA</div>
    <div class="cab-res">Resolução. CFM nº 2.173 &nbsp; 15/12/2017</div>
  </div>

  <div class="bloco-titulo">PACIENTE</div>
  <div class="campo-linha"><span class="campo-lbl">Nome:</span><span class="campo-val">${_e(m.pac)}</span><span class="campo-lbl" style="margin-left:12px;">Nascimento:</span><span class="campo-val" style="max-width:90px;">${_dn(m.dn)}</span></div>

  <div class="bloco-titulo" style="margin-top:8px;">2º EXAME CLÍNICO</div>
  <div class="campo-linha">
    <span class="campo-lbl">PA (mmHg):</span><span class="campo-val" style="max-width:80px;">${_e(m.e2Pa)}</span>
    <span class="campo-lbl" style="margin-left:8px;">TEMP (°C):</span><span class="campo-val" style="max-width:50px;">${_e(m.e2Temp)}</span>
    <span class="campo-lbl" style="margin-left:8px;">DATA:</span><span>${_dt(m.e2Data)}</span>
    <span class="campo-lbl" style="margin-left:8px;">HORA:</span><span>${m.e2Hora||'__:__'}</span>
  </div>
  <div style="font-size:9pt;margin-bottom:3px;">Coma não perceptivo? ${_sn(m.e2Coma)}</div>
  <div style="font-weight:700;font-size:8.5pt;margin-bottom:3px;">EXAME NEUROLÓGICO (exame dos reflexos):</div>
  <table class="refl"><thead><tr><th style="text-align:left;">Reflexo</th><th>Direito</th><th>Esquerdo</th></tr></thead><tbody>
    <tr><td>Pupila fixa e arreativa</td><td>${m.e2PupD==='SIM'?'SIM(X) NÃO( )':'SIM( ) NÃO(X)'}</td><td>${m.e2PupE==='SIM'?'SIM(X) NÃO( )':'SIM( ) NÃO(X)'}</td></tr>
    <tr><td>Ausência de reflexo córneo-palpebral</td><td>${_ref(m.e2CorD,null,true).split('|')[0]}</td><td>${_ref(null,m.e2CorE,true).split('|')[1]||''}</td></tr>
    <tr><td>Ausência de reflexo óculo-cefálico</td><td>${_ref(m.e2OcD,null,true).split('|')[0]}</td><td>${_ref(null,m.e2OcE,true).split('|')[1]||''}</td></tr>
    <tr><td>Ausência de reflexo vestíbulo-calórico</td><td>${_ref(m.e2VestD,null,true).split('|')[0]}</td><td>${_ref(null,m.e2VestE,true).split('|')[1]||''}</td></tr>
    <tr><td colspan="3">Ausência de reflexo da tosse: &nbsp; ${_sn(m.e2Tosse)}</td></tr>
  </tbody></table>
  <div class="campo-linha" style="margin-top:4px;"><span class="campo-lbl">Justificativa NT:</span><span class="campo-val">${_e(m.e2Just)}</span></div>
  <div class="assin"><div class="campo-linha"><span class="campo-lbl">Médico:</span><span class="campo-val">${_e(m.e2Med)}</span><span class="campo-lbl" style="margin-left:8px;">CRM:</span><span class="campo-val" style="max-width:80px;">${_e(m.e2Crm)}</span></div>
  <span class="assin-linha">Assinatura Identificada</span></div>

  <div class="bloco-titulo" style="margin-top:8px;">EXAME COMPLEMENTAR</div>
  <div class="campo-linha">
    <span class="campo-lbl">PA (mmHg):</span><span class="campo-val" style="max-width:80px;">${_e(m.ecPa)}</span>
    <span class="campo-lbl" style="margin-left:8px;">TEMP (°C):</span><span class="campo-val" style="max-width:50px;">${_e(m.ecTemp)}</span>
    <span class="campo-lbl" style="margin-left:8px;">DATA:</span><span>${_dt(m.ecData)}</span>
    <span class="campo-lbl" style="margin-left:8px;">HORA:</span><span>${m.ecHora||'__:__'}</span>
  </div>
  <div class="campo-linha"><span class="campo-lbl">Tipo:</span><span style="font-size:8.5pt;">${ecTipos}</span></div>
  <div style="font-size:9pt;margin-bottom:4px;">Ausência de perfusão sanguínea ou de atividade metabólica ou elétrica encefálica? ${_sn(m.ecRes)}</div>
  <div class="assin"><div class="campo-linha"><span class="campo-lbl">Médico:</span><span class="campo-val">${_e(m.ecMed)}</span><span class="campo-lbl" style="margin-left:8px;">CRM:</span><span class="campo-val" style="max-width:80px;">${_e(m.ecCrm)}</span></div>
  <span class="assin-linha">Assinatura Identificada</span></div>

  <!-- Tabelas de referência -->
  <div style="margin-top:16px;display:grid;grid-template-columns:1fr 1fr;gap:12px;">
    <div>
      <div class="bloco-titulo">A. CONTROLE DA PRESSÃO ARTERIAL</div>
      <table style="width:100%;border-collapse:collapse;font-size:8pt;">
        <thead><tr style="background:#eee;"><th style="border:1px solid #000;padding:2px 5px;">IDADE</th><th style="border:1px solid #000;padding:2px 5px;">Sistólica</th><th style="border:1px solid #000;padding:2px 5px;">PAM</th></tr></thead>
        <tbody>
          <tr><td style="border:1px solid #000;padding:2px 5px;">Até 5 meses incompletos</td><td style="border:1px solid #000;padding:2px 5px;text-align:center;">60</td><td style="border:1px solid #000;padding:2px 5px;text-align:center;">43</td></tr>
          <tr><td style="border:1px solid #000;padding:2px 5px;">De 5 meses a 2 anos incompletos</td><td style="border:1px solid #000;padding:2px 5px;text-align:center;">80</td><td style="border:1px solid #000;padding:2px 5px;text-align:center;">60</td></tr>
          <tr><td style="border:1px solid #000;padding:2px 5px;">De 2 anos a 7 anos incompletos</td><td style="border:1px solid #000;padding:2px 5px;text-align:center;">85</td><td style="border:1px solid #000;padding:2px 5px;text-align:center;">62</td></tr>
          <tr><td style="border:1px solid #000;padding:2px 5px;">De 7 anos a 15 anos</td><td style="border:1px solid #000;padding:2px 5px;text-align:center;">90</td><td style="border:1px solid #000;padding:2px 5px;text-align:center;">65</td></tr>
          <tr><td style="border:1px solid #000;padding:2px 5px;">De 16 anos em diante</td><td style="border:1px solid #000;padding:2px 5px;text-align:center;">100</td><td style="border:1px solid #000;padding:2px 5px;text-align:center;">65</td></tr>
        </tbody>
      </table>
    </div>
    <div>
      <div class="bloco-titulo">B. INTERVALOS ENTRE EXAMES CLÍNICOS</div>
      <table style="width:100%;border-collapse:collapse;font-size:8pt;">
        <thead><tr style="background:#eee;"><th style="border:1px solid #000;padding:2px 5px;">FAIXA ETÁRIA</th><th style="border:1px solid #000;padding:2px 5px;">MÍNIMO</th></tr></thead>
        <tbody>
          <tr><td style="border:1px solid #000;padding:2px 5px;">7 dias completos (RN a termo) a 2 meses incompletos</td><td style="border:1px solid #000;padding:2px 5px;text-align:center;">24 horas</td></tr>
          <tr><td style="border:1px solid #000;padding:2px 5px;">De 2 meses a 24 meses incompletos</td><td style="border:1px solid #000;padding:2px 5px;text-align:center;">12 horas</td></tr>
          <tr><td style="border:1px solid #000;padding:2px 5px;">Mais de 24 meses</td><td style="border:1px solid #000;padding:2px 5px;text-align:center;">1 hora</td></tr>
        </tbody>
      </table>
    </div>
  </div>`;

  // ── Documento único: frente + page-break + verso em uma só janela ──────
  // Extrai o <body> da frente e injeta o verso numa nova página
  const frenteBody = frente.replace(/<script>.*?<\/script>/s,'').replace(/<\/body>.*?<\/html>/s,'');
  const combinedHtml = frenteBody +
    `<div style="page-break-before:always;"></div>` +
    versoCorp +
    `<script>window.onload=()=>{window.print();window.onafterprint=()=>window.close();}<\/script>
  </body></html>`;

  const w1 = window.open('','_blank','width=820,height=1000');
  if(w1){ w1.document.write(combinedHtml); w1.document.close(); }
  else toast('Popup bloqueado — permita popups para imprimir.',true);
}

async function salvarSolicitacaoCultura(){
  if(!leitoAtual){ toast('Abra o prontuário de um paciente.',true); return; }
  const c=_coletarCultura();
  showLoading('Salvando...');
  try{
    const key=`uti_med_sol_cult_${leitoAtual}_${c.data}_${Date.now()}`;
    await dbSet(key,c);
    hideLoading(); toast('<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M2.5 8.5l3.5 3.5 7.5-7.5"/></svg> Requisição de cultura salva.');
    fecharSolicitacaoCultura();
    _renderHistoricoSolicitacoes();
  }catch(e){ hideLoading(); toast('Erro: '+(e.message||e),true); }
}

function imprimirSolicitacaoCultura(){ _imprimirCulturaObj(_coletarCultura()); }

async function _imprimirCultChave(key){
  showLoading('Carregando...');
  try{ const c=await dbGet(key); hideLoading(); if(c) _imprimirCulturaObj(c); }
  catch(e){ hideLoading(); toast('Erro: '+(e.message||e),true); }
}

function _imprimirCulturaObj(c){
  const X='(X)'; const _='( )';
  const mk=(v)=>v?X:_;
  const mkr=(v,opt)=>v===opt?'(X)':'( )';
  // Monta lista de exames com checkboxes
  const uroTpStr=c.uroTp==='jato'?'jato médio':c.uroTp==='svd'?'SVD':c.uroTp==='aliv'?'sonda vesical de alívio':'';
  const secSubs=c.secSubs||[];
  const liqSubs=c.liqSubs||[];
  const vigSubs=c.vigSubs||[];
  const dataFmt=c.dataColeta?_fmtDataCurta(c.dataColeta):'___/___/___';
  const [dd,mm,yy]=dataFmt.split('/').concat(['','','']);
  const tipoInfMap={'C':'Comunitária','H':'Hospital','?':'Não esclarecida'};

  const html=`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
  <title>Requisição de Cultura — ${c.pac||''}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;font-family:Arial,sans-serif;font-size:9.5pt;}
    @page{size:A4 portrait;margin:1cm 1.2cm}
    body{color:#000;}
    /* Cabeçalho */
    .cab{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:8px;}
    .cab-txt{font-size:8.5pt;line-height:1.5;}
    .cab-txt b{font-size:9pt;}
    .cab-logo{height:40px;width:auto;}
    h1{text-align:center;font-size:11pt;font-weight:800;text-decoration:underline;margin-bottom:10px;}
    /* Blocos */
    .bloco{border:1px solid #000;padding:6px 8px;margin-bottom:6px;}
    .bloco-titulo{font-weight:800;font-size:9pt;margin-bottom:5px;}
    .campo-linha{display:flex;align-items:baseline;gap:6px;margin-bottom:3px;flex-wrap:wrap;}
    .campo-lbl{font-weight:700;white-space:nowrap;font-size:9pt;}
    .campo-val{border-bottom:1px solid #555;flex:1;min-width:60px;padding:0 2px;font-size:9pt;}
    /* Checkboxes */
    .chk-linha{margin:2px 0 2px 4px;font-size:9pt;line-height:1.6;}
    .sub-linha{margin:1px 0 1px 24px;font-size:9pt;display:flex;gap:16px;flex-wrap:wrap;}
    /* Rodapé */
    .rodape{margin-top:10px;display:flex;justify-content:space-between;align-items:flex-end;}
    .assin-linha{border-top:1px solid #555;text-align:center;min-width:240px;padding-top:2px;font-size:8.5pt;}
    @media print{body{margin:0;}}
  </style></head><body>

  <!-- Cabeçalho -->
  <div class="cab">
    <div class="cab-txt">
      <b>HOSPESC - HOSPITAL DOS PESCADORES</b><br>
      Rua São João de Deus, 80 ROCAS — NATAL. RN - CEP:-59010-775<br>
      FONE: 3232 4592 - <b>Email:</b> hospitaldospescadoresadm@gmail.com
    </div>
    <img src="logo.png" class="cab-logo" alt="" onerror="this.style.display='none'">
  </div>

  <h1>Requisição de Exames Microbiológicos</h1>

  <!-- Dados do paciente -->
  <div class="bloco">
    <div class="bloco-titulo">DADOS DO PACIENTE:</div>
    <div class="campo-linha">
      <span class="campo-lbl">Nome:</span>
      <span class="campo-val">${(c.pac||'').toUpperCase()}</span>
      <span class="campo-lbl" style="margin-left:12px;">Registro:</span>
      <span class="campo-val" style="max-width:80px;">${c.registro||''}</span>
    </div>
    <div class="campo-linha">
      <span class="campo-lbl">Idade:</span>
      <span class="campo-val" style="max-width:40px;">${c.idade||''}</span>
      <span class="campo-lbl">Sexo M ${mkr(c.sexo,'M')} F ${mkr(c.sexo,'F')}</span>
      <span class="campo-lbl" style="margin-left:12px;">Enfermaria/UTI:</span>
      <span class="campo-val">${c.ward||'UTI-HOSPESC'}</span>
      <span class="campo-lbl" style="margin-left:12px;">Leito:</span>
      <span class="campo-val" style="max-width:40px;">${c.leito||''}</span>
    </div>
  </div>

  <!-- Informações sobre o paciente -->
  <div class="bloco">
    <div class="bloco-titulo">INFORMAÇÕES SOBRE O PACIENTE</div>
    <div class="campo-linha">
      <span class="campo-lbl">Indicação clínica ou hipótese diagnóstica:</span>
      <span class="campo-val">${(c.indicacao||'').toUpperCase()}</span>
    </div>
    <div class="campo-linha">
      <span>Paciente esteve internado nas últimas 72h?</span>
      <span style="margin-left:8px;">Sim ${mkr(c.internado72h,'S')} &nbsp; Não ${mkr(c.internado72h,'N')}</span>
    </div>
    <div class="campo-linha">
      <span>Fez uso de antibióticos nos últimos 10 dias?</span>
      <span style="margin-left:8px;">Sim ${mkr(c.atbUltimos10,'S')} &nbsp; Não ${mkr(c.atbUltimos10,'N')}</span>
    </div>
    ${c.atbUltimos10==='S'?`<div class="campo-linha"><span class="campo-lbl">Quais?</span><span class="campo-val">${(c.atbQuais||'').toUpperCase()}</span></div>`:''}
    <div class="campo-linha">
      <span>Paciente transferido de outro hospital, casas de apoio ou home care?</span>
      <span style="margin-left:8px;">Sim ${mkr(c.transferido,'S')} &nbsp; Não ${mkr(c.transferido,'N')}</span>
    </div>
    <div class="campo-linha">
      <span>Tipos de infecção:</span>
      <span style="margin-left:8px;">
        Comunitária ${mkr(c.tipoInfeccao,'C')} &nbsp;
        Hospital ${mkr(c.tipoInfeccao,'H')} &nbsp;
        Não esclarecida ${mkr(c.tipoInfeccao,'?')}
      </span>
    </div>
    <div class="campo-linha">
      <span class="campo-lbl">Data da coleta:</span>
      <span style="font-size:9pt;">${dd}/${mm}/${yy}</span>
      <span class="campo-lbl" style="margin-left:16px;">Hora da coleta:</span>
      <span style="font-size:9pt;">${(c.horaColeta||'').replace(':',':')}</span>
    </div>
  </div>

  <!-- Identificação do exame -->
  <div class="bloco">
    <div class="bloco-titulo">IDENTIFICAÇÃO DO EXAME</div>
    <div class="chk-linha">${mk(c.uro)} Urocultura com antibiograma: &nbsp;
      jato médio ${mkr(c.uroTp,'jato')} &nbsp;
      SVD ${mkr(c.uroTp,'svd')} &nbsp;
      sonda vesical de alívio ${mkr(c.uroTp,'aliv')}
    </div>
    <div class="chk-linha">${mk(c.copro)} Coprocultura</div>
    <div class="chk-linha">${mk(c.hemo)} Hemocultura</div>
    <div class="chk-linha">${mk(c.cateter)} Cultura de ponta de cateter</div>
    <div class="chk-linha">${mk(c.sec)} Cultura de secreção:</div>
    <div class="sub-linha">
      ${mk(secSubs.includes('traq'))} Traqueal &nbsp;
      ${mk(secSubs.includes('fo'))} Ferida operatória &nbsp;
      ${mk(secSubs.includes('up'))} Úlcera de pressão
    </div>
    <div class="sub-linha">
      ${mk(secSubs.includes('abs'))} Abscesso &nbsp;
      ${mk(c.secOutros)} Outros: <span style="border-bottom:1px solid #555;min-width:120px;display:inline-block;">${c.secOutros||''}</span>
    </div>
    <div class="chk-linha">${mk(c.liq)} Cultura de líquidos cavitários</div>
    <div class="sub-linha">
      ${mk(liqSubs.includes('liquor'))} Líquor &nbsp;
      ${mk(liqSubs.includes('pleural'))} Líquido pleural &nbsp;
      ${mk(liqSubs.includes('sinov'))} Liq. sinovial &nbsp;
      ${mk(liqSubs.includes('ascit'))} Líq. Ascítico
    </div>
    <div class="sub-linha">
      Outros: <span style="border-bottom:1px solid #555;min-width:100px;display:inline-block;">${c.liqOutros||''}</span>
    </div>
    <div class="chk-linha">${mk(c.frag)} Cultura de fragmento de tecido</div>
    <div class="chk-linha">${mk(c.bk)} Cultura para BK (Mycobacterium tuberculosis)</div>
    <div class="chk-linha">${mk(c.fungos)} Cultura para fungos</div>
    <div class="chk-linha">${mk(c.vig)} Cultura de vigilância</div>
    <div class="sub-linha">
      ${mk(vigSubs.includes('nasal'))} Swab nasal &nbsp;
      ${mk(vigSubs.includes('retal'))} Swab retal &nbsp;
      ${mk(c.vigOutros)} Outros: <span style="border-bottom:1px solid #555;min-width:120px;display:inline-block;">${c.vigOutros||''}</span>
    </div>
    <div class="chk-linha">${mk(c.bordet)} Cultura para Bordetella pertussis</div>
    <div class="chk-linha">${mk(c.virus)} Cultura de vírus respiratório:
      <span style="border-bottom:1px solid #555;min-width:180px;display:inline-block;">${c.virusTxt||''}</span>
    </div>
    <div class="chk-linha">${mk(c.fresco)} Exame microscópico a fresco</div>
    <div class="chk-linha">${mk(c.gram)} Exame microscópico GRAM</div>
    <div class="chk-linha">${mk(c.ziehl)} Exame microscópico ZIEHL-NEELSEN</div>
  </div>

  <!-- Observações e assinatura -->
  <div class="bloco">
    <div class="bloco-titulo">OBSERVAÇÕES:</div>
    <div style="min-height:28px;padding:2px 0;font-size:9pt;">${(c.obs||'').toUpperCase()}</div>
  </div>

  <div class="rodape">
    <div style="font-size:9pt;">
      Data: ${dd} / ${mm} / ${yy}
    </div>
    <div class="assin-linha">
      ${c.medNome?c.medNome.toUpperCase():''}${c.medCrm?' — CRM '+c.medCrm:''}<br>Médico / CRM
    </div>
  </div>

  <script>window.onload=()=>{window.print();window.onafterprint=()=>window.close();}<\/script>
  </body></html>`;

  // PDF unificado: pág. 1 = solicitação (1 A4 forçado), pág. 2 = Cartão SUS + 1 etiqueta por material
  if(window.PDFLib && window.html2canvas && window.jspdf){
    _gerarCulturaCompleto(html, c).catch(e=>{
      console.warn('[CulturaCompleto] falhou, abrindo HTML separado:', e);
      const w=window.open('','_blank','width=820,height=1000');
      if(w){ w.document.write(html); w.document.close(); }
      else toast('Popup bloqueado — permita popups para imprimir.',true);
    });
    return;
  }
  // Fallback sem PDF-lib: comportamento anterior
  const w=window.open('','_blank','width=820,height=1000');
  if(w){ w.document.write(html); w.document.close(); }
  else toast('Popup bloqueado — permita popups para imprimir.',true);
  _emitirEtiquetasCultura(c);
}

async function _emitirEtiquetasCultura(c){
  // Fallback: usado apenas quando PDF-lib não está disponível
  const pac  = c.pac||gf('f-pac')||'';
  const cns  = gf('f-cns')||'';
  const dn   = gf('f-dn')||'';
  const leito= c.leito||gf('f-leito')||'';
  const materiais = _cultResumir(c);
  const dadosPac = { pac, dn, leito };
  if(!window.PDFLib){ toast('PDF-lib não carregado — etiquetas não geradas.',true); return; }
  showLoading('Buscando cartão SUS para etiquetas...');
  const cartaoB64 = await _buscarCartaoSUSGenerico(pac, cns);
  hideLoading();
  await _gerarEtiquetasComCartao(cartaoB64, dadosPac, 'cultura', materiais);
}

/* ════════════════════════════════════════════════════════════════════════════
   PDF UNIFICADO DE REQUISIÇÃO DE CULTURAS
   Pág. 1 — Solicitação forçada em 1 A4
   Pág. 2 — Cartão SUS (pág. 0) + 1 etiqueta por material solicitado
            em grid 2 colunas no espaço em branco (metade inferior do cartão)
   ════════════════════════════════════════════════════════════════════════════ */
async function _gerarCulturaCompleto(htmlFicha, c){
  showLoading('Gerando PDF unificado...');
  const container = document.createElement('div');
  container.style.cssText = 'position:fixed;left:-99999px;top:0;width:794px;background:#fff;color:#000;';
  try{
    // ── 1. Renderiza HTML da solicitação em canvas ─────────────────────────────
    const parser  = new DOMParser();
    const docHtml = parser.parseFromString(htmlFicha, 'text/html');
    const styleEl = docHtml.querySelector('style');
    if(styleEl){ const s=document.createElement('style'); s.textContent=styleEl.textContent; container.appendChild(s); }
    const inner = document.createElement('div');
    inner.innerHTML = docHtml.body.innerHTML.replace(/<script[\s\S]*?<\/script>/gi,'');
    inner.style.cssText = 'padding:8mm 10mm;background:#fff;';
    container.appendChild(inner);
    document.body.appendChild(container);
    await new Promise(r => setTimeout(r, 300));

    const canvas = await html2canvas(container, { scale:2, backgroundColor:'#ffffff', useCORS:true });

    // ── 2. Canvas <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-.15em;flex-shrink:0;"><path d="M3 8h10"/><path d="M9.5 4.5L13 8l-3.5 3.5"/></svg> 1 A4 forçado via jsPDF ────────────────────────────────────
    const { jsPDF } = window.jspdf;
    const fichaJsPDF = new jsPDF('p','mm','a4');
    const pdfW = fichaJsPDF.internal.pageSize.getWidth();
    const pdfH = fichaJsPDF.internal.pageSize.getHeight();
    fichaJsPDF.addImage(canvas.toDataURL('image/jpeg',0.93), 'JPEG', 0, 0, pdfW, pdfH);
    const fichaBytes = fichaJsPDF.output('arraybuffer');

    // ── 3. PDF final com pdf-lib ───────────────────────────────────────────────
    const PDFDocument   = window.PDFLib.PDFDocument;
    const StandardFonts = window.PDFLib.StandardFonts;
    const rgb           = window.PDFLib.rgb;
    const merged = await PDFDocument.create();

    // Pág. 1 — ficha
    const fichaDoc  = await PDFDocument.load(fichaBytes);
    const [fichaPg] = await merged.copyPages(fichaDoc, [0]);
    merged.addPage(fichaPg);

    // Pág. 2 — Cartão SUS ou A4 em branco
    let cartaoPage, pgW, pgH2;
    const pac = c.pac || gf('f-pac') || '';
    const cns = gf('f-cns') || '';
    showLoading('Buscando cartão SUS...');
    const cartaoB64 = await _buscarCartaoSUSGenerico(pac, cns);
    hideLoading();

    if(cartaoB64){
      const bin = atob(cartaoB64);
      const cb  = new Uint8Array(bin.length);
      for(let i=0;i<bin.length;i++) cb[i] = bin.charCodeAt(i);
      const cartaoDoc = await PDFDocument.load(cb);
      const [cpg] = await merged.copyPages(cartaoDoc, [0]);
      merged.addPage(cpg);
      cartaoPage = merged.getPage(1);
    } else {
      cartaoPage = merged.addPage([595.28, 841.89]);
    }
    const sz = cartaoPage.getSize();
    pgW  = sz.width;
    pgH2 = sz.height;

    // ── 4. Etiquetas: 1 por material, grid 2 colunas ──────────────────────────
    const font     = await merged.embedFont(StandardFonts.TimesRoman);
    const fontBold = await merged.embedFont(StandardFonts.TimesRomanBold);

    const materiais = _cultResumir(c);          // ex: ['Urocultura (SVD)', 'Hemocultura', ...]
    const leito = (c.leito || gf('f-leito') || '').toString().padStart(2,'0');
    const nome  = (c.pac   || gf('f-pac')   || '').toUpperCase();
    const dn    = _fmtDNEtiq(c.dn || gf('f-dn') || '');

    const N    = Math.min(materiais.length, 8); // máx 8 etiquetas
    const COLS = 2;
    const ROWS = Math.ceil(N / COLS);

    const FS  = 6.5;         // tamanho da fonte
    const LH  = FS * 1.55;  // altura de linha
    const PAD = 4;           // padding interno da caixa
    const N_LINHAS = 6;      // header + nome + dn + material + data + coletado por
    const etiqH = N_LINHAS * LH + PAD * 2;

    const MARG_ESQ  = 16;
    const MARG_DIR  = 16;
    const ENTRE_COL = 10;
    const etiqW = (pgW - MARG_ESQ - MARG_DIR - ENTRE_COL) / COLS;

    // Espaço em branco do Cartão SUS: de y=0 (fundo) até y≈pgH2*0.49 (pdf-lib: y=0 é fundo)
    const blankTop  = pgH2 * 0.49;
    const MARG_INF  = 6;
    const areaH     = blankTop - MARG_INF;
    const blocoH    = areaH / ROWS;

    // Linha separadora tracejada no topo do espaço em branco
    cartaoPage.drawLine({
      start: { x: MARG_ESQ, y: blankTop },
      end:   { x: pgW - MARG_DIR, y: blankTop },
      thickness: 0.4,
      color: rgb(0.5,0.5,0.5),
      dashArray: [4, 3],
    });

    for(let i = 0; i < N; i++){
      const col = i % COLS;
      const row = Math.floor(i / COLS);

      const xBase = MARG_ESQ + col * (etiqW + ENTRE_COL);
      // Centra verticalmente a etiqueta dentro do bloco de cada linha
      const blocoTopo = blankTop - row * blocoH;
      const blocoBot  = blocoTopo - blocoH;
      const boxY = blocoBot + (blocoH - etiqH) / 2;  // y do canto inferior da caixa

      // Borda da etiqueta
      cartaoPage.drawRectangle({
        x: xBase - 2, y: boxY,
        width: etiqW + 4, height: etiqH,
        borderColor: rgb(0,0,0), borderWidth: 0.6,
        color: rgb(1,1,1),
      });

      // Linhas do texto (de cima para baixo dentro da caixa)
      const linhas = [
        `HOSPITAL DOS PESCADORES - UTI (L-${leito})`,
        `NOME: ${nome}`,
        `DN: ${dn}`,
        `MATERIAL: ${materiais[i].toUpperCase()}`,
        `DATA COLETA: ___/___/______`,
        `COLETADO POR: ________________________`,
      ];
      linhas.forEach((txt, li) => {
        const isBold = li === 0 || li === 3; // cabeçalho e MATERIAL em negrito
        cartaoPage.drawText(txt, {
          x: xBase,
          y: boxY + etiqH - PAD - LH*(li+1) + FS*0.25,
          size: FS,
          font: isBold ? fontBold : font,
          color: rgb(0,0,0),
          maxWidth: etiqW - 2,
        });
      });
    }

    // ── 5. Salva e abre para impressão ────────────────────────────────────────
    const finalBytes = await merged.save();
    const blob = new Blob([finalBytes], { type:'application/pdf' });
    const url  = URL.createObjectURL(blob);
    hideLoading();
    const w = window.open(url, '_blank');
    if(w){ setTimeout(()=>{ try{ w.focus(); w.print(); }catch(_){} }, 1200); }
    else toast('Popup bloqueado — permita popups para imprimir.', true);
    setTimeout(() => URL.revokeObjectURL(url), 180000);

  } finally {
    if(container.parentNode) container.parentNode.removeChild(container);
    hideLoading();
  }
}
