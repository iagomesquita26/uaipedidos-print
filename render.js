'use strict';
/*
 * render.js
 * Motor de montagem do cupom. É a tradução fiel do que o painel do UaiPedidos
 * faz hoje (painel.php, funções docShell / viaCozinha / viaMotoboy / cabecalhoImp
 * e auxiliares). O objetivo é gerar um cupom IDENTICO ao do painel, para a loja
 * não ver diferença ao trocar o navegador pelo programa local.
 *
 * Este módulo não depende de nada do sistema operacional: recebe o pedido e as
 * preferências da loja e devolve HTML puro, que o printer.js manda para a bobina.
 */

// ------- auxiliares (espelham painel.php) -------
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
const sepImp = extra => '<div class="sep"' + (extra ? ' style="' + extra + '"' : '') + '></div>';
function primeiroNome(nome) { return String(nome || '').trim().split(/\s+/)[0] || ''; }
function agoraTexto() {
  const d = new Date(), pad = n => String(n).padStart(2, '0');
  return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
const moeda = v => 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',');
const fmtDataFull = x => {
  if (!x) return '';
  try { return new Date(String(x).replace(' ', 'T')).toLocaleString('pt-BR'); } catch (e) { return String(x); }
};
const pagLabel = m => ({ pix: 'PIX', dinheiro: 'Dinheiro', cartao_entrega: 'Cartão na entrega' }[m] || m || '-');
const pagStLabel = s => ({ pendente: 'Pendente', pago: 'Pago', simulado: 'Simulado', estornado: 'Estornado' }[s] || s || '-');

// ------- preferências (espelham painel.php) -------
const IMP_FONTES = {
  sans:   { css: "'Segoe UI','Helvetica Neue','DejaVu Sans',Verdana,Arial,sans-serif" },
  arial:  { css: "Arial,'Helvetica Neue',Helvetica,sans-serif" },
  tahoma: { css: "Tahoma,'DejaVu Sans Condensed',Verdana,sans-serif" },
  mono:   { css: "'Courier New',Courier,monospace" },
};
const IMP_AV_PADRAO = () => ({
  categoria: true, descricao: true, precos_cozinha: false, observacoes: true, data: true,
  telefone: true, endereco_completo: true, valores: true, pagamento: true, volumes: true, nao_fiscal: true,
  contato_loja: false, logo: false, fonte_grande_cozinha: false,
  cabecalho_texto: '', rodape_texto: '', densidade: 'padrao', alinhamento: 'centro', espaco_fim: 0,
});

// Normaliza o objeto de configuração vindo da loja para o formato que as vias usam.
function normalizarCfg(bruto) {
  const c = bruto || {};
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  return {
    margem_topo:  num(c.imp_margem_topo  != null ? c.imp_margem_topo  : c.margem_topo, 5),
    margem_baixo: num(c.imp_margem_baixo != null ? c.imp_margem_baixo : c.margem_baixo, 5),
    margem_esq:   num(c.imp_margem_esq   != null ? c.imp_margem_esq   : c.margem_esq, 5),
    margem_dir:   num(c.imp_margem_dir   != null ? c.imp_margem_dir   : c.margem_dir, 5),
    largura:      num(c.imp_largura != null ? c.imp_largura : c.largura, 80) === 58 ? 58 : 80,
    fonte:        ['sans', 'arial', 'tahoma', 'mono'].includes(c.imp_fonte || c.fonte) ? (c.imp_fonte || c.fonte) : 'sans',
    fonte_tam:    num(c.imp_fonte_tam != null ? c.imp_fonte_tam : c.fonte_tam, 13),
    av: Object.assign(IMP_AV_PADRAO(),
      (c.imp_avancado && typeof c.imp_avancado === 'object') ? c.imp_avancado :
      (c.av && typeof c.av === 'object') ? c.av : {}),
  };
}

