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
        <div class="leito-card-actions" style="margin-top:8px;display:flex;gap:4px;width:100%;z-index:10;" onclick="event.stopPropagation();">
          <button class="btn btn-sm" style="flex:1;font-size:0.62rem;padding:2px 4px;border-radius:4px;background:rgba(122,16,32,0.1);border:1px solid var(--vinho);color:var(--vinho);" onclick="abrirFormularioDirect(${i},'evolucao')">📋 Evolução</button>
          <button class="btn btn-sm" style="flex:1;font-size:0.62rem;padding:2px 4px;border-radius:4px;background:rgba(122,16,32,0.1);border:1px solid var(--vinho);color:var(--vinho);" onclick="abrirFormularioDirect(${i},'prescricao')">💊 Presc.</button>
          <button class="btn btn-sm" style="flex:1;font-size:0.62rem;padding:2px 4px;border-radius:4px;background:rgba(122,16,32,0.1);border:1px solid var(--vinho);color:var(--vinho);" onclick="abrirFormularioDirect(${i},'guias')">📄 Guias</button>
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
    mudarAba('evolucao'); // sempre abre na aba de evolução
    hideLoading();
    mostrarTela('t-form');
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
    peso:gf('f-peso'), altura:gf('f-altura'),
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
function _setLabVal(i,k,v){
  if(_labLinhas[i]){
    _labLinhas[i].valores=_labLinhas[i].valores||{};
    _labLinhas[i].valores[k]= v===''?undefined:v;
    if(['cr','bt','leu','plaq'].includes(k)){ _recalcSAPS(); }
    if(k==='cr') _atualizarTFG();
  }
}
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
  if(aba==='laboratorio') _renderLabLinhas();
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
  {nome:'AMPICILINA + SULBACTAM 3G', qtd:'3', apres:'FA', dose:'3G', diluicao:'+ 250ML SF 0,9%', via:'EV', freq:'8/8H', hor:['08','16','24'], cat:'ATB', obs:'informar D0'},
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
  {nome:'COLISTINA 500.000UI', qtd:'', apres:'FA', dose:'500.000UI', diluicao:'+ 200ML SG 5%', via:'EV', freq:'12/12H', hor:['08','20'], cat:'ATB', obs:'ataque 5mg/kg — informar D0'},
  {nome:'ERTAPENEM 1G', qtd:'1', apres:'FA', dose:'1G', diluicao:'+ 100ML SF 0,9%', via:'EV', freq:'24/24H', hor:['08'], cat:'ATB', obs:''},
  {nome:'FLUCONAZOL 200MG/100ML', qtd:'1', apres:'BOLSA', dose:'200MG/100ML', diluicao:'', via:'EV', freq:'24/24H', hor:['08'], cat:'ATB', obs:''},
  {nome:'GENTAMICINA 40MG/ML 2ML', qtd:'2', apres:'ML', dose:'40MG/ML', diluicao:'+ 100ML SF 0,9%', via:'EV', freq:'24/24H', hor:['08'], cat:'ATB', obs:'ajustar TFG — dosar nível'},
  {nome:'GENTAMICINA 40MG/ML 1ML', qtd:'1', apres:'ML', dose:'40MG/ML', diluicao:'+ 100ML SF 0,9%', via:'EV', freq:'24/24H', hor:['08'], cat:'ATB', obs:''},
  {nome:'IVERMECTINA 6MG', qtd:'', apres:'COMP', dose:'6MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'ATB', obs:'dose pelo peso'},
  {nome:'LEVOFLOXACINO 500MG/100ML', qtd:'1', apres:'BOLSA', dose:'500MG/100ML', diluicao:'', via:'EV', freq:'24/24H', hor:['08'], cat:'ATB', obs:'infundir em 60min'},
  {nome:'LINEZOLIDA 600MG/300ML', qtd:'1', apres:'BOLSA', dose:'600MG/300ML', diluicao:'', via:'EV', freq:'12/12H', hor:['08','20'], cat:'ATB', obs:''},
  {nome:'MEROPENEM 500MG', qtd:'1', apres:'FA', dose:'500MG', diluicao:'+ 100ML SF 0,9%', via:'EV', freq:'8/8H', hor:['08','16','24'], cat:'ATB', obs:'informar D0'},
  {nome:'MEROPENEM 1G', qtd:'1', apres:'FA', dose:'1G', diluicao:'+ 100ML SF 0,9%', via:'EV', freq:'8/8H', hor:['08','16','24'], cat:'ATB', obs:'informar D0'},
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
  {nome:'PIPERACILINA 4G + TAZOBACTAM 500MG', qtd:'1', apres:'FA', dose:'4G+0,5G', diluicao:'+ 100ML SF 0,9%', via:'EV', freq:'6/6H', hor:['06','12','18','24'], cat:'ATB', obs:'infundir em 4h — informar D0'},
  {nome:'POLIMIXINA B 500.000UI', qtd:'', apres:'FA', dose:'500.000UI', diluicao:'+ 100ML SF 0,9%', via:'EV', freq:'12/12H', hor:['08','20'], cat:'ATB', obs:'informar D0'},
  {nome:'RHZE/RIPE 150+75+400+275MG', qtd:'', apres:'COMP', dose:'150+75+400+275MG', diluicao:'', via:'VO', freq:'24/24H', hor:['08'], cat:'ATB', obs:'DOTS — em jejum'},
  {nome:'TEICOPLANINA 400MG', qtd:'1', apres:'FA', dose:'400MG', diluicao:'+ 100ML SF 0,9%', via:'EV', freq:'24/24H', hor:['08'], cat:'ATB', obs:'ataque 12/12h x3 doses'},
  {nome:'TIGECICLINA 50MG', qtd:'2', apres:'FA', dose:'50MG', diluicao:'+ 100ML SF 0,9%', via:'EV', freq:'12/12H', hor:['08','20'], cat:'ATB', obs:'ataque 100mg — informar D0'},
  {nome:'VANCOMICINA 1G', qtd:'1', apres:'FA', dose:'1G', diluicao:'+ 100ML SF 0,9%', via:'EV', freq:'12/12H', hor:['08','20'], cat:'ATB', obs:'dosar nível — informar D0'},
  {nome:'VANCOMICINA 500MG', qtd:'1', apres:'FA', dose:'500MG', diluicao:'+ 100ML SF 0,9%', via:'EV', freq:'6/6H', hor:['06','12','18','24'], cat:'ATB', obs:'dosar nível — ajustar TFG'},
  {nome:'AMICACINA 500MG', qtd:'1', apres:'FA', dose:'500MG', diluicao:'+ 100ML SF 0,9%', via:'EV', freq:'24/24H', hor:['08'], cat:'ATB', obs:'dosar nível'},
  {nome:'ALBENDAZOL 4MG/ML 10ML', qtd:'10', apres:'ML', dose:'4MG/ML', diluicao:'', via:'VO', freq:'12/12H', hor:['08','20'], cat:'ATB', obs:'junto à refeição'},
  {nome:'PERMETRINA 5% LOÇÃO 60ML', qtd:'', apres:'FR', dose:'5%', diluicao:'', via:'TD', freq:'ACM', hor:['ACM'], cat:'ATB', obs:'lavar após 8-14h'},
  {nome:'SF 0,9% 120ML EV EM BIC ~5ML/H', qtd:'120', apres:'ML', dose:'0,9%', diluicao:'', via:'EV', freq:'BIC ACM', hor:['BIC'], cat:'Hidratação', obs:''},
  {nome:'SF 0,9% 250ML EV EM BIC', qtd:'250', apres:'ML', dose:'0,9%', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Hidratação', obs:''},
  {nome:'SF 0,9% 500ML EV EM BIC', qtd:'500', apres:'ML', dose:'0,9%', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Hidratação', obs:''},
  {nome:'SF 0,9% 1000ML EV EM BIC 42ML/H', qtd:'1000', apres:'ML', dose:'0,9%', diluicao:'', via:'EV', freq:'BIC ACM', hor:['BIC'], cat:'Hidratação', obs:''},
  {nome:'SG 5% 420ML + BICARBONATO DE SÓDIO 8,4% 80ML', qtd:'500', apres:'ML', dose:'5%', diluicao:'+ 80ML BIC 8,4%', via:'EV', freq:'BIC ACM', hor:['BIC'], cat:'Hidratação', obs:'~84ML/H'},
  {nome:'RINGER LACTATO 500ML ETAPA RÁPIDA', qtd:'500', apres:'ML', dose:'—', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Hidratação', obs:''},
  {nome:'RINGER LACTATO 1500ML EV EM BIC ~63ML/H', qtd:'1500', apres:'ML', dose:'—', diluicao:'', via:'EV', freq:'BIC ACM', hor:['BIC'], cat:'Hidratação', obs:''},
  {nome:'RINGER LACTATO 120ML EV EM BIC 5ML/H', qtd:'120', apres:'ML', dose:'—', diluicao:'', via:'EV', freq:'BIC ACM', hor:['BIC'], cat:'Hidratação', obs:''},
  {nome:'SORO FISIOLÓGICO 0,9% EV EM BIC A 4ML/H', qtd:'', apres:'ML', dose:'0,9%', diluicao:'', via:'EV', freq:'BIC ACM', hor:['BIC'], cat:'Hidratação', obs:''},
  {nome:'JELCO HIDRATADO', qtd:'', apres:'—', dose:'', diluicao:'', via:'EV', freq:'—', hor:[], cat:'Hidratação', obs:''},
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
  {nome:'DEXMEDETOMIDINA 200MCG', qtd:'', apres:'AMP', dose:'200MCG', diluicao:'+ SF 0,9%', via:'EV', freq:'BIC ACM', hor:['BIC'], cat:'Sedação', obs:'BIC — protocolo'},
  {nome:'KETAMINA 500MG', qtd:'', apres:'FA', dose:'500MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:''},
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
  {nome:'METOCLOPRAMIDA 10MG/2ML', qtd:'1', apres:'AMP', dose:'10MG/2ML', diluicao:'+ 18ML SF 0,9%', via:'EV', freq:'8/8H SN', hor:['SN'], cat:'Medicação Geral', obs:'se necessário'},
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
  // ════════ Itens integrados do MEDS_UTI (SUS 2024) ════════
  // ── ATB ──
  {nome:'ALBENDAZOL', qtd:'1', apres:'COMP', dose:'400MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'ATB', obs:'Antiparasitário'},
  {nome:'AMICACINA', qtd:'1', apres:'AMP', dose:'500MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'ATB', obs:'Aminoglicosídeo'},
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
  {nome:'GENTAMICINA', qtd:'1', apres:'AMP', dose:'40MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'ATB', obs:'Aminoglicosídeo'},
  {nome:'IMIPENEM+CILASTATINA', qtd:'1', apres:'FA', dose:'500MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'ATB', obs:'Carbapenem'},
  {nome:'LEVOFLOXACINO', qtd:'1', apres:'COMP', dose:'500MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'ATB', obs:'Quinolona'},
  {nome:'METRONIDAZOL', qtd:'1', apres:'FR', dose:'500MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'ATB', obs:'Antiparasitário/ATB'},
  {nome:'MOXIFLOXACINO', qtd:'1', apres:'COMP', dose:'400MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'ATB', obs:'Quinolona'},
  {nome:'PENICILINA G CRISTALINA', qtd:'1', apres:'FA', dose:'5.000.000UI', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'ATB', obs:'Penicilina'},
  {nome:'PIPERACILINA+TAZOBACTAM', qtd:'1', apres:'FA', dose:'4,5G', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'ATB', obs:'Penicilina/β-lact'},
  {nome:'SULFADIAZINA DE PRATA', qtd:'1', apres:'BISN', dose:'', diluicao:'', via:'TD', freq:'ACM', hor:['ACM'], cat:'ATB', obs:'ATB tópico'},
  {nome:'SULFAMETOXAZOL+TRIMETOPRIMA', qtd:'1', apres:'AMP', dose:'', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'ATB', obs:'Sulfa'},
  {nome:'VORICONAZOL', qtd:'1', apres:'FA', dose:'200MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'ATB', obs:'Antifúngico'},
  // ── Droga Vasoativa ──
  {nome:'DOPAMINA', qtd:'1', apres:'AMP', dose:'50MG', diluicao:'', via:'EV', freq:'BIC ACM', hor:['BIC'], cat:'Droga Vasoativa', obs:'Amina Vasoativa · ⚠ MPP/ALTA VIGILÂNCIA'},
  {nome:'EFEDRINA', qtd:'1', apres:'AMP', dose:'5%', diluicao:'', via:'EV', freq:'BIC ACM', hor:['BIC'], cat:'Droga Vasoativa', obs:'Amina Vasoativa · ⚠ MPP/ALTA VIGILÂNCIA'},
  {nome:'EPINEFRINA', qtd:'1', apres:'AMP', dose:'1MG/ML', diluicao:'', via:'EV', freq:'BIC ACM', hor:['BIC'], cat:'Droga Vasoativa', obs:'Amina Vasoativa · ⚠ MPP/ALTA VIGILÂNCIA'},
  {nome:'ISOPRENALINA', qtd:'1', apres:'AMP', dose:'0,2MG/ML', diluicao:'', via:'EV', freq:'BIC ACM', hor:['BIC'], cat:'Droga Vasoativa', obs:'Amina Vasoativa · ⚠ MPP/ALTA VIGILÂNCIA'},
  {nome:'LEVOSIMENDANA', qtd:'1', apres:'FA', dose:'12,5MG', diluicao:'', via:'EV', freq:'BIC ACM', hor:['BIC'], cat:'Droga Vasoativa', obs:'Estimulante cardíaco'},
  {nome:'METARAMINOL', qtd:'1', apres:'AMP', dose:'10MG', diluicao:'', via:'EV', freq:'BIC ACM', hor:['BIC'], cat:'Droga Vasoativa', obs:'Amina Vasoativa · ⚠ MPP/ALTA VIGILÂNCIA'},
  {nome:'MILRINONE', qtd:'1', apres:'FA', dose:'1MG/ML', diluicao:'', via:'EV', freq:'BIC ACM', hor:['BIC'], cat:'Droga Vasoativa', obs:'Cardiotônico'},
  {nome:'NOREPINEFRINA', qtd:'1', apres:'AMP', dose:'1MG/ML', diluicao:'', via:'EV', freq:'BIC ACM', hor:['BIC'], cat:'Droga Vasoativa', obs:'Amina Vasoativa · ⚠ MPP/ALTA VIGILÂNCIA'},
  {nome:'VASOPRESSINA', qtd:'1', apres:'AMP', dose:'20U/ML', diluicao:'', via:'EV', freq:'BIC ACM', hor:['BIC'], cat:'Droga Vasoativa', obs:'Amina Vasoativa · ⚠ MPP/ALTA VIGILÂNCIA'},
  // ── Sedação ──
  {nome:'CISATRACÚRIO', qtd:'1', apres:'AMP', dose:'2MG/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Bloq. Neuromuscular · ⚠ MPP/ALTA VIGILÂNCIA'},
  {nome:'CLONAZEPAM', qtd:'1', apres:'COMP', dose:'2MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Anticonvulsivante/BZD'},
  {nome:'CODEÍNA', qtd:'', apres:'ML', dose:'3MG/ML', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Analgésico Narcótico · ⚠ MPP/ALTA VIGILÂNCIA'},
  {nome:'DEXMEDETOMIDINA', qtd:'1', apres:'BOLSA', dose:'4MCG/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Sedativo'},
  {nome:'DIAZEPAM', qtd:'1', apres:'AMP', dose:'10MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'BZD/Anticonvulsivante'},
  {nome:'ETOMIDATO', qtd:'1', apres:'AMP', dose:'20MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Anestésico venoso'},
  {nome:'FENTANILA', qtd:'1', apres:'AMP', dose:'50MCG/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Analgésico Narcótico · ⚠ MPP/ALTA VIGILÂNCIA'},
  {nome:'FLUMAZENIL', qtd:'1', apres:'AMP', dose:'0,5MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Antídoto BZD'},
  {nome:'KETAMINA', qtd:'1', apres:'AMP', dose:'50MG/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Anestésico venoso'},
  {nome:'METADONA', qtd:'1', apres:'AMP', dose:'10MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Analgésico Narcótico · ⚠ MPP/ALTA VIGILÂNCIA'},
  {nome:'METADONA', qtd:'1', apres:'COMP', dose:'10MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Analgésico Narcótico · ⚠ MPP/ALTA VIGILÂNCIA'},
  {nome:'MIDAZOLAM', qtd:'1', apres:'AMP', dose:'15MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Sedativo/BZD · ⚠ MPP/ALTA VIGILÂNCIA'},
  {nome:'MORFINA', qtd:'1', apres:'BOLSA', dose:'1MG/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Analgésico Narcótico · ⚠ MPP/ALTA VIGILÂNCIA'},
  {nome:'NALBUFINA', qtd:'1', apres:'AMP', dose:'10MG/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Analgésico Narcótico · ⚠ MPP/ALTA VIGILÂNCIA'},
  {nome:'NEOSTIGMINA', qtd:'1', apres:'AMP', dose:'0,5MG/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Antídoto BNM'},
  {nome:'PROPOFOL', qtd:'1', apres:'FR', dose:'10MG/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Anestésico venoso'},
  {nome:'PROPOFOL', qtd:'1', apres:'AMP', dose:'10MG/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Anestésico venoso'},
  {nome:'REMIFENTANILA', qtd:'1', apres:'FA', dose:'2MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Analgésico Narcótico · ⚠ MPP/ALTA VIGILÂNCIA'},
  {nome:'ROCURÔNIO', qtd:'1', apres:'FA', dose:'50MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Bloq. Neuromuscular · ⚠ MPP/ALTA VIGILÂNCIA'},
  {nome:'SUFENTANILA', qtd:'1', apres:'AMP', dose:'5MCG/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Analgésico Narcótico · ⚠ MPP/ALTA VIGILÂNCIA'},
  {nome:'SUGAMADEX', qtd:'1', apres:'FA', dose:'100MG/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Antídoto BNM'},
  {nome:'SUXAMETÔNIO', qtd:'1', apres:'FA', dose:'100MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Bloq. Neuromuscular · ⚠ MPP/ALTA VIGILÂNCIA'},
  {nome:'TIOPENTAL', qtd:'1', apres:'FA', dose:'1G', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Anestésico venoso'},
  {nome:'TRAMADOL', qtd:'1', apres:'CAP', dose:'50MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Sedação', obs:'Analgésico Narcótico · ⚠ MPP/ALTA VIGILÂNCIA'},
  // ── Hidratação ──
  {nome:'ALBUMINA HUMANA', qtd:'1', apres:'FR', dose:'20%', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Hidratação', obs:'Expansor volemico'},
  {nome:'CITRATO TRISSÓDICO 4%', qtd:'1', apres:'BOLSA', dose:'', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Hidratação', obs:'Solução diálise'},
  {nome:'CLORETO DE SÓDIO', qtd:'1', apres:'FR', dose:'0,9%', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Hidratação', obs:'Solução parenteral'},
  {nome:'GLICOSE', qtd:'1', apres:'FR', dose:'5%', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Hidratação', obs:'Solução parenteral'},
  {nome:'SOLUÇÃO DIÁLISE PERITONEAL 1,5%', qtd:'1', apres:'BOLSA', dose:'', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Hidratação', obs:'Solução diálise'},
  // ── Medicação Geral ──
  {nome:'ACETAZOLAMIDA', qtd:'1', apres:'COMP', dose:'250MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Diurético/Antiglaucoma'},
  {nome:'ADENOSINA', qtd:'1', apres:'AMP', dose:'3MG/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Antiarrítmico · ⚠ MPP/ALTA VIGILÂNCIA'},
  {nome:'ALTEPLASE', qtd:'1', apres:'FA', dose:'20MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Trombolítico'},
  {nome:'AMINOFILINA', qtd:'1', apres:'AMP', dose:'24MG/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Broncodilatador'},
  {nome:'APIXABANA', qtd:'1', apres:'COMP', dose:'2,5MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Anticoagulante · ⚠ MPP/ALTA VIGILÂNCIA'},
  {nome:'ATENOLOL', qtd:'1', apres:'COMP', dose:'25MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Beta-bloq.'},
  {nome:'ATROPINA', qtd:'1', apres:'AMP', dose:'0,25MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Anticolinérgico/Antídoto'},
  {nome:'BICARBONATO DE SÓDIO', qtd:'1', apres:'AMP', dose:'8,4%', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Eletrólito'},
  {nome:'BICARBONATO DE SÓDIO', qtd:'1', apres:'FR', dose:'8,4%', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Eletrólito'},
  {nome:'BISACODIL', qtd:'', apres:'—', dose:'DRÁGEA', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Laxante'},
  {nome:'BUDESONIDA', qtd:'', apres:'—', dose:'0,5MG/2MLNEBULIZAÇÃO', diluicao:'', via:'IN', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Corticosteroide inalatório'},
  {nome:'CARBAMAZEPINA', qtd:'1', apres:'COMP', dose:'200MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Anticonvulsivante'},
  {nome:'CETOPROFENO', qtd:'1', apres:'AMP', dose:'100MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'AINE'},
  {nome:'CETOROLACO', qtd:'1', apres:'AMP', dose:'30MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'AINE'},
  {nome:'CITRATO DE SÓDIO', qtd:'1', apres:'AMP', dose:'4%', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Anticoagulante regional · ⚠ MPP/ALTA VIGILÂNCIA'},
  {nome:'CLONIDINA', qtd:'1', apres:'AMP', dose:'150MCG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Anti-hipertensivo'},
  {nome:'CLOPIDOGREL', qtd:'1', apres:'COMP', dose:'75MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Antiagregante'},
  {nome:'CLORETO DE CÁLCIO', qtd:'1', apres:'AMP', dose:'10%', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Eletrólito'},
  {nome:'CLORETO DE POTÁSSIO', qtd:'', apres:'—', dose:'7GENV(HEMODIÁLISE)', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Eletrólito · ⚠ MPP/ALTA VIGILÂNCIA'},
  {nome:'CLORETO DE SÓDIO', qtd:'1', apres:'AMP', dose:'20%', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Eletrólito · ⚠ MPP/ALTA VIGILÂNCIA'},
  {nome:'COLAGENASE', qtd:'1', apres:'BISN', dose:'', diluicao:'', via:'TD', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Cicatrizante'},
  {nome:'DABIGATRANA', qtd:'1', apres:'CAP', dose:'150MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Anticoagulante · ⚠ MPP/ALTA VIGILÂNCIA'},
  {nome:'DESLANOSÍDEO', qtd:'1', apres:'AMP', dose:'0,4MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Glicosídeo cardíaco'},
  {nome:'DESMOPRESSINA', qtd:'1', apres:'AMP', dose:'4MCG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Hormônio antidiurético'},
  {nome:'DEXAMETASONA', qtd:'1', apres:'FA', dose:'4MG/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Corticosteroide'},
  {nome:'DILTIAZEM', qtd:'1', apres:'COMP', dose:'60MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'BCC/Antiarrítmico'},
  {nome:'ESMOLOL', qtd:'1', apres:'FA', dose:'2500MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Antiarrítmico · ⚠ MPP/ALTA VIGILÂNCIA'},
  {nome:'ESOMEPRAZOL', qtd:'1', apres:'FA', dose:'40MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'IBP'},
  {nome:'FATOR VII RECOMBINANTE', qtd:'1', apres:'FA', dose:'1MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Hemostático'},
  {nome:'FENITOÍNA', qtd:'1', apres:'AMP', dose:'50MG/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Anticonvulsivante'},
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
  {nome:'HEPARINA', qtd:'1', apres:'FA', dose:'5000UI/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Anticoagulante · ⚠ MPP/ALTA VIGILÂNCIA'},
  {nome:'HEPARINA', qtd:'1', apres:'AMP', dose:'5000UI/0,25ML', diluicao:'', via:'SC', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Anticoagulante · ⚠ MPP/ALTA VIGILÂNCIA'},
  {nome:'HIDROCLOROTIAZIDA', qtd:'1', apres:'COMP', dose:'25MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Diurético'},
  {nome:'IDARUCIZUMABE', qtd:'1', apres:'FA', dose:'50MG/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Antídoto anticoag.'},
  {nome:'INSULINA ASPARTE', qtd:'', apres:'—', dose:'100UI/MLCARPULE', diluicao:'', via:'SC', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Insulina · ⚠ MPP/ALTA VIGILÂNCIA'},
  {nome:'INSULINA DEGLUDECA', qtd:'', apres:'—', dose:'100UI/MLCANETA', diluicao:'', via:'SC', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Insulina · ⚠ MPP/ALTA VIGILÂNCIA'},
  {nome:'INSULINA GLARGINA', qtd:'1', apres:'FA', dose:'100UI/ML', diluicao:'', via:'SC', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Insulina · ⚠ MPP/ALTA VIGILÂNCIA'},
  {nome:'INSULINA HUMANA REGULAR', qtd:'1', apres:'FA', dose:'100UI/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Insulina · ⚠ MPP/ALTA VIGILÂNCIA'},
  {nome:'INSULINA LISPRO', qtd:'1', apres:'FA', dose:'100UI/ML', diluicao:'', via:'SC', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Insulina · ⚠ MPP/ALTA VIGILÂNCIA'},
  {nome:'INSULINA NPH', qtd:'1', apres:'FA', dose:'100UI/ML', diluicao:'', via:'SC', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Insulina · ⚠ MPP/ALTA VIGILÂNCIA'},
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
  {nome:'PROPAFENONA', qtd:'1', apres:'COMP', dose:'300MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Antiarrítmico · ⚠ MPP/ALTA VIGILÂNCIA'},
  {nome:'PROPRANOLOL', qtd:'1', apres:'COMP', dose:'40MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Beta-bloq.'},
  {nome:'PROTAMINA', qtd:'1', apres:'AMP', dose:'', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Antídoto anticoag.'},
  {nome:'RANITIDINA/CIMETIDINA', qtd:'1', apres:'AMP', dose:'150MG/ML', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Anti-H2'},
  {nome:'SALBUTAMOL', qtd:'1', apres:'SPRAY', dose:'', diluicao:'', via:'IN', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Beta2-agonista'},
  {nome:'SOTALOL', qtd:'1', apres:'COMP', dose:'120MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Antiarrítmico · ⚠ MPP/ALTA VIGILÂNCIA'},
  {nome:'SUCRALFATO', qtd:'', apres:'—', dose:'2G/10MLFLACONETE', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Protetor gástrico'},
  {nome:'SULFATO DE MAGNÉSIO', qtd:'1', apres:'AMP', dose:'50%', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Anticonvulsivante/Eletrólito'},
  {nome:'TENECTEPLASE', qtd:'1', apres:'FA', dose:'50MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Trombolítico'},
  {nome:'TERLIPRESSINA', qtd:'1', apres:'FA', dose:'1MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Hormônio sistêmico'},
  {nome:'TICAGRELOR', qtd:'1', apres:'COMP', dose:'90MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Antiagregante'},
  {nome:'VALPROATO DE SÓDIO', qtd:'', apres:'—', dose:'50MG/MLSOLUÇÃO', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Anticonvulsivante'},
  {nome:'VERAPAMIL', qtd:'1', apres:'COMP', dose:'80MG', diluicao:'', via:'VO', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Antiarrítmico · ⚠ MPP/ALTA VIGILÂNCIA'},
  {nome:'ÁCIDO AMINOCAPROICO', qtd:'1', apres:'FR', dose:'1G', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Antifibrinolítico'},
  {nome:'ÁCIDO TRANEXÂMICO', qtd:'1', apres:'AMP', dose:'250MG', diluicao:'', via:'EV', freq:'ACM', hor:['ACM'], cat:'Medicação Geral', obs:'Antifibrinolítico'},
];


/* ════════════════════════════════════════════════════════════════════════════
   PRESCRIÇÃO — estado e funções
   ════════════════════════════════════════════════════════════════════════════ */
let _rxItens = [];   // array de itens da prescrição atual
let _rxAcTarget = null; // input do autocomplete ativo

const RX_HORAS = ['01','02','04','06','08','10','12','14','16','18','20','22','24'];
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
  return { id:Date.now()+Math.random(), farm:'', qtd:'', apres:'', dose:'', diluicao:'', via:'EV', freq:'24/24H', hor:[], obs:'', tipo:tipo||'normal', _cat:'Medicação Geral', ddInicio:'' };
}

/* ════════════════════════════════════════════════════════════════════════════
   MOTOR CLÍNICO — TFG, doses por peso, interações, redundância
   ════════════════════════════════════════════════════════════════════════════ */

// ── Função renal — Cockcroft-Gault e CKD-EPI 2021 ──
function _calcularTFG(){
  const peso=parseFloat(gf('f-peso'))||null;
  const dn=gf('f-dn');
  const sexo=(gf('f-sexo')||'').toUpperCase();
  const cr=_ultimaCreatinina();
  if(!cr||!dn) return null;
  const idade=_idadeDeDN(dn);
  if(!idade) return null;

  // Cockcroft-Gault: ((140-idade) × peso × (0.85 se F)) / (72 × Cr)
  let cg=null;
  if(peso){
    cg = ((140-idade)*peso*(sexo==='FEMININO'?0.85:1))/(72*cr);
  }

  // CKD-EPI 2021 (sem raça)
  // 142 × min(Scr/k,1)^α × max(Scr/k,1)^-1.200 × 0.9938^idade × (1.012 se F)
  const k = sexo==='FEMININO' ? 0.7 : 0.9;
  const a = sexo==='FEMININO' ? -0.241 : -0.302;
  const minR = Math.min(cr/k, 1);
  const maxR = Math.max(cr/k, 1);
  const ckdepi = 142 * Math.pow(minR, a) * Math.pow(maxR, -1.200) *
    Math.pow(0.9938, idade) * (sexo==='FEMININO' ? 1.012 : 1);

  return { cg: cg!=null?Math.round(cg):null, ckdepi:Math.round(ckdepi), cr, idade, peso, sexo };
}
function _ultimaCreatinina(){
  // Tenta da última linha de exames; senão, do SAPS
  if(_labLinhas&&_labLinhas.length){
    const ord=[..._labLinhas].filter(l=>l.data).sort((a,b)=>(a.data||'').localeCompare(b.data||''));
    for(let i=ord.length-1;i>=0;i--){
      const v=ord[i].valores&&ord[i].valores.cr;
      if(v!=null&&v!=='') return parseFloat(v);
    }
  }
  return null;
}
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
    calc = ` → <b>${totMin===totMax?totMin:totMin+'-'+totMax} mg</b> p/ ${peso}kg`;
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

// ── Badge "D-X" para itens da categoria ATB ──
let _ddiaCache = {};
function _rxBadgeDdia(it){
  if(it._cat!=='ATB') return '';
  const k=(it.farm||'').toUpperCase().split(/\s+/).slice(0,2).join(' ').trim();
  if(!k||(_ddiaCache[k]===undefined)) return '';
  const d=_ddiaCache[k];
  const cor = d>=10 ? '#b71c1c' : d>=7 ? '#e65100' : '#1565c0';
  return `<span class="rx-ddia" style="background:${cor};" title="D${d} desde a primeira prescrição">D${d}</span>`;
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
  const interacoes=_detectarInteracoes();
  const redund=_detectarRedundancia();
  const omissoes=_detectarOmissoes();
  // D-dias dos ATBs (cache simples por leito)
  _ddiaCache = await _calcularDdiaATBs();

  let h='';
  // Card de TFG (sempre que houver dados)
  if(tfg){
    const corCG = tfg.cg && tfg.cg<30 ? 'var(--vermelho)' : tfg.cg && tfg.cg<60 ? 'var(--laranja)' : 'var(--verde)';
    const corCK = tfg.ckdepi<30 ? 'var(--vermelho)' : tfg.ckdepi<60 ? 'var(--laranja)' : 'var(--verde)';
    h+=`<div class="apoio-card apoio-tfg">
      <div class="apoio-titulo">⚕ FUNÇÃO RENAL</div>
      <div class="apoio-tfg-vals">
        ${tfg.cg!=null?`<div><span class="tfg-num" style="color:${corCG}">${tfg.cg}</span><span class="tfg-unit">Cockcroft-Gault</span></div>`:'<div><span class="tfg-num" style="color:#aaa">?</span><span class="tfg-unit">Cockcroft (peso?)</span></div>'}
        <div><span class="tfg-num" style="color:${corCK}">${tfg.ckdepi}</span><span class="tfg-unit">CKD-EPI 2021</span></div>
      </div>
      <div class="apoio-sub">Cr ${tfg.cr} · ${tfg.idade}a · ${tfg.sexo==='FEMININO'?'♀':'♂'}${tfg.peso?' · '+tfg.peso+'kg':' · sem peso'}</div>
    </div>`;
  }
  // Card de interações
  if(interacoes.length){
    h+=`<div class="apoio-card apoio-alerta">
      <div class="apoio-titulo">⚠ INTERAÇÕES (${interacoes.length})</div>
      ${interacoes.map(i=>`<div class="apoio-item apoio-${i.grav}">
        <b>${i.a.toUpperCase()} + ${i.b.toUpperCase()}</b><br>${i.texto}</div>`).join('')}
    </div>`;
  }
  // Card de redundância
  if(redund.length){
    h+=`<div class="apoio-card apoio-warn">
      <div class="apoio-titulo">⚠ REDUNDÂNCIA DE CLASSE</div>
      ${redund.map(r=>`<div class="apoio-item">
        <b>${r.classe}:</b> ${r.itens.join(' + ').toUpperCase()}</div>`).join('')}
    </div>`;
  }
  // Card de omissões
  if(omissoes.length){
    h+=`<div class="apoio-card apoio-warn">
      <div class="apoio-titulo">💡 OMISSÕES POSSÍVEIS</div>
      ${omissoes.map(o=>`<div class="apoio-item">${o}</div>`).join('')}
    </div>`;
  }
  // Doses por peso pendentes e ajustes renais
  const sugestoes=[], ajustes=[];
  _rxItens.forEach(it=>{
    const s=_sugerirDosePorPeso(it);
    if(s) sugestoes.push({nome:it.farm, ...s});
    if(tfg){
      const tfgUsar = tfg.cg!=null?tfg.cg:tfg.ckdepi;
      const a=_ajusteRenal(it, tfgUsar);
      if(a) ajustes.push({nome:it.farm, ...a, tfgUsar});
    }
  });
  if(sugestoes.length){
    h+=`<div class="apoio-card apoio-info">
      <div class="apoio-titulo">📐 DOSE POR PESO</div>
      ${sugestoes.map(s=>`<div class="apoio-item">
        <b>${s.nome}:</b> ${s.intervalo} ${s.uso}${s.calc||''}${s.nota?' <em>('+s.nota+')</em>':''}</div>`).join('')}
    </div>`;
  }
  if(ajustes.length){
    h+=`<div class="apoio-card apoio-info">
      <div class="apoio-titulo">🔧 AJUSTE PARA FUNÇÃO RENAL (TFG ${ajustes[0].tfgUsar})</div>
      ${ajustes.map(a=>`<div class="apoio-item">
        <b>${a.nome}:</b> ${a.dose}${a.nota?' — <em>'+a.nota+'</em>':''}</div>`).join('')}
    </div>`;
  }

  wrap.innerHTML=h;
  wrap.style.display=h ? '' : 'none';
}



function addItemPrescricao(){ _rxItens.push(_rxNovoItem('normal')); _renderPrescricao(); _rxFocusUltimo(); }
function addItemPrescricaoEspecial(tipo){
  const item=_rxNovoItem(tipo);
  if(tipo==='dieta'){ item.farm='DIETA '; item.via='VO'; item.freq='SND'; item.hor=['SND']; }
  if(tipo==='sn'){    item.freq='SN'; item.hor=['SN']; }
  if(tipo==='cuidados'){ item.via='—'; item.freq='SND'; }
  _rxItens.push(item); _renderPrescricao(); _rxFocusUltimo();
}
function _rxFocusUltimo(){
  setTimeout(()=>{
    const inputs=document.querySelectorAll('#presc-tbody .rx-farm');
    if(inputs.length) inputs[inputs.length-1].focus();
  },60);
}

function _rxRemover(id){ _rxItens=_rxItens.filter(i=>i.id!==id); _renderPrescricao(); }

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
      alertaEl.innerHTML=`<div class="presc-alerta">⚠️ <strong>ALERGIA:</strong> ${alergia.toUpperCase()}</div>`;
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
    const rowCls = it.tipo==='dieta'?'presc-dieta':it.tipo==='sn'?'presc-sn':it.tipo==='cuidados'?'presc-cuidado':'';
    const viaOpts=RX_VIAS.map(v=>`<option ${it.via===v?'selected':''}>${v}</option>`).join('');
    const freqOpts=RX_FREQS.map(f=>`<option ${it.freq===f?'selected':''}>${f}</option>`).join('');
    const apresOpts=RX_APRES.map(a=>`<option ${it.apres===a?'selected':''}>${a}</option>`).join('');
    const dispensa=_rxDispensaDose(it);
    const dosePendente = !dispensa && (!it.dose || it.dose.trim()===''||it.dose==='—');
    const doseStyle = dosePendente ? 'border-color:#e53935!important;background:#fff5f5!important;' : '';
    return `<tr class="${rowCls}">
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
        <button class="presc-del" onclick="_rxRemover(${it.id})" title="Excluir item">🗑</button>
      </td>
    </tr>`;
  }).join('');
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
  ac.style.top=(rect.bottom+window.scrollY+2)+'px';
  ac.style.left=(rect.left+window.scrollX)+'px';
  ac.style.minWidth=Math.max(rect.width,320)+'px';
  const reQ=new RegExp('('+q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+')','gi');
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
  // Diluição vai para Obs (concatenada à obs do banco, se houver)
  it.obs=[m.obs||'', m.diluicao||''].filter(Boolean).join(' · ');
  it._cat=m.cat||'Medicação Geral';
  // Marca D0 se for ATB novo (sem ddInicio anterior)
  if(m.cat==='ATB' && !it.ddInicio) it.ddInicio=gf('f-data')||hoje();
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

// Itens que não precisam de dose (cuidados/dieta sem medicamento)
function _rxDispensaDose(it){
  const semDose=['DIETA','JEJUM','RESTRIÇÃO','PNI','MCC','OP','SSVV','CABECEIRA','MANTER',
    'QUANTIFICAR','FISIOTERAPIA','SONDA','CURATIVO','DECÚBITO','HGT','JELCO','—'];
  return semDose.some(s=>(it.farm||'').toUpperCase().startsWith(s)) ||
    it.tipo==='cuidados' ||
    it.via==='—' || (it.dose||'').trim()==='—';
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
    toast(`✓ ${_rxItens.length} itens importados de ${_fmtDataCurta(ult.data)}.`);
  }catch(e){ hideLoading(); toast('Erro: '+(e.message||e),true); }
}

/* ════════════════════════════════════════════════════════════════════════════
   IMPORTAR MEDICAMENTOS DE USO CONTÍNUO
   ════════════════════════════════════════════════════════════════════════════ */
function importarUsoContinuo(){
  const txt=(gf('f-medcont')||'').trim();
  if(!txt){ toast('Não há medicamentos de uso contínuo registrados na admissão.',true); return; }
  // Divide por vírgula ou ponto-e-vírgula
  const itens=txt.split(/[,;]+/).map(s=>s.trim()).filter(Boolean);
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
  if(adicionados){ _renderPrescricao(); toast(`✓ ${adicionados} item(ns) de uso contínuo importado(s). Revise as doses.`); }
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
          <button class="btn btn-sm" style="color:var(--vermelho);" onclick="excluirTemplate('${t.key}','${t.nome.replace(/'/g,'')}')">🗑</button>
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
    hideLoading(); toast('✓ Template salvo e compartilhado.');
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
    toast(`✓ Template "${tpl.nome}" aplicado.`);
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
  let h=`<div class="tip i" style="margin-bottom:10px;">
    Calcula mL/h conforme as diluições padrão da UTI. ${peso?'Peso atual: <b>'+peso+'kg</b>':'<b style="color:var(--vermelho);">⚠ Sem peso registrado</b> — preencha na evolução.'}</div>
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
    <div id="bic-resultado"></div>`;
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
  if(d.porPeso && !peso) html+=`<span style="color:var(--vermelho);">⚠ Esta droga é dose por peso — registre o peso do paciente.</span>`;
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


async function _salvarPrescricaoCore(){
  if(!leitoAtual){ toast('Abra o prontuário de um paciente.',true); return; }
  // Valida: nenhum medicamento pode ter dose vazia
  const semDose=_rxItens.filter(it=>!_rxDispensaDose(it)&&(!it.dose||it.dose.trim()===''||it.dose.trim()==='—'));
  if(semDose.length){
    const nomes=semDose.map((it,i)=>`${i===0?'':'  '}${it.farm||'item '+(it.id)}`).join('\n');
    toast(`❌ Dose obrigatória:\n${nomes}`,true);
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
    hideLoading(); toast('✓ Prescrição salva.');
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

async function _carregarPrescricao(leito){
  const data=gf('f-data')||hoje();
  const key=`uti_med_rx_${leito}_${data}`;
  const saved=await dbGet(key);
  _rxItens = saved&&saved.itens ? saved.itens : [];
  _rxAtualizarDdias();   // substitui "informar D0" pelo D real
  _snapshotRX();         // snapshot para detectar novos ATBs
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
    @page{size:A4 landscape;margin:.8cm 1cm}
    body{font-family:'Arial Narrow',Arial,sans-serif;font-size:9.5pt;color:#111;}
    .cabecalho{display:flex;justify-content:space-between;align-items:flex-start;
      border-bottom:2px solid #7a1020;padding-bottom:6px;margin-bottom:6px;}
    .cab-centro{text-align:center;flex:1;}
    .cab-titulo{font-size:13pt;font-weight:800;color:#7a1020;letter-spacing:.04em;}
    .cab-sub{font-size:8pt;color:#555;margin-top:1px;}
    .cab-logo{width:80px;text-align:right;font-size:7.5pt;color:#888;}
    .meta-linha{display:flex;gap:6px;margin-bottom:5px;flex-wrap:wrap;}
    .meta-box{border:1px solid #bbb;padding:4px 8px;border-radius:3px;font-size:8.5pt;flex:1;min-width:120px;}
    .meta-box strong{color:#7a1020;}
    .alerta{background:#fde8e6;border:1.5px solid #e57373;padding:4px 10px;border-radius:3px;
      font-size:9pt;color:#7a1020;font-weight:700;margin-bottom:5px;}
    table{width:100%;border-collapse:collapse;font-size:9pt;}
    thead tr{background:#7a1020;color:white;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
    th{padding:5px 6px;text-align:left;font-size:8pt;font-weight:700;border:1px solid #5c0a18;}
    td{border:1px solid #ccc;padding:4px 6px;vertical-align:middle;}
    tr:nth-child(even) td{background:#faf5f6;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
    .tr-dieta td{background:#e6f4ec!important;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
    .tr-sn td{background:#fdf2dd!important;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
    .tr-cuidado td{background:#f0f4ff!important;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
    .n{text-align:center;font-weight:700;color:#7a1020;width:22px;}
    .farm{font-weight:700;}
    .th-num{width:22px;}.th-farm{min-width:220px;}.th-dose{width:85px;}.th-via{width:45px;}
    .th-freq{width:80px;}.th-hor{width:170px;}.th-obs{min-width:90px;}
    .assin{margin-top:18px;display:flex;justify-content:flex-end;}
    .assin-box{border-top:1px solid #555;text-align:center;padding-top:4px;min-width:260px;font-size:8.5pt;}
    .rodape{margin-top:8px;font-size:7.5pt;color:#888;text-align:center;border-top:1px solid #eee;padding-top:4px;}
  </style></head><body>
  <div class="cabecalho">
    <div style="width:100px;text-align:center;">
      <img src="logo.png" alt="" style="max-height:56px;max-width:90px;width:auto;height:auto;"
        onerror="this.style.display='none'">
    </div>
    <div class="cab-centro">
      <div class="cab-titulo">PRESCRIÇÃO MÉDICA — UTI GERAL</div>
      <div class="cab-sub">HOSPITAL DOS PESCADORES · NATAL/RN</div>
    </div>
    <div style="width:100px;text-align:right;font-size:7.5pt;color:#555;line-height:1.6;">
      DATA: ${_fmtDataCurta(data)||'—'}<br>LEITO: ${leito||'?'}
    </div>
  </div>

  <div class="meta-linha">
    <div class="meta-box"><strong>PACIENTE:</strong> ${pac||'—'}</div>
    <div class="meta-box"><strong>LEITO:</strong> ${leito||'?'}</div>
    <div class="meta-box"><strong>DATA:</strong> ${_fmtDataCurta(data)||'—'}</div>
    <div class="meta-box"><strong>ADM UTI:</strong> ${_fmtDataCurta(adm)||'—'}</div>
  </div>
  ${diag?`<div class="meta-linha"><div class="meta-box" style="flex:none;width:100%;"><strong>DIAGNÓSTICO:</strong> ${diag}</div></div>`:''}
  ${alergia&&!/^NEGA$/.test(alergia.trim())?`<div class="alerta">⚠ ALERGIA: ${alergia}</div>`:''}

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
        const hors=(it.hor||[]).join(' · ')||'—';
        // Dose impressa = "qtd apres dose" (ex: "2 FA 1G", "1 COMP 200MG", "40 GTS")
        const doseImpressa=[it.qtd, (it.apres&&it.apres!=='—'?it.apres:''), (it.dose&&it.dose!=='—'?it.dose:'')]
          .filter(Boolean).join(' ')||'—';
        return `<tr class="${rowCls}">
          <td class="n">${i+1}</td>
          <td class="farm">${(it.farm||'—').toUpperCase()}</td>
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
      ${_fichaATBLinhas.length>1?`<button class="presc-del" onclick="_fichaATBLinhas.splice(${i},1);_fatbRenderLinhas()" title="Remover">🗑</button>`:''}
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
    toast('✓ Ficha salva.');
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
    const atbs   = await dbListByPrefix(`uti_med_atb_ficha_${leitoAtual}_`);
    const hemos  = await dbListByPrefix(`uti_med_hemo_ficha_${leitoAtual}_`);
    const termos = await dbListByPrefix(`uti_med_termo_${leitoAtual}_`);
    const arr=[
      ...Object.entries(atbs).map(([k,v])=>({key:k,...v, _tipo:'atb'})),
      ...Object.entries(hemos).map(([k,v])=>({key:k,...v, _tipo:'hemo'})),
      ...Object.entries(termos).map(([k,v])=>({key:k,...v, _tipo:'termo'}))
    ].filter(x=>x.pac||x.nome||x.resp).sort((a,b)=>(b.salvadoEm||'').localeCompare(a.salvadoEm||''));
    if(!arr.length){ w.innerHTML='<span style="font-size:.8rem;color:var(--muted);">Nenhuma ficha salva.</span>'; return; }
    w.innerHTML=arr.map(f=>{
      let icon, titulo, edit, impr;
      if(f._tipo==='hemo'){
        icon='🩸';
        titulo=`Hemoterápicos: ${(f.pedidos||[]).filter(p=>p.selecionado).map(p=>p.label.split(' ').slice(0,2).join(' ')).join(', ')||'—'}`;
        edit=`_abrirHemoExistente('${f.key}')`;
        impr=`_imprimirHemoChave('${f.key}')`;
      } else if(f._tipo==='termo'){
        icon='📋';
        const nomeTermo = f.tipo==='paliativo'?'Cuidados Paliativos':f.tipo==='traqueo'?'Autorização de Traqueostomia':'Termo';
        titulo=`Termo: ${nomeTermo}`;
        edit=`_abrirTermoExistente('${f.key}')`;
        impr=`_imprimirTermoChave('${f.key}')`;
      } else {
        icon='🦠';
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
          <button class="btn btn-sm" onclick="${edit}">✎ Editar</button>
          <button class="btn btn-sm" onclick="${impr}">🖨 Imprimir</button>
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
  const nomes=atbs.map(a=>`${a.motivo==='novo'?'🆕':'✏️'} ${a.farm}`).join('<br>');
  // Guarda os ATBs num campo global para evitar problemas com aspas no onclick
  window._atbsPendentes = atbs.map(a=>a.farm);
  const el=document.createElement('div');
  el.className='modal show'; el.id='modal-atb-prompt';
  el.innerHTML=`<div class="modal-box" style="max-width:480px;">
    <div class="modal-head"><h3>🦠 Ficha de Antimicrobiano</h3></div>
    <div class="modal-body">
      <div class="tip i" style="margin-bottom:12px;">
        ${atbs.length===1?'Um antimicrobiano foi':'Antimicrobianos foram'}
        ${atbs[0].motivo==='novo'?'adicionado(s)':'alterado(s)'} na prescrição:<br>
        <strong style="margin-top:6px;display:block;">${nomes}</strong>
      </div>
      <p style="font-size:.86rem;margin-bottom:14px;">Deseja preencher a ficha de solicitação de antimicrobiano agora?</p>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button class="btn btn-pri" onclick="document.getElementById('modal-atb-prompt').remove();abrirFichaATBComATBs(window._atbsPendentes||[])">✓ Sim, preencher ficha</button>
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
      <td style="white-space:nowrap;">☐ SIM &nbsp; ☐ NÃO</td>
      <td style="white-space:nowrap;">☐ SIM &nbsp; ☐ NÃO</td>
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
        <div class="campo"><label>Origem</label><div class="val">${f.origem==='comunitaria'?'☑ Comunitária  ☐ Hospitalar':'☐ Comunitária  ☑ Hospitalar'}</div></div>
        <div class="campo"><label>Uso</label><div class="val">${f.uso==='profilatico'?'☑ Profilático  ☐ Terapêutico':'☐ Profilático  ☑ Terapêutico'}</div></div>
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
          <td>☐ SIM  ☐ NÃO</td>
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

// D-dia automático na obs — substitui "informar D0" pelo D calculado
function _rxAtualizarDdias(){
  const hoje_=gf('f-data')||hoje();
  _rxItens.forEach(it=>{
    if(it._cat!=='ATB') return;
    if(!it.ddInicio) return;
    const diff=Math.floor((new Date(hoje_+'T00:00:00')-new Date(it.ddInicio+'T00:00:00'))/86400000);
    // Atualiza obs: substitui "informar D0" ou "D0" pelo D real
    if(it.obs) it.obs=it.obs.replace(/\binformar D0\b|\bD0\b(?=\s|$)/gi, `D${diff}`);
    it._ddia=diff;
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
}

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
    hideLoading(); toast('✓ Ficha de hemoterápicos salva.');
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
      <div class="sangue">🩸</div>
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

  const w=window.open('','_blank','width=850,height=950');
  if(w){ w.document.write(html); w.document.close(); }
  else toast('Popup bloqueado — permita popups para imprimir.',true);
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
    hideLoading(); toast('✓ Termo salvo.');
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
    @page{size:A4 portrait;margin:1.5cm}
    body{font-size:10pt;color:#000;line-height:1.55;text-align:justify;}
    .cab{text-align:center;border-bottom:2px solid #7a1020;padding-bottom:8px;margin-bottom:14px;}
    h2.titulo{text-align:center;font-size:11pt;font-weight:800;margin:14px 0 10px;text-transform:uppercase;letter-spacing:.04em;}
    p{margin-bottom:8px;}
    .item{margin-bottom:7px;text-align:justify;}
    .item b{display:inline-block;min-width:18px;}
    .linha-dados{margin:10px 0;line-height:1.9;}
    .campo{display:inline-block;border-bottom:1px solid #555;padding:0 4px;min-width:120px;}
    .campo-grande{display:inline-block;border-bottom:1px solid #555;padding:0 4px;min-width:280px;}
    .assin{margin-top:24px;text-align:center;}
    .assin .linha{border-top:1px solid #555;display:inline-block;min-width:280px;padding-top:3px;font-size:9pt;}
    .duas-assin{display:flex;justify-content:space-between;gap:20px;margin-top:20px;}
    .duas-assin > div{flex:1;text-align:center;}
    .duas-assin .linha{border-top:1px solid #555;padding-top:3px;font-size:9pt;}
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

  <h3 style="font-size:10pt;margin-top:14px;text-decoration:underline;">Preenchimento Obrigatório pelo Paciente ou Representante Legal</h3>
  <div class="linha-dados">
    Nome legível: <span class="campo-grande">${(t.resp||'').toUpperCase()}</span><br>
    Grau de parentesco/vínculo: <span class="campo-grande">${(t.vinculo||'').toUpperCase()}</span><br>
    CPF: <span class="campo">${t.cpf||''}</span> &nbsp;&nbsp; Telefone: <span class="campo">${t.tel||''}</span><br>
    Assinatura: <span class="campo-grande">&nbsp;</span>
  </div>

  <h3 style="font-size:10pt;margin-top:14px;text-decoration:underline;">Preenchimento Obrigatório pela Equipe Médica</h3>
  <p style="font-size:9.5pt;">Expliquei o procedimento ao qual o paciente acima referido está sujeito, ao próprio paciente ou seu representante legal, sobre os benefícios, riscos e alternativas, tendo respondido às perguntas formuladas. De acordo com o meu entendimento, o paciente e/ou seu representante legal, está em condições de compreender o que lhes foi informado.</p>

  <div class="assin">
    <div class="linha">${(t.autorNome||'').toUpperCase()}<br>Assinatura e carimbo do Médico${t.medCrm?' — CRM '+t.medCrm:''}</div>
  </div>

  <h3 style="font-size:10pt;margin-top:16px;text-decoration:underline;">Testemunhas</h3>
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

  <div style="margin-top:16px;font-size:9pt;">
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
      ${_solLinhas.length>1?`<button class="presc-del" onclick="_solLinhas.splice(${i},1);_solRender()" title="Remover">🗑</button>`:''}
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
    toast('✓ Solicitação salva. Clique em 🖨 Imprimir para gerar o documento.');
    _solLinhas=[{exame:''}];
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
    const dose=[it.qtd,(it.apres&&it.apres!=='—'?it.apres:''),(it.dose&&it.dose!=='—'?it.dose:'')]
      .filter(Boolean).join(' ')||'—';
    const hors=(it.hor||[]).join(' · ')||'—';
    const bg = it.tipo==='dieta'?'#f0f7f0':it.tipo==='sn'?'#fffde7':it.tipo==='cuidados'?'#f5f5f5':'white';
    return `<tr style="background:${bg};">
      <td style="padding:4px 6px;border:1px solid #ccc;width:24px;color:#888;font-size:8pt;">${i+1}</td>
      <td style="padding:4px 6px;border:1px solid #ccc;font-weight:600;">${(it.farm||'—').toUpperCase()}</td>
      <td style="padding:4px 6px;border:1px solid #ccc;">${dose.toUpperCase()}</td>
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
