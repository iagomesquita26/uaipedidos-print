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
 *   testar_impressao, coletar_diagnostico, recado, deslogar
 */
const store = require('./store');

// Dependencias injetadas pelo main.js (que conhece app, poller, telemetria etc.)
let ctx = {};
function configurar(deps) { ctx = deps || {}; }

// Os comandos rodam um por vez. Se chegar um lote novo enquanto outro ainda roda
// (dois heartbeats cruzados), ele entra na fila e roda em seguida. Antes o lote
// novo era descartado, mas o servidor ja o tinha marcado como entregue, entao o
// comando se perdia. A guarda por id (cmdJaFeito/cmdMarcarFeito) evita repetir.
let processando = false;
const filaCmd = [];
// Depois de um reiniciar/deslogar, os comandos que sobraram na fila nao rodam (o
// programa vai fechar ou ficou sem acesso). Eles recebem um resultado de erro, que
// fica no disco e volta ao painel, em vez de sumirem como "entregue" para sempre.
let encerrando = '';

// Executa a lista de comandos recebida, um por vez, e guarda os resultados.
async function processar(lista) {
  if (!Array.isArray(lista) || !lista.length) return;
  filaCmd.push(...lista);
  if (processando) return; // o lote em andamento pega estes no fim
  processando = true;
  try {
    while (filaCmd.length) {
      const cmd = filaCmd.shift();
      const id = Number(cmd && cmd.id);
      if (!id || store.cmdJaFeito(id)) continue; // ja executado: nao repete
      store.cmdMarcarFeito(id);
      if (encerrando) { store.cmdResultAdicionar({ id: id, status: 'erro', resultado: 'Nao executado: ' + encerrando }); continue; }
      try {
        const r = await executar(cmd);
        if (r && r.jaRegistrado) continue; // o proprio executar ja guardou o resultado
        store.cmdResultAdicionar({ id: id, status: (r && r.status) || 'concluido', resultado: (r && r.resultado) || '' });
      } catch (e) {
        store.cmdResultAdicionar({ id: id, status: 'erro', resultado: String((e && e.message) || e).slice(0, 500) });
      }
    }
  } finally {
    processando = false;
    if (encerrando.startsWith('a loja')) encerrando = '';
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
      // "ultimos": reimprime os N pedidos recentes de uma vez (1 a 20).
      const n = Number(p.ultimos || p.quantidade || 0);
      if (n > 0) {
        if (!ctx.poller.reimprimirUltimos) return { status: 'erro', resultado: 'reimpressao em lote indisponivel' };
        const r = await ctx.poller.reimprimirUltimos(Math.min(20, n));
        if (!r || !r.ok) return { status: 'erro', resultado: (r && r.erro) || 'falha ao reimprimir em lote' };
        const feitos = (r.feitos || []).length;
        const erros = (r.erros || []).length;
        return { status: erros && !feitos ? 'erro' : 'concluido',
                 resultado: feitos + ' pedido(s) reimpresso(s)' + (erros ? ', ' + erros + ' com erro' : '') };
      }
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
      // Desde a 1.1.0 as vias vem so do painel: um pedido de vias vira "seguir a loja".
      if (p.vias !== undefined)       permitido.vias = 'auto';
      const viasIgnoradas = p.vias !== undefined && p.vias !== 'auto';
      if (p.intervalo !== undefined)  permitido.intervalo = Math.max(5, Math.min(120, Number(p.intervalo) || 5));
      if (p.copias !== undefined)     permitido.copiasCozinha = Math.max(1, Math.min(5, Number(p.copias) || 1));
      if (p.som !== undefined)        permitido.som = !!p.som;
      if (p.autostart !== undefined)  permitido.autostart = !!p.autostart;
      if (p.pausado !== undefined)    permitido.pausado = !!p.pausado; // retomar/pausar pela pausa local
      if (!Object.keys(permitido).length) return { status: 'erro', resultado: 'configuracao vazia' };
      const aviso = viasIgnoradas ? ' (vias fixas nao valem mais neste PC: desde a 1.1.0 ele segue a escolha da loja na aba Impressao do painel)' : '';
      // So veio vias fixas: nada mudou de verdade, entao avisa como erro.
      if (viasIgnoradas && Object.keys(permitido).length === 1) return { status: 'erro', resultado: 'Nao aplicado' + aviso };
      store.setConfig(permitido);
      if (ctx.aplicarConfig) ctx.aplicarConfig(permitido);
      return { status: 'concluido', resultado: 'Configuracao aplicada: ' + Object.keys(permitido).join(', ') + aviso };
    }

    case 'coletar_diagnostico':
      if (ctx.coletarAmbiente) { try { await ctx.coletarAmbiente('comando'); } catch (e) {} }
      return { status: 'concluido', resultado: 'Diagnostico coletado e enviado' };

    case 'reiniciar': {
      // guarda o resultado AGORA (sobrevive ao reinicio) e tenta mandar antes de sair
      store.cmdResultAdicionar({ id: Number(cmd.id), status: 'concluido', resultado: 'Programa reiniciado' });
      encerrando = 'o programa foi reiniciado antes';
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

    case 'recado': {
      // Texto do suporte que aparece na tela do programa. Vazio limpa o recado.
      const texto = String(p.texto || p.recado || '').slice(0, 300);
      store.setConfig({ recado: texto });
      if (ctx.mostrarRecado) ctx.mostrarRecado();
      return { status: 'concluido', resultado: texto ? 'Recado exibido na tela' : 'Recado removido' };
    }

    case 'deslogar': {
      // Logout remoto: guarda o resultado e envia ANTES de apagar o token (o flush
      // precisa do token), igual ao reiniciar. Depois desconecta.
      store.cmdResultAdicionar({ id: Number(cmd.id), status: 'concluido', resultado: 'Loja desconectada pelo suporte' });
      encerrando = 'a loja foi desconectada antes';
      try { if (ctx.telemetria) await ctx.telemetria.flush(true); } catch (e) {}
      if (ctx.deslogar) { try { ctx.deslogar(); } catch (e) {} }
      return { jaRegistrado: true };
    }

    default:
      return { status: 'erro', resultado: 'comando desconhecido: ' + tipo };
  }
}

module.exports = { configurar, processar };