// ------- documento (espelha docShell) -------
function docShell(titulo, inner, cfg) {
  const c = normalizarCfg(cfg);
  const cfgL = Number(c.largura) === 58 ? 58 : 80;
  const mm = v => Math.min(50, Math.max(0, Number(v) || 0));
  const mt = mm(c.margem_topo), mb = mm(c.margem_baixo), mEsq = mm(c.margem_esq), mDir = mm(c.margem_dir);
  const fam = (IMP_FONTES[c.fonte] || IMP_FONTES.sans).css;
  const tam = Math.min(20, Math.max(10, Number(c.fonte_tam) || 13));
  const larguraConteudo = Math.max(120, Math.round((cfgL - mEsq - mDir) * 3.78));
  const av = c.av || {};
  const compacto = av.densidade === 'compacto';
  const lh = compacto ? 1.18 : 1.35;
  const fim = Math.min(40, Math.max(0, Number(av.espaco_fim) || 0));
  return '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>' + escHtml(titulo) + '</title><style>' +
    '@page { size: ' + cfgL + 'mm auto; margin: ' + mt + 'mm ' + mDir + 'mm ' + mb + 'mm ' + mEsq + 'mm; }' +
    'html, body { background:#fff; color:#000; margin:0; padding:0; }' +
    'body { font-family:' + fam + '; font-size:' + tam + 'px; line-height:' + lh + '; }' +
    '.bobina { max-width:' + larguraConteudo + 'px; margin:0 auto; padding:8px 2px; word-break:break-word; }' +
    '.c { text-align:center; } .b { font-weight:bold; }' +
    '.lin { display:flex; justify-content:space-between; gap:10px; align-items:baseline; }' +
    '.lin .v { white-space:nowrap; }' +
    '.it { margin:6px 0 1px; }' +
    '.desc { font-size:.82em; margin:0 0 2px; }' +
    '.opc { font-size:.9em; }' +
    '.obs { font-weight:bold; text-transform:uppercase; font-size:.9em; }' +
    '.cat { font-weight:bold; text-transform:uppercase; font-size:.9em; margin:10px 0 3px; border-bottom:1px solid #000; padding-bottom:1px; }' +
    '.sep { border-top:1px dashed #000; margin:6px 0; }' +
    '.corte { border-top:2px dashed #000; margin:22px 0 4px; }' +
    '.corte-tx { text-align:center; font-size:.72em; letter-spacing:2px; margin-bottom:12px; }' +
    (compacto ? '.sep{margin:3px 0;} .it{margin:3px 0 0;} .cat{margin:6px 0 2px;} .lin{gap:8px;} .desc{margin:0 0 1px;}' : '') +
    '@media print { .bobina { max-width:100%; padding:0; } }' +
    '</style></head><body>' + inner +
    (fim > 0 ? '<div style="height:' + fim + 'mm"></div>' : '') +
    '</body></html>';
}

// Várias vias no MESMO papel, com o "CORTE AQUI" pontilhado entre elas.
function documentoVias(vias, cfg) {
  const lista = (Array.isArray(vias) ? vias : [vias]).filter(Boolean);
  const inner = lista.map((v, i) =>
    (i > 0 ? '<div class="corte"></div><div class="corte-tx">CORTE AQUI</div>' : '') +
    '<div class="bobina">' + v.corpo + '</div>'
  ).join('');
  return docShell((lista[0] && lista[0].titulo) || 'Pedido', inner, cfg);
}

// ------- cabeçalho comum (espelha cabecalhoImp) -------
function cabecalhoImp(cfg, est, nomeTam) {
  const av = normalizarCfg(cfg).av || {};
  const e = est || {};
  const al = av.alinhamento === 'esquerda' ? 'left' : 'center';
  const tn = nomeTam || '1.2em';
  let h = '';
  if (av.logo && e.logo_url) h += '<div style="text-align:' + al + ';margin-bottom:4px"><img src="' + escHtml(e.logo_url) + '" style="max-width:70%;max-height:90px"></div>';
  h += '<div class="b" style="text-align:' + al + ';font-size:' + tn + '">' + escHtml((e.nome || 'Loja').toUpperCase()) + '</div>';
  if (av.cabecalho_texto) h += '<div style="text-align:' + al + ';font-size:.85em">' + escHtml(av.cabecalho_texto) + '</div>';
  if (av.contato_loja) {
    const linhas = [];
    if (e.endereco) linhas.push(e.endereco);
    const tel = e.whatsapp || e.telefone;
    if (tel) linhas.push('WhatsApp ' + tel);
    if (e.instagram) linhas.push('@' + String(e.instagram).replace(/^@+/, ''));
    linhas.forEach(l => h += '<div style="text-align:' + al + ';font-size:.8em">' + escHtml(l) + '</div>');
  }
  return h;
}

