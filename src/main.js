'use strict';
/*
 * main.js
 * Processo principal do UaiPedidos Print. Cuida do ícone na bandeja, da janela de
 * configuração, dos avisos de pedido novo e liga tudo ao cérebro (poller.js).
 * O programa fica rodando em segundo plano; fechar a janela não encerra o app,
 * só some para a bandeja. Encerra de verdade pelo menu "Sair".
 */
const path = require('path');
const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, nativeImage, shell } = require('electron');

let tray = null;
let win = null;
let poller = null;
let store = null;
let printer = null;
const logs = [];           // histórico curto de mensagens
const MAX_LOGS = 250;

const ASSETS = path.join(__dirname, '..', 'assets');
const UI = path.join(__dirname, '..', 'ui');

// Uma instância só (abrir de novo apenas mostra a janela).
if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => mostrarJanela());

function registrarLog(nivel, msg) {
  const item = { nivel, msg, ts: Date.now() };
  logs.push(item);
  if (logs.length > MAX_LOGS) logs.shift();
  if (win && !win.isDestroyed()) win.webContents.send('log', item);
}

function enviarStatus(st) {
  if (win && !win.isDestroyed()) win.webContents.send('status', st);
  atualizarTray(st);
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
  const s = st || (poller && poller.status()) || {};
  const cfg = store.getConfig();
  const estadoTxt = cfg.pausado ? 'Pausado'
    : s.conectado ? ('Ativo' + (s.loja ? ' - ' + s.loja : ''))
    : 'Desconectado';
  tray.setToolTip('UaiPedidos Print - ' + estadoTxt);
  const menu = Menu.buildFromTemplate([
    { label: 'UaiPedidos Print (' + estadoTxt + ')', enabled: false },
    { type: 'separator' },
    { label: 'Abrir configurações', click: () => mostrarJanela() },
    {
      label: cfg.pausado ? 'Retomar impressão' : 'Pausar impressão',
      click: () => alternarPausa(!cfg.pausado),
    },
    { label: 'Imprimir teste', click: async () => { await poller.imprimirTeste(); } },
    { type: 'separator' },
    { label: 'Sair', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
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

function configurarIpc() {
  ipcMain.handle('config:get', () => store.getConfig());
  ipcMain.handle('logs:recentes', () => logs.slice(-120));
  ipcMain.handle('status:get', () => poller.status());

  ipcMain.handle('config:salvar', (_e, parcial) => {
    const permitido = {};
    for (const k of ['base', 'impressora', 'vias', 'intervalo', 'copiasCozinha', 'som', 'autostart']) {
      if (parcial && parcial[k] !== undefined) permitido[k] = parcial[k];
    }
    const c = store.setConfig(permitido);
    aplicarAutostart();
    poller.iniciar();
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
      registrarLog('ok', 'Conectado' + (loja ? ' a ' + loja : '') + '.');
      poller.iniciar();
      return { ok: true, loja };
    } catch (e) {
      registrarLog('erro', 'Falha ao conectar: ' + (e.message || e));
      return { ok: false, erro: e.message || String(e) };
    }
  });

  ipcMain.handle('auth:sair', () => {
    store.limparToken();
    store.setConfig({ email: '' });
    store.setSenha('');
    registrarLog('aviso', 'Desconectado da loja.');
    poller.parar();
    enviarStatus(poller.status());
    return store.getConfig();
  });

  ipcMain.handle('impressoras:listar', () => printer.listarImpressoras());
  ipcMain.handle('teste:imprimir', () => poller.imprimirTeste());
  ipcMain.handle('pausa:alternar', (_e, v) => { alternarPausa(!!v); return store.getConfig(); });
  ipcMain.handle('abrir:pasta', () => { shell.openPath(store.pastaDados()); return true; });
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
app.on('before-quit', () => { app.isQuitting = true; if (poller) poller.parar(); });
