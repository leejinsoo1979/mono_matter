import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({plugins:[react()],server:{host:'127.0.0.1',port:5188,strictPort:true,proxy:{'/api':'http://127.0.0.1:4388','/uploads':'http://127.0.0.1:4388'}},build:{chunkSizeWarningLimit:1800}});
