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
  jsonb,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import type { QRCustomization } from '../utils/qrCustomization.js';

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
export const musicRequestStatusEnum = pgEnum('music_request_status', ['pending', 'approved', 'rejected', 'played']);
// Host review of guest photos: 'pending' photos stay hidden until the owner approves them
export const photoReviewStatusEnum = pgEnum('photo_review_status', ['approved', 'pending']);

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
    role: varchar('role', { length: 50 }).default('user').notNull(),
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
    category: varchar('category', { length: 100 }),
    startAt: timestamp('start_at', { withTimezone: true }),
    endAt: timestamp('end_at', { withTimezone: true }),
    location: text('location'),
    capacity: integer('capacity'),
    coverImage: text('cover_image'),
    backgroundImage: text('background_image'),
    status: varchar('status', { length: 50 }).default('published').notNull(),
    maxEntriesPerInvitation: integer('max_entries_per_invitation').default(1).notNull(),
    eventDate: timestamp('event_date', { withTimezone: true }),
    startDate: timestamp('start_date', { withTimezone: true }),
    endDate: timestamp('end_date', { withTimezone: true }),
    storageMode: storageModeEnum('storage_mode').default('fallback').notNull(),
    isActive: boolean('is_active').default(true).notNull(),
    enableDjPlaylist: boolean('enable_dj_playlist').default(false).notNull(),
    requirePhotoApproval: boolean('require_photo_approval').default(false).notNull(),
    // Owner's QR code / table card design (null until saved for the first time)
    qrCustomization: jsonb('qr_customization').$type<QRCustomization>(),
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
    reviewStatus: photoReviewStatusEnum('review_status').default('approved').notNull(),
    // Why automatic moderation sent the photo to manual review (null when it was not flagged)
    reviewReason: text('review_reason'),
    errorMessage: text('error_message'),
  },
  (table) => [
    index('photos_event_id_idx').on(table.eventId),
    index('photos_file_hash_idx').on(table.eventId, table.fileHash),
    index('photos_upload_status_idx').on(table.uploadStatus),
    index('photos_review_status_idx').on(table.eventId, table.reviewStatus),
  ]
);

// Music Requests table — DJ playlist where guests submit song requests
export const musicRequests = pgTable(
  'music_requests',
  {
    id: serial('id').primaryKey(),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    // Spotify track ID for deduplication and rich metadata
    spotifyTrackId: varchar('spotify_track_id', { length: 64 }),
    title: varchar('title', { length: 255 }).notNull(),
    artist: varchar('artist', { length: 255 }).notNull(),
    albumName: varchar('album_name', { length: 255 }),
    albumArtUrl: text('album_art_url'),
    spotifyPreviewUrl: text('spotify_preview_url'),
    guestName: varchar('guest_name', { length: 100 }),
    status: musicRequestStatusEnum('status').default('pending').notNull(),
    position: integer('position').default(0).notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('music_requests_event_id_idx').on(table.eventId),
    index('music_requests_status_idx').on(table.status),
    uniqueIndex('music_requests_event_spotify_unique')
      .on(table.eventId, table.spotifyTrackId)
      .where(sql`${table.spotifyTrackId} IS NOT NULL`),
  ]
);

// Event Users (Collaborators / Co-organizers)
export const eventUsers = pgTable(
  'event_users',
  {
    id: serial('id').primaryKey(),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 50 }).default('admin').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('event_users_event_id_idx').on(table.eventId),
    index('event_users_user_id_idx').on(table.userId),
    uniqueIndex('event_users_event_user_idx').on(table.eventId, table.userId),
  ]
);

