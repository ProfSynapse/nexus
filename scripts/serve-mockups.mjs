import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const rootDir = path.resolve('docs/mockups');
const requestedEntry = process.argv[2] || 'audio-editor-leaf-view.html';
const port = Number(process.env.PORT || 4173);
const host = '127.0.0.1';

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8'
};

function resolvePath(urlPath) {
  const cleanPath = urlPath === '/' ? `/${requestedEntry}` : urlPath;
  const absolutePath = path.resolve(rootDir, `.${cleanPath}`);
  if (!absolutePath.startsWith(rootDir)) {
    return null;
  }
  return absolutePath;
}

const server = http.createServer(async (request, response) => {
  const url = request.url || '/';
  const filePath = resolvePath(url);

  if (!filePath) {
    response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Forbidden');
    return;
  }

  try {
    const data = await fs.readFile(filePath);
    const extension = path.extname(filePath);
    response.writeHead(200, {
      'Content-Type': mimeTypes[extension] || 'application/octet-stream'
    });
    response.end(data);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
});

server.listen(port, host, () => {
  console.log(`Mockups server running at http://${host}:${port}/${requestedEntry}`);
});
