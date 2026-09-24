/**
 * PlayerService
 * Manages real HTML5 audio playback and keeps UI in sync
 * 
 * Replaces the fake setInterval() playback with real audio element.
 * Maintains single source of truth: HTML5 Audio element state
 * 
 * Usage:
 *   const player = new PlayerService()
 *   await player.loadTrack(track)
 *   await player.play()
 *   player.pause()
 *   player.seek(120) // seconds
 *   player.setVolume(80)
 */

class PlayerService {
  constructor() {
    // Hidden audio element - the source of truth
    this.audioElement = new Audio();
    this.audioElement.crossOrigin = 'anonymous';
    document.body.appendChild(this.audioElement);

    // State
    this.currentTrack = null;
    this.isPlaying = false;
    this.repeatMode = 'off'; // 'off', 'all', 'one'
    this.shuffleEnabled = false;
    this.volume = 80;
    this.isMuted = false;

    // Session tracking
    this.playStartTime = null;
    this.sessionId = this.generateSessionId();

    // UI listeners
    this.listeners = [];

    // Setup audio event listeners
    this.setupAudioListeners();
  }

  /**
   * Setup listeners for HTML5 audio element events
   */
  setupAudioListeners() {
    // When current time updates
    this.audioElement.addEventListener('timeupdate', () => {
      this.notifyListeners('timeupdate', {
        currentTime: this.audioElement.currentTime,
        duration: this.audioElement.duration,
      });
    });

    // When track ends
    this.audioElement.addEventListener('ended', () => {
      this.handleTrackEnd();
    });

    // When metadata is loaded (duration becomes available)
    this.audioElement.addEventListener('loadedmetadata', () => {
      this.notifyListeners('durationload', {
        duration: this.audioElement.duration,
      });
    });

    // When playback can start
    this.audioElement.addEventListener('canplay', () => {
      this.notifyListeners('canplay');
    });

    // When waiting for data
    this.audioElement.addEventListener('waiting', () => {
      this.notifyListeners('buffering');
    });

    // On audio errors
    this.audioElement.addEventListener('error', (event) => {
      const errorMsg = this.getAudioErrorMessage(
        this.audioElement.error?.code
      );
      console.error('Audio error:', errorMsg);
      this.notifyListeners('error', { error: errorMsg });
      this.handlePlaybackFailure();
    });

    // Pause
    this.audioElement.addEventListener('pause', () => {
      if (this.isPlaying) {
        this.isPlaying = false;
        this.notifyListeners('pause');
      }
    });

    // Play
    this.audioElement.addEventListener('play', () => {
      this.isPlaying = true;
      this.playStartTime = Date.now();
      this.notifyListeners('play');
    });

    // Volume change
    this.audioElement.addEventListener('volumechange', () => {
      this.volume = Math.round(this.audioElement.volume * 100);
      this.notifyListeners('volumechange', { volume: this.volume });
    });
  }

  /**
   * Load track and prepare for playback
   */
  async loadTrack(track) {
    try {
      if (!track || !track.audio_url) {
        throw new Error('Invalid track or missing audio URL');
      }

      // Stop current playback
      this.stop();

      // Update current track reference
      this.currentTrack = track;

      // Set audio source
      this.audioElement.src = track.audio_url;

      // Preload metadata to get duration
      this.audioElement.load();

      this.notifyListeners('trackload', { track });

      return { success: true };
    } catch (error) {
      console.error('Track load error:', error);
      this.notifyListeners('error', { error: error.message });
      return { error: error.message, success: false };
    }
  }

  /**
   * Play current track
   */
  async play() {
    try {
      if (!this.currentTrack) {
        throw new Error('No track loaded');
      }

      const playPromise = this.audioElement.play();

      if (playPromise !== undefined) {
        await playPromise;
      }

      this.isPlaying = true;
      this.playStartTime = Date.now();

      return { success: true };
    } catch (error) {
      console.error('Play error:', error);
      this.notifyListeners('error', { error: error.message });
      return { error: error.message, success: false };
    }
  }

  /**
   * Pause playback
   */
  pause() {
    try {
      this.audioElement.pause();
      this.isPlaying = false;
      this.notifyListeners('pause');
      return { success: true };
    } catch (error) {
      console.error('Pause error:', error);
      return { error: error.message, success: false };
    }
  }

  /**
   * Stop playback and reset
   */
  stop() {
    try {
      this.audioElement.pause();
      this.audioElement.currentTime = 0;
      this.isPlaying = false;
      this.playStartTime = null;
      this.notifyListeners('stop');
      return { success: true };
    } catch (error) {
      console.error('Stop error:', error);
      return { error: error.message, success: false };
    }
  }

  /**
   * Seek to specific time (seconds)
   */
  seek(timeInSeconds) {
    try {
      if (isNaN(timeInSeconds) || timeInSeconds < 0) {
        throw new Error('Invalid seek time');
      }

      this.audioElement.currentTime = Math.min(
        timeInSeconds,
        this.audioElement.duration
      );

      this.notifyListeners('seek', { currentTime: timeInSeconds });

      return { success: true };
    } catch (error) {
      console.error('Seek error:', error);
      return { error: error.message, success: false };
    }
  }

