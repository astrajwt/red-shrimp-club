import { randomUUID } from 'crypto'
import { query, queryOne } from './db/client.js'

const LOCAL_USER_EMAIL = process.env.LOCAL_USER_EMAIL ?? 'jwt@local.dev'
const LOCAL_USER_NAME = process.env.LOCAL_USER_NAME ?? 'Jwt2077'

export async function ensureLocalUser(): Promise<{ id: string; email: string; name: string }> {
  let user = await queryOne<{ id: string; email: string; name: string }>(
    'SELECT id, email, name FROM users WHERE email = $1',
    [LOCAL_USER_EMAIL]
  )

  if (!user) {
    const [created] = await query<{ id: string; email: string; name: string }>(
      `INSERT INTO users (name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, email, name`,
      [LOCAL_USER_NAME, LOCAL_USER_EMAIL, 'local-auth-disabled']
    )
    user = created
  }

  let server = await queryOne<{ id: string }>(
    'SELECT server_id AS id FROM server_members WHERE user_id = $1 ORDER BY joined_at LIMIT 1',
    [user.id]
  )

  if (!server) {
    const slug = `local-${randomUUID().slice(0, 8)}`
    const [createdServer] = await query<{ id: string }>(
      `INSERT INTO servers (name, slug, owner_id) VALUES ($1, $2, $3) RETURNING id`,
      [`${user.name}'s workspace`, slug, user.id]
    )
    server = createdServer
    await query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [server.id, user.id]
    )
  }

  let allChannel = await queryOne<{ id: string }>(
    `SELECT id FROM channels WHERE server_id = $1 AND name = 'all' LIMIT 1`,
    [server.id]
  )

  if (!allChannel) {
    const [createdChannel] = await query<{ id: string }>(
      `INSERT INTO channels (server_id, name, description)
       VALUES ($1, 'all', 'General channel for all members')
       RETURNING id`,
      [server.id]
    )
    allChannel = createdChannel
  }

  await query(
    `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [allChannel.id, user.id]
  )

  return user
}
