require('dotenv').config();
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

// Use the strategy
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.GOOGLE_CALLBACK_URL, // safer and more flexible
}, async (accessToken, refreshToken, profile, done) => {
  // In production, check DB here (e.g. findOrCreate)
  return done(null, profile);
}));

// Serialize user info into the session (used only if you enable sessions)
passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((obj, done) => {
  done(null, obj);
});
