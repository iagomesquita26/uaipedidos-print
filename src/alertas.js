'use strict';
/*
 * alertas.js (1.1.0)
 * Aviso de pedido novo na tela do computador e alarme que repete ate alguem aceitar.
 *
 * Quem decide se avisa e a loja, no painel (aba Impressao > Avisos de pedido novo):
 *   aviso  : notificacao do Windows/Mac quando chega pedido (padrao ligado)
 *   alarme : som que repete enquanto o pedido espera aceite (padrao desligado)
 *   som, volume
 * Neste PC, a chave "Avisos de pedido novo neste computador" (cfg.som) desliga tudo.
 *
 * O poller descobre os pedidos (mesma regra do painel) e chama atualizar() a cada
 * volta. Aqui so mostramos a notificacao e cuidamos da janelinha do alarme.
 */
const path = require('path');
const { BrowserWindow, Notification, screen } = require('electron');

const ASSETS = path.join(__dirname, '..', 'assets');
const UI = path.join(__dirname, '..', 'ui');
const REPETIR_MS = 6000; // de quanto em quanto tempo o alarme toca de novo
// Rede de seguranca: sem noticia do servidor por este tempo (internet caiu, por
// exemplo), o alarme para, porque nao da para saber se o pedido ja foi aceito.
const SEM_NOTICIA_MS = 5 * 60 * 1000;

const PADRAO = { aviso: true, alarme: false, som: 'alarme', volume: 80 };
const SONS = ['alarme', 'sirene', 'sino'];

// Normaliza o que veio do servidor (mesmas regras do api/estab/_print_alertas.php).
function normalizar(p) {
  const o = (p && typeof p === 'object') ? p : {};
  const vol = Math.round(Number(o.volume));
  return {
    aviso: o.aviso === undefined ? PADRAO.aviso : !!o.aviso,
    alarme: o.alarme === undefined ? PADRAO.alarme : !!o.alarme,
    som: SONS.includes(o.som) ? o.som : PADRAO.som,
    volume: Number.isFinite(vol) ? Math.max(0, Math.min(100, vol)) : PADRAO.volume,
  };
}

const moeda = v => 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',');
const TIPOS = { entrega: 'Entrega', delivery: 'Entrega', retirada: 'Retirada', balcao: 'Balcão', mesa: 'Mesa', local: 'No local' };
const CANAIS = { uairango: 'UaiRango', ifood: 'iFood', whatsapp: 'WhatsApp', cardapio: 'Cardápio', site: 'Cardápio', robo: 'Robô' };

