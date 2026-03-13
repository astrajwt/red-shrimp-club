/**
 * PostgreSQL 数据库客户端
 *
 * 文件位置: backend-src/src/db/client.ts
 * 核心功能:
 *   1. 创建并导出 PostgreSQL 连接池 (pg Pool)
 *   2. 提供带泛型的 query / queryOne 便捷查询函数
 *
 * 设计说明:
 *   - 单机部署，无 Redis，所有状态持久化在 PostgreSQL 中
 *   - 连接池最大 10 个连接，适合单机 + 少量并发的场景
 *   - 所有数据库配置通过环境变量注入（参见 .env.example）
 */
import pg from 'pg'

const { Pool } = pg

/**
 * 全局数据库连接池
 * 所有模块共享同一个 Pool 实例，pg 内部管理连接复用
 */
export const db = new Pool({
  host:     process.env.DB_HOST     ?? 'localhost',
  port:     Number(process.env.DB_PORT ?? 5432),
  database: process.env.DB_NAME     ?? 'redshrimp',
  user:     process.env.DB_USER     ?? 'postgres',
  password: process.env.DB_PASSWORD ?? '',
  max:      10,  // 最大连接数
})

/**
 * 通用查询函数（返回行数组）
 * @param sql    SQL 语句，支持 $1, $2 等占位符
 * @param params 参数数组，按顺序对应占位符
 * @returns      泛型 T[] 类型的结果行
 */
export async function query<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  const result = await db.query(sql, params)
  return result.rows as T[]
}

/**
 * 查询单行（返回第一行或 null）
 * 适用于 SELECT ... WHERE id = $1 等确定最多返回一行的场景
 * @param sql    SQL 语句
 * @param params 参数数组
 * @returns      第一行数据或 null
 */
export async function queryOne<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<T | null> {
  const rows = await query<T>(sql, params)
  return rows[0] ?? null
}
