'use strict';
/* Comportamento da tela de configuração. Fala com o programa pela ponte "uai". */
const $ = id => document.getElementById(id);
let pausadoAtual = false;
let atualizandoAgora = false; // trava o texto do banner enquanto a atualizacao roda

function fmtHora(ts) {
  const d = new Date(ts), p = n => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function addLog(item) {
  const log = $('log');
  if (!log) return;
  const linha = document.createElement('div');
  linha.className = 'l';
  linha.innerHTML = '<span class="t">' + fmtHora(item.ts) + '</span> ' +
    '<span class="' + (item.nivel || 'info') + '">' + escapar(item.msg) + '</span>';
  log.appendChild(linha);
  log.scrollTop = log.scrollHeight;
}
function escapar(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function aviso(el, tipo, msg) {
  el.className = 'aviso ' + tipo;
  el.textContent = msg;
  if (tipo === 'ok') setTimeout(() => { el.className = 'aviso'; }, 4000);
}

function aplicarStatus(st) {
  const pill = $('statusPill');
  // "pausado" aqui e a pausa local do lojista. Bloqueio e pausa remota vem a parte.
  pausadoAtual = !!st.pausado;
  if (st.bloqueado) { pill.className = 'pill off'; pill.textContent = 'Bloqueado pelo suporte'; }
  else if (st.pausadoRemoto) { pill.className = 'pill pause'; pill.textContent = 'Pausado pelo painel'; }
  else if (st.pausado) { pill.className = 'pill pause'; pill.textContent = 'Pausado'; }
  else if (st.conectado) { pill.className = 'pill on'; pill.textContent = st.fila > 0 ? ('Imprimindo (' + st.fila + ')') : 'Ativo'; }
  else if (st.precisaLogin) { pill.className = 'pill off'; pill.textContent = 'Senha mudou, entre de novo'; }
  else { pill.className = 'pill off'; pill.textContent = 'Desconectado'; }
  if (st.loja) $('lojaNome').textContent = st.loja;
  $('btnPausa').textContent = st.pausado ? 'Retomar' : 'Pausar';
  // Sob bloqueio ou pausa remota do painel, o lojista nao controla a pausa por aqui
  // (evita a confusao de "pausar" algo que o painel ja parou).
  $('btnPausa').disabled = !!st.bloqueado || !!st.pausadoRemoto;

  // Banner de versao nova disponivel. So aparece quando ha atualizacao; o lojista
  // clica em "Atualizar agora" quando quiser (nunca atualiza sozinho).
  const banner = $('avisoVersao');
  if (banner) {
    const txt = $('avisoVersaoTxt');
    if (st.atualizar && st.versaoRecomendada) {
      banner.style.display = 'block';
      if (txt && !atualizandoAgora) txt.textContent = 'Nova versão disponível (' + st.versaoRecomendada + '). Clique em Atualizar agora quando puder.';
    } else {
      banner.style.display = 'none';
    }
  }
}

function mostrarConectado(conectado, loja) {
  $('blocoConectado').style.display = conectado ? 'block' : 'none';
  $('blocoDesconectado').style.display = conectado ? 'none' : 'block';
  if (loja) $('lojaNome').textContent = loja;
}

async function carregarImpressoras(selecionar) {
  const sel = $('impressora');
  const atual = selecionar != null ? selecionar : sel.value;
  const lista = await window.uai.listarImpressoras();
  sel.innerHTML = '<option value="">Impressora padrão do sistema</option>';
  (lista || []).forEach(p => {
    const o = document.createElement('option');
    o.value = p.nome;
    o.textContent = p.descricao + (p.padrao ? ' (padrão)' : '');
    sel.appendChild(o);
  });
  sel.value = atual || '';
}

async function carregar() {
  const c = await window.uai.getConfig();
  $('base').value = c.base || 'https://uaipedidos.com.br';
  $('email').value = c.email || '';
  $('vias').value = c.vias || 'auto';
  $('copias').value = c.copiasCozinha || 1;
  $('intervalo').value = c.intervalo || 5;
  $('som').checked = c.som !== false;
  $('autostart').checked = c.autostart !== false;
  await carregarImpressoras(c.impressora);
  const conectado = !!(c.email && (c.temSenha || c.temToken));
  mostrarConectado(conectado);
  const logs = await window.uai.logsRecentes();
  (logs || []).forEach(addLog);
  aplicarStatus(await window.uai.getStatus());
}

// ------- botões -------
$('btnConectar').addEventListener('click', async () => {
  const btn = $('btnConectar'); btn.disabled = true; btn.textContent = 'Conectando...';
  const r = await window.uai.conectar({ base: $('base').value.trim(), email: $('email').value.trim(), senha: $('senha').value });
  btn.disabled = false; btn.textContent = 'Conectar';
  if (r.ok) { aviso($('avisoConta'), 'ok', 'Conectado com sucesso.'); $('senha').value = ''; mostrarConectado(true, r.loja); await carregarImpressoras(); }
  else { aviso($('avisoConta'), 'erro', r.erro || 'Não foi possível conectar.'); }
});

$('btnSair').addEventListener('click', async () => {
  await window.uai.sair();
  mostrarConectado(false);
});

$('btnSalvar').addEventListener('click', async () => {
  await window.uai.salvarConfig({
    impressora: $('impressora').value,
    vias: $('vias').value,
    copiasCozinha: Math.max(1, Math.min(5, Number($('copias').value) || 1)),
    intervalo: Math.max(5, Math.min(120, Number($('intervalo').value) || 5)),
    som: $('som').checked,
    autostart: $('autostart').checked,
  });
  aviso($('avisoImp'), 'ok', 'Configuração salva.');
});

$('btnTeste').addEventListener('click', async () => {
  const btn = $('btnTeste'); btn.disabled = true;
  const r = await window.uai.imprimirTeste();
  btn.disabled = false;
  if (r && r.ok) aviso($('avisoImp'), 'ok', 'Teste enviado. Confira a bobina.');
  else aviso($('avisoImp'), 'erro', (r && r.erro) || 'Falha ao imprimir o teste.');
});

$('btnPausa').addEventListener('click', async () => {
  await window.uai.alternarPausa(!pausadoAtual);
});

$('btnAtualizarImp').addEventListener('click', () => carregarImpressoras());
$('btnPasta').addEventListener('click', () => window.uai.abrirPasta());

// Banner de versao nova: o botao "Atualizar agora" baixa e abre o instalador
// (Windows) ou abre a pagina de instalacao (Mac). Nunca atualiza sozinho.
$('btnAtualizar').addEventListener('click', async () => {
  const b = $('btnAtualizar');
  const txt = $('avisoVersaoTxt');
  atualizandoAgora = true;
  b.disabled = true;
  b.textContent = 'Atualizando...';
  if (txt) txt.textContent = 'Baixando a nova versão, aguarde...';
  let r = null;
  try { r = await window.uai.atualizarAgora(); } catch (e) { r = { ok: false, erro: (e && e.message) || 'falha' }; }
  b.disabled = false;
  b.textContent = 'Atualizar agora';
  if (txt) {
    if (r && r.ok) txt.textContent = r.msg || 'Atualização iniciada. Siga o instalador que abriu.';
    else txt.textContent = 'Não consegui atualizar agora' + (r && r.erro ? ' (' + r.erro + ')' : '') + '. Tente de novo em instantes.';
  }
  atualizandoAgora = false;
});

// mostra/esconde as configurações avançadas
$('btnAvancado').addEventListener('click', () => {
  const a = $('avancado');
  const aberto = a.style.display !== 'none';
  a.style.display = aberto ? 'none' : 'block';
  $('advSeta').textContent = aberto ? '▾' : '▴';
});

// ------- eventos vindos do programa -------
window.uai.onLog(addLog);
window.uai.onStatus(aplicarStatus);

carregar();
