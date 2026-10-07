/**
 * Grafo Studio: servidor do editor de grafos de agentes de IA.
 *
 * Publicação (script vinculado à planilha):
 *   1. Na planilha, abra Extensões > Apps Script e envie este arquivo e o Index.html.
 *   2. Rode a função "configurar" uma vez. Ela cria a aba "Usuarios" e, numa planilha nova,
 *      o usuário "admin" com uma senha aleatória mostrada no registro de execução.
 *   3. Implantar > Nova implantação > App da Web, executando como "Eu" e com acesso
 *      para "Qualquer pessoa".
 *
 * Aba "Usuarios": uma pessoa por linha.
 *   - Para criar alguém, preencha Usuário e Senha numa linha nova.
 *   - Para trocar a senha, apague a célula da Senha e digite a nova.
 *   - Para remover alguém, apague a linha.
 * A senha digitada é substituída por um hash (começa com "h1$") assim que a célula é editada.
 * A coluna "Chave interna" é preenchida automaticamente e não deve ser editada.
 * A coluna ID é só um rótulo e pode repetir.
 *
 * Os grafos ficam no Drive do dono do app, na pasta "Grafo Studio", numa subpasta por usuário.
 */

const ABA_USUARIOS = 'Usuarios';
const CABECALHO = ['ID', 'Usuário', 'Senha', 'Chave interna (não editar)'];
const PREFIXO_HASH = 'h1$';
const ITERACOES_HASH = 100;
const MAX_FALHAS = 5;
const BLOQUEIO_SEGUNDOS = 10 * 60;
const SESSAO_SEGUNDOS = 6 * 60 * 60;   // máximo permitido pelo CacheService
const DOWNLOAD_SEGUNDOS = 10 * 60;
const PASTA_NOME = 'Grafo Studio';
const PASTA_EXPORT = 'Exportações';
const EXT = '.grafo.json';
const CARACTERES_PROIBIDOS = /[\\/:*?"<>|]/g;

function doGet(e) {
  if (e && e.parameter && e.parameter.baixar) return baixar_(String(e.parameter.baixar));
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Grafo Studio')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}


// Configuração

/** Rode pelo editor. Cria a aba de usuários, aplica hash nas senhas e confere os IDs. */
function configurar() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Este script precisa estar vinculado a uma planilha (Extensões > Apps Script).');
  const abaNova = !ss.getSheetByName(ABA_USUARIOS);
  const senhaInicial = abaNova ? Utilities.getUuid().replace(/-/g, '').slice(0, 10) : null;
  planilha_(senhaInicial);
  pasta_();
  const lista = usuarios_();

  Logger.log('Planilha de usuários: ' + ss.getUrl());
  Logger.log(lista.length + ' usuário(s) ativo(s). Todas as senhas estão embaralhadas.');
  if (senhaInicial) Logger.log('Usuário inicial: admin / ' + senhaInicial + '  (anote: esta senha não aparece em nenhum outro lugar)');

  const contagem = {};
  lista.forEach((u) => { contagem[u.id] = (contagem[u.id] || 0) + 1; });
  Object.keys(contagem)
    .filter((id) => contagem[id] > 1)
    .forEach((id) => Logger.log('Aviso: o ID "' + id + '" aparece ' + contagem[id] + ' vezes. Não causa problema, mas pode confundir quem lê a planilha.'));
}

function planilha_(senhaInicial) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Este script precisa estar vinculado a uma planilha (Extensões > Apps Script).');
  const aba = ss.getSheetByName(ABA_USUARIOS) || ss.insertSheet(ABA_USUARIOS);
  if (aba.getLastRow() === 0) {
    aba.appendRow(CABECALHO);
    if (senhaInicial) aba.appendRow(['1', 'admin', senhaInicial, '']);
    aba.setFrozenRows(1);
  }
  if (String(aba.getRange(1, 4).getValue()) !== CABECALHO[3]) aba.getRange(1, 4).setValue(CABECALHO[3]);
  aba.getRange('A:D').setNumberFormat('@');
  return ss;
}


// Senhas
// Hash = HMAC-SHA256 repetido, com um sal por usuário e uma "pimenta" guardada só nas
// propriedades do script. Quem copiar a planilha não consegue testar senhas fora daqui.

function pimenta_() {
  const props = PropertiesService.getScriptProperties();
  let pimenta = props.getProperty('pimenta');
  if (!pimenta) {
    pimenta = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('pimenta', pimenta);
  }
  return pimenta;
}

function embaralhar_(senha, sal) {
  const pimenta = pimenta_();
  let h = sal + ':' + senha;
  for (let i = 0; i < ITERACOES_HASH; i++) {
    h = Utilities.base64Encode(Utilities.computeHmacSha256Signature(h + senha, pimenta));
  }
  return h;
}

