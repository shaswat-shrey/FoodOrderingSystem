import { connect } from 'node:net';

/** Encodes a command in RESP (enough for SELECT/AUTH/FLUSHDB; no dependency needed). */
const resp = (...args: string[]) =>
  `*${args.length}\r\n${args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join('')}`;

/** Empties one Redis database (the index in the URL path) — never the whole server. */
export function flushRedisDb(url: string): Promise<void> {
  const u = new URL(url);
  const db = u.pathname.slice(1);
  if (!/^\d+$/.test(db)) throw new Error(`Redis URL ${u.host} must name a database index`);
  const commands = [
    ...(u.password ? [resp('AUTH', ...(u.username ? [u.username] : []), u.password)] : []),
    resp('SELECT', db),
    resp('FLUSHDB'),
  ];
  return new Promise((resolve, reject) => {
    const socket = connect(Number(u.port || 6379), u.hostname);
    let reply = '';
    socket.on('connect', () => socket.write(commands.join('')));
    socket.on('data', (chunk) => {
      reply += chunk.toString();
      const lines = reply.split('\r\n').filter(Boolean);
      if (lines.some((l) => l.startsWith('-'))) {
        socket.destroy();
        reject(new Error(`Redis refused: ${reply.trim()}`));
      } else if (lines.length >= commands.length) {
        socket.end();
        resolve();
      }
    });
    socket.on('error', reject);
  });
}
