// Minimal Socket.IO v4 client over k6/ws (Engine.IO protocol 4, WebSocket transport only).
// Frames: "0{…}" open, "2"/"3" ping/pong, "40/ns,{auth}" connect, "42/ns,[event,data]"
// event, "42/ns,<id>[…]" emit with ack, "43/ns,<id>[…]" ack, "44/ns,{…}" connect error.
import ws from 'k6/ws';
import { BASE_URL, ORIGINS } from './common.js';

const NAMESPACES = { CUSTOMER: '/customer', RESTAURANT: '/restaurant', DELIVERY: '/delivery' };

/**
 * Opens a socket for `app` with an access token and calls `onReady(io)` once the
 * namespace is connected. `io.emit(event, data, onAck?)`, `io.on(event, fn)`,
 * `io.close()`. Returns the k6/ws response (status 101 on success).
 */
export function connect(app, token, { onReady, onError, timeoutMs = 60_000 } = {}) {
  const ns = NAMESPACES[app];
  const url = `${BASE_URL.replace(/^http/, 'ws')}/socket.io/?EIO=4&transport=websocket`;
  return ws.connect(url, { headers: { Origin: ORIGINS[app] } }, (socket) => {
    const handlers = {};
    const acks = {};
    let nextAck = 1;
    const io = {
      socket,
      emit(event, data, onAck) {
        const id = onAck ? nextAck++ : '';
        if (onAck) acks[id] = onAck;
        socket.send(`42${ns},${id}${JSON.stringify([event, data])}`);
      },
      on(event, fn) {
        handlers[event] = fn;
      },
      close() {
        socket.close();
      },
    };
    socket.on('message', (msg) => {
      if (msg === '2') return socket.send('3'); // heartbeat
      if (msg.startsWith('0')) return socket.send(`40${ns},${JSON.stringify({ token })}`);
      if (msg.startsWith(`40${ns},`)) return onReady && onReady(io);
      if (msg.startsWith(`44${ns},`)) {
        if (onError) onError(JSON.parse(msg.slice(ns.length + 3)));
        return socket.close();
      }
      if (msg.startsWith(`43${ns},`)) {
        const body = msg.slice(ns.length + 3);
        const at = body.indexOf('[');
        const id = body.slice(0, at);
        const cb = acks[id];
        delete acks[id];
        if (cb) cb(...JSON.parse(body.slice(at)));
        return undefined;
      }
      if (msg.startsWith(`42${ns},`)) {
        const [event, data] = JSON.parse(msg.slice(ns.length + 3));
        if (handlers[event]) handlers[event](data);
        if (handlers['*']) handlers['*'](event, data);
      }
      return undefined;
    });
    socket.setTimeout(() => socket.close(), timeoutMs);
  });
}
