/**
 * GRAFO STUDIO — editor visual de grafos de agentes de IA
 * (loops trabalhador ⇄ supervisor cego, em paralelo e em sequência)
 *
 * COMO PUBLICAR (script vinculado à planilha)
 * 1. Crie uma planilha no Google Sheets → Extensões → Apps Script.
 * 2. Cole este arquivo em "Code.gs".
 * 3. Arquivo "+" → HTML → nome exatamente "Index" → cole o Index.html.
 * 4. Selecione a função "configurar" e clique em Executar (autorize).
 *    Ela cria a aba "Usuarios" (ID | Usuário | Senha) com o usuário
 *    inicial admin / troque-esta-senha.
 * 5. Implantar → Nova implantação → tipo "App da Web":
 *      Executar como: "Eu"
 *      Quem pode acessar: "Qualquer pessoa"
 *
 * USUÁRIOS: cada linha da aba "Usuarios" é uma pessoa. Para criar, trocar senha
 * ou bloquear alguém, edite a planilha. Os grafos ficam no SEU Drive, na pasta
 * "Grafo Studio", numa subpasta por usuário.
 */

var ABA_USUARIOS = 'Usuarios';
var PASTA_NOME = 'Grafo Studio';
var PASTA_EXPORT = 'Exportações';
var EXT = '.grafo.json';
var SESSAO_SEGUNDOS = 6 * 60 * 60;    // 6 horas (máximo do CacheService)

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Grafo Studio')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* ───────────────────────── configuração e planilha ───────────────────────── */

/** Rode uma vez pelo editor. Cria (ou encontra) a planilha de usuários. */
function configurar() {
  var ss = planilha_();
  pasta_();
  Logger.log('Planilha de usuários: ' + ss.getUrl());
  Logger.log('Usuário inicial: admin / troque-esta-senha (troque na planilha).');
}

function planilha_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Este script precisa estar vinculado a uma planilha (Extensões → Apps Script).');
  var aba = ss.getSheetByName(ABA_USUARIOS);
  if (!aba) aba = ss.insertSheet(ABA_USUARIOS);
  if (aba.getLastRow() === 0) {
    aba.appendRow(['ID', 'Usuário', 'Senha']);
    aba.appendRow(['1', 'admin', 'troque-esta-senha']);
    aba.setFrozenRows(1);
    aba.getRange('A:C').setNumberFormat('@');
  }
  return ss;
}

function usuarios_() {
  var aba = planilha_().getSheetByName(ABA_USUARIOS);
  var dados = aba.getDataRange().getDisplayValues();
  var out = [];
  for (var i = 1; i < dados.length; i++) {
    var id = String(dados[i][0] || '').trim();
    var user = String(dados[i][1] || '').trim();
    if (!id || !user) continue;
    out.push({ id: id, usuario: user, senha: String(dados[i][2] || '') });
  }
  return out;
}

/* ───────────────────────── sessão ───────────────────────── */

function login(usuario, senha) {
  var u = String(usuario || '').trim().toLowerCase();
  var s = String(senha || '');
  if (!u || !s) throw new Error('Informe usuário e senha.');
  var achado = null;
  usuarios_().forEach(function (x) { if (x.usuario.toLowerCase() === u && x.senha === s) achado = x; });
  if (!achado) {
    Utilities.sleep(800); // freia tentativas em série
    throw new Error('Usuário ou senha incorretos.');
  }
  var token = Utilities.getUuid();
  CacheService.getScriptCache().put('sessao_' + token, JSON.stringify({ id: achado.id, usuario: achado.usuario }), SESSAO_SEGUNDOS);
  return { token: token, usuario: achado.usuario };
}

function logout(token) {
  if (token) CacheService.getScriptCache().remove('sessao_' + token);
  return true;
}

/** Valida a sessão, confere se o usuário ainda existe na planilha e renova o prazo. */
function sessao_(token) {
  if (!token) throw new Error('SESSAO_EXPIRADA');
  var cache = CacheService.getScriptCache();
  var raw = cache.get('sessao_' + token);
  if (!raw) throw new Error('SESSAO_EXPIRADA');
  var s = JSON.parse(raw);
  var ainda = usuarios_().some(function (x) { return x.id === s.id && x.usuario === s.usuario; });
  if (!ainda) { cache.remove('sessao_' + token); throw new Error('SESSAO_EXPIRADA'); }
  cache.put('sessao_' + token, raw, SESSAO_SEGUNDOS);
  return s;
}

function pref_(s, chave, valor) {
  var props = PropertiesService.getScriptProperties();
  var k = 'u_' + s.id + '_' + chave;
  if (valor === undefined) return props.getProperty(k);
  if (valor === null) props.deleteProperty(k); else props.setProperty(k, String(valor));
}

/* ───────────────────────── pastas e arquivos ───────────────────────── */

function pasta_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('pastaId');
  if (id) {
    try { var f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) {}
  }
  var it = DriveApp.getFoldersByName(PASTA_NOME);
  var pasta = it.hasNext() ? it.next() : DriveApp.createFolder(PASTA_NOME);
  props.setProperty('pastaId', pasta.getId());
  return pasta;
}

/** Subpasta exclusiva de cada usuário (pelo ID da planilha). */
function pastaUsuario_(s) {
  var props = PropertiesService.getScriptProperties();
  var k = 'pasta_u_' + s.id;
  var id = props.getProperty(k);
  if (id) {
    try { var f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) {}
  }
  var nome = 'usuario-' + s.id;
  var it = pasta_().getFoldersByName(nome);
  var p = it.hasNext() ? it.next() : pasta_().createFolder(nome);
  props.setProperty(k, p.getId());
  return p;
}

