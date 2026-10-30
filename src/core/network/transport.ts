/**
 * Transport abstraction.
 *
 * The sync engine talks to a `Transport`, never to a WebSocket directly.
 * That keeps the protocol state machine testable with in-memory transports,
 * which can reorder, duplicate or drop messages to simulate a hostile
 * network, and keeps the CRDT core free of I/O.
 */
import { encodeMessage, parseServerMessage, type ClientMessage, type ServerMessage } from "./protocol";

export interface TransportHandlers {
  onOpen(): void;
  onMessage(message: ServerMessage): void;
  onClose(reason: string): void;
}

export interface Transport {
  /** Opens a connection. Handlers fire only for the connection this call created. */
  connect(handlers: TransportHandlers): void;
  /** Sends a message. Returns false if the connection isn't open (the message is dropped). */
  send(message: ClientMessage): boolean;
  /** Closes the current connection *without* firing `onClose` (it's an intentional disconnect). */
  disconnect(): void;
}

/** Minimal slice of the DOM WebSocket the transport relies on (lets tests inject fakes). */
export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

const WS_OPEN = 1;

export class WebSocketTransport implements Transport {
  private socket: WebSocketLike | null = null;

  constructor(
    private readonly url: string,
    private readonly factory: WebSocketFactory = (url) => new WebSocket(url),
  ) {}

  connect(handlers: TransportHandlers): void {
    this.disconnect();
    const socket = this.factory(this.url);
    this.socket = socket;
    // Every handler checks `this.socket === socket`, so events from a stale socket (closed by a fast offline→online toggle) are ignored.
    socket.onopen = (): void => {
      if (this.socket === socket) handlers.onOpen();
    };
    socket.onmessage = (event: MessageEvent): void => {
      if (this.socket !== socket || typeof event.data !== "string") return;
      const message = parseServerMessage(event.data);
      if (message !== null) handlers.onMessage(message);
    };
    socket.onclose = (event: CloseEvent): void => {
      if (this.socket !== socket) return;
      this.socket = null;
      handlers.onClose(event.reason || `socket closed (code ${event.code})`);
    };
    socket.onerror = (): void => {
      // Browsers always follow `error` with `close`, so reconnection is handled there.
    };
  }

  send(message: ClientMessage): boolean {
    if (this.socket === null || this.socket.readyState !== WS_OPEN) return false;
    this.socket.send(encodeMessage(message));
    return true;
  }

  disconnect(): void {
    const socket = this.socket;
    if (socket === null) return;
    this.socket = null;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.close(1000, "client disconnect");
  }
}
