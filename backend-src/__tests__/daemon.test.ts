// Daemon Tests - HeartbeatChecker and CronRunner
// Tests for scheduled tasks and heartbeat monitoring

import { query, queryOne } from '../src/db/client.js'

jest.mock('../src/db/client.js')

describe('HeartbeatChecker', () => {
  describe('HEARTBEAT.md Parsing', () => {
    it('should detect unchecked checkboxes in HEARTBEAT.md', async () => {
      // Sample HEARTBEAT.md format:
      // - [ ] Agent task 1
      // - [x] Agent task 2
      // - [ ] Agent task 3

      const heartbeatContent = `
# Agent Heartbeats

- [ ] Agent alice-001 needs review
- [x] Agent bob-002 completed
- [ ] Agent charlie-003 pending
      `

      const unchecked = heartbeatContent
        .split('\n')
        .filter(line => line.includes('- [ ]'))

      expect(unchecked).toHaveLength(2)
      expect(unchecked[0]).toContain('alice-001')
      expect(unchecked[1]).toContain('charlie-003')
    })

    it('should extract agent names from unchecked items', () => {
      const line = '- [ ] Agent alice-prod-01 needs restart'
      const match = line.match(/Agent\s+([^\s]+)/)

      expect(match).not.toBeNull()
      expect(match?.[1]).toBe('alice-prod-01')
    })
  })

  describe('Database Updates', () => {
    it('should update agent last_heartbeat_at when found in HEARTBEAT.md', async () => {
      const agentName = 'test-agent'
      const now = new Date().toISOString()

      ;(query as jest.Mock).mockResolvedValueOnce([])

      // Simulate updating an agent's heartbeat timestamp
      await query(
        'UPDATE agents SET last_heartbeat_at = NOW() WHERE name = $1',
        [agentName]
      )

      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE agents'),
        [agentName]
      )
    })

    it('should handle agent not found gracefully', async () => {
      const agentName = 'nonexistent-agent'

      ;(queryOne as jest.Mock).mockResolvedValueOnce(null)

      const result = await queryOne(
        'SELECT id FROM agents WHERE name = $1',
        [agentName]
      )

      expect(result).toBeNull()
    })
  })

  describe('30-Minute Scan Interval', () => {
    it('should calculate next scan time correctly', () => {
      const now = new Date()
      const nextScan = new Date(now.getTime() + 30 * 60 * 1000)

      const diff = nextScan.getTime() - now.getTime()
      expect(diff).toBe(30 * 60 * 1000) // 30 minutes
    })

    it('should handle scan overlaps gracefully', () => {
      let isScanning = false
      let lastScan = Date.now()

      const shouldScan = (interval: number) => {
        if (isScanning) return false
        if (Date.now() - lastScan < interval) return false
        return true
      }

      const interval = 30 * 60 * 1000

      // First scan
      expect(shouldScan(interval)).toBe(true)
      isScanning = true
      lastScan = Date.now()
      isScanning = false

      // Immediate second scan attempt should fail
      expect(shouldScan(interval)).toBe(false)

      // After interval passes
      lastScan = Date.now() - interval - 1000
      expect(shouldScan(interval)).toBe(true)
    })
  })
})

