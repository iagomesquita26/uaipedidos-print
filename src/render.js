'use strict';
/*
 * render.js
 * Monta o cupom. Desde a 1.1.0 o programa NAO tem mais uma copia traduzida das
 * vias: ele roda o MESMO arquivo do painel (nucleo-impressao.js, copia sem
 * nenhuma mudanca de abas/_nucleo/impressao.js do site), dentro de um vm do Node.
 * Assim todas as chaves de "Mostrar ou ocultar", o corte entre vias, o troco, a
 * mesa e a largura do papel saem exatamente como na impressao pelo navegador.
 *
 * Quando o painel mudar o cupom, basta copiar o arquivo de novo:
 *   cp <site>/abas/_nucleo/impressao.js src/nucleo-impressao.js
 *
 * Cada impressao cria um nucleo novo (sem estado guardado entre pedidos).
 * Se o nucleo falhar por qualquer motivo, cai no motor antigo (render-legado.js),
 * para o pedido nao deixar de sair.
 *
 * Este modulo nao depende de nada do sistema operacional: recebe o pedido e as
 * preferencias da loja e devolve HTML puro, que o printer.js manda para a bobina.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const legado = require('./render-legado');

// Se o arquivo do nucleo faltar ou nao compilar, fica null e tudo usa o motor antigo.
let NUCLEO = null;
try {
  NUCLEO = new vm.Script(
    fs.readFileSync(path.join(__dirname, 'nucleo-impressao.js'), 'utf8'),
    { filename: 'nucleo-impressao.js' }
  );
} catch (e) { console.error('[render] nucleo nao carregou:', e && e.message); }

// Funcoes do nucleo que o programa usa. Se uma copia velha do arquivo do painel
// nao tiver alguma, o nucleo nao vale e o motor antigo assume (avisando no log).
const EXIGIDAS = ['sincronizarImpressao', 'viaCozinha', 'viaMotoboy', 'docImpressaoVias'];

// Endereco do site (vem do poller). A logo da loja e salva como "/uploads/...";
// no navegador ela se resolve sozinha, mas no programa o cupom e um documento
// solto, entao precisa do endereco completo.
let BASE = '';
function definirBase(b) { BASE = /^https?:\/\//.test(String(b || '')) ? String(b).replace(/\/+$/, '') : ''; }

// Avisa (uma vez a cada 10 min) quando o motor antigo assumiu, para o suporte ver.
let aoFalhar = null, ultimoAviso = 0;
function definirAvisoFalha(fn) { aoFalhar = typeof fn === 'function' ? fn : null; }
function falhou(e) {
  const msg = (e && e.message) || String(e);
  console.error('[render] nucleo falhou, usando o motor antigo:', msg);
  if (aoFalhar && Date.now() - ultimoAviso > 10 * 60 * 1000) {
    ultimoAviso = Date.now();
    try { aoFalhar('Cupom montado pelo modo de reserva (' + msg + ').'); } catch (e2) {}
  }
}

// ------- auxiliares iguais aos do painel.php (passados ao nucleo) -------
const moeda = v => 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',');
const fmtDataFull = x => x ? new Date(String(x).replace(' ', 'T')).toLocaleString('pt-BR') : '';
const pagLabel = m => ({ pix: 'PIX', dinheiro: 'Dinheiro', cartao_entrega: 'Cartão na entrega' }[m] || m || '-');
const pagStLabel = s => ({ pendente: 'Pendente', pago: 'Pago', simulado: 'Simulado', estornado: 'Estornado' }[s] || s || '-');

// Aceita as preferencias no formato da loja (imp_largura, imp_avancado...) e, por
// compatibilidade, no formato curto antigo (largura, av...). O nucleo le o primeiro.
function comoLoja(cfg, est) {
  const c = cfg || {};
  const e = Object.assign({}, est || {}, c);
  const curto = { imp_margem_topo: 'margem_topo', imp_margem_baixo: 'margem_baixo', imp_margem_esq: 'margem_esq',
    imp_margem_dir: 'margem_dir', imp_largura: 'largura', imp_fonte: 'fonte', imp_fonte_tam: 'fonte_tam', imp_avancado: 'av' };
  Object.keys(curto).forEach(k => { if (e[k] == null && c[curto[k]] != null) e[k] = c[curto[k]]; });
  if (BASE && typeof e.logo_url === 'string' && e.logo_url.startsWith('/') && !e.logo_url.startsWith('//')) e.logo_url = BASE + e.logo_url;
  return e;
}

// Cria um nucleo novo do painel, ja sincronizado com as preferencias da loja.
function nucleo(cfg, est) {
  if (!NUCLEO) throw new Error('nucleo indisponivel');
  const loja = comoLoja(cfg, est);
  // O nucleo so usa window/document/localStorage na impressao pelo navegador, que
  // o programa nunca chama. Ficam aqui so para nada quebrar se alguem chamar.
  const ctx = {
    window: {}, Date, setTimeout: () => 0, clearTimeout: () => {},
    document: { hidden: false }, navigator: {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  NUCLEO.runInNewContext(ctx);
  const n = ctx.window.criarNucleoImpressao({
    reactive: o => o, estab: { value: loja }, autoCfg: {}, pedDet: {},
    moeda, pagLabel, pagStLabel, fmtDataFull, estabIdAtual: () => 0,
    avisar() {}, api() { return Promise.reject(new Error('sem api no programa')); }, esperarVozComecar() {},
  });
  const falta = EXIGIDAS.filter(f => typeof n[f] !== 'function');
  if (falta.length) throw new Error('nucleo sem ' + falta.join(', '));
  n.sincronizarImpressao();
  return n;
}

// Mesma regra do painel (viasDoPedido). 'entrega' vale como 'motoboy'.
function viasDe(n, det, escolha) {
  const esc = escolha || 'cozinha';
  const vias = [];
  if (esc === 'cozinha' || esc === 'ambas') vias.push(n.viaCozinha(det));
  if (esc === 'motoboy' || esc === 'entrega' || esc === 'ambas') vias.push(n.viaMotoboy(det));
  return vias;
}

function montarVias(det, cfg, est, escolha) {
  try { return viasDe(nucleo(cfg, est), det, escolha); }
  catch (e) { falhou(e); return legado.montarVias(det, cfg, est, escolha); }
}

// Monta o documento HTML final pronto para impressao (sem o roteiro do navegador).
function montarDocumento(det, cfg, est, escolha) {
  try {
    const n = nucleo(cfg, est);
    const vias = viasDe(n, det, escolha);
    if (!vias.length) return '';
    return n.docImpressaoVias(vias, false);
  } catch (e) {
    falhou(e);
    return legado.montarDocumento(det, cfg, est, escolha);
  }
}

// Varias vias ja montadas num papel so (cfg no formato da loja ou curto).
function documentoVias(vias, cfg) {
  const lista = (Array.isArray(vias) ? vias : [vias]).filter(Boolean);
  if (!lista.length) return '';
  try { return nucleo(cfg).docImpressaoVias(lista, false); }
  catch (e) { falhou(e); return legado.documentoVias(lista, cfg); }
}

// O nucleo do painel nao exporta o docShell; fica o do motor antigo.
function docShell(titulo, inner, cfg) { return legado.docShell(titulo, inner, cfg); }

function viaCozinha(d, cfg, est) { try { return nucleo(cfg, est).viaCozinha(d); } catch (e) { falhou(e); return legado.viaCozinha(d, cfg, est); } }
function viaMotoboy(d, cfg, est) { try { return nucleo(cfg, est).viaMotoboy(d); } catch (e) { falhou(e); return legado.viaMotoboy(d, cfg, est); } }

// Preferencias resolvidas (largura, margens, fonte, av), iguais ao impCfg do painel.
// Usado para o tamanho do papel na impressora e no relatorio do suporte.
function normalizarCfg(bruto) {
  try {
    const c = nucleo(bruto).impCfg;
    return {
      margem_topo: c.margem_topo, margem_baixo: c.margem_baixo, margem_esq: c.margem_esq, margem_dir: c.margem_dir,
      largura: c.largura, fonte: c.fonte, fonte_tam: c.fonte_tam, av: Object.assign({}, c.av),
    };
  } catch (e) {
    falhou(e);
    return legado.normalizarCfg(bruto);
  }
}

const _base = (() => { try { return nucleo({}); } catch (e) { return null; } })();
const IMP_FONTES = _base ? _base.IMP_FONTES : legado.IMP_FONTES;
const IMP_AV_PADRAO = _base ? _base.IMP_AV_PADRAO : legado.IMP_AV_PADRAO;

module.exports = {
  montarDocumento, montarVias, documentoVias, docShell,
  viaCozinha, viaMotoboy, normalizarCfg, IMP_FONTES, IMP_AV_PADRAO,
  definirBase, definirAvisoFalha,
  PEDIDO_EXEMPLO: legado.PEDIDO_EXEMPLO,
};
