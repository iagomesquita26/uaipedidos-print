/* ==========================================================
   NUCLEO: impressao  (LEVA 16, modulo 2)
   Extraido verbatim do setup() de painel.php: config de impressao
   (impCfg + fontes + avancado), montadores de via (cozinha/motoboy),
   fila de impressao automatica e trava por PC. Exposto como
   window.criarNucleoImpressao(core): o painel chama esta fabrica de
   dentro do setup, logo depois do bloco de sincronismo entre abas
   (que fica no painel, junto do estabIdAtual), passando as deps por
   core e reespalhando os nomes retornados no proprio escopo. O
   contrato provide('uaiCore') continua com exatamente os mesmos
   nomes. Zero mudanca de comportamento: mesma logica, outro arquivo.
   ========================================================== */
window.criarNucleoImpressao = function (core) {
  const {
    reactive, api, avisar, estab, autoCfg, pedDet, esperarVozComecar,
    moeda, pagLabel, pagStLabel, fmtDataFull, estabIdAtual,
  } = core;

    const IMP_FONTES = {
      sans:   { label: 'Moderna (Segoe UI)', css: "'Segoe UI','Helvetica Neue','DejaVu Sans',Verdana,Arial,sans-serif" },
      arial:  { label: 'Clássica (Arial)',   css: "Arial,'Helvetica Neue',Helvetica,sans-serif" },
      tahoma: { label: 'Estreita (Tahoma)',  css: "Tahoma,'DejaVu Sans Condensed',Verdana,sans-serif" },
      mono:   { label: 'Máquina (Courier)',  css: "'Courier New',Courier,monospace" },
    };
    // Configurações avançadas: os padrões deixam a saída IGUAL à de hoje quando
    // ninguém mexe (nada de logo, nada oculto, densidade padrão, texto vazio).
    // "observacoes" e "data" valem para a via de entrega; a cozinha tem chaves
    // próprias (observacoes_cozinha, data_cozinha) que herdam o valor antigo.
    const IMP_AV_PADRAO = () => ({
      categoria:true, descricao:true, precos_cozinha:false, observacoes:true, data:true,
      telefone:true, endereco_completo:true, valores:true, pagamento:true, volumes:true, nao_fiscal:true,
      contato_loja:false, logo:false, fonte_grande_cozinha:false,
      cabecalho_texto:'', rodape_texto:'', densidade:'padrao', alinhamento:'centro', espaco_fim:0, corte_vias:'manual',
      // As duas vias têm as mesmas opções; o padrão de cada uma é o que faz sentido
      // para ela (a cozinha não precisa de telefone, endereço, valores e pagamento).
      // via da cozinha
      cab_cozinha:true, titulo_cozinha:true, tipo_cozinha:true, agendado_cozinha:true, data_pedido_cozinha:false,
      cliente_cozinha:true, telefone_cozinha:false, localizador_cozinha:false, garcom_cozinha:true,
      endereco_cozinha:false, endereco_completo_cozinha:true, itens_cozinha:true,
      adicionais_cozinha:true, obs_item_cozinha:true, valores_cozinha:false, valores_detalhe_cozinha:true,
      volumes_cozinha:false, pagamento_cozinha:false, troco_cozinha:true, pagamento_detalhe_cozinha:true,
      observacoes_cozinha:true, data_cozinha:true, nao_fiscal_cozinha:false, rodape_cozinha:true,
      // via de entrega
      cab_entrega:true, titulo_entrega:false, tipo_entrega:true, agendado_entrega:true, cliente_entrega:true, localizador:true,
      garcom_entrega:true, endereco:true, itens_entrega:true, valores_detalhe:true, categoria_entrega:false, descricao_entrega:false,
      precos_entrega:true, adicionais_entrega:true, obs_item_entrega:true, troco:true, pagamento_detalhe:true,
      data_impressao_entrega:false, rodape_entrega:true, fonte_grande_entrega:false,
    });
    // Lojas salvas antes da divisão por via: as chaves novas herdam das antigas.
    function herdarAvAntigo(av) {
      const a = Object.assign({}, av);
      if (!('observacoes_cozinha' in a) && 'observacoes' in a) a.observacoes_cozinha = a.observacoes;
      if (!('data_cozinha' in a) && 'data' in a) a.data_cozinha = a.data;
      if (!('localizador' in a) && 'telefone' in a) a.localizador = a.telefone;
      return a;
    }
    // Largura da bobina em mm. Antes só 58 ou 80; agora aceita qualquer largura de
    // 40 a 112 (ex.: 76). Valor ausente ou fora da faixa vira 80, como sempre foi.
    const larguraImp = v => { const n = Math.round(Number(v)); return (n >= 40 && n <= 112) ? n : 80; };
    const impCfg = reactive({ margem_topo:5, margem_baixo:5, margem_esq:5, margem_dir:5, largura:80, fonte:'sans', fonte_tam:13, av: IMP_AV_PADRAO() });
    // Espelha no estado local o que veio da loja (login, troca de loja).
    function sincronizarImpressao() {
      const e = estab.value || {};
      impCfg.margem_topo  = Number(e.imp_margem_topo  ?? 5);
      impCfg.margem_baixo = Number(e.imp_margem_baixo ?? 5);
      impCfg.margem_esq   = Number(e.imp_margem_esq   ?? 5);
      impCfg.margem_dir   = Number(e.imp_margem_dir   ?? 5);
      impCfg.largura      = larguraImp(e.imp_largura ?? 80);
      impCfg.fonte        = ['sans','arial','tahoma','mono'].includes(e.imp_fonte) ? e.imp_fonte : 'sans';
      impCfg.fonte_tam    = Number(e.imp_fonte_tam ?? 13);
      Object.assign(impCfg.av, IMP_AV_PADRAO(), herdarAvAntigo((e.imp_avancado && typeof e.imp_avancado === 'object') ? e.imp_avancado : {}));
    }

    // ---- impressão em bobina 80mm (vias da cozinha e do motoboy) ----
    function escHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); }
    const sepImp = extra => '<div class="sep"' + (extra ? ' style="' + extra + '"' : '') + '></div>';
    function primeiroNome(nome) { return String(nome || '').trim().split(/\s+/)[0] || ''; }
    function agoraTexto() {
      const d = new Date(), pad = n => String(n).padStart(2, '0');
      return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }
    /* comScript=false monta a mesma bobina sem o roteiro de imprimir e fechar:
       é a versão que vai para o iframe da impressão automática, onde quem
       chama o print é o painel, e fechar a janela não faria sentido. */
    function docShell(titulo, inner, fonteBase, comScript) {
      // Preferências da loja (aba Impressão). Sem elas, valem os padrões de sempre.
      const cfgL = larguraImp(impCfg.largura);
      const mm = v => Math.min(50, Math.max(0, Number(v) || 0));
      const mt = mm(impCfg.margem_topo), mb = mm(impCfg.margem_baixo), mEsq = mm(impCfg.margem_esq), mDir = mm(impCfg.margem_dir);
      const fam = (IMP_FONTES[impCfg.fonte] || IMP_FONTES.sans).css;
      const tam = Math.min(20, Math.max(10, Number(impCfg.fonte_tam) || Number(fonteBase) || 13));
      const larguraConteudo = Math.max(120, Math.round((cfgL - mEsq - mDir) * 3.78));
      const av = impCfg.av || {};
      const compacto = av.densidade === 'compacto';
      const lh = compacto ? 1.18 : 1.35;
      const fim = Math.min(40, Math.max(0, Number(av.espaco_fim) || 0));
      /* Espaço do fim = margem inferior + espaço extra, tudo junto num rodapé só.
         Impressoras térmicas com papel de altura automática CORTAM o espaço vazio
         do fim (margem de página ou caixa em branco), e mesmo linhas em branco sem
         tinta acabam aparadas, então nada avança de verdade.
         Solução: emitimos as linhas em branco do espaço do fim e, DEPOIS delas,
         uma linha pontilhada. A tinta da pontilhada obriga a impressora a avançar
         o papel até ali, e as linhas em branco passam a ficar ENTRE o conteúdo e a
         pontilhada (espaço do meio, que a impressora sempre respeita). De quebra,
         a pontilhada vira a guia de onde rasgar o cupom. Por isso a margem inferior
         no @page vai a 0 e todo o espaço do fim vira conteúdo de verdade. */
      const feedMm = mb + fim;
      const alturaLinhaPx = tam * lh;
      const linhasFim = feedMm > 0 ? Math.max(1, Math.round(feedMm * 3.7795 / alturaLinhaPx)) : 0;
      const feedHtml = linhasFim ? '<div class="feedpont">' + ('...' + '<br>').repeat(linhasFim) + '</div>' : '';
      // Mesmo truque no topo: algumas térmicas também ignoram a margem de cima do
      // @page. Então a margem superior vira linhas em branco reais no começo.
      const linhasTopo = mt > 0 ? Math.max(1, Math.round(mt * 3.7795 / alturaLinhaPx)) : 0;
      const topoHtml = linhasTopo ? '<div class="feedpont">' + ('...' + '<br>').repeat(linhasTopo) + '</div>' : '';
      // inner pode ser uma via só (string) ou várias vias (array). Com várias, entre
      // elas sempre entra o rótulo "CORTE AQUI". Com corte_vias 'auto' entram também o
      // avanço de papel, uma QUEBRA DE PÁGINA (gatilho do corte automático quando o
      // driver corta a cada página) e a margem de topo da próxima via. Com 'manual'
      // (padrão) as vias seguem coladas e as margens ficam só nas pontas do papel.
      // Via única: paginas = [inner], o join não faz nada e a saída fica idêntica.
      // corte_vias = 'manual' (padrão): o lojista rasga as vias na mão, então tudo sai
      // num papel só e as margens valem só nas pontas. Entre as vias fica apenas o
      // "CORTE AQUI": no meio do papel a térmica respeita o espaço em branco.
      const paginas = Array.isArray(inner) ? inner : [inner];
      const sepVias = av.corte_vias === 'auto'
        ? '<div class="corte"></div><div class="corte-tx">CORTE AQUI</div>' + feedHtml + '<div class="corte-pg"></div>' + topoHtml
        : '<div class="corte"></div><div class="corte-tx">CORTE AQUI</div>';
      const corpoDoc = topoHtml + paginas.join(sepVias) + feedHtml;
      return '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>' + titulo + '</title><style>' +
        '@page { size: ' + cfgL + 'mm auto; margin: 0; }' +
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
        // Quebra de página entre as vias: é o gatilho do corte automático da
        // impressora (quando o driver está ajustado para cortar a cada página).
        '.corte-pg { break-after: page; page-break-after: always; height:0; }' +
        '.fimcorte { text-align:center; font-size:.8em; letter-spacing:2px; }' +
        '.feedpont { text-align:center; letter-spacing:2px; color:#000; font-weight:bold; }' +
        (compacto ? '.sep{margin:3px 0;} .it{margin:3px 0 0;} .cat{margin:6px 0 2px;} .lin{gap:8px;} .desc{margin:0 0 1px;}' : '') +
        '@media print { .bobina { max-width:100%; padding:0 ' + mDir + 'mm 0 ' + mEsq + 'mm; } }' +
        '</style></head><body>' + corpoDoc +
        (comScript === false ? '' :
          '<scr' + 'ipt>window.onload = function(){ window.__pronto = 1; setTimeout(function(){ window.print(); }, 60); };' +
          'window.onafterprint = function(){ setTimeout(function(){ window.close(); }, 250); };</scr' + 'ipt>') +
        '</body></html>';
    }
    // Uma via só: o papel de sempre.
    function docImpressao(titulo, corpo, fonteBase, comScript) {
      return docShell(titulo, '<div class="bobina">' + corpo + '</div>', fonteBase, comScript);
    }
    /* Várias vias no MESMO papel, uma embaixo da outra, com um "CORTE AQUI"
       pontilhado entre elas: é assim que cozinha + entrega saem numa impressão
       só, e não em dois trabalhos separados. */
    function docImpressaoVias(vias, comScript) {
      // Cada via vira um bloco próprio; o docShell decide o que entra entre elas
      // conforme corte_vias (só "CORTE AQUI", ou também avanço + quebra de página).
      const paginas = vias.map(v => '<div class="bobina">' + v.corpo + '</div>');
      return docShell((vias[0] && vias[0].titulo) || 'Pedido', paginas, (vias[0] && vias[0].fonte) || 13, comScript);
    }
    // Abre a janela de impressão com uma ou mais vias já montadas (papel único).
    function abrirImpressaoVias(vias) {
      const lista = (Array.isArray(vias) ? vias : [vias]).filter(Boolean);
      if (!lista.length) return;
      const w = window.open('', '_blank', 'width=420,height=640');
      if (!w) { avisar('O navegador bloqueou a janela de impressão. Libere os pop-ups deste site.', 'erro'); return; }
      w.document.write(docImpressaoVias(lista, true));
      w.document.close();
      w.focus();
      // fallback: se o onload da janela não disparar o print em 900ms, força
      setTimeout(() => { try { if (w && !w.closed && !w.__pronto) w.print(); } catch (e) {} }, 900);
    }
    /* viaCozinha e viaMotoboy só montam o papel a partir de um pedido já
       carregado ({ pedido, itens }). Quem manda para a impressora é outro:
       o clique do lojista abre uma janela, a impressão automática usa um
       iframe escondido. A bobina é exatamente a mesma nos dois caminhos. */
    // Cabeçalho comum das duas vias: logo, nome da loja, texto livre e contato,
    // tudo conforme as configurações avançadas. O alinhamento vale só aqui.
    function cabecalhoImp(nomeTam) {
      const av = impCfg.av || {}, est = estab.value || {};
      const al = av.alinhamento === 'esquerda' ? 'left' : 'center';
      const tn = nomeTam || '1.2em';   // cada via mantém o tamanho do nome que já tinha
      let h = '';
      if (av.logo && est.logo_url) h += '<div style="text-align:' + al + ';margin-bottom:4px"><img src="' + escHtml(est.logo_url) + '" style="max-width:70%;max-height:90px"></div>';
      h += '<div class="b" style="text-align:' + al + ';font-size:' + tn + '">' + escHtml((est.nome || 'Loja').toUpperCase()) + '</div>';
      if (av.cabecalho_texto) h += '<div style="text-align:' + al + ';font-size:.85em">' + escHtml(av.cabecalho_texto) + '</div>';
      if (av.contato_loja) {
        const linhas = [];
        if (est.endereco) linhas.push(est.endereco);
        const tel = est.whatsapp || est.telefone;
        if (tel) linhas.push('WhatsApp ' + tel);
        if (est.instagram) linhas.push('@' + String(est.instagram).replace(/^@+/, ''));
        linhas.forEach(l => h += '<div style="text-align:' + al + ';font-size:.8em">' + escHtml(l) + '</div>');
      }
      return h;
    }
    // Tipo do pedido no papel: pedido de mesa sai "MESA 5" (antes saia "ENTREGA").
    function tipoImp(p) {
      if (p.tipo === 'mesa') return escHtml(('MESA ' + (p.mesa_numero || '')).trim());
      return p.tipo === 'retirada' ? 'RETIRADA' : 'ENTREGA';
    }
    /* Blocos iguais nas duas vias: endereço, valores, pagamento, rodapé fiscal e
       hora da impressão. Cada via decide se mostra pela própria chave. */
    function blocoEndereco(e, completo) {
      let h = '<div class="c b" style="font-size:.9em">ENDERECO</div>';
      if (!e) return h + '<div class="c b" style="font-size:1.1em">Endereco nao informado</div>';
      h += '<div class="c b" style="font-size:1.4em">' + escHtml([e.logradouro, e.numero].filter(Boolean).join(', ')) + '</div>';
      if (completo && e.complemento) h += '<div class="c b" style="font-size:1.15em">Comp: ' + escHtml(e.complemento) + '</div>';
      if (completo && e.referencia) h += '<div class="c" style="font-size:1.1em">Ref: ' + escHtml(e.referencia) + '</div>';
      const bc = [e.bairro, [e.cidade, e.uf].filter(Boolean).join('/')].filter(Boolean).join(' - ');
      if (bc) h += '<div class="c" style="font-size:1.1em">' + escHtml(bc) + '</div>';
      if (completo && e.cep) h += '<div class="c" style="font-size:1.05em">CEP ' + escHtml(e.cep) + '</div>';
      return h;
    }
    function blocoValores(p, detalhe) {
      let h = sepImp('margin-top:6px');
      if (detalhe) {
        if (p.subtotal !== undefined && p.subtotal !== null) h += '<div class="lin"><span>Subtotal</span><span class="v">' + moeda(p.subtotal) + '</span></div>';
        if (Number(p.taxa_entrega) > 0) h += '<div class="lin"><span>Taxa de entrega</span><span class="v">' + moeda(p.taxa_entrega) + '</span></div>';
        if (Number(p.desconto) > 0) h += '<div class="lin"><span>Desconto</span><span class="v">- ' + moeda(p.desconto) + '</span></div>';
        if (Number(p.taxa_servico) > 0) h += '<div class="lin"><span>Serviço</span><span class="v">' + moeda(p.taxa_servico) + '</span></div>';
      }
      return h + '<div class="lin b" style="font-size:1.3em; margin-top:4px"><span>TOTAL</span><span class="v">' + moeda(p.total) + '</span></div>';
    }
    function blocoPagamento(d, p, comTroco, comDetalhe) {
      let h = sepImp('margin-top:6px') + '<div class="c b" style="font-size:.9em">PAGAMENTO</div>';
      h += '<div class="c">' + escHtml(pagLabel(p.pagamento_metodo)) + ' . ' + escHtml(pagStLabel(p.pagamento_status)) + '</div>';
      // Troco do UaiRango (pedido em dinheiro): bloco claro para o lojista na hora de
      // cobrar e dar o troco. Os numeros vem prontos de uairango_extra (troco_para = nota
      // que o cliente vai dar, troco_cobrar = quanto cobrar, troco = o que levar de volta).
      // Sem UaiRango, vale o troco digitado no balcao (pedidos.troco_para): cobra o
      // total e devolve a diferenca. So entra quando ha troco de fato (nota > total) e o
      // pedido ainda e em dinheiro (editar para Pix/cartao nao limpa o troco_para).
      const uai = p.uairango || {};
      const trocoBalcao = !(Number(uai.troco_para) > 0) && String(p.pagamento_metodo || '').toLowerCase() === 'dinheiro'
        && Number(p.troco_para) > Number(p.total);
      const temTroco = Number(uai.troco_para) > 0 || trocoBalcao;
      if (temTroco && comTroco) {
        const tCobrar = (!trocoBalcao && uai.troco_cobrar != null) ? Number(uai.troco_cobrar) : Number(p.total);
        const tPara   = trocoBalcao ? Number(p.troco_para) : Number(uai.troco_para);
        const tLevar  = (!trocoBalcao && uai.troco != null) ? Number(uai.troco) : Math.max(0, tPara - tCobrar);
        h += '<div class="c b" style="font-size:.95em; margin-top:3px">COBRAR DO CLIENTE: ' + moeda(tCobrar) + '</div>';
        h += '<div class="c">Troco para ' + moeda(tPara) + '</div>';
        h += '<div class="c b" style="font-size:1.1em">Troco do cliente: ' + moeda(tLevar) + '</div>';
      }
      // Linha extra com o detalhe do pagamento: codigo/comprovante do Pix, bandeira do
      // cartao e demais observacoes da descricao. Imprime o mesmo texto que o detalhe
      // mostra na tela; pula quando a descricao so repetiria o metodo da linha de cima,
      // ou quando e a linha do dinheiro que ja virou o bloco de troco acima.
      if (comDetalhe) (d.pagamentos || []).forEach(pg => {
        if (!pg) return;
        if (!pg.codigo && temTroco && comTroco && String(pg.tipo || '').toLowerCase() === 'dinheiro') return;
        const temDet = pg.descricao && String(pg.descricao).toLowerCase() !== String(pg.tipo || '').toLowerCase();
        if (!pg.codigo && !temDet) return;
        let linha = String(pg.descricao || pg.tipo || 'Pagamento');
        if (pg.codigo) linha += ' . ' + pg.codigo;
        h += '<div class="c" style="font-size:.85em">' + escHtml(linha) + '</div>';
      });
      return h;
    }
    const linhaVolumes = itens => '<div class="c" style="font-size:.85em; margin-top:2px">Total de volumes: ' + escHtml(itens.reduce((s, it) => s + (Number(it.quantidade) || 0), 0)) + '</div>';
    const linhaImpresso = () => sepImp('margin-top:8px') + '<div class="c" style="font-size:.8em">Impresso em ' + escHtml(agoraTexto()) + '</div>';
    const linhaNaoFiscal = () => sepImp('margin-top:8px') + '<div class="c" style="font-size:.8em">NAO E DOCUMENTO FISCAL</div>';
    const linhaRodape = av => '<div class="c" style="font-size:.85em; margin-top:6px">' + escHtml(av.rodape_texto) + '</div>';
    const ligado = v => v !== false;
    function viaCozinha(d) {
      const p = d.pedido, itens = d.itens || [], e = p.endereco || null, av = impCfg.av || {};
      const fItem = av.fonte_grande_cozinha ? '1.45em' : '1.15em';
      let h = '';
      if (Number(p.teste)) h += '<div class="c b" style="font-size:1.15em">*** PEDIDO DE TESTE ***</div>' + sepImp();
      if (ligado(av.cab_cozinha)) h += cabecalhoImp();
      if (ligado(av.titulo_cozinha)) h += '<div class="c b">COZINHA</div>' + sepImp();
      h += '<div class="c b" style="font-size:1.9em; margin:4px 0">PEDIDO Nº ' + escHtml(p.numero) + '</div>';
      // Pedido de mesa sempre mostra a mesa: sem ela a cozinha não sabe para onde vai.
      if (ligado(av.tipo_cozinha) || p.tipo === 'mesa') h += '<div class="c b">' + tipoImp(p) + '</div>';
      if (ligado(av.agendado_cozinha) && p.agendado_para) h += '<div class="c b" style="font-size:1.25em; margin:2px 0">AGENDADO: ' + escHtml(fmtDataFull(p.agendado_para)) + '</div>';
      if (av.data_pedido_cozinha && p.criado_em) h += '<div class="c" style="font-size:.85em">' + escHtml(fmtDataFull(p.criado_em)) + '</div>';
      if (ligado(av.cliente_cozinha)) h += '<div class="c">Cliente: ' + escHtml(primeiroNome(p.cliente_nome)) + '</div>';
      if (av.telefone_cozinha && p.cliente_telefone) h += '<div class="c">Telefone: ' + escHtml(p.cliente_telefone) + '</div>';
      if (av.localizador_cozinha && p.uairango && p.uairango.localizer) h += '<div class="c">Localizador: ' + escHtml(p.uairango.localizer) + '</div>';
      if (ligado(av.garcom_cozinha) && p.garcom_nome) h += '<div class="c">Garçom: ' + escHtml(p.garcom_nome) + '</div>';
      // Na cozinha o endereço só faz sentido no pedido de entrega (mesa e retirada já
      // aparecem no tipo do pedido).
      if (av.endereco_cozinha && p.tipo !== 'mesa' && p.tipo !== 'retirada') h += sepImp('margin-top:6px') + blocoEndereco(e, ligado(av.endereco_completo_cozinha));
      if (ligado(av.itens_cozinha)) h += sepImp('margin-top:4px');
      let catAtual = null;
      if (ligado(av.itens_cozinha)) itens.forEach(it => {
        if (ligado(av.categoria)) { const cat = String(it.categoria || '').trim(); if (cat && cat !== catAtual) { h += '<div class="cat">' + escHtml(cat) + '</div>'; catAtual = cat; } }
        if (av.precos_cozinha) h += '<div class="lin it b" style="font-size:' + fItem + '"><span>' + escHtml(it.quantidade) + 'x ' + escHtml(it.nome) + '</span><span class="v">' + moeda(it.total) + '</span></div>';
        else h += '<div class="it b" style="font-size:' + fItem + '">' + escHtml(it.quantidade) + 'x ' + escHtml(it.nome) + '</div>';
        if (ligado(av.descricao) && it.descricao) h += '<div class="desc">' + escHtml(String(it.descricao).trim().slice(0, 400)) + '</div>';
        if (ligado(av.adicionais_cozinha)) (it.opcoes || []).forEach(op => { h += '<div class="opc">+ ' + (Number(op.quantidade) > 1 ? escHtml(op.quantidade) + 'x ' : '') + escHtml(op.opcao_nome) + '</div>'; });
        if (ligado(av.obs_item_cozinha) && it.observacao) h += '<div class="obs">OBS: ' + escHtml(it.observacao) + '</div>';
      });
      if (av.valores_cozinha) h += blocoValores(p, ligado(av.valores_detalhe_cozinha));
      if (av.volumes_cozinha) h += linhaVolumes(itens);
      if (av.pagamento_cozinha) h += blocoPagamento(d, p, ligado(av.troco_cozinha), ligado(av.pagamento_detalhe_cozinha));
      if (ligado(av.observacoes_cozinha) && p.observacoes) { h += sepImp('margin-top:8px') + '<div class="c b">OBSERVACOES DO PEDIDO</div><div class="c" style="text-transform:uppercase">' + escHtml(p.observacoes) + '</div>'; }
      if (ligado(av.data_cozinha)) h += linhaImpresso();
      if (av.nao_fiscal_cozinha) h += linhaNaoFiscal();
      if (ligado(av.rodape_cozinha) && av.rodape_texto) h += linhaRodape(av);
      return { titulo: 'Via cozinha - pedido ' + escHtml(p.numero), corpo: h, fonte: 13 };
    }
    function viaMotoboy(d) {
      const p = d.pedido, itens = d.itens || [], e = p.endereco || null, av = impCfg.av || {};
      let h = '';
      if (Number(p.teste)) h += '<div class="c b" style="font-size:1.3em">*** PEDIDO DE TESTE ***</div>' + sepImp();
      if (ligado(av.cab_entrega)) h += cabecalhoImp('1.1em');
      if (av.titulo_entrega) h += '<div class="c b">VIA DO CLIENTE</div>' + sepImp();
      h += '<div class="c b" style="font-size:1.9em; margin:4px 0">PEDIDO Nº ' + escHtml(p.numero) + '</div>';
      if (ligado(av.tipo_entrega)) h += '<div class="c b">' + tipoImp(p) + '</div>';
      if (ligado(av.agendado_entrega) && p.agendado_para) h += '<div class="c b" style="font-size:1.25em; margin:2px 0">AGENDADO: ' + escHtml(fmtDataFull(p.agendado_para)) + '</div>';
      if (ligado(av.data) && p.criado_em) h += '<div class="c" style="font-size:.85em">' + escHtml(fmtDataFull(p.criado_em)) + '</div>';
      const temTel = ligado(av.telefone) && p.cliente_telefone;
      // Pedido do UaiRango: o telefone vem mascarado, entao imprime o localizador para completar a ligacao.
      const temLoc = ligado(av.localizador) && p.uairango && p.uairango.localizer;
      const temGarcom = ligado(av.garcom_entrega) && p.garcom_nome;
      if (ligado(av.cliente_entrega) || temTel || temLoc || temGarcom) {
        h += sepImp('margin-top:6px');
        if (ligado(av.cliente_entrega)) {
          h += '<div class="c b" style="font-size:.9em">CLIENTE</div>';
          h += '<div class="c b" style="font-size:1.5em">' + escHtml(p.cliente_nome || '') + '</div>';
        }
        if (temTel) h += '<div class="c b" style="font-size:1.4em">' + escHtml(p.cliente_telefone) + '</div>';
        if (temLoc) h += '<div class="c" style="font-size:1.05em">Localizador: ' + escHtml(p.uairango.localizer) + '</div>';
        if (temGarcom) h += '<div class="c" style="font-size:1.05em">Garçom: ' + escHtml(p.garcom_nome) + '</div>';
      }
      if (p.tipo === 'mesa') {
        h += sepImp('margin-top:6px');
        h += '<div class="c b" style="font-size:1.5em; margin:8px 0">' + tipoImp(p) + '</div>';
      } else if (p.tipo === 'retirada') {
        h += sepImp('margin-top:6px');
        h += '<div class="c b" style="font-size:1.5em; margin:8px 0">RETIRADA NO BALCAO</div>';
      } else if (ligado(av.endereco)) {
        h += sepImp('margin-top:6px') + blocoEndereco(e, ligado(av.endereco_completo));
      }
      if (ligado(av.itens_entrega)) {
        const comPreco = ligado(av.precos_entrega);
        const fIt = av.fonte_grande_entrega ? ' style="font-size:1.25em"' : '';
        h += sepImp('margin-top:6px') + '<div class="c b" style="font-size:.9em">ITENS</div>';
        let catAtual = null;
        itens.forEach(it => {
          if (av.categoria_entrega) { const cat = String(it.categoria || '').trim(); if (cat && cat !== catAtual) { h += '<div class="cat">' + escHtml(cat) + '</div>'; catAtual = cat; } }
          if (comPreco) h += '<div class="lin it"' + fIt + '><span>' + escHtml(it.quantidade) + 'x ' + escHtml(it.nome) + '</span><span class="v">' + moeda(it.total) + '</span></div>';
          else h += '<div class="it"' + fIt + '>' + escHtml(it.quantidade) + 'x ' + escHtml(it.nome) + '</div>';
          if (av.descricao_entrega && it.descricao) h += '<div class="desc">' + escHtml(String(it.descricao).trim().slice(0, 400)) + '</div>';
          if (ligado(av.adicionais_entrega)) (it.opcoes || []).forEach(op => { h += '<div class="opc">+ ' + (Number(op.quantidade) > 1 ? escHtml(op.quantidade) + 'x ' : '') + escHtml(op.opcao_nome) + (comPreco && Number(op.preco_extra) > 0 ? ' (+' + moeda(op.preco_extra) + ')' : '') + '</div>'; });
          if (ligado(av.obs_item_entrega) && it.observacao) h += '<div class="obs">OBS: ' + escHtml(it.observacao) + '</div>';
        });
      }
      if (ligado(av.valores)) h += blocoValores(p, ligado(av.valores_detalhe));
      if (ligado(av.volumes)) h += linhaVolumes(itens);
      if (ligado(av.pagamento)) h += blocoPagamento(d, p, ligado(av.troco), ligado(av.pagamento_detalhe));
      if (ligado(av.observacoes) && p.observacoes) h += sepImp('margin-top:6px') + '<div class="c b" style="font-size:.9em">OBSERVACOES</div><div class="c" style="text-transform:uppercase">' + escHtml(p.observacoes) + '</div>';
      if (av.data_impressao_entrega) h += linhaImpresso();
      if (ligado(av.nao_fiscal)) h += linhaNaoFiscal();
      if (ligado(av.rodape_entrega) && av.rodape_texto) h += linhaRodape(av);
      return { titulo: 'Via entrega - pedido ' + escHtml(p.numero), corpo: h, fonte: 13 };
    }
    /* Página de teste / calibração do assistente de configuração.
       Não depende de nenhum pedido: monta um papel que serve de "régua" para o
       lojista conferir, a olho, se a impressão está saindo certa com a largura e
       as margens que ele escolheu. Imprime, de cima para baixo:
         - uma barra preta de borda a borda (mostra se o papel corta nas laterais);
         - uma régua em centímetros de verdade (unidades cm, que a impressão respeita);
         - três marcas de alinhamento (esquerda / centro / direita);
         - um trecho de texto no tamanho de fonte configurado;
         - um resumo do que está valendo (papel, margens, fonte).
       Usa o mesmo docShell das vias, então herda @page, margens-virando-linhas e
       o avanço/corte do fim exatamente como um pedido real sairia. */
    function viaCalibracao() {
      const cfgL = larguraImp(impCfg.largura);
      const mm = v => Math.min(50, Math.max(0, Number(v) || 0));
      const mEsq = mm(impCfg.margem_esq), mDir = mm(impCfg.margem_dir);
      const mt = mm(impCfg.margem_topo), mb = mm(impCfg.margem_baixo);
      const fam = (IMP_FONTES[impCfg.fonte] || IMP_FONTES.sans);
      const tam = Math.min(20, Math.max(10, Number(impCfg.fonte_tam) || 13));
      const larguraMm = Math.max(10, cfgL - mEsq - mDir);
      const cmInteiros = Math.max(1, Math.floor(larguraMm / 10));
      let regua = '<div style="white-space:nowrap;overflow:hidden;border-top:1px solid #000;margin:2px 0">';
      for (let i = 0; i < cmInteiros; i++) {
        regua += '<span style="display:inline-block;width:1cm;height:12px;border-left:2px solid #000;font-size:8px;line-height:12px;padding-left:1px;box-sizing:border-box">' + (i + 1) + '</span>';
      }
      regua += '</div>';
      let h = '';
      h += '<div class="c b" style="font-size:1.2em">PAGINA DE TESTE</div>';
      h += '<div class="c" style="font-size:.8em">' + escHtml((estab.value && estab.value.nome) || 'Sua loja') + '</div>';
      h += sepImp('margin-top:4px');
      // Barra de borda a borda: se as pontas somem, o papel esta cortando as laterais.
      h += '<div class="c" style="font-size:.78em;margin-bottom:2px">A barra abaixo deve ir de ponta a ponta</div>';
      h += '<div style="height:10px;background:#000;width:100%"></div>';
      h += '<div class="lin" style="font-size:.72em;margin-top:1px"><span>|&lt; esquerda</span><span class="v">direita &gt;|</span></div>';
      // Regua em centimetros reais.
      h += sepImp('margin-top:8px') + '<div class="c" style="font-size:.78em;margin-bottom:2px">Regua (cada numero = 1 cm)</div>' + regua;
      h += '<div class="c" style="font-size:.72em">Com uma regua de verdade, confira se os numeros batem com os centimetros</div>';
      // Alinhamento.
      h += sepImp('margin-top:8px') + '<div class="c" style="font-size:.78em;margin-bottom:2px">Alinhamento</div>';
      h += '<div style="text-align:left" class="b">ESQUERDA</div>';
      h += '<div style="text-align:center" class="b">CENTRO</div>';
      h += '<div style="text-align:right" class="b">DIREITA</div>';
      // Amostra de texto na fonte/tamanho escolhidos.
      h += sepImp('margin-top:8px') + '<div class="c" style="font-size:.78em;margin-bottom:2px">Amostra de texto</div>';
      h += '<div>1x X-Salada Especial ........ R$ 29,90</div>';
      h += '<div class="b" style="font-size:1.4em">PEDIDO Nº 123</div>';
      h += '<div style="font-size:.85em">abcdefghij ABCDEFGHIJ 0123456789</div>';
      // Resumo do que esta valendo.
      h += sepImp('margin-top:8px') + '<div class="c" style="font-size:.78em">Papel ' + cfgL + 'mm . Margens ' + mt + '/' + mb + '/' + mEsq + '/' + mDir + 'mm</div>';
      h += '<div class="c" style="font-size:.78em">Fonte ' + escHtml(fam.label) + ' . Tamanho ' + tam + '</div>';
      h += sepImp('margin-top:8px') + '<div class="c b" style="font-size:.85em">FIM DA PAGINA DE TESTE</div>';
      return { titulo: 'Pagina de teste de impressao', corpo: h, fonte: tam };
    }
    // Atalho do assistente: abre a janela de impressão só com a página de teste.
    function imprimirCalibracao() {
      abrirImpressaoVias([viaCalibracao()]);
    }

    // Os botões do detalhe do pedido: monta a(s) via(s) e abre a janela de impressão.
    // "As duas" imprime cozinha e entrega juntas, num papel só (com corte no meio).
    function imprimirCozinha() {
      const d = pedDet.value; if (!d || !d.pedido) return;
      abrirImpressaoVias([viaCozinha(d)]);
    }
    function imprimirMotoboy() {
      const d = pedDet.value; if (!d || !d.pedido) return;
      abrirImpressaoVias([viaMotoboy(d)]);
    }
    function imprimirAmbas() {
      const d = pedDet.value; if (!d || !d.pedido) return;
      abrirImpressaoVias([viaCozinha(d), viaMotoboy(d)]);
    }

    /* ---- impressão automática ----
       Dispara quando o pedido passa a ACEITO, venha o aceite de onde vier:
       do aceite automático do servidor, do botão do popup, do "Avançar" ou
       de arrastar o card no quadro. Três cuidados que fazem isso funcionar:

       1. Iframe escondido, e não janela nova. Aqui quem manda imprimir é o
          pedido chegando, não um clique, e o bloqueador de pop-up do
          navegador barraria a janela sem nem avisar o lojista.
       2. Fila de um pedido por vez. A caixa de impressão do navegador trava a
          página enquanto está aberta, então dois pedidos juntos atropelariam um
          ao outro. As vias de um mesmo pedido saem juntas, num papel só.
       3. Trava no servidor. Se a loja tem o painel aberto no caixa e na
          cozinha, os dois enxergam o mesmo pedido novo. O primeiro que
          carimbar `impresso_em` imprime, o outro fica quieto. */
    const impFila = [];
    let impOcupado = false;

    /* Trava de impressão POR PC (antes era global: só 1 PC imprimia).
       Cada navegador guarda os pedidos que já mandou imprimir; assim cada PC imprime
       o seu, mas 2 abas no mesmo PC imprimem só uma vez. O Web Locks serializa as abas
       do mesmo navegador para não haver corrida. A trava global do servidor
       (marcar_impresso) fica intacta e continua servindo ao programa UaiPedidos Print. */
    function _impKey() { return 'uaiimp_done_' + estabIdAtual(); }
    function jaImprimiuNestePc(id) {
      try { const m = JSON.parse(localStorage.getItem(_impKey()) || '{}'); return !!m[id]; }
      catch (e) { return false; }
    }
    function marcarImprimiuNestePc(id) {
      try {
        const k = _impKey(); const m = JSON.parse(localStorage.getItem(k) || '{}');
        m[id] = Date.now();
        const lim = Date.now() - 2 * 24 * 3600 * 1000;   // não deixa o registro crescer sem fim
        for (const key in m) if (m[key] < lim) delete m[key];
        localStorage.setItem(k, JSON.stringify(m));
      } catch (e) {}
    }
    // Reserva a impressão deste pedido neste PC. Retorna true só para a primeira aba
    // do navegador que chegar; as demais (e re-detecções) recebem false.
    async function reservarImpressaoLocal(id) {
      const reservar = () => {
        if (jaImprimiuNestePc(id)) return false;
        marcarImprimiuNestePc(id);
        return true;
      };
      try {
        if (navigator.locks && navigator.locks.request) {
          return await navigator.locks.request('uaiimp_' + estabIdAtual() + '_' + id, reservar);
        }
      } catch (e) {}
      return reservar();
    }

    function imprimirNoIframe(vias) {
      const lista = (Array.isArray(vias) ? vias : [vias]).filter(Boolean);
      return new Promise(resolve => {
        if (!lista.length) { resolve(); return; }
        const ifr = document.createElement('iframe');
        ifr.setAttribute('aria-hidden', 'true');
        ifr.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
        document.body.appendChild(ifr);
        let encerrado = false;
        const encerrar = () => {
          if (encerrado) return;
          encerrado = true;
          setTimeout(() => { try { ifr.remove(); } catch (e) {} resolve(); }, 1200);
        };
        try {
          const doc = ifr.contentDocument || ifr.contentWindow.document;
          doc.open();
          doc.write(docImpressaoVias(lista, false));
          doc.close();
        } catch (e) { encerrar(); return; }
        // Se a loja ativou o logo, o papel tem imagem: espera carregar antes de
        // imprimir (com um teto de 3s), senão sairia sem o logo. Sem imagem, segue
        // como antes, só um respiro para o layout assentar.
        const disparar = () => { try { ifr.contentWindow.focus(); ifr.contentWindow.print(); } catch (e) {} encerrar(); };
        let doc2 = null; try { doc2 = ifr.contentDocument || ifr.contentWindow.document; } catch (e) {}
        const imgs = doc2 ? Array.from(doc2.images || []).filter(im => !im.complete) : [];
        if (imgs.length) {
          let restam = imgs.length, feito = false;
          const pronto = () => { if (feito) return; feito = true; setTimeout(disparar, 60); };
          imgs.forEach(im => { im.onload = im.onerror = () => { if (--restam <= 0) pronto(); }; });
          setTimeout(pronto, 3000);
        } else {
          setTimeout(disparar, 250);
        }
        // Rede de segurança: nada pode deixar a fila presa para sempre.
        setTimeout(encerrar, 15000);
      });
    }

    // Quais vias este pedido gera, conforme a escolha da loja. A via de entrega
    // vale também para retirada (sai como "RETIRADA NO BALCAO"), então "as duas
    // vias" sempre rende os dois papéis, seja entrega ou retirada.
    function viasDoPedido(det) {
      const escolha = autoCfg.impressao_vias || 'cozinha';
      const vias = [];
      if (escolha === 'cozinha' || escolha === 'ambas') vias.push(viaCozinha(det));
      if (escolha === 'motoboy' || escolha === 'ambas') vias.push(viaMotoboy(det));
      return vias;
    }

    async function processarFilaImp() {
      // (coerencia) O programa UaiPedidos Print esta assumindo a impressao: o
      // navegador recua e descarta a fila, para o mesmo pedido nao sair em dobro
      // (uma via pelo programa, outra pelo navegador). Volta a imprimir sozinho
      // se o programa cair (programaOnline volta a false no proximo status).
      if (autoCfg.programaOnline) { impFila.length = 0; return; }
      if (impOcupado) return;
      // (A1-15) Com a aba escondida o print() do navegador nao roda; segura a fila (sem
      // carimbar impresso_em) e imprime quando a aba voltar (ver aoVoltarAba).
      if (document.hidden) return;
      const det = impFila.shift();
      if (!det) return;
      impOcupado = true;
      try {
        const vias = viasDoPedido(det);
        if (vias.length) {
          // (A1-15) Se ja foi carimbado numa tentativa anterior (a aba escondeu no meio),
          // nao carimba de novo, so imprime.
          let imprimir = det._impresso === true;
          if (!imprimir) {
            // Trava local por PC: cada computador imprime uma vez; 2 abas no mesmo PC
            // imprimem só uma vez. Outros PCs imprimem o seu normalmente.
            imprimir = await reservarImpressaoLocal(det.pedido.id);
          }
          if (imprimir) {
            if (document.hidden) {
              // (A1-15) A aba escondeu entre carimbar e imprimir: guarda para imprimir ao
              // voltar, sem carimbar de novo, para a via nao se perder.
              det._impresso = true;
              impFila.unshift(det);
            } else {
              // Aviso visível: o navegador não confirma se a bobina imprimiu de fato,
              // então mostramos que a impressão foi disparada. Se nada sair, o lojista
              // percebe e reimprime pelo botão no detalhe do pedido. (auditoria 2026-09-15)
              avisar('Imprimindo o pedido #' + (det.pedido.numero || det.pedido.id) + '...', 'info');
              // Espera a voz começar a tocar antes de abrir o diálogo de impressão (que
              // congela a página). Assim a fala não fica "presa" esperando a impressão; a
              // voz toca por cima do diálogo. Teto de 2,5s para a impressão nunca travar.
              await esperarVozComecar(2500);
              // As vias do pedido (cozinha + entrega) vão juntas, num papel só.
              await imprimirNoIframe(vias);
            }
          }
        }
      } catch (e) {
        avisar('Não consegui enviar o pedido #' + (det.pedido.numero || det.pedido.id) + ' para a impressora. Abra o pedido e use o botão de imprimir.', 'erro');
      }
      impOcupado = false;
      if (impFila.length && !document.hidden) processarFilaImp();
    }

    /* Único ponto de entrada da impressão automática. Recebe o id do pedido e,
       quando já tem o detalhe carregado na mão, aproveita em vez de buscar de novo. */
    async function imprimirSeAutomatico(id, det) {
      // Recua quando o programa UaiPedidos Print esta assumindo (programaOnline),
      // para nao imprimir em dobro.
      if (!autoCfg.impressao_automatica || autoCfg.programaOnline || !id) return;
      if (impFila.some(d => Number(d.pedido.id) === Number(id))) return;
      let d = det && det.pedido && Number(det.pedido.id) === Number(id) ? det : null;
      if (!d) {
        try {
          const j = await api('/api/estab/pedidos?id=' + id);
          if (j && j.pedido) d = { pedido:j.pedido, itens:j.itens || [], pagamentos:j.pagamentos || [] };
        } catch (e) { return; }
      }
      if (!d) return;
      impFila.push(d);
      processarFilaImp();
    }

  return {
    impCfg, IMP_FONTES, IMP_AV_PADRAO, sincronizarImpressao, larguraImp, herdarAvAntigo, docImpressaoVias,
    viaCozinha, viaMotoboy, viaCalibracao, imprimirCalibracao, abrirImpressaoVias,
    imprimirCozinha, imprimirMotoboy, imprimirAmbas,
    imprimirSeAutomatico, processarFilaImp, viasDoPedido, imprimirNoIframe,
  };
};