function gerarHash_(senha) {
  const sal = Utilities.getUuid().replace(/-/g, '');
  return PREFIXO_HASH + sal + '$' + embaralhar_(senha, sal);
}

function conferirSenha_(senha, guardado) {
  const partes = String(guardado || '').split('$');
  if (partes.length !== 3 || partes[0] + '$' !== PREFIXO_HASH) return false;
  const calculado = embaralhar_(senha, partes[1]);
  if (calculado.length !== partes[2].length) return false;
  // Comparação em tempo constante.
  let diferenca = 0;
  for (let i = 0; i < calculado.length; i++) diferenca |= calculado.charCodeAt(i) ^ partes[2].charCodeAt(i);
  return diferenca === 0;
}

const ehHash_ = (valor) => String(valor || '').indexOf(PREFIXO_HASH) === 0;


// Usuários

/**
 * Lê a aba de usuários. Antes, se preciso, aplica hash nas senhas digitadas e dá uma
 * Chave interna única a quem não tem uma (ou tem uma repetida).
 */
function usuarios_() {
  const aba = planilha_().getSheetByName(ABA_USUARIOS);
  const linhas = aba.getLastRow() - 1;
  if (linhas < 1) return [];
  const faixa = aba.getRange(2, 1, linhas, 4);
  let dados = faixa.getDisplayValues();

  if (precisaArrumar_(dados)) {
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      dados = faixa.getDisplayValues(); // outra execução pode ter arrumado enquanto esperávamos
      if (arrumar_(dados)) {
        aba.getRange(2, 3, linhas, 2).setValues(dados.map((r) => [r[2], r[3]]));
        SpreadsheetApp.flush();
      }
    } finally {
      lock.releaseLock();
    }
  }

  return dados
    .filter((r) => String(r[1] || '').trim() && ehHash_(r[2]) && r[3])
    .map((r) => ({ id: String(r[0] || '').trim(), usuario: String(r[1]).trim(), hash: r[2], chave: r[3] }));
}

function precisaArrumar_(dados) {
  const vistas = {};
  return dados.some((r) => {
    if (!String(r[1] || '').trim()) return false;
    const repetida = r[3] && vistas[r[3]];
    if (r[3]) vistas[r[3]] = true;
    return (r[2] && !ehHash_(r[2])) || !r[3] || repetida;
  });
}

/** Altera `dados` no lugar e devolve true se mudou alguma coisa. */
function arrumar_(dados) {
  let mudou = false;
  const vistas = {};
  dados.forEach((r) => {
    if (!String(r[1] || '').trim()) return;
    if (r[2] && !ehHash_(r[2])) {
      r[2] = gerarHash_(String(r[2]));
      mudou = true;
    }
    if (!r[3] || vistas[r[3]]) {
      r[3] = Utilities.getUuid();
      herdarDadosAntigos_(String(r[0] || '').trim(), r[3]);
      mudou = true;
    }
    vistas[r[3]] = true;
  });
  return mudou;
}

/**
 * Migração da versão em que a pasta e as preferências eram guardadas pelo ID.
 * Quando uma linha ganha Chave interna, assume o que estava no ID dela e o registro antigo
 * é apagado. Assim, um ID reaproveitado depois nunca encontra os grafos de outra pessoa.
 */
function herdarDadosAntigos_(id, chave) {
  if (!id) return;
  const props = PropertiesService.getScriptProperties();
  [
    ['pasta_u_' + id, 'pasta_c_' + chave],
    ['u_' + id + '_ultimoGrafo', 'c_' + chave + '_ultimoGrafo'],
    ['u_' + id + '_ajudaVista', 'c_' + chave + '_ajudaVista'],
  ].forEach(([antiga, nova]) => {
    const valor = props.getProperty(antiga);
    if (valor !== null) {
      props.setProperty(nova, valor);
      props.deleteProperty(antiga);
    }
  });
}

/** Gatilho simples: aplica hash na senha assim que alguém a digita na aba Usuarios. */
function onEdit(e) {
  try {
    if (!e || !e.range || e.range.getSheet().getName() !== ABA_USUARIOS) return;
    if (e.range.getLastRow() < 2 || e.range.getColumn() > 4 || e.range.getLastColumn() < 2) return;
    usuarios_();
  } catch (err) {
    // Se falhar, o hash é aplicado no próximo login ou ao rodar "configurar".
  }
}


// Sessão