function criarAlertas({ abrirPedido = () => {}, registrarLog = () => {} } = {}) {
  // Objetos Notification precisam ficar guardados, senao o coletor de lixo some
  // com eles e o clique deixa de funcionar (problema conhecido no Windows).
  const vivas = new Set();
  let cfgAtual = Object.assign({}, PADRAO);
  let tocando = new Map();    // id -> numero, pedidos que fazem o alarme tocar
  const suspensos = new Map(); // tocavam quando o acesso caiu; voltam se ainda esperarem aceite
  const silenciados = new Set(); // ids que alguem ja disse "Vi o pedido"
  let timer = null;
  let janela = null;
  let lembrou = false;        // lembrete "aguardando aceite" so uma vez por execucao
  let ultimaNoticia = Date.now(); // ultima vez que o poller mandou a situacao

  function notificar(titulo, corpo, idPedido, silencioso) {
    try {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title: titulo, body: corpo, icon: path.join(ASSETS, 'icon.png'), silent: !!silencioso });
      vivas.add(n);
      const soltar = () => vivas.delete(n);
      n.on('click', () => { soltar(); if (idPedido) silenciar([idPedido]); abrirPedido(idPedido || 0); });
      n.on('close', soltar);
      n.show();
      // Notificacao esquecida na central nao segura memoria para sempre.
      setTimeout(soltar, 10 * 60 * 1000);
    } catch (e) {}
  }

  function descrever(p) {
    const partes = [];
    const tipo = TIPOS[String(p.tipo || '').toLowerCase()];
    if (tipo) partes.push(tipo);
    if (p.total != null) partes.push(moeda(p.total));
    const canal = CANAIS[String(p.canal || '').toLowerCase()];
    if (canal) partes.push(canal);
    if (p.cliente_nome && partes.length < 3) partes.push(String(p.cliente_nome).slice(0, 40));
    return partes.join(' · ') || 'Abra o painel para ver o pedido.';
  }

  // ---------- janelinha do alarme ----------
  function criarJanela() {
    if (janela && !janela.isDestroyed()) return janela;
    let x, y;
    try {
      const area = screen.getPrimaryDisplay().workArea;
      x = area.x + area.width - 400; y = area.y + area.height - 250;
    } catch (e) {}
    janela = new BrowserWindow({
      width: 380, height: 230, x, y,
      title: 'Pedido novo',
      icon: path.join(ASSETS, 'icon.png'),
      resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
      alwaysOnTop: true, show: false, autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload-alarme.js'),
        contextIsolation: true, nodeIntegration: false,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    // Acima de tudo, inclusive de programa em tela cheia (no Mac, em qualquer mesa).
    try { janela.setAlwaysOnTop(true, 'screen-saver'); } catch (e) {}
    if (process.platform === 'darwin') {
      try { janela.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (e) {}
    }
    janela.loadFile(path.join(UI, 'alarme.html'));
    // Se a pagina do alarme travar, descarta a janela; o proximo toque cria outra.
    janela.webContents.on('render-process-gone', () => {
      const j = janela; janela = null;
      try { if (j && !j.isDestroyed()) { j.removeAllListeners('close'); j.destroy(); } } catch (e) {}
    });
    // Fechar a janelinha conta como "Vi o pedido".
    janela.on('close', () => { janela = null; silenciar(); });
    janela.on('closed', () => { janela = null; });
    janela.once('ready-to-show', () => { try { janela.showInactive(); } catch (e) {} enviarTela(); tocarUmaVez(); });
    return janela;
  }

  function enviarTela() {
    if (!janela || janela.isDestroyed()) return;
    const lista = Array.from(tocando.entries()).map(([id, numero]) => ({ id, numero }));
    try { janela.webContents.send('alarme:pedidos', lista); } catch (e) {}
  }

  function tocarUmaVez() {
    if (!janela || janela.isDestroyed()) return;
    try { janela.webContents.send('alarme:tocar', { som: cfgAtual.som, volume: cfgAtual.volume }); } catch (e) {}
  }

  // chegouNovo: toca na hora (sem esperar a proxima repeticao).
  function iniciarAlarme(chegouNovo) {
    if (!tocando.size) return pararAlarme();
    const nova = !janela || janela.isDestroyed();
    criarJanela(); // janela nova toca sozinha quando fica pronta
    if (!nova) {
      enviarTela();
      try { if (!janela.isVisible()) janela.showInactive(); } catch (e) {}
      if (chegouNovo) tocarUmaVez();
    }
    // Pedido novo tocou agora: a repeticao recomeca a contar daqui (sem som em cima de som).
    if (chegouNovo && timer) { clearInterval(timer); timer = null; }
    if (!timer) timer = setInterval(() => {
      if (!tocando.size) return pararAlarme();
      if (Date.now() - ultimaNoticia > SEM_NOTICIA_MS) { suspender(); return pararAlarme(); }
      if (!janela || janela.isDestroyed()) { criarJanela(); return; }
      tocarUmaVez();
    }, REPETIR_MS);
  }

  function pararAlarme() {
    if (timer) { clearInterval(timer); timer = null; }
    if (janela && !janela.isDestroyed()) {
      const j = janela; janela = null;
      try { j.removeAllListeners('close'); j.destroy(); } catch (e) {}
    }
  }

  // Para o alarme dos pedidos indicados (ou de todos).
  function silenciar(ids) {
    const lista = ids && ids.length ? ids.map(Number) : Array.from(tocando.keys());
    for (const id of lista) { silenciados.add(id); tocando.delete(id); }
    if (silenciados.size > 500) { const a = Array.from(silenciados).slice(-200); silenciados.clear(); a.forEach(i => silenciados.add(i)); }
    if (!tocando.size) pararAlarme(); else enviarTela();
  }

  function suspender() {
    for (const [id, n] of tocando) suspensos.set(id, n);
    tocando.clear();
    if (suspensos.size > 200) suspensos.clear();
  }

  function primeiroTocando() { const it = tocando.keys().next(); return it.done ? 0 : it.value; }

  // ---------- chamado pelo poller a cada volta ----------
  // ev = { cfg, ativo, inicio, novos: [pedido], pendentes: [id] }
  function atualizar(ev) {
    const e = ev || {};
    ultimaNoticia = Date.now();
    cfgAtual = normalizar(e.cfg);
    if (!e.ativo) {
      if (e.suspender) suspender(); else { suspensos.clear(); tocando.clear(); }
      pararAlarme(); return;
    }
    const pendentes = new Set((e.pendentes || []).map(Number));
    let chegouNovo = false;
    // Voltou o acesso: quem tocava e ainda espera aceite volta a tocar.
    if (suspensos.size) {
      if (cfgAtual.alarme) for (const [id, n] of suspensos) if (pendentes.has(id) && !silenciados.has(id) && !tocando.has(id)) { tocando.set(id, n); chegouNovo = true; }
      suspensos.clear();
    }

    // Pedido aceito/recusado em qualquer lugar sai do alarme.
    for (const id of Array.from(tocando.keys())) if (!pendentes.has(id)) tocando.delete(id);

    if (e.inicio && e.relembrar) lembrou = false; // trocou de loja ou voltou de muito tempo parado
    if (e.inicio) {
      // Ao ligar o programa: so um lembrete, sem alarme, dos que ja estavam esperando.
      if (cfgAtual.aviso && pendentes.size && !lembrou) {
        lembrou = true;
        notificar(pendentes.size === 1 ? '1 pedido aguardando aceite' : pendentes.size + ' pedidos aguardando aceite',
          'Abra o painel do UaiPedidos para aceitar.', pendentes.size === 1 ? Array.from(pendentes)[0] : 0, false);
      }
    } else if ((e.novos || []).length) {
      const novos = e.novos;
      const alarmeVai = cfgAtual.alarme && novos.some(p => pendentes.has(Number(p.id)));
      if (cfgAtual.aviso) {
        if (novos.length === 1) {
          const p = novos[0];
          const teste = Number(p.teste) === 1;
          const titulo = (teste ? 'Pedido de teste #' : 'Novo pedido #') + (p.numero || p.id);
          notificar(titulo, descrever(p), Number(p.id), alarmeVai);
        } else {
          notificar(novos.length + ' pedidos novos', 'Abra o painel do UaiPedidos para ver.', 0, alarmeVai);
        }
      }
      if (cfgAtual.alarme) {
        for (const p of novos) {
          const id = Number(p.id);
          if (pendentes.has(id) && !silenciados.has(id) && !tocando.has(id)) { tocando.set(id, p.numero || id); chegouNovo = true; }
        }
      }
      if (alarmeVai) registrarLog('info', 'Alarme de pedido novo tocando.', { tipo: 'alerta' });
    }

    if (!cfgAtual.alarme) tocando.clear();
    if (tocando.size) iniciarAlarme(chegouNovo); else pararAlarme();
  }

  return {
    atualizar,
    silenciar: () => silenciar(),
    abrirPrimeiro: () => { const id = primeiroTocando(); silenciar(); abrirPedido(id); },
    tocandoAgora: () => tocando.size > 0,
    normalizar,
  };
}

module.exports = { criarAlertas, normalizar, PADRAO };
