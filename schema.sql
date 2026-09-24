-- Sound Lounge Database Schema
-- PostgreSQL 13+
-- This schema is designed for Supabase but works on any PostgreSQL instance

-- ============================================================================
-- USERS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  display_name VARCHAR(255),
  avatar_url TEXT,
  subscription_tier VARCHAR(50) DEFAULT 'free', -- 'free', 'premium', 'family'
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ============================================================================
-- ARTISTS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS artists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL UNIQUE,
  bio TEXT,
  avatar_url TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_artists_name ON artists(name);

-- ============================================================================
-- TRACKS TABLE (Core catalog)
-- ============================================================================
CREATE TABLE IF NOT EXISTS tracks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(255) NOT NULL,
  artist_id UUID NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  genre VARCHAR(100),
  duration_seconds INTEGER NOT NULL,
  audio_url TEXT NOT NULL,
  cover_url TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  play_count INTEGER DEFAULT 0,
  is_public BOOLEAN DEFAULT true,
  
  -- Validate
  CONSTRAINT valid_duration CHECK (duration_seconds > 0)
);

CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist_id);
CREATE INDEX IF NOT EXISTS idx_tracks_genre ON tracks(genre);
CREATE INDEX IF NOT EXISTS idx_tracks_created ON tracks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tracks_public ON tracks(is_public);
CREATE INDEX IF NOT EXISTS idx_tracks_popular ON tracks(play_count DESC);

-- ============================================================================
-- LIKES TABLE (User favorites)
-- ============================================================================
CREATE TABLE IF NOT EXISTS likes (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id UUID NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  PRIMARY KEY (user_id, track_id)
);

CREATE INDEX IF NOT EXISTS idx_likes_user ON likes(user_id);
CREATE INDEX IF NOT EXISTS idx_likes_track ON likes(track_id);
CREATE INDEX IF NOT EXISTS idx_likes_created ON likes(created_at DESC);

-- ============================================================================
-- LISTENING_HISTORY TABLE (Track plays with metadata)
-- ============================================================================
CREATE TABLE IF NOT EXISTS listening_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id UUID NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  started_at TIMESTAMP WITH TIME ZONE NOT NULL,
  ended_at TIMESTAMP WITH TIME ZONE,
  duration_played_seconds INTEGER,
  completion_percentage DECIMAL(5, 2) DEFAULT 0,
  source VARCHAR(50), -- 'queue', 'search', 'recommendation', 'playlist'
  session_id VARCHAR(100),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_history_user ON listening_history(user_id);