function login(usuario, senha) {
  const nome = String(usuario || '').trim().toLowerCase();
  const texto = String(senha || '');
  if (!nome || !texto) throw new Error('Informe usuário e senha.');

  const cache = CacheService.getScriptCache();
  if (cache.get('bloq_' + nome)) throw new Error('Muitas tentativas erradas. Este usuário está bloqueado por alguns minutos.');

  const achado = usuarios_().find((x) => x.usuario.toLowerCase() === nome && conferirSenha_(texto, x.hash));
  if (!achado) {
    const falhas = Number(cache.get('falhas_' + nome) || 0) + 1;
    if (falhas >= MAX_FALHAS) {
      cache.put('bloq_' + nome, '1', BLOQUEIO_SEGUNDOS);
      cache.remove('falhas_' + nome);
    } else {
      cache.put('falhas_' + nome, String(falhas), BLOQUEIO_SEGUNDOS);
    }
    Utilities.sleep(800); // freia tentativas em sequência
    throw new Error('Usuário ou senha incorretos.');
  }

  cache.remove('falhas_' + nome);
  const token = Utilities.getUuid();
  cache.put('sessao_' + token, JSON.stringify({ chave: achado.chave, usuario: achado.usuario }), SESSAO_SEGUNDOS);
  return { token, usuario: achado.usuario };
}

function logout(token) {
  if (token) CacheService.getScriptCache().remove('sessao_' + token);
  return true;
}

/** Valida a sessão, confere se o usuário ainda existe na planilha e renova o prazo. */
function sessao_(token) {
  if (!token) throw new Error('SESSAO_EXPIRADA');
  const cache = CacheService.getScriptCache();
  const raw = cache.get('sessao_' + token);
  if (!raw) throw new Error('SESSAO_EXPIRADA');
  const s = JSON.parse(raw);
  const ativo = s.chave && usuarios_().some((x) => x.chave === s.chave && x.usuario === s.usuario);
  if (!ativo) {
    cache.remove('sessao_' + token);
    throw new Error('SESSAO_EXPIRADA');
  }
  cache.put('sessao_' + token, raw, SESSAO_SEGUNDOS);
  return s;
}

function pref_(s, chave, valor) {
  const props = PropertiesService.getScriptProperties();
  const k = 'c_' + s.chave + '_' + chave;
  if (valor === undefined) return props.getProperty(k);
  if (valor === null) props.deleteProperty(k);
  else props.setProperty(k, String(valor));
}


// Pastas e arquivos

function pasta_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('pastaId');
  if (id) {
    try {
      const f = DriveApp.getFolderById(id);
      if (!f.isTrashed()) return f;
    } catch (e) { /* pasta removida: cria ou reencontra abaixo */ }
  }
  const it = DriveApp.getFoldersByName(PASTA_NOME);
  const pasta = it.hasNext() ? it.next() : DriveApp.createFolder(PASTA_NOME);
  props.setProperty('pastaId', pasta.getId());
  return pasta;
}

/**
 * Subpasta exclusiva de cada usuário, escolhida pela Chave interna. Nunca procura pelo
 * nome, para que uma pasta antiga com nome parecido não seja entregue a outra pessoa.
 */
function pastaUsuario_(s) {
  const props = PropertiesService.getScriptProperties();
  const k = 'pasta_c_' + s.chave;
  const id = props.getProperty(k);
  if (id) {
    try {
      const f = DriveApp.getFolderById(id);
      if (!f.isTrashed()) return f;
    } catch (e) { /* pasta removida: cria outra abaixo */ }
  }
  const nome = 'usuario-' + String(s.usuario).replace(CARACTERES_PROIBIDOS, '-') + '-' + s.chave.slice(0, 8);
  const pasta = pasta_().createFolder(nome);
  props.setProperty(k, pasta.getId());
  return pasta;
}

function subpasta_(pai, nome) {
  const it = pai.getFoldersByName(nome);
  return it.hasNext() ? it.next() : pai.createFolder(nome);
}

/** Abre um grafo garantindo que ele pertence ao usuário logado. */
function arquivo_(s, id) {
  let f;
  try { f = DriveApp.getFileById(id); } catch (e) { throw new Error('Grafo não encontrado.'); }
  if (f.isTrashed()) throw new Error('Este grafo foi apagado.');
  const pastaId = pastaUsuario_(s).getId();
  const pais = f.getParents();
  while (pais.hasNext()) {
    if (pais.next().getId() === pastaId) return f;
  }
  throw new Error('Grafo não encontrado.');
}

const nomeArquivo_ = (nome) => String(nome || 'Meu grafo').replace(CARACTERES_PROIBIDOS, '-').slice(0, 120) + EXT;
const lerGrafo_ = (f) => f.getBlob().getDataAsString('UTF-8');

function gravar_(f, g) {
  const nome = String(g.name || 'Meu grafo').slice(0, 120);
  g.name = nome;
  g.updatedAt = new Date().toISOString();
  f.setContent(JSON.stringify(g, null, 2));
  f.setName(nomeArquivo_(nome));
  f.setDescription(JSON.stringify({ name: nome, pieces: g.nodes.length, wires: g.edges.length }));
}


// Funções chamadas pela página. Todas recebem o token da sessão como primeiro argumento.

