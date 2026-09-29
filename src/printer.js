'use strict';
/*
 * printer.js
 * Impressão silenciosa. Carrega o HTML do cupom numa janela invisível e manda
 * imprimir direto na impressora escolhida, sem diálogo e sem clique (o que o
 * navegador não deixa fazer). Espera o logo carregar antes de imprimir, com um
 * teto de 3 segundos, igual ao painel faz hoje.
 */
const { BrowserWindow } = require('electron');

function novaJanelaOculta(larguraPx) {
  return new BrowserWindow({
    show: false,
    width: Math.max(120, Math.round(Number(larguraPx) || 480)),
    height: 800,
    webPreferences: { offscreen: false, javascript: true, images: true },
  });
}

// Lista as impressoras instaladas no computador.
async function listarImpressoras() {
  const win = novaJanelaOculta();
  try {
    await win.loadURL('data:text/html;charset=utf-8,<html><body></body></html>');
    const lista = await win.webContents.getPrintersAsync();
    return (lista || []).map(p => ({
      nome: p.name,
      descricao: p.displayName || p.description || p.name,
      padrao: !!p.isDefault,
    }));
  } catch (e) {
    return [];
  } finally {
    try { win.destroy(); } catch (e) {}
  }
}

// Imprime um documento HTML completo. Resolve quando o sistema aceitou o trabalho.
function imprimirHtml(html, opcoes = {}) {
  const { deviceName = '', copies = 1, larguraMm = 80 } = opcoes;
  // Largura do rolo em px de tela (96 dpi), para a janela oculta montar o cupom
  // na mesma largura em que ele sera impresso e a medida de altura bater.
  const larguraPx = Math.round((Number(larguraMm) || 80) * 96 / 25.4);
  return new Promise((resolve, reject) => {
    const win = novaJanelaOculta(larguraPx);
    let terminou = false;
    const encerrar = (fn, arg) => {
      if (terminou) return;
      terminou = true;
      try { win.destroy(); } catch (e) {}
      fn(arg);
    };
    // Rede de segurança: nada pode deixar o trabalho preso para sempre.
    const guarda = setTimeout(() => encerrar(reject, new Error('Tempo esgotado ao preparar a impressão')), 20000);

    win.webContents.on('did-finish-load', async () => {
      try {
        // Espera as imagens (logo) carregarem, com teto de 3s.
        await win.webContents.executeJavaScript(`new Promise(function(r){
          var imgs = Array.prototype.slice.call(document.images || []).filter(function(i){return !i.complete;});
          if (!imgs.length) return r(true);
          var restam = imgs.length, fim = false;
          function pronto(){ if(fim) return; fim = true; r(true); }
          imgs.forEach(function(im){ im.onload = im.onerror = function(){ if(--restam <= 0) pronto(); }; });
          setTimeout(pronto, 3000);
        })`).catch(() => {});

        // Mede a altura real do cupom para informar ao Windows o tamanho EXATO do
        // papel. Sem pageSize, o Electron assume A4, e a impressora termica de
        // 80mm recebe o trabalho mas nao imprime nada. Era esse o bug.
        let alturaMm = 0;
        try {
          alturaMm = await win.webContents.executeJavaScript(
            'Math.ceil(Math.max('
            + '(document.body ? document.body.scrollHeight : 0),'
            + '(document.documentElement ? document.documentElement.scrollHeight : 0)'
            + ') * 25.4 / 96)'
          );
        } catch (e) {}
        const MICRON_POR_MM = 1000;
        const larguraFinalMm = Number(larguraMm) || 80;
        const alturaFinalMm = Math.max(40, (Number(alturaMm) || 200) + 4); // folga de 4mm
        const cfgPrint = {
          silent: true,
          printBackground: true,
          margins: { marginType: 'none' },
          copies: Math.max(1, Number(copies) || 1),
          pageSize: {
            width: Math.round(larguraFinalMm * MICRON_POR_MM),
            height: Math.round(alturaFinalMm * MICRON_POR_MM),
          },
        };
        if (deviceName) cfgPrint.deviceName = deviceName;

        win.webContents.print(cfgPrint, (sucesso, motivo) => {
          clearTimeout(guarda);
          if (sucesso) encerrar(resolve, true);
          else encerrar(reject, new Error(motivo || 'A impressão foi cancelada ou falhou'));
        });
      } catch (e) {
        clearTimeout(guarda);
        encerrar(reject, e);
      }
    });

    win.webContents.on('did-fail-load', (_e, code, desc) => {
      clearTimeout(guarda);
      encerrar(reject, new Error('Falha ao montar o cupom: ' + (desc || code)));
    });

    // Carrega o HTML na janela invisível.
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch(err => {
      clearTimeout(guarda);
      encerrar(reject, err);
    });
  });
}

module.exports = { listarImpressoras, imprimirHtml };
