import { queryOne } from '../db/client.js'

export interface ReservedTaskNumbers {
  first: number
  last: number
}

export async function reserveTaskNumbers(channelId: string, count: number): Promise<ReservedTaskNumbers> {
  if (count <= 0) {
    throw new Error('count must be greater than 0')
  }

  const row = await queryOne<{ last_num: number }>(
    `INSERT INTO task_sequences (channel_id, last_num)
     VALUES (
       $1,
       COALESCE((SELECT MAX(number) FROM tasks WHERE channel_id = $1), 0) + $2
     )
     ON CONFLICT (channel_id) DO UPDATE
       SET last_num = GREATEST(
         task_sequences.last_num,
         COALESCE((SELECT MAX(number) FROM tasks WHERE channel_id = $1), 0)
       ) + $2
     RETURNING last_num`,
    [channelId, count]
  )

  const last = Number(row?.last_num ?? count)
  return {
    first: last - count + 1,
    last,
  }
}