function bootstrap(token) {
  const s = sessao_(token);
  const ultimo = pref_(s, 'ultimoGrafo');
  let graph = null;
  if (ultimo) {
    try { graph = lerGrafo_(arquivo_(s, ultimo)); } catch (e) { pref_(s, 'ultimoGrafo', null); }
  }
  return { email: s.usuario, graph, helpSeen: pref_(s, 'ajudaVista') === '1' };
}

function markHelpSeen(token) {
  pref_(sessao_(token), 'ajudaVista', '1');
  return true;
}

function listGraphs(token) {
  const s = sessao_(token);
  const it = pastaUsuario_(s).getFiles();
  const lista = [];
  while (it.hasNext()) {
    const f = it.next();
    if (f.isTrashed() || f.getName().slice(-EXT.length) !== EXT) continue;
    let meta = {};
    try { meta = JSON.parse(f.getDescription() || '{}'); } catch (e) { /* descrição inválida */ }
    lista.push({
      id: f.getId(),
      name: meta.name || f.getName().slice(0, -EXT.length),
      updatedAt: f.getLastUpdated().toISOString(),
      pieces: meta.pieces || 0,
      wires: meta.wires || 0,
    });
  }
  return lista.sort((a, b) => (b.updatedAt < a.updatedAt ? -1 : 1));
}

function loadGraph(token, id) {
  const s = sessao_(token);
  const texto = lerGrafo_(arquivo_(s, id));
  pref_(s, 'ultimoGrafo', id);
  return texto;
}

function saveGraph(token, json) {
  const s = sessao_(token);
  if (typeof json !== 'string' || json.length > 5000000) throw new Error('Grafo grande demais ou inválido.');
  const g = JSON.parse(json);
  if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) throw new Error('Grafo inválido.');
  let f;
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
  const s = sessao_(token);
  const f = arquivo_(s, id);
  const g = JSON.parse(lerGrafo_(f));
  g.name = String(nome || '').trim() || 'Meu grafo';
  gravar_(f, g);
  return { id, name: g.name };
}

function duplicateGraph(token, id) {
  const s = sessao_(token);
  const g = JSON.parse(lerGrafo_(arquivo_(s, id)));
  g.name = 'Cópia de ' + (g.name || 'Meu grafo');
  g.createdAt = new Date().toISOString();
  const f = pastaUsuario_(s).createFile(nomeArquivo_(g.name), '{}', 'application/json');
  g.id = f.getId();
  gravar_(f, g);
  return { id: g.id, name: g.name };
}

function deleteGraph(token, id) {
  const s = sessao_(token);
  arquivo_(s, id).setTrashed(true);
  if (pref_(s, 'ultimoGrafo') === id) pref_(s, 'ultimoGrafo', null);
  return true;
}

function forgetCurrent(token) {
  pref_(sessao_(token), 'ultimoGrafo', null);
  return true;
}


// Download de exportações
// O arquivo fica privado no Drive do dono do app. O usuário recebe um endereço com um
// código aleatório que vence em poucos minutos; nada é compartilhado por link público.

function prepararDownload(token, nomeArquivo, conteudo) {
  const s = sessao_(token);
  const nome = String(nomeArquivo || 'grafo.txt').replace(CARACTERES_PROIBIDOS, '-').slice(0, 150);
  const f = subpasta_(pastaUsuario_(s), PASTA_EXPORT).createFile(nome, String(conteudo || ''), MimeType.PLAIN_TEXT);
  const codigo = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  CacheService.getScriptCache().put('dl_' + codigo, JSON.stringify({ arquivo: f.getId(), nome }), DOWNLOAD_SEGUNDOS);
  return { url: ScriptApp.getService().getUrl() + '?baixar=' + codigo, name: nome, minutos: Math.round(DOWNLOAD_SEGUNDOS / 60) };
}

function baixar_(codigo) {
  const raw = /^[0-9a-f]{64}$/.test(codigo) ? CacheService.getScriptCache().get('dl_' + codigo) : null;
  if (!raw) {
    return HtmlService.createHtmlOutput(
      '<body style="margin:0;background:#13161b;color:#e3e6eb;font:15px/1.5 system-ui,sans-serif">' +
      '<p style="max-width:440px;margin:80px auto;padding:0 24px">Este link de download venceu ou não é válido. ' +
      'Volte ao Grafo Studio e gere outro em Exportar.</p></body>').setTitle('Link vencido');
  }
  const d = JSON.parse(raw);
  const conteudo = DriveApp.getFileById(d.arquivo).getBlob().getDataAsString('UTF-8');
  const tipo = /\.json$/i.test(d.nome) ? ContentService.MimeType.JSON : ContentService.MimeType.TEXT;
  return ContentService.createTextOutput(conteudo).setMimeType(tipo).downloadAsFile(d.nome);
}
