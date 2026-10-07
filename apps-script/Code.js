/**
 * GRAFO STUDIO — editor visual de grafos de agentes de IA
 * (loops trabalhador ⇄ supervisor cego, em paralelo e em sequência)
 *
 * COMO PUBLICAR (script vinculado à planilha)
 * 1. Crie uma planilha no Google Sheets → Extensões → Apps Script.
 * 2. Cole este arquivo em "Code.gs".
 * 3. Arquivo "+" → HTML → nome exatamente "Index" → cole o Index.html.
 * 4. Selecione a função "configurar" e clique em Executar (autorize).
 *    Ela cria a aba "Usuarios" e, se a aba ainda não existia, o usuário
 *    "admin" com uma senha aleatória, mostrada no Registro de execução.
 * 5. Implantar → Nova implantação → tipo "App da Web":
 *      Executar como: "Eu"
 *      Quem pode acessar: "Qualquer pessoa"
 *
 * USUÁRIOS: cada linha da aba "Usuarios" é uma pessoa.
 *  - Para criar alguém, preencha Usuário e Senha numa linha nova.
 *  - Para trocar uma senha, apague a célula da Senha e digite a nova.
 *  - Para bloquear alguém, apague a linha.
 *  A senha digitada é trocada na hora por um código embaralhado (hash) que
 *  começa com "h1$" e não pode ser desfeito. A coluna "Chave interna" é
 *  preenchida sozinha: não edite nem copie essa coluna. A coluna ID é só
 *  um rótulo para humanos; pode repetir ou ser reaproveitada sem risco.
 *
 * Os grafos ficam no SEU Drive, na pasta "Grafo Studio", numa subpasta por
 * usuário, escolhida pela Chave interna.
 */

var ABA_USUARIOS = 'Usuarios';
var CABECALHO = ['ID', 'Usuário', 'Senha', 'Chave interna (não editar)'];
var PREFIXO_HASH = 'h1$';
var ITERACOES_HASH = 100;
var MAX_FALHAS = 5;                   // erros seguidos até bloquear
var BLOQUEIO_SEGUNDOS = 10 * 60;      // 10 minutos
var PASTA_NOME = 'Grafo Studio';
var PASTA_EXPORT = 'Exportações';
var EXT = '.grafo.json';
var SESSAO_SEGUNDOS = 6 * 60 * 60;    // 6 horas (máximo do CacheService)
var DOWNLOAD_SEGUNDOS = 10 * 60;      // validade do link de download: 10 minutos

function doGet(e) {
  // Endereço de download (…/exec?baixar=<código>): entrega o arquivo exportado.
  if (e && e.parameter && e.parameter.baixar) return baixar_(String(e.parameter.baixar));
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Grafo Studio')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* ───────────────────────── configuração e planilha ───────────────────────── */

/** Rode pelo editor. Cria a aba de usuários, embaralha senhas e confere a aba. */
function configurar() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Este script precisa estar vinculado a uma planilha (Extensões → Apps Script).');
  var nova = !ss.getSheetByName(ABA_USUARIOS);
  var senhaInicial = null;
  if (nova) senhaInicial = Utilities.getUuid().replace(/-/g, '').slice(0, 10);
  planilha_(senhaInicial);
  pasta_();
  var lista = usuarios_();
  Logger.log('Planilha de usuários: ' + ss.getUrl());
  Logger.log(lista.length + ' usuário(s) ativo(s). Todas as senhas estão embaralhadas.');
  if (senhaInicial) Logger.log('Usuário inicial: admin / ' + senhaInicial + '  (anote: esta senha não aparece em nenhum outro lugar)');
  var ids = {};
  lista.forEach(function (u) { ids[u.id] = (ids[u.id] || 0) + 1; });
  Object.keys(ids).forEach(function (id) {
    if (ids[id] > 1) Logger.log('Aviso: o ID "' + id + '" aparece ' + ids[id] + ' vezes. Não causa problema, mas pode confundir quem lê a planilha.');
  });
}

/** Garante a aba "Usuarios" com o cabeçalho de 4 colunas. */
function planilha_(senhaInicial) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Este script precisa estar vinculado a uma planilha (Extensões → Apps Script).');
  var aba = ss.getSheetByName(ABA_USUARIOS);
  if (!aba) aba = ss.insertSheet(ABA_USUARIOS);
  if (aba.getLastRow() === 0) {
    aba.appendRow(CABECALHO);
    if (senhaInicial) aba.appendRow(['1', 'admin', senhaInicial, '']);
    aba.setFrozenRows(1);
  }
  if (String(aba.getRange(1, 4).getValue()) !== CABECALHO[3]) aba.getRange(1, 4).setValue(CABECALHO[3]);
  aba.getRange('A:D').setNumberFormat('@');
  return ss;
}

