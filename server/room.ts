/**
 * A collaboration room on the relay server.
 *
 * The server is just another replica that never authors mutations. It keeps
 * the merged state and the delta log so that peers which are never online at
 * the same time can still exchange updates (store-and-forward). The room has
 * no WebSocket dependency, so tests drive it with in-memory peers.
 */
import { DeltaLog } from "../src/core/crdt/deltaLog";
import { materializeBoard } from "../src/core/crdt/view";
import { WorkspaceDoc } from "../src/core/crdt/workspaceDoc";
import type { BoardView, CausalContext, Delta, NodeId } from "../src/core/crdt/types";
import type { ServerMessage } from "../src/core/network/protocol";

/** A connected client, as seen by a room. */
export interface PeerConnection {
  readonly id: NodeId;
  send(message: ServerMessage): void;
}

export interface RoomSummary {
  readonly id: string;
  readonly peers: readonly NodeId[];
  readonly logSize: number;
  readonly context: CausalContext;
  readonly board: BoardView;
}

export const SERVER_NODE_ID = "relay";

export class Room {
  private readonly replica = new WorkspaceDoc({ nodeId: SERVER_NODE_ID });
  private readonly log = new DeltaLog();
  private readonly peers = new Set<PeerConnection>();

  constructor(readonly id: string) {}

  /**
   * Handshake step 1. The peer announces its causal context, and we reply
   * with every logged delta it hasn't seen plus our own context. The peer
   * uses our context to work out what *it* needs to push back.
   */
  join(peer: PeerConnection, peerContext: CausalContext): void {
    this.peers.add(peer);
    peer.send({ type: "sync", deltas: this.log.missingFrom(peerContext), context: this.replica.context });
    this.broadcastPeers();
  }

  /**
   * Ingests deltas from a peer. Every received dot is acked, including
   * duplicates, so the sender can clear its outbox. Only *new* deltas are
   * fanned out to the other peers.
   */
  receive(from: PeerConnection, deltas: readonly Delta[]): void {
    const fresh: Delta[] = [];
    for (const delta of deltas) {
      if (!this.log.add(delta)) continue;
      this.replica.apply(delta);
      fresh.push(delta);
    }
    from.send({ type: "ack", dots: deltas.map((d) => d.dot) });
    if (fresh.length === 0) return;
    for (const peer of this.peers) {
      if (peer !== from) peer.send({ type: "deltas", deltas: fresh, from: from.id });
    }
  }

  leave(peer: PeerConnection): void {
    if (this.peers.delete(peer)) this.broadcastPeers();
  }

  get peerCount(): number {
    return this.peers.size;
  }

  get context(): CausalContext {
    return this.replica.context;
  }

  summary(): RoomSummary {
    return {
      id: this.id,
      peers: this.peerIds(),
      logSize: this.log.size,
      context: this.replica.context,
      board: materializeBoard(this.replica.state),
    };
  }

  private peerIds(): NodeId[] {
    return [...new Set([...this.peers].map((p) => p.id))].sort();
  }

  private broadcastPeers(): void {
    const peers = this.peerIds();
    for (const peer of this.peers) peer.send({ type: "peers", peers });
  }
}
