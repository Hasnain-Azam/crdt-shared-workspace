/**
 * Relay / signal server: a WebSocket endpoint plus a small HTTP surface.
 *
 *   ws://host:PORT/?room=<id>   sync protocol (see src/core/network/protocol.ts)
 *   GET /health                 liveness probe
 *   GET /rooms/<id>             JSON summary of a room's merged state (debugging)
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { encodeMessage, parseClientMessage, type ServerMessage } from "../src/core/network/protocol";
import { Room, type PeerConnection } from "./room";

const PORT = Number(process.env.SYNC_PORT ?? process.env.PORT ?? 4000);
const rooms = new Map<string, Room>();

function getRoom(id: string): Room {
  let room = rooms.get(id);
  if (room === undefined) {
    room = new Room(id);
    rooms.set(id, room);
  }
  return room;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
}

function handleHttp(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/health") return sendJson(res, 200, { ok: true, rooms: rooms.size });
  const match = /^\/rooms\/([^/]+)$/.exec(url.pathname);
  if (match?.[1] !== undefined) {
    const room = rooms.get(decodeURIComponent(match[1]));
    return room ? sendJson(res, 200, room.summary()) : sendJson(res, 404, { error: "room not found" });
  }
  sendJson(res, 404, { error: "not found" });
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

function handleConnection(socket: WebSocket): void {
  let session: { readonly room: Room; readonly peer: PeerConnection } | null = null;
  const send = (message: ServerMessage): void => {
    if (socket.readyState === socket.OPEN) socket.send(encodeMessage(message));
  };

  socket.on("message", (data) => {
    const message = parseClientMessage(rawToString(data));
    if (message === null) return send({ type: "error", message: "malformed message" });
    switch (message.type) {
      case "hello": {
        session?.room.leave(session.peer);
        const room = getRoom(message.room);
        const peer: PeerConnection = { id: message.clientId, send };
        session = { room, peer };
        room.join(peer, message.context);
        return;
      }
      case "deltas":
        if (session === null) return send({ type: "error", message: "send hello first" });
        session.room.receive(session.peer, message.deltas);
        return;
      case "ping":
        return send({ type: "pong", t: message.t });
    }
  });

  socket.on("close", () => {
    session?.room.leave(session.peer);
    session = null;
  });
}

const server = createServer(handleHttp);
const wss = new WebSocketServer({ server, maxPayload: 8 * 1024 * 1024 });
wss.on("connection", handleConnection);

server.listen(PORT, () => {
  console.log(`[sync] relay listening on ws://localhost:${PORT}`);
});

function shutdown(): void {
  wss.close();
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
