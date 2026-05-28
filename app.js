/* ════════════════════════════════════════════════════════════════════════════
   UTI MÉDICA – Hospital dos Pescadores
   app.js  ·  Sistema de evolução médica
   ────────────────────────────────────────────────────────────────────────────
   Estrutura de dados (Firestore — compatível com o sistema de enfermagem):
     uti_leitos                → mapa de leitos (objeto único)
     uti_med_ev_<leito>_<turno>_<data>   → evolução médica de um turno
     uti_med_adm_log_<...>     → log de admissões (para indicadores)
     uti_med_alta_log_<...>    → log de altas
     usuarios_med (coleção)    → perfis dos médicos
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
let _modoOffline = false;

/* ── HELPERS BÁSICOS ──────────────────────────────────────────────────────── */
const $  = id => document.getElementById(id);
const gf = id => { const e = $(id); return e ? (e.value||'') : ''; };
const sf = (id,v) => { const e = $(id); if(e) e.value = (v==null?'':v); };
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

function mostrarTela(id){
  document.querySelectorAll('.tela').forEach(t=>{ t.classList.remove('ativa'); t.style.display='none'; });
  ['t-login','t-turno'].forEach(x=>{ const e=$(x); if(e) e.style.display='none'; });
  const el = $(id);
  if(el){ el.style.display='flex'; el.classList.add('ativa'); }
}
function showLoading(t){ const o=$('loading-overlay'); $('loading-txt').textContent=t||'Carregando...'; o.classList.add('show'); }
function hideLoading(){ $('loading-overlay').classList.remove('show'); }
function toast(msg,err=false){ const t=$('toast'); t.textContent=msg; t.className='toast'+(err?' err':''); t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),3200); }
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
  // considera que há dados suficientes se idade + ao menos alguns fisiológicos existem
  const fis=[d.glasgow,d.pas,d.fc,d.tmax,d.creatinina,d.plaquetas].filter(x=>x!=null).length;
  return (d.idade!=null||d.dn) && fis>=2;
}

