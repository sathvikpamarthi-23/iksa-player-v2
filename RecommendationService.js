/**
 * RecommendationService
 * Multi-layer hybrid recommendation engine combining:
 * - Content similarity
 * - Collaborative signals
 * - Popularity & trends
 * - Personalization
 * - Cold start handling
 */

class RecommendationService {
  constructor(apiBaseUrl, authService) {
    this.apiBaseUrl = apiBaseUrl;
    this.authService = authService;
    this.cache = new Map();
    this.cacheTimeout = 5 * 60 * 1000;
  }

  async getPersonalizedRecommendations(limit = 20) {
    const user = this.authService.getCurrentUser();
    if (!user) return this.getColdStartRecommendations(limit);

    try {
      const cacheKey = `personalized_${user.id}`;
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
        return cached.data;
      }

      const token = await this.authService.getToken();
      const response = await fetch(`${this.apiBaseUrl}/api/recommendations?limit=${limit}`, {
        headers: {
          ...(token ? { Authorization: Bearer  } : {}),
        },
      });

      if (!response.ok) throw new Error('Failed to fetch recommendations');
      const data = await response.json();
      this.cache.set(cacheKey, { data, timestamp: Date.now() });
      return data;
    } catch (error) {
      console.error('Get personalized recommendations error:', error);
      return this.getTrendingTracks(null, limit);
    }
  }

  async getColdStartRecommendations(limit = 20) {
    const cacheKey = 'coldstart_recommendations';
    try {
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
        return cached.data;
      }

      const response = await fetch(`${this.apiBaseUrl}/api/recommendations/trending?limit=${limit}`);
      if (!response.ok) throw new Error('Failed to fetch cold start recs');
      const data = await response.json();
      this.cache.set(cacheKey, { data, timestamp: Date.now() });
      return data;
    } catch (error) {
      console.error('Cold start recommendations error:', error);
      return [];
    }
  }

  async getSimilarTracks(trackId, limit = 15) {
    const cacheKey = `similar_${trackId}`;
    try {
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
        return cached.data;
      }

      const response = await fetch(`${this.apiBaseUrl}/api/tracks/${trackId}/similar?limit=${limit}`);
      if (!response.ok) throw new Error('Failed to fetch similar tracks');
      const data = await response.json();
      this.cache.set(cacheKey, { data, timestamp: Date.now() });
      return data;
    } catch (error) {
      console.error('Similar tracks error:', error);
      return [];
    }
  }

  async getBecauseYouListenedTo(trackId, limit = 15) {
    const user = this.authService.getCurrentUser();
    if (!user) return [];

    try {
      const cacheKey = `because_${user.id}_${trackId}`;
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
        return cached.data;
      }

      const token = await this.authService.getToken();
      const response = await fetch(`${this.apiBaseUrl}/api/recommendations/because-you-played/${trackId}?limit=${limit}`, {
        headers: {
          ...(token ? { Authorization: Bearer  } : {}),
        },
      });

      if (!response.ok) throw new Error('Failed to fetch contextual recommendations');
      const data = await response.json();
      this.cache.set(cacheKey, { data, timestamp: Date.now() });
      return data;
    } catch (error) {
      console.error('Contextual recommendations error:', error);
      return [];
    }
  }

  async getTrendingTracks(genre = null, limit = 20) {
    try {
      let url = `${this.apiBaseUrl}/api/recommendations/trending?limit=${limit}`;
      if (genre) url += `&genre=${encodeURIComponent(genre)}`;

      const cacheKey = `trending_${genre || 'all'}`;
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
        return cached.data;
      }

      const response = await fetch(url);
      if (!response.ok) throw new Error('Failed to fetch trending tracks');
      const data = await response.json();
      this.cache.set(cacheKey, { data, timestamp: Date.now() });
      return data;
    } catch (error) {
      console.error('Trending tracks error:', error);
      return [];
    }
  }

  async getForYouRecommendations(limit = 30) {
    const user = this.authService.getCurrentUser();
    if (!user) return this.getColdStartRecommendations(limit);

    try {
      const token = await this.authService.getToken();
      const response = await fetch(`${this.apiBaseUrl}/api/recommendations/for-you?limit=${limit}`, {
        headers: {
          ...(token ? { Authorization: Bearer  } : {}),
        },
      });
      if (!response.ok) throw new Error('Failed to fetch For You recommendations');
      return response.json();
    } catch (error) {
      console.error('For You recommendations error:', error);
      return this.getTrendingTracks(null, limit);
    }
  }

  async getContinueListeningRecommendations(limit = 10) {
    const user = this.authService.getCurrentUser();
    if (!user) return [];

    try {
      const token = await this.authService.getToken();
      const response = await fetch(`${this.apiBaseUrl}/api/recommendations/continue-listening?limit=${limit}`, {
        headers: {
          ...(token ? { Authorization: Bearer  } : {}),
        },
      });
      if (!response.ok) throw new Error('Failed to fetch continue listening');
      return response.json();
    } catch (error) {
      console.error('Continue listening error:', error);
      return [];
    }
  }

  async getNewReleases(genre = null, limit = 20) {
    try {
      let url = `${this.apiBaseUrl}/api/recommendations/new-releases?limit=${limit}`;
      if (genre) url += `&genre=${encodeURIComponent(genre)}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error('Failed to fetch new releases');
      return response.json();
    } catch (error) {
      console.error('New releases error:', error);
      return [];
    }
  }

  calculateTrackSimilarity(track1, track2) {
    let score = 0;
    if (track1.genre === track2.genre) score += 30;
    if (track1.artist_id === track2.artist_id) score += 40;
    if (track1.artist === track2.artist) score += 35;
    return Math.min(score, 100);
  }

  filterCandidates(candidates, options = {}) {
    const {
      hideHidden = true,
      hideUnavailable = true,
      hideCurrent = null,
      maxResults = 50,
    } = options;

    let filtered = [...candidates];
    if (hideHidden && options.hiddenTrackIds) {
      filtered = filtered.filter(t => !options.hiddenTrackIds.includes(t.id));
    }
    if (hideUnavailable) {
      filtered = filtered.filter(t => t.audio_url && t.is_public);
    }
    if (hideCurrent) {
      filtered = filtered.filter(t => t.id !== hideCurrent.id);
    }

    const seen = new Set();
    filtered = filtered.filter(t => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });

    return filtered.slice(0, maxResults);
  }

  diversifyRecommendations(tracks, options = {}) {
    const { maxPerArtist = 2, maxPerGenre = 3 } = options;
    const result = [];
    const artistCount = new Map();
    const genreCount = new Map();

    for (const track of tracks) {
      const artistCountValue = artistCount.get(track.artist_id) || 0;
      const genreCountValue = genreCount.get(track.genre) || 0;
      if (artistCountValue >= maxPerArtist) continue;
      if (genreCountValue >= maxPerGenre) continue;

      result.push(track);
      artistCount.set(track.artist_id, artistCountValue + 1);
      genreCount.set(track.genre, genreCountValue + 1);
    }

    return result;
  }

  clearCache() { this.cache.clear(); }
  clearCacheFor(key) { this.cache.delete(key); }
}

window.RecommendationService = RecommendationService;
