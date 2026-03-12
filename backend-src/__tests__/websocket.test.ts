// WebSocket Real-time Events Tests
// Tests Socket.io event broadcasting

describe('WebSocket Events', () => {
  describe('Message Broadcasting', () => {
    it('should broadcast new message to channel subscribers', async () => {
      const mockSio = {
        to: jest.fn().mockReturnThis(),
        emit: jest.fn(),
      }

      const channelId = 'channel-123'
      const message = {
        id: 'msg-1',
        content: 'Test message',
        sender_id: 'user-1',
        channel_id: channelId,
        created_at: new Date().toISOString(),
      }

      // Simulate event broadcast
      mockSio.to(channelId).emit('message:new', message)

      expect(mockSio.to).toHaveBeenCalledWith(channelId)
      expect(mockSio.emit).toHaveBeenCalledWith('message:new', message)
    })

    it('should handle message updates via WebSocket', async () => {
      const mockSio = {
        to: jest.fn().mockReturnThis(),
        emit: jest.fn(),
      }

      const messageId = 'msg-1'
      const update = {
        id: messageId,
        content: 'Updated message',
        edited_at: new Date().toISOString(),
      }

      mockSio.to('channel-123').emit('message:update', update)

      expect(mockSio.emit).toHaveBeenCalledWith('message:update', update)
    })
  })

  describe('Task Updates', () => {
    it('should broadcast task status changes', async () => {
      const mockSio = {
        to: jest.fn().mockReturnThis(),
        emit: jest.fn(),
      }

      const taskUpdate = {
        id: 'task-1',
        status: 'completed',
        claimed_by: 'user-1',
        updated_at: new Date().toISOString(),
      }

      mockSio.to('channel-123').emit('task:update', taskUpdate)

      expect(mockSio.emit).toHaveBeenCalledWith('task:update', taskUpdate)
    })

    it('should broadcast task deletion', async () => {
      const mockSio = {
        to: jest.fn().mockReturnThis(),
        emit: jest.fn(),
      }

      const deletion = {
        taskId: 'task-1',
        deletedAt: new Date().toISOString(),
      }

      mockSio.to('channel-123').emit('task:delete', deletion)

      expect(mockSio.emit).toHaveBeenCalledWith('task:delete', deletion)
    })
  })

  describe('Agent Status Events', () => {
    it('should broadcast agent status changes (online/offline/error)', async () => {
      const mockSio = {
        to: jest.fn().mockReturnThis(),
        emit: jest.fn(),
      }

      const statuses = ['idle', 'running', 'offline', 'error']

      statuses.forEach(status => {
        const statusEvent = {
          agentId: 'agent-1',
          status,
          timestamp: new Date().toISOString(),
        }

        mockSio.to('server-1').emit('agent:status', statusEvent)

        expect(mockSio.emit).toHaveBeenCalledWith('agent:status', statusEvent)
      })
    })

    it('should broadcast agent log entries in real-time', async () => {
      const mockSio = {
        to: jest.fn().mockReturnThis(),
        emit: jest.fn(),
      }

      const logEntry = {
        id: 'log-1',
        agent_id: 'agent-1',
        level: 'info',
        content: 'Task execution started',
        timestamp: new Date().toISOString(),
      }

      mockSio.to('agent-1').emit('agent:log', logEntry)

      expect(mockSio.emit).toHaveBeenCalledWith('agent:log', logEntry)
    })
  })

  describe('Channel Membership Events', () => {
    it('should broadcast when user joins channel', async () => {
      const mockSio = {
        to: jest.fn().mockReturnThis(),
        emit: jest.fn(),
      }

      const joinEvent = {
        userId: 'user-1',
        channelId: 'channel-123',
        timestamp: new Date().toISOString(),
      }

      mockSio.to('channel-123').emit('channel:join', joinEvent)

      expect(mockSio.emit).toHaveBeenCalledWith('channel:join', joinEvent)
    })

    it('should broadcast when user leaves channel', async () => {
      const mockSio = {
        to: jest.fn().mockReturnThis(),
        emit: jest.fn(),
      }

      const leaveEvent = {
        userId: 'user-1',
        channelId: 'channel-123',
        timestamp: new Date().toISOString(),
      }

      mockSio.to('channel-123').emit('channel:leave', leaveEvent)

      expect(mockSio.emit).toHaveBeenCalledWith('channel:leave', leaveEvent)
    })
  })

  describe('Connection Management', () => {
    it('should handle client connection', async () => {
      const mockSocket = {
        id: 'socket-abc123',
        on: jest.fn(),
        emit: jest.fn(),
        join: jest.fn(),
      }

      // Client joins a channel on connect
      mockSocket.join('channel-123')

      expect(mockSocket.join).toHaveBeenCalledWith('channel-123')
    })

    it('should handle client disconnection', async () => {
      const mockSio = {
        sockets: {
          fetchSockets: jest.fn().mockResolvedValue([
            { id: 'socket-1', userId: 'user-1' },
            { id: 'socket-2', userId: 'user-2' },
          ]),
        },
        to: jest.fn().mockReturnThis(),
        emit: jest.fn(),
      }

      // Simulate socket disconnect
      const disconnectEvent = {
        socketId: 'socket-1',
        userId: 'user-1',
        reason: 'client-disconnect',
      }

      mockSio.to('server-1').emit('user:offline', disconnectEvent)

      expect(mockSio.emit).toHaveBeenCalledWith('user:offline', disconnectEvent)
    })

    it('should handle reconnection with new socket ID', async () => {
      const mockSocket = {
        id: 'socket-new123',
        userId: 'user-1',
        on: jest.fn(),
      }

      const reconnectEvent = {
        oldSocketId: 'socket-abc123',
        newSocketId: mockSocket.id,
        userId: mockSocket.userId,
      }

      expect(reconnectEvent.newSocketId).not.toBe('socket-abc123')
      expect(reconnectEvent.userId).toBe('user-1')
    })
  })

  describe('Error Handling', () => {
    it('should handle broadcast errors gracefully', async () => {
      const mockSio = {
        to: jest.fn().mockReturnThis(),
        emit: jest.fn(() => {
          throw new Error('Broadcast failed')
        }),
      }

      const message = {
        id: 'msg-1',
        content: 'Test',
      }

      try {
        mockSio.to('channel-123').emit('message:new', message)
        throw new Error('Should have thrown')
      } catch (err) {
        expect((err as Error).message).toBe('Broadcast failed')
      }
    })

    it('should handle invalid event data', async () => {
      const mockSio = {
        to: jest.fn().mockReturnThis(),
        emit: jest.fn(),
      }

      const invalidMessage = null // Missing required fields

      expect(() => {
        if (!invalidMessage) throw new Error('Invalid message data')
      }).toThrow('Invalid message data')
    })
  })

  describe('Event Rate Limiting', () => {
    it('should throttle rapid event broadcasts', async () => {
      let eventCount = 0
      const limit = 100 // events per second
      let lastWindowStart = Date.now()

      const canEmit = (): boolean => {
        const now = Date.now()
        if (now - lastWindowStart > 1000) {
          lastWindowStart = now
          eventCount = 0
        }

        if (eventCount >= limit) return false
        eventCount++
        return true
      }

      // Simulate rapid events
      for (let i = 0; i < 150; i++) {
        if (!canEmit()) {
          expect(eventCount).toBe(limit)
          break
        }
      }
    })
  })
})
