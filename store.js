'use strict';
/*
 * store.js
 * Guarda as configurações e o estado no computador da loja, na pasta de dados do
 * app (userData). A senha e o token são cifrados com o cofre do sistema
 * operacional (safeStorage) quando disponível, para não ficarem em texto puro.
 */
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const DIR = app.getPath('userData');
const ARQ_CFG = path.join(DIR, 'config.json');
const ARQ_ESTADO = path.join(DIR, 'estado.json');

const CFG_PADRAO = {
  base: 'https://uaipedidos.com.br',
  email: '',
  segredo: '',        // senha cifrada (base64) ou vazio
  token: '',          // token cifrado (base64) ou vazio
  tokenExpira: 0,     // epoch em ms
  impressora: '',     // deviceName escolhido (vazio = padrão do sistema)
  vias: 'auto',       // 'auto' (usa a config da loja) | 'cozinha' | 'motoboy' | 'ambas'
  intervalo: 12,      // segundos entre verificações
  copiasCozinha: 1,   // quantas vias iguais imprimir
  som: true,          // aviso sonoro ao chegar pedido
  autostart: true,    // iniciar junto com o computador
  pausado: false,     // impressão pausada pelo usuário
};

const ESTADO_PADRAO = {
  lastSeenId: 0,      // maior id já visto (para não avisar pedidos antigos)
  processados: [],    // ids que já tentamos imprimir (evita repetir a cada volta)
};

function lerJson(arq, padrao) {
  try {
    if (!fs.existsSync(arq)) return { ...padrao };
    const j = JSON.parse(fs.readFileSync(arq, 'utf8'));
    return { ...padrao, ...j };
  } catch (e) { return { ...padrao }; }
}
function salvarJson(arq, obj) {
  try { fs.writeFileSync(arq, JSON.stringify(obj, null, 2), 'utf8'); } catch (e) {}
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

module.exports = {
  getConfig, setConfig, setSenha, getSenha, setToken, getToken, limparToken,
  getEstado, setLastSeen, jaProcessado, marcarProcessado, pastaDados,
};
