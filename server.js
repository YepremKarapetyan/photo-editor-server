const dotenv = require('dotenv');
const express = require('express');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const multer = require('multer');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');

dotenv.config()

const app = express();

// ===== Connect to MongoDB =====
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch((err) => console.error('❌ MongoDB error:', err));

// ===== Photo Schema =====
const photoSchema = new mongoose.Schema({
  owner: { type: String, required: true },
  imageUrl: { type: String, required: true },
  editedVersions: [{
    type: { type: String, required: true },
    url: { type: String, required: true },
    date: { type: Date, default: Date.now }
  }],
  createdAt: { type: Date, default: Date.now }
});
const Photo = mongoose.model('Photo', photoSchema);

// ===== Middlewares =====
app.use(cookieParser());
app.use(cors({
  origin: 'https://photoeditor-front.netlify.app',
  credentials: true
}));
app.use(express.json({ limit: '25mb' })); // large payloads for base64 images
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ===== Passport Google OAuth Setup =====
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.GOOGLE_CALLBACK_URL
}, (accessToken, refreshToken, profile, done) => {
  return done(null, profile);
}));
app.use(passport.initialize());

// ===== Google OAuth Routes =====
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/auth/google/callback',
  passport.authenticate('google', { session: false, failureRedirect: '/auth/failure' }),
  (req, res) => {
    const user = req.user;
    const token = jwt.sign({
      id: user.id,
      name: user.displayName,
      email: user.emails?.[0]?.value || '',
      photo: user.photos?.[0]?.value || ''
    }, process.env.JWT_SECRET, { expiresIn: '1d' });

    res.redirect(`https://photoeditor-front.netlify.app/oauth-success?token=${token}`);
  }
);

app.get('/auth/failure', (req, res) => {
  res.status(401).send('Google OAuth failed');
});

// ===== Auth Middleware =====
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, message: 'No token provided' });

  try {
    const user = jwt.verify(token, process.env.JWT_SECRET);
    req.user = user;
    next();
  } catch (err) {
    res.status(401).json({ success: false, message: 'Invalid token' });
  }
};

// ===== Multer Config for File Uploads =====
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = './uploads';
    if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath);
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const filename = `${Date.now()}-${Math.round(Math.random() * 1E9)}${ext}`;
    cb(null, filename);
  }
});
const upload = multer({ storage });

// ===== Upload Photo Route =====
app.post('/upload-photo', authenticate, upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

  const newPhoto = new Photo({
    owner: req.user.id,
    imageUrl: `/uploads/${req.file.filename}`
  });

  await newPhoto.save();
  res.json({ success: true, photo: newPhoto });
});

// ===== Get User Photos =====
app.get('/my-photos', authenticate, async (req, res) => {
  const photos = await Photo.find({ owner: req.user.id });
  res.json({ success: true, photos });
});

// ===== Delete Original Photo =====
app.delete('/photo/:id', authenticate, async (req, res) => {
  const photo = await Photo.findById(req.params.id);
  if (!photo || photo.owner !== req.user.id) return res.status(403).json({ success: false, message: 'Not authorized' });

  try {
    const originalPath = path.join(__dirname, photo.imageUrl);
    if (fs.existsSync(originalPath)) {
      fs.unlinkSync(originalPath);
    }
  } catch (err) {
    console.warn('File deletion failed:', err);
  }

  // Delete all edited files associated with this photo as well
  for (const edited of photo.editedVersions) {
    try {
      const editedPath = path.join(__dirname, edited.url);
      if (fs.existsSync(editedPath)) fs.unlinkSync(editedPath);
    } catch (e) {
      console.warn('Failed to delete edited file:', e);
    }
  }

  await photo.deleteOne();
  res.json({ success: true });
});

// ===== Utility: Save base64 image as file =====
const saveBase64Image = (base64Data, filename) => {
  const matches = base64Data.match(/^data:(.+);base64,(.+)$/);
  if (!matches) throw new Error('Invalid base64 string');

  const ext = matches[1].split('/')[1]; // e.g. jpeg, png
  const data = matches[2];

  const buffer = Buffer.from(data, 'base64');
  const filePath = path.join(__dirname, 'uploads', filename + '.' + ext);

  fs.writeFileSync(filePath, buffer);
  return `/uploads/${filename}.${ext}`;
};

// ===== Edit Photo (Add Edited Version) =====
app.patch('/photo/:id/edit', authenticate, async (req, res) => {
  try {
    const { type, base64 } = req.body;
    if (!type || !base64) {
      return res.status(400).json({ success: false, message: 'Missing type or base64 data' });
    }

    const photo = await Photo.findById(req.params.id);
    if (!photo || photo.owner !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    // Save base64 as file
    let savedUrl;
    if (base64.startsWith('data:')) {
      const filename = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
      savedUrl = saveBase64Image(base64, filename);
    } else {
      return res.status(400).json({ success: false, message: 'Invalid base64 image data' });
    }

    photo.editedVersions.push({ type, url: savedUrl, date: new Date() });
    await photo.save();

    return res.json({ success: true, photo });
  } catch (err) {
    console.error('PATCH /photo/:id/edit error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ===== Delete Edited Version =====
app.delete('/photo/:photoId/edit/:editId', authenticate, async (req, res) => {
  try {
    const { photoId, editId } = req.params;

    const photo = await Photo.findById(photoId);
    if (!photo || photo.owner !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    // Find edited version index
    const editedIndex = photo.editedVersions.findIndex(ev => ev._id.toString() === editId);
    if (editedIndex === -1) {
      return res.status(404).json({ success: false, message: 'Edited version not found' });
    }

    // Delete edited file
    const filePath = path.join(__dirname, photo.editedVersions[editedIndex].url);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (err) {
      console.warn('Failed to delete edited file:', err);
    }

    // Remove edited version from array
    photo.editedVersions.splice(editedIndex, 1);
    await photo.save();

    res.json({ success: true, photo });
  } catch (err) {
    console.error('DELETE /photo/:photoId/edit/:editId error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ===== User Info Route =====
app.get('/me', authenticate, (req, res) => {
  res.json({ success: true, user: req.user });
});

// ===== Start Server =====
const PORT = 10000;
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
