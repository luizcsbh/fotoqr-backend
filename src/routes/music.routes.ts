import { Router, Request, Response, NextFunction } from 'express';
import { eq, and, count, asc } from 'drizzle-orm';
import { db } from '../config/database.js';
import { musicRequests, MusicRequest } from '../models/schema.js';
import { eventService } from '../services/event.service.js';
import { searchSpotifyTracks, searchDeezerTracks, isSpotifyAvailable } from '../services/spotify.service.js';
import { authenticateToken, optionalAuth } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';

const router = Router();

const MAX_SONGS_PER_EVENT = 15;

/** Trimmed string limited to `max` chars, or null for anything that is not a non-empty string. */
const asText = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim() ? value.trim().substring(0, max) : null;

/** Only http(s) URLs are stored, since they end up in <img>/<audio> tags of other users. */
const asHttpUrl = (value: unknown): string | null => {
  const text = asText(value, 2048);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
};

const parseSongId = (raw: string): number | null => (/^\d+$/.test(raw) ? parseInt(raw, 10) : null);

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/events/:uuid/music
// Public: list all approved + pending music requests for an event
// ──────────────────────────────────────────────────────────────────────────────
router.get('/events/:uuid/music', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uuid = req.params.uuid as string;

    const event = await eventService.getEventByUuid(uuid);
    if (!event) {
      res.status(404).json({ success: false, error: 'Evento não encontrado.' });
      return;
    }

    const songs = await db
      .select()
      .from(musicRequests)
      .where(eq(musicRequests.eventId, event.id))
      .orderBy(asc(musicRequests.position), asc(musicRequests.requestedAt));

    res.json({
      success: true,
      data: songs.map(formatSong),
      total: songs.length,
      max: MAX_SONGS_PER_EVENT,
      enabled: event.enableDjPlaylist,
      // Search stays available through the Deezer fallback even when Spotify refuses
      spotifyEnabled: true,
    });
  } catch (error) {
    next(error);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/events/:uuid/music
// Public: guest submits a song request
// Body: { title, artist, albumName?, albumArtUrl?, spotifyTrackId?, spotifyPreviewUrl?, guestName? }
// ──────────────────────────────────────────────────────────────────────────────
router.post('/events/:uuid/music', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uuid = req.params.uuid as string;
    const body = req.body ?? {};
    const title = asText(body.title, 255);
    const artist = asText(body.artist, 255);
    const spotifyTrackId = asText(body.spotifyTrackId, 64);

    if (!title || !artist) {
      res.status(400).json({ success: false, error: 'Título e artista são obrigatórios.' });
      return;
    }

    const event = await eventService.getEventByUuid(uuid);
    if (!event) {
      res.status(404).json({ success: false, error: 'Evento não encontrado.' });
      return;
    }

    if (!event.isActive) {
      res.status(403).json({ success: false, error: 'Este evento não está aceitando pedidos no momento.' });
      return;
    }

    if (!event.enableDjPlaylist) {
      res.status(403).json({ success: false, error: 'A playlist do DJ não está ativada para este evento.' });
      return;
    }

    // Check playlist capacity
    const [{ count: currentCount }] = await db
      .select({ count: count() })
      .from(musicRequests)
      .where(eq(musicRequests.eventId, event.id));

    if (Number(currentCount) >= MAX_SONGS_PER_EVENT) {
      res.status(422).json({
        success: false,
        error: `A lista de pedidos já está cheia (máximo de ${MAX_SONGS_PER_EVENT} músicas por evento).`,
      });
      return;
    }

    // Check for duplicate Spotify track (if spotify ID provided)
    if (spotifyTrackId) {
      const [existing] = await db
        .select({ id: musicRequests.id })
        .from(musicRequests)
        .where(
          and(
            eq(musicRequests.eventId, event.id),
            eq(musicRequests.spotifyTrackId, spotifyTrackId)
          )
        )
        .limit(1);

      if (existing) {
        res.status(409).json({
          success: false,
          error: 'Esta música já foi pedida para este evento.',
        });
        return;
      }
    } else {
      // Fallback deduplication: normalize title + artist
      // Drop accents but keep any letter/digit, so "Coração" matches "Coracao" and
      // non-Latin titles do not all collapse into an empty string
      const normalizeStr = (s: string) =>
        s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      const existing = await db.select().from(musicRequests).where(eq(musicRequests.eventId, event.id));
      const isDuplicate = existing.some(
        (r) =>
          normalizeStr(r.title) === normalizeStr(title) &&
          normalizeStr(r.artist) === normalizeStr(artist)
      );

      if (isDuplicate) {
        res.status(409).json({
          success: false,
          error: 'Esta música já foi pedida para este evento.',
        });
        return;
      }
    }

    const [inserted] = await db
      .insert(musicRequests)
      .values({
        eventId: event.id,
        title,
        artist,
        albumName: asText(body.albumName, 255),
        albumArtUrl: asHttpUrl(body.albumArtUrl),
        spotifyTrackId,
        spotifyPreviewUrl: asHttpUrl(body.spotifyPreviewUrl),
        guestName: asText(body.guestName, 100),
        position: Number(currentCount),
        status: 'pending',
      })
      .returning();

    logger.info(`[music] New request for event ${uuid}: "${title}" by "${artist}"`);

    res.status(201).json({
      success: true,
      message: `"${inserted.title}" adicionado à lista do DJ!`,
      data: formatSong(inserted),
    });
  } catch (error: any) {
    // Handle unique constraint violation (race condition)
    if (error?.code === '23505') {
      res.status(409).json({ success: false, error: 'Esta música já foi pedida para este evento.' });
      return;
    }
    next(error);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// DELETE /api/events/:uuid/music/:songId
// Authenticated (event owner): remove a song from the playlist
// ──────────────────────────────────────────────────────────────────────────────
router.delete('/events/:uuid/music/:songId', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uuid = req.params.uuid as string;
    const songId = parseSongId(req.params.songId as string);
    const userId = req.user!.id;

    if (songId === null) {
      res.status(400).json({ success: false, error: 'ID da música inválido.' });
      return;
    }

    const event = await eventService.getEventByUuid(uuid);
    if (!event) {
      res.status(404).json({ success: false, error: 'Evento não encontrado.' });
      return;
    }

    // Ensure the authenticated user owns this event
    if (event.userId !== userId) {
      res.status(403).json({ success: false, error: 'Sem permissão para remover músicas deste evento.' });
      return;
    }

    const deleted = await db
      .delete(musicRequests)
      .where(and(eq(musicRequests.id, songId), eq(musicRequests.eventId, event.id)))
      .returning({ id: musicRequests.id });

    if (!deleted.length) {
      res.status(404).json({ success: false, error: 'Pedido de música não encontrado.' });
      return;
    }

    res.json({ success: true, message: 'Música removida da lista.' });
  } catch (error) {
    next(error);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// PATCH /api/events/:uuid/music/:songId/status
// Authenticated (event owner): update song status (played, approved, rejected)
// ──────────────────────────────────────────────────────────────────────────────
router.patch('/events/:uuid/music/:songId/status', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uuid = req.params.uuid as string;
    const songId = parseSongId(req.params.songId as string);
    const status = req.body?.status as MusicRequest['status'];
    const userId = req.user!.id;

    const validStatuses: MusicRequest['status'][] = ['pending', 'approved', 'rejected', 'played'];
    if (!validStatuses.includes(status)) {
      res.status(400).json({ success: false, error: 'Status inválido.' });
      return;
    }

    if (songId === null) {
      res.status(400).json({ success: false, error: 'ID da música inválido.' });
      return;
    }

    const event = await eventService.getEventByUuid(uuid);
    if (!event) {
      res.status(404).json({ success: false, error: 'Evento não encontrado.' });
      return;
    }

    if (event.userId !== userId) {
      res.status(403).json({ success: false, error: 'Sem permissão.' });
      return;
    }

    const [updated] = await db
      .update(musicRequests)
      .set({ status })
      .where(and(eq(musicRequests.id, songId), eq(musicRequests.eventId, event.id)))
      .returning();

    if (!updated) {
      res.status(404).json({ success: false, error: 'Pedido de música não encontrado.' });
      return;
    }

    res.json({ success: true, data: formatSong(updated) });
  } catch (error) {
    next(error);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/spotify/search?q=...
// Public proxy: search Spotify tracks (avoids exposing credentials to frontend),
// falling back to Deezer's public catalog when Spotify is unavailable
// ──────────────────────────────────────────────────────────────────────────────
router.get('/spotify/search', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = (req.query.q as string)?.trim();
    if (!q || q.length < 2) {
      res.status(400).json({ success: false, error: 'Parâmetro de busca inválido.' });
      return;
    }

    if (isSpotifyAvailable()) {
      try {
        const tracks = await searchSpotifyTracks(q);
        res.json({ success: true, data: tracks, spotifyEnabled: true, source: 'spotify' });
        return;
      } catch (spotifyError) {
        logger.warn('[music] Busca no Spotify falhou; usando catálogo do Deezer.', spotifyError);
      }
    }

    // Spotify unconfigured or refusing (e.g. app owner without Premium): search Deezer instead
    try {
      const tracks = await searchDeezerTracks(q);
      res.json({ success: true, data: tracks, spotifyEnabled: true, source: 'deezer' });
    } catch (fallbackError) {
      // Both catalogs down: the guest falls back to manual entry
      logger.warn('[music] Busca no Deezer falhou; usando modo manual.', fallbackError);
      res.json({
        success: true,
        data: [],
        spotifyEnabled: false,
        message: 'A busca de músicas está indisponível no momento. Digite o nome da música e do artista.',
      });
    }
  } catch (error) {
    next(error);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────
function formatSong(r: MusicRequest) {
  return {
    id: String(r.id),
    eventId: String(r.eventId),
    spotifyTrackId: r.spotifyTrackId || null,
    title: r.title,
    artist: r.artist,
    albumName: r.albumName || null,
    albumArtUrl: r.albumArtUrl || null,
    spotifyPreviewUrl: r.spotifyPreviewUrl || null,
    guestName: r.guestName || null,
    status: r.status,
    position: r.position,
    requestedAt: r.requestedAt.toISOString(),
  };
}

export default router;
