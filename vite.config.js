import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  root: 'src',                          // o código-fonte fica em src/
  plugins: [react(), viteSingleFile()], // entende React e junta tudo em 1 arquivo
  build: {
    outDir: '../apps-script',           // entrega o resultado em apps-script/
    emptyOutDir: false,                 // NÃO apaga Code.js e os outros
    rollupOptions: { input: 'src/Index.html' },
  },
});