// Event Guests
export const eventGuests = pgTable(
  'event_guests',
  {
    id: serial('id').primaryKey(),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    email: varchar('email', { length: 255 }),
    phone: varchar('phone', { length: 50 }),
    category: varchar('category', { length: 100 }).default('Convidado').notNull(),
    notes: text('notes'),
    externalId: varchar('external_id', { length: 100 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('event_guests_event_id_idx').on(table.eventId),
    index('event_guests_email_idx').on(table.eventId, table.email),
    index('event_guests_phone_idx').on(table.eventId, table.phone),
  ]
);

// Event Invitations
export const eventInvitations = pgTable(
  'event_invitations',
  {
    id: serial('id').primaryKey(),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    guestId: integer('guest_id')
      .notNull()
      .references(() => eventGuests.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
    status: varchar('status', { length: 50 }).default('pending').notNull(),
    maxEntries: integer('max_entries').default(1).notNull(),
    usedEntries: integer('used_entries').default(0).notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('event_invitations_token_hash_idx').on(table.tokenHash),
    index('event_invitations_event_id_idx').on(table.eventId),
    index('event_invitations_guest_id_idx').on(table.guestId),
    index('event_invitations_status_idx').on(table.status),
  ]
);

// Event Readers (Authorized QR Code readers)
export const eventReaders = pgTable(
  'event_readers',
  {
    id: serial('id').primaryKey(),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    active: boolean('active').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('event_readers_event_id_idx').on(table.eventId),
    index('event_readers_user_id_idx').on(table.userId),
    uniqueIndex('event_readers_event_user_idx').on(table.eventId, table.userId),
  ]
);

// Event Checkins
export const eventCheckins = pgTable(
  'event_checkins',
  {
    id: serial('id').primaryKey(),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    invitationId: integer('invitation_id')
      .notNull()
      .references(() => eventInvitations.id, { onDelete: 'cascade' }),
    guestId: integer('guest_id')
      .notNull()
      .references(() => eventGuests.id, { onDelete: 'cascade' }),
    readerUserId: integer('reader_user_id').references(() => users.id, { onDelete: 'set null' }),
    deviceIdentifier: varchar('device_identifier', { length: 255 }),
    checkedInAt: timestamp('checked_in_at', { withTimezone: true }).defaultNow().notNull(),
    result: varchar('result', { length: 50 }).notNull(),
  },
  (table) => [
    index('event_checkins_event_id_idx').on(table.eventId),
    index('event_checkins_invitation_id_idx').on(table.invitationId),
    index('event_checkins_guest_id_idx').on(table.guestId),
    index('event_checkins_reader_user_id_idx').on(table.readerUserId),
    index('event_checkins_checked_in_at_idx').on(table.checkedInAt),
  ]
);

// Invitation Deliveries
export const invitationDeliveries = pgTable(
  'invitation_deliveries',
  {
    id: serial('id').primaryKey(),
    invitationId: integer('invitation_id')
      .notNull()
      .references(() => eventInvitations.id, { onDelete: 'cascade' }),
    channel: varchar('channel', { length: 50 }).notNull(),
    destination: varchar('destination', { length: 255 }).notNull(),
    status: varchar('status', { length: 50 }).default('pending').notNull(),
    providerMessageId: varchar('provider_message_id', { length: 255 }),
    attempts: integer('attempts').default(0).notNull(),
    errorMessage: text('error_message'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('invitation_deliveries_invitation_id_idx').on(table.invitationId),
    index('invitation_deliveries_channel_status_idx').on(table.channel, table.status),
  ]
);

// Event Audit Logs
export const eventAuditLogs = pgTable(
  'event_audit_logs',
  {
    id: serial('id').primaryKey(),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
    action: varchar('action', { length: 100 }).notNull(),
    entityType: varchar('entity_type', { length: 100 }).notNull(),
    entityId: integer('entity_id'),
    metadata: jsonb('metadata'),
    ipAddress: varchar('ip_address', { length: 45 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('event_audit_logs_event_id_idx').on(table.eventId),
    index('event_audit_logs_user_id_idx').on(table.userId),
    index('event_audit_logs_action_idx').on(table.action),
    index('event_audit_logs_created_at_idx').on(table.createdAt),
  ]
);

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  events: many(events),
  eventUsers: many(eventUsers),
  eventReaders: many(eventReaders),
  auditLogs: many(eventAuditLogs),
  passwordResetTokens: many(passwordResetTokens),
}));

export const eventsRelations = relations(events, ({ one, many }) => ({
  user: one(users, {
    fields: [events.userId],
    references: [users.id],
  }),
  photos: many(photos),
  musicRequests: many(musicRequests),
  eventUsers: many(eventUsers),
  guests: many(eventGuests),
  invitations: many(eventInvitations),
  readers: many(eventReaders),
  checkins: many(eventCheckins),
  auditLogs: many(eventAuditLogs),
}));

export const photosRelations = relations(photos, ({ one }) => ({
  event: one(events, {
    fields: [photos.eventId],
    references: [events.id],
  }),
}));

export const musicRequestsRelations = relations(musicRequests, ({ one }) => ({
  event: one(events, {
    fields: [musicRequests.eventId],
    references: [events.id],
  }),
}));

export const eventUsersRelations = relations(eventUsers, ({ one }) => ({
  event: one(events, {
    fields: [eventUsers.eventId],
    references: [events.id],
  }),
  user: one(users, {
    fields: [eventUsers.userId],
    references: [users.id],
  }),
}));

export const eventGuestsRelations = relations(eventGuests, ({ one, many }) => ({
  event: one(events, {
    fields: [eventGuests.eventId],
    references: [events.id],
  }),
  invitations: many(eventInvitations),
  checkins: many(eventCheckins),
}));

export const eventInvitationsRelations = relations(eventInvitations, ({ one, many }) => ({
  event: one(events, {
    fields: [eventInvitations.eventId],
    references: [events.id],
  }),
  guest: one(eventGuests, {
    fields: [eventInvitations.guestId],
    references: [eventGuests.id],
  }),
  deliveries: many(invitationDeliveries),
  checkins: many(eventCheckins),
}));

export const eventReadersRelations = relations(eventReaders, ({ one }) => ({
  event: one(events, {
    fields: [eventReaders.eventId],
    references: [events.id],
  }),
  user: one(users, {
    fields: [eventReaders.userId],
    references: [users.id],
  }),
}));

export const eventCheckinsRelations = relations(eventCheckins, ({ one }) => ({
  event: one(events, {
    fields: [eventCheckins.eventId],
    references: [events.id],
  }),
  invitation: one(eventInvitations, {
    fields: [eventCheckins.invitationId],
    references: [eventInvitations.id],
  }),
  guest: one(eventGuests, {
    fields: [eventCheckins.guestId],
    references: [eventGuests.id],
  }),
  reader: one(users, {
    fields: [eventCheckins.readerUserId],
    references: [users.id],
  }),
}));

export const invitationDeliveriesRelations = relations(invitationDeliveries, ({ one }) => ({
  invitation: one(eventInvitations, {
    fields: [invitationDeliveries.invitationId],
    references: [eventInvitations.id],
  }),
}));

export const eventAuditLogsRelations = relations(eventAuditLogs, ({ one }) => ({
  event: one(events, {
    fields: [eventAuditLogs.eventId],
    references: [events.id],
  }),
  user: one(users, {
    fields: [eventAuditLogs.userId],
    references: [users.id],
  }),
}));

// Password Reset Tokens table
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 255 }).notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  }
);

