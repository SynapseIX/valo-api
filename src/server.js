import http from 'node:http';
import { createApp } from './app.js';

const port = Number(process.env.PORT || 3000);
const handler = await createApp();

const server = http.createServer(handler);

server.listen(port, () => {
  console.log(`Listening on ${server.address().port}`);
});