function subpasta_(pai, nome) {
  var it = pai.getFoldersByName(nome);
  return it.hasNext() ? it.next() : pai.createFolder(nome);
}

/** Abre um grafo garantindo que ele pertence ao usuário logado. */
function arquivo_(s, id) {
  var f;
  try { f = DriveApp.getFileById(id); } catch (e) { throw new Error('Grafo não encontrado.'); }
  if (f.isTrashed()) throw new Error('Este grafo foi apagado.');
  var pid = pastaUsuario_(s).getId();
  var pais = f.getParents();
  while (pais.hasNext()) { if (pais.next().getId() === pid) return f; }
  throw new Error('Grafo não encontrado.');
}

function nomeArquivo_(nome) {
  return String(nome || 'Meu grafo').replace(/[\\/:*?"<>|]/g, '-').slice(0, 120) + EXT;
}

function lerGrafo_(f) { return f.getBlob().getDataAsString('UTF-8'); }

function gravar_(f, g) {
  var nome = String(g.name || 'Meu grafo').slice(0, 120);
  g.name = nome;
  g.updatedAt = new Date().toISOString();
  f.setContent(JSON.stringify(g, null, 2));
  f.setName(nomeArquivo_(nome));
  f.setDescription(JSON.stringify({ name: nome, pieces: g.nodes.length, wires: g.edges.length }));
}

/* ───────────────────────── API chamada pela página ───────────────────────── */

function bootstrap(token) {
  var s = sessao_(token);
  var ultimo = pref_(s, 'ultimoGrafo');
  var graph = null;
  if (ultimo) {
    try { graph = lerGrafo_(arquivo_(s, ultimo)); } catch (e) { pref_(s, 'ultimoGrafo', null); }
  }
  return { email: s.usuario, graph: graph, helpSeen: pref_(s, 'ajudaVista') === '1' };
}

function markHelpSeen(token) {
  pref_(sessao_(token), 'ajudaVista', '1');
  return true;
}

function listGraphs(token) {
  var s = sessao_(token);
  var it = pastaUsuario_(s).getFiles();
  var out = [];
  while (it.hasNext()) {
    var f = it.next();
    if (f.isTrashed() || f.getName().slice(-EXT.length) !== EXT) continue;
    var meta = {};
    try { meta = JSON.parse(f.getDescription() || '{}'); } catch (e) {}
    out.push({
      id: f.getId(),
      name: meta.name || f.getName().slice(0, -EXT.length),
      updatedAt: f.getLastUpdated().toISOString(),
      pieces: meta.pieces || 0,
      wires: meta.wires || 0
    });
  }
  out.sort(function (a, b) { return b.updatedAt < a.updatedAt ? -1 : 1; });
  return out;
}

function loadGraph(token, id) {
  var s = sessao_(token);
  var txt = lerGrafo_(arquivo_(s, id));
  pref_(s, 'ultimoGrafo', id);
  return txt;
}

function saveGraph(token, json) {
  var s = sessao_(token);
  if (typeof json !== 'string' || json.length > 5000000) throw new Error('Grafo grande demais ou inválido.');
  var g = JSON.parse(json);
  if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) throw new Error('Grafo inválido.');
  var f;
  if (g.id) {
    f = arquivo_(s, g.id);
  } else {
    f = pastaUsuario_(s).createFile(nomeArquivo_(g.name), '{}', 'application/json');
    g.id = f.getId();
    g.createdAt = g.createdAt || new Date().toISOString();
  }
  gravar_(f, g);
  pref_(s, 'ultimoGrafo', g.id);
  return { id: g.id, updatedAt: g.updatedAt };
}

function renameGraph(token, id, nome) {
  var s = sessao_(token);
  var f = arquivo_(s, id);
  var g = JSON.parse(lerGrafo_(f));
  g.name = String(nome || '').trim() || 'Meu grafo';
  gravar_(f, g);
  return { id: id, name: g.name };
}

function duplicateGraph(token, id) {
  var s = sessao_(token);
  var g = JSON.parse(lerGrafo_(arquivo_(s, id)));
  g.name = 'Cópia de ' + (g.name || 'Meu grafo');
  g.createdAt = new Date().toISOString();
  var f = pastaUsuario_(s).createFile(nomeArquivo_(g.name), '{}', 'application/json');
  g.id = f.getId();
  gravar_(f, g);
  return { id: g.id, name: g.name };
}

function deleteGraph(token, id) {
  var s = sessao_(token);
  arquivo_(s, id).setTrashed(true);
  if (pref_(s, 'ultimoGrafo') === id) pref_(s, 'ultimoGrafo', null);
  return true;
}

function forgetCurrent(token) {
  pref_(sessao_(token), 'ultimoGrafo', null);
  return true;
}

/** Salva uma exportação (.txt, .json, .py) no Drive e devolve o link. */
function exportToDrive(token, nomeArquivo, conteudo) {
  var s = sessao_(token);
  var nome = String(nomeArquivo || 'grafo.txt').replace(/[\\/:*?"<>|]/g, '-').slice(0, 150);
  var f = subpasta_(pastaUsuario_(s), PASTA_EXPORT).createFile(nome, String(conteudo || ''), MimeType.PLAIN_TEXT);
  // O arquivo fica no Drive do dono do app; o link permite que o usuário logado o abra.
  try { f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
  return { url: f.getUrl(), name: f.getName() };
}
