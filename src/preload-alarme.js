'use strict';
// Ponte segura entre a janelinha do alarme e o processo principal (1.1.0).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('alarme', {
  aoTocar: (cb) => ipcRenderer.on('alarme:tocar', (_e, dados) => cb(dados)),
  aoPedidos: (cb) => ipcRenderer.on('alarme:pedidos', (_e, lista) => cb(lista)),
  vi: () => ipcRenderer.invoke('alarme:vi'),
  abrir: () => ipcRenderer.invoke('alarme:abrir'),
});