// ------- via da cozinha (espelha viaCozinha) -------
function viaCozinha(d, cfg, est) {
  const p = d.pedido, itens = d.itens || [], av = normalizarCfg(cfg).av || {};
  const fItem = av.fonte_grande_cozinha ? '1.45em' : '1.15em';
  let h = '';
  if (Number(p.teste)) h += '<div class="c b" style="font-size:1.15em">*** PEDIDO DE TESTE ***</div>' + sepImp();
  h += cabecalhoImp(cfg, est);
  h += '<div class="c b">COZINHA</div>' + sepImp();
  h += '<div class="c b" style="font-size:1.9em; margin:4px 0">PEDIDO Nº ' + escHtml(p.numero) + '</div>';
  h += '<div class="c b">' + (p.tipo === 'retirada' ? 'RETIRADA' : 'ENTREGA') + '</div>';
  h += '<div class="c">Cliente: ' + escHtml(primeiroNome(p.cliente_nome)) + '</div>';
  h += sepImp('margin-top:4px');
  let catAtual = null;
  itens.forEach(it => {
    if (av.categoria !== false) { const cat = String(it.categoria || '').trim(); if (cat && cat !== catAtual) { h += '<div class="cat">' + escHtml(cat) + '</div>'; catAtual = cat; } }
    if (av.precos_cozinha) h += '<div class="lin it b" style="font-size:' + fItem + '"><span>' + escHtml(it.quantidade) + 'x ' + escHtml(it.nome) + '</span><span class="v">' + moeda(it.total) + '</span></div>';
    else h += '<div class="it b" style="font-size:' + fItem + '">' + escHtml(it.quantidade) + 'x ' + escHtml(it.nome) + '</div>';
    if (av.descricao !== false && it.descricao) h += '<div class="desc">' + escHtml(String(it.descricao).trim().slice(0, 400)) + '</div>';
    (it.opcoes || []).forEach(op => { h += '<div class="opc">+ ' + (Number(op.quantidade) > 1 ? escHtml(op.quantidade) + 'x ' : '') + escHtml(op.opcao_nome) + '</div>'; });
    if (it.observacao) h += '<div class="obs">OBS: ' + escHtml(it.observacao) + '</div>';
  });
  if (av.observacoes !== false && p.observacoes) { h += sepImp('margin-top:8px') + '<div class="c b">OBSERVACOES DO PEDIDO</div><div class="c" style="text-transform:uppercase">' + escHtml(p.observacoes) + '</div>'; }
  if (av.data !== false) h += sepImp('margin-top:8px') + '<div class="c" style="font-size:.8em">Impresso em ' + escHtml(agoraTexto()) + '</div>';
  if (av.rodape_texto) h += '<div class="c" style="font-size:.85em; margin-top:6px">' + escHtml(av.rodape_texto) + '</div>';
  return { titulo: 'Via cozinha - pedido ' + p.numero, corpo: h, fonte: 13 };
}