/* ───────────────────────── senhas ───────────────────────── */

/** Segredo do servidor ("pimenta"): fica só nas propriedades do script, nunca na planilha. */
function pimenta_() {
  var props = PropertiesService.getScriptProperties();
  var p = props.getProperty('pimenta');
  if (!p) { p = Utilities.getUuid() + Utilities.getUuid(); props.setProperty('pimenta', p); }
  return p;
}

function embaralhar_(senha, sal) {
  var p = pimenta_();
  var h = sal + ':' + senha;
  for (var i = 0; i < ITERACOES_HASH; i++) {
    h = Utilities.base64Encode(Utilities.computeHmacSha256Signature(h + senha, p));
  }
  return h;
}

function gerarHash_(senha) {
  var sal = Utilities.getUuid().replace(/-/g, '');
  return PREFIXO_HASH + sal + '$' + embaralhar_(senha, sal);
}

function conferirSenha_(senha, guardado) {
  var partes = String(guardado || '').split('$');
  if (partes.length !== 3 || partes[0] + '$' !== PREFIXO_HASH) return false;
  var calc = embaralhar_(senha, partes[1]);
  if (calc.length !== partes[2].length) return false;
  var dif = 0;
  for (var i = 0; i < calc.length; i++) dif |= calc.charCodeAt(i) ^ partes[2].charCodeAt(i);
  return dif === 0;
}

function ehHash_(v) { return String(v || '').indexOf(PREFIXO_HASH) === 0; }

/* ───────────────────────── usuários ───────────────────────── */

/**
 * Lê a aba de usuários e, se preciso, arruma-a: embaralha senhas digitadas
 * e dá uma Chave interna única a quem não tem (ou tem uma repetida).
 */
function usuarios_() {
  var aba = planilha_().getSheetByName(ABA_USUARIOS);
  var n = aba.getLastRow() - 1;
  if (n < 1) return [];
  var faixa = aba.getRange(2, 1, n, 4);
  var dados = faixa.getDisplayValues();
  if (precisaArrumar_(dados)) {
    var lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      dados = faixa.getDisplayValues();          // relê: outra execução pode ter arrumado
      if (arrumar_(dados)) {
        aba.getRange(2, 3, n, 2).setValues(dados.map(function (r) { return [r[2], r[3]]; }));
        SpreadsheetApp.flush();
      }
    } finally { lock.releaseLock(); }
  }
  var out = [];
  dados.forEach(function (r) {
    var user = String(r[1] || '').trim();
    if (!user || !ehHash_(r[2]) || !r[3]) return;
    out.push({ id: String(r[0] || '').trim(), usuario: user, hash: r[2], chave: r[3] });
  });
  return out;
}

function precisaArrumar_(dados) {
  var vistas = {};
  return dados.some(function (r) {
    if (!String(r[1] || '').trim()) return false;
    var repetida = r[3] && vistas[r[3]];
    if (r[3]) vistas[r[3]] = 1;
    return (r[2] && !ehHash_(r[2])) || !r[3] || repetida;
  });
}

/** Altera `dados` no lugar. Devolve true se mudou alguma coisa. */
function arrumar_(dados) {
  var mudou = false, vistas = {};
  dados.forEach(function (r) {
    if (!String(r[1] || '').trim()) return;
    if (r[2] && !ehHash_(r[2])) { r[2] = gerarHash_(String(r[2])); mudou = true; }
    if (!r[3] || vistas[r[3]]) {
      r[3] = Utilities.getUuid();
      herdarDadosAntigos_(String(r[0] || '').trim(), r[3]);
      mudou = true;
    }
    vistas[r[3]] = 1;
  });
  return mudou;
}

/**
 * Migração da versão anterior, em que pasta e preferências eram guardadas
 * pelo ID. Na primeira vez que uma linha ganha Chave interna, ela assume o
 * que estava no ID dela, e o registro antigo é apagado — assim, um ID
 * reaproveitado depois nunca encontra os grafos de outra pessoa.
 */
function herdarDadosAntigos_(id, chave) {
  if (!id) return;
  var props = PropertiesService.getScriptProperties();
  [['pasta_u_' + id, 'pasta_c_' + chave],
   ['u_' + id + '_ultimoGrafo', 'c_' + chave + '_ultimoGrafo'],
   ['u_' + id + '_ajudaVista', 'c_' + chave + '_ajudaVista']].forEach(function (par) {
    var v = props.getProperty(par[0]);
    if (v !== null) { props.setProperty(par[1], v); props.deleteProperty(par[0]); }
  });
}

