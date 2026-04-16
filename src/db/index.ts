import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

const DATABASE_URL = process.env.DATABASE_URL || './local.db';

const sqlite = new Database(DATABASE_URL);
export const db = drizzle(sqlite, { schema });

sqlite.pragma('foreign_keys = ON');

function ensureSchema() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS topics (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      icon TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      is_custom INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY NOT NULL,
      topic_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(topic_id) REFERENCES topics(id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY NOT NULL,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id)
    );
  `);
}

// Seed data for 5 preset topics
const SEED_TOPICS = [
  {
    id: 'lang-learning',
    name: 'Language Learning',
    icon: '📚',
    systemPrompt:
      'You are a friendly language learning companion. Help the user practice conversation in their target language. Correct mistakes gently, explain vocabulary when asked, and keep responses short (1-3 sentences) to encourage practice. Respond in the language the user is learning unless they ask for clarification in their native language.',
    isCustom: false,
  },
  {
    id: 'travelling',
    name: 'Travelling',
    icon: '✈️',
    systemPrompt:
      'You are a helpful travel assistant. Provide practical travel advice including local customs, useful phrases in the local language, recommendations for places to visit, and tips for getting around. Keep responses concise and actionable. Ask clarifying questions about the user\'s destination or travel style if needed.',
    isCustom: false,
  },
  {
    id: 'anime',
    name: 'Anime',
    icon: '🎌',
    systemPrompt:
      'You are a enthusiastic anime fan and conversation partner. Discuss anime series, characters, plot analysis, animation styles, voice acting, and manga. Keep the conversation fun and engaging. Ask about the user\'s favorite anime and recommend new ones based on their tastes. Keep responses short and conversational.',
    isCustom: false,
  },
  {
    id: 'gaming',
    name: 'Gaming',
    icon: '🎮',
    systemPrompt:
      'You are a gaming buddy ready to discuss video games of all genres and platforms. Talk about game mechanics, storylines, strategies, industry news, and recommendations. Ask what games the user is currently playing or looking forward to. Keep responses short and enthusiastic.',
    isCustom: false,
  },
  {
    id: 'custom',
    name: 'Custom',
    icon: '✨',
    systemPrompt:
      'You are a helpful conversational partner tailored to the user\'s custom topic. Keep responses short (1-3 sentences) and engaging.',
    isCustom: false,
  },
];

// Ensure seed topics exist on first import
function seed() {
  const existing = db.select({ id: schema.topics.id }).from(schema.topics).all();
  if (existing.length === 0) {
    db.insert(schema.topics)
      .values(
        SEED_TOPICS.map((t) => ({
          ...t,
          createdAt: new Date(),
        }))
      )
      .run();
    console.log('[db] Seeded 5 preset topics');
  }
}

ensureSchema();
seed();

export { schema };
