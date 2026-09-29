'use strict';
/*
 * telemetria.js
 * Manda para o UaiPedidos o "diario de bordo" deste computador: o estado atual
 * (impressora, versao, ligado/desligado, ultimo erro) e o historico de eventos
 * (impressoes, testes, erros, login, mudancas de config).
 *
 * Resiliente: os eventos ficam guardados no disco (store) e so saem da fila
 * quando o servidor confirma o recebimento. Se o PC estiver sem internet, nada
 * se perde: envia quando a conexao voltar. Tambem manda um "sinal de vida" a
 * cada poucos minutos, mesmo sem eventos, para sabermos que a loja esta online.
 */
const os = require('os');
const api = require('./api');
const store = require('./store');

const FLUSH_MS = 30 * 1000;        // tenta enviar a cada 30s
const HEARTBEAT_MS = 2 * 60 * 1000; // sinal de vida no maximo a cada 2 min
const LOTE_MAX = 200;               // eventos por envio

let timer = null;
let enviando = false;
let ultimoHeartbeat = 0;
let getEstado = () => ({});
let versao = '';
const SO = process.platform + ' ' + os.release();
const MAQUINA = (() => { try { return os.hostname(); } catch (e) { return ''; } })();

function iniciar(opcoes = {}) {
  versao = opcoes.versao || '';
  if (typeof opcoes.getEstado === 'function') getEstado = opcoes.getEstado;
  parar();
  timer = setInterval(flush, FLUSH_MS);
}
function parar() { if (timer) { clearInterval(timer); timer = null; } }

// Registra um evento na fila local. tipo: log|inicio|parada|login|conexao|config|impressao|teste|erro
function registrar(nivel, msg, extra = {}) {
  try {
    store.teleAdicionar({
      ts: Date.now(),
      tipo: extra.tipo || 'log',
      nivel: nivel || 'info',
      msg: String(msg || '').slice(0, 500),
      pedido: extra.pedido != null ? String(extra.pedido) : undefined,
      impressora: extra.impressora,
      dados: extra.dados,
    });
  } catch (e) {}
}

async function flush(forcar) {
  if (enviando) return;
  const cfg = store.getConfig();
  const token = store.getToken();
  if (!token) return; // sem login ainda: guarda e espera
  const temEventos = store.teleTamanho() > 0;
  const naHora = (Date.now() - ultimoHeartbeat) >= HEARTBEAT_MS;
  if (!temEventos && !naHora && !forcar) return;

  enviando = true;
  try {
    const lote = store.teleLista(LOTE_MAX);
    let estado = {};
    try { estado = getEstado() || {}; } catch (e) {}
    const payload = {
      agente_id: store.getAgenteId(),
      versao,
      so: SO,
      maquina: MAQUINA,
      estado,
      eventos: lote,
    };
    await api.enviarLog(cfg.base, token, payload);
    // deu certo: tira da fila o que foi enviado e registra o heartbeat
    if (lote.length) store.teleRemover(lote.length);
    ultimoHeartbeat = Date.now();
    // se ainda sobrou fila grande, tenta esvaziar em seguida
    if (store.teleTamanho() > 0) setTimeout(() => flush(true), 1000);
  } catch (e) {
    // sem conexao ou erro: mantem a fila para a proxima tentativa
  } finally {
    enviando = false;
  }
}

module.exports = { iniciar, parar, registrar, flush };