// Recalcula e atualiza a UI do SAPS no formulário (chamado a cada input relevante)
function _recalcSAPS(){
  const dados = _coletarDadosSAPS();
  const r = calcularSAPS3(dados);
  $('saps-num').textContent = r.score;
  if(r.temDados){
    $('saps-mort').textContent = (r.mortCSA*100).toFixed(1)+'%';
    $('saps-mort-glob').textContent = 'Equação global: '+(r.mortGlobal*100).toFixed(1)+'%';
  } else {
    $('saps-mort').textContent = '—';
    $('saps-mort-glob').textContent = 'Preencha mais dados fisiológicos e de admissão.';
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

function _coletarDadosSAPS(){
  const num = id => { const v=gf(id); return v===''?null:Number(v); };
  return {
    dn: gf('f-dn'),
    idade: _idadeDeDN(gf('f-dn')),
    glasgow: num('f-glasgow'),
    pas: num('f-pas'),
    fc: num('f-fc'),
    tmax: num('f-tmax'),
    pao2: num('f-pao2'),
    fio2: num('f-fio2'),
    ph: num('f-ph'),
    vent: gf('f-vent'),
    dva: gf('f-dva'),
    // laboratoriais derivados da última linha de exames
    ..._labDerivadosParaSAPS(),
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
    leucocitos: ult.leu!=null&&ult.leu!=='' ? Number(ult.leu)/1000 : null, // espera valor absoluto → ×10³
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
    toast('✓ Senha atualizada.');
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
function escolherTurno(t){ turnoAtual=t; $('badge-turno-leitos').textContent=(t==='DIURNO'?'☀ DIURNO':'🌙 NOTURNO'); renderLeitos(); mostrarTela('t-leitos'); }
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
      h+=`<div class="leito-card ocupado" onclick="abrirFormulario(${i})">
        ${sapsCanto}
        <div class="leito-num">LEITO ${pad(i)}</div>
        <div class="leito-pac">${L.pac}</div>
        <div class="leito-diag">${L.diag||'—'}</div>
        <div class="leito-tags">${sapsBadge}${L.adm?`<span class="leito-tag">UTI ${_fmtDataCurta(L.adm)}</span>`:''}</div>
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
  const sel=(id,val,opts)=>`<select id="${id}">${opts.map(o=>`<option value="${o[0]}" ${val===o[0]?'selected':''}>${o[1]}</option>`).join('')}</select>`;
  const chk=(id,b,lbl,autoKey)=>{
    const auto = autoKey && A[autoKey];
    return `<label style="display:flex;align-items:center;gap:6px;font-size:.78rem;text-transform:none;letter-spacing:0;font-weight:500;${auto?'background:#fdf2dd;border-radius:6px;padding:2px 5px;':''}"><input type="checkbox" id="${id}" ${b?'checked':''} style="width:auto;"> ${lbl}${auto?' <span style="font-size:.6rem;color:var(--laranja);font-weight:700;">✨auto</span>':''}</label>`;
  };
  return `
    <div class="grid2">
      <div class="fl"><label>Local antes da UTI</label>${sel('sa-local',it.localPrevio,[['','—'],['emergencia','Emergência'],['centro_cirurgico','Centro cirúrgico'],['sala_recup','Sala de recuperação'],['outra_uti','Outra UTI'],['enfermaria','Enfermaria/outros']])}</div>
      <div class="fl"><label>Dias de internação antes da UTI</label><input type="number" id="sa-predias" value="${it.preDias!=null?it.preDias:''}" placeholder="0"></div>
      <div class="fl"><label>Tipo de admissão</label>${sel('sa-admtipo',it.admTipo,[['','—'],['planejada','Planejada'],['nao_planejada','Não planejada']])}</div>
      <div class="fl"><label>Status cirúrgico</label>${sel('sa-cirurgia',it.cirurgia,[['','—'],['nao_cirurgico','Não cirúrgico'],['programada','Cirurgia programada'],['urgente','Cirurgia de urgência']])}</div>
      <div class="fl"><label>Local da cirurgia (se houve)</label>${sel('sa-localcir',it.localCir,[['','—'],['transplante','Transplante'],['trauma','Trauma/politrauma'],['cardiaca','Cir. cardíaca'],['neuro_avc','Neurocirurgia/AVC'],['outras_cir','Outras cirurgias']])}</div>
    </div>
    <div style="margin:8px 0;"><strong style="font-size:.74rem;color:var(--vinho);">Comorbidades</strong>
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
    <div style="margin:8px 0;"><strong style="font-size:.74rem;color:var(--vinho);">Motivo de admissão</strong>
      <div class="grid2" style="margin-top:5px;">
        ${chk('sa-coma',m.coma,'Coma/torpor/agitação','coma')}
        ${chk('sa-focal',m.focalNeuro,'Focalidade neurológica','focalNeuro')}
        ${chk('sa-massa',m.efeitoMassa,'Efeito de massa cerebral','efeitoMassa')}
        ${chk('sa-choqueSep',m.choqueSeptico,'Choque séptico','choqueSeptico')}
        ${chk('sa-choqueHipo',m.choqueHipovol,'Choque hipovolêmico','choqueHipovol')}
        ${chk('sa-choqueAna',m.choqueAnafilatico,'Choque anafilático/misto','choqueAnafilatico')}
      </div>
    </div>
    <div style="margin:8px 0;"><strong style="font-size:.74rem;color:var(--vinho);">Infecção na admissão</strong>
      <div class="grid2" style="margin-top:5px;">
        ${chk('sa-infNoso',it.infNoso,'Infecção nosocomial','infNoso')}
        ${chk('sa-infResp',it.infResp,'Infecção respiratória','infResp')}
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
    // arquiva evoluções (mantém para indicadores — não apaga)
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
  {k:'bd',  l:'BD'},      {k:'inr',l:'INR'},   {k:'ttpa',l:'TTPa'},   {k:'gli', l:'Glic'},
  {k:'trop',l:'Tropon'},  {k:'alb',l:'Album'},
];

async function abrirFormulario(leito){
  leitoAtual=leito;
  showLoading('Abrindo evolução...');
  try{
    const ld=await _getLeitos(); const L=ld[leito]||{};
    const dataT=dataDoTurno(turnoAtual);
    $('form-titulo').textContent=`Evolução Médica – Leito ${pad(leito)}`;
    $('form-sub').textContent=`${turnoAtual==='DIURNO'?'☀ Diurno':'🌙 Noturno'} · ${_fmtDataCurta(dataT)} · ${perfilUsuario?perfilUsuario.nome:''}`;
    $('badge-form').textContent=turnoAtual;

    // limpa tudo
    _limparFormulario();
    _itensSAPS = L.itensSAPS || {};

    // 1) herda dados de admissão (sempre visíveis)
    sf('f-pac',L.pac||''); sf('f-dn',L.dn||''); sf('f-sexo',L.sexo||''); sf('f-cns',L.cns||'');
    sf('f-adm',L.adm||''); sf('f-adm-hosp',L.admHosp||''); sf('f-diag',L.diag||''); sf('f-cid',L.cid||'');
    sf('f-alergia',L.alergia||''); sf('f-comor',L.comor||''); sf('f-medcont',L.medcont||'');
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
    hideLoading();
    mostrarTela('t-form');
  }catch(e){ hideLoading(); console.error('abrirFormulario:',e); toast('Erro ao abrir: '+(e.message||e),true); }
}

function _limparFormulario(){
  ['f-pac','f-dn','f-sexo','f-cns','f-adm','f-adm-hosp','f-diag','f-cid','f-alergia','f-comor','f-medcont',
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
  sf('f-pam',ev.pam||''); sf('f-pas',ev.pas||''); sf('f-fc',ev.fc||''); sf('f-fr',ev.fr||'');
  sf('f-tmax',ev.tmax||''); sf('f-spo2',ev.spo2||''); sf('f-diurese',ev.diurese||'');
  sf('f-bh',ev.bh||''); sf('f-evac',ev.evac||''); sf('f-hgt',ev.hgt||'');
  sf('f-ef-ecto',ev.ecto||''); sf('f-ef-neuro',ev.neuro||''); sf('f-glasgow',ev.glasgow||'');
  sf('f-ef-pupilas',ev.pupilas||''); sf('f-ef-acv',ev.acv||''); sf('f-ef-ar',ev.ar||'');
  sf('f-ef-abd',ev.abd||''); sf('f-ef-ext',ev.ext||''); sf('f-ef-pele',ev.pele||''); sf('f-ef-genital',ev.genital||'');
  sf('f-acessos',ev.acessos||''); sf('f-dispositivos',ev.dispositivos||''); sf('f-dieta',ev.dieta||'');
  sf('f-dva',ev.dva||'NAO'); sf('f-sedacao',ev.sedacao||''); sf('f-transfusao',ev.transfusao||'');
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
    hda:gf('f-hda'), admDesc:gf('f-adm-desc'),
    evol:gf('f-evol'), atb:gf('f-atb'), atbPrev:gf('f-atb-prev'),
    pam:gf('f-pam'), pas:n('f-pas'), fc:n('f-fc'), fr:gf('f-fr'), tmax:n('f-tmax'),
    spo2:gf('f-spo2'), diurese:gf('f-diurese'), bh:gf('f-bh'), evac:gf('f-evac'), hgt:gf('f-hgt'),
    ecto:gf('f-ef-ecto'), neuro:gf('f-ef-neuro'), glasgow:n('f-glasgow'), pupilas:gf('f-ef-pupilas'),
    acv:gf('f-ef-acv'), ar:gf('f-ef-ar'), abd:gf('f-ef-abd'), ext:gf('f-ef-ext'),
    pele:gf('f-ef-pele'), genital:gf('f-ef-genital'),
    acessos:gf('f-acessos'), dispositivos:gf('f-dispositivos'), dieta:gf('f-dieta'),
    dva:gf('f-dva'), sedacao:gf('f-sedacao'), transfusao:gf('f-transfusao'),
    vent:gf('f-vent'), ventParam:gf('f-vent-param'), pao2:n('f-pao2'), fio2:n('f-fio2'),
    ph:n('f-ph'), gaso:gf('f-gaso'), imagem:gf('f-imagem'), condutas:gf('f-condutas'),
    microorg:gf('f-microorg'), culturas:_culturasForm, labLinhas:_labLinhas,
    // fisiológicos para SAPS armazenados na evolução
    ..._labDerivadosParaSAPS(),
    autor:usuarioEmail, autorNome:perfilUsuario?perfilUsuario.nome:'', registradoEm:new Date().toISOString()
  };
}

async function salvarEvolucao(){
  if(!gf('f-pac').trim()){ toast('Sem paciente no leito.',true); return; }
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

    hideLoading();
    toast('✓ Evolução salva.');
    $('herd-tag').style.display='none';
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
function _renderLabLinhas(){
  const wrap=$('lab-linhas'); if(!wrap) return;
  if(!_labLinhas.length){ wrap.innerHTML='<div style="font-size:.78rem;color:var(--muted);padding:.4rem;">Nenhuma data registrada. Clique em "+ Adicionar data de exames".</div>'; return; }
  wrap.innerHTML = _labLinhas.map((lin,idx)=>{
    const campos = LAB_CAMPOS.map(c=>`
      <div class="fl"><label>${c.l}</label><input type="number" step="any" value="${(lin.valores&&lin.valores[c.k]!=null)?lin.valores[c.k]:''}" oninput="_setLabVal(${idx},'${c.k}',this.value)"></div>`).join('');
    return `<div class="lab-linha">
      <div class="lab-linha-head">
        <input type="date" value="${lin.data||''}" onchange="_setLabData(${idx},this.value)">
        <span style="font-size:.7rem;color:var(--muted);">valores deste dia</span>
        <button class="lab-del" onclick="_delLabLinha(${idx})" title="Remover">🗑</button>
      </div>
      <div class="lab-grid">${campos}</div>
    </div>`;
  }).join('');
}
function addLinhaLab(){ _labLinhas.push({data:gf('f-data')||hoje(), valores:{}}); _renderLabLinhas(); }
function _setLabData(i,v){ if(_labLinhas[i]) _labLinhas[i].data=v; }
function _setLabVal(i,k,v){ if(_labLinhas[i]){ _labLinhas[i].valores=_labLinhas[i].valores||{}; _labLinhas[i].valores[k]= v===''?undefined:v; if(['cr','bt','leu','plaq'].includes(k)) _recalcSAPS(); } }
function _delLabLinha(i){ _labLinhas.splice(i,1); _renderLabLinhas(); }

let _labCampoAtivo='hb';
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
   ─ action:'culturas'         → por paciente (com antibiograma dos PDFs)
   ─ action:'culturas_agregado'→ panorama CCIH institucional
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
    return `<span class="cult-chip ${pos?'pos':''}" style="${cls}">🦠 ${txt}<span class="x" onclick="_removerCultura(${i})" title="Remover">×</span></span>`;
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
  el.innerHTML='<span style="font-size:.72rem;color:var(--muted);">🔬 Buscando culturas...</span>';
  try{
    const data=await _apsFetch({action:'culturas',paciente:_normalizarNome(paciente),leito,sheetId:CULTURAS_SHEET_ID});
    const positivos=(data.resultados||[]).filter(r=>r.microorg&&!/negativ|contaminad|pendente/i.test(r.resultado||''));
    if(!positivos.length){ el.innerHTML=''; el.style.display='none'; return; }
    positivos.forEach(r=>_adicionarCultura(r.cultura||'',r.microorg||'',r.sensibilidade||'',
      r.dataResultado||r.dataRecebimento||'','planilha',r.antibiograma||null));
    el.innerHTML=`<span style="font-size:.72rem;color:var(--verde);font-weight:600;">✓ ${positivos.length} cultura(s) positiva(s) importada(s) da planilha</span>`;
    setTimeout(()=>{ el.style.display='none'; },4000);
  }catch(e){ el.innerHTML=''; el.style.display='none'; console.warn('[Culturas auto]',e); }
}

// ── Modal completo de busca por paciente ─────────────────────────────────────
async function buscarCulturas(){
  if(!leitoAtual){ toast('Abra uma evolução primeiro.',true); return; }
  const pac=gf('f-pac').trim();
  if(!pac){ toast('Preencha o nome do paciente primeiro.',true); return; }
  if(!APPS_SCRIPT_URL||!CULTURAS_SHEET_ID){
    $('culturas-conteudo').innerHTML='<div class="tip w">Configure <code>APPS_SCRIPT_URL</code> e <code>CULTURAS_SHEET_ID</code> no index.html. Use "✏️ Adicionar manual" enquanto isso.</div>';
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
          <strong style="color:var(--vermelho);">🦠 ${r.microorg}</strong>
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
    <div style="font-weight:700;color:var(--vinho);">🏥 Buscando panorama institucional CCIH...</div>
    <div style="font-size:.74rem;color:var(--muted);margin-top:6px;">${nAbas} meses · até ${nPDFs} antibiogramas. Aguarde ${nAbas<=3?'30–60':'60–120'} s.</div>
  </div>`;
  try{
    const data=await _apsFetch({action:'culturas_agregado',sheetId:CULTURAS_SHEET_ID,maxAbas:nAbas,maxPDFs:nPDFs});
    if(data.error) throw new Error(data.error);
    data._maxAbas=nAbas; _culturasAgregadoCache=data;
    renderIndicadores();
    toast(`✓ ${data.totalCulturas} culturas · ${data.pdfsExtraidos} antibiogramas`);
  }catch(e){
    console.error('[CCIH agregado]',e);
    c.innerHTML=`<div class="tip d">❌ Erro: ${e.message}. <button onclick="_ccihCarregarAgregado(true)" class="btn btn-sm">Tentar novamente</button></div>`;
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
  return `<div class="tip w" style="margin-bottom:10px;">✨ <strong>${n} item(ns) pré-marcado(s) automaticamente</strong> a partir do quadro (DVA, ventilação, diagnóstico, Glasgow, comorbidades). <strong>Revise e ajuste</strong> — você é responsável pela conferência. A idade já entra pela DN.</div>`;
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
    if(cache[key]){ sf(idCid,cache[key]); if(st) st.textContent='✓ cache'; return; }
    const resp=await fetch(APPS_SCRIPT_URL,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},
      body:JSON.stringify({action:'cid',diagnostico:diag})});
    const data=JSON.parse(await resp.text());
    if(data.codigo){ sf(idCid,data.codigo); cache[key]=data.codigo; localStorage.setItem('uti_med_cid_cache',JSON.stringify(cache)); if(st) st.textContent='✓ IA'; }
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
  if(d.dva==='SIM') p.push('Em uso de droga vasoativa.');
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
    <div>Acessos: ${d.acessos||'—'} · Dispositivos: ${d.dispositivos||'—'} · Dieta: ${d.dieta||'—'} · DVA: ${d.dva==='SIM'?'Sim':'Não'} · Ventilação: ${_ventTexto(d.vent)}${d.ventParam?' ('+d.ventParam+')':''}</div>
    ${d.gaso?`<div class="pv-secao">Gasometria</div><div>${d.gaso}</div>`:''}
    <div class="pv-secao">Culturas</div><div>${cult}</div>
    ${labTab?`<div class="pv-secao">Exames Laboratoriais</div>${labTab}`:''}
    ${d.imagem?`<div class="pv-secao">Exames de Imagem</div><div>${d.imagem}</div>`:''}
    <div class="pv-secao">SAPS 3</div>
    <div>Escore: <strong>${r.score}</strong> pontos · Mortalidade prevista (Am. do Sul): <strong>${r.temDados?(r.mortCSA*100).toFixed(1)+'%':'—'}</strong>${r.temDados?' · global: '+(r.mortGlobal*100).toFixed(1)+'%':''}</div>
    <div class="pv-secao">Condutas</div><div>${d.condutas||'—'}</div>
    <div class="pv-assinatura"><div class="linha"></div>${assinatura}<br><span style="font-size:.68rem;color:#888;">Evolução médica · ${_fmtDataCurta(d.data)} ${agoraHora()}</span></div>
  `;
  $('modal-preview').classList.add('show');
}
function _labParaTabela(linhas){
  if(!linhas||!linhas.length) return '';
  const ord=[...linhas].filter(l=>l.data).sort((a,b)=>a.data.localeCompare(b.data));
  if(!ord.length) return '';
  const usados=LAB_CAMPOS.filter(c=>ord.some(l=>l.valores&&l.valores[c.k]!=null&&l.valores[c.k]!==''));
  if(!usados.length) return '';
  let h='<table><tr><th>Data</th>'+usados.map(c=>`<th>${c.l}</th>`).join('')+'</tr>';
  ord.forEach(l=>{ h+=`<tr><td>${_fmtDataCurta(l.data)}</td>`+usados.map(c=>`<td>${(l.valores&&l.valores[c.k]!=null)?l.valores[c.k]:'—'}</td>`).join('')+'</tr>'; });
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
function _ativarCaixaAlta(){
  const sel='#t-form input[type=text], #t-form textarea, #modal-adm input[type=text], #modal-adm textarea';
  document.querySelectorAll(sel).forEach(el=>{
    if(el.dataset.upperBound) return; el.dataset.upperBound='1';
    el.addEventListener('input',function(){ const p=this.selectionStart; const up=this.value.toUpperCase();
      if(this.value!==up){ this.value=up; try{this.setSelectionRange(p,p);}catch(_){} } });
  });
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
    toast('✓ Médico cadastrado.');
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
  h+='<div class="ind-hint">📌 Pacientes-dia = pares únicos (leito × dia) com evolução registrada no período (convenção ANVISA). A taxa de ocupação reflete o estado atual dos leitos.</div>';
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
  h+='<div class="ind-hint">📌 SMR (Standardized Mortality Ratio) = óbitos observados ÷ soma das mortalidades previstas. SMR &lt; 1 sugere desempenho melhor que o previsto pelo escore; &gt; 1, pior. Interpretar com cautela em amostras pequenas.</div>';
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
  h+='<div class="ind-hint">📌 Taxas = (dispositivo-dia ÷ pacientes-dia) × 100. Dispositivo-dia = pares únicos (leito × dia) com o suporte registrado na evolução.</div>';
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
        <button class="btn btn-pri btn-sm" onclick="_ccihCarregarAgregado(false,3)">🏥 Panorama institucional (3 meses)</button>
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
  h+='<div class="ind-hint">📌 Baseado nas culturas registradas nas evoluções. Para o panorama completo com antibiograma de todos os pacientes da planilha CCIH, use o botão "Panorama institucional" acima.</div>';
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
        <div style="font-weight:700;font-size:.86rem;">🏥 Panorama institucional CCIH</div>
        <div style="font-size:.72rem;opacity:.9;">${dados.totalCulturas||0} culturas · ${dados.pacientesAnalisados||0} pacientes · ${dados.pdfsExtraidos||0} antibiogramas · ${abas===99?'todas as abas':abas+(abas===1?' mês':' meses')}</div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <select onchange="_ccihCarregarAgregado(true,+this.value)" style="background:rgba(255,255,255,.15);color:white;border:1px solid rgba(255,255,255,.3);border-radius:6px;padding:4px 8px;font-size:.72rem;cursor:pointer;">
          <option value="1" ${abas===1?'selected':''}>1 mês</option><option value="3" ${abas===3?'selected':''}>3 meses</option>
          <option value="6" ${abas===6?'selected':''}>6 meses</option><option value="99" ${abas===99?'selected':''}>Todas</option>
        </select>
        <button class="btn btn-sm" style="background:rgba(255,255,255,.15);color:white;border-color:rgba(255,255,255,.3);" onclick="_ccihLimparAgregado()">← Local</button>
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
    h+=`<div class="tip d" style="margin-top:8px;">⚠️ Nenhum antibiograma extraído dos PDFs. Verifique se a conta do Apps Script tem acesso aos arquivos no Drive. Rode <code>_testarColunaL</code> no editor do Apps Script.</div>`;
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
  h+='<div class="ind-hint" style="margin-top:8px;">📌 PDR = Pan-resistente · XDR = Extensivamente resistente · MDR = Multirresistente (Magiorakos et al. 2012). Versão simplificada: conta classes de antibióticos com resistência.</div>';
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
