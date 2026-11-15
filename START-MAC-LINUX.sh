#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
node -e "const v=process.versions.node.split('.').map(Number); if(v[0]<20 || (v[0]===20 && v[1]<9)){console.error('Node.js 20.9+ is required.'); process.exit(1)}"
if [ ! -d node_modules ]; then npm install; fi
npm run dev
