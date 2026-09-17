'use strict';
/*
 * afterPack.js
 * Assinatura ad-hoc (sem certificado pago) do app do Mac, feita na montagem, para
 * o programa CONSEGUIR ABRIR nos Macs com chip Apple (que recusam abrir app sem
 * assinatura, chamando de "danificado"). NAO remove o aviso "nao verificado"
 * (isso so a notarizacao remove), mas permite abrir pelo caminho normal
 * (Privacidade e Seguranca, Abrir mesmo assim), sem Terminal.
 *
 * Tudo aqui e protegido: se algo der errado na assinatura, apenas avisa e segue,
 * NUNCA derruba a montagem. Roda so no Mac.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

exports.default = async function afterPack(context) {
  try {
    if (!context || context.electronPlatformName !== 'darwin') return;
    const dir = context.appOutDir;
    if (!dir || !fs.existsSync(dir)) return;
    const app = fs.readdirSync(dir).find(f => f.endsWith('.app'));
    if (!app) { console.warn('[afterPack] nenhum .app encontrado em ' + dir); return; }
    const appPath = path.join(dir, app);
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
    console.log('[afterPack] assinatura ad-hoc aplicada em ' + appPath);
  } catch (e) {
    console.warn('[afterPack] aviso (seguindo sem assinar): ' + (e && e.message));
  }
};