// ------- via de entrega (espelha viaMotoboy) -------
function viaMotoboy(d, cfg, est) {
  const p = d.pedido, itens = d.itens || [], e = p.endereco || null, av = normalizarCfg(cfg).av || {};
  let h = '';
  if (Number(p.teste)) h += '<div class="c b" style="font-size:1.3em">*** PEDIDO DE TESTE ***</div>' + sepImp();
  h += cabecalhoImp(cfg, est, '1.1em');
  h += '<div class="c b" style="font-size:1.9em; margin:4px 0">PEDIDO Nº ' + escHtml(p.numero) + '</div>';
  h += '<div class="c b">' + (p.tipo === 'retirada' ? 'RETIRADA' : 'ENTREGA') + '</div>';
  if (av.data !== false && p.criado_em) h += '<div class="c" style="font-size:.85em">' + escHtml(fmtDataFull(p.criado_em)) + '</div>';
  h += sepImp('margin-top:6px');
  h += '<div class="c b" style="font-size:.9em">CLIENTE</div>';
  h += '<div class="c b" style="font-size:1.5em">' + escHtml(p.cliente_nome || '') + '</div>';
  if (av.telefone !== false && p.cliente_telefone) h += '<div class="c b" style="font-size:1.4em">' + escHtml(p.cliente_telefone) + '</div>';
  h += sepImp('margin-top:6px');
  if (p.tipo === 'retirada') {
    h += '<div class="c b" style="font-size:1.5em; margin:8px 0">RETIRADA NO BALCAO</div>';
  } else {
    h += '<div class="c b" style="font-size:.9em">ENDERECO</div>';
    if (e) {
      h += '<div class="c b" style="font-size:1.4em">' + escHtml([e.logradouro, e.numero].filter(Boolean).join(', ')) + '</div>';
      if (av.endereco_completo !== false && e.complemento) h += '<div class="c b" style="font-size:1.15em">Comp: ' + escHtml(e.complemento) + '</div>';
      if (av.endereco_completo !== false && e.referencia) h += '<div class="c" style="font-size:1.1em">Ref: ' + escHtml(e.referencia) + '</div>';
      const bc = [e.bairro, [e.cidade, e.uf].filter(Boolean).join('/')].filter(Boolean).join(' - ');
      if (bc) h += '<div class="c" style="font-size:1.1em">' + escHtml(bc) + '</div>';
      if (av.endereco_completo !== false && e.cep) h += '<div class="c" style="font-size:1.05em">CEP ' + escHtml(e.cep) + '</div>';
    } else { h += '<div class="c b" style="font-size:1.1em">Endereco nao informado</div>'; }
  }
  h += sepImp('margin-top:6px') + '<div class="c b" style="font-size:.9em">ITENS</div>';
  let volumes = 0;
  itens.forEach(it => {
    volumes += Number(it.quantidade) || 0;
    h += '<div class="lin it"><span>' + escHtml(it.quantidade) + 'x ' + escHtml(it.nome) + '</span><span class="v">' + moeda(it.total) + '</span></div>';
    (it.opcoes || []).forEach(op => { h += '<div class="opc">+ ' + (Number(op.quantidade) > 1 ? escHtml(op.quantidade) + 'x ' : '') + escHtml(op.opcao_nome) + (Number(op.preco_extra) > 0 ? ' (+' + moeda(op.preco_extra) + ')' : '') + '</div>'; });
    if (it.observacao) h += '<div class="obs">OBS: ' + escHtml(it.observacao) + '</div>';
  });
  if (av.valores !== false) {
    h += sepImp('margin-top:6px');
    if (p.subtotal !== undefined && p.subtotal !== null) h += '<div class="lin"><span>Subtotal</span><span class="v">' + moeda(p.subtotal) + '</span></div>';
    if (Number(p.taxa_entrega) > 0) h += '<div class="lin"><span>Taxa de entrega</span><span class="v">' + moeda(p.taxa_entrega) + '</span></div>';
    if (Number(p.desconto) > 0) h += '<div class="lin"><span>Desconto</span><span class="v">- ' + moeda(p.desconto) + '</span></div>';
    h += '<div class="lin b" style="font-size:1.3em; margin-top:4px"><span>TOTAL</span><span class="v">' + moeda(p.total) + '</span></div>';
  }
  if (av.volumes !== false) h += '<div class="c" style="font-size:.85em; margin-top:2px">Total de volumes: ' + escHtml(volumes) + '</div>';
  if (av.pagamento !== false) {
    h += sepImp('margin-top:6px') + '<div class="c b" style="font-size:.9em">PAGAMENTO</div>';
    h += '<div class="c">' + escHtml(pagLabel(p.pagamento_metodo)) + ' . ' + escHtml(pagStLabel(p.pagamento_status)) + '</div>';
    (d.pagamentos || []).forEach(pg => {
      if (pg && pg.codigo) h += '<div class="c" style="font-size:.85em">' + escHtml(pg.descricao || pg.tipo || 'Pagamento') + ' . ' + escHtml(pg.codigo) + '</div>';
    });
  }
  if (av.observacoes !== false && p.observacoes) h += sepImp('margin-top:6px') + '<div class="c b" style="font-size:.9em">OBSERVACOES</div><div class="c" style="text-transform:uppercase">' + escHtml(p.observacoes) + '</div>';
  if (av.nao_fiscal !== false) h += sepImp('margin-top:8px') + '<div class="c" style="font-size:.8em">NAO E DOCUMENTO FISCAL</div>';
  if (av.rodape_texto) h += '<div class="c" style="font-size:.85em; margin-top:6px">' + escHtml(av.rodape_texto) + '</div>';
  return { titulo: 'Via entrega - pedido ' + p.numero, corpo: h, fonte: 13 };
}

