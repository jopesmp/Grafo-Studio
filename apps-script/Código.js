// Code.gs
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Graph Builder')
    .addItem('Abrir editor', 'abrirEditor').addToUi();
}
function abrirEditor() {
  const html = HtmlService.createHtmlOutputFromFile('Index')
    .setWidth(1400).setHeight(850);
  SpreadsheetApp.getUi().showModalDialog(html, 'Graph Builder');
}