CREATE INDEX IF NOT EXISTS idx_history_track ON listening_history(track_id);
CREATE INDEX IF NOT EXISTS idx_history_started ON listening_history(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_user_recent 
  ON listening_history(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_session ON listening_history(session_id);

-- ============================================================================
-- HIDDEN_TRACKS TABLE (Don't recommend / blocklist)
-- ============================================================================
CREATE TABLE IF NOT EXISTS hidden_tracks (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id UUID NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  reason VARCHAR(100), -- 'dont_recommend', 'explicit', 'irrelevant'
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  PRIMARY KEY (user_id, track_id)
);

CREATE INDEX IF NOT EXISTS idx_hidden_user ON hidden_tracks(user_id);
CREATE INDEX IF NOT EXISTS idx_hidden_track ON hidden_tracks(track_id);

-- ============================================================================
-- PLAYLISTS TABLE (User-created collections)
-- ============================================================================
CREATE TABLE IF NOT EXISTS playlists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  cover_url TEXT,
  is_public BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_playlists_user ON playlists(user_id);
CREATE INDEX IF NOT EXISTS idx_playlists_public ON playlists(is_public);

-- ============================================================================
-- PLAYLIST_TRACKS TABLE (Playlist membership with order)
-- ============================================================================
CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlist_id UUID NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id UUID NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  added_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  PRIMARY KEY (playlist_id, track_id),
  UNIQUE (playlist_id, position),
  CONSTRAINT valid_position CHECK (position >= 0)
);

CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist 
  ON playlist_tracks(playlist_id);
CREATE INDEX IF NOT EXISTS idx_playlist_tracks_track 
  ON playlist_tracks(track_id);

-- ============================================================================
-- USER_PREFERENCES TABLE (User settings)
-- ============================================================================
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  volume INTEGER DEFAULT 80,
  shuffle_enabled BOOLEAN DEFAULT false,
  repeat_mode VARCHAR(20) DEFAULT 'off', -- 'off', 'all', 'one'
  dark_mode BOOLEAN DEFAULT true,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  CONSTRAINT valid_volume CHECK (volume >= 0 AND volume <= 100),
  CONSTRAINT valid_repeat CHECK (repeat_mode IN ('off', 'all', 'one'))
);

-- ============================================================================
-- PLAYBACK_EVENTS TABLE (Detailed playback analytics)
-- ============================================================================
CREATE TABLE IF NOT EXISTS playback_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id UUID NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  event_type VARCHAR(50) NOT NULL, -- 'play', 'pause', 'skip', 'complete'
  playback_position_seconds INTEGER DEFAULT 0,
  session_id VARCHAR(100),
  timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_playback_user ON playback_events(user_id);
CREATE INDEX IF NOT EXISTS idx_playback_track ON playback_events(track_id);
CREATE INDEX IF NOT EXISTS idx_playback_session ON playback_events(session_id);
CREATE INDEX IF NOT EXISTS idx_playback_timestamp ON playback_events(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_playback_event_type ON playback_events(event_type);

-- ============================================================================
-- SEARCH_EVENTS TABLE (Search analytics)
-- ============================================================================
CREATE TABLE IF NOT EXISTS search_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  query VARCHAR(255) NOT NULL,
  results_count INTEGER,
  clicked_track_id UUID REFERENCES tracks(id) ON DELETE SET NULL,
  clicked_position INTEGER,
  timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_search_query ON search_events(query);
CREATE INDEX IF NOT EXISTS idx_search_user ON search_events(user_id);
CREATE INDEX IF NOT EXISTS idx_search_timestamp ON search_events(timestamp DESC);

-- ============================================================================
-- GENRE_PREFERENCES TABLE (User's genre affinities)
-- ============================================================================
CREATE TABLE IF NOT EXISTS genre_preferences (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  genre VARCHAR(100) NOT NULL,
  affinity_score DECIMAL(5, 2) DEFAULT 0.5, -- 0.0 to 1.0
  play_count INTEGER DEFAULT 0,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  PRIMARY KEY (user_id, genre),
  CONSTRAINT valid_affinity CHECK (affinity_score >= 0 AND affinity_score <= 1)
);

CREATE INDEX IF NOT EXISTS idx_genre_pref_user ON genre_preferences(user_id);
CREATE INDEX IF NOT EXISTS idx_genre_pref_affinity ON genre_preferences(affinity_score DESC);

-- ============================================================================
-- ARTIST_PREFERENCES TABLE (User's artist affinities)
-- ============================================================================
CREATE TABLE IF NOT EXISTS artist_preferences (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  artist_id UUID NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  affinity_score DECIMAL(5, 2) DEFAULT 0.5,
  play_count INTEGER DEFAULT 0,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  PRIMARY KEY (user_id, artist_id),
  CONSTRAINT valid_affinity CHECK (affinity_score >= 0 AND affinity_score <= 1)
);

CREATE INDEX IF NOT EXISTS idx_artist_pref_user ON artist_preferences(user_id);
CREATE INDEX IF NOT EXISTS idx_artist_pref_artist ON artist_preferences(artist_id);

-- ============================================================================
-- TRACK_SIMILARITY TABLE (Precomputed similarity for faster recommendations)
-- ============================================================================
CREATE TABLE IF NOT EXISTS track_similarity (
  track_id_1 UUID NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  track_id_2 UUID NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  similarity_score DECIMAL(5, 2) NOT NULL, -- 0.0 to 1.0
  reason VARCHAR(100), -- 'genre', 'artist', 'audio_features', etc.
  computed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  PRIMARY KEY (track_id_1, track_id_2),
  CONSTRAINT valid_similarity CHECK (similarity_score >= 0 AND similarity_score <= 1),
  CONSTRAINT different_tracks CHECK (track_id_1 != track_id_2)
);

CREATE INDEX IF NOT EXISTS idx_similarity_track1 ON track_similarity(track_id_1);
CREATE INDEX IF NOT EXISTS idx_similarity_track2 ON track_similarity(track_id_2);
CREATE INDEX IF NOT EXISTS idx_similarity_score ON track_similarity(similarity_score DESC);

-- ============================================================================
-- ROW LEVEL SECURITY (for Supabase)
-- ============================================================================
-- Enable RLS on tables with user data
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE listening_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE hidden_tracks ENABLE ROW LEVEL SECURITY;
ALTER TABLE playlists ENABLE ROW LEVEL SECURITY;
ALTER TABLE playlist_tracks ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE playback_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE genre_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE artist_preferences ENABLE ROW LEVEL SECURITY;

-- Policies for users table
CREATE POLICY "Users can view their own profile" ON users
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can update their own profile" ON users
  FOR UPDATE USING (auth.uid() = id);

-- Policies for likes
CREATE POLICY "Users can view their own likes" ON likes
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can manage their own likes" ON likes
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own likes" ON likes
  FOR DELETE USING (auth.uid() = user_id);

-- Policies for listening_history
CREATE POLICY "Users can view their own history" ON listening_history
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can record their own plays" ON listening_history
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Policies for hidden_tracks
CREATE POLICY "Users can manage their hidden tracks" ON hidden_tracks
  FOR ALL USING (auth.uid() = user_id);

-- Policies for playlists
CREATE POLICY "Users can view their own playlists" ON playlists
  FOR SELECT USING (auth.uid() = user_id OR is_public);

CREATE POLICY "Users can create playlists" ON playlists
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own playlists" ON playlists
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own playlists" ON playlists
  FOR DELETE USING (auth.uid() = user_id);

-- Policies for public tables (tracks, artists)
CREATE POLICY "Anyone can view public tracks" ON tracks
  FOR SELECT USING (is_public = true);

CREATE POLICY "Anyone can view artists" ON artists
  FOR SELECT USING (true);

-- ============================================================================
-- SAMPLE DATA / SEED DATA
-- ============================================================================
-- These are the 8 original tracks from the Sound Lounge prototype
-- Uncomment to seed initial data

/*

-- Insert artists
INSERT INTO artists (name, bio, avatar_url) VALUES
('Lo-Fi Feline', 'Chill lo-fi beats curator', 'https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba'),
('Chill Whiskers', 'Relaxing ambient soundscapes', 'https://images.unsplash.com/photo-1573865526739-10659fec78a5'),
('Tabby Beats', 'Jazz fusion specialist', 'https://images.unsplash.com/photo-1533738363-b7f9aef128ce'),
('Velvet Paws', 'Lo-fi beats & rainy vibes', 'https://images.unsplash.com/photo-1543852786-1cf6624b9987'),
('Jazz Cat', 'Modern jazz explorer', 'https://images.unsplash.com/photo-1495360010541-f48722b34f7d'),
('Synth Purr', 'Synthwave producer', 'https://images.unsplash.com/photo-1518791841217-8f162f1e1131'),
('Cyber Kitten', 'Cyberpunk synthwave', 'https://images.unsplash.com/photo-1561948955-570b270e7c36'),
('Acoustic Paws', 'Acoustic & indie artist', 'https://images.unsplash.com/photo-1513360371669-4adf3dd7dff8');

-- Insert tracks
INSERT INTO tracks (title, artist_id, genre, duration_seconds, audio_url, cover_url) VALUES
('Midnight Purr', (SELECT id FROM artists WHERE name = 'Lo-Fi Feline'), 'lofi', 204, 'https://example.com/midnight-purr.mp3', 'https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba'),
('Cozy Naps', (SELECT id FROM artists WHERE name = 'Chill Whiskers'), 'chill', 180, 'https://example.com/cozy-naps.mp3', 'https://images.unsplash.com/photo-1573865526739-10659fec78a5'),
('Sunbeam Groove', (SELECT id FROM artists WHERE name = 'Tabby Beats'), 'jazz', 225, 'https://example.com/sunbeam-groove.mp3', 'https://images.unsplash.com/photo-1533738363-b7f9aef128ce'),
('Rainy Window', (SELECT id FROM artists WHERE name = 'Velvet Paws'), 'lofi', 195, 'https://example.com/rainy-window.mp3', 'https://images.unsplash.com/photo-1543852786-1cf6624b9987'),
('Moonlight Prowl', (SELECT id FROM artists WHERE name = 'Jazz Cat'), 'jazz', 210, 'https://example.com/moonlight-prowl.mp3', 'https://images.unsplash.com/photo-1495360010541-f48722b34f7d'),
('Morning Stretch', (SELECT id FROM artists WHERE name = 'Synth Purr'), 'synth', 168, 'https://example.com/morning-stretch.mp3', 'https://images.unsplash.com/photo-1518791841217-8f162f1e1131'),
('Neon Alley Run', (SELECT id FROM artists WHERE name = 'Cyber Kitten'), 'synth', 230, 'https://example.com/neon-alley-run.mp3', 'https://images.unsplash.com/photo-1561948955-570b270e7c36'),
('Coffee Shop Whispers', (SELECT id FROM artists WHERE name = 'Acoustic Paws'), 'chill', 192, 'https://example.com/coffee-shop-whispers.mp3', 'https://images.unsplash.com/photo-1513360371669-4adf3dd7dff8');

*/

-- ============================================================================
-- VIEWS FOR COMMON QUERIES
-- ============================================================================

-- View: Recently played tracks for a user
CREATE OR REPLACE VIEW user_recent_tracks AS
SELECT DISTINCT ON (lh.track_id)
  lh.user_id,
  lh.track_id,
  t.title,
  a.name as artist,
  lh.started_at
FROM listening_history lh
JOIN tracks t ON lh.track_id = t.id
JOIN artists a ON t.artist_id = a.id
ORDER BY lh.track_id, lh.started_at DESC;

-- View: User's liked tracks with details
CREATE OR REPLACE VIEW user_liked_tracks_detail AS
SELECT
  l.user_id,
  t.id as track_id,
  t.title,
  a.name as artist,
  t.genre,
  t.duration_seconds,
  t.cover_url,
  l.created_at
FROM likes l
JOIN tracks t ON l.track_id = t.id
JOIN artists a ON t.artist_id = a.id
ORDER BY l.created_at DESC;

-- View: Trending tracks (most played in last 7 days)
CREATE OR REPLACE VIEW trending_tracks AS
SELECT
  t.id,
  t.title,
  a.name as artist,
  t.genre,
  COUNT(lh.id) as play_count,
  COUNT(DISTINCT lh.user_id) as unique_listeners
FROM tracks t
JOIN artists a ON t.artist_id = a.id
LEFT JOIN listening_history lh ON t.id = lh.track_id
  AND lh.started_at > NOW() - INTERVAL '7 days'
WHERE t.is_public
GROUP BY t.id, t.title, a.name, t.genre
ORDER BY play_count DESC;

-- View: User statistics
CREATE OR REPLACE VIEW user_statistics AS
SELECT
  u.id as user_id,
  u.display_name,
  COUNT(DISTINCT l.track_id) as liked_count,
  COUNT(DISTINCT lh.track_id) as total_tracks_played,
  SUM(CASE WHEN lh.completion_percentage >= 80 THEN 1 ELSE 0 END) as tracks_completed,
  EXTRACT(EPOCH FROM (MAX(lh.started_at) - MIN(lh.started_at))) / 3600 as listening_hours,
  MAX(lh.started_at) as last_played_at
FROM users u
LEFT JOIN likes l ON u.id = l.user_id
LEFT JOIN listening_history lh ON u.id = lh.user_id
GROUP BY u.id, u.display_name;

-- ============================================================================
-- COMMENTS (Documentation)
-- ============================================================================
COMMENT ON TABLE users IS 'Core user accounts';
COMMENT ON TABLE tracks IS 'Music track catalog';
COMMENT ON TABLE listening_history IS 'Track play events with completion data';
COMMENT ON TABLE likes IS 'User favorite tracks (many-to-many relationship)';
COMMENT ON TABLE hidden_tracks IS 'Tracks user has hidden from recommendations';
COMMENT ON TABLE playlists IS 'User-created track collections';
COMMENT ON TABLE playback_events IS 'Detailed playback analytics for recommendations';
