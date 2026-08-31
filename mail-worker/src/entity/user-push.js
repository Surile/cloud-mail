import { sqliteTable, text, integer} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

const userPush = sqliteTable('user_push', {
	userPushId: integer('user_push_id').primaryKey({ autoIncrement: true }),
	userId: integer('user_id').notNull(),
	channel: text('channel').default('').notNull(),
	secret: text('secret').default('').notNull(),
	status: integer('status').default(0).notNull(),
	copyCode: integer('copy_code').default(0).notNull(),
	createTime: text('create_time').default(sql`CURRENT_TIMESTAMP`).notNull()
});
export default userPush
