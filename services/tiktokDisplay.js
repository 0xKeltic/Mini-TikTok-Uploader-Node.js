const axios = require('axios');

async function listVideos({ accessToken, maxCount = 5, fields = ['id', 'title', 'cover_image_url'] }) {
  const url = `https://open.tiktokapis.com/v2/video/list/?fields=${encodeURIComponent(fields.join(','))}`;
  const response = await axios.post(
    url,
    { max_count: Math.max(1, Math.min(20, maxCount)) },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 30_000,
    }
  );

  return response.data;
}

module.exports = {
  listVideos,
};

