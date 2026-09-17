'use strict';
/*
 * poller.js
 * O cérebro do programa. De tempos em tempos pergunta ao UaiPedidos se há pedidos
 * abertos, avisa quando chega um novo (som) e imprime os que estão "em preparo" e
 * ainda não foram impressos. Espelha a lógica do painel:
 *   - fila de um pedido por vez;
 *   - trava anti duplicidade no servidor (marcar_impresso) antes de imprimir;
 *   - as duas vias de um mesmo pedido saem juntas, num papel só.
 * A diferença é que aqui nada depende de navegador aberto.
 */
const api = require('./api');
const render = require('./render');
const printer = require('./printer');
const store = require('./store');

const CACHE_PREFS_MS = 5 * 60 * 1000; // atualiza as preferências da loja a cada 5 min

function criarPoller({ onLog = () => {}, onStatus = () => {}, onNovoPedido = () => {} } = {}) {
  let timer = null;
  let rodando = false;      // um tick por vez
  let primeiraVolta = true; // não avisa/soa pedidos que já existiam ao ligar
  let prefs = null;         // resposta de /api/estab/me (cfg + dados da loja)
  let prefsTs = 0;
  let conectado = false;
  let ultimoErro = '';

  const fila = [];          // pedidos aguardando impressão (det)
  const naFila = new Set(); // ids já enfileirados, para não duplicar
  let ocupado = false;

  function status() {
    return {
      conectado,
      pausado: !!store.getConfig().pausado,
      loja: prefs && (prefs.nome || (prefs.estabelecimento && prefs.estabelecimento.nome)) || '',
      fila: fila.length,
      ultimoErro,
    };
  }
  function emitirStatus() { onStatus(status()); }

  // Garante um token válido. Faz login com email/senha guardados se preciso.
  async function garantirToken() {
    let token = store.getToken();
    if (token) return token;
    const cfg = store.getConfig();
    const senha = store.getSenha();
    if (!cfg.email || !senha) throw new api.ApiError('Configure o e-mail e a senha da loja', 401);
    onLog('info', 'Entrando na conta da loja...');
    token = await api.login(cfg.base, cfg.email, senha);
    store.setToken(token);
    onLog('ok', 'Conectado ao UaiPedidos.');
    return token;
  }

  // Busca (com cache) as preferências e os dados da loja.
  async function pegarPrefs(base, token, forcar) {
    if (!forcar && prefs && (Date.now() - prefsTs) < CACHE_PREFS_MS) return prefs;
    try {
      const j = await api.me(base, token);
      // o endpoint pode devolver a loja direto ou dentro de uma chave
      prefs = j && (j.estabelecimento || j.loja || j) || {};
      prefsTs = Date.now();
    } catch (e) {
      if (!prefs) prefs = {}; // segue com padrões
      onLog('aviso', 'Não consegui ler as preferências da loja agora, usando o último ajuste conhecido.');
    }
    return prefs;
  }

  function escolhaVias() {
    const cfg = store.getConfig();
    if (cfg.vias && cfg.vias !== 'auto') return cfg.vias;
    const v = prefs && (prefs.impressao_vias || (prefs.automacoes && prefs.automacoes.impressao_vias));
    return v || 'cozinha';
  }

  // Coloca um pedido na fila de impressão (sem duplicar).
  function enfileirar(det) {
    const id = Number(det.pedido.id);
    if (naFila.has(id) || store.jaProcessado(id)) return;
    naFila.add(id);
    fila.push(det);
    emitirStatus();
    processarFila();
  }

  // Processa a fila, um pedido por vez.
  async function processarFila() {
    if (ocupado) return;
    if (store.getConfig().pausado) return;
    const det = fila.shift();
    if (!det) return;
    ocupado = true;
    const id = Number(det.pedido.id);
    const numero = det.pedido.numero || id;
    try {
      const cfg = store.getConfig();
      const token = await garantirToken();
      // Trava no servidor: só imprime quem vence a corrida.
      const r = await api.marcarImpresso(cfg.base, token, id);
      if (!r || !r.imprimir) {
        onLog('info', 'Pedido #' + numero + ' já foi impresso em outro ponto, ignorando.');
        store.marcarProcessado(id);
      } else {
        const escolha = escolhaVias();
        const html = render.montarDocumento(det, prefs || {}, prefs || {}, escolha);
        if (!html) { onLog('aviso', 'Pedido #' + numero + ' sem vias para imprimir.'); }
        else {
          onLog('info', 'Imprimindo o pedido #' + numero + '...');
          await imprimirComTentativas(html, cfg.impressora, cfg.copiasCozinha);
          onLog('ok', 'Pedido #' + numero + ' enviado para a impressora.');
        }
        store.marcarProcessado(id);
      }
    } catch (e) {
      ultimoErro = e.message || String(e);
      if (e.status === 401) { store.limparToken(); conectado = false; }
      onLog('erro', 'Falha no pedido #' + numero + ': ' + ultimoErro + ' (se o cupom nao saiu, reimprima pelo painel).');
      // não marca como processado: tenta de novo na próxima volta, a menos que
      // o servidor já tenha carimbado (então marcar_impresso devolverá imprimir=false).
    } finally {
      naFila.delete(id);
      ocupado = false;
      emitirStatus();
      if (fila.length) processarFila();
    }
  }

  async function imprimirComTentativas(html, impressora, copias) {
    let ultima = null;
    for (let i = 0; i < 3; i++) {
      try { await printer.imprimirHtml(html, { deviceName: impressora, copies: copias }); return; }
      catch (e) { ultima = e; await new Promise(r => setTimeout(r, 1500)); }
    }
    throw ultima || new Error('Não foi possível imprimir');
  }

  // Uma volta do laço.
  async function tick() {
    if (rodando) return;
    rodando = true;
    try {
      const cfg = store.getConfig();
      if (cfg.pausado) { conectado = false; ultimoErro = ''; emitirStatus(); return; }
      const token = await garantirToken();
      conectado = true; ultimoErro = '';
      await pegarPrefs(cfg.base, token, false);

      const lista = await api.listaAbertos(cfg.base, token, 2);
      const pedidos = (lista && lista.pedidos) || [];
      const maxId = pedidos.reduce((m, p) => Math.max(m, Number(p.id) || 0), 0);

      // Aviso de pedido novo (som/notificação), sem repetir os que já existiam.
      const estado = store.getEstado();
      if (primeiraVolta) {
        store.setLastSeen(maxId);
        primeiraVolta = false;
      } else {
        const novos = pedidos.filter(p => Number(p.id) > Number(estado.lastSeenId || 0));
        if (novos.length && cfg.som) {
          novos.sort((a, b) => Number(a.id) - Number(b.id));
          onNovoPedido(novos[novos.length - 1], novos.length);
        }
        if (maxId > 0) store.setLastSeen(maxId);
      }

      // Impressão dos pedidos em preparo ainda não impressos.
      for (const p of pedidos) {
        if (p.status !== 'em_preparo') continue;
        const id = Number(p.id);
        if (store.jaProcessado(id) || naFila.has(id)) continue;
        try {
          const d = await api.detalhe(cfg.base, token, id);
          if (!d || !d.pedido) continue;
          if (d.pedido.impresso_em) { store.marcarProcessado(id); continue; }
          enfileirar({ pedido: d.pedido, itens: d.itens || [], pagamentos: d.pagamentos || [] });
        } catch (e) {
          if (e.status === 401) { store.limparToken(); conectado = false; throw e; }
          onLog('aviso', 'Não consegui ler o pedido #' + (p.numero || id) + ' agora, tento de novo.');
        }
      }
      emitirStatus();
    } catch (e) {
      conectado = false;
      ultimoErro = e.message || String(e);
      if (e.status === 401) { store.limparToken(); onLog('erro', 'Sessão expirada. Verifique e-mail e senha nas configurações.'); }
      else onLog('erro', ultimoErro);
      emitirStatus();
    } finally {
      rodando = false;
    }
  }

  function iniciar() {
    parar();
    primeiraVolta = true;
    const seg = Math.max(5, Number(store.getConfig().intervalo) || 12);
    onLog('info', 'Monitorando pedidos a cada ' + seg + ' segundos.');
    tick();
    timer = setInterval(tick, seg * 1000);
  }
  function parar() { if (timer) { clearInterval(timer); timer = null; } }
  function reiniciar() { iniciar(); }

  // Impressão de teste com o pedido de exemplo (não usa a trava do servidor).
  async function imprimirTeste() {
    const cfg = store.getConfig();
    try {
      // tenta atualizar as preferências para o teste sair com a cara da loja
      try { const token = store.getToken(); if (token) await pegarPrefs(cfg.base, token, true); } catch (e) {}
      const escolha = cfg.vias && cfg.vias !== 'auto' ? cfg.vias : 'ambas';
      const html = render.montarDocumento(render.PEDIDO_EXEMPLO, prefs || {}, prefs || {}, escolha);
      onLog('info', 'Imprimindo cupom de teste...');
      await imprimirComTentativas(html, cfg.impressora, cfg.copiasCozinha);
      onLog('ok', 'Cupom de teste enviado. Confira se saiu certo na bobina.');
      return { ok: true };
    } catch (e) {
      onLog('erro', 'Falha no teste: ' + (e.message || e));
      return { ok: false, erro: e.message || String(e) };
    }
  }

  return { iniciar, parar, reiniciar, tick, imprimirTeste, status, get conectado() { return conectado; } };
}

module.exports = { criarPoller };