/*
 * Decide quais vias montar conforme a escolha da loja (espelha viasDoPedido).
 * Vocabulario do sistema: 'cozinha' | 'motoboy' | 'ambas'. A via de entrega
 * vale tambem para retirada (sai como "RETIRADA NO BALCAO").
 */
function montarVias(det, cfg, est, escolha) {
  const esc = escolha || 'cozinha';
  const vias = [];
  if (esc === 'cozinha' || esc === 'ambas') vias.push(viaCozinha(det, cfg, est));
  if (esc === 'motoboy' || esc === 'entrega' || esc === 'ambas') vias.push(viaMotoboy(det, cfg, est));
  return vias;
}

// Monta o documento HTML final pronto para impressao.
function montarDocumento(det, cfg, est, escolha) {
  const vias = montarVias(det, cfg, est, escolha);
  if (!vias.length) return '';
  return documentoVias(vias, cfg);
}

// Pedido de exemplo, igual ao impExemplo do painel, para o botao "Imprimir teste".
const PEDIDO_EXEMPLO = {
  pedido: {
    numero: 1234, tipo: 'delivery', teste: 1, cliente_nome: 'Joao da Silva', cliente_telefone: '(34) 99999-0000',
    criado_em: '2026-09-16 20:14', subtotal: 49.80, taxa_entrega: 8, desconto: 0, total: 57.80,
    pagamento_metodo: 'pix', pagamento_status: 'pago', observacoes: 'Entregar na portaria B',
    endereco: { logradouro: 'Rua das Flores', numero: '123', complemento: 'Apto 2', referencia: 'perto da praca', bairro: 'Centro', cidade: 'Uberlandia', uf: 'MG', cep: '38400-000' },
  },
  itens: [
    { id: 1, nome: 'Pizza Calabresa', quantidade: 2, total: 45.80, categoria: 'Pizzas Salgadas', descricao: 'Molho da casa, mussarela, calabresa e cebola', observacao: 'bem assada', opcoes: [{ opcao_nome: 'Borda catupiry', quantidade: 1, preco_extra: 8 }] },
    { id: 2, nome: 'Refrigerante 2L', quantidade: 1, total: 12.00, categoria: 'Bebidas', descricao: '', observacao: '', opcoes: [] },
  ],
  pagamentos: [{ tipo: 'pix', descricao: 'PIX', codigo: 'E1234ABC', valor: 57.80 }],
};

module.exports = {
  montarDocumento, montarVias, documentoVias, docShell,
  viaCozinha, viaMotoboy, normalizarCfg, IMP_FONTES, IMP_AV_PADRAO, PEDIDO_EXEMPLO,
};
