const express = require('express');
const { retired } = require('../middleware/security');

// Student Google sign-in was removed. These routes stay so old links and cached pages land somewhere sensible.
const router = express.Router();

// Cached pages from the Google era ask whether to show "Continue with Google": always no.
router.get('/providers', (req, res) => res.json({ google: false }));

// Browser navigations (the old button, the OAuth callback) go to the join page; anything else gets 410.
router.get('/google', retired('Google sign-in has been removed.', { redirect: true }));
router.get('/google/callback', retired('Google sign-in has been removed.', { redirect: true }));

module.exports = router;
