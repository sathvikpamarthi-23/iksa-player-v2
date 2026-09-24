/**
 * AuthService
 * Handles user authentication and session management via Supabase
 * 
 * Usage:
 *   await AuthService.signup(email, password, displayName)
 *   await AuthService.signin(email, password)
 *   const user = AuthService.getCurrentUser()
 *   await AuthService.signout()
 */

class AuthService {
  constructor(supabaseClient) {
    this.supabase = supabaseClient;
    this.currentUser = null;
    this.listeners = []; // For UI updates
    
    // Restore session on initialization
    this.restoreSession();
  }

  /**
   * Sign up new user
   */
  async signup(email, password, displayName) {
    try {
      // Create auth user
      const { data, error } = await this.supabase.auth.signUp({
        email,
        password,
      });

      if (error) throw new Error(error.message);

      const userId = data.user.id;

      // Create user profile in database
      const { error: profileError } = await this.supabase
        .from('users')
        .insert({
          id: userId,
          email,
          display_name: displayName,
          avatar_url: this.generateAvatarUrl(email),
        });

      if (profileError) throw new Error(profileError.message);

      // Create user preferences
      const { error: prefError } = await this.supabase
        .from('user_preferences')
        .insert({
          user_id: userId,
          volume: 80,
          shuffle_enabled: false,
          repeat_mode: 'off',
        });

      if (prefError) throw new Error(prefError.message);

      this.currentUser = data.user;
      this.notifyListeners();

      return { user: data.user, success: true };
    } catch (error) {
      console.error('Signup error:', error);
      return { error: error.message, success: false };
    }
  }

  /**
   * Sign in existing user
   */
  async signin(email, password) {
    try {
      const { data, error } = await this.supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) throw new Error(error.message);

      this.currentUser = data.user;
      this.notifyListeners();

      return { user: data.user, success: true };
    } catch (error) {
      console.error('Signin error:', error);
      return { error: error.message, success: false };
    }
  }

  /**
   * Sign out current user
   */
  async signout() {
    try {
      const { error } = await this.supabase.auth.signOut();

      if (error) throw new Error(error.message);

      this.currentUser = null;
      this.notifyListeners();

      return { success: true };
    } catch (error) {
      console.error('Signout error:', error);
      return { error: error.message, success: false };
    }
  }

  /**
   * Get current authenticated user
   */
  getCurrentUser() {
    return this.currentUser;
  }

  /**
   * Get user's profile data from database
   */
  async getUserProfile(userId = null) {
    try {
      const id = userId || this.currentUser?.id;
      if (!id) return null;

      const { data, error } = await this.supabase
        .from('users')
        .select('*')
        .eq('id', id)
        .single();

      if (error) throw new Error(error.message);

      return data;
    } catch (error) {
      console.error('Get profile error:', error);
      return null;
    }
  }

  /**
   * Update user profile
   */
  async updateProfile(updates) {
    try {
      if (!this.currentUser) throw new Error('Not authenticated');

      const { data, error } = await this.supabase
        .from('users')
        .update(updates)
        .eq('id', this.currentUser.id)
        .select()
        .single();

      if (error) throw new Error(error.message);

      return { data, success: true };
    } catch (error) {
      console.error('Update profile error:', error);
      return { error: error.message, success: false };
    }
  }

  /**
   * Reset password with email
   */
  async requestPasswordReset(email) {
    try {
      const { error } = await this.supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      });

      if (error) throw new Error(error.message);

      return { success: true };
    } catch (error) {
      console.error('Password reset error:', error);
      return { error: error.message, success: false };
    }
  }

  /**
   * Confirm password reset
   */
  async resetPassword(newPassword) {
    try {
      const { error } = await this.supabase.auth.updateUser({
        password: newPassword,
      });

      if (error) throw new Error(error.message);

      return { success: true };
    } catch (error) {
      console.error('Reset password error:', error);
      return { error: error.message, success: false };
    }
  }

  /**
   * Restore session from local storage / cookies
   */
  async restoreSession() {
    try {
      const {
        data: { session },
      } = await this.supabase.auth.getSession();

      if (session?.user) {
        this.currentUser = session.user;
        this.notifyListeners();
      }
    } catch (error) {
      console.error('Restore session error:', error);
    }
  }

  /**
   * Set up auth state listener for real-time updates
   */
  onAuthStateChange(callback) {
    const {
      data: { subscription },
    } = this.supabase.auth.onAuthStateChange((event, session) => {
      this.currentUser = session?.user || null;
      callback(this.currentUser);
      this.notifyListeners();
    });

    return subscription;
  }

  /**
   * Register listener for UI updates
   */
  subscribe(listener) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  /**
   * Notify all listeners of auth state change
   */
  notifyListeners() {
    this.listeners.forEach(listener => listener(this.currentUser));
  }

  /**
   * Generate avatar URL (gravatar or placeholder)
   */
  generateAvatarUrl(email) {
    const hash = btoa(email.toLowerCase()).replace(/[^a-zA-Z0-9]/g, '');
    return `https://ui-avatars.com/api/?name=${encodeURIComponent(email)}&background=random`;
  }

  /**
   * Check if user is authenticated
   */
  isAuthenticated() {
    return this.currentUser !== null;
  }

  /**
   * Get auth token (for API calls)
   */
  async getToken() {
    try {
      const {
        data: { session },
      } = await this.supabase.auth.getSession();

      return session?.access_token || null;
    } catch (error) {
      console.error('Get token error:', error);
      return null;
    }
  }
}

// Export singleton instance (initialized with Supabase client)
// Usage in main code:
// import AuthService from './services/AuthService.js'
// import { createClient } from '@supabase/supabase-js'
//
// const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
// const authService = new AuthService(supabase)

// Make available globally for event handlers
window.AuthService = AuthService;