  /**
   * Set volume (0-100)
   */
  setVolume(level) {
    try {
      const normalized = Math.max(0, Math.min(100, level)) / 100;
      this.audioElement.volume = normalized;
      this.volume = Math.round(normalized * 100);

      // Auto-unmute if volume set above 0
      if (level > 0 && this.isMuted) {
        this.isMuted = false;
        this.notifyListeners('unmute');
      }

      return { success: true };
    } catch (error) {
      console.error('Set volume error:', error);
      return { error: error.message, success: false };
    }
  }

  /**
   * Toggle mute
   */
  toggleMute() {
    try {
      if (this.isMuted) {
        // Unmute - restore previous volume
        this.audioElement.muted = false;
        this.isMuted = false;
        this.notifyListeners('unmute');
      } else {
        // Mute
        this.audioElement.muted = true;
        this.isMuted = true;
        this.notifyListeners('mute');
      }

      return { success: true };
    } catch (error) {
      console.error('Toggle mute error:', error);
      return { error: error.message, success: false };
    }
  }

  /**
   * Set repeat mode
   */
  setRepeatMode(mode) {
    // mode: 'off', 'all', 'one'
    if (!['off', 'all', 'one'].includes(mode)) {
      throw new Error('Invalid repeat mode');
    }

    this.repeatMode = mode;
    this.notifyListeners('repeatchange', { mode });

    return { success: true };
  }

  /**
   * Toggle shuffle
   */
  toggleShuffle() {
    this.shuffleEnabled = !this.shuffleEnabled;
    this.notifyListeners('shufflechange', { enabled: this.shuffleEnabled });
    return { success: true };
  }

  /**
   * Handle track end
   */
  handleTrackEnd() {
    const completionPercentage = 100; // Full play

    // Record listening event
    if (this.currentTrack) {
      this.recordPlaybackEvent('complete', completionPercentage);
    }

    // Apply repeat mode
    if (this.repeatMode === 'one') {
      // Restart current track
      this.seek(0);
      this.play();
    } else if (this.repeatMode === 'all' || true) {
      // Next track (handled by queue/app layer)
      this.notifyListeners('trackend');
    }
  }

  /**
   * Handle playback failure
   */
  handlePlaybackFailure() {
    this.stop();
    this.notifyListeners('playbackfailed', {
      track: this.currentTrack,
    });
  }

  /**
   * Record playback event for analytics
   */
  recordPlaybackEvent(eventType, completionPercentage = 0) {
    if (!this.currentTrack) return;

    const event = {
      user_id: null, // Will be set by app layer if authenticated
      track_id: this.currentTrack.id,
      event_type: eventType, // 'play', 'pause', 'skip', 'complete'
      playback_position_seconds: Math.floor(this.audioElement.currentTime),
      session_id: this.sessionId,
      timestamp: new Date().toISOString(),
      duration_played_seconds: Math.floor(
        this.audioElement.currentTime - (this.playStartTime ? 0 : 0)
      ),
      completion_percentage: completionPercentage,
    };

    this.notifyListeners('playbackevent', event);

    // Could send to analytics service here
    return event;
  }

  /**
   * Get current playback state
   */
  getState() {
    return {
      track: this.currentTrack,
      isPlaying: this.isPlaying,
      currentTime: this.audioElement.currentTime,
      duration: this.audioElement.duration,
      volume: this.volume,
      isMuted: this.isMuted,
      repeatMode: this.repeatMode,
      shuffleEnabled: this.shuffleEnabled,
      buffered: this.audioElement.buffered,
      canPlay: this.audioElement.canPlayType('audio/mpeg') !== '',
    };
  }

  /**
   * Get progress as percentage
   */
  getProgress() {
    if (!this.audioElement.duration) return 0;
    return (this.audioElement.currentTime / this.audioElement.duration) * 100;
  }

  /**
   * Check if audio format is supported
   */
  isAudioSupported(mimeType) {
    return this.audioElement.canPlayType(mimeType) !== '';
  }

  /**
   * Subscribe to player events
   */
  subscribe(listener) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  /**
   * Notify listeners of state changes
   */
  notifyListeners(eventType, data = {}) {
    this.listeners.forEach(listener => {
      listener({
        type: eventType,
        ...data,
        state: this.getState(),
      });
    });
  }

  /**
   * Map audio error codes to readable messages
   */
  getAudioErrorMessage(errorCode) {
    const errorMap = {
      1: 'Audio loading aborted',
      2: 'Network error loading audio',
      3: 'Audio decoding error',
      4: 'Audio format not supported',
    };

    return errorMap[errorCode] || 'Unknown audio error';
  }

  /**
   * Generate unique session ID for analytics
   */
  generateSessionId() {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Cleanup
   */
  destroy() {
    this.stop();
    if (this.audioElement.parentNode) {
      this.audioElement.parentNode.removeChild(this.audioElement);
    }
    this.listeners = [];
  }
}

// Make available globally
window.PlayerService = PlayerService;
