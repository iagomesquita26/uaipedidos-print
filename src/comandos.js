'use strict';
/*
 * comandos.js
 * Executa os comandos de suporte que chegam do painel/admin pelo canal de controle
 * (vem de carona na resposta do print_log, em controle.comandos). Cada comando
 * executado gera um resultado, que a telemetria devolve no proximo sinal de vida
 * (campo comandos_resultado). Os resultados ficam guardados no disco (store): se um
 * comando reiniciar ou atualizar o programa, o resultado sobrevive e e enviado quando
 * o programa voltar.
 *
 * Tipos de comando (espelham o servidor em api/lib_print_comandos.php):
 *   reimprimir, limpar_fila, reiniciar, aplicar_config, atualizar,
 *   testar_impressao, coletar_diagnostico
 */
const store = require('./store');

// Dependencias injetadas pelo main.js (que conhece app, poller, telemetria etc.)
let ctx = {};
function configurar(deps) { ctx = deps || {}; }

// Executa a lista de comandos recebida, um por vez, e guarda os resultados.
async function processar(lista) {
  if (!Array.isArray(lista) || !lista.length) return;
  for (const cmd of lista) {
    const id = Number(cmd && cmd.id);
    if (!id || store.cmdJaFeito(id)) continue; // ja executado: nao repete
    store.cmdMarcarFeito(id);
    try {
      const r = await executar(cmd);
      if (r && r.jaRegistrado) continue; // o proprio executar ja guardou o resultado
      store.cmdResultAdicionar({ id: id, status: (r && r.status) || 'concluido', resultado: (r && r.resultado) || '' });
    } catch (e) {
      store.cmdResultAdicionar({ id: id, status: 'erro', resultado: String((e && e.message) || e).slice(0, 500) });
    }
  }
  // tenta devolver os resultados o quanto antes (fora do heartbeat em andamento)
  setTimeout(() => { try { if (ctx.telemetria) ctx.telemetria.flush(true); } catch (e) {} }, 1200);
}

async function executar(cmd) {
  const tipo = cmd && cmd.tipo;
  const p = (cmd && cmd.payload) || {};
  switch (tipo) {
    case 'reimprimir': {
      if (!ctx.poller || !ctx.poller.reimprimir) return { status: 'erro', resultado: 'reimpressao indisponivel' };
      const r = await ctx.poller.reimprimir(p);
      return (r && r.ok)
        ? { status: 'concluido', resultado: 'Pedido #' + (r.numero || (p.pedido_numero || p.pedido_id || '')) + ' reimpresso' }
        : { status: 'erro', resultado: (r && r.erro) || 'falha ao reimprimir' };
    }

    case 'limpar_fila':
      if (ctx.poller && ctx.poller.limparFila) ctx.poller.limparFila();
      return { status: 'concluido', resultado: 'Fila de impressao limpa' };

    case 'testar_impressao': {
      const r = (ctx.poller && ctx.poller.imprimirTeste) ? await ctx.poller.imprimirTeste() : { ok: false };
      return (r && r.ok)
        ? { status: 'concluido', resultado: 'Cupom de teste enviado a impressora' }
        : { status: 'erro', resultado: (r && r.erro) || 'falha no teste' };
    }

    case 'aplicar_config': {
      const permitido = {};
      if (p.impressora !== undefined) permitido.impressora = String(p.impressora);
      if (p.vias !== undefined)       permitido.vias = String(p.vias);
      if (p.intervalo !== undefined)  permitido.intervalo = Math.max(5, Number(p.intervalo) || 5);
      if (p.copias !== undefined)     permitido.copiasCozinha = Math.max(1, Number(p.copias) || 1);
      if (!Object.keys(permitido).length) return { status: 'erro', resultado: 'configuracao vazia' };
      store.setConfig(permitido);
      if (ctx.aplicarConfig) ctx.aplicarConfig(permitido);
      return { status: 'concluido', resultado: 'Configuracao aplicada: ' + Object.keys(permitido).join(', ') };
    }

    case 'coletar_diagnostico':
      if (ctx.coletarAmbiente) { try { await ctx.coletarAmbiente('comando'); } catch (e) {} }
      return { status: 'concluido', resultado: 'Diagnostico coletado e enviado' };

    case 'reiniciar': {
      // guarda o resultado AGORA (sobrevive ao reinicio) e tenta mandar antes de sair
      store.cmdResultAdicionar({ id: Number(cmd.id), status: 'concluido', resultado: 'Programa reiniciado' });
      try { if (ctx.telemetria) await ctx.telemetria.flush(true); } catch (e) {}
      setTimeout(() => { try { ctx.app.relaunch(); ctx.app.exit(0); } catch (e) {} }, 800);
      return { jaRegistrado: true };
    }

    case 'atualizar': {
      const r = ctx.atualizarAgora ? await ctx.atualizarAgora('comando') : { ok: false, erro: 'atualizacao indisponivel' };
      return (r && r.ok)
        ? { status: 'concluido', resultado: r.msg || 'Atualizacao iniciada' }
        : { status: 'erro', resultado: (r && r.erro) || 'falha na atualizacao' };
    }

    default:
      return { status: 'erro', resultado: 'comando desconhecido: ' + tipo };
  }
}

module.exports = { configurar, processar };
