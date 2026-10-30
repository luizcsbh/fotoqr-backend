/**
 * Spotify Web API Service for FotoQR
 *
 * Handles OAuth2 Client Credentials flow to get access tokens,
 * then proxies track search requests from the frontend.
 *
 * Required env vars:
 *   SPOTIFY_CLIENT_ID
 *   SPOTIFY_CLIENT_SECRET
 */

import { logger } from '../utils/logger.js';

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '';
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '';

interface SpotifyToken {
  access_token: string;
  expires_at: number; // Unix timestamp ms
}

let cachedToken: SpotifyToken | null = null;

const UNAVAILABLE_BACKOFF_MS = 10 * 60 * 1000;
let unavailableUntil = 0;

/** Spotify could not serve the request; callers fall back to manual song entry. */
export class SpotifyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpotifyUnavailableError';
  }
}

/**
 * Gets a valid Spotify access token using Client Credentials flow.
 * Caches the token until it expires.
 */
async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expires_at - 30_000) {
    return cachedToken.access_token;
  }

  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    throw new Error('Spotify API credentials not configured (SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET).');
  }

  const fetch = (await import('node-fetch')).default;

  const credentials = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');

  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!response.ok) {
    logger.error(`Spotify token error: ${response.status}`);
    if (response.status === 400 || response.status === 401) unavailableUntil = Date.now() + UNAVAILABLE_BACKOFF_MS;
    throw new SpotifyUnavailableError(`Spotify token request failed with status ${response.status}`);
  }

  const data = (await response.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    access_token: data.access_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };

  return cachedToken.access_token;
}

export interface SpotifyTrack {
  id: string;
  title: string;
  artist: string;
  albumName: string;
  albumArtUrl: string | null;
  previewUrl: string | null;
  durationMs: number;
  spotifyUrl: string;
}

/**
 * Searches Spotify for tracks matching the given query.
 * Returns up to `limit` results.
 */
export async function searchSpotifyTracks(query: string, limit = 8): Promise<SpotifyTrack[]> {
  const token = await getAccessToken();
  const fetch = (await import('node-fetch')).default;

  const url = new URL('https://api.spotify.com/v1/search');
  url.searchParams.set('q', query);
  url.searchParams.set('type', 'track');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('market', 'BR');

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    logger.error(`Spotify search error: ${response.status} ${detail.slice(0, 200)}`);
    if (response.status === 401) cachedToken = null;
    // 403 means the app itself is refused (e.g. "Active premium subscription required for the
    // owner of the app"); stop calling Spotify for a while instead of failing every search
    if (response.status === 403) unavailableUntil = Date.now() + UNAVAILABLE_BACKOFF_MS;
    throw new SpotifyUnavailableError(`Spotify search failed with status ${response.status}`);
  }

  const data = (await response.json()) as any;
  const items = data.tracks?.items ?? [];

  return items.map((track: any) => ({
    id: track.id,
    title: track.name,
    artist: track.artists?.map((a: any) => a.name).join(', ') ?? 'Artista Desconhecido',
    albumName: track.album?.name ?? '',
    albumArtUrl: track.album?.images?.[0]?.url ?? null,
    previewUrl: track.preview_url ?? null,
    durationMs: track.duration_ms ?? 0,
    spotifyUrl: track.external_urls?.spotify ?? '',
  }));
}

/**
 * Fallback catalog search on Deezer's public API (no account or key needed), used while
 * Spotify refuses requests. Results keep the SpotifyTrack shape; ids are prefixed with
 * "deezer:" so they never collide with Spotify ids, and `spotifyUrl` opens the same song
 * in Spotify's search so the DJ can still play it there.
 */
export async function searchDeezerTracks(query: string, limit = 8): Promise<SpotifyTrack[]> {
  const url = new URL('https://api.deezer.com/search/track');
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(limit));

  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const data = (await response.json().catch(() => null)) as any;
  if (!response.ok || !data || data.error) {
    throw new Error(`Deezer search failed with status ${response.status}`);
  }

  return (data.data ?? []).map((track: any) => {
    const title = track.title ?? '';
    const artist = track.artist?.name ?? 'Artista Desconhecido';
    return {
      id: `deezer:${track.id}`,
      title,
      artist,
      albumName: track.album?.title ?? '',
      albumArtUrl: track.album?.cover_medium ?? null,
      previewUrl: track.preview || null,
      durationMs: (track.duration ?? 0) * 1000,
      spotifyUrl: `https://open.spotify.com/search/${encodeURIComponent(`${title} ${artist}`)}`,
    };
  });
}

/** Whether Spotify is configured in this environment */
export function isSpotifyConfigured(): boolean {
  return Boolean(SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET);
}

/** Configured and not recently refused by Spotify */
export function isSpotifyAvailable(): boolean {
  return isSpotifyConfigured() && Date.now() >= unavailableUntil;
}
