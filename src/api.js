'use strict';
/*
 * api.js
 * Conversa com o UaiPedidos usando exatamente os mesmos endereços que o painel
 * já usa (api/estab/*). Autentica por token no cabeçalho Authorization: Bearer.
 * Por ser um app nativo (e não uma página de navegador), não sofre bloqueio de
 * origem cruzada (CORS).
 */

class ApiError extends Error {
  constructor(msg, status) { super(msg); this.name = 'ApiError'; this.status = status; }
}

function baseLimpa(base) {
  return String(base || 'https://uaipedidos.com.br').trim().replace(/\/+$/, '');
}

async function req(base, caminho, { method = 'GET', token = null, body = null } = {}) {
  const url = baseLimpa(base) + caminho;
  const headers = { 'Accept': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (body) headers['Content-Type'] = 'application/json';
  let resp;
  try {
    resp = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      // timeout defensivo: rede lenta não pode travar o programa
      signal: AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined,
    });
  } catch (e) {
    throw new ApiError('Sem conexão com o UaiPedidos (' + (e.message || 'rede') + ')', 0);
  }
  const txt = await resp.text();
  let dados = null;
  try { dados = txt ? JSON.parse(txt) : null; } catch (e) { dados = null; }
  if (resp.status === 401) throw new ApiError((dados && dados.erro) || 'Sessão expirada, faça login de novo', 401);
  if (!resp.ok) throw new ApiError((dados && dados.erro) || ('Erro ' + resp.status), resp.status);
  return dados;
}

// POST /api/estab/login {email, senha} -> { token }
async function login(base, email, senha) {
  const j = await req(base, '/api/estab/login', { method: 'POST', body: { email, senha } });
  if (!j || !j.token) throw new ApiError('Login sem token na resposta', 0);
  return j.token;
}

// GET /api/estab/me -> dados da loja + preferências de impressão
function me(base, token) {
  return req(base, '/api/estab/me', { token });
}

// GET /api/estab/pedidos?ping=1 -> { max_id, total }
function ping(base, token) {
  return req(base, '/api/estab/pedidos?ping=1', { token });
}

// GET /api/estab/pedidos?status=abertos&dias=N -> { pedidos: [...] }
function listaAbertos(base, token, dias = 2) {
  return req(base, '/api/estab/pedidos?status=abertos&dias=' + encodeURIComponent(dias), { token });
}

// GET /api/estab/pedidos?id=NN -> { pedido, itens, historico, pagamentos }
function detalhe(base, token, id) {
  return req(base, '/api/estab/pedidos?id=' + encodeURIComponent(id), { token });
}

// POST /api/estab/pedidos {acao:'marcar_impresso', id} -> { ok, imprimir }
// imprimir=true significa "você venceu a corrida, pode imprimir".
function marcarImpresso(base, token, id) {
  return req(base, '/api/estab/pedidos', { method: 'POST', token, body: { acao: 'marcar_impresso', id } });
}

module.exports = { ApiError, login, me, ping, listaAbertos, detalhe, marcarImpresso, baseLimpa };
