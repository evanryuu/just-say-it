import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const topics = sqliteTable('topics', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  icon: text('icon').notNull(),
  systemPrompt: text('system_prompt').notNull(),
  isCustom: integer('is_custom', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
});

export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  topicId: text('topic_id')
    .notNull()
    .references(() => topics.id),
  title: text('title').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
});

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id')
    .notNull()
    .references(() => conversations.id),
  role: text('role', { enum: ['user', 'assistant'] }).notNull(),
  content: text('content').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
});

export type Topic = typeof topics.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