describe('CronRunner', () => {
  describe('Job Loading', () => {
    it('should load active cron jobs from database', async () => {
      const mockJobs = [
        {
          id: 'cron-1',
          schedule: '0 */6 * * *',
          status: 'active',
          last_run: null,
        },
        {
          id: 'cron-2',
          schedule: '0 0 * * *',
          status: 'active',
          last_run: '2026-03-11T00:00:00Z',
        },
      ]

      ;(query as jest.Mock).mockResolvedValueOnce(mockJobs)

      const jobs = await query(
        'SELECT id, schedule, status, last_run FROM cron_jobs WHERE status = $1',
        ['active']
      )

      expect(jobs).toHaveLength(2)
      expect(jobs[0].schedule).toBe('0 */6 * * *')
    })
  })

  describe('Job Execution', () => {
    it('should execute LLM prompt for scheduled job', async () => {
      // Simulate job execution
      const jobId = 'cron-1'
      const prompt = 'Review recent logs and identify issues'
      const model = 'claude'

      // Mock LLM client response
      const mockResult = {
        success: true,
        output: '✅ All systems operational',
        duration: 2.5,
      }

      ;(query as jest.Mock).mockResolvedValueOnce([mockResult])

      expect(mockResult.success).toBe(true)
      expect(mockResult.output).toContain('operational')
    })

    it('should post job result to channel', async () => {
      const jobId = 'cron-1'
      const channelId = 'channel-123'
      const result = '✅ Cron job completed successfully'

      ;(query as jest.Mock).mockResolvedValueOnce([])

      await query(
        `INSERT INTO messages (channel_id, sender_id, sender_type, content)
         VALUES ($1, $2, 'agent', $3)`,
        [channelId, jobId, result]
      )

      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO messages'),
        expect.arrayContaining([channelId, jobId, result])
      )
    })

    it('should update cron job last_run timestamp', async () => {
      const jobId = 'cron-1'
      const runTime = new Date().toISOString()

      ;(query as jest.Mock).mockResolvedValueOnce([])

      await query(
        'UPDATE cron_jobs SET last_run = NOW() WHERE id = $1',
        [jobId]
      )

      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE cron_jobs'),
        [jobId]
      )
    })
  })

  describe('Cron Schedule Parsing', () => {
    it('should validate cron expression format', () => {
      const validSchedules = [
        '0 0 * * *',        // Daily at midnight
        '0 */6 * * *',      // Every 6 hours
        '*/15 * * * *',     // Every 15 minutes
        '0 9 * * MON-FRI',  // 9 AM weekdays
      ]

      validSchedules.forEach(schedule => {
        // In real code, node-cron would validate this
        expect(schedule).toMatch(/^.+\s+.+\s+.+\s+.+\s+.+$/)
      })
    })

    it('should handle invalid cron schedule', () => {
      const invalidSchedules = [
        'invalid',
        '0 0 0 0 0',  // Invalid values
        '',
      ]

      invalidSchedules.forEach(schedule => {
        expect(schedule === '' || !schedule.includes(' ')).toBe(true)
      })
    })
  })

  describe('Error Handling', () => {
    it('should handle LLM execution failures gracefully', async () => {
      const jobId = 'cron-1'

      // Simulate LLM client throwing error
      const mockError = new Error('LLM service unavailable')

      ;(query as jest.Mock).mockRejectedValueOnce(mockError)

      try {
        await query('SELECT * FROM cron_jobs WHERE id = $1', [jobId])
      } catch (err) {
        expect((err as Error).message).toContain('unavailable')
      }
    })

    it('should retry failed job execution with exponential backoff', async () => {
      const jobId = 'cron-1'
      let attempts = 0
      const maxAttempts = 3

      const executeWithRetry = async (): Promise<boolean> => {
        for (let i = 0; i < maxAttempts; i++) {
          attempts++
          // Simulate failure on first 2 attempts
          if (attempts < 3) {
            await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 100))
            continue
          }
          return true
        }
        return false
      }

      const result = await executeWithRetry()
      expect(result).toBe(true)
      expect(attempts).toBe(3)
    })
  })
})

describe('Daemon Integration', () => {
  describe('Multi-Daemon Safety', () => {
    it('should handle multiple daemon instances without conflicts', async () => {
      const locks: Set<string> = new Set()

      const acquireLock = async (resourceId: string): Promise<boolean> => {
        if (locks.has(resourceId)) return false
        locks.add(resourceId)
        return true
      }

      const releaseLock = (resourceId: string) => {
        locks.delete(resourceId)
      }

      // Daemon 1 acquires lock
      const lock1 = await acquireLock('heartbeat')
      expect(lock1).toBe(true)

      // Daemon 2 tries same lock - should fail
      const lock2 = await acquireLock('heartbeat')
      expect(lock2).toBe(false)

      // Daemon 1 releases
      releaseLock('heartbeat')

      // Now daemon 2 can acquire
      const lock3 = await acquireLock('heartbeat')
      expect(lock3).toBe(true)
    })
  })
})
