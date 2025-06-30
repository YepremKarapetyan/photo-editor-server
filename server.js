const dotenv = require('dotenv');
const express = require('express');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const cookieParser = require('cookie-parser');
const cors = require('cors');
const multer = require('multer');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

dotenv.config();
require('./passport');

const app = express();
app.set('trust proxy', 1);

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

app.use(cookieParser());
app.use(cors({
  origin: 'https://photoeditor-front.netlify.app',
  credentials: true
}));
app.use(express.json({ limit: '25mb' }));

// Session Config with MongoStore
app.use(session({
  secret: process.env.SESSION_SECRET || 'defaultsecret',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGO_URI,
    collectionName: 'sessions',
    ttl: 60 * 60 * 24
  }),
  cookie: {
    sameSite: 'none',
    secure: true,
    maxAge: 1000 * 60 * 60 * 24,
  }
}));

app.use(passport.initialize());
app.use(passport.session());

// MongoDB Connect
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch((err) => console.error('❌ MongoDB error:', err));

// Photo Schema
const photoSchema = new mongoose.Schema({
  ownerEmail: { type: String, required: true },
  imageUrl: { type: String, required: true },
  editedVersions: [{
    type: { type: String, required: true },
    url: { type: String, required: true },
    date: { type: Date, default: Date.now }
  }],
  createdAt: { type: Date, default: Date.now }
});
const Photo = mongoose.model('Photo', photoSchema);

// Auth Routes
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/auth/google/callback',
  passport.authenticate('google', {
    failureRedirect: '/auth/failure',
    session: true
  }),
  (req, res) => {
    res.redirect('https://photoeditor-front.netlify.app/dashboard');
  }
);

app.get('/auth/failure', (req, res) => {
  res.status(401).send('Google OAuth failed');
});

app.get('/logout', (req, res) => {
  req.logout(() => {
    res.clearCookie('connect.sid');
    res.redirect('https://photoeditor-front.netlify.app/');
  });
});

// Auth Middleware
const authenticate = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  return res.status(401).json({ success: false, message: 'Not authenticated' });
};

// Multer with Cloudinary storage
const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'photo-editor',
    allowed_formats: ['jpg', 'png', 'jpeg', 'webp'],
    transformation: [{ quality: 'auto' }]
  }
});
const upload = multer({ storage });

// Upload Photo
app.post('/upload-photo', authenticate, upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

  const newPhoto = new Photo({
    ownerEmail: req.user.email,
    imageUrl: req.file.path
  });

  await newPhoto.save();
  res.json({ success: true, photo: newPhoto });
});

// My Photos
app.get('/my-photos', authenticate, async (req, res) => {
  const photos = await Photo.find({ ownerEmail: req.user.email });
  res.json({ success: true, photos });
});

// Delete Photo (does not delete from Cloudinary)
app.delete('/photo/:id', authenticate, async (req, res) => {
  const photo = await Photo.findById(req.params.id);
  if (!photo || photo.ownerEmail !== req.user.email)
    return res.status(403).json({ success: false, message: 'Not authorized' });

  try {
    await photo.deleteOne();
    res.json({ success: true });
  } catch (err) {
    console.error('Delete error:', err);
    res.status(500).json({ success: false });
  }
});

// Save base64 image to Cloudinary
const saveBase64Image = async (base64Data, filename) => {
  const uploadResponse = await cloudinary.uploader.upload(base64Data, {
    folder: 'photo-editor',
    public_id: filename,
    overwrite: true
  });
  return uploadResponse.secure_url;
};

// Edit Photo (save base64 to cloud)
app.patch('/photo/:id/edit', authenticate, async (req, res) => {
  try {
    const { type, base64 } = req.body;
    if (!type || !base64) {
      return res.status(400).json({ success: false, message: 'Missing type or base64 data' });
    }

    const photo = await Photo.findById(req.params.id);
    if (!photo || photo.ownerEmail !== req.user.email) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    const filename = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
    const savedUrl = await saveBase64Image(base64, filename);

    photo.editedVersions.push({ type, url: savedUrl, date: new Date() });
    await photo.save();

    return res.json({ success: true, photo });
  } catch (err) {
    console.error('PATCH error:', err);
    res.status(500).json({ success: false });
  }
});

// Delete Edited Version (does not delete from Cloudinary)
app.delete('/photo/:photoId/edit/:editId', authenticate, async (req, res) => {
  try {
    const { photoId, editId } = req.params;
    const photo = await Photo.findById(photoId);
    if (!photo || photo.ownerEmail !== req.user.email)
      return res.status(403).json({ success: false });

    const editedIndex = photo.editedVersions.findIndex(ev => ev._id.toString() === editId);
    if (editedIndex === -1)
      return res.status(404).json({ success: false });

    photo.editedVersions.splice(editedIndex, 1);
    await photo.save();
    res.json({ success: true, photo });
  } catch (err) {
    console.error('DELETE edit error:', err);
    res.status(500).json({ success: false });
  }
});

// Get User Info
app.get('/me', authenticate, (req, res) => {
  res.json({ success: true, user: req.user });
});

// Start Server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
