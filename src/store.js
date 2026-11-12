'use strict';
/*
 * store.js
 * Guarda as configurações e o estado no computador da loja, na pasta de dados do
 * app (userData). A senha e o token são cifrados com o cofre do sistema
 * operacional (safeStorage) quando disponível, para não ficarem em texto puro.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, safeStorage } = require('electron');

const DIR = app.getPath('userData');
const ARQ_CFG = path.join(DIR, 'config.json');
const ARQ_ESTADO = path.join(DIR, 'estado.json');
const ARQ_TELE = path.join(DIR, 'telemetria.json'); // fila de eventos p/ o servidor
const ARQ_CMD = path.join(DIR, 'comandos.json');    // controle dos comandos de suporte
const TELE_MAX = 5000; // teto da fila local (se ficar offline muito tempo)

const CFG_PADRAO = {
  base: 'https://uaipedidos.com.br',
  email: '',
  segredo: '',        // senha cifrada (base64) ou vazio
  token: '',          // token cifrado (base64) ou vazio
  tokenExpira: 0,     // epoch em ms
  impressora: '',     // deviceName escolhido (vazio = padrão do sistema)
  vias: 'auto',       // sempre 'auto' desde a 1.1.0: quem decide as vias e o painel da loja
  intervalo: 5,       // segundos entre verificações
  copiasCozinha: 1,   // quantas vias iguais imprimir
  som: true,          // aviso sonoro ao chegar pedido
  autostart: true,    // iniciar junto com o computador
  pausado: false,     // impressão pausada pelo usuário
  recado: '',         // recado do suporte exibido na tela (vazio = sem recado)
};

const ESTADO_PADRAO = {
  lastSeenId: 0,      // maior id já visto (para não avisar pedidos antigos)
  processados: [],    // ids que já tentamos imprimir (evita repetir a cada volta)
  viasLoja: '',       // ultima escolha de vias lida do painel (reserva se o servidor nao responder)
};

function lerUm(arq) {
  if (!fs.existsSync(arq)) return null;
  const j = JSON.parse(fs.readFileSync(arq, 'utf8'));
  return (j && typeof j === 'object' && !Array.isArray(j)) ? j : null;
}
function lerJson(arq, padrao) {
  // Se o arquivo principal existir mas estiver estragado (queda de energia no meio
  // da gravacao), tenta a copia temporaria da ultima gravacao. Se o principal nao
  // existir (suporte apagou para zerar), comeca do padrao e ignora a copia.
  try { const j = lerUm(arq); if (j) return { ...padrao, ...j }; } catch (e) {}
  if (fs.existsSync(arq)) {
    try {
      const j = lerUm(arq + '.tmp');
      if (j) { const r = { ...padrao, ...j }; salvarJson(arq, r); return r; } // conserta o principal
    } catch (e) {}
  }
  return { ...padrao };
}
// Gravacao segura: escreve numa copia temporaria, garante que foi para o disco e
// so depois troca pelo arquivo de verdade. Assim uma queda de energia no meio nao
// deixa o arquivo pela metade (o que antes fazia o programa "esquecer" a loja e o
// identificador do PC).
function salvarJson(arq, obj) {
  const txt = JSON.stringify(obj, null, 2);
  try {
    const fd = fs.openSync(arq + '.tmp', 'w');
    try { fs.writeSync(fd, txt, null, 'utf8'); try { fs.fsyncSync(fd); } catch (e) {} }
    finally { fs.closeSync(fd); }
    fs.renameSync(arq + '.tmp', arq);
  } catch (e) {
    // antivirus segurando o arquivo, por exemplo: grava direto, como antes, e
    // apaga a copia temporaria para ela nao voltar velha numa leitura futura.
    try { fs.writeFileSync(arq, txt, 'utf8'); } catch (e2) {}
    try { fs.unlinkSync(arq + '.tmp'); } catch (e3) {}
  }
}

// ------- cifragem de segredos -------
function cifrar(texto) {
  if (!texto) return '';
  try {
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      return 'enc:' + safeStorage.encryptString(String(texto)).toString('base64');
    }
  } catch (e) {}
  return 'raw:' + Buffer.from(String(texto), 'utf8').toString('base64');
}
function decifrar(valor) {
  if (!valor) return '';
  try {
    if (valor.startsWith('enc:')) {
      return safeStorage.decryptString(Buffer.from(valor.slice(4), 'base64'));
    }
    if (valor.startsWith('raw:')) {
      return Buffer.from(valor.slice(4), 'base64').toString('utf8');
    }
  } catch (e) {}
  return '';
}

// ------- API pública do módulo -------
let _cfg = lerJson(ARQ_CFG, CFG_PADRAO);
let _estado = lerJson(ARQ_ESTADO, ESTADO_PADRAO);
if (!Array.isArray(_estado.processados)) _estado.processados = [];
// 1.1.0: a escolha "O que imprimir" saiu do programa. Quem tinha escolhido uma via
// fixa neste PC passa a seguir o painel da loja (aba Impressao).
if (_cfg.vias !== 'auto') { _cfg.vias = 'auto'; salvarJson(ARQ_CFG, _cfg); }

// Controle remoto (vem na resposta do print_log). So em memoria de proposito: ao
// reiniciar, volta ao normal ate o servidor confirmar de novo o bloqueio/pausa.
let _controle = { bloqueado: false, pausar: false, versao_recomendada: '' };
function setControle(c) {
  if (!c || typeof c !== 'object') return;
  _controle = {
    bloqueado: !!c.bloqueado,
    pausar: !!c.pausar,
    versao_recomendada: String(c.versao_recomendada || ''),
  };
}
function getControle() { return { ..._controle }; }

function getConfig() {
  // devolve uma cópia sem expor os segredos crus
  const c = { ..._cfg };
  c.temSenha = !!_cfg.segredo;
  c.temToken = !!_cfg.token;
  delete c.segredo;
  delete c.token;
  return c;
}
function setConfig(parcial) {
  _cfg = { ..._cfg, ...parcial };
  salvarJson(ARQ_CFG, _cfg);
  return getConfig();
}
function setSenha(senha) { _cfg.segredo = cifrar(senha); salvarJson(ARQ_CFG, _cfg); }
function getSenha() { return decifrar(_cfg.segredo); }
function setToken(token, expiraMs) {
  _cfg.token = cifrar(token);
  _cfg.tokenExpira = expiraMs || (Date.now() + 29 * 24 * 60 * 60 * 1000);
  salvarJson(ARQ_CFG, _cfg);
}
function getToken() {
  if (!_cfg.token) return '';
  if (_cfg.tokenExpira && Date.now() > _cfg.tokenExpira) return '';
  return decifrar(_cfg.token);
}
function limparToken() { _cfg.token = ''; _cfg.tokenExpira = 0; salvarJson(ARQ_CFG, _cfg); }

function getEstado() { return { ..._estado }; }
function setLastSeen(id) {
  if (Number(id) > Number(_estado.lastSeenId || 0)) { _estado.lastSeenId = Number(id); salvarJson(ARQ_ESTADO, _estado); }
}
function jaProcessado(id) { return _estado.processados.includes(Number(id)); }
function marcarProcessado(id) {
  const n = Number(id);
  if (!_estado.processados.includes(n)) {
    _estado.processados.push(n);
    // mantém a lista curta (últimos 800), para o arquivo não crescer sem fim
    if (_estado.processados.length > 800) _estado.processados = _estado.processados.slice(-800);
    salvarJson(ARQ_ESTADO, _estado);
  }
}
function pastaDados() { return DIR; }
function setViasLoja(v) {
  if (!['cozinha', 'motoboy', 'ambas'].includes(v) || _estado.viasLoja === v) return;
  _estado.viasLoja = v;
  salvarJson(ARQ_ESTADO, _estado);
}

// ------- identificador fixo deste computador (para o servidor separar as maquinas) -------
// Alem do config.json (pasta do usuario), o id fica numa pasta comum do computador.
// Se a pasta do usuario for apagada (reinstalacao, outro usuario do Windows), o
// programa reaproveita o mesmo id e o painel nao mostra o PC duplicado.
// Windows: C:\ProgramData\UaiPedidos\agente.json  Mac: /Users/Shared/UaiPedidos/agente.json
function arqAgenteComum() {
  try {
    if (process.platform === 'win32') return path.join(process.env.ProgramData || 'C:\\ProgramData', 'UaiPedidos', 'agente.json');
    if (process.platform === 'darwin') return '/Users/Shared/UaiPedidos/agente.json';
  } catch (e) {}
  return '';
}
const idValido = v => typeof v === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(v);
const nomeMaquina = () => { try { return os.hostname(); } catch (e) { return ''; } };
const nomeUsuario = () => { try { return os.userInfo().username || ''; } catch (e) { return ''; } };
// O arquivo comum e deste computador E deste usuario do Windows/Mac? (dois
// usuarios no mesmo PC rodam dois programas, e cada um precisa do seu id)
const comumEhMeu = c => !!(c && c.maquina && c.maquina === nomeMaquina() && (c.usuario || '') === nomeUsuario());
function lerAgenteComum() {
  try { const a = arqAgenteComum(); const j = a ? lerUm(a) : null; return (j && idValido(j.agente_id)) ? j : null; } catch (e) { return null; }
}
function gravarAgenteComum(id) {
  try {
    const a = arqAgenteComum();
    if (!a) return;
    fs.mkdirSync(path.dirname(a), { recursive: true });
    salvarJson(a, { agente_id: id, maquina: nomeMaquina(), usuario: nomeUsuario(), criado_em: new Date().toISOString() });
  } catch (e) {}
}
let _agenteConferido = false;
function getAgenteId() {
  if (idValido(_cfg.agente_id)) {
    // O id local sempre vale. So escreve na pasta comum se ela ainda nao tiver um
    // (nunca sobrescreve o id de outro usuario do mesmo PC), ou se for o mesmo id
    // e o nome do computador mudou (PC renomeado).
    if (!_agenteConferido) {
      _agenteConferido = true;
      const comum = lerAgenteComum();
      if (!comum || (comum.agente_id === _cfg.agente_id && !comumEhMeu(comum))) gravarAgenteComum(_cfg.agente_id);
    }
    return _cfg.agente_id;
  }
  _agenteConferido = true;
  let id = '';
  const comum = lerAgenteComum();
  // Reaproveita o id da pasta comum so se for deste mesmo computador e usuario (a
  // pasta pode ter vindo copiada de outra maquina, numa imagem do Windows, ou ser
  // de outro usuario do mesmo PC).
  if (comumEhMeu(comum)) id = comum.agente_id;
  if (!id) {
    try { const { randomUUID } = require('crypto'); id = randomUUID(); } catch (e) {}
    if (!id) id = 'ag-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  }
  _cfg.agente_id = id;
  salvarJson(ARQ_CFG, _cfg);
  if (!comum) gravarAgenteComum(id);
  return id;
}

// ------- fila de telemetria (sobrevive a reinicios e a quedas de internet) -------
let _tele = lerJson(ARQ_TELE, { fila: [] });
if (!Array.isArray(_tele.fila)) _tele.fila = [];
function teleAdicionar(ev) {
  _tele.fila.push(ev);
  if (_tele.fila.length > TELE_MAX) _tele.fila = _tele.fila.slice(-TELE_MAX); // descarta os mais antigos
  salvarJson(ARQ_TELE, _tele);
}
function teleLista(qtd) {
  return qtd ? _tele.fila.slice(0, qtd) : _tele.fila.slice();
}
function teleRemover(qtd) {
  _tele.fila = _tele.fila.slice(qtd);
  salvarJson(ARQ_TELE, _tele);
}
function teleTamanho() { return _tele.fila.length; }

// ------- comandos de suporte (vem na resposta do print_log e sao executados aqui) -------
// feitos:     ids ja executados, para nao repetir se o servidor reenviar por engano.
// resultados: respostas prontas esperando o proximo sinal de vida para voltar ao painel.
//             Fica em disco de proposito: se o comando reiniciar/atualizar o programa, o
//             resultado sobrevive ao reinicio e e enviado quando o programa voltar.
let _cmd = lerJson(ARQ_CMD, { feitos: [], resultados: [] });
if (!Array.isArray(_cmd.feitos)) _cmd.feitos = [];
if (!Array.isArray(_cmd.resultados)) _cmd.resultados = [];
function cmdJaFeito(id) { return _cmd.feitos.includes(Number(id)); }
function cmdMarcarFeito(id) {
  const n = Number(id);
  if (!_cmd.feitos.includes(n)) {
    _cmd.feitos.push(n);
    if (_cmd.feitos.length > 500) _cmd.feitos = _cmd.feitos.slice(-500);
    salvarJson(ARQ_CMD, _cmd);
  }
}
function cmdResultAdicionar(res) {
  if (!res || !res.id) return;
  // se ja houver um resultado para esse id, substitui (o ultimo manda)
  _cmd.resultados = _cmd.resultados.filter(r => Number(r.id) !== Number(res.id));
  _cmd.resultados.push({
    id: Number(res.id),
    status: String(res.status || 'concluido'),
    resultado: String(res.resultado || '').slice(0, 500),
  });
  if (_cmd.resultados.length > 200) _cmd.resultados = _cmd.resultados.slice(-200);
  salvarJson(ARQ_CMD, _cmd);
}
function cmdResultLista() { return _cmd.resultados.slice(); }
function cmdResultRemover(ids) {
  if (!Array.isArray(ids) || !ids.length) return;
  const rem = ids.map(Number);
  _cmd.resultados = _cmd.resultados.filter(r => !rem.includes(Number(r.id)));
  salvarJson(ARQ_CMD, _cmd);
}

module.exports = {
  getConfig, setConfig, setSenha, getSenha, setToken, getToken, limparToken,
  getEstado, setLastSeen, jaProcessado, marcarProcessado, pastaDados, setViasLoja,
  getAgenteId, teleAdicionar, teleLista, teleRemover, teleTamanho,
  setControle, getControle,
  cmdJaFeito, cmdMarcarFeito, cmdResultAdicionar, cmdResultLista, cmdResultRemover,
};
