import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
  },
  // Kokoro / Transformers.js / onnxruntime-web all rely on dynamic imports
  // and worker scripts that break under Vite's CommonJS-style pre-bundling,
  // so we let them run through esbuild's regular ESM pipeline instead.
  optimizeDeps: {
    exclude: ['pdfjs-dist', 'kokoro-js', '@huggingface/transformers', 'onnxruntime-web'],
  },
});
