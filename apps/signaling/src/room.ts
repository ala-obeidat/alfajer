// Using a generic type for WebSocket to make it testable without Elysia's specific WS implementation
export class RoomManager<T> {
  // We store the WebSockets in a Set. 
  // To mark as "sealed" when 2 peers join, we just check the size of the set.
  // Wait, if we want to "mark the room as sealed", checking `set.size >= 2` is sufficient.
  // But to be robust, we can just use the Set size.
  private rooms: Map<string, Set<T>> = new Map();

  joinRoom(roomId: string, ws: T): boolean {
    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, new Set());
    }

    const room = this.rooms.get(roomId)!;

    if (room.size >= 2) {
      // Room is sealed
      return false;
    }

    room.add(ws);
    return true;
  }

  leaveRoom(roomId: string, ws: T) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    if (room.has(ws)) {
      // "On disconnect of either peer, purge the room entry immediately."
      this.rooms.delete(roomId);
    }
  }

  getPeers(roomId: string): Set<T> | undefined {
    return this.rooms.get(roomId);
  }

  getRoomCount(): number {
    return this.rooms.size;
  }
}

export const roomManager = new RoomManager();
