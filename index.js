const express = require('express');
const cors = require('cors');
const axios = require('axios');
const sharp = require('sharp');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

app.post('/api/instagram/post', async (req, res) => {
  try {
    const { url, shortcode } = req.body;
    if (!url || !shortcode) return res.status(400).json({ message: 'URL and shortcode required' });

    const pageResponse = await axios.get(url, {
      headers: { 'User-Agent': 'facebookexternalhit/1.1', 'Accept': 'text/html' },
      timeout: 10000, maxRedirects: 5,
    });
    const html = pageResponse.data;

    const ogImageMatch = html.match(/property="og:image"\s+content="([^"]+)"/);
    const ogImage = ogImageMatch ? ogImageMatch[1].replace(/&amp;/g, '&') : null;

    const ogDescMatch = html.match(/property="og:description"\s+content="([^"]+)"/);
    const rawDesc = ogDescMatch ? ogDescMatch[1].replace(/&amp;/g, '&').replace(/&#039;/g, "'").replace(/&quot;/g, '"') : '';

    const usernameMatch = rawDesc.match(/^([\w.]+)\s/) || html.match(/property="og:title"\s+content="([^"]+)"/);
    const username = usernameMatch ? usernameMatch[1].replace(/ on Instagram.*/, '').trim() : '';
    const caption = rawDesc.replace(/^[\w.]+\s/, '');

    const isVideo = url.includes('/reel') || html.includes('og:video');
    const uniqueUrls = ogImage ? [ogImage] : [];

    if (uniqueUrls.length === 0) return res.status(404).json({ message: 'No media found' });

    res.json({
      shortcode,
      type: isVideo ? 'video' : uniqueUrls.length > 1 ? 'carousel' : 'image',
      mediaUrls: uniqueUrls, thumbnailUrl: uniqueUrls[0], caption, username,
    });
  } catch (error) {
    console.error('Instagram fetch error:', error.message);
    res.status(500).json({ message: 'Failed to load post' });
  }
});

app.post('/api/analyze', async (req, res) => {
  try {
    const { mediaUrl, mediaType } = req.body;
    if (!mediaUrl) return res.status(400).json({ message: 'Media URL required' });
    if (!process.env.SIGHTENGINE_USER || !process.env.SIGHTENGINE_SECRET)
      return res.status(500).json({ message: 'SightEngine keys not configured' });

    const imageResponse = await axios.get(mediaUrl, {
      responseType: 'arraybuffer', timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    const processedBuffer = await sharp(Buffer.from(imageResponse.data))
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 }).toBuffer();

    const FormData = require('form-data');
    const form = new FormData();
    form.append('media', processedBuffer, { filename: 'image.jpg', contentType: 'image/jpeg' });
    form.append('models', 'genai');
    form.append('api_user', process.env.SIGHTENGINE_USER);
    form.append('api_secret', process.env.SIGHTENGINE_SECRET);

    const response = await axios.post('https://api.sightengine.com/1.0/check.json', form, {
      headers: form.getHeaders(), timeout: 30000,
    });

    if (response.data.status !== 'success') throw new Error(response.data.error?.message || 'SightEngine error');
    const aiScore = response.data.type?.ai_generated;
    if (aiScore === undefined) throw new Error('No AI score');

    const score = Math.round(aiScore * 100);
    res.json({
      isAI: score >= 50, confidence: score, sightengineScore: score,
      claudeVerdict: null, mediaType: mediaType || 'image', analyzedUrl: mediaUrl,
    });
  } catch (error) {
    console.error('Analysis error:', error.message);
    res.status(500).json({ message: 'Analysis failed: ' + error.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', sightengineConfigured: !!process.env.SIGHTENGINE_USER });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log('AI Detector running on port ' + PORT));