/** Gatilho simples: embaralha a senha assim que alguém a digita na aba Usuarios. */
function onEdit(e) {
  try {
    if (!e || !e.range || e.range.getSheet().getName() !== ABA_USUARIOS) return;
    if (e.range.getLastRow() < 2 || e.range.getColumn() > 4 || e.range.getLastColumn() < 2) return;
    usuarios_();
  } catch (err) {
    // Sem problema: a senha também é embaralhada no próximo login ou ao rodar "configurar".
  }
}

/* ───────────────────────── sessão ───────────────────────── */

function login(usuario, senha) {
  var u = String(usuario || '').trim().toLowerCase();
  var s = String(senha || '');
  if (!u || !s) throw new Error('Informe usuário e senha.');
  var cache = CacheService.getScriptCache();
  if (cache.get('bloq_' + u)) {
    throw new Error('Muitas tentativas erradas. Este usuário está bloqueado por alguns minutos.');
  }
  var achado = null;
  usuarios_().forEach(function (x) {
    if (!achado && x.usuario.toLowerCase() === u && conferirSenha_(s, x.hash)) achado = x;
  });
  if (!achado) {
    var falhas = Number(cache.get('falhas_' + u) || 0) + 1;
    if (falhas >= MAX_FALHAS) {
      cache.put('bloq_' + u, '1', BLOQUEIO_SEGUNDOS);
      cache.remove('falhas_' + u);
    } else {
      cache.put('falhas_' + u, String(falhas), BLOQUEIO_SEGUNDOS);
    }
    Utilities.sleep(800); // freia tentativas em série
    throw new Error('Usuário ou senha incorretos.');
  }
  cache.remove('falhas_' + u);
  var token = Utilities.getUuid();
  cache.put('sessao_' + token, JSON.stringify({ chave: achado.chave, usuario: achado.usuario }), SESSAO_SEGUNDOS);
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
  var ainda = s.chave && usuarios_().some(function (x) { return x.chave === s.chave && x.usuario === s.usuario; });
  if (!ainda) { cache.remove('sessao_' + token); throw new Error('SESSAO_EXPIRADA'); }
  cache.put('sessao_' + token, raw, SESSAO_SEGUNDOS);
  return s;
}

function pref_(s, chave, valor) {
  var props = PropertiesService.getScriptProperties();
  var k = 'c_' + s.chave + '_' + chave;
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

/**
 * Subpasta exclusiva de cada usuário, escolhida pela Chave interna.
 * Nunca procura pasta pelo nome: uma pasta antiga com nome parecido
 * nunca é entregue a outra pessoa.
 */
function pastaUsuario_(s) {
  var props = PropertiesService.getScriptProperties();
  var k = 'pasta_c_' + s.chave;
  var id = props.getProperty(k);
  if (id) {
    try { var f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) {}
  }
  var nome = 'usuario-' + String(s.usuario).replace(/[\\/:*?"<>|]/g, '-') + '-' + s.chave.slice(0, 8);
  var p = pasta_().createFolder(nome);
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

/**
 * Prepara o download de uma exportação (.txt, .json, .py).
 * O arquivo fica guardado no Drive do dono do app, PRIVADO (sem link público),
 * na pasta "Exportações" do usuário. O usuário recebe um endereço de download
 * com um código aleatório que vale por poucos minutos.
 */
function prepararDownload(token, nomeArquivo, conteudo) {
  var s = sessao_(token);
  var nome = String(nomeArquivo || 'grafo.txt').replace(/[\\/:*?"<>|]/g, '-').slice(0, 150);
  var f = subpasta_(pastaUsuario_(s), PASTA_EXPORT).createFile(nome, String(conteudo || ''), MimeType.PLAIN_TEXT);
  var codigo = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  CacheService.getScriptCache().put('dl_' + codigo, JSON.stringify({ arquivo: f.getId(), nome: nome }), DOWNLOAD_SEGUNDOS);
  return { url: ScriptApp.getService().getUrl() + '?baixar=' + codigo, name: nome, minutos: Math.round(DOWNLOAD_SEGUNDOS / 60) };
}

/** Responde ao endereço de download. Código desconhecido ou vencido → página de aviso. */
function baixar_(codigo) {
  var raw = /^[0-9a-f]{64}$/.test(codigo) ? CacheService.getScriptCache().get('dl_' + codigo) : null;
  if (!raw) {
    return HtmlService.createHtmlOutput(
      '<p style="font:16px system-ui;margin:40px">Este link de download venceu ou não é válido. ' +
      'Volte ao Grafo Studio e gere outro em Exportar.</p>').setTitle('Link vencido');
  }
  var d = JSON.parse(raw);
  var conteudo = DriveApp.getFileById(d.arquivo).getBlob().getDataAsString('UTF-8');
  var tipo = /\.json$/i.test(d.nome) ? ContentService.MimeType.JSON : ContentService.MimeType.TEXT;
  return ContentService.createTextOutput(conteudo).setMimeType(tipo).downloadAsFile(d.nome);
}
