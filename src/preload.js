'use strict';
/*
 * preload.js
 * Ponte segura entre a tela de configuração e o processo principal. A tela não
 * tem acesso direto ao sistema; só pode chamar estas funções.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('uai', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  salvarConfig: (parcial) => ipcRenderer.invoke('config:salvar', parcial),
  conectar: (dados) => ipcRenderer.invoke('auth:conectar', dados),
  sair: () => ipcRenderer.invoke('auth:sair'),
  listarImpressoras: () => ipcRenderer.invoke('impressoras:listar'),
  imprimirTeste: () => ipcRenderer.invoke('teste:imprimir'),
  alternarPausa: (v) => ipcRenderer.invoke('pausa:alternar', v),
  getStatus: () => ipcRenderer.invoke('status:get'),
  logsRecentes: () => ipcRenderer.invoke('logs:recentes'),
  abrirPasta: () => ipcRenderer.invoke('abrir:pasta'),
  onLog: (cb) => ipcRenderer.on('log', (_e, item) => cb(item)),
  onStatus: (cb) => ipcRenderer.on('status', (_e, st) => cb(st)),
});
