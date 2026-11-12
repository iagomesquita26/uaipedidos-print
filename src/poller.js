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
 *
 * Controle remoto (store.getControle()): se "bloqueado", para tudo e se comporta
 * como desconectado (o navegador volta a assumir). Se "pausar", comporta como se
 * o lojista tivesse pausado no proprio PC.
 */
const api = require('./api');
const render = require('./render');
const printer = require('./printer');
const store = require('./store');
const alertas = require('./alertas');

// Atualiza as preferências da loja a cada 1 min. Desde a 1.1.0 as vias vem so do
// painel, entao uma troca la precisa chegar rapido aqui.
const CACHE_PREFS_MS = 60 * 1000;

function criarPoller({ onLog = () => {}, onStatus = () => {}, onAlertas = () => {} } = {}) {
  let timer = null;
  let rodando = false;      // um tick por vez
  let primeiraVolta = true; // não avisa/soa pedidos que já existiam ao ligar
  let prefs = null;         // resposta de /api/estab/me (cfg + dados da loja)
  let prefsTs = 0;
  let conectado = false;
  let ultimoErro = '';

  // Avisos de pedido novo (1.1.0). Mesma regra do painel (pedidos-motor.js):
  // pedido novo = id acima do ultimo visto, menos os recebidos com a loja fechada,
  // os agendados (esses avisam quando a hora chega, pelo "despertar") e os lancados
  // pela propria loja no painel. O alarme vale enquanto o pedido espera aceite.
  let alertaUltimoId = -1;          // -1 = ainda nao leu (primeira volta so memoriza)
  const despertados = new Set();    // agendados que ja avisaram
  let alertaLoja = null;            // base|email da loja dos avisos (trocou = recomeca)
  let alertaRelembrar = false;      // proxima "primeira volta" repete o lembrete de pendentes
  let alertaParadoDesde = 0;        // avisos parados por falta de acesso desde (epoch ms)
  let geracao = 0;                  // muda no logout: volta em andamento nao avisa depois dele
  const PARADO_RECOMECA_MS = 10 * 60 * 1000; // parado mais que isso: recomeca so memorizando

  // Espera crescente quando o login falha (senha trocada/expirada). Em vez de
  // martelar o servidor a cada 5s de forma muda, espera 15s, 30s, 60s... ate 5 min,
  // e avisa uma vez de forma clara que a senha mudou e e preciso entrar de novo.
  let backoffAuth = 0;      // nivel atual da espera (0 = sem espera)
  let proximaAuthTs = 0;    // so tenta logar de novo depois deste instante (epoch ms)
  let avisouSenha = false;  // ja avisou "senha mudou" nesta sequencia de falhas

  const fila = [];          // pedidos aguardando impressão (det)
  const naFila = new Set(); // ids já enfileirados, para não duplicar
  let ocupado = false;

  // Esvazia a fila local. Usado ao pausar/bloquear: assim "desconectado" significa
  // de verdade que nao estamos segurando nenhum pedido. Na proxima volta sem bloqueio,
  // o tick reescaneia os pedidos em preparo ainda nao impressos e reenfileira.
  function limparFila() { fila.length = 0; naFila.clear(); }

  // Se o cupom cair no modo de reserva, aparece no log (e chega ao suporte).
  try { render.definirAvisoFalha(msg => onLog('aviso', msg, { tipo: 'impressao' })); } catch (e) {}

  // Preferencias de impressao resolvidas da loja (largura, fonte, margens).
  function prefsImpressao() {
    try { return render.normalizarCfg(prefs || {}); } catch (e) { return null; }
  }

  function status() {
    const ctrl = store.getControle();
    return {
      // sob bloqueio, reportamos desconectado para o navegador voltar a assumir
      conectado: ctrl.bloqueado ? false : conectado,
      pausado: !!store.getConfig().pausado,
      bloqueado: !!ctrl.bloqueado,
      pausadoRemoto: !!ctrl.pausar,
      // true enquanto o login esta falhando (senha trocada/expirada): a janela mostra
      // um aviso fixo ate o lojista entrar de novo.
      precisaLogin: !!avisouSenha,
      versaoRecomendada: ctrl.versao_recomendada || '',
      loja: prefs && (prefs.nome || (prefs.estabelecimento && prefs.estabelecimento.nome)) || '',
      viasLoja: escolhaVias(),
      fila: fila.length,
      ultimoErro,
    };
  }
  function emitirStatus() { onStatus(status()); }

  // Senha trocada ou acesso expirado: limpa o token e espera cada vez mais antes de
  // tentar de novo (15s, 30s, 60s, 120s... ate 5 min). Avisa uma vez.
  function falhaDeLogin() {
    store.limparToken();
    backoffAuth = Math.min(backoffAuth + 1, 5);
    const esperaMs = Math.min(15000 * Math.pow(2, backoffAuth - 1), 5 * 60 * 1000);
    proximaAuthTs = Date.now() + esperaMs;
    if (!avisouSenha) {
      avisouSenha = true;
      onLog('erro', 'Sua senha mudou ou o acesso expirou. Abra as configurações e entre de novo com e-mail e senha. (nova tentativa em ' + Math.round(esperaMs / 1000) + 's)', { tipo: 'conexao', nivel: 'erro' });
    }
  }
  function loginOk() { backoffAuth = 0; proximaAuthTs = 0; avisouSenha = false; }

  // Sem acesso a loja (bloqueio, senha, logout): o alarme para, porque nao da mais
  // para saber se o pedido foi aceito. Parado por muito tempo, recomeca do zero.
  function avisosParados() {
    if (!alertaParadoDesde) alertaParadoDesde = Date.now();
    avisar({ ativo: false, suspender: true }); // o alarme volta se o pedido ainda esperar
  }

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
    try { render.definirBase(base); } catch (e) {}
    try {
      const j = await api.me(base, token);
      // o endpoint pode devolver a loja direto ou dentro de uma chave
      prefs = j && (j.estabelecimento || j.loja || j) || {};
      prefsTs = Date.now();
      try { store.setViasLoja(prefs.impressao_vias); } catch (e) {}
    } catch (e) {
      if (!prefs) prefs = {}; // segue com padrões
      onLog('aviso', 'Não consegui ler as preferências da loja agora, usando o último ajuste conhecido.');
    }
    return prefs;
  }

  // Quais vias imprimir: desde a 1.1.0 so o painel decide (aba Impressao), igual a
  // impressao pelo navegador. Se o servidor nao respondeu ainda, usa a ultima
  // escolha conhecida da loja, guardada no disco.
  function escolhaVias() {
    const ok = v => (v === 'cozinha' || v === 'motoboy' || v === 'ambas') ? v : '';
    const v = prefs && ok(prefs.impressao_vias || (prefs.automacoes && prefs.automacoes.impressao_vias));
    if (v) return v;
    try { const g = ok(store.getEstado().viasLoja); if (g) return g; } catch (e) {}
    return 'cozinha';
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
    const ctrl = store.getControle();
    // Bloqueio/pausa (do usuario ou remota): nao imprime e nao "assume" o pedido
    // (nao chama marcar_impresso), deixando o navegador cuidar. Esvazia a fila para
    // nao deixar pedidos presos aqui enquanto o navegador reassume.
    if (store.getConfig().pausado || ctrl.pausar || ctrl.bloqueado) { limparFila(); return; }
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
          onLog('info', 'Imprimindo o pedido #' + numero + '...', { tipo: 'impressao', pedido: numero, impressora: cfg.impressora });
          await imprimirComTentativas(html, cfg.impressora, cfg.copiasCozinha, render.normalizarCfg(prefs || {}).largura);
          onLog('ok', 'Pedido #' + numero + ' enviado para a impressora.', { tipo: 'impressao', pedido: numero, impressora: cfg.impressora });
        }
        store.marcarProcessado(id);
      }
    } catch (e) {
      ultimoErro = e.message || String(e);
      if (e.status === 401) { store.limparToken(); conectado = false; }
      onLog('erro', 'Falha no pedido #' + numero + ': ' + ultimoErro + ' (se o cupom nao saiu, reimprima pelo painel).', { tipo: 'impressao', nivel: 'erro', pedido: numero, dados: { erro: ultimoErro } });
      // não marca como processado: tenta de novo na próxima volta, a menos que
      // o servidor já tenha carimbado (então marcar_impresso devolverá imprimir=false).
    } finally {
      naFila.delete(id);
      ocupado = false;
      emitirStatus();
      if (fila.length) processarFila();
    }
  }

  async function imprimirComTentativas(html, impressora, copias, larguraMm) {
    let ultima = null;
    for (let i = 0; i < 3; i++) {
      try { await printer.imprimirHtml(html, { deviceName: impressora, copies: copias, larguraMm: larguraMm, onLog: onLog }); return; }
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
      const ctrl = store.getControle();
      // Bloqueio remoto, pausa do usuario ou pausa remota: nao busca nem imprime
      // pedidos. Reporta desconectado para o navegador voltar a assumir.
      if (cfg.pausado || ctrl.pausar || ctrl.bloqueado) {
        conectado = false; ultimoErro = ''; limparFila();
        // Impressao pausada nao cala o aviso de pedido novo (a loja ainda precisa
        // aceitar). So o bloqueio do suporte desliga tudo neste PC.
        if (ctrl.bloqueado || (proximaAuthTs && Date.now() < proximaAuthTs)) avisosParados();
        else {
          try {
            const token = await garantirToken();
            await pegarPrefs(cfg.base, token, false);
            const l = await api.listaAbertos(cfg.base, token, 2);
            loginOk();
            await verificarAlertas(cfg, token, (l && l.pedidos) || []);
          } catch (e) {
            if (e && e.status === 401) { falhaDeLogin(); avisosParados(); }
            else if (!alertaParadoDesde) alertaParadoDesde = Date.now(); // sem internet: so marca
          }
        }
        emitirStatus(); return;
      }
      // Espera crescente apos falha de login: nao tenta de novo antes da hora.
      if (proximaAuthTs && Date.now() < proximaAuthTs) { conectado = false; avisosParados(); emitirStatus(); return; }
      const token = await garantirToken();
      await pegarPrefs(cfg.base, token, false);

      const lista = await api.listaAbertos(cfg.base, token, 2);
      conectado = true; ultimoErro = '';
      loginOk(); // login e lista ok: zera a espera
      const pedidos = (lista && lista.pedidos) || [];
      const maxId = pedidos.reduce((m, p) => Math.max(m, Number(p.id) || 0), 0);

      if (maxId > 0) store.setLastSeen(maxId);
      primeiraVolta = false;

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
      // Avisos depois da impressao, para nunca atrasar o cupom. Erro aqui nao
      // derruba a volta.
      try { await verificarAlertas(cfg, token, pedidos); } catch (e) {
        if (e && e.status === 401) throw e;
      }
      emitirStatus();
    } catch (e) {
      conectado = false;
      ultimoErro = e.message || String(e);
      if (e.status === 401) { falhaDeLogin(); avisosParados(); }
      // Sem internet: o alarme segue (para sozinho em 5 min sem noticia), so marca o
      // inicio para, se demorar, recomecar memorizando em vez de despejar tudo.
      else if (!alertaParadoDesde) alertaParadoDesde = Date.now();
      else onLog('erro', ultimoErro);
      emitirStatus();
    } finally {
      rodando = false;
    }
  }

  // Escolha da loja (aba Impressao do painel). O sinal de vida traz a mais nova
  // (controle.alertas, a cada ~30s); as preferencias da loja servem de reserva.
  function configAlertas() {
    const c = store.getControle();
    if (c && c.alertas) return c.alertas;
    return (prefs && prefs.print_alertas) || null;
  }

  function avisar(ev) { try { onAlertas(Object.assign({ cfg: configAlertas() }, ev)); } catch (e) {} }

  async function verificarAlertas(cfg, token, pedidos) {
    const g = geracao;
    const al = alertas.normalizar(configAlertas());
    // cfg.som: chave "Avisos de pedido novo neste computador" (tela do programa).
    if (cfg.som === false || (!al.aviso && !al.alarme)) { alertaUltimoId = -1; avisar({ ativo: false }); return; }
    const pg = await api.ping(cfg.base, token);
    if (g !== geracao) return; // desconectou enquanto esperava
    const pendentes = ((pg && pg.pendentes) || []).map(Number).filter(Boolean);
    const despertar = ((pg && pg.despertar) || []).map(Number).filter(Boolean);
    const maxServ = Number(pg && pg.max_id) || 0;
    // Ficou muito tempo sem acesso: nao despeja tudo o que chegou nesse meio tempo,
    // recomeca memorizando e repete o lembrete dos que esperam aceite.
    if (alertaParadoDesde && Date.now() - alertaParadoDesde > PARADO_RECOMECA_MS) { alertaUltimoId = -1; alertaRelembrar = true; }
    alertaParadoDesde = 0;
    if (alertaUltimoId < 0) {
      alertaUltimoId = maxServ;
      despertar.forEach(id => despertados.add(id));
      avisar({ ativo: true, inicio: true, relembrar: alertaRelembrar, pendentes });
      alertaRelembrar = false;
      return;
    }
    const novos = pedidos.filter(p => {
      const id = Number(p.id);
      return id > alertaUltimoId && Number(p.recebido_fechado) !== 1 && !p.agendado_para && p.canal !== 'painel';
    });
    // Agendados cuja hora chegou: avisam uma vez (podem ser antigos, fora da lista).
    for (const id of despertar) {
      if (despertados.has(id)) continue;
      despertados.add(id);
      let p = pedidos.find(x => Number(x.id) === id);
      if (!p) { try { const d = await api.detalhe(cfg.base, token, id); p = d && d.pedido; } catch (e) { p = null; } }
      // Igual ao painel: so avisa o agendado que ainda espera aceite.
      if (p && p.status && p.status !== 'criado') continue;
      novos.push(p || { id, numero: id });
    }
    if (despertados.size > 500) { const a = Array.from(despertados).slice(-200); despertados.clear(); a.forEach(i => despertados.add(i)); }
    // Avanca pelo maior id da propria lista (lida ANTES do ping): pedido que entrou
    // entre a lista e o ping fica para a proxima volta, em vez de sumir.
    const maxLista = pedidos.reduce((m, p) => Math.max(m, Number(p.id) || 0), 0);
    alertaUltimoId = Math.max(alertaUltimoId, maxLista);
    if (g !== geracao) return;
    novos.sort((a, b) => Number(a.id) - Number(b.id));
    avisar({ ativo: true, novos, pendentes });
  }

  function iniciar() {
    parar();
    primeiraVolta = true;
    prefsTs = 0; // reconexao/config nova: busca as preferencias da loja de novo
    // Avisos so recomecam do zero se mudou a loja. Retomar ou salvar a configuracao
    // nao pode engolir o pedido que acabou de chegar.
    const c0 = store.getConfig();
    const loja = String(c0.base || '') + '|' + String(c0.email || '').toLowerCase();
    if (loja !== alertaLoja) {
      if (alertaLoja !== null) { prefs = null; alertaRelembrar = true; }
      alertaLoja = loja; alertaUltimoId = -1; alertaParadoDesde = 0;
    }
    backoffAuth = 0; proximaAuthTs = 0; avisouSenha = false; // reconexao manual: tenta ja
    const seg = Math.max(5, Number(store.getConfig().intervalo) || 12);
    onLog('info', 'Monitorando pedidos a cada ' + seg + ' segundos.');
    tick();
    timer = setInterval(tick, seg * 1000);
  }
  function parar() { if (timer) { clearInterval(timer); timer = null; } }
  // Logout: para tudo, cala o alarme e esquece a loja (o selo do painel nao mostra
  // mais a loja antiga).
  function desligar() {
    parar();
    geracao++;
    avisar({ ativo: false });
    prefs = null; prefsTs = 0;
    alertaLoja = null; alertaUltimoId = -1; alertaParadoDesde = 0; alertaRelembrar = true;
  }
  function reiniciar() { iniciar(); }

  // Impressão de teste com o pedido de exemplo (não usa a trava do servidor).
  async function imprimirTeste() {
    const cfg = store.getConfig();
    try {
      // tenta atualizar as preferências para o teste sair com a cara da loja
      try { const token = store.getToken(); if (token) await pegarPrefs(cfg.base, token, true); } catch (e) {}
      // O teste sempre mostra as duas vias, para a loja conferir o papel inteiro.
      const escolha = 'ambas';
      const html = render.montarDocumento(render.PEDIDO_EXEMPLO, prefs || {}, prefs || {}, escolha);
      onLog('info', 'Imprimindo cupom de teste...', { tipo: 'teste', impressora: cfg.impressora });
      await imprimirComTentativas(html, cfg.impressora, cfg.copiasCozinha, render.normalizarCfg(prefs || {}).largura);
      onLog('ok', 'Cupom de teste enviado. Confira se saiu certo na bobina.', { tipo: 'teste', impressora: cfg.impressora });
      return { ok: true };
    } catch (e) {
      onLog('erro', 'Falha no teste: ' + (e.message || e), { tipo: 'teste', nivel: 'erro', dados: { erro: e.message || String(e) } });
      return { ok: false, erro: e.message || String(e) };
    }
  }

  // Reimpressao a pedido do suporte (painel/admin). Ao contrario da fila normal,
  // NAO usa a trava do servidor (marcar_impresso): e uma segunda via proposital,
  // mesmo que o pedido ja tenha sido impresso antes. Aceita { pedido_id } ou
  // { pedido_numero }. Devolve { ok } ou { ok:false, erro }.
  // Imprime uma segunda via de um pedido ja conhecido (por id). Nao usa a trava do
  // servidor. Usado tanto pela reimpressao de um pedido quanto pela de varios.
  async function reimprimirUmId(cfg, token, id) {
    const d = await api.detalhe(cfg.base, token, id);
    if (!d || !d.pedido) return { ok: false, erro: 'pedido nao encontrado' };
    const det = { pedido: d.pedido, itens: d.itens || [], pagamentos: d.pagamentos || [] };
    const numero = d.pedido.numero || id;
    const escolha = escolhaVias();
    const html = render.montarDocumento(det, prefs || {}, prefs || {}, escolha);
    if (!html) return { ok: false, erro: 'pedido sem vias para imprimir', numero };
    onLog('info', 'Reimprimindo o pedido #' + numero + ' (pedido do suporte)...', { tipo: 'impressao', pedido: numero, impressora: cfg.impressora });
    await imprimirComTentativas(html, cfg.impressora, cfg.copiasCozinha, render.normalizarCfg(prefs || {}).largura);
    onLog('ok', 'Pedido #' + numero + ' reimpresso (segunda via do suporte).', { tipo: 'impressao', pedido: numero, impressora: cfg.impressora });
    return { ok: true, numero: numero };
  }

  async function reimprimir(sel) {
    const cfg = store.getConfig();
    try {
      const token = await garantirToken();
      try { await pegarPrefs(cfg.base, token, false); } catch (e) {}
      let id = Number(sel && sel.pedido_id) || 0;
      const numeroBusca = sel && (sel.pedido_numero != null ? String(sel.pedido_numero) : '');
      if (!id && numeroBusca) {
        const lista = await api.listaAbertos(cfg.base, token, 7);
        const ped = ((lista && lista.pedidos) || []).find(p => String(p.numero) === numeroBusca);
        if (ped) id = Number(ped.id);
      }
      if (!id) return { ok: false, erro: 'pedido nao encontrado' };
      return await reimprimirUmId(cfg, token, id);
    } catch (e) {
      const erro = e.message || String(e);
      if (e.status === 401) store.limparToken();
      onLog('erro', 'Falha ao reimprimir: ' + erro, { tipo: 'impressao', nivel: 'erro', dados: { erro: erro } });
      return { ok: false, erro: erro };
    }
  }

  // Reimpressao em lote a pedido do suporte: os N pedidos EM ABERTO mais recentes
  // (o endpoint so lista pedidos abertos), do mais novo para o mais antigo. Pedido ja
  // finalizado nao entra. Devolve a lista de numeros feitos e os que deram erro.
  async function reimprimirUltimos(n) {
    const cfg = store.getConfig();
    const quantos = Math.max(1, Math.min(20, Number(n) || 1));
    try {
      const token = await garantirToken();
      try { await pegarPrefs(cfg.base, token, false); } catch (e) {}
      const lista = await api.listaAbertos(cfg.base, token, 7);
      const pedidos = ((lista && lista.pedidos) || [])
        .slice()
        .sort((a, b) => Number(b.id) - Number(a.id))
        .slice(0, quantos);
      if (!pedidos.length) return { ok: false, erro: 'nenhum pedido em aberto para reimprimir' };
      const feitos = [], erros = [];
      for (const p of pedidos) {
        try {
          const r = await reimprimirUmId(cfg, token, Number(p.id));
          if (r && r.ok) feitos.push(r.numero); else erros.push(p.numero || p.id);
        } catch (e) {
          if (e.status === 401) { store.limparToken(); throw e; }
          erros.push(p.numero || p.id);
        }
      }
      return { ok: true, feitos, erros };
    } catch (e) {
      const erro = e.message || String(e);
      if (e.status === 401) store.limparToken();
      onLog('erro', 'Falha ao reimprimir em lote: ' + erro, { tipo: 'impressao', nivel: 'erro', dados: { erro: erro } });
      return { ok: false, erro: erro };
    }
  }

  // Limpa a fila local a pedido do suporte, e deixa claro no diario de bordo.
  function limparFilaPublica() {
    limparFila();
    onLog('info', 'Fila de impressao limpa pelo suporte.', { tipo: 'impressao' });
    emitirStatus();
  }

  return { iniciar, parar, desligar, reiniciar, tick, imprimirTeste, reimprimir, reimprimirUltimos, limparFila: limparFilaPublica, status, prefsImpressao,
    estabId: () => (prefs && Number(prefs.id)) || 0, get conectado() { return conectado; } };
}

module.exports = { criarPoller };
