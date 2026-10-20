'use strict';
/*
 * main.js
 * Processo principal do UaiPedidos Print. Cuida do ícone na bandeja, da janela de
 * configuração, dos avisos de pedido novo e liga tudo ao cérebro (poller.js).
 * O programa fica rodando em segundo plano; fechar a janela não encerra o app,
 * só some para a bandeja. Encerra de verdade pelo menu "Sair".
 *
 * Controle remoto (1.0.7): a resposta da telemetria traz "controle" (bloqueado,
 * pausar, versao_recomendada). O store guarda e o main reflete no ícone/janela e,
 * quando ha versao nova, avisa uma vez com um clique que leva a pagina de instalacao.
 *
 * Canal de comandos (1.0.8): o mesmo "controle" pode trazer "comandos" (reimprimir,
 * limpar fila, testar, aplicar config, coletar diagnostico, reiniciar, atualizar).
 * O modulo comandos executa cada um e a telemetria devolve o resultado no proximo
 * sinal de vida. A atualizacao nunca roda sozinha: so pelo botao do lojista ou por
 * um comando explicito do suporte.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, nativeImage, shell, screen } = require('electron');

let tray = null;
let win = null;
let poller = null;
let store = null;
let printer = null;
let telemetria = null;
let comandos = null;
const logs = [];           // histórico curto de mensagens
const MAX_LOGS = 250;

const ASSETS = path.join(__dirname, '..', 'assets');
const UI = path.join(__dirname, '..', 'ui');

// Pagina com o passo a passo para baixar e instalar a versao nova.
const URL_INSTALACAO = 'https://uaipedidos.com.br/uaipedidos-print-como-instalar';
let ultimaVersaoAvisada = ''; // evita repetir a notificacao da mesma versao

// Uma instância só (abrir de novo apenas mostra a janela).
if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => mostrarJanela());

function registrarLog(nivel, msg, extra) {
  const item = { nivel, msg, ts: Date.now() };
  logs.push(item);
  if (logs.length > MAX_LOGS) logs.shift();
  if (win && !win.isDestroyed()) win.webContents.send('log', item);
  // Espelha no diario de bordo enviado ao servidor (suporte remoto).
  try { if (telemetria) telemetria.registrar(nivel, msg, extra || {}); } catch (e) {}
}

// Compara versoes "a.b.c": retorna true se 'a' for maior que 'b'.
function versaoMaior(a, b) {
  const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

// Enriquece o status do poller com a versao instalada e se ha atualizacao, para a
// janela e o ícone mostrarem o aviso de versao nova.
function statusCompleto(st) {
  const s = st || (poller && poller.status()) || {};
  const versaoAtual = app.getVersion();
  const atualizar = !!(s.versaoRecomendada && versaoMaior(s.versaoRecomendada, versaoAtual));
  const recado = (() => { try { return store.getConfig().recado || ''; } catch (e) { return ''; } })();
  return Object.assign({}, s, { versaoAtual, atualizar, recado });
}

// Estado atual resumido, enviado como "sinal de vida" a cada poucos minutos.
function estadoAtual() {
  const cfg = store.getConfig();
  const s = (poller && poller.status()) || {};
  const ctrl = store.getControle();
  return {
    impressora: cfg.impressora,
    vias: cfg.vias,
    intervalo: cfg.intervalo,
    copias: cfg.copiasCozinha,
    // "pausado" reflete a pausa local do lojista OU a pausa/bloqueio remoto
    pausado: !!cfg.pausado || !!ctrl.pausar || !!ctrl.bloqueado,
    conectado: ctrl.bloqueado ? false : !!s.conectado,
    bloqueado: !!ctrl.bloqueado,
    pausa_remota: !!ctrl.pausar,
    loja: s.loja || '',
    ultimo_erro: s.ultimoErro || '',
    ambiente: ambienteCache, // fotografia completa do PC (Windows, impressoras, drivers)
  };
}

// Coleta TUDO que pode afetar a impressao: versao do Windows, arquitetura, versoes
// internas, idioma/fuso, impressora escolhida, impressora PADRAO do sistema e a
// lista completa de impressoras instaladas com o driver de cada uma.
let ambienteCache = null;
let ambienteImpressao = ''; // "impressao digital" do ambiente, p/ so registrar quando mudar
async function coletarAmbiente(motivo) {
  let impressoras = [];
  try { impressoras = await printer.listarImpressorasDetalhado(); } catch (e) {}
  const padrao = (impressoras.find(p => p.padrao) || {}).nome || '';
  const cfg = store.getConfig();
  const escolhida = impressoras.find(p => p.nome === cfg.impressora) || null;
  const amb = {
    so_nome: (() => { try { return os.version(); } catch (e) { return ''; } })(),
    so_build: process.platform + ' ' + os.release(),
    arch: os.arch(),
    memoria_gb: Math.round((os.totalmem() / (1024 * 1024 * 1024)) * 10) / 10,
    versoes: {
      app: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    },
    locale: (() => { try { return app.getLocale(); } catch (e) { return ''; } })(),
    fuso: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return ''; } })(),
    cpus: (() => { try { return os.cpus().length; } catch (e) { return 0; } })(),
    escala_tela: (() => { try { return screen.getPrimaryDisplay().scaleFactor; } catch (e) { return null; } })(),
    autostart: !!cfg.autostart,
    base: cfg.base || '',
    impressora_escolhida: cfg.impressora || '',
    impressora_escolhida_driver: escolhida ? escolhida.driver : '',
    impressora_escolhida_existe: !!escolhida,
    impressora_escolhida_detalhe: escolhida, // objeto completo (status, midia, resolucao, opcoes)
    impressora_padrao: padrao,
    qtd_impressoras: impressoras.length,
    impressoras: impressoras,
    // Preferencias de impressao da loja (largura do papel, fonte, margens): afetam
    // o cupom gerado e ajudam a explicar problemas de corte/tamanho.
    prefs_impressao: (() => { try { return poller && poller.prefsImpressao ? poller.prefsImpressao() : null; } catch (e) { return null; } })(),
  };
  ambienteCache = amb;

  // So registra um evento no historico quando algo relevante muda (evita repetir).
  const digital = JSON.stringify([
    amb.so_build, amb.versoes.app, amb.impressora_escolhida, amb.impressora_padrao,
    impressoras.map(p => p.nome + '|' + p.driver + '|' + (p.padrao ? '1' : '0')),
  ]);
  if (digital !== ambienteImpressao) {
    ambienteImpressao = digital;
    registrarLog('info', 'Ambiente do computador registrado' + (motivo ? ' (' + motivo + ')' : '') + '.', {
      tipo: 'ambiente', dados: amb,
    });
  }
  return amb;
}

function enviarStatus(st) {
  const completo = statusCompleto(st);
  if (win && !win.isDestroyed()) win.webContents.send('status', completo);
  atualizarTray(completo);
}

function abrirPaginaInstalacao() {
  try { shell.openExternal(URL_INSTALACAO); } catch (e) {}
}

// Atualizacao a pedido do lojista (botao) ou do suporte (comando 'atualizar').
// Nunca roda sozinha. No Windows, baixa o instalador novo e abre: o instalador
// fecha o programa, troca os arquivos e reabre. No Mac, o pacote precisa ser
// assinado pela Apple para atualizar sozinho, entao so abrimos a pagina com o
// passo a passo (o lojista baixa e instala a mao).
let atualizando = false;
async function atualizarAgora(origem) {
  if (atualizando) return { ok: false, erro: 'ja em andamento' };
  atualizando = true;
  try {
    const cfg = store.getConfig();
    const base = String(cfg.base || 'https://uaipedidos.com.br').replace(/\/+$/, '');
    if (process.platform === 'win32') {
      const url = base + '/downloads/UaiPedidos-Print-win.exe';
      const destino = path.join(app.getPath('temp'), 'UaiPedidos-Print-setup.exe');
      registrarLog('info', 'Baixando a nova versao do UaiPedidos Print...', { tipo: 'config' });
      const resp = await fetch(url, { redirect: 'follow' });
      if (!resp || !resp.ok) throw new Error('download falhou (' + (resp && resp.status) + ')');
      const buf = Buffer.from(await resp.arrayBuffer());
      if (!buf.length) throw new Error('instalador vazio');
      fs.writeFileSync(destino, buf);
      registrarLog('ok', 'Instalador baixado. Abrindo para atualizar.', { tipo: 'config' });
      await shell.openPath(destino);
      return { ok: true, msg: 'Instalador aberto no computador' };
    }
    if (process.platform === 'darwin') {
      // Mac: baixa o .dmg e abre. O app nao e assinado pela Apple, entao nao da para
      // trocar sozinho: o lojista arrasta o programa para a pasta Aplicativos (por
      // cima do antigo). Melhor que so abrir a pagina, mas o passo final e manual.
      const url = base + '/downloads/UaiPedidos-Print-mac.dmg';
      const destino = path.join(app.getPath('temp'), 'UaiPedidos-Print.dmg');
      registrarLog('info', 'Baixando a nova versao do UaiPedidos Print...', { tipo: 'config' });
      const resp = await fetch(url, { redirect: 'follow' });
      if (!resp || !resp.ok) throw new Error('download falhou (' + (resp && resp.status) + ')');
      const buf = Buffer.from(await resp.arrayBuffer());
      if (!buf.length) throw new Error('instalador vazio');
      fs.writeFileSync(destino, buf);
      registrarLog('ok', 'Instalador baixado. Abrindo para atualizar.', { tipo: 'config' });
      await shell.openPath(destino);
      return { ok: true, msg: 'Instalador aberto. Arraste o UaiPedidos Print para a pasta Aplicativos.' };
    }
    // Outros sistemas: abre a pagina de instalacao.
    abrirPaginaInstalacao();
    registrarLog('info', 'Abri a pagina de instalacao para atualizar (atualizacao manual).', { tipo: 'config' });
    return { ok: true, msg: 'Pagina de instalacao aberta (atualizacao manual)' };
  } catch (e) {
    const erro = (e && e.message) || String(e);
    registrarLog('erro', 'Falha ao atualizar: ' + erro, { tipo: 'config', nivel: 'erro' });
    return { ok: false, erro: erro.slice(0, 300) };
  } finally {
    atualizando = false;
  }
}

// Aplica uma configuracao recebida do painel (comando aplicar_config). Replica os
// efeitos de salvar pela janela: autostart, reinicia o monitoramento e refaz a
// fotografia do ambiente (a impressora pode ter mudado).
function aplicarConfigRemota(permitido) {
  try {
    aplicarAutostart();
    if (poller) poller.iniciar();
    registrarLog('info', 'Configuracao aplicada pelo painel.', { tipo: 'config', dados: permitido });
    coletarAmbiente('config');
    enviarStatus(poller ? poller.status() : null);
  } catch (e) {}
}

// Mostra (ou limpa) o recado do suporte na tela. O texto ja foi gravado no config
// pelo comando 'recado'; aqui so empurramos o novo status para a janela.
function mostrarRecado() {
  try {
    const texto = store.getConfig().recado || '';
    registrarLog('info', texto ? ('Recado do suporte: ' + texto) : 'Recado do suporte removido.', { tipo: 'config' });
    enviarStatus(poller ? poller.status() : null);
  } catch (e) {}
}

// Desconecta a loja (logout). Usado pelo botao "Desconectar" da tela e pelo comando
// 'deslogar' do suporte. Quem chama deve garantir o flush da telemetria ANTES,
// pois aqui o token e apagado e o envio pos-logout nao teria como autenticar.
function fazerLogout(motivo) {
  registrarLog('aviso', 'Desconectado da loja' + (motivo ? ' (' + motivo + ')' : '') + '.', { tipo: 'conexao' });
  store.limparToken();
  store.setConfig({ email: '' });
  store.setSenha('');
  if (poller) poller.parar();
  enviarStatus(poller ? poller.status() : null);
}

function criarJanela() {
  win = new BrowserWindow({
    width: 520, height: 720, minWidth: 460, minHeight: 560,
    title: 'UaiPedidos Print',
    icon: path.join(ASSETS, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(UI, 'config.html'));
  win.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); win.hide(); }
  });
}

function mostrarJanela() {
  if (!win || win.isDestroyed()) criarJanela();
  win.show();
  win.focus();
}

function atualizarTray(st) {
  if (!tray) return;
  const s = st || statusCompleto();
  const cfg = store.getConfig();
  const ctrl = store.getControle();
  const estadoTxt = ctrl.bloqueado ? 'Bloqueado pelo suporte'
    : ctrl.pausar ? 'Pausado pelo painel'
    : cfg.pausado ? 'Pausado'
    : s.conectado ? ('Ativo' + (s.loja ? ' - ' + s.loja : ''))
    : 'Desconectado';
  tray.setToolTip('UaiPedidos Print - ' + estadoTxt);
  const itens = [
    { label: 'UaiPedidos Print (' + estadoTxt + ')', enabled: false },
  ];
  if (s.atualizar) {
    itens.push({ label: 'Atualizar agora (' + s.versaoRecomendada + ')', click: () => atualizarAgora('tray') });
  }
  itens.push({ type: 'separator' });
  itens.push({ label: 'Abrir configurações', click: () => mostrarJanela() });
  itens.push({
    // Sob bloqueio ou pausa remota do painel, o lojista nao controla a pausa por aqui.
    label: cfg.pausado ? 'Retomar impressão' : 'Pausar impressão',
    enabled: !ctrl.bloqueado && !ctrl.pausar,
    click: () => alternarPausa(!cfg.pausado),
  });
  itens.push({ label: 'Imprimir teste', enabled: !ctrl.bloqueado, click: async () => { await poller.imprimirTeste(); } });
  itens.push({ type: 'separator' });
  itens.push({ label: 'Sair', click: () => { app.isQuitting = true; app.quit(); } });
  tray.setContextMenu(Menu.buildFromTemplate(itens));
}

function alternarPausa(pausado) {
  store.setConfig({ pausado });
  if (pausado) { registrarLog('aviso', 'Impressão pausada.'); }
  else { registrarLog('info', 'Impressão retomada.'); }
  poller.iniciar();
  enviarStatus(poller.status());
}

function aplicarAutostart() {
  try {
    const cfg = store.getConfig();
    app.setLoginItemSettings({ openAtLogin: !!cfg.autostart, openAsHidden: true });
  } catch (e) {}
}

function avisarPedidoNovo(pedido, quantos) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title: quantos > 1 ? (quantos + ' pedidos novos') : ('Novo pedido #' + (pedido.numero || pedido.id)),
      body: (pedido.cliente_nome || 'Cliente') + (pedido.total != null ? ' - R$ ' + Number(pedido.total).toFixed(2).replace('.', ',') : ''),
      icon: path.join(ASSETS, 'icon.png'),
      silent: false,
    });
    n.on('click', () => mostrarJanela());
    n.show();
  } catch (e) {}
}

// Notificacao de versao nova disponivel (uma vez por versao). Clicar leva a pagina
// de instalacao.
function avisarNovaVersao(versaoNova) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title: 'Atualização disponível',
      body: 'Uma nova versão do UaiPedidos Print (' + versaoNova + ') está disponível. Clique para baixar e atualizar.',
      icon: path.join(ASSETS, 'icon.png'),
      silent: true,
    });
    n.on('click', () => abrirPaginaInstalacao());
    n.show();
  } catch (e) {}
}

// Chamado quando a telemetria traz o bloco de controle do servidor.
function aoReceberControle(ctrl) {
  // Reflete imediatamente no ícone/janela (bloqueio, pausa remota, aviso de versao).
  try { enviarStatus(poller ? poller.status() : null); } catch (e) {}
  // Aviso de versao nova: so uma vez por versao recomendada.
  try {
    const rec = ctrl && ctrl.versao_recomendada;
    if (rec && versaoMaior(rec, app.getVersion()) && rec !== ultimaVersaoAvisada) {
      ultimaVersaoAvisada = rec;
      avisarNovaVersao(rec);
    }
  } catch (e) {}
}

function configurarIpc() {
  ipcMain.handle('config:get', () => store.getConfig());
  ipcMain.handle('logs:recentes', () => logs.slice(-120));
  ipcMain.handle('status:get', () => statusCompleto());

  ipcMain.handle('config:salvar', (_e, parcial) => {
    const permitido = {};
    for (const k of ['base', 'impressora', 'vias', 'intervalo', 'copiasCozinha', 'som', 'autostart']) {
      if (parcial && parcial[k] !== undefined) permitido[k] = parcial[k];
    }
    const c = store.setConfig(permitido);
    aplicarAutostart();
    poller.iniciar();
    registrarLog('info', 'Configurações salvas.', { tipo: 'config', dados: permitido });
    coletarAmbiente('config'); // impressora pode ter mudado
    if (telemetria) telemetria.flush(true);
    return c;
  });

  ipcMain.handle('auth:conectar', async (_e, { base, email, senha }) => {
    try {
      store.setConfig({ base: base || 'https://uaipedidos.com.br', email: email || '' });
      if (senha) store.setSenha(senha);
      const api = require('./api');
      const token = await api.login(store.getConfig().base, email, senha || store.getSenha());
      store.setToken(token);
      let loja = '';
      try { const me = await api.me(store.getConfig().base, token); loja = (me && (me.nome || (me.estabelecimento && me.estabelecimento.nome))) || ''; } catch (e) {}
      registrarLog('ok', 'Conectado' + (loja ? ' a ' + loja : '') + '.', { tipo: 'conexao' });
      poller.iniciar();
      coletarAmbiente('conexao');
      if (telemetria) telemetria.flush(true); // aparece no monitor logo apos conectar
      return { ok: true, loja };
    } catch (e) {
      registrarLog('erro', 'Falha ao conectar: ' + (e.message || e));
      return { ok: false, erro: e.message || String(e) };
    }
  });

  ipcMain.handle('auth:sair', async () => {
    // Envia a telemetria pendente ANTES de apagar o token (senao nao envia).
    try { if (telemetria) await telemetria.flush(true); } catch (e) {}
    fazerLogout();
    return store.getConfig();
  });

  ipcMain.handle('impressoras:listar', () => printer.listarImpressoras());
  ipcMain.handle('teste:imprimir', () => poller.imprimirTeste());
  ipcMain.handle('pausa:alternar', (_e, v) => { alternarPausa(!!v); return store.getConfig(); });
  ipcMain.handle('abrir:pasta', () => { shell.openPath(store.pastaDados()); return true; });
  ipcMain.handle('abrir:instalacao', () => { abrirPaginaInstalacao(); return true; });
  ipcMain.handle('atualizar:agora', () => atualizarAgora('botao'));
}

app.whenReady().then(() => {
  store = require('./store');
  printer = require('./printer');
  const { criarPoller } = require('./poller');
  poller = criarPoller({
    onLog: registrarLog,
    onStatus: enviarStatus,
    onNovoPedido: avisarPedidoNovo,
  });

  // Telemetria: envia o diario de bordo (estado + eventos) ao servidor e recebe o
  // bloco de controle, que repassamos para aoReceberControle. Os comandos de suporte
  // que vierem de carona no controle sao executados pelo modulo comandos.
  comandos = require('./comandos');
  comandos.configurar({
    app,
    poller,
    get telemetria() { return telemetria; },
    coletarAmbiente,
    aplicarConfig: aplicarConfigRemota,
    atualizarAgora,
    mostrarRecado,
    deslogar: () => fazerLogout('comando do suporte'),
  });
  telemetria = require('./telemetria');
  telemetria.iniciar({
    versao: app.getVersion(),
    getEstado: estadoAtual,
    onControle: aoReceberControle,
    onComandos: comandos.processar,
  });
  registrarLog('info', 'UaiPedidos Print iniciado (versao ' + app.getVersion() + ').', { tipo: 'inicio' });
  coletarAmbiente('inicio');
  // Reconfere o ambiente (impressoras, driver padrao, etc.) a cada 30 min.
  setInterval(() => { coletarAmbiente('rotina'); }, 30 * 60 * 1000);

  configurarIpc();

  // ícone da bandeja
  let img = nativeImage.createFromPath(path.join(ASSETS, 'tray.png'));
  if (process.platform === 'darwin') img = img.resize({ width: 18, height: 18 });
  tray = new Tray(img);
  tray.on('click', () => mostrarJanela());
  tray.on('double-click', () => mostrarJanela());
  atualizarTray();

  aplicarAutostart();

  const cfg = store.getConfig();
  const configurado = cfg.email && (cfg.temSenha || cfg.temToken);
  if (configurado) {
    poller.iniciar();
    // se não foi aberto escondido pelo autostart, mostra a janela
    if (!app.getLoginItemSettings().wasOpenedAsHidden) criarJanela();
    else registrarLog('info', 'Iniciado em segundo plano.');
  } else {
    criarJanela();
    registrarLog('info', 'Bem-vindo. Conecte a sua loja para começar.');
  }

  app.on('activate', () => mostrarJanela());
});

// Não encerra ao fechar todas as janelas: vive na bandeja.
app.on('window-all-closed', (e) => { /* mantém vivo na bandeja */ });
app.on('before-quit', () => {
  app.isQuitting = true;
  try { if (telemetria) telemetria.registrar('info', 'Programa encerrado.', { tipo: 'parada' }); } catch (e) {}
  if (poller) poller.parar();
});