export const passwordResetTokensRelations = relations(passwordResetTokens, ({ one }) => ({
  user: one(users, {
    fields: [passwordResetTokens.userId],
    references: [users.id],
  }),
}));

// Inferred Types
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;

export type Photo = typeof photos.$inferSelect;
export type NewPhoto = typeof photos.$inferInsert;

export type MusicRequest = typeof musicRequests.$inferSelect;
export type NewMusicRequest = typeof musicRequests.$inferInsert;

export type EventUser = typeof eventUsers.$inferSelect;
export type NewEventUser = typeof eventUsers.$inferInsert;

export type EventGuest = typeof eventGuests.$inferSelect;
export type NewEventGuest = typeof eventGuests.$inferInsert;

export type EventInvitation = typeof eventInvitations.$inferSelect;
export type NewEventInvitation = typeof eventInvitations.$inferInsert;

export type EventReader = typeof eventReaders.$inferSelect;
export type NewEventReader = typeof eventReaders.$inferInsert;

export type EventCheckin = typeof eventCheckins.$inferSelect;
export type NewEventCheckin = typeof eventCheckins.$inferInsert;

export type InvitationDelivery = typeof invitationDeliveries.$inferSelect;
export type NewInvitationDelivery = typeof invitationDeliveries.$inferInsert;

export type EventAuditLog = typeof eventAuditLogs.$inferSelect;
export type NewEventAuditLog = typeof eventAuditLogs.$inferInsert;

export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type NewPasswordResetToken = typeof passwordResetTokens.$inferInsert;
