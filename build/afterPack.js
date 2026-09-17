'use strict';
/*
 * afterPack.js
 * Assinatura ad-hoc (sem certificado pago) do app do Mac, feita na montagem.
 * Serve para o programa CONSEGUIR ABRIR nos Macs com chip Apple, que recusam
 * abrir qualquer app totalmente sem assinatura ("danificado").
 *
 * Importante: isto NÃO remove o aviso "não foi possível verificar se está livre
 * de malware". Esse aviso some só com a notarização (conta Apple paga). Com a
 * assinatura ad-hoc, o lojista consegue abrir pelo caminho normal
 * (Privacidade e Segurança, Abrir mesmo assim), sem precisar do Terminal.
 *
 * Roda só no Mac. Em Windows/Linux não faz nada.
 */
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const nome = context.packager.appInfo.productFilename; // "UaiPedidos Print"
  const appPath = path.join(context.appOutDir, nome + '.app');
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
    console.log('[afterPack] assinatura ad-hoc aplicada em ' + appPath);
  } catch (e) {
    console.warn('[afterPack] nao foi possivel assinar ad-hoc: ' + (e && e.message));
  }
};
