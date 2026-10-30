import {
  pgTable,
  serial,
  text,
  varchar,
  integer,
  boolean,
  timestamp,
  pgEnum,
  index,
  uniqueIndex,
  customType,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

// Custom bytea column definition for binary storage in PostgreSQL
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
  toDriver(val: Buffer): Buffer {
    return val;
  },
  fromDriver(val: unknown): Buffer {
    return Buffer.isBuffer(val) ? val : Buffer.from(val as any);
  },
});

// Enums
export const storageModeEnum = pgEnum('storage_mode', ['fallback']);
export const storageProviderEnum = pgEnum('storage_provider', ['google_photos', 'supabase', 'local', 'database']);
export const uploadStatusEnum = pgEnum('upload_status', ['pending', 'success', 'failed']);

// Users table
export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    email: varchar('email', { length: 255 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    avatarUrl: text('avatar_url'),
    avatarData: bytea('avatar_data'),
    avatarMimeType: varchar('avatar_mime_type', { length: 50 }),
    passwordHash: text('password_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('users_email_idx').on(table.email),
    uniqueIndex('users_password_email_unique_idx')
      .on(sql`lower(${table.email})`)
      .where(sql`${table.passwordHash} IS NOT NULL`),
  ]
);

// Events table
export const events = pgTable(
  'events',
  {
    id: serial('id').primaryKey(),
    uuid: varchar('uuid', { length: 36 }).notNull().unique(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: 255 }).notNull(),
    description: text('description'),
    eventDate: timestamp('event_date', { withTimezone: true }),
    startDate: timestamp('start_date', { withTimezone: true }),
    endDate: timestamp('end_date', { withTimezone: true }),
    storageMode: storageModeEnum('storage_mode').default('fallback').notNull(),
    isActive: boolean('is_active').default(true).notNull(),
    photoCount: integer('photo_count').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('events_uuid_idx').on(table.uuid),
    index('events_user_id_idx').on(table.userId),
    index('events_is_active_idx').on(table.isActive),
  ]
);

// Photos table
export const photos = pgTable(
  'photos',
  {
    id: serial('id').primaryKey(),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    originalFilename: varchar('original_filename', { length: 255 }).notNull(),
    storedFilename: varchar('stored_filename', { length: 255 }).notNull(),
    storagePath: text('storage_path').notNull(),
    storageProvider: storageProviderEnum('storage_provider').notNull(),
    mimeType: varchar('mime_type', { length: 100 }).notNull(),
    fileSize: integer('file_size').notNull(),
    fileHash: varchar('file_hash', { length: 64 }),
    fileData: bytea('file_data'),
    thumbnailData: bytea('thumbnail_data'),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).defaultNow().notNull(),
    uploadStatus: uploadStatusEnum('upload_status').default('pending').notNull(),
    errorMessage: text('error_message'),
  },
  (table) => [
    index('photos_event_id_idx').on(table.eventId),
    index('photos_file_hash_idx').on(table.eventId, table.fileHash),
    index('photos_upload_status_idx').on(table.uploadStatus),
  ]
);

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  events: many(events),
}));

export const eventsRelations = relations(events, ({ one, many }) => ({
  user: one(users, {
    fields: [events.userId],
    references: [users.id],
  }),
  photos: many(photos),
}));

export const photosRelations = relations(photos, ({ one }) => ({
  event: one(events, {
    fields: [photos.eventId],
    references: [events.id],
  }),
}));

// Inferred Types
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;

export type Photo = typeof photos.$inferSelect;
export type NewPhoto = typeof photos.$inferInsert;
