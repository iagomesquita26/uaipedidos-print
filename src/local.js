'use strict';
/*
 * local.js (1.1.0)
 * Um "sinal" so dentro do computador, para o painel do UaiPedidos aberto NESTE PC
 * saber que o programa esta instalado aqui (selo "Este computador" na aba Impressao).
 *
 * Seguranca:
 *  - escuta so em 127.0.0.1 (nunca na rede da loja), portas 47801 a 47803;
 *  - responde so GET /ping (e o OPTIONS do navegador); todo o resto e 404;
 *  - devolve so versao, id do PC e id da loja. Nunca e-mail, senha ou token;
 *  - o navegador so deixa ler a resposta quem vem do site do UaiPedidos.
 */
const http = require('http');

const PORTAS = [47801, 47802, 47803];
const SITES = ['https://uaipedidos.com.br', 'https://www.uaipedidos.com.br'];

function origemDe(base) {
  try { const u = new URL(String(base || '')); return (u.protocol === 'https:' || u.protocol === 'http:') ? u.origin : ''; } catch (e) { return ''; }
}

function iniciar({ getInfo, getBase, registrarLog = () => {} } = {}) {
  let servidor = null;
  let porta = 0;

  function origemPermitida(o) {
    if (!o) return false;
    if (SITES.includes(o)) return true;
    const b = origemDe(getBase && getBase());
    return !!b && b === o;
  }

  function tratar(req, res) {
    // Barra o truque de "DNS rebinding": o endereco pedido tem que ser este PC.
    const host = String(req.headers.host || '');
    if (host !== '127.0.0.1:' + porta && host !== 'localhost:' + porta) { res.writeHead(403); res.end(); return; }

    const origem = String(req.headers.origin || '');
    const cab = { 'Cache-Control': 'no-store', 'Vary': 'Origin' };
    if (origemPermitida(origem)) {
      cab['Access-Control-Allow-Origin'] = origem;
      cab['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
      cab['Access-Control-Max-Age'] = '600';
      if (req.headers['access-control-request-private-network']) cab['Access-Control-Allow-Private-Network'] = 'true';
    }
    const caminho = String(req.url || '').split('?')[0];
    // Pagina de outro site nem recebe resposta.
    if (origem && !origemPermitida(origem)) { res.writeHead(403, cab); res.end(); return; }

    if (req.method === 'OPTIONS' && caminho === '/ping') { res.writeHead(204, cab); res.end(); return; }
    if (req.method !== 'GET' || caminho !== '/ping') { res.writeHead(404, cab); res.end(); return; }

    let info = {};
    try { info = (getInfo && getInfo()) || {}; } catch (e) {}
    const corpo = JSON.stringify({
      app: 'uaipedidos-print',
      versao: String(info.versao || ''),
      agente_id: String(info.agente_id || ''),
      estabelecimento_id: Number(info.estabelecimento_id) || 0,
    });
    cab['Content-Type'] = 'application/json; charset=utf-8';
    res.writeHead(200, cab);
    res.end(corpo);
  }

  function tentar(i) {
    if (i >= PORTAS.length) { registrarLog('aviso', 'Nao consegui abrir o sinal local para o painel (portas ocupadas). A impressao segue normal.'); return; }
    const s = http.createServer(tratar);
    // Porta ocupada (outro usuario do PC, por exemplo): tenta a proxima.
    const aoFalhar = () => { try { s.close(); } catch (e) {} tentar(i + 1); };
    s.once('error', aoFalhar);
    s.listen(PORTAS[i], '127.0.0.1', () => {
      s.removeListener('error', aoFalhar);
      s.on('error', () => {}); // erro depois de aberto nao derruba o programa
      servidor = s; porta = PORTAS[i];
    });
    // Conexao parada nao fica presa.
    s.setTimeout(5000, (sock) => { try { sock.destroy(); } catch (e) {} });
  }
  tentar(0);

  return {
    parar() { try { if (servidor) servidor.close(); } catch (e) {} servidor = null; },
    porta: () => porta,
  };
}

module.exports = { iniciar, PORTAS };
