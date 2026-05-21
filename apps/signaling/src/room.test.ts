import { describe, it, expect, beforeEach } from 'vitest';
import { RoomManager } from './room';

describe('RoomManager', () => {
  let manager: RoomManager<string>;

  beforeEach(() => {
    manager = new RoomManager<string>();
  });

  it('should allow two peers to join a room', () => {
    const ws1 = 'ws1';
    const ws2 = 'ws2';
    
    expect(manager.joinRoom('room1', ws1)).toBe(true);
    expect(manager.joinRoom('room1', ws2)).toBe(true);
    
    const peers = manager.getPeers('room1');
    expect(peers?.size).toBe(2);
    expect(peers?.has(ws1)).toBe(true);
    expect(peers?.has(ws2)).toBe(true);
  });

  it('should reject a third peer from joining a sealed room', () => {
    const ws1 = 'ws1';
    const ws2 = 'ws2';
    const ws3 = 'ws3';
    
    manager.joinRoom('room1', ws1);
    manager.joinRoom('room1', ws2);
    
    expect(manager.joinRoom('room1', ws3)).toBe(false);
    expect(manager.getPeers('room1')?.size).toBe(2);
  });

  it('should purge the room entirely when one peer leaves', () => {
    const ws1 = 'ws1';
    const ws2 = 'ws2';
    
    manager.joinRoom('room1', ws1);
    manager.joinRoom('room1', ws2);
    
    manager.leaveRoom('room1', ws1);
    
    expect(manager.getPeers('room1')).toBeUndefined();
    expect(manager.getRoomCount()).toBe(0);
  });
